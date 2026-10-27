import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  safeParseAgentEvent,
  type AdapterEventCandidate,
  type AgentHost,
  type TerminalSpec,
} from '@vibefield/puppeteer-core';
import { projectAgentEvents } from '@vibefield/puppeteer-testing';
import { createOpenCodeTuiSession, type OpenCodeTuiSession } from './driver.js';
import { createOpenCodeImposterFixture } from './test-support/imposter.js';

const sessions = new Set<OpenCodeTuiSession>();
const roots = new Set<string>();

afterEach(async () => {
  await Promise.all([...sessions].map((session) => session.dispose()));
  sessions.clear();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe('OpenCode native-TUI session composition', () => {
  it('attaches the exact session and confirms REST prompts only from the matching native echo', async () => {
    const fixture = createOpenCodeImposterFixture();
    roots.add(fixture.root);
    let launch: TerminalSpec | undefined;
    const host: AgentHost = {
      async spawnTerminal(spec) {
        launch = spec;
        return { runtimeSessionId: 'runtime-opencode-test' };
      },
      async automateTerminal() {
        throw new Error('structured OpenCode prompt submission must not parse or automate terminal output');
      },
    };
    const session = await createOpenCodeTuiSession({
      cwd: fixture.cwd,
      host,
      executable: fixture.executable,
      env: fixture.env,
      promptConfirmationTimeoutMs: 2_000,
    });
    sessions.add(session);
    const projection = projectAgentEvents(session);

    expect(session.observationLevel()).toBe('structured');
    expect(projection.state.lifecycle).toBe('ready');
    expect(launch?.command).toBe(fixture.executable);
    expect(launch?.args).toEqual([
      'attach',
      session.backendOrigin(),
      '--dir',
      fixture.cwd,
      '--session',
      session.sessionId,
      '--pure',
    ]);
    expect(launch?.args).not.toContain(launch?.env?.OPENCODE_SERVER_PASSWORD);
    expect(launch?.env?.OPENCODE_SERVER_PASSWORD).toBeTruthy();

    const observed: AdapterEventCandidate[] = [];
    const candidates: AdapterEventCandidate[] = [];
    const monitor = projection.monitorBatches;
    const off = session.events.onCandidate((event) => observed.push(event));
    expect(session.events.onCandidate).toBeTypeOf('function');
    const offCandidate = session.events.onCandidate!((candidate) => candidates.push(candidate));
    expect(monitor.length).toBeGreaterThan(0);
    expect(monitor.every((batch) => batch.phase === 'bootstrap')).toBe(true);
    expect(monitor.flatMap((batch) => batch.capabilities ?? [])).toEqual(
      expect.arrayContaining([expect.objectContaining({ family: 'usage', support: 'supported' })]),
    );
    const receipt = await session.services.prompt.submit({ text: 'hello from adapter' });
    expect(receipt.status).toBe('confirmed');
    const confirmedTurnID = receipt.status === 'confirmed' ? receipt.turnId : undefined;
    expect(confirmedTurnID).toMatch(/^msg_puppeteer_/);
    await waitFor(
      () => projection.state.activeTurn === undefined && projection.state.lastAssistantMessage !== undefined,
      'turn completion',
    );
    off();

    expect(projection.state.lastAssistantMessage).toBe('imposter: ok');
    expect(observed.some((event) => event.event.type === 'turn:started' && event.promptId === confirmedTurnID)).toBe(
      true,
    );
    expect(observed.some((event) => event.event.type === 'turn:completed')).toBe(true);
    const assistant = candidates.find(({ type }) => type === 'conversation:assistant-message');
    expect(assistant).not.toHaveProperty('sequence');
    expect(assistant && safeParseAgentEvent(assistant.type, assistant.event).success).toBe(true);
    expect(candidates.every(({ type }) => type.includes(':'))).toBe(true);
    expect(candidates.every(({ type, event }) => safeParseAgentEvent(type, event).success)).toBe(true);
    expect(
      monitor.some(
        (batch) =>
          batch.phase === 'live' &&
          batch.updates.some(
            (update) =>
              update.family === 'usage' &&
              update.operation === 'upsert' &&
              update.value.canonical &&
              update.value.deltaTokens === 18,
          ),
      ),
    ).toBe(true);
    for (let index = 1; index < projection.envelopes.length; index++) {
      expect(projection.envelopes[index]!.sequence).toBeGreaterThan(projection.envelopes[index - 1]!.sequence);
    }

    const sequence = projection.state.lastSequence;
    await session.reconcile();
    expect(projection.state.lastSequence).toBe(sequence);
    offCandidate();
    projection.dispose();
  });

  it("runs the private backend under the host's helper environment, never this process's own", async () => {
    const fixture = createOpenCodeImposterFixture();
    roots.add(fixture.root);
    // The backend writes down the environment it was born with, then serves as the fixture does.
    const record = join(fixture.root, 'backend-environment.json');
    const executable = join(fixture.root, 'recording', 'opencode.mjs');
    mkdirSync(dirname(executable));
    writeFileSync(
      executable,
      `import { writeFileSync } from 'node:fs';\n` +
        `writeFileSync(${JSON.stringify(record)}, JSON.stringify(process.env));\n` +
        `await import(${JSON.stringify(pathToFileURL(fixture.executable).href)});\n`,
      { mode: 0o700 },
    );
    vi.stubEnv('PUPPETEER_HOST_ONLY_SECRET', 'host-secret');
    const composed: Record<string, string>[] = [];
    const host: AgentHost = {
      async spawnTerminal() {
        return { runtimeSessionId: 'runtime-opencode-helper-environment' };
      },
      async automateTerminal() {
        return { accepted: true };
      },
      // a host's policy: what it chooses to pass, beneath the adapter's own variables
      helperEnvironment(env) {
        composed.push(env);
        return {
          ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
          ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
          ...env,
        };
      },
    };
    try {
      const session = await createOpenCodeTuiSession({ cwd: fixture.cwd, host, executable, env: fixture.env });
      sessions.add(session);
      expect(composed).toEqual([fixture.env]);
      const environment = JSON.parse(readFileSync(record, 'utf8')) as Record<string, string>;
      expect(environment).not.toHaveProperty('PUPPETEER_HOST_ONLY_SECRET');
      expect(environment['PUPPETEER_IMPOSTER_HOME']).toBe(fixture.env['PUPPETEER_IMPOSTER_HOME']);
      // the adapter's own credentials still ride over the host's composition
      expect(environment['OPENCODE_SERVER_USERNAME']).toBe('opencode');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentHost } from '@vibecook/puppeteer-core';
import { projectAgentEvents } from '@vibecook/puppeteer-testing';
import { attestLiveAdapter } from '@vibecook/puppeteer-testing/live-attestation';
import { resolveOpenCodeExecutable } from './detection.js';
import { createOpenCodeTuiSession, type OpenCodeTuiSession } from './driver.js';

const roots = new Set<string>();
const sessions = new Set<OpenCodeTuiSession>();

afterEach(async () => {
  await Promise.all([...sessions].map((session) => session.dispose()));
  sessions.clear();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

describe.runIf(process.env.OPENCODE_LIVE === '1')('pinned real OpenCode smoke', () => {
  it('starts a private backend, creates an exact session, and prepares native attach', async () => {
    const cwd = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'puppeteer-opencode-live-')));
    roots.add(cwd);
    const host: AgentHost = {
      async spawnTerminal() {
        return { runtimeSessionId: 'runtime-opencode-live' };
      },
      async automateTerminal() {
        return { accepted: false, reason: 'not used by structured OpenCode control' };
      },
    };
    const executable = resolveOpenCodeExecutable();
    const session = await createOpenCodeTuiSession({ cwd, host, executable });
    sessions.add(session);
    const projection = projectAgentEvents(session);
    expect(session.sessionId).toMatch(/^ses_/);
    expect(projection.state.lifecycle).toBe('ready');
    expect(session.observationLevel()).toBe('structured');
    await attestLiveAdapter({ vendor: 'opencode', artifact: executable, testId: 'opencode:private-backend' });
    projection.dispose();
  });
});

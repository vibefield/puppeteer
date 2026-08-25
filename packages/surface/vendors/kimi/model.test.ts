import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadModel, validatePayload } from '@vibecook/puppeteer-surface';
import { checkCaptureDirectory } from '@vibecook/puppeteer-surface/sanitize';
import { kimiRules } from './sanitize-captures.mjs';

const vendorRoot = dirname(fileURLToPath(import.meta.url));
const version = '0.34.0';
const capturesRoot = join(vendorRoot, 'captures', `kimi@${version}`);
const model = loadModel(join(vendorRoot, 'model', `kimi@${version}`));
const events = new Map(model.events.map((event) => [event.event, event]));
const sourceReference = JSON.parse(
  readFileSync(join(vendorRoot, 'references', `kimi@${version}`, 'source-contract.json'), 'utf8'),
) as Record<string, any>;

function jsonLines(path: string): Record<string, unknown>[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe(`the Kimi ${version} candidate ASM`, () => {
  it('keeps terminal, wire, state, index, and hook rails distinct', () => {
    expect(Object.keys(model.channels.channels).sort()).toEqual([
      'argv',
      'hook-command',
      'session-index',
      'session-state',
      'terminal',
      'wire',
    ]);
  });

  it('models every captured wire record and accepts both its payload and carrier', () => {
    const failures: string[] = [];
    for (const scenario of readdirSync(capturesRoot)) {
      const journals = [join(capturesRoot, scenario, 'wire.jsonl')];
      const agentsDir = join(capturesRoot, scenario, 'agents');
      if (existsSync(agentsDir)) {
        journals.push(
          ...readdirSync(agentsDir)
            .filter((file) => file.endsWith('.jsonl'))
            .map((file) => join(agentsDir, file)),
        );
      }
      for (const journal of journals) {
        for (const record of jsonLines(journal)) {
          const type = String(record.type);
          const descriptor = events.get(type);
          if (!descriptor) {
            failures.push(`unmodelled ${type}`);
            continue;
          }
          const { type: _type, time: _time, ...payload } = record;
          if (descriptor.payloadSchema) {
            failures.push(
              ...validatePayload(descriptor.payloadSchema, payload).map((failure) => `${type}: ${failure}`),
            );
          }
          if (descriptor.recordSchema) {
            failures.push(
              ...validatePayload(descriptor.recordSchema, record).map((failure) => `${type} carrier: ${failure}`),
            );
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('models every captured hook, session state, and session-index entry', () => {
    const failures: string[] = [];
    for (const scenario of readdirSync(capturesRoot)) {
      const scenarioRoot = join(capturesRoot, scenario);
      for (const hook of readdirSync(join(scenarioRoot, 'hooks'))) {
        for (const payload of jsonLines(join(scenarioRoot, 'hooks', hook))) {
          const name = String(payload.hook_event_name);
          const schema = events.get(name)?.payloadSchema;
          if (!schema) failures.push(`unmodelled hook ${name}`);
          else failures.push(...validatePayload(schema, payload).map((failure) => `${name}: ${failure}`));
        }
      }
      const state = JSON.parse(readFileSync(join(scenarioRoot, 'state.json'), 'utf8')) as Record<string, unknown>;
      failures.push(...validatePayload(events.get('state.json')!.payloadSchema!, state));
      for (const entry of jsonLines(join(scenarioRoot, 'session-index.jsonl'))) {
        failures.push(...validatePayload(events.get('session_index.entry')!.payloadSchema!, entry));
      }
    }
    expect(failures).toEqual([]);
  });

  it('attributes observed branches to runtime while leaving source-only outcomes unverified', () => {
    const turnEnded = events.get('turn.ended')!;
    expect(turnEnded.confidence).toBe('verified-headless');
    expect(turnEnded.variants?.find((entry) => entry.match.reason === 'completed')?.confidence).toBe(
      'verified-headless',
    );
    expect(turnEnded.variants?.find((entry) => entry.match.reason === 'failed')?.confidence).toBe('verified-headless');
    for (const reason of ['cancelled', 'blocked']) {
      expect(turnEnded.variants?.find((entry) => entry.match.reason === reason)?.confidence).toBe('unverified');
    }
    expect(events.get('SessionStart')?.variants?.find((entry) => entry.match.source === 'resume')?.confidence).toBe(
      'verified-headless',
    );
    expect(events.get('task.started')?.confidence).toBe('verified-headless');
    expect(events.get('task.terminated')?.confidence).toBe('verified-headless');
    expect(events.get('TaskStarted')?.confidence).toBe('verified-headless');
    expect(events.get('Notification')?.confidence).toBe('verified-headless');
    expect(events.get('StopFailure')?.confidence).toBe('verified-headless');
    expect(events.get('SubagentStart')?.confidence).toBe('verified-headless');
    expect(events.get('SubagentStop')?.confidence).toBe('verified-headless');
    expect(
      events
        .get('context.append_message')
        ?.variants?.find((entry) => entry.match['message.origin.kind'] === 'hook_result')?.confidence,
    ).toBe('verified-headless');
    expect(
      events.get('TurnStarted')?.variants?.find((entry) => entry.match.origin_kind === 'system_trigger')?.confidence,
    ).toBe('verified-headless');
    expect(events.get('interaction.request')?.confidence).toBe('unverified');
    expect(events.get('full_compaction.begin')?.confidence).toBe('unverified');
  });

  it('uses the 40-persisted/8-transient source contract verbatim', () => {
    expect(sourceReference.wire).toMatchObject({
      totalOperationTypes: 48,
      persistedOperationTypes: 40,
      transientOperationTypes: 8,
    });
    expect(sourceReference.hooks.events).toHaveLength(20);
    for (const [name, schema] of Object.entries(sourceReference.wire.payloadSchemas)) {
      expect(events.get(name)?.payloadSchema, name).toEqual(schema);
    }
    for (const [name, schema] of Object.entries(sourceReference.hooks.payloadSchemas)) {
      expect(events.get(name)?.payloadSchema, name).toEqual(schema);
    }
  });

  it('enforces the source union/integer constraints and complete llm.request field set', () => {
    const undo = events.get('context.undo')!.payloadSchema!;
    expect(validatePayload(undo, { count: 1 })).toEqual([]);
    expect(validatePayload(undo, { count: 0 })).not.toEqual([]);
    expect(validatePayload(undo, { count: 1.5 })).not.toEqual([]);

    const compaction = events.get('context.apply_compaction')!.payloadSchema!;
    expect(validatePayload(compaction, {})).toEqual(['payload does not satisfy anyOf']);
    expect(validatePayload(compaction, { summary: 'summary', compactedCount: 2 })).toEqual([]);
    expect(validatePayload(compaction, { contextSummary: 'summary', compactedCount: 2 })).toEqual([]);

    expect(Object.keys(events.get('llm.request')!.payloadSchema!.properties ?? {})).toEqual(
      expect.arrayContaining([
        'temperature',
        'topP',
        'betaApi',
        'systemPrompt',
        'attempt',
        'projection',
        'droppedCount',
      ]),
    );
  });

  it('constrains hook names, requires event-specific fields, and points verified hooks at matching fixtures', () => {
    for (const name of sourceReference.hooks.events as string[]) {
      expect(events.get(name)?.payloadSchema?.properties?.hook_event_name?.enum).toEqual([name]);
    }
    expect(
      validatePayload(events.get('PreToolUse')!.payloadSchema!, {
        hook_event_name: 'PreToolUse',
        session_id: 'session',
        cwd: '/workspace',
        client_type: 'kimi_code_cli',
      }),
    ).toContain('missing required field "tool_name"');
    expect(
      validatePayload(events.get('PostToolUse')!.payloadSchema!, {
        hook_event_name: 'PostToolUseFailure',
        session_id: 'session',
        cwd: '/workspace',
        client_type: 'kimi_code_cli',
        tool_name: 'Bash',
        tool_input: {},
        tool_call_id: 'call',
        tool_output: 'ok',
      }),
    ).toContain('field "hook_event_name" value not in enum');

    for (const name of [
      'PreToolUse',
      'PostToolUse',
      'PostToolUseFailure',
      'TaskStarted',
      'Notification',
      'StopFailure',
      'SubagentStart',
      'SubagentStop',
    ]) {
      const fixture = events.get(name)!.fixture!;
      expect(existsSync(resolve(vendorRoot, fixture)), fixture).toBe(true);
      expect(jsonLines(resolve(vendorRoot, fixture)).every((payload) => payload.hook_event_name === name)).toBe(true);
    }
  });

  it('binds the exact candidate identity and contains no detectable private material', () => {
    const artifact = model.evidenceIndex?.artifacts[0] as Record<string, unknown>;
    expect(artifact.versionOutput).toBe(version);
    expect((artifact.integrity as Record<string, unknown>).sha256).toBe(
      'sha256:9f4337e10da47843f6b550474012a53ba8b30dd665f83b176a5cd479c5f7e859',
    );
    expect(checkCaptureDirectory(capturesRoot, kimiRules)).toEqual([]);
    expect(model.evidenceIndex?.records.map((record) => record.id)).toEqual(
      expect.arrayContaining(['binary-probes', 'exact-source-reference', 'sanitized-captures']),
    );
    const attestation = JSON.parse(
      readFileSync(join(vendorRoot, 'probes', `kimi@${version}`, 'raw-capture-attestation.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(attestation).toMatchObject({
      scenarios: [
        'background-task',
        'basic-turn',
        'hook-block-prompt',
        'hook-deny-tool',
        'interrupt-stream',
        'provider-error',
        'provider-retry',
        'resume-turn',
        'subagent-turn',
        'tool-nonzero',
        'tool-success',
      ],
    });
    expect(attestation.files).toEqual(expect.any(Number));
    expect(attestation.files).toBeGreaterThan(37);
    expect(model.evidenceIndex?.claims.find((claim) => claim.id === 'kimi-runtime-headless')?.capturedAt).toBe(
      attestation.captureStartedAt,
    );
  });
});

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadModel, validatePayload } from '@vibefield/puppeteer-surface';
import { resolveAgentModel } from '../../../../scripts/agent-model-selection.mjs';
import { CLAUDE_HOOK_EVENTS } from './census/harness.mjs';

interface CapturedHookRecord {
  session_id: string;
  transcript_path: string;
  cwd: string;
  hook_event_name: string;
  [key: string]: unknown;
}

const selected = resolveAgentModel({ vendor: 'claude' });
const surfaceModel = loadModel(selected.groundTruthPath);
const captureRoot = selected.capturesRoot;
const captureModes = readdirSync(captureRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

function modelConfidence(event: string): string {
  const descriptor = surfaceModel.events.find((candidate) => candidate.event === event);
  if (!descriptor) throw new Error(`canonical ground truth has no ${event} event`);
  return descriptor.confidence;
}

function expectCapturedOrUnverified(event: string): CapturedHookRecord[] {
  const records = loadHookFixtures(event);
  if (records.length === 0) expect(modelConfidence(event)).toBe('unverified');
  return records;
}

function listHookFixtureEvents(): string[] {
  return [
    ...new Set(
      captureModes.flatMap((mode) =>
        readdirSync(join(captureRoot, mode))
          .filter((file) => file.endsWith('.jsonl'))
          .map((file) => file.replace(/\.jsonl$/, '')),
      ),
    ),
  ].sort();
}

function loadHookFixtures(event?: string): CapturedHookRecord[] {
  const events = event ? [event] : listHookFixtureEvents();
  return events.flatMap((name) =>
    captureModes.flatMap((mode) => {
      const path = join(captureRoot, mode, `${name}.jsonl`);
      if (!existsSync(path)) return [];
      return readFileSync(path, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as CapturedHookRecord);
    }),
  );
}

describe('captured hook fixtures', () => {
  it('keeps the digest-pinned child status channel and its full task snapshot in the active model', () => {
    const channels = surfaceModel.channels as {
      channels: Record<
        string,
        {
          inputShape?: string;
          taskFields?: string[];
          tokenSamples?: { maxItems: number; timestampsIncluded: boolean };
          nominalCallbackIntervalMs?: number;
        }
      >;
    };
    const probe = JSON.parse(
      readFileSync(
        join(selected.surfaceRoot, 'vendors', 'claude', 'probes', `claude@${selected.version}`, 'status-channels.json'),
        'utf8',
      ),
    ) as {
      subagentStatusLine: {
        present: boolean;
        inputShape: string;
        taskFields: string[];
        tokenSamples: { maxItems: number; timestampsIncluded: boolean };
        nominalCallbackIntervalMs: number;
      };
    };
    const expectedFields = [
      'id',
      'name',
      'type',
      'agentType',
      'status',
      'description',
      'label',
      'startTime',
      'model',
      'effort',
      'contextWindowSize',
      'tokenCount',
      'tokenSamples',
      'cwd',
    ];

    expect(probe.subagentStatusLine).toEqual({
      present: true,
      inputShape: 'full-task-snapshot',
      taskFields: expectedFields,
      tokenSamples: { maxItems: 16, timestampsIncluded: false },
      nominalCallbackIntervalMs: 5_000,
    });
    expect(channels.channels.subagentStatusLine).toMatchObject({
      inputShape: 'full-task-snapshot',
      taskFields: expectedFields,
      tokenSamples: { maxItems: 16, timestampsIncluded: false },
      nominalCallbackIntervalMs: 5_000,
    });
  });

  it('exactly covers the model events carrying retained runtime fixtures', () => {
    const capturedEvents = readdirSync(join(selected.modelRoot, 'events'))
      .filter((file) => file.endsWith('.json'))
      .filter((file) => {
        const event = file.replace(/\.json$/, '');
        return surfaceModel.events.find((candidate) => candidate.event === event)?.fixture !== undefined;
      })
      .map((file) => file.replace(/\.json$/, ''))
      .sort();
    expect(listHookFixtureEvents()).toEqual(capturedEvents);
  });

  it('every record carries the common envelope and matches its file', () => {
    for (const event of listHookFixtureEvents()) {
      const records = loadHookFixtures(event);
      expect(records.length).toBeGreaterThan(0);
      for (const record of records) {
        expect(record.hook_event_name).toBe(event);
        expect(typeof record.session_id).toBe('string');
        expect(record.session_id.length).toBeGreaterThan(0);
        expect(record.transcript_path).toMatch(/^\/workspace\/transcripts\//);
        expect(typeof record.cwd).toBe('string');
      }
    }
  });

  it('tool events carry tool_use_id; prompts carry prompt and prompt_id', () => {
    for (const record of loadHookFixtures('PreToolUse')) {
      expect(typeof record.tool_use_id).toBe('string');
      expect(record.tool_name).toBeDefined();
    }
    for (const record of loadHookFixtures('UserPromptSubmit')) {
      expect(typeof record.prompt).toBe('string');
      expect(typeof record.prompt_id).toBe('string');
    }
  });

  it('retains the documented Write and Edit input contracts without overstating their confidence', () => {
    const descriptor = surfaceModel.events.find((event) => event.event === 'PreToolUse')!;
    expect(descriptor.confidence).toBe('unverified');
    expect(descriptor.schemaFidelity).toMatchObject({ payload: 'structural' });
    const common = {
      session_id: 'session',
      transcript_path: '/workspace/transcripts/session.jsonl',
      cwd: '/workspace',
      hook_event_name: 'PreToolUse',
      tool_use_id: 'tool',
    };
    expect(
      validatePayload(descriptor.payloadSchema!, {
        ...common,
        tool_name: 'Write',
        tool_input: { file_path: '/workspace/a.ts' },
      }),
    ).toContain('missing required field "tool_input.content"');
    expect(
      validatePayload(descriptor.payloadSchema!, {
        ...common,
        tool_name: 'Edit',
        tool_input: { file_path: '/workspace/a.ts', old_string: 'before' },
      }),
    ).toContain('missing required field "tool_input.new_string"');
  });

  it('MessageDisplay fixtures have the streaming shape found by the probe', () => {
    for (const record of loadHookFixtures('MessageDisplay')) {
      expect(typeof record.delta).toBe('string');
      expect(typeof record.final).toBe('boolean');
      expect(typeof record.turn_id).toBe('string');
      expect(typeof record.message_id).toBe('string');
    }
  });
});

// These events need the interactive census lane (native TUI against a loopback
// model). A candidate must either carry captures for them or keep their model
// confidence explicitly unverified; documentation alone is never promoted to
// runtime evidence.
describe('interactive hook fixtures', () => {
  it('PermissionRequest carries the pending tool but NO tool_use_id (correlate via prompt_id)', () => {
    const records = expectCapturedOrUnverified('PermissionRequest');
    for (const record of records) {
      expect(typeof record.prompt_id).toBe('string');
      expect(typeof record.tool_name).toBe('string');
      expect(typeof record.tool_input).toBe('object');
      // The permission gate fires before a tool_use_id is assigned: correlation
      // to PreToolUse is by (prompt_id + tool_name + tool_input), not tool id.
      expect(record.tool_use_id).toBeUndefined();
      expect(Array.isArray(record.permission_suggestions)).toBe(true);
    }
  });

  it('Notification identifies the reason it interrupted', () => {
    const records = expectCapturedOrUnverified('Notification');
    for (const record of records) {
      expect(typeof record.notification_type).toBe('string');
      expect(typeof record.message).toBe('string');
    }
  });

  it('PostToolUseFailure carries tool_use_id + an error string (approved tool that failed)', () => {
    const records = expectCapturedOrUnverified('PostToolUseFailure');
    for (const record of records) {
      expect(typeof record.tool_use_id).toBe('string');
      expect(typeof record.tool_name).toBe('string');
      expect(typeof record.error).toBe('string');
      expect(typeof record.is_interrupt).toBe('boolean');
    }
  });

  it('SubagentStart/Stop carry agent_id + agent_type; Stop adds the agent transcript path', () => {
    for (const record of expectCapturedOrUnverified('SubagentStart')) {
      expect(typeof record.agent_id).toBe('string');
      expect((record.agent_id as string).length).toBeGreaterThan(0);
      expect(typeof record.agent_type).toBe('string');
    }
    for (const record of expectCapturedOrUnverified('SubagentStop')) {
      expect(typeof record.agent_id).toBe('string');
      expect(typeof record.agent_type).toBe('string');
      expect(record.agent_transcript_path).toMatch(/^\/workspace\/transcripts\//);
      expect(record.last_assistant_message).toBeDefined();
    }
  });
});

describe('2.1.308 hook surface', () => {
  const probeRoot = join(selected.surfaceRoot, 'vendors', 'claude', 'probes', `claude@${selected.version}`);

  it('models exactly the hook-event inventory the pinned executable carries', () => {
    const inventory = JSON.parse(readFileSync(join(probeRoot, 'hook-events.json'), 'utf8')) as {
      events: number;
      order: string[];
    };
    expect([...inventory.order].sort()).toEqual([...CLAUDE_HOOK_EVENTS].sort());
    expect(surfaceModel.events.map((event) => event.event).sort()).toEqual([...CLAUDE_HOOK_EVENTS].sort());
  });

  it('never makes PreModelSwitch a passive observer, because a missed deadline blocks the switch', () => {
    const descriptor = (event: string) => surfaceModel.events.find((candidate) => candidate.event === event)!;
    expect(descriptor('PreModelSwitch').observationMode).toBe('timeout-blocks');
    expect(descriptor('PostModelSwitch').observationMode).toBe('passive');
    for (const record of loadHookFixtures('PreModelSwitch')) {
      expect(['command', 'picker', 'sdk']).toContain(record.source);
      expect(typeof record.to_model).toBe('string');
    }
  });

  it('maps each loopback HTTP failure to its native StopFailure error, with no credential too', () => {
    const errorOf = (mode: string) =>
      readFileSync(join(captureRoot, mode, 'StopFailure.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => (JSON.parse(line) as CapturedHookRecord).error);
    if (!captureModes.includes('api-error-401')) {
      expect(modelConfidence('StopFailure')).toBe('unverified');
      return;
    }
    expect(errorOf('api-error-400')).toEqual(['unknown']);
    expect(errorOf('api-error-401')).toEqual(['authentication_failed']);
    expect(errorOf('api-error-429')).toEqual(['rate_limit']);
    expect(errorOf('api-error-500')).toEqual(['server_error']);
    expect(errorOf('api-error-529')).toEqual(['server_error']);
    expect(errorOf('headless')).toEqual(['authentication_failed']);
  });

  it('carries the resume staleness fields on a resumed SessionStart', () => {
    const resumed = loadHookFixtures('SessionStart').filter((record) => record.source === 'resume');
    if (resumed.length === 0) return;
    for (const record of resumed) {
      expect(typeof record.seconds_since_last_response).toBe('number');
      expect(typeof record.context_tokens).toBe('number');
      expect(typeof record.prompt_cache_likely_expired).toBe('boolean');
      expect(typeof record.estimated_cache_write_usd).toBe('number');
    }
  });
});

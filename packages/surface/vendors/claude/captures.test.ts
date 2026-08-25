import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveAgentModel } from '../../../../scripts/agent-model-selection.mjs';

interface CapturedHookRecord {
  session_id: string;
  transcript_path: string;
  cwd: string;
  hook_event_name: string;
  [key: string]: unknown;
}

const selected = resolveAgentModel({ vendor: 'claude' });
const captureRoot = selected.capturesRoot;
const captureModes = readdirSync(captureRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

function modelConfidence(event: string): string {
  const path = join(selected.modelRoot, 'events', `${event}.json`);
  return (JSON.parse(readFileSync(path, 'utf8')) as { confidence: string }).confidence;
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
    const channels = JSON.parse(readFileSync(join(selected.modelRoot, 'channels.json'), 'utf8')) as {
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

  it('exactly covers the events the active model labels runtime-verified', () => {
    const verifiedEvents = readdirSync(join(selected.modelRoot, 'events'))
      .filter((file) => file.endsWith('.json'))
      .filter((file) => {
        const event = file.replace(/\.json$/, '');
        return modelConfidence(event) !== 'unverified';
      })
      .map((file) => file.replace(/\.json$/, ''))
      .sort();
    expect(listHookFixtureEvents()).toEqual(verifiedEvents);
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

  it('MessageDisplay fixtures have the streaming shape found by the probe', () => {
    for (const record of loadHookFixtures('MessageDisplay')) {
      expect(typeof record.delta).toBe('string');
      expect(typeof record.final).toBe('boolean');
      expect(typeof record.turn_id).toBe('string');
      expect(typeof record.message_id).toBe('string');
    }
  });
});

// These events require credentialed interactive paths. A candidate produced by
// the isolated census must either carry captures for them or keep their model
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

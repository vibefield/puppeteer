import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { REDACTED_EPOCH_MS, checkRecord, extendRules } from '@vibefield/puppeteer-surface/sanitize';
import {
  REDACTED_EPOCH_SECONDS,
  REDACTED_MACHINE_AGENT_ID,
  checkGrokCaptureDirectory,
  checkGrokOnlyRecord,
  checkGrokRecord,
  grokRules,
  sanitizeGrokRecord,
} from './privacy.mjs';
import { sanitizeGrokCaptureSet } from './sanitize-captures.mjs';

/** The rules this vendor shipped before the 1.0.70 survey: they passed every leak below. */
const previousGrokRules = extendRules({ sensitiveTextKey: /^(?:signature|prompt_text|summary_preview|description)$/i });

// A disposable census root shaped like the survey's (uid-scoped temp dir, short socket dir).
const base = '/private/tmp/u-501/pw-grok/gkT3st01';
const roots = {
  base,
  home: `${base}/home`,
  grokHome: `${base}/grok-home`,
  workspace: `${base}/workspace`,
  tmp: `${base}/tmp`,
  socketDir: `${base}/s`,
  socket: `${base}/s/leader.sock`,
  artifact: '/opt/grok-artifacts/grok@1.0.70/darwin-arm64/grok',
};
const sessionId = '01a17155-ba5c-7430-ad1f-fa0f9a57645a';
const bucket = encodeURIComponent(roots.workspace);

/** Leaks found by the survey and critic in output that the previous sanitizer reported clean. */
const surveyedLeaks = {
  currentWorkingDirectory: {
    jsonrpc: '2.0',
    id: 1,
    result: {
      _meta: {
        currentWorkingDirectory:
          '/private/tmp/u-501/-Users-<redacted>-proj/a11a5ed0-fb8c-4e30-9b8e-7bdb1449b402/homes/x/workspace',
      },
    },
  },
  facets: {
    jsonrpc: '2.0',
    id: 3,
    result: {
      _meta: {
        'x.ai/facets': {
          scope: 'window',
          keys: [{ key: 'cwd', values: [{ value: '/private/tmp/u-501/pw-grok/gkT3st01/workspace', count: 1 }] }],
        },
      },
    },
  },
  outputFile: {
    method: 'session/update',
    params: {
      update: {
        sessionUpdate: 'tool_call_update',
        rawOutput: {
          output_file: `/private/tmp/u-501/pw-grok/gkT3st01/grok-home/sessions/${bucket}/a11a5ed0-452a-4f68-bd0f-96c6b002c70d/terminal/call_1.log`,
        },
      },
    },
  },
  runningText: {
    method: '_x.ai/queue/changed',
    params: { runningText: 'Reply with exactly SURFACE_GROK_TUI_OK and do not use tools.' },
  },
  sessionSummary: {
    method: 'summary.json',
    params: { session_summary: 'fix the payment bug', last_turn_summary: 'Patched checkout.ts' },
  },
  argumentsDelta: {
    method: '_x.ai/session_notification',
    params: { update: { sessionUpdate: 'tool_call_delta_chunk', arguments_delta: '{"command":"cat ~/.ssh/id_rsa"' } },
  },
  byteOutput: {
    method: 'session/update',
    params: { update: { rawOutput: { type: 'Bash', output: [83, 85, 82, 70, 65, 67, 69, 95, 79, 75, 10] } } },
  },
  durableSecondsClock: { timestamp: 1_792_902_812, method: 'session/update', params: {} },
  millisecondClock: { method: 'session/update', params: { _meta: { agentTimestampMs: 1_792_902_812_084 } } },
  isoClock: { method: 'usage.json', params: { updatedAt: '2026-10-25T04:33:38.770700+00:00' } },
  xaiPrefixedIds: {
    method: '_x.ai/session_notification',
    params: { update: { agentAddress: 'aa1.cf10055a3750446b8d183b11f8d11b5e' } },
  },
};

describe('Grok capture privacy', () => {
  it('treats native prose and signatures as sensitive regardless of nesting', () => {
    const raw = {
      signature: 'provider-authenticated-signature',
      update: {
        prompt_text: 'private user prompt',
        summary_preview: 'private compacted context',
        description: 'private workflow description',
        runningText: 'private queued prompt',
        session_summary: 'private session summary',
        arguments_delta: '{"command":"private"',
      },
    };
    expect(checkRecord(raw, grokRules)).toEqual([
      '<record>.signature: unsanitized sensitive field signature',
      '<record>.update.prompt_text: unsanitized sensitive field prompt_text',
      '<record>.update.summary_preview: unsanitized sensitive field summary_preview',
      '<record>.update.description: unsanitized sensitive field description',
      '<record>.update.runningText: unsanitized sensitive field runningText',
      '<record>.update.session_summary: unsanitized sensitive field session_summary',
      '<record>.update.arguments_delta: unsanitized sensitive field arguments_delta',
    ]);
    expect(checkGrokRecord(sanitizeGrokRecord(raw))).toEqual([]);
  });

  it('detects every surveyed 1.0.70 leak that the previous rules reported clean', () => {
    for (const [name, record] of Object.entries(surveyedLeaks)) {
      const previous = checkRecord(record, previousGrokRules).filter(
        // The shared clock rule always caught a bare `timestamp`; it pinned it to the wrong unit instead.
        (issue) => !issue.includes('unpinned wall-clock timestamp at timestamp'),
      );
      expect(previous, name).toEqual([]);
      expect(checkGrokRecord(record).length, name).toBeGreaterThan(0);
    }
  });

  it('redacts each surveyed leak in place without changing native types', () => {
    // The survey's leaked cwd was already partially rewritten; sanitize the native value Grok emits instead.
    const nativeInputs = {
      ...surveyedLeaks,
      currentWorkingDirectory: {
        jsonrpc: '2.0',
        id: 1,
        result: { _meta: { currentWorkingDirectory: roots.workspace } },
      },
    };
    for (const [name, record] of Object.entries(nativeInputs)) {
      const sanitized = sanitizeGrokRecord(record, { roots });
      expect(checkGrokRecord(sanitized), name).toEqual([]);
    }
    expect(sanitizeGrokRecord(nativeInputs.currentWorkingDirectory, { roots }).result._meta).toEqual({
      currentWorkingDirectory: '/workspace',
    });
    const cwd = sanitizeGrokRecord(surveyedLeaks.facets, { roots });
    expect(cwd.result._meta['x.ai/facets'].keys[0].values[0]).toEqual({ value: '/workspace', count: 1 });
    const output = sanitizeGrokRecord(surveyedLeaks.outputFile, { roots });
    expect(output.params.update.rawOutput.output_file).toBe('<redacted:output_file>');
    const bytes = sanitizeGrokRecord(surveyedLeaks.byteOutput, { roots }).params.update.rawOutput;
    expect(bytes).toEqual({ type: 'Bash', output: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] });
  });

  it('pins Grok clocks in their native unit', () => {
    expect(sanitizeGrokRecord(surveyedLeaks.durableSecondsClock).timestamp).toBe(REDACTED_EPOCH_SECONDS);
    expect(sanitizeGrokRecord(surveyedLeaks.millisecondClock).params._meta.agentTimestampMs).toBe(REDACTED_EPOCH_MS);
    expect(sanitizeGrokRecord(surveyedLeaks.isoClock).params.updatedAt).toBe('2026-01-01T00:00:00.000000+00:00');
    expect(sanitizeGrokRecord({ created_at: '2026-10-25T04:33:26.127185Z' }).created_at).toBe(
      '2026-01-01T00:00:00.000000Z',
    );
    // The seconds pin never exceeds the shared detector's floor, so the default repository gate accepts it.
    expect(checkRecord({ timestamp: REDACTED_EPOCH_SECONDS })).toEqual([]);
  });

  it('replaces the stable machine agentId with one constant and aliases xAI prefixed ids', () => {
    const sanitized = sanitizeGrokRecord({
      result: {
        _meta: {
          agentId: '0a9b748d-4843-5f20-9dac-418c1a205f2b',
          agentInstanceId: '3ad8d1dc-da8d-4b39-841b-b6457c98cf39',
        },
      },
      agent_id: 'ag1.27324ec197394f588fce10cb4a4d693b',
      attempt_id: 'at1.36e36d0e51c3441fa973e64d08071372',
      agentAddress: 'aa1.cf10055a3750446b8d183b11f8d11b5e',
    });
    expect(sanitized.result._meta.agentId).toBe(REDACTED_MACHINE_AGENT_ID);
    expect(sanitized.result._meta.agentInstanceId).toMatch(/^a11a5ed0-/);
    expect(sanitized.agent_id).toMatch(/^anon-[0-9a-f]{16}$/);
    expect(sanitized.attempt_id).toMatch(/^anon-[0-9a-f]{16}$/);
    expect(sanitized.agentAddress).toMatch(/^anon-[0-9a-f]{16}$/);
    expect(checkGrokOnlyRecord({ result: { _meta: { agentId: 'a11a5ed0-941b-4c9c-b821-1f7f774ac405' } } })).toEqual([
      '<record>.result._meta.agentId: machine agentId is not the fixed redaction',
    ]);
  });

  it('keeps tool discriminators and event-id shape while redacting raw tool arguments', () => {
    const sanitized = sanitizeGrokRecord(
      {
        params: {
          update: {
            rawInput: { variant: 'Bash', command: 'echo hi > out.txt', description: 'write', is_background: false },
            _meta: { 'x.ai/tool': { name: 'run_terminal_command', kind: 'execute', input: { command: 'echo hi' } } },
          },
          _meta: { eventId: `${sessionId}-25` },
        },
      },
      { roots },
    );
    expect(sanitized.params.update.rawInput).toEqual({
      variant: 'Bash',
      command: '<redacted:command>',
      description: '<redacted:description>',
      is_background: false,
    });
    expect(sanitized.params.update._meta['x.ai/tool']).toEqual({
      name: 'run_terminal_command',
      kind: 'execute',
      input: { command: '<redacted:command>' },
    });
    expect(sanitized.params._meta.eventId).toMatch(
      /^a11a5ed0-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-25$/,
    );
  });

  it('promotes only native carriers from a raw census and never a persisted permission rule', () => {
    const temporary = mkdtempSync(join(tmpdir(), 'grok-sanitize-'));
    const input = join(temporary, 'raw');
    const output = join(temporary, 'sanitized');
    const scenario = join(input, 'viewer-session');
    const sessionDir = join(scenario, 'store', 'sessions', bucket, sessionId);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(input, 'harness.json'),
      JSON.stringify({
        version: '1.0.70',
        versionOutput: 'grok 1.0.70 (f50904eaee6c)',
        platform: 'darwin-arm64',
        artifactSha256: '5c8a688251bf61e35370b828b6a353b0a20fcc3f64000de8a91d426039f29cec',
        capturedAt: '2026-10-25T04:33:00.000Z',
        scenarios: { 'viewer-session': [{ id: 'session-new-result', ok: true }] },
      }),
    );
    writeFileSync(join(scenario, 'roots.json'), JSON.stringify(roots));
    const frames = [
      {
        t: 1,
        direction: 'client-to-agent',
        message: { jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: roots.workspace, mcpServers: [] } },
      },
      { t: 2, direction: 'agent-to-client', message: { jsonrpc: '2.0', id: 2, result: { sessionId } } },
      {
        t: 3,
        direction: 'agent-to-client',
        message: {
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId,
            update: {
              sessionUpdate: 'tool_call_update',
              content: [{ type: 'diff', path: `${roots.workspace}/a.ts`, oldText: 'before', newText: 'after' }],
            },
          },
        },
      },
    ];
    writeFileSync(
      join(scenario, 'acp-controller.jsonl'),
      `${frames.map((frame) => JSON.stringify(frame)).join('\n')}\n`,
    );
    writeFileSync(
      join(sessionDir, 'updates.jsonl'),
      `${JSON.stringify({ timestamp: 1_792_902_812, method: 'session/update', params: { sessionId, update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'SURFACE_SECRET' } } } })}\n`,
    );
    writeFileSync(
      join(sessionDir, 'summary.json'),
      JSON.stringify({
        info: { id: sessionId, cwd: roots.workspace },
        grok_home: roots.grokHome,
        session_summary: 'x',
      }),
    );
    writeFileSync(join(sessionDir, 'chat_history.jsonl'), '{"role":"user","content":"private"}\n');
    writeFileSync(
      join(scenario, 'store', 'sessions', bucket, `permission__${encodeURIComponent(roots.artifact)}.toml`),
      'allowed_bash_commands = ["echo"]\n',
    );
    writeFileSync(join(scenario, 'observations.json'), JSON.stringify({ scenario: 'viewer-session', turns: [] }));
    writeFileSync(
      join(scenario, 'processes.jsonl'),
      `${JSON.stringify({ t: 0, label: 'leader', role: 'leader', args: ['agent', 'leader', '--leader-socket', roots.socket] })}\n`,
    );
    writeFileSync(
      join(scenario, 'store-listing.json'),
      JSON.stringify([`sessions/${bucket}/${sessionId}/updates.jsonl`, `sessions/${bucket}/permission__x.toml`]),
    );
    try {
      sanitizeGrokCaptureSet(input, output, { version: '1.0.70' });
      expect(checkGrokCaptureDirectory(output)).toEqual([]);
      expect(readdirSync(join(output, 'viewer-session')).sort()).toEqual([
        'acp-controller.jsonl',
        'observations.json',
        'state.jsonl',
        'store-layout.json',
        'topology.json',
        'updates.jsonl',
      ]);
      const serialized = readdirSync(join(output, 'viewer-session'))
        .map((name) => readFileSync(join(output, 'viewer-session', name), 'utf8'))
        .join('\n');
      expect(serialized).not.toContain('allowed_bash_commands');
      expect(serialized).not.toContain('permission__');
      const wire = readFileSync(join(output, 'viewer-session', 'acp-controller.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(wire.map((frame) => Object.keys(frame))).toEqual([
        ['direction', 'message'],
        ['direction', 'message'],
        ['direction', 'message'],
      ]);
      expect(wire[0].message.params.cwd).toBe('/workspace');
      const diff = wire[2].message.params.update.content[0];
      expect(diff).toEqual(
        expect.objectContaining({
          type: 'diff',
          path: expect.any(String),
          oldText: expect.any(String),
          newText: expect.any(String),
        }),
      );
      expect(diff.path).toMatch(/^\/workspace/);
      const durable = JSON.parse(readFileSync(join(output, 'viewer-session', 'updates.jsonl'), 'utf8'));
      expect(durable.timestamp).toBe(REDACTED_EPOCH_SECONDS);
      expect(durable.params.update.content.text).toBe('<redacted:text>');
      const metadata = JSON.parse(readFileSync(join(output, 'capture.json'), 'utf8'));
      expect(metadata).toMatchObject({ schemaVersion: 2, representation: 'type-preserving-redaction' });
      expect(existsSync(join(output, 'capture-fidelity.json'))).toBe(true);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });
});

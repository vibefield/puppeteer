import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@vibefield/puppeteer-core';
import {
  ANTIGRAVITY_1_4_CONTRACT,
  ANTIGRAVITY_1_4_MONITOR_CAPABILITIES,
  ANTIGRAVITY_CONTRACT,
  ANTIGRAVITY_MONITOR_CAPABILITIES,
} from './monitor-capabilities.js';
import { antigravityCapabilitiesBatch, antigravityObservationDegradedBatch } from './monitor.js';
import { AntigravityTranscriptNormalizer } from './pipeline.js';
import type { AntigravityNormalizedRecord } from './types.js';

const captures = (path: string) =>
  fileURLToPath(new URL(`../../../surface/vendors/antigravity/captures/${path}`, import.meta.url));
const journal = (path: string): unknown[] =>
  readFileSync(captures(path), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
const replay = (records: unknown[]) => {
  const normalizer = new AntigravityTranscriptNormalizer();
  return { normalizer, normalized: records.map((record) => normalizer.normalize(record)) };
};
const events = (normalized: AntigravityNormalizedRecord[]): AgentEvent[] => normalized.flatMap(({ events }) => events);
const withoutBatchId = <T extends { batchId: string }>(batch: T) => ({ ...batch, batchId: 'x' });

describe('Antigravity 1.1.x replay is unchanged by the 1.4.12 migration', () => {
  const golden = JSON.parse(readFileSync(new URL('./__fixtures__/replay-1.1.x.json', import.meta.url), 'utf8')) as {
    journals: Record<string, unknown>;
    capabilities: unknown;
    degraded: unknown;
  };
  for (const path of Object.keys(golden.journals))
    it(`reproduces ${path} exactly`, () => {
      expect(JSON.parse(JSON.stringify(replay(journal(path)).normalized))).toEqual(golden.journals[path]);
    });
  it('keeps the 1.1.20 contract and claims by default', () => {
    expect(withoutBatchId(antigravityCapabilitiesBatch('s', 't', 3))).toEqual(golden.capabilities);
    expect(withoutBatchId(antigravityObservationDegradedBatch('s', 't', 4))).toEqual(golden.degraded);
  });
  it('proves no newer journal shape from any 1.1.x capture', () => {
    for (const path of Object.keys(golden.journals))
      expect(replay(journal(path)).normalizer.journalShape()).toBeUndefined();
  });
});

describe('Antigravity 1.4.12 captured journals', () => {
  it('joins the GENERIC command result to the run_command call (tool-use)', () => {
    const { normalizer, normalized } = replay(journal('antigravity@1.4.12/tool-use/events.jsonl'));
    expect(normalizer.journalShape()).toBe('1.4.12');
    expect(normalized.map(({ disposition }) => disposition)).toEqual(['mapped', 'mapped', 'mapped', 'mapped']);
    expect(normalized[1]!.events).toEqual([
      {
        type: 'tool:requested',
        toolCallId: 'step:1:tool:0',
        tool: 'run_command',
        // Captures redact every argument, so the encoded-argument decoder sees
        // strings that do not parse and leaves them as they are.
        input: {
          CommandLine: '<redacted:CommandLine>',
          WaitMsBeforeAsync: '<redacted:WaitMsBeforeAsync>',
          toolSummary: '<redacted:toolSummary>',
        },
        presentation: { kind: 'command', title: 'Using run_command', detail: '<redacted:CommandLine>' },
      },
    ]);
    expect(normalized[2]).toMatchObject({ turnId: 'turn:0', promptId: 'turn:0' });
    expect(normalized[2]!.events).toEqual([
      {
        type: 'tool:completed',
        toolCallId: 'step:1:tool:0',
        tool: 'run_command',
        output: '<redacted:content>',
        presentation: { kind: 'command', title: 'Used run_command', detail: '<redacted:CommandLine>' },
      },
    ]);
    // No CHECKPOINT follows: planner content alone completes the turn.
    expect(normalized[3]!.events.map(({ type }) => type)).toEqual(['conversation:assistant-message', 'turn:completed']);
  });

  it('keeps planner token counts out of the event stream (usage)', () => {
    const { normalized } = replay(journal('antigravity@1.4.12/usage/events.jsonl'));
    const types = events(normalized).map(({ type }) => type);
    expect(types).toEqual([
      'turn:started',
      'tool:requested',
      'tool:completed',
      'conversation:assistant-message',
      'turn:completed',
    ]);
    expect(types).not.toContain('usage:tokens-used');
  });

  it('maps both turns of a resumed conversation and retains SYSTEM_MESSAGE (resume)', () => {
    const { normalized } = replay(journal('antigravity@1.4.12/resume/events.jsonl'));
    expect(events(normalized).map(({ type }) => type)).toEqual([
      'turn:started',
      'conversation:assistant-message',
      'turn:completed',
      'turn:started',
      'adapter:native-event',
      'conversation:assistant-message',
      'turn:completed',
    ]);
    expect(normalized[3]!.disposition).toBe('retained-native');
  });

  it('completes a plain chat without CHECKPOINT (basic-chat)', () => {
    const { normalizer, normalized } = replay(journal('antigravity@1.4.12/basic-chat/events.jsonl'));
    expect(normalizer.journalShape()).toBe('1.4.12');
    expect(events(normalized).map(({ type }) => type)).toEqual([
      'turn:started',
      'conversation:assistant-message',
      'turn:completed',
    ]);
  });
});

// Shapes copied from Rosetta groundtruth/antigravity/fixtures/1.4.12/tool-use
// (e5f1111): the raw, unredacted transcript.jsonl and transcript_full.jsonl.
// Their text is the loopback mock's. The Puppeteer captures redact these
// values, so the decoding is pinned here.
const RAW_PLANNER = {
  step_index: 1,
  source: 'MODEL',
  type: 'PLANNER_RESPONSE',
  status: 'DONE',
  created_at: '2026-11-04T18:57:51Z',
  input_tokens: 128,
  cache_read_tokens: 0,
  output_tokens: 32,
};
const RAW_GENERIC = {
  step_index: 2,
  source: 'MODEL',
  type: 'GENERIC',
  status: 'DONE',
  created_at: '2026-11-04T18:57:51Z',
  content:
    'Created At: 2026-11-04T10:57:51-08:00\nCompleted At: 2026-11-04T10:57:51-08:00\nCommand exited with code 0.\n\nCommand output:\nrosetta-mock\r\n',
};
const USER = (step: number) => ({
  step_index: step,
  source: 'USER_EXPLICIT',
  type: 'USER_INPUT',
  status: 'DONE',
  content: '<USER_REQUEST>\nRun the echo command now. [use-tool]\n</USER_REQUEST>',
});
const DECODED = { CommandLine: 'echo rosetta-mock', WaitMsBeforeAsync: 5000, toolSummary: 'Echo command check' };

describe('Antigravity 1.4.12 raw transcript shapes (from Rosetta fixtures)', () => {
  it('decodes transcript.jsonl JSON-encoded arguments', () => {
    const normalizer = new AntigravityTranscriptNormalizer();
    normalizer.normalize(USER(0));
    const request = normalizer.normalize({
      ...RAW_PLANNER,
      tool_calls: [
        {
          name: 'run_command',
          args: {
            CommandLine: '"echo rosetta-mock"',
            WaitMsBeforeAsync: '5000',
            toolSummary: '"Echo command check"',
          },
        },
      ],
    });
    expect(request.events[0]).toEqual({
      type: 'tool:requested',
      toolCallId: 'step:1:tool:0',
      tool: 'run_command',
      input: DECODED,
      presentation: { kind: 'command', title: 'Using run_command', detail: 'echo rosetta-mock' },
    });
    expect(normalizer.normalize(RAW_GENERIC).events[0]).toMatchObject({
      type: 'tool:completed',
      toolCallId: 'step:1:tool:0',
      output: RAW_GENERIC.content,
    });
  });

  it('keeps transcript_full.jsonl real-typed arguments as they are', () => {
    const normalizer = new AntigravityTranscriptNormalizer();
    normalizer.normalize(USER(0));
    const request = normalizer.normalize({ ...RAW_PLANNER, tool_calls: [{ name: 'run_command', args: DECODED }] });
    expect(request.events[0]).toMatchObject({ input: DECODED, presentation: { detail: 'echo rosetta-mock' } });
  });

  it('decodes a later planner step by the shape the journal already proved', () => {
    const normalizer = new AntigravityTranscriptNormalizer();
    normalizer.normalize(USER(0));
    normalizer.normalize({ ...RAW_PLANNER, content: 'proved' });
    const request = normalizer.normalize({
      type: 'PLANNER_RESPONSE',
      step_index: 2,
      tool_calls: [{ name: 'view_file', args: { AbsolutePath: '"/a"' } }],
    });
    expect(request.events[0]).toMatchObject({ input: { AbsolutePath: '/a' }, presentation: { detail: '/a' } });
  });

  it('keeps real-typed string arguments that happen to parse as JSON', () => {
    const normalizer = new AntigravityTranscriptNormalizer();
    normalizer.normalize(USER(0));
    for (const CommandLine of ['true', '42']) {
      const request = normalizer.normalize({
        ...RAW_PLANNER,
        tool_calls: [{ name: 'run_command', args: { CommandLine } }],
      });
      expect(request.events[0]).toMatchObject({ input: { CommandLine }, presentation: { detail: CommandLine } });
    }
  });

  it('proves the shape from CommandLine even without planner token counts', () => {
    const normalizer = new AntigravityTranscriptNormalizer();
    normalizer.normalize(USER(0));
    normalizer.normalize({
      type: 'PLANNER_RESPONSE',
      step_index: 1,
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'echo rosetta-mock' } }],
    });
    expect(normalizer.journalShape()).toBe('1.4.12');
    expect(normalizer.normalize(RAW_GENERIC).events[0]).toMatchObject({ type: 'tool:completed' });
  });
});

describe('Antigravity 1.4.12 GENERIC correlation boundaries (constructed)', () => {
  const start = (calls: unknown[]) => {
    const normalizer = new AntigravityTranscriptNormalizer();
    normalizer.normalize(USER(0));
    normalizer.normalize({ ...RAW_PLANNER, tool_calls: calls });
    return normalizer;
  };
  const command = { name: 'run_command', args: { CommandLine: 'echo a' } };

  it('fails the call from step status or error, never from content', () => {
    expect(start([command]).normalize({ ...RAW_GENERIC, status: 'ERROR' }).events[0]).toMatchObject({
      type: 'tool:failed',
      toolCallId: 'step:1:tool:0',
    });
    expect(start([command]).normalize({ ...RAW_GENERIC, error: { message: 'denied' } }).events[0]).toEqual({
      type: 'tool:failed',
      toolCallId: 'step:1:tool:0',
      tool: 'run_command',
      error: 'denied',
      presentation: { kind: 'command', title: 'Used run_command', detail: 'echo a' },
    });
  });

  it('joins calls in request order', () => {
    const normalizer = start([command, { name: 'run_command', args: { CommandLine: 'echo b' } }]);
    expect(normalizer.normalize(RAW_GENERIC).events[0]).toMatchObject({ toolCallId: 'step:1:tool:0' });
    expect(normalizer.normalize({ ...RAW_GENERIC, step_index: 3 }).events[0]).toMatchObject({
      toolCallId: 'step:1:tool:1',
    });
    expect(normalizer.normalize({ ...RAW_GENERIC, step_index: 4 }).disposition).toBe('retained-native');
  });

  it('retains a GENERIC step when the oldest outstanding call is not a command', () => {
    const normalizer = start([{ name: 'view_file', args: { AbsolutePath: '/a' } }, command]);
    const result = normalizer.normalize(RAW_GENERIC);
    expect(result.disposition).toBe('retained-native');
    expect(result.events).toEqual([{ type: 'adapter:native-event', adapter: 'antigravity', nativeType: 'GENERIC' }]);
  });

  it('joins a later planner step command after an earlier call got no typed result', () => {
    const normalizer = start([{ name: 'write_to_file', args: { TargetFile: '"/a"' } }]);
    expect(normalizer.normalize(RAW_GENERIC).disposition).toBe('retained-native');
    normalizer.normalize({
      ...RAW_PLANNER,
      step_index: 3,
      tool_calls: [{ name: 'run_command', args: { CommandLine: '"ls"' } }],
    });
    expect(normalizer.normalize({ ...RAW_GENERIC, step_index: 4 }).events[0]).toMatchObject({
      type: 'tool:completed',
      toolCallId: 'step:3:tool:0',
    });
  });

  it('closes the GENERIC window at the next planner step', () => {
    const normalizer = start([command]);
    normalizer.normalize({ ...RAW_PLANNER, step_index: 2, content: 'answered without a result step' });
    expect(normalizer.normalize({ ...RAW_GENERIC, step_index: 3 }).disposition).toBe('retained-native');
  });

  it('reads a non-zero exit written as a DONE step as completed (declared limitation)', () => {
    const failed = { ...RAW_GENERIC, content: RAW_GENERIC.content.replace('code 0.', 'code 2.') };
    expect(start([command]).normalize(failed).events[0]).toMatchObject({
      type: 'tool:completed',
      toolCallId: 'step:1:tool:0',
    });
  });

  it('drops calls left pending when the next prompt arrives', () => {
    const normalizer = start([command]);
    normalizer.normalize(USER(2));
    expect(normalizer.normalize({ ...RAW_GENERIC, step_index: 3 }).disposition).toBe('retained-native');
    expect(normalizer.normalize({ type: 'RUN_COMMAND', step_index: 4, exit_code: 0 }).disposition).toBe(
      'retained-native',
    );
  });

  it('never joins GENERIC in a journal that has not proven the 1.4.12 shape', () => {
    const normalizer = new AntigravityTranscriptNormalizer();
    normalizer.normalize(USER(0));
    normalizer.normalize({
      type: 'PLANNER_RESPONSE',
      step_index: 1,
      tool_calls: [{ name: 'run_command', args: { commandLine: 'echo a' } }],
    });
    expect(normalizer.normalize(RAW_GENERIC).disposition).toBe('retained-native');
    // The 1.1.20 typed result still joins.
    expect(normalizer.normalize({ type: 'RUN_COMMAND', step_index: 3, exit_code: 0 }).events[0]).toMatchObject({
      type: 'tool:completed',
      toolCallId: 'step:1:tool:0',
    });
  });
});

describe('Antigravity capabilities by journal shape', () => {
  it('announces the 1.4.12 contract with transcript usage excluded', () => {
    const batch = antigravityCapabilitiesBatch('s', 't', 2, '1.4.12');
    expect(batch.producer.contractVersion).toBe(ANTIGRAVITY_1_4_CONTRACT);
    expect(batch.evidence).toEqual([{ namespace: 'antigravity:surface-contract', id: ANTIGRAVITY_1_4_CONTRACT }]);
    expect(batch.capabilities?.find(({ family }) => family === 'usage')).toMatchObject({
      support: 'unsupported',
      source: 'antigravity-planner-response-tokens',
    });
    expect(antigravityObservationDegradedBatch('s', 't', 3, '1.4.12').producer.contractVersion).toBe(
      ANTIGRAVITY_1_4_CONTRACT,
    );
  });

  it('changes only the families 1.4.12 changed, and claims no more support', () => {
    expect(ANTIGRAVITY_CONTRACT).toBe('antigravity-transcript@1.1.20');
    const changed = new Set(['status', 'usage', 'context', 'compaction']);
    for (const [index, capability] of ANTIGRAVITY_1_4_MONITOR_CAPABILITIES.entries()) {
      const previous = ANTIGRAVITY_MONITOR_CAPABILITIES[index]!;
      expect(capability.family).toBe(previous.family);
      expect(capability.support).toBe(previous.support);
      if (!changed.has(capability.family))
        expect(capability).toEqual({ ...previous, contractVersion: ANTIGRAVITY_1_4_CONTRACT });
    }
  });
});

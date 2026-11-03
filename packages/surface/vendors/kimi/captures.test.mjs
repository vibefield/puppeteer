import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkCaptureDirectory } from '@vibefield/puppeteer-surface/sanitize';
import { kimiRepositoryGateRules, kimiRules } from './sanitize-captures.mjs';

const capturesRoot = join(import.meta.dirname, 'captures', 'kimi@2.4.1');
const expectedArtifactSha256 = 'f2b3634c17b604e5b0f0c578b6a787fd01bcafb40a3c0dd62203ae14ff2ea068';
const expectedScenarios = [
  'background-task',
  'basic-turn',
  'hook-block-prompt',
  'hook-deny-tool',
  'interrupt-stream',
  'malformed-stream',
  'provider-error',
  'provider-retry',
  'resume-turn',
  'subagent-turn',
  'tool-nonzero',
  'tool-success',
];
const expectedExitCodes = {
  'hook-block-prompt': 1,
  'interrupt-stream': 130,
  'provider-error': 1,
};

function json(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function jsonl(path) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function scenario(name) {
  return join(capturesRoot, name);
}

function wire(name) {
  return jsonl(join(scenario(name), 'wire.jsonl'));
}

function hookNames(name) {
  return readdirSync(join(scenario(name), 'hooks'))
    .filter((file) => file.endsWith('.jsonl'))
    .map((file) => file.replace(/\.jsonl$/, ''))
    .sort();
}

describe('Kimi 2.4.1 captures', () => {
  it('pins the executable and native wire protocol', () => {
    for (const name of expectedScenarios) {
      const process = json(join(scenario(name), 'process.json'));
      expect(process.identity.version).toBe('2.4.1');
      expect(process.artifactSha256).toBe(expectedArtifactSha256);
      expect(process.code).toBe(expectedExitCodes[name] ?? 0);
      expect(wire(name)[0]).toMatchObject({ type: 'metadata', protocol_version: '1.5' });
    }
  });

  it('records an exact two-invocation resume without resetting native turn ids', () => {
    const records = wire('resume-turn');
    expect(records.filter((record) => record.type === 'turn.prompt')).toHaveLength(2);
    expect(records.filter((record) => record.type === 'turn.ended').map((record) => record.turnId)).toEqual([0, 1]);
    expect(
      records.filter((record) => record.event?.type === 'step.begin').map((record) => record.event.turnId),
    ).toEqual(['0', '1']);
    expect(
      jsonl(join(scenario('resume-turn'), 'hooks', 'SessionStart.jsonl')).map((payload) => payload.source),
    ).toEqual(['startup', 'resume']);
    expect(json(join(scenario('resume-turn'), 'process.json')).invocations).toEqual([
      { resumed: false, code: 0, signal: null },
      { resumed: true, code: 0, signal: null },
    ]);
  });

  it('captures detached process task persistence and matching lifecycle hooks', () => {
    const records = wire('background-task');
    const started = records.find((record) => record.type === 'task.started');
    const terminated = records.find((record) => record.type === 'task.terminated');
    expect(started.info).toMatchObject({ kind: 'process', status: 'running', detached: true, endedAt: null });
    expect(terminated.info).toMatchObject({
      taskId: started.info.taskId,
      kind: 'process',
      status: 'completed',
      detached: true,
      exitCode: 0,
    });
    expect(records.indexOf(started)).toBeLessThan(records.indexOf(terminated));

    const taskStarted = jsonl(join(scenario('background-task'), 'hooks', 'TaskStarted.jsonl'))[0];
    const notification = jsonl(join(scenario('background-task'), 'hooks', 'Notification.jsonl'))[0];
    expect(taskStarted).toMatchObject({ task_id: started.info.taskId, kind: 'process', status: 'running' });
    expect(notification).toMatchObject({
      sink: 'context',
      notification_type: 'task.completed',
      severity: 'info',
      source_id: started.info.taskId,
    });
  });

  it('captures provider rejection as a failed turn and StopFailure hook', () => {
    const process = json(join(scenario('provider-error'), 'process.json'));
    const ended = wire('provider-error').find((record) => record.type === 'turn.ended');
    expect(process).toMatchObject({ code: 1, signal: null });
    expect(ended).toMatchObject({ reason: 'failed', error: { code: 'provider.auth_error', retryable: false } });
    expect(hookNames('provider-error')).toContain('StopFailure');
    expect(hookNames('provider-error')).not.toContain('Stop');
  });

  it('records the basic turn in native order, including the interleaved engine journal', () => {
    expect(wire('basic-turn').map((record) => record.event?.type ?? record.type)).toEqual([
      'metadata',
      'runtime.set_binding',
      'profile.bind',
      'changeNotifier.snapshot',
      'permission.set_mode',
      'turn.prompt',
      'context.append_message',
      'agent.message.appended',
      'context.append_message',
      'context.append_message',
      'agent.turn.started',
      'plugin.session_start',
      'step.begin',
      'llm.tools_snapshot',
      'llm.request',
      'usage.record',
      'token_counting.measured',
      'content.part',
      'content.part',
      'step.end',
      'agent.message.appended',
      'agent.turn.ended',
      'turn.ended',
      'token_counting.turn_recorded',
      'prompt.completed',
    ]);
    expect(hookNames('basic-turn')).toEqual(['SessionStart', 'Stop', 'TurnStarted', 'UserPromptSubmit']);
  });

  it('stamps every agent-scoped record with its agent and correlates the prompt lifecycle', () => {
    const records = wire('basic-turn');
    const engine = records.filter((record) => record.type.startsWith('agent.'));
    expect(engine.every((record) => record.kind === 'event' && record.agentId === undefined)).toBe(true);
    expect(records.filter((record) => !record.type.startsWith('agent.') && record.type !== 'metadata')).toSatisfy(
      (scoped) => scoped.every((record) => record.agentId === 'main'),
    );
    const prompt = records.find((record) => record.type === 'turn.prompt');
    const completed = records.find((record) => record.type === 'prompt.completed');
    expect(prompt).toMatchObject({ turnId: 0, promptId: expect.stringMatching(/^msg_/) });
    expect(completed).toMatchObject({ promptId: prompt.promptId, reason: 'completed' });
    expect(records.find((record) => record.type === 'agent.turn.started')).toMatchObject({
      turnId: 0,
      queueItemId: prompt.promptId,
    });
  });

  it('distinguishes successful and nonzero tool results on wire and hooks', () => {
    const resultFor = (name) => wire(name).find((record) => record.event?.type === 'tool.result').event;
    const callFor = (name) => wire(name).find((record) => record.event?.type === 'tool.call').event;

    const successCall = callFor('tool-success');
    const successResult = resultFor('tool-success');
    expect(successCall.name).toBe('Bash');
    expect(successResult.toolCallId).toBe(successCall.toolCallId);
    expect(successResult.result.isError).toBeUndefined();
    // PostToolUse is fire-and-forget; this print-mode run exited before it was collected.
    expect(hookNames('tool-success')).toContain('PreToolUse');
    expect(hookNames('tool-success')).not.toContain('PostToolUseFailure');
    expect(hookNames('background-task')).toContain('PostToolUse');

    const nonzeroCall = callFor('tool-nonzero');
    const nonzeroResult = resultFor('tool-nonzero');
    expect(nonzeroResult.toolCallId).toBe(nonzeroCall.toolCallId);
    expect(nonzeroResult.result.isError).toBe(true);
    expect(hookNames('tool-nonzero')).toContain('PostToolUseFailure');
    expect(hookNames('tool-nonzero')).not.toContain('PostToolUse');
  });

  it('keeps session joins consistent across state, index, and hooks', () => {
    for (const name of expectedScenarios) {
      const state = json(join(scenario(name), 'state.json'));
      const index = jsonl(join(scenario(name), 'session-index.jsonl'))[0];
      const sessionStarts = jsonl(join(scenario(name), 'hooks', 'SessionStart.jsonl'));
      expect(index.sessionId).toBe(state.id);
      expect(sessionStarts.every((payload) => payload.session_id === state.id)).toBe(true);
    }
  });

  it('records a UserPromptSubmit hook block before any turn starts, then a blocked prompt outcome', () => {
    const records = wire('hook-block-prompt');
    expect(records.some((record) => record.type === 'turn.prompt')).toBe(false);
    expect(records.some((record) => record.type === 'turn.ended')).toBe(false);
    expect(records.map((record) => record.message?.origin).filter(Boolean)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'hook_result', event: 'UserPromptSubmit', blocked: true }),
        expect.objectContaining({ kind: 'user' }),
      ]),
    );
    const user = records.find((record) => record.message?.origin?.kind === 'user');
    expect(records.at(-1)).toMatchObject({ type: 'prompt.completed', reason: 'blocked', promptId: user.message.id });
    expect(hookNames('hook-block-prompt')).toEqual(['SessionStart', 'UserPromptSubmit']);
    expect(json(join(scenario('hook-block-prompt'), 'process.json')).code).toBe(1);
  });

  it('records PreToolUse deny as a failed tool result, not a permission dialog', () => {
    const result = wire('hook-deny-tool').find((record) => record.event?.type === 'tool.result').event;
    expect(result.result.isError).toBe(true);
    expect(hookNames('hook-deny-tool')).toEqual(expect.arrayContaining(['PreToolUse', 'PostToolUseFailure', 'Stop']));
    expect(hookNames('hook-deny-tool')).not.toContain('PermissionRequest');
  });

  it('persists a retried 429 and a retried malformed stream as failed step plus turn.step.retrying', () => {
    for (const [name, errorName] of [
      ['provider-retry', 'APIProviderRateLimitError'],
      ['malformed-stream', 'ChatProviderError'],
    ]) {
      const records = wire(name);
      const steps = records.filter((record) => record.event?.type === 'step.end').map((record) => record.event);
      const retrying = records.find((record) => record.type === 'turn.step.retrying');
      expect(records.filter((record) => record.type === 'llm.request')).toHaveLength(2);
      expect(steps.map((step) => step.finishReason)).toEqual(['error', 'end_turn']);
      expect(retrying).toMatchObject({ turnId: 0, step: 1, stepId: steps[0].uuid, failedAttempt: 1, errorName });
      expect(records.find((record) => record.type === 'turn.ended')).toMatchObject({ reason: 'completed' });
      expect(jsonl(join(scenario(name), 'provider-requests.jsonl'))).toHaveLength(2);
    }
  });

  it('persists print-mode SIGINT as a cancelled turn with an Interrupt hook', () => {
    const process = json(join(scenario('interrupt-stream'), 'process.json'));
    const records = wire('interrupt-stream');
    const types = records.map((record) => record.type);
    expect(process).toMatchObject({ code: 130, mode: 'native-print-hermetic' });
    expect(records.find((record) => record.type === 'turn.cancel')).toMatchObject({
      turnId: 0,
      target: 'active',
      reason: 'user_cancelled',
    });
    expect(records.find((record) => record.event?.type === 'step.end').event.finishReason).toBe('interrupted');
    expect(records.find((record) => record.type === 'turn.ended')).toMatchObject({ reason: 'cancelled' });
    expect(types.indexOf('turn.cancel')).toBeLessThan(types.indexOf('turn.ended'));
    expect(types.indexOf('turn.ended')).toBeLessThan(types.indexOf('prompt.aborted'));
    expect(hookNames('interrupt-stream')).toContain('Interrupt');
    expect(hookNames('interrupt-stream')).not.toContain('Stop');
  });

  it('captures a foreground subagent journal plus SubagentStart/Stop hooks', () => {
    const main = wire('subagent-turn');
    const child = jsonl(join(scenario('subagent-turn'), 'agents', 'agent-0.jsonl'));
    expect(main.find((record) => record.event?.type === 'tool.call').event.name).toBe('Agent');
    expect(child[0]).toMatchObject({ type: 'metadata', protocol_version: '1.5' });
    expect(child.filter((record) => record.type === 'turn.ended').length).toBeGreaterThanOrEqual(1);
    expect(jsonl(join(scenario('subagent-turn'), 'hooks', 'SubagentStart.jsonl'))[0]).toMatchObject({
      hook_event_name: 'SubagentStart',
      agent_name: 'coder',
    });
    expect(jsonl(join(scenario('subagent-turn'), 'hooks', 'SubagentStop.jsonl'))[0]).toMatchObject({
      hook_event_name: 'SubagentStop',
      agent_name: 'coder',
    });
    expect(json(join(scenario('subagent-turn'), 'state.json')).agents).toEqual(
      expect.objectContaining({ main: expect.any(Object), 'agent-0': expect.any(Object) }),
    );
    expect(json(join(scenario('subagent-turn'), 'capture.json')).agentJournals).toEqual(['agent-0']);
    const spawned = main.find((record) => record.type === 'subagent.spawned');
    expect(spawned).toMatchObject({
      subagentId: 'agent-0',
      subagentName: 'coder',
      parentAgentId: 'main',
      runInBackground: false,
      parentToolCallId: main.find((record) => record.event?.type === 'tool.call').event.toolCallId,
    });
    expect(main.filter((record) => record.type.startsWith('subagent.')).map((record) => record.type)).toEqual([
      'subagent.spawned',
      'subagent.started',
      'subagent.completed',
    ]);
    expect(
      child.every(
        (record) => record.type === 'metadata' || record.type.startsWith('agent.') || record.agentId === 'agent-0',
      ),
    ).toBe(true);
  });

  it('passes both the Kimi-specific and shared privacy detectors', () => {
    expect(checkCaptureDirectory(capturesRoot, kimiRules)).toEqual([]);
    expect(checkCaptureDirectory(capturesRoot, kimiRepositoryGateRules)).toEqual([]);
  });
});

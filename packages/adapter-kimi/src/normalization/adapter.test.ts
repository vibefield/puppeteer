import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { KimiWireNormalizer } from './pipeline.js';

function capture(name: string): unknown[] {
  const path = new URL(`../../../surface/vendors/kimi/captures/kimi@0.34.0/${name}/wire.jsonl`, import.meta.url);
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as unknown);
}

function normalize(records: unknown[]) {
  const normalizer = new KimiWireNormalizer();
  return records.flatMap((entry) => normalizer.normalize(entry).events);
}

describe('KimiWireNormalizer', () => {
  it('maps the captured basic turn without exposing hidden reasoning text', () => {
    const events = normalize(capture('basic-turn'));

    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        'environment:updated',
        'model:updated',
        'effort:updated',
        'turn:started',
        'reasoning:started',
        'conversation:assistant-message',
        'reasoning:completed',
        'turn:completed',
      ]),
    );
    expect(events.find((event) => event.type === 'turn:started')).toMatchObject({ turnId: '0' });
    expect(events.at(-1)).toMatchObject({
      type: 'turn:completed',
      turnId: '0',
      stopReason: 'completed',
      lastAssistantMessage: '<redacted:text>',
    });
    const portable = JSON.stringify(events);
    expect(portable).not.toContain('<redacted:think>');
    expect(events.filter((event) => event.type === 'conversation:assistant-message').at(-1)).toMatchObject({
      text: '<redacted:text>',
      final: true,
    });
    expect(events.filter((event) => event.type === 'model:updated')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          intent: 'configured',
          model: expect.objectContaining({ id: '__kimi_env_model__' }),
        }),
        expect.objectContaining({
          intent: 'observed',
          model: expect.objectContaining({ id: 'puppeteer-kimi-census' }),
        }),
      ]),
    );
  });

  it('keeps configured profile intent separate from the applied request model and effort', () => {
    const normalizer = new KimiWireNormalizer();

    expect(
      normalizer.normalize({
        type: 'profile.bind',
        modelAlias: 'kimi-code/k3',
        thinkingEffort: 'high',
        environmentDisclosure: { cwd: '/repo' },
        time: 1,
      }).events,
    ).toEqual([
      {
        type: 'environment:updated',
        currentCwd: '/repo',
      },
      { type: 'model:updated', intent: 'configured', model: { id: 'kimi-code/k3', provider: 'moonshot-ai' } },
      { type: 'effort:updated', intent: 'configured', effort: 'high' },
    ]);
    expect(
      normalizer.normalize({
        type: 'llm.request',
        provider: 'openai',
        model: 'k3',
        modelAlias: 'kimi-code/k3',
        thinkingEffort: 'high',
        maxTokens: 1_048_576,
        time: 2,
      }).events,
    ).toEqual([
      { type: 'model:updated', intent: 'observed', model: { id: 'k3', provider: 'moonshot-ai' } },
      { type: 'effort:updated', intent: 'observed', effort: 'high' },
    ]);
  });

  it('maps captured tool success and failure with stable terminal tombstones', () => {
    const success = normalize(capture('tool-success'));
    expect(success.find((event) => event.type === 'tool:requested')).toMatchObject({
      tool: 'Bash',
      presentation: { kind: 'command' },
    });
    expect(success.find((event) => event.type === 'tool:completed')).toMatchObject({
      tool: 'Bash',
      output: '<redacted:output>',
    });

    const failure = normalize(capture('tool-nonzero'));
    expect(failure.find((event) => event.type === 'tool:failed')).toMatchObject({
      tool: 'Bash',
      error: '<redacted:output>',
    });

    const reordered = new KimiWireNormalizer();
    const result = {
      type: 'context.append_loop_event',
      event: { type: 'tool.result', toolCallId: 'call-1', result: { output: 'early' } },
      time: 1,
    };
    expect(reordered.normalize(result).events).toEqual([
      { type: 'tool:completed', toolCallId: 'call-1', output: 'early' },
    ]);
    expect(
      reordered.normalize({
        type: 'context.append_loop_event',
        event: { type: 'tool.call', toolCallId: 'call-1', name: 'Bash', args: { command: 'echo late' } },
      }).events,
    ).toEqual([]);
    expect(reordered.normalize(result).events).toEqual([]);
  });

  it('buffers the id-less prompt, correlates on step.begin, and treats late content as native-only', () => {
    const normalizer = new KimiWireNormalizer();
    const prompt = normalizer.normalize({
      type: 'turn.prompt',
      input: [{ type: 'text', text: 'hello' }],
      origin: { kind: 'user' },
      time: 1,
    });
    expect(prompt).toMatchObject({ events: [], disposition: 'buffered' });

    const started = normalizer.normalize({
      type: 'context.append_loop_event',
      event: { type: 'step.begin', turnId: '7', step: 1, uuid: 'step' },
      time: 2,
    });
    expect(started.events).toEqual([{ type: 'turn:started', turnId: '7', prompt: 'hello' }]);

    normalizer.normalize({ type: 'turn.ended', turnId: 7, reason: 'cancelled', time: 3 });
    const late = normalizer.normalize({
      type: 'context.append_loop_event',
      event: {
        type: 'content.part',
        turnId: '7',
        step: 1,
        stepUuid: 'step',
        uuid: 'late',
        part: { type: 'text', text: 'must not surface' },
      },
      time: 4,
    });
    expect(late).toMatchObject({ disposition: 'retained-native' });
    expect(late.events).toEqual([
      { type: 'adapter:native-event', adapter: 'kimi', nativeType: 'late:context.append_loop_event:content.part' },
    ]);

    const toolNormalizer = new KimiWireNormalizer();
    toolNormalizer.normalize({
      type: 'turn.prompt',
      input: [{ type: 'text', text: 'run it' }],
      origin: { kind: 'user' },
    });
    toolNormalizer.normalize({
      type: 'context.append_loop_event',
      event: { type: 'step.begin', turnId: '8', step: 1, uuid: 'step-8' },
    });
    toolNormalizer.normalize({
      type: 'context.append_loop_event',
      event: {
        type: 'tool.call',
        turnId: '8',
        toolCallId: 'call-late',
        name: 'Bash',
        args: { command: 'sleep 1' },
      },
    });
    toolNormalizer.normalize({ type: 'turn.ended', turnId: 8, reason: 'cancelled' });
    const lateTool = toolNormalizer.normalize({
      type: 'context.append_loop_event',
      event: { type: 'tool.result', toolCallId: 'call-late', result: { output: 'too late' } },
    });
    expect(lateTool).toMatchObject({ disposition: 'retained-native', turnId: '8' });
    expect(lateTool.events).toEqual([
      { type: 'adapter:native-event', adapter: 'kimi', nativeType: 'late:context.append_loop_event:tool.result' },
    ]);
  });

  it('maps approval, compaction, and subagent lifecycles conservatively', () => {
    const normalizer = new KimiWireNormalizer();
    expect(
      normalizer.normalize({
        type: 'interaction.request',
        id: 'i1',
        kind: 'approval',
        toolCallId: 'call-1',
        request: { tool: 'Bash', input: { command: 'pwd' } },
      }).events,
    ).toEqual([
      {
        type: 'interaction:permission-requested',
        requestId: 'i1',
        toolCallId: 'call-1',
        tool: 'Bash',
        input: { command: 'pwd' },
        presentation: 'native-tui',
      },
    ]);
    expect(
      normalizer.normalize({ type: 'interaction.resolved', id: 'i1', response: { decision: 'approved' } }).events,
    ).toEqual([{ type: 'interaction:permission-resolved', requestId: 'i1', outcome: 'allowed' }]);
    expect(normalizer.normalize({ type: 'full_compaction.complete' }).events).toEqual([
      { type: 'context-window:invalidated', reason: 'compacted' },
    ]);

    const info = {
      taskId: 'task-1',
      description: 'delegate',
      kind: 'agent',
      agentId: 'agent-1',
      subagentType: 'Explore',
    };
    expect(normalizer.normalize({ type: 'task.started', info }).events).toEqual([
      { type: 'delegation:subagent-started', subagentId: 'agent-1', agentType: 'Explore' },
    ]);
    expect(normalizer.normalize({ type: 'task.terminated', info: { ...info, status: 'completed' } }).events).toEqual([
      { type: 'delegation:subagent-stopped', subagentId: 'agent-1' },
    ]);
  });

  it.each(['task.started', 'task.terminated', 'plan.revision'])('retains %s without task tracking', (type) => {
    const normalizer = new KimiWireNormalizer();
    const record = { type, id: 'plan-1', info: { taskId: 'task-1', kind: 'process', status: 'running' } };
    expect(normalizer.normalize(record)).toMatchObject({
      disposition: 'retained-native',
      nativeEvent: record,
      events: [{ type: 'adapter:native-event', adapter: 'kimi', nativeType: type }],
    });
  });

  it('retains unknown records and isolates non-main journals', () => {
    const normalizer = new KimiWireNormalizer();
    expect(normalizer.normalize({ type: 'future.record', future: true })).toMatchObject({
      disposition: 'retained-native',
      events: [{ type: 'adapter:native-event', adapter: 'kimi', nativeType: 'future.record' }],
    });
    expect(
      normalizer.normalize({ type: 'turn.ended', turnId: 0, reason: 'completed' }, { agentId: 'agent-child' }),
    ).toMatchObject({
      disposition: 'retained-native',
      events: [{ type: 'adapter:native-event', adapter: 'kimi', nativeType: 'turn.ended' }],
    });
  });
});

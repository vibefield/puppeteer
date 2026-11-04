import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PiSessionNormalizer } from './pipeline.js';

/** The sanitized Pi 1.5.0 session journals (Surface evidence), one native entry per line. */
const capturesRoot = fileURLToPath(new URL('../../../surface/vendors/pi/captures/pi@1.5.0/', import.meta.url));
function journals(): { name: string; records: Record<string, unknown>[] }[] {
  return readdirSync(capturesRoot, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.jsonl'))
    .sort()
    .map((name) => ({
      name,
      records: readFileSync(`${capturesRoot}${name}`, 'utf8')
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    }));
}

/** A 1.5.0 SystemMessage as Pi persists it after thinking_level_change and on compaction.systemMessage. */
const systemMessage = {
  role: 'system',
  content: '',
  sections: { preamble: 'prompt', tools: '<tools>', cwd: '/work' },
  timestamp: 1,
  toolsAdded: [{ name: 'read', description: 'Read a file', parameters: { type: 'object' } }],
};

describe('Pi session normalization', () => {
  it('maps transcript conversation and workspace edits without emitting usage', () => {
    const normalizer = new PiSessionNormalizer();
    expect(
      normalizer
        .normalize({ type: 'session', id: 's', timestamp: '2026-08-25T00:00:00Z', cwd: '/work' })
        .events.map((event) => event.type),
    ).toEqual(['session:started', 'environment:updated']);
    expect(
      normalizer.normalize({
        type: 'message',
        id: 'u',
        timestamp: '2026-08-25T00:00:01Z',
        message: { role: 'user', content: [{ type: 'text', text: 'edit it' }] },
      }).events,
    ).toContainEqual({ type: 'turn:started', turnId: 'u', prompt: 'edit it' });
    const request = normalizer.normalize({
      type: 'message',
      id: 'a1',
      timestamp: '2026-08-25T00:00:02Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'invalid-without-name', arguments: { path: 'wrong.ts' } },
          { type: 'toolCall', id: 'call-1', name: 'edit', arguments: { path: 'a.ts', oldText: 'a', newText: 'b' } },
        ],
        stopReason: 'toolUse',
        usage: { input: 4, output: 2, totalTokens: 6 },
      },
    });
    expect(request.events.map((event) => event.type)).toEqual(['tool:requested', 'workspace:file-operation']);
    const result = normalizer.normalize({
      type: 'message',
      id: 'r',
      timestamp: '2026-08-25T00:00:03Z',
      message: {
        role: 'toolResult',
        toolCallId: 'call-1',
        toolName: 'edit',
        content: [{ type: 'text', text: 'ok' }],
        isError: false,
      },
    });
    expect(result.events.map((event) => event.type)).toEqual(['tool:completed', 'workspace:file-operation']);
    const done = normalizer.normalize({
      type: 'message',
      id: 'a2',
      timestamp: '2026-08-25T00:00:04Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], stopReason: 'stop' },
    });
    expect(done.events.map((event) => event.type)).toEqual(['conversation:assistant-message', 'turn:completed']);
  });

  it('does not present the `{}` of a 1.5.0 malformed tool call as its input', () => {
    const normalizer = new PiSessionNormalizer();
    normalizer.normalize({
      type: 'message',
      id: 'u',
      message: { role: 'user', content: [{ type: 'text', text: 'write it' }] },
    });
    const request = normalizer.normalize({
      type: 'message',
      id: 'a1',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'toolCall',
            id: 'call-bad',
            name: 'write',
            arguments: {},
            argumentsError: 'Expected a JSON object: {"path":"secret.ts","content":"raw model text',
          },
        ],
        stopReason: 'toolUse',
      },
    });
    expect(request.events).toEqual([
      {
        type: 'tool:requested',
        toolCallId: 'call-bad',
        tool: 'write',
        presentation: { kind: 'file-edit', title: 'Using write' },
      },
    ]);
    expect(JSON.stringify(request.events)).not.toContain('raw model text');
    const result = normalizer.normalize({
      type: 'message',
      id: 'r',
      message: {
        role: 'toolResult',
        toolCallId: 'call-bad',
        toolName: 'write',
        content: [{ type: 'text', text: 'Invalid arguments for tool "write"' }],
        isError: true,
      },
    });
    expect(result.events.map((event) => event.type)).toEqual(['tool:failed']);
  });

  it('maps compaction as a completed durable boundary', () => {
    const events = new PiSessionNormalizer().normalize({
      type: 'compaction',
      id: 'c',
      timestamp: '2026-08-25T00:00:00Z',
      usage: {
        input: 10,
        output: 5,
        cacheRead: 2,
        cacheWrite: 1,
        totalTokens: 18,
        cost: { total: 0.01 },
      },
    }).events;
    expect(events.map((event) => event.type)).toEqual(['context-window:invalidated', 'compaction:completed']);
    expect(events.some((event) => event.type === 'usage:tokens-used')).toBe(false);
  });

  it('retains the 1.5.0 system-prompt message as native scaffolding that opens no turn', () => {
    const normalizer = new PiSessionNormalizer();
    normalizer.normalize({ type: 'session', version: 3, id: 's', timestamp: '2026-11-03T00:00:00Z', cwd: '/work' });
    normalizer.normalize({ type: 'model_change', id: 'm', parentId: null, provider: 'mock', modelId: 'mock-1' });
    normalizer.normalize({ type: 'thinking_level_change', id: 't', parentId: 'm', thinkingLevel: 'off' });
    const system = normalizer.normalize({ type: 'message', id: 'sys', parentId: 't', message: systemMessage });
    expect(system.disposition).toBe('retained-native');
    expect(system.events).toEqual([{ type: 'adapter:native-event', adapter: 'pi', nativeType: 'message:system' }]);
    expect(system.turnId).toBeUndefined();
    const user = normalizer.normalize({
      type: 'message',
      id: 'u',
      parentId: 'sys',
      message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    });
    expect(user.turnId).toBe('u');
    expect(user.events).toContainEqual({ type: 'turn:started', turnId: 'u', prompt: 'hi' });
  });

  it('retains the 1.5.0 writer-only usage and context_edit entries as native events', () => {
    const normalizer = new PiSessionNormalizer();
    for (const entry of [
      {
        type: 'usage',
        id: 'x',
        parentId: null,
        kind: 'cache-warm',
        provider: 'mock',
        model: 'mock-1',
        usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 1, totalTokens: 2 },
      },
      { type: 'context_edit', id: 'y', parentId: 'x' },
    ]) {
      const result = normalizer.normalize(entry);
      expect(result.disposition).toBe('retained-native');
      expect(result.events).toEqual([{ type: 'adapter:native-event', adapter: 'pi', nativeType: entry.type }]);
      expect(result.turnId).toBeUndefined();
    }
  });

  it('maps a 1.5.0 compaction carrying systemMessage, usage and fromHook to the same durable boundary', () => {
    const events = new PiSessionNormalizer().normalize({
      type: 'compaction',
      id: 'c',
      parentId: 'a',
      summary: 'summary',
      firstKeptEntryId: 'u',
      tokensBefore: 100,
      fromHook: false,
      systemMessage,
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
    }).events;
    expect(events.map((event) => event.type)).toEqual(['context-window:invalidated', 'compaction:completed']);
  });

  it('replays every 1.5.0 capture without opening a turn before the first user message', () => {
    const captured = journals();
    expect(captured.length).toBeGreaterThan(0);
    let systemMessages = 0;
    for (const { name, records } of captured) {
      const normalizer = new PiSessionNormalizer();
      let userSeen = false;
      for (const record of records) {
        const message = record.message as { role?: string } | undefined;
        const result = normalizer.normalize(record);
        if (message?.role === 'user') userSeen = true;
        if (message?.role === 'system') {
          systemMessages += 1;
          expect(result.disposition, name).toBe('retained-native');
          expect(result.events, name).toEqual([
            { type: 'adapter:native-event', adapter: 'pi', nativeType: 'message:system' },
          ]);
        }
        if (!userSeen) {
          expect(result.turnId, `${name}: ${String(record.type)}`).toBeUndefined();
          expect(
            result.events.some((event) => event.type.startsWith('turn:')),
            name,
          ).toBe(false);
        }
      }
    }
    expect(systemMessages).toBeGreaterThan(0);
  });
});

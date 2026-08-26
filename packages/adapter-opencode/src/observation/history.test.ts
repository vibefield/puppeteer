import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { OpenCodeMessage, OpenCodeSessionInfo } from '../transport/client.js';
import type { OpenCodeSseRecord } from '../transport/event-stream.js';
import { projectOpenCodeChild, projectOpenCodeHistory, projectOpenCodeStatus } from './history.js';
import { OpenCodeNormalizer } from '../normalization/pipeline.js';

const root = new URL('../../../surface/vendors/opencode/captures/opencode@1.18.16/turn/', import.meta.url);

function lines<T>(name: string): T[] {
  return readFileSync(fileURLToPath(new URL(name, root)), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as T);
}

describe('OpenCode durable history projection', () => {
  it('restores the same turn identity and final assistant text with replay provenance', () => {
    const records = lines<OpenCodeSseRecord>('events.jsonl');
    const created = records.find((record) => record.type === 'session.created')!;
    const info = created.properties.info as OpenCodeSessionInfo;
    const messages = lines<OpenCodeMessage>('messages.jsonl');
    const normalizer = new OpenCodeNormalizer({ sessionID: info.id });
    const events = normalizer.normalizeSession(info, {
      replay: true,
      nativeEvent: { type: 'http/session.get', body: info },
    });
    for (const projection of projectOpenCodeHistory(messages)) {
      events.push(...normalizer.normalize(projection.record, { replay: true, nativeEvent: projection.nativeEvent }));
    }
    const status = projectOpenCodeStatus(info.id, undefined);
    events.push(...normalizer.normalize(status.record, { replay: true, nativeEvent: status.nativeEvent }));

    expect(events.every((entry) => entry.replay === true)).toBe(true);
    expect(events.map((entry) => entry.event)).toContainEqual(
      expect.objectContaining({ type: 'conversation:assistant-message', text: '<redacted:text>', final: true }),
    );
    expect(events.map((entry) => entry.event)).toContainEqual(
      expect.objectContaining({
        type: 'turn:completed',
        lastAssistantMessage: '<redacted:text>',
      }),
    );
    expect(events.find((entry) => entry.event.type === 'turn:started')?.promptId).toBe(messages[0]!.info.id);

    const replayAgain = projectOpenCodeHistory(messages).flatMap((projection) =>
      normalizer.normalize(projection.record, { replay: true, nativeEvent: projection.nativeEvent }),
    );
    expect(replayAgain).toEqual([]);

    // A reconnect can observe a later durable revision of the same native
    // entity. Its synthetic reconciliation id must change with the snapshot.
    const changed = structuredClone(messages);
    const assistantText = changed[1]!.parts.find((part) => part.type === 'text')!;
    assistantText.text = '<redacted:text> updated';
    const changedProjection = projectOpenCodeHistory(changed).find(
      (projection) =>
        projection.record.type === 'message.part.updated' && projection.record.properties.part === assistantText,
    )!;
    const originalProjection = projectOpenCodeHistory(messages).find(
      (projection) =>
        projection.record.type === 'message.part.updated' &&
        (projection.record.properties.part as { id?: unknown }).id === assistantText.id,
    )!;
    expect(changedProjection.record.id).not.toBe(originalProjection.record.id);
    expect(
      normalizer.normalize(changedProjection.record, {
        replay: true,
        nativeEvent: changedProjection.nativeEvent,
      }),
    ).toEqual([
      expect.objectContaining({
        event: expect.objectContaining({ type: 'conversation:assistant-message', text: '<redacted:text> updated' }),
      }),
    ]);
  });

  it('projects durable children as the same child-session lifecycle the live SSE path uses', () => {
    const childRoot = new URL(
      '../../../surface/vendors/opencode/captures/opencode@1.18.16/task-child/',
      import.meta.url,
    );
    const parent = JSON.parse(
      readFileSync(fileURLToPath(new URL('events.jsonl', childRoot)), 'utf8')
        .trim()
        .split('\n')
        .find((line) => line.includes('"type":"session.created"'))!,
    ) as OpenCodeSseRecord;
    const parentInfo = parent.properties.info as OpenCodeSessionInfo;
    const child = JSON.parse(
      readFileSync(fileURLToPath(new URL('children.jsonl', childRoot)), 'utf8')
        .trim()
        .split('\n')[0]!,
    ) as OpenCodeSessionInfo;
    const normalizer = new OpenCodeNormalizer({ sessionID: parentInfo.id });
    const events = [
      ...normalizer.normalizeSession(parentInfo, { replay: true, nativeEvent: { type: 'http/session.get' } }),
      ...normalizer.normalize(projectOpenCodeChild(child).record, {
        replay: true,
        nativeEvent: { type: 'http/session.children', body: child },
      }),
      ...normalizer.normalize(projectOpenCodeStatus(child.id, { type: 'idle' }).record, {
        replay: true,
        nativeEvent: { type: 'http/session.status', sessionID: child.id },
      }),
    ];

    expect(events.map((entry) => entry.event)).toEqual([
      expect.objectContaining({ type: 'session:started', nativeSessionId: parentInfo.id }),
      expect.objectContaining({ type: 'environment:updated' }),
      expect.objectContaining({ type: 'model:updated' }),
      { type: 'delegation:subagent-started', subagentId: child.id, agentType: child.agent },
      { type: 'delegation:subagent-stopped', subagentId: child.id },
    ]);
    expect(events.every((entry) => entry.replay === true)).toBe(true);
  });
});

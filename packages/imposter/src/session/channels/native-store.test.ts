import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createNativeSessionStore, resolveNativeSessionDirectory } from './native-store.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const document = {
  sessionPath: ['sessions', '$encodedCwd', '$sessionId'],
  updatesFile: 'updates.jsonl',
};

describe('vendor-native session store', () => {
  it('appends the vendor envelope and replaces state files beside it', () => {
    const root = mkdtempSync(join(tmpdir(), 'puppeteer-native-store-'));
    roots.push(root);
    const bindings: Record<string, unknown> = { $encodedCwd: '%2Fworkspace', $sessionId: 'session-one' };
    const store = createNativeSessionStore(root, document, bindings);

    store.append('session/update', { sessionId: 'session-one', update: { sessionUpdate: 'agent_message_chunk' } });
    store.write('signals.json', { turnCount: 1 });

    const record = JSON.parse(readFileSync(store.updatesPath, 'utf8').trim()) as Record<string, unknown>;
    expect(record).toMatchObject({
      method: 'session/update',
      params: { sessionId: 'session-one', update: { sessionUpdate: 'agent_message_chunk' } },
    });
    expect(typeof record.timestamp).toBe('number');
    expect(record.timestamp).toBeGreaterThan(10_000_000_000);
    expect(JSON.parse(readFileSync(join(store.directory, 'signals.json'), 'utf8'))).toEqual({ turnCount: 1 });
    expect(store.exists()).toBe(true);
    expect(store.readUpdates()).toEqual([
      expect.objectContaining({
        method: 'session/update',
        params: { sessionId: 'session-one', update: { sessionUpdate: 'agent_message_chunk' } },
      }),
    ]);
    expect(store.read('signals.json')).toEqual({ turnCount: 1 });
  });

  it('writes a Unix-seconds clock and a per-session event ordinal that continues after resume', () => {
    const root = mkdtempSync(join(tmpdir(), 'puppeteer-native-store-seconds-'));
    roots.push(root);
    const grok = {
      ...document,
      recordTimestamp: { field: 'timestamp', format: 'epoch-seconds' as const },
      recordEventId: { metaField: 'eventId' },
    };
    const bindings: Record<string, unknown> = { $encodedCwd: '%2Fworkspace', $sessionId: 'session-one' };
    const first = createNativeSessionStore(root, grok, bindings);
    const before = Math.floor(Date.now() / 1_000);
    // Stamping before validation previews the next ordinal without consuming it.
    expect(first.stamp({ sessionId: 'session-one', _meta: { agentTimestampMs: 1 } })).toEqual({
      sessionId: 'session-one',
      _meta: { agentTimestampMs: 1, eventId: 'session-one-1' },
    });
    first.append('session/update', { sessionId: 'session-one', _meta: { agentTimestampMs: 1 } });
    first.append('_x.ai/session/update', { sessionId: 'session-one', _meta: { eventId: 'session-one-7' } });
    first.append('session/update', { sessionId: 'session-one' });
    const resumed = createNativeSessionStore(root, grok, bindings);
    resumed.append('_x.ai/session/update', { sessionId: 'session-one', _meta: { agentTimestampMs: 2 } });

    const records = readFileSync(first.updatesPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { timestamp: number; params: { _meta: { eventId: string } } });
    expect(records.map(({ params }) => params._meta.eventId)).toEqual([
      'session-one-1',
      'session-one-7',
      'session-one-8',
      'session-one-9',
    ]);
    for (const { timestamp } of records) {
      expect(Number.isInteger(timestamp)).toBe(true);
      expect(timestamp).toBeGreaterThanOrEqual(before);
      expect(timestamp).toBeLessThan(10_000_000_000);
    }
  });

  it('rebinds its directory when session/new adopts the authoritative id', () => {
    const root = mkdtempSync(join(tmpdir(), 'puppeteer-native-store-rebind-'));
    roots.push(root);
    const bindings: Record<string, unknown> = { $encodedCwd: '%2Fworkspace', $sessionId: 'provisional' };
    const store = createNativeSessionStore(root, document, bindings);
    bindings.$sessionId = 'authoritative';
    store.append('_x.ai/session/update', {});
    expect(store.directory).toBe(join(root, 'sessions', '%2Fworkspace', 'authoritative'));
  });

  it('re-resolves encoded workspace bindings when session/load changes cwd', () => {
    const root = mkdtempSync(join(tmpdir(), 'puppeteer-native-store-cwd-rebind-'));
    roots.push(root);
    const bindings: Record<string, unknown> = { $threadCwd: '/first/workspace', $sessionId: 'session-one' };
    const store = createNativeSessionStore(
      root,
      { ...document, sessionPath: ['sessions', '$encodeURIComponent:$threadCwd', '$sessionId'] },
      bindings,
    );
    expect(store.directory).toBe(join(root, 'sessions', encodeURIComponent('/first/workspace'), 'session-one'));
    bindings.$threadCwd = '/loaded/workspace';
    expect(store.directory).toBe(join(root, 'sessions', encodeURIComponent('/loaded/workspace'), 'session-one'));
  });

  it('reports an unmaterialized session without creating it', () => {
    const root = mkdtempSync(join(tmpdir(), 'puppeteer-native-store-missing-'));
    roots.push(root);
    const store = createNativeSessionStore(root, document, {
      $encodedCwd: '%2Fworkspace',
      $sessionId: 'missing',
    });
    expect(store.exists()).toBe(false);
    expect(store.readUpdates()).toEqual([]);
    expect(store.read('signals.json')).toBeUndefined();
    expect(store.exists()).toBe(false);
  });

  it('refuses a carrier before writing when the Surface contract rejects it', () => {
    const root = mkdtempSync(join(tmpdir(), 'puppeteer-native-store-invalid-'));
    roots.push(root);
    const store = createNativeSessionStore(
      root,
      document,
      { $encodedCwd: '%2Fworkspace', $sessionId: 'session-one' },
      { validateRecord: () => ['timestamp is outside the captured unit'] },
    );
    expect(() => store.append('session/update', {})).toThrow(/outside the captured unit/);
    expect(store.exists()).toBe(false);
  });

  it('refuses path traversal supplied through a binding', () => {
    expect(() =>
      resolveNativeSessionDirectory('/tmp/isolated', document, {
        $encodedCwd: '..',
        $sessionId: 'session-one',
      }),
    ).toThrow(/unsafe path component/);
  });

  it('writes Kimi-style flat records to a nested agent journal with one metadata header', () => {
    const root = mkdtempSync(join(tmpdir(), 'puppeteer-native-store-flat-'));
    roots.push(root);
    const flatDocument = {
      sessionPath: ['sessions', '$workdirKey', '$sessionId'],
      updatesPath: ['agents', 'main', 'wire.jsonl'],
      indexPath: ['session_index.jsonl'],
      recordFormat: 'flat-record' as const,
      recordTimestamp: { field: 'time', format: 'epoch-ms' as const, omitFor: ['metadata'] },
      singletonEvents: ['metadata'],
    };
    const store = createNativeSessionStore(
      root,
      flatDocument,
      { $workdirKey: 'wd_repo_deadbeef0000', $sessionId: 'session-one' },
      { validateRecord: (_method, record) => (typeof record.type === 'string' ? [] : ['missing type']) },
    );

    store.append('metadata', { protocol_version: '1.5', created_at: 1000 });
    store.append('metadata', { protocol_version: '1.5', created_at: 2000 });
    store.append('turn.prompt', { input: [], origin: { kind: 'user' } });

    expect(store.updatesPath).toBe(join(store.directory, 'agents', 'main', 'wire.jsonl'));
    const records = readFileSync(store.updatesPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records).toHaveLength(2);
    expect(records[0]).toEqual({ type: 'metadata', protocol_version: '1.5', created_at: 1000 });
    expect(records[1]).toMatchObject({ type: 'turn.prompt', input: [], origin: { kind: 'user' } });
    expect(typeof records[1]!.time).toBe('number');
    expect(store.readUpdates().map((record) => record.method)).toEqual(['metadata', 'turn.prompt']);

    const indexEntry = { sessionId: 'session-one', sessionDir: store.directory, workDir: '/repo' };
    store.appendIndex(indexEntry);
    store.appendIndex(indexEntry);
    expect(store.indexPath).toBe(join(root, 'session_index.jsonl'));
    expect(
      readFileSync(store.indexPath!, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    ).toEqual([indexEntry]);
  });

  it('builds declarative ISO, sequence, and identity envelopes for native journals', () => {
    const root = mkdtempSync(join(tmpdir(), 'puppeteer-native-store-envelope-'));
    roots.push(root);
    const store = createNativeSessionStore(
      root,
      {
        sessionPath: ['sessions'],
        updatesFile: '$concat:$sessionId:.jsonl',
        recordFormat: 'flat-record',
        recordTimestamp: { field: 'timestamp', format: 'iso' },
        recordSequence: { field: 'step_index', start: 4 },
        recordIdentity: { idField: 'id', parentField: 'parentId', omitParentFor: ['session.start'] },
      },
      { $sessionId: 'session-one' },
    );
    store.append('session.start', { id: 'session-one' });
    store.append('user.message', { data: { content: 'hello' } });
    const records = readFileSync(store.updatesPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(store.updatesPath).toBe(join(root, 'sessions', 'session-one.jsonl'));
    expect(records[0]).toMatchObject({ type: 'session.start', id: 'session-one', step_index: 4 });
    expect(records[0]).not.toHaveProperty('parentId');
    expect(records[1]).toMatchObject({ type: 'user.message', parentId: 'session-one', step_index: 5 });
    expect(records[1].id).toMatch(/^[0-9a-f-]{36}$/);
    expect(records[1].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('wraps payloads and resumes singleton, sequence, and identity state from disk', () => {
    const root = mkdtempSync(join(tmpdir(), 'puppeteer-native-store-resume-'));
    roots.push(root);
    const wrappedDocument = {
      sessionPath: ['session-state', '$sessionId'],
      updatesFile: 'events.jsonl',
      recordFormat: 'flat-record' as const,
      recordPayloadField: 'data',
      recordTimestamp: { field: 'timestamp', format: 'iso' as const },
      recordSequence: { field: 'ordinal', start: 0 },
      recordIdentity: { idField: 'id', parentField: 'parentId' },
      singletonEvents: ['session.start'],
    };
    const bindings = { $sessionId: 'session-one' };
    const first = createNativeSessionStore(root, wrappedDocument, bindings);
    first.append('session.start', { sessionId: 'session-one' });
    first.append('user.message', { content: 'first' });

    const initial = readFileSync(first.updatesPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const priorId = initial[1].id as string;
    expect(initial[0]).toMatchObject({ type: 'session.start', data: { sessionId: 'session-one' }, ordinal: 0 });
    expect(initial[1]).toMatchObject({ type: 'user.message', data: { content: 'first' }, ordinal: 1 });

    const resumed = createNativeSessionStore(root, wrappedDocument, bindings);
    resumed.append('session.start', { sessionId: 'session-one' });
    resumed.append('assistant.message', { content: 'continued' });

    const records = readFileSync(resumed.updatesPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(records).toHaveLength(3);
    expect(records[2]).toMatchObject({
      type: 'assistant.message',
      data: { content: 'continued' },
      ordinal: 2,
      parentId: priorId,
    });
    expect(resumed.readUpdates()[2]).toMatchObject({
      method: 'assistant.message',
      params: { content: 'continued' },
    });
  });
});

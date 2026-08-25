import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { REDACTED_EPOCH_MS, checkCaptureDirectory, defaultRules } from '@vibecook/chopsticks-surface/sanitize';
import { opencodeRules } from './privacy.mjs';

const vendorRoot = dirname(fileURLToPath(import.meta.url));
const capturesRoot = join(vendorRoot, 'captures', 'opencode@1.18.16');
const scenarios = [
  'turn',
  'session-lifecycle',
  'file-part',
  'file-write',
  'file-edit',
  'file-delete',
  'task-child',
  'subtask-part',
  'agent-part',
  'background-task',
  'detach-task',
  'permission-accept',
  'permission-reject',
  'attach-permission-always',
  'question-reply',
  'question-reject',
  'abort-stream',
  'abort-tool',
  'provider-retry',
  'provider-error',
  'reconnect-rehydrate',
  'exact-resume',
  'attach-exact-resume',
  'manual-compaction',
  'auto-compaction',
  'overflow-compaction',
  'unknown-context',
];

function records(scenario: string, file = 'events.jsonl'): Array<Record<string, any>> {
  return readFileSync(join(capturesRoot, scenario, file), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function events(scenario: string, type?: string): Array<Record<string, any>> {
  const all = records(scenario);
  return type ? all.filter((event) => event.type === type) : all;
}

function partStatuses(scenario: string, tool: string): string[] {
  return events(scenario, 'message.part.updated')
    .map((event) => event.properties?.part)
    .filter((part) => part?.type === 'tool' && part?.tool === tool)
    .map((part) => part.state?.status)
    .filter(Boolean);
}

describe('OpenCode 1.18.16 census fixtures', () => {
  it('preserves the native event envelope and unique vendor event IDs', () => {
    for (const scenario of scenarios) {
      const captured = events(scenario);
      expect(captured.length).toBeGreaterThan(0);
      const ids = captured.map((event) => event.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const event of captured) {
        expect(event.id).toMatch(/^evt_a11a5ed0/);
        expect(typeof event.type).toBe('string');
        expect(event.properties).toBeTypeOf('object');
      }
    }
  });

  it('captures the baseline turn from correlated user echo through durable idle', () => {
    const captured = events('turn');
    const types = captured.map((event) => event.type);
    expect(types.indexOf('session.created')).toBeLessThan(types.indexOf('message.updated'));
    expect(types).toContain('message.part.delta');
    expect(captured.some((event) => event.type === 'session.status' && event.properties?.status?.type === 'busy')).toBe(
      true,
    );
    expect(captured.some((event) => event.type === 'session.status' && event.properties?.status?.type === 'idle')).toBe(
      true,
    );
    expect(types.at(-1)).not.toBe('session.error');

    const user = events('turn', 'message.updated').find((event) => event.properties?.info?.role === 'user');
    const prompt = records('turn', 'http-roundtrip.jsonl').find(
      (record) => record.request?.route === '/session/:sessionID/prompt_async',
    );
    expect(user?.properties?.info?.id).toBe(prompt?.request?.body?.messageID);
  });

  it('captures prompt file inputs as durable file parts with their synthetic text expansion', () => {
    const durable = records('file-part', 'messages.jsonl');
    const user = durable.find((message) => message.info?.role === 'user');
    expect(user?.parts).toEqual([
      expect.objectContaining({ type: 'text' }),
      expect.objectContaining({ type: 'text', synthetic: true }),
      expect.objectContaining({ type: 'text', synthetic: true }),
      expect.objectContaining({ type: 'file', mime: 'text/plain' }),
    ]);
    expect(user?.parts[0]).not.toHaveProperty('synthetic');

    const liveFileParts = events('file-part', 'message.part.updated')
      .map((event) => event.properties?.part)
      .filter((part) => part?.type === 'file');
    expect(liveFileParts).toEqual([expect.objectContaining({ type: 'file', mime: 'text/plain' })]);
    expect(records('file-part', 'provider-requests.jsonl')).toHaveLength(1);
  });

  it('captures message-scoped/full forks, the two session-list archive views, and permanent deletion', () => {
    const roundTrips = records('session-lifecycle', 'http-roundtrip.jsonl');
    const created = roundTrips.find((record) => record.response?.route === '/session')?.response?.body;
    const parentID = created?.id;
    expect(parentID).toMatch(/^ses_a11a5ed0/);

    const forkRequests = roundTrips
      .filter((record) => record.request?.route === '/session/:sessionID/fork')
      .map((record) => record.request);
    const forkResults = roundTrips
      .filter((record) => record.response?.route === '/session/:sessionID/fork')
      .map((record) => record.response);
    expect(forkRequests).toHaveLength(2);
    expect(forkResults).toHaveLength(2);
    expect(forkRequests[0]).toMatchObject({ params: { sessionID: parentID }, body: { messageID: expect.any(String) } });
    expect(forkRequests[1]).toMatchObject({ params: { sessionID: parentID } });
    expect(forkRequests[1]).not.toHaveProperty('body');

    const partialID = forkResults[0]?.body?.id;
    const fullID = forkResults[1]?.body?.id;
    expect(new Set([parentID, partialID, fullID]).size).toBe(3);
    expect(forkResults.map((result) => result.body?.parentID)).toEqual([undefined, undefined]);

    const messageResults = roundTrips
      .filter((record) => record.response?.route === '/session/:sessionID/message')
      .map((record) => record.response);
    const originalMessages = messageResults.find((result) => result.params?.sessionID === parentID)?.body;
    const partialMessages = messageResults.find((result) => result.params?.sessionID === partialID)?.body;
    const fullMessages = messageResults.find((result) => result.params?.sessionID === fullID)?.body;
    expect(originalMessages?.map((message: any) => message.info?.role)).toEqual(['user', 'assistant']);
    expect(partialMessages?.map((message: any) => message.info?.role)).toEqual(['user']);
    expect(fullMessages?.map((message: any) => message.info?.role)).toEqual(['user', 'assistant']);
    expect(partialMessages[0]?.info).toMatchObject({ sessionID: partialID });
    expect(partialMessages[0]?.info?.id).not.toBe(originalMessages[0]?.info?.id);
    expect(fullMessages[1]?.info).toMatchObject({ sessionID: fullID, parentID: fullMessages[0]?.info?.id });

    const archiveRequest = roundTrips.find(
      (record) => record.request?.method === 'PATCH' && record.request?.route === '/session/:sessionID',
    )?.request;
    const archiveResult = roundTrips.find(
      (record) => record.response?.method === 'PATCH' && record.response?.route === '/session/:sessionID',
    )?.response;
    expect(archiveRequest).toMatchObject({
      params: { sessionID: partialID },
      body: { time: { archived: REDACTED_EPOCH_MS } },
    });
    expect(archiveResult).toMatchObject({
      params: { sessionID: partialID },
      status: 200,
      body: { id: partialID, time: { archived: REDACTED_EPOCH_MS } },
    });

    const projectList = roundTrips.find(
      (record) => record.response?.method === 'GET' && record.response?.route === '/session',
    )?.response?.body;
    expect(projectList.map((entry: any) => entry.id)).toEqual(expect.arrayContaining([parentID, partialID, fullID]));

    const experimentalLists = roundTrips
      .filter((record) => record.response?.route === '/experimental/session')
      .map((record) => record.response);
    const activeOnly = experimentalLists.find((result) => result.query === undefined)?.body;
    const includingArchived = experimentalLists.filter((result) => result.query?.archived === 'true');
    expect(activeOnly.map((entry: any) => entry.id)).toEqual(expect.arrayContaining([parentID, fullID]));
    expect(activeOnly.some((entry: any) => entry.id === partialID)).toBe(false);
    expect(includingArchived).toHaveLength(2);
    expect(includingArchived[0]?.body.some((entry: any) => entry.id === partialID)).toBe(true);
    expect(includingArchived[1]?.body.some((entry: any) => entry.id === partialID)).toBe(false);

    const lifecycleEvents = events('session-lifecycle');
    const archivedIndex = lifecycleEvents.findIndex(
      (event) =>
        event.type === 'session.updated' &&
        event.properties?.sessionID === partialID &&
        event.properties?.info?.time?.archived === REDACTED_EPOCH_MS,
    );
    const deletedIndex = lifecycleEvents.findIndex(
      (event) => event.type === 'session.deleted' && event.properties?.sessionID === partialID,
    );
    expect(archivedIndex).toBeGreaterThan(-1);
    expect(deletedIndex).toBeGreaterThan(archivedIndex);
    expect(lifecycleEvents[deletedIndex]?.properties?.info).toMatchObject({
      id: partialID,
      time: { archived: REDACTED_EPOCH_MS },
    });
    expect(records('session-lifecycle', 'provider-requests.jsonl')).toHaveLength(1);
  });

  it('captures file write/edit/delete lifecycles, snapshots, patches, and the workspace-diff split', () => {
    expect(partStatuses('file-write', 'write')).toEqual(['pending', 'running', 'completed']);
    expect(partStatuses('file-edit', 'read')).toEqual(['pending', 'running', 'completed']);
    expect(partStatuses('file-edit', 'edit')).toEqual(['pending', 'running', 'running', 'completed']);
    expect(partStatuses('file-delete', 'apply_patch')).toEqual(['pending', 'running', 'completed']);
    expect(records('file-write', 'provider-requests.jsonl')).toHaveLength(2);
    expect(records('file-edit', 'provider-requests.jsonl')).toHaveLength(3);
    expect(records('file-delete', 'provider-requests.jsonl')).toHaveLength(2);

    for (const [scenario, watcherEvent, vcsStatus, additions, deletions] of [
      ['file-write', 'add', 'added', 1, 0],
      ['file-edit', 'change', 'modified', 1, 1],
      ['file-delete', 'unlink', 'deleted', 0, 1],
    ] as const) {
      const captured = events(scenario);
      const editedIndex = captured.findIndex((event) => event.type === 'file.edited');
      const watcherIndex = captured.findIndex(
        (event) => event.type === 'file.watcher.updated' && event.properties?.event === watcherEvent,
      );
      expect(watcherIndex).toBeGreaterThan(-1);
      if (scenario === 'file-delete') {
        expect(editedIndex).toBe(-1);
      } else {
        expect(editedIndex).toBeGreaterThan(-1);
        expect(watcherIndex).toBeGreaterThan(editedIndex);
        expect(captured[watcherIndex]?.properties?.file).toBe(captured[editedIndex]?.properties?.file);
      }

      // Live session.diff events are invalidation notifications and the
      // endpoint is empty without a message ID.
      expect(events(scenario, 'session.diff').every((event) => event.properties?.diff?.length === 0)).toBe(true);
      const roundTrips = records(scenario, 'http-roundtrip.jsonl');
      expect(
        roundTrips.find(
          (record) => record.response?.route === '/session/:sessionID/diff' && record.response?.query === undefined,
        )?.response?.body,
      ).toEqual([]);
      const prompt = roundTrips.find((record) => record.request?.route === '/session/:sessionID/prompt_async');
      const messageDiff = roundTrips.find(
        (record) =>
          record.response?.route === '/session/:sessionID/diff' && record.response?.query?.messageID !== undefined,
      )?.response;
      expect(messageDiff?.query?.messageID).toBe(prompt?.request?.body?.messageID);
      expect(messageDiff?.body).toEqual([
        {
          file: '/workspace/redacted-file',
          patch: '<redacted:patch>',
          additions,
          deletions,
          status: vcsStatus,
        },
      ]);

      // A patch part joins the pre-step snapshot hash to the changed files;
      // the step-finish snapshot is the post-mutation state.
      const parts = events(scenario, 'message.part.updated').map((event) => event.properties?.part);
      const patch = parts.find((part) => part?.type === 'patch');
      const start = parts.find(
        (part) => part?.type === 'step-start' && part?.messageID === patch?.messageID,
      );
      const finish = parts.find(
        (part) => part?.type === 'step-finish' && part?.messageID === patch?.messageID,
      );
      expect(patch).toMatchObject({ files: ['/workspace/redacted-path'] });
      expect(patch?.hash).toBe(start?.snapshot);
      expect(finish?.snapshot).not.toBe(start?.snapshot);

      // The VCS endpoint exposes the current tracked workspace view using a
      // different patch format but the same structural file status/counts.
      const vcs = roundTrips.find((record) => record.response?.route === '/vcs/diff')?.response;
      expect(vcs?.query).toEqual({ mode: 'git' });
      expect(vcs?.body).toEqual([
        {
          file: '/workspace/redacted-file',
          patch: '<redacted:patch>',
          additions,
          deletions,
          status: vcsStatus,
        },
      ]);
    }

    const editParts = events('file-edit', 'message.part.updated').map((event) => event.properties?.part);
    expect(editParts.findIndex((part) => part?.tool === 'read' && part?.state?.status === 'completed')).toBeLessThan(
      editParts.findIndex((part) => part?.tool === 'edit' && part?.state?.status === 'pending'),
    );
    expect(
      editParts.some(
        (part) =>
          part?.tool === 'edit' &&
          part?.state?.metadata?.filediff?.additions === 1 &&
          part?.state?.metadata?.filediff?.deletions === 1,
      ),
    ).toBe(true);
  });

  it('captures foreground task tools and direct subtask parts as joined child sessions', () => {
    for (const [scenario, statuses, providerRequests, directPart] of [
      ['task-child', ['pending', 'running', 'running', 'completed'], 3, false],
      ['subtask-part', ['running', 'running', 'completed'], 2, true],
    ] as const) {
      const captured = events(scenario);
      const created = captured.filter((event) => event.type === 'session.created');
      expect(created).toHaveLength(2);
      const parent = created.find((event) => event.properties?.info?.parentID === undefined);
      const child = created.find((event) => event.properties?.info?.parentID !== undefined);
      const parentID = parent?.properties?.sessionID;
      const childID = child?.properties?.sessionID;
      expect(parentID).toMatch(/^ses_a11a5ed0/);
      expect(childID).toMatch(/^ses_a11a5ed0/);
      expect(child?.properties?.info).toMatchObject({ id: childID, parentID });

      const taskUpdates = captured
        .map((event, index) => ({ event, index }))
        .filter(
          ({ event }) =>
            event.type === 'message.part.updated' &&
            event.properties?.part?.type === 'tool' &&
            event.properties?.part?.tool === 'task',
        );
      expect(taskUpdates.map(({ event }) => event.properties?.part?.state?.status)).toEqual(statuses);
      const joinedTask = taskUpdates.find(({ event }) => event.properties?.part?.state?.metadata?.sessionId);
      expect(joinedTask?.event.properties?.part?.state?.metadata).toMatchObject({
        parentSessionId: parentID,
        sessionId: childID,
      });

      const childIdleIndex = captured.findIndex(
        (event) => event.type === 'session.idle' && event.properties?.sessionID === childID,
      );
      const taskCompletedIndex = taskUpdates.find(
        ({ event }) => event.properties?.part?.state?.status === 'completed',
      )?.index;
      const parentIdleIndex = captured.findIndex(
        (event) => event.type === 'session.idle' && event.properties?.sessionID === parentID,
      );
      expect(childIdleIndex).toBeGreaterThan(-1);
      expect(taskCompletedIndex).toBeGreaterThan(childIdleIndex);
      expect(parentIdleIndex).toBeGreaterThan(taskCompletedIndex ?? -1);

      const children = records(scenario, 'children.jsonl');
      expect(children).toEqual([
        expect.objectContaining({
          id: childID,
          parentID,
          permission: expect.arrayContaining([
            expect.objectContaining({ permission: 'todowrite', action: 'deny' }),
            expect.objectContaining({ permission: 'task', action: 'deny' }),
          ]),
          tokens: expect.objectContaining({ input: 11, output: 7 }),
        }),
      ]);
      const childMessages = records(scenario, 'child-messages.jsonl');
      expect(childMessages.map((message) => message.info?.role)).toEqual(['user', 'assistant']);
      expect(childMessages.every((message) => message.info?.sessionID === childID)).toBe(true);

      const roundTrips = records(scenario, 'http-roundtrip.jsonl');
      expect(
        roundTrips.find((record) => record.request?.route === '/session/:sessionID/children')?.request?.params,
      ).toEqual({ sessionID: parentID });
      expect(
        roundTrips.find(
          (record) =>
            record.request?.route === '/session/:sessionID/message' &&
            record.request?.params?.sessionID === childID,
        ),
      ).toBeDefined();
      expect(records(scenario, 'provider-requests.jsonl')).toHaveLength(providerRequests);

      const subtaskIndex = captured.findIndex(
        (event) => event.type === 'message.part.updated' && event.properties?.part?.type === 'subtask',
      );
      if (directPart) {
        expect(subtaskIndex).toBeGreaterThan(-1);
        expect(subtaskIndex).toBeLessThan(taskUpdates[0]?.index ?? -1);
        const durable = records(scenario, 'messages.jsonl');
        expect(durable[0]?.parts).toEqual([expect.objectContaining({ type: 'subtask' })]);
        expect(durable[1]?.info).toMatchObject({ role: 'assistant', mode: 'explore', finish: 'tool-calls' });
        expect(durable[2]?.info).toMatchObject({ role: 'assistant', mode: 'build', finish: 'stop' });
      } else {
        expect(subtaskIndex).toBe(-1);
      }
    }
  });

  it('captures an agent mention part, its synthetic task instruction, and the resulting child', () => {
    const captured = events('agent-part');
    const agentPartIndex = captured.findIndex(
      (event) => event.type === 'message.part.updated' && event.properties?.part?.type === 'agent',
    );
    const syntheticInstructionIndex = captured.findIndex(
      (event) =>
        event.type === 'message.part.updated' &&
        event.properties?.part?.type === 'text' &&
        event.properties?.part?.synthetic === true,
    );
    const taskPendingIndex = captured.findIndex(
      (event) =>
        event.type === 'message.part.updated' &&
        event.properties?.part?.tool === 'task' &&
        event.properties?.part?.state?.status === 'pending',
    );
    expect(agentPartIndex).toBeGreaterThan(-1);
    expect(syntheticInstructionIndex).toBeGreaterThan(agentPartIndex);
    expect(taskPendingIndex).toBeGreaterThan(syntheticInstructionIndex);
    expect(partStatuses('agent-part', 'task')).toEqual(['pending', 'running', 'running', 'completed']);

    const durable = records('agent-part', 'messages.jsonl');
    expect(durable[0]?.parts).toEqual([
      expect.objectContaining({ type: 'text' }),
      expect.objectContaining({ type: 'agent' }),
      expect.objectContaining({ type: 'text', synthetic: true }),
    ]);
    expect(durable[1]?.parts).toEqual(expect.arrayContaining([expect.objectContaining({ tool: 'task' })]));

    const created = captured.filter((event) => event.type === 'session.created');
    const parentID = created.find((event) => event.properties?.info?.parentID === undefined)?.properties?.sessionID;
    const child = created.find((event) => event.properties?.info?.parentID !== undefined)?.properties?.info;
    expect(child).toMatchObject({ parentID });
    expect(records('agent-part', 'children.jsonl')).toEqual([
      expect.objectContaining({ id: child?.id, parentID }),
    ]);
    expect(records('agent-part', 'child-messages.jsonl').map((message) => message.info?.role)).toEqual([
      'user',
      'assistant',
    ]);
    expect(records('agent-part', 'provider-requests.jsonl')).toHaveLength(3);
  });

  it('captures direct background tasks and foreground-to-background promotion', () => {
    for (const [scenario, statuses, launchedInBackground] of [
      ['background-task', ['pending', 'running', 'running', 'completed'], true],
      ['detach-task', ['pending', 'running', 'running', 'running', 'completed'], false],
    ] as const) {
      const captured = events(scenario);
      const created = captured.filter((event) => event.type === 'session.created');
      expect(created).toHaveLength(2);
      const parent = created.find((event) => event.properties?.info?.parentID === undefined);
      const child = created.find((event) => event.properties?.info?.parentID !== undefined);
      const parentID = parent?.properties?.sessionID;
      const childID = child?.properties?.sessionID;
      expect(child?.properties?.info).toMatchObject({ id: childID, parentID });

      const taskUpdates = captured
        .map((event, index) => ({ event, index }))
        .filter(
          ({ event }) =>
            event.type === 'message.part.updated' &&
            event.properties?.part?.type === 'tool' &&
            event.properties?.part?.tool === 'task',
        );
      expect(taskUpdates.map(({ event }) => event.properties?.part?.state?.status)).toEqual(statuses);
      const joinedUpdates = taskUpdates.filter(({ event }) => event.properties?.part?.state?.metadata?.sessionId);
      expect(joinedUpdates[0]?.event.properties?.part?.state?.metadata?.background).toBe(
        launchedInBackground ? true : undefined,
      );
      const completed = taskUpdates.find(({ event }) => event.properties?.part?.state?.status === 'completed');
      expect(completed?.event.properties?.part?.state?.metadata).toMatchObject({
        parentSessionId: parentID,
        sessionId: childID,
        background: true,
        jobId: childID,
      });

      const firstParentIdle = captured.findIndex(
        (event) => event.type === 'session.idle' && event.properties?.sessionID === parentID,
      );
      const childIdle = captured.findIndex(
        (event) => event.type === 'session.idle' && event.properties?.sessionID === childID,
      );
      const injection = captured.findIndex(
        (event) =>
          event.type === 'message.part.updated' &&
          event.properties?.part?.sessionID === parentID &&
          event.properties?.part?.type === 'text' &&
          event.properties?.part?.synthetic === true,
      );
      const secondParentIdle = captured.findIndex(
        (event, index) =>
          index > injection && event.type === 'session.idle' && event.properties?.sessionID === parentID,
      );
      expect(completed?.index).toBeLessThan(firstParentIdle);
      expect(childIdle).toBeGreaterThan(firstParentIdle);
      expect(injection).toBeGreaterThan(childIdle);
      expect(secondParentIdle).toBeGreaterThan(injection);

      const durable = records(scenario, 'messages.jsonl');
      expect(durable.map((message) => message.info?.role)).toEqual([
        'user',
        'assistant',
        'assistant',
        'user',
        'assistant',
      ]);
      expect(durable[1]?.parts).toEqual([
        expect.objectContaining({ type: 'step-start' }),
        expect.objectContaining({ type: 'tool', tool: 'task', state: expect.objectContaining({ status: 'completed' }) }),
        expect.objectContaining({ type: 'step-finish' }),
      ]);
      expect(durable[3]?.parts).toEqual([expect.objectContaining({ type: 'text', synthetic: true })]);
      expect(durable[4]?.info).toMatchObject({ mode: 'build', finish: 'stop' });

      const children = records(scenario, 'children.jsonl');
      expect(children).toEqual([expect.objectContaining({ id: childID, parentID })]);
      const childMessages = records(scenario, 'child-messages.jsonl');
      expect(childMessages.map((message) => message.info?.role)).toEqual(['user', 'assistant']);
      expect(childMessages.every((message) => message.info?.sessionID === childID)).toBe(true);
      expect(records(scenario, 'provider-requests.jsonl')).toHaveLength(4);

      const backgroundRoundTrip = records(scenario, 'http-roundtrip.jsonl').filter(
        (record) =>
          record.request?.route === '/experimental/session/:sessionID/background' ||
          record.response?.route === '/experimental/session/:sessionID/background',
      );
      if (scenario === 'detach-task') {
        expect(backgroundRoundTrip).toEqual([
          expect.objectContaining({ request: expect.objectContaining({ params: { sessionID: parentID } }) }),
          expect.objectContaining({ response: expect.objectContaining({ status: 200, body: true }) }),
        ]);
      } else {
        expect(backgroundRoundTrip).toEqual([]);
      }
    }
  });

  it('captures permission accept and reject as explicit correlated round-trips', () => {
    const acceptedAsk = events('permission-accept', 'permission.asked')[0];
    const acceptedReply = events('permission-accept', 'permission.replied')[0];
    expect(acceptedReply.properties.requestID).toBe(acceptedAsk.properties.id);
    expect(acceptedReply.properties.reply).toBe('once');
    expect(partStatuses('permission-accept', 'bash')).toEqual(
      expect.arrayContaining(['pending', 'running', 'completed']),
    );
    expect(records('permission-accept', 'provider-requests.jsonl')).toHaveLength(2);

    const rejectedAsk = events('permission-reject', 'permission.asked')[0];
    const rejectedReply = events('permission-reject', 'permission.replied')[0];
    expect(rejectedReply.properties.requestID).toBe(rejectedAsk.properties.id);
    expect(rejectedReply.properties.reply).toBe('reject');
    expect(partStatuses('permission-reject', 'bash')).toContain('error');
    // Native behavior: rejection closes this tool loop rather than asking the
    // provider for a follow-up response.
    expect(records('permission-reject', 'provider-requests.jsonl')).toHaveLength(1);
  });

  it('captures a native attach TUI resolving permission with always', () => {
    const asked = events('attach-permission-always', 'permission.asked')[0];
    const replied = events('attach-permission-always', 'permission.replied')[0];
    expect(replied.properties.requestID).toBe(asked.properties.id);
    expect(replied.properties.reply).toBe('always');
    expect(partStatuses('attach-permission-always', 'bash')).toEqual(
      expect.arrayContaining(['pending', 'running', 'completed']),
    );
    expect(records('attach-permission-always', 'provider-requests.jsonl')).toHaveLength(2);

    const roundTrips = records('attach-permission-always', 'http-roundtrip.jsonl');
    expect(roundTrips.some((record) => record.request?.route === '/permission/:requestID/reply')).toBe(false);
    expect(roundTrips.find((record) => record.response?.route === '/permission')?.response?.body).toEqual([]);
  });

  it('captures question reply and dismissal without folding them into permission events', () => {
    const asked = events('question-reply', 'question.asked')[0];
    const replied = events('question-reply', 'question.replied')[0];
    expect(replied.properties.requestID).toBe(asked.properties.id);
    expect(partStatuses('question-reply', 'question')).toContain('completed');
    expect(records('question-reply', 'provider-requests.jsonl')).toHaveLength(2);

    const rejectedAsk = events('question-reject', 'question.asked')[0];
    const rejected = events('question-reject', 'question.rejected')[0];
    expect(rejected.properties.requestID).toBe(rejectedAsk.properties.id);
    expect(partStatuses('question-reject', 'question')).toContain('error');
    expect(records('question-reject', 'provider-requests.jsonl')).toHaveLength(1);
    expect(events('question-reject', 'permission.replied')).toHaveLength(0);
  });

  it('captures streamed and running-tool aborts through the native abort endpoint', () => {
    for (const scenario of ['abort-stream', 'abort-tool']) {
      const roundTrips = records(scenario, 'http-roundtrip.jsonl');
      const request = roundTrips.find((record) => record.request?.route === '/session/:sessionID/abort');
      const response = roundTrips.find((record) => record.response?.route === '/session/:sessionID/abort');
      expect(request?.request?.method).toBe('POST');
      expect(response?.response).toMatchObject({ status: 200, body: true });
      expect(events(scenario, 'session.error')).toHaveLength(1);
      expect(records(scenario, 'provider-requests.jsonl')).toHaveLength(1);
    }

    const streamed = events('abort-stream');
    const textDelta = streamed.findIndex(
      (event) => event.type === 'message.part.delta' && event.properties?.field === 'text',
    );
    const streamError = streamed.findIndex((event) => event.type === 'session.error');
    expect(textDelta).toBeGreaterThan(-1);
    expect(textDelta).toBeLessThan(streamError);

    const toolEvents = events('abort-tool');
    const toolError = toolEvents.findIndex((event) => event.type === 'session.error');
    const completedTool = toolEvents.findIndex(
      (event) =>
        event.type === 'message.part.updated' &&
        event.properties?.part?.type === 'tool' &&
        event.properties?.part?.state?.status === 'completed',
    );
    expect(partStatuses('abort-tool', 'bash')).toEqual(expect.arrayContaining(['pending', 'running', 'completed']));
    // Native behavior is deliberately counterintuitive: abort fails the turn,
    // then the Bash carrier settles as completed with an abort marker.
    expect(toolError).toBeGreaterThan(-1);
    expect(toolError).toBeLessThan(completedTool);
  });

  it('captures retryable recovery separately from a terminal provider error', () => {
    const retryStatuses = events('provider-retry', 'session.status').map((event) => event.properties?.status);
    expect(retryStatuses).toContainEqual(
      expect.objectContaining({ type: 'retry', attempt: 1, next: REDACTED_EPOCH_MS }),
    );
    expect(retryStatuses.at(-1)?.type).toBe('idle');
    expect(events('provider-retry', 'session.error')).toHaveLength(0);
    expect(records('provider-retry', 'provider-requests.jsonl')).toHaveLength(2);

    const terminalError = events('provider-error', 'session.error');
    expect(terminalError).toHaveLength(1);
    expect(terminalError[0]?.properties?.error?.data).toMatchObject({
      statusCode: 400,
      isRetryable: false,
      responseBody: '<redacted:responseBody>',
      metadata: { url: 'https://example.invalid/redacted' },
    });
    expect(events('provider-error', 'session.status').some((event) => event.properties?.status?.type === 'retry')).toBe(
      false,
    );
    expect(records('provider-error', 'provider-requests.jsonl')).toHaveLength(1);
  });

  it('captures an SSE gap that requires durable REST rehydration', () => {
    const before = records('reconnect-rehydrate', 'events-before-disconnect.jsonl');
    const after = records('reconnect-rehydrate', 'events-after-reconnect.jsonl');
    expect(before.some((event) => event.type === 'message.part.delta' && event.properties?.field === 'text')).toBe(
      true,
    );
    expect(
      before.some(
        (event) =>
          event.type === 'session.error' ||
          event.type === 'session.idle' ||
          (event.type === 'session.status' && event.properties?.status?.type === 'idle'),
      ),
    ).toBe(false);
    // The replacement stream has no history cursor and replays no session
    // events; only its fresh connection marker appears.
    expect(after.map((event) => event.type)).toEqual(['server.connected']);

    const durable = records('reconnect-rehydrate', 'messages.jsonl');
    expect(durable.map((message) => message.info?.role)).toEqual(['user', 'assistant']);
    expect(durable[1]?.info).toMatchObject({ finish: 'stop', time: { completed: REDACTED_EPOCH_MS } });
    expect(records('reconnect-rehydrate', 'provider-requests.jsonl')).toHaveLength(1);
  });

  it('resumes the exact persisted session across a private backend restart', () => {
    const beforeRestart = records('exact-resume', 'messages-before-restart.jsonl');
    const afterRestart = records('exact-resume', 'messages-after-restart.jsonl');
    const finalMessages = records('exact-resume', 'messages.jsonl');
    expect(beforeRestart).toHaveLength(2);
    expect(afterRestart).toEqual(beforeRestart);
    expect(finalMessages.map((message) => message.info?.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(new Set(finalMessages.map((message) => message.info?.sessionID)).size).toBe(1);

    const roundTrips = records('exact-resume', 'http-roundtrip.jsonl');
    const verificationRequest = roundTrips.find((record) => record.request?.route === '/session/:sessionID');
    const verificationResponse = roundTrips.find((record) => record.response?.route === '/session/:sessionID');
    expect(verificationResponse?.response?.status).toBe(200);
    expect(verificationResponse?.response?.body?.id).toBe(verificationRequest?.request?.params?.sessionID);
    expect(verificationResponse?.response?.body?.id).toBe(verificationResponse?.response?.params?.sessionID);

    const promptIDs = roundTrips
      .filter((record) => record.request?.route === '/session/:sessionID/prompt_async')
      .map((record) => record.request?.body?.messageID);
    const userIDs = finalMessages.filter((message) => message.info?.role === 'user').map((message) => message.info?.id);
    expect(promptIDs).toHaveLength(2);
    expect(new Set(promptIDs).size).toBe(2);
    expect(userIDs).toEqual(promptIDs);
    expect(events('exact-resume', 'server.connected')).toHaveLength(2);
    expect(events('exact-resume', 'session.created')).toHaveLength(1);
    expect(records('exact-resume', 'provider-requests.jsonl')).toHaveLength(2);
  });

  it('reattaches the native TUI to the exact recovered session and resolves a resumed permission', () => {
    const beforeRestart = records('attach-exact-resume', 'messages-before-restart.jsonl');
    const afterRestart = records('attach-exact-resume', 'messages-after-restart.jsonl');
    const finalMessages = records('attach-exact-resume', 'messages.jsonl');
    expect(beforeRestart).toHaveLength(2);
    expect(afterRestart).toEqual(beforeRestart);
    expect(finalMessages.map((message) => message.info?.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
      'assistant',
    ]);
    expect(new Set(finalMessages.map((message) => message.info?.sessionID)).size).toBe(1);

    const beforeEvents = records('attach-exact-resume', 'events-before-restart.jsonl');
    const afterEvents = records('attach-exact-resume', 'events-after-restart.jsonl');
    expect(beforeEvents.some((event) => event.type === 'permission.asked')).toBe(false);
    expect(afterEvents[0]?.type).toBe('server.connected');
    expect(afterEvents.some((event) => event.type === 'session.created')).toBe(false);
    const asked = afterEvents.find((event) => event.type === 'permission.asked');
    const replied = afterEvents.find((event) => event.type === 'permission.replied');
    expect(replied?.properties).toMatchObject({ requestID: asked?.properties?.id, reply: 'always' });
    expect(partStatuses('attach-exact-resume', 'bash')).toEqual(
      expect.arrayContaining(['pending', 'running', 'completed']),
    );

    const roundTrips = records('attach-exact-resume', 'http-roundtrip.jsonl');
    const verification = roundTrips.find((record) => record.response?.route === '/session/:sessionID')?.response;
    expect(verification).toMatchObject({
      status: 200,
      params: { sessionID: verification?.body?.id },
      body: { id: verification?.body?.id },
    });
    expect(roundTrips.some((record) => record.request?.route === '/permission/:requestID/reply')).toBe(false);
    expect(events('attach-exact-resume', 'server.connected')).toHaveLength(2);
    expect(events('attach-exact-resume', 'session.created')).toHaveLength(1);
    expect(records('attach-exact-resume', 'provider-requests.jsonl')).toHaveLength(3);
  });

  it('captures manual compaction as a synthetic message turn and explicit invalidation', () => {
    const captured = events('manual-compaction');
    const compactionPartIndex = captured.findIndex(
      (event) => event.type === 'message.part.updated' && event.properties?.part?.type === 'compaction',
    );
    const compactedIndex = captured.findIndex((event) => event.type === 'session.compacted');
    const idleAfterCompaction = captured.findIndex(
      (event, index) =>
        index > compactedIndex && event.type === 'session.status' && event.properties?.status?.type === 'idle',
    );
    expect(compactionPartIndex).toBeGreaterThan(-1);
    expect(captured[compactionPartIndex]?.properties?.part?.auto).toBe(false);
    expect(compactedIndex).toBeGreaterThan(compactionPartIndex);
    expect(idleAfterCompaction).toBeGreaterThan(compactedIndex);

    const compactionMessages = events('manual-compaction', 'message.updated').filter(
      (event) => event.properties?.info?.mode === 'compaction',
    );
    expect(compactionMessages.length).toBeGreaterThanOrEqual(2);
    expect(compactionMessages.every((event) => event.properties?.info?.role === 'assistant')).toBe(true);
    expect(compactionMessages.at(-1)?.properties?.info).toMatchObject({
      summary: true,
      finish: 'stop',
      tokens: { total: 18, input: 11, output: 7 },
    });

    const durable = records('manual-compaction', 'messages.jsonl');
    expect(durable.map((message) => message.info?.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(durable[2]?.parts).toEqual([
      expect.objectContaining({ type: 'compaction', auto: false, messageID: durable[2]?.info?.id }),
    ]);
    expect(durable[3]?.info).toMatchObject({ mode: 'compaction', summary: true, finish: 'stop' });

    const roundTrips = records('manual-compaction', 'http-roundtrip.jsonl');
    expect(roundTrips.find((record) => record.request?.route === '/session/:sessionID/summarize')?.request?.body).toEqual(
      { providerID: 'test', modelID: 'test-model', auto: false },
    );
    expect(roundTrips.find((record) => record.response?.route === '/session/:sessionID/summarize')?.response).toMatchObject(
      { status: 200, body: true },
    );
    expect(records('manual-compaction', 'provider-requests.jsonl')).toHaveLength(2);
  });

  it('captures threshold-driven compaction and its synthetic continuation', () => {
    const captured = events('auto-compaction');
    const thresholdIndex = captured.findIndex(
      (event) =>
        event.type === 'message.part.updated' &&
        event.properties?.part?.type === 'step-finish' &&
        event.properties?.part?.tokens?.total === 120,
    );
    const compactionIndex = captured.findIndex(
      (event) =>
        event.type === 'message.part.updated' &&
        event.properties?.part?.type === 'compaction' &&
        event.properties?.part?.auto === true,
    );
    const continuationIndex = captured.findIndex(
      (event) =>
        event.type === 'message.part.updated' &&
        event.properties?.part?.type === 'text' &&
        event.properties?.part?.synthetic === true,
    );
    const compactedIndex = captured.findIndex((event) => event.type === 'session.compacted');
    const idleIndex = captured.findIndex(
      (event, index) =>
        index > compactedIndex && event.type === 'session.status' && event.properties?.status?.type === 'idle',
    );
    expect(thresholdIndex).toBeGreaterThan(-1);
    expect(compactionIndex).toBeGreaterThan(thresholdIndex);
    expect(captured[compactionIndex]?.properties?.part).toMatchObject({ auto: true, overflow: false });
    expect(continuationIndex).toBeGreaterThan(compactionIndex);
    expect(captured[continuationIndex]?.properties?.part?.metadata).toEqual({ compaction_continue: true });
    expect(compactedIndex).toBeGreaterThan(continuationIndex);
    expect(idleIndex).toBeGreaterThan(compactedIndex);

    const durable = records('auto-compaction', 'messages.jsonl');
    expect(durable.map((message) => message.info?.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
    expect(durable[1]?.info?.tokens).toMatchObject({ total: 120, input: 110, output: 10 });
    expect(durable[2]?.parts).toEqual([expect.objectContaining({ type: 'compaction', auto: true, overflow: false })]);
    expect(durable[3]?.info).toMatchObject({ mode: 'compaction', summary: true, finish: 'stop' });
    expect(durable[4]?.parts).toEqual([
      expect.objectContaining({ type: 'text', synthetic: true, metadata: { compaction_continue: true } }),
    ]);
    expect(durable[5]?.info).toMatchObject({ mode: 'build', finish: 'stop' });

    const roundTrips = records('auto-compaction', 'http-roundtrip.jsonl');
    expect(roundTrips.some((record) => record.request?.route === '/session/:sessionID/summarize')).toBe(false);
    expect(records('auto-compaction', 'provider-requests.jsonl')).toHaveLength(3);
  });

  it('captures provider hard overflow as an error followed by overflow compaction and recovery', () => {
    const captured = events('overflow-compaction');
    const overflowErrorIndex = captured.findIndex((event) => event.type === 'session.error');
    const compactionIndex = captured.findIndex(
      (event) =>
        event.type === 'message.part.updated' &&
        event.properties?.part?.type === 'compaction' &&
        event.properties?.part?.overflow === true,
    );
    const continuationIndex = captured.findIndex(
      (event) =>
        event.type === 'message.part.updated' &&
        event.properties?.part?.type === 'text' &&
        event.properties?.part?.synthetic === true,
    );
    const compactedIndex = captured.findIndex((event) => event.type === 'session.compacted');
    const resumedBuildIndex = captured.findIndex(
      (event) =>
        event.type === 'message.updated' &&
        event.properties?.info?.mode === 'build' &&
        event.properties?.info?.finish === 'stop',
    );
    const idleIndex = captured.findIndex(
      (event, index) =>
        index > resumedBuildIndex && event.type === 'session.status' && event.properties?.status?.type === 'idle',
    );
    expect(overflowErrorIndex).toBeGreaterThan(-1);
    expect(captured[overflowErrorIndex]?.properties?.error?.data).toMatchObject({
      message: '<redacted:message>',
      responseBody: '<redacted:responseBody>',
    });
    expect(compactionIndex).toBeGreaterThan(overflowErrorIndex);
    expect(captured[compactionIndex]?.properties?.part).toMatchObject({ auto: true, overflow: true });
    expect(continuationIndex).toBeGreaterThan(compactionIndex);
    expect(captured[continuationIndex]?.properties?.part?.metadata).toEqual({ compaction_continue: true });
    expect(compactedIndex).toBeGreaterThan(continuationIndex);
    expect(resumedBuildIndex).toBeGreaterThan(compactedIndex);
    expect(idleIndex).toBeGreaterThan(resumedBuildIndex);
    expect(events('overflow-compaction', 'session.status').some((event) => event.properties?.status?.type === 'retry')).toBe(
      false,
    );

    const durable = records('overflow-compaction', 'messages.jsonl');
    expect(durable.map((message) => message.info?.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
    expect(durable[1]).toMatchObject({ info: { mode: 'build' }, parts: [] });
    expect(durable[2]?.parts).toEqual([expect.objectContaining({ type: 'compaction', auto: true, overflow: true })]);
    expect(durable[3]?.info).toMatchObject({ mode: 'compaction', summary: true, finish: 'stop' });
    expect(durable[4]?.parts).toEqual([
      expect.objectContaining({ type: 'text', synthetic: true, metadata: { compaction_continue: true } }),
    ]);
    expect(durable[5]?.info).toMatchObject({ mode: 'build', finish: 'stop' });

    const roundTrips = records('overflow-compaction', 'http-roundtrip.jsonl');
    expect(roundTrips.some((record) => record.request?.route === '/session/:sessionID/summarize')).toBe(false);
    expect(records('overflow-compaction', 'provider-requests.jsonl')).toHaveLength(3);
  });

  it('treats a zero model context limit as unknown and does not compact on reported usage', () => {
    const captured = events('unknown-context');
    const highUsageIndex = captured.findIndex(
      (event) =>
        event.type === 'message.part.updated' &&
        event.properties?.part?.type === 'step-finish' &&
        event.properties?.part?.tokens?.total === 1_000_010,
    );
    const idleIndex = captured.findIndex(
      (event, index) =>
        index > highUsageIndex && event.type === 'session.status' && event.properties?.status?.type === 'idle',
    );
    expect(highUsageIndex).toBeGreaterThan(-1);
    expect(idleIndex).toBeGreaterThan(highUsageIndex);
    expect(
      captured.some(
        (event) => event.type === 'message.part.updated' && event.properties?.part?.type === 'compaction',
      ),
    ).toBe(false);
    expect(events('unknown-context', 'session.compacted')).toEqual([]);
    expect(events('unknown-context', 'session.error')).toEqual([]);

    const durable = records('unknown-context', 'messages.jsonl');
    expect(durable.map((message) => message.info?.role)).toEqual(['user', 'assistant']);
    expect(durable[1]?.info).toMatchObject({
      finish: 'stop',
      tokens: { total: 1_000_010, input: 1_000_000, output: 10 },
    });
    expect(records('unknown-context', 'provider-requests.jsonl')).toHaveLength(1);
    expect(
      records('unknown-context', 'http-roundtrip.jsonl').some(
        (record) => record.request?.route === '/session/:sessionID/summarize',
      ),
    ).toBe(false);
  });

  it('passes both the vendor privacy policy and the shared conservative detector', () => {
    expect(checkCaptureDirectory(capturesRoot, opencodeRules)).toEqual([]);
    expect(checkCaptureDirectory(capturesRoot, defaultRules)).toEqual([]);
  });
});

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadModel, validatePayload } from '@vibecook/puppeteer-surface';
import { checkCaptureDirectory, defaultRules } from '@vibecook/puppeteer-surface/sanitize';
import { opencodeRules } from './privacy.mjs';

const VERSION = '1.18.16';
const vendorRoot = dirname(fileURLToPath(import.meta.url));
const modelRoot = join(vendorRoot, 'model', `opencode@${VERSION}`);
const capturesRoot = join(vendorRoot, 'captures', `opencode@${VERSION}`);
const model = loadModel(modelRoot);
const sse = new Map(model.events.filter((event) => event.channel === 'sse').map((event) => [event.event, event]));
const http = new Map<string, (typeof model.events)[number]>();

for (const event of model.events.filter((entry) => entry.channel === 'http')) {
  const request = event.recordSchema?.properties?.request;
  const method = request?.properties?.method?.enum?.[0];
  const route = request?.properties?.route?.enum?.[0];
  if (typeof method === 'string' && typeof route === 'string') http.set(`${method} ${route}`, event);
}

function records(scenario: string, file: string): Array<Record<string, any>> {
  return readFileSync(join(capturesRoot, scenario, file), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function scenarioNames(): string[] {
  return readdirSync(capturesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function variantConfidence(event: string, path: string, value: unknown): string | undefined {
  return model.events.find((entry) => entry.event === event)?.variants?.find((variant) => variant.match[path] === value)
    ?.confidence;
}

describe('the OpenCode 1.18.16 ASM', () => {
  it('loads the complete generated HTTP/SSE surface with distinct native rails', () => {
    expect(model.manifest).toMatchObject({ asmVersion: 2, vendor: 'opencode', vendorVersion: VERSION });
    expect(Object.keys(model.channels.channels).sort()).toEqual(['argv', 'http', 'sse', 'terminal']);
    expect(model.events).toHaveLength(278);
    expect(model.events.filter((event) => event.channel === 'http')).toHaveLength(188);
    expect(model.events.filter((event) => event.channel === 'sse')).toHaveLength(90);
    expect(new Set(model.events.map((event) => event.direction))).toEqual(
      new Set(['client-to-agent', 'agent-to-client']),
    );

    const heartbeat = model.events.find((event) => event.event === 'server.heartbeat');
    expect(heartbeat).toMatchObject({ confidence: 'verified-headless', transport: 'sse-event' });
    expect(heartbeat?.notes).toContain('absent from the pinned /doc Event union');
  });

  it('raises confidence only for the 21 HTTP and 24 SSE runtime observations', () => {
    expect(model.events.filter((event) => event.confidence === 'verified-headless')).toHaveLength(45);
    expect(model.events.filter((event) => event.confidence === 'unverified')).toHaveLength(233);
    expect(model.events.filter((event) => event.confidence === 'verified-interactive')).toHaveLength(0);

    expect(model.events.find((event) => event.event === 'http/session.prompt_async')?.confidence).toBe(
      'verified-headless',
    );
    expect(model.events.find((event) => event.event === 'http/session.diff')?.confidence).toBe('verified-headless');
    expect(model.events.find((event) => event.event === 'http/vcs.diff')?.confidence).toBe('verified-headless');
    expect(model.events.find((event) => event.event === 'http/session.summarize')?.confidence).toBe(
      'verified-headless',
    );
    expect(model.events.find((event) => event.event === 'http/session.children')?.confidence).toBe(
      'verified-headless',
    );
    expect(model.events.find((event) => event.event === 'http/experimental.session.background')?.confidence).toBe(
      'verified-headless',
    );
    expect(model.events.find((event) => event.event === 'http/session.fork')?.confidence).toBe('verified-headless');
    expect(model.events.find((event) => event.event === 'http/session.update')?.confidence).toBe(
      'verified-headless',
    );
    expect(model.events.find((event) => event.event === 'http/session.delete')?.confidence).toBe(
      'verified-headless',
    );
    expect(model.events.find((event) => event.event === 'http/experimental.session.list')?.confidence).toBe(
      'verified-headless',
    );
    expect(model.events.find((event) => event.event === 'session.deleted')?.confidence).toBe('verified-headless');
    expect(model.events.find((event) => event.event === 'session.compacted')?.confidence).toBe(
      'verified-headless',
    );

    const vcsDiff = model.events.find((event) => event.event === 'http/vcs.diff');
    expect(vcsDiff?.payloadSchema?.properties?.query).toMatchObject({
      type: 'object',
      required: ['mode'],
      properties: { mode: { type: 'string' } },
    });
    expect(vcsDiff?.resultSchema?.properties).toMatchObject({
      method: { enum: ['GET'] },
      route: { enum: ['/vcs/diff'] },
      query: { required: ['mode'] },
    });
    const sessionDiff = model.events.find((event) => event.event === 'http/session.diff');
    expect(sessionDiff?.payloadSchema?.properties?.query).toMatchObject({
      type: 'object',
      properties: { messageID: { type: 'string' } },
    });
    expect(sessionDiff?.resultSchema?.properties?.query).toMatchObject({
      type: 'object',
      properties: { messageID: { type: 'string' } },
    });
  });

  it('attributes captured and schema-only variants independently', () => {
    expect(variantConfidence('permission.replied', 'reply', 'once')).toBe('verified-headless');
    expect(variantConfidence('permission.replied', 'reply', 'always')).toBe('verified-interactive');
    expect(variantConfidence('permission.replied', 'reply', 'reject')).toBe('verified-headless');
    expect(variantConfidence('session.status', 'status.type', 'retry')).toBe('verified-headless');
    expect(variantConfidence('message.part.updated', 'part.type', 'tool')).toBe('verified-headless');
    expect(variantConfidence('message.part.updated', 'part.type', 'file')).toBe('verified-headless');
    expect(variantConfidence('message.part.updated', 'part.type', 'snapshot')).toBe('unverified');
    expect(variantConfidence('message.part.updated', 'part.type', 'compaction')).toBe('verified-headless');
    expect(variantConfidence('message.part.updated', 'part.type', 'subtask')).toBe('verified-headless');
    expect(variantConfidence('message.part.updated', 'part.type', 'agent')).toBe('verified-headless');
    expect(variantConfidence('message.part.updated', 'part.type', 'patch')).toBe('verified-headless');
    expect(variantConfidence('file.watcher.updated', 'event', 'add')).toBe('verified-headless');
    expect(variantConfidence('file.watcher.updated', 'event', 'change')).toBe('verified-headless');
    expect(variantConfidence('file.watcher.updated', 'event', 'unlink')).toBe('verified-headless');
  });

  it('accepts every captured SSE payload and whole carrier', () => {
    const failures: string[] = [];
    let checked = 0;
    for (const scenario of scenarioNames()) {
      for (const [index, record] of records(scenario, 'events.jsonl').entries()) {
        const event = sse.get(record.type);
        if (!event) {
          failures.push(`${scenario}:${index + 1} unknown ${String(record.type)}`);
          continue;
        }
        for (const violation of validatePayload(event.payloadSchema!, record.properties)) {
          failures.push(`${scenario}:${index + 1} ${record.type} payload: ${violation}`);
        }
        for (const violation of validatePayload(event.recordSchema!, record)) {
          failures.push(`${scenario}:${index + 1} ${record.type} carrier: ${violation}`);
        }
        checked += 1;
      }
    }
    expect(checked).toBe(2775);
    expect(failures).toEqual([]);
  });

  it('accepts every correlated HTTP request, carrier, and result', () => {
    const failures: string[] = [];
    let requests = 0;
    let results = 0;
    for (const scenario of scenarioNames()) {
      const pending = new Map<string, number>();
      for (const [index, record] of records(scenario, 'http-roundtrip.jsonl').entries()) {
        if (record.request) {
          const key = `${record.request.method} ${record.request.route}`;
          const event = http.get(key);
          if (!event) {
            failures.push(`${scenario}:${index + 1} unknown request ${key}`);
            continue;
          }
          failures.push(
            ...validatePayload(event.payloadSchema!, record.request).map(
              (violation) => `${scenario}:${index + 1} ${event.event} payload: ${violation}`,
            ),
            ...validatePayload(event.recordSchema!, record).map(
              (violation) => `${scenario}:${index + 1} ${event.event} carrier: ${violation}`,
            ),
          );
          pending.set(key, (pending.get(key) ?? 0) + 1);
          requests += 1;
        } else if (record.response) {
          const key = `${record.response.method} ${record.response.route}`;
          const event = http.get(key);
          if (!event) {
            failures.push(`${scenario}:${index + 1} unknown result ${key}`);
            continue;
          }
          if ((pending.get(key) ?? 0) < 1) failures.push(`${scenario}:${index + 1} orphan result ${key}`);
          else pending.set(key, (pending.get(key) ?? 0) - 1);
          failures.push(
            ...validatePayload(event.resultSchema!, record.response).map(
              (violation) => `${scenario}:${index + 1} ${event.event} result: ${violation}`,
            ),
          );
          results += 1;
        }
      }
      expect([...pending.values()].reduce((sum, count) => sum + count, 0)).toBe(0);
    }
    expect({ requests, results }).toEqual({ requests: 209, results: 209 });
    expect(failures).toEqual([]);
  });

  it('binds behavior and evidence to captured workspace, context, subagent, failure, recovery, and attach paths', () => {
    expect(model.behavior.nodes.map((node) => node.id)).toEqual(
      expect.arrayContaining([
        'permission-always',
        'session-retry',
        'session-error',
        'server-connected',
        'workspace-file-edited',
        'workspace-watcher-add',
        'workspace-watcher-change',
        'workspace-watcher-unlink',
        'workspace-snapshot-before',
        'workspace-snapshot-after',
        'workspace-patch-part',
        'workspace-message-diff',
        'workspace-vcs-diff',
        'prompt-file-part',
        'session-fork-request',
        'fork-session-created',
        'session-archive-request',
        'session-archived',
        'session-project-list',
        'session-global-list-active',
        'session-global-list-archived',
        'session-delete-request',
        'session-deleted',
        'post-restart-native-attach-permission',
        'manual-compaction-request',
        'manual-compaction-part',
        'session-compacted-manual',
        'auto-threshold-step',
        'auto-compaction-part',
        'auto-compaction-continuation',
        'session-compacted-auto',
        'context-overflow-error',
        'overflow-compaction-part',
        'overflow-compaction-continuation',
        'session-compacted-overflow',
        'unknown-context-step',
        'direct-subtask-part',
        'subagent-task-running',
        'subagent-child-created',
        'subagent-child-idle',
        'subagent-task-completed',
        'subagent-parent-resumed',
        'subagent-detach-request',
        'subagent-background-running',
        'subagent-background-task-completed',
        'subagent-background-parent-idle',
        'subagent-background-child-idle',
        'subagent-background-result',
        'subagent-background-parent-resumed',
        'direct-agent-part',
        'agent-part-task-instruction',
      ]),
    );
    expect(
      model.behavior.relations.find(
        (relation) => relation.from === 'server-connected' && relation.to === 'server-connected',
      ),
    ).toMatchObject({ kind: 'resume', confidence: 'verified-headless' });
    expect(model.behavior.nodes.find((node) => node.id === 'permission-always')?.confidence).toBe(
      'verified-interactive',
    );
    expect(
      model.behavior.relations.find(
        (relation) => relation.from === 'session-idle' && relation.to === 'workspace-vcs-diff',
      ),
    ).toMatchObject({ kind: 'sequence', confidence: 'verified-headless' });
    expect(
      model.behavior.relations.find(
        (relation) => relation.from === 'user-message' && relation.to === 'prompt-file-part',
      ),
    ).toMatchObject({ kind: 'conditional', confidence: 'verified-headless' });
    expect(
      model.behavior.relations.find(
        (relation) => relation.from === 'session-fork-request' && relation.to === 'fork-session-created',
      ),
    ).toMatchObject({ kind: 'sequence', confidence: 'verified-headless' });
    expect(
      model.behavior.relations.find(
        (relation) => relation.from === 'session-archive-request' && relation.to === 'session-archived',
      ),
    ).toMatchObject({ kind: 'sequence', confidence: 'verified-headless' });
    expect(
      model.behavior.relations.find(
        (relation) => relation.from === 'session-delete-request' && relation.to === 'session-deleted',
      ),
    ).toMatchObject({ kind: 'sequence', confidence: 'verified-headless' });
    expect(
      model.behavior.relations.find(
        (relation) =>
          relation.from === 'server-connected' && relation.to === 'post-restart-native-attach-permission',
      ),
    ).toMatchObject({ kind: 'resume', confidence: 'verified-interactive' });
    expect(
      model.behavior.relations.find(
        (relation) => relation.from === 'workspace-snapshot-after' && relation.to === 'workspace-patch-part',
      ),
    ).toMatchObject({ kind: 'sequence', confidence: 'verified-headless' });
    expect(
      model.behavior.relations.find(
        (relation) => relation.from === 'manual-compaction-part' && relation.to === 'session-compacted-manual',
      ),
    ).toMatchObject({ kind: 'sequence', confidence: 'verified-headless' });
    expect(
      model.behavior.relations.find(
        (relation) => relation.from === 'session-compacted-auto' && relation.to === 'session-busy',
      ),
    ).toMatchObject({ kind: 'loop', confidence: 'verified-headless' });
    expect(
      model.behavior.relations.find(
        (relation) => relation.from === 'context-overflow-error' && relation.to === 'overflow-compaction-part',
      ),
    ).toMatchObject({ kind: 'sequence', confidence: 'verified-headless' });
    expect(
      model.behavior.relations.find(
        (relation) => relation.from === 'unknown-context-step' && relation.to === 'session-status-idle',
      ),
    ).toMatchObject({ kind: 'sequence', confidence: 'verified-headless' });
    expect(
      model.behavior.relations.find(
        (relation) => relation.from === 'direct-subtask-part' && relation.to === 'subagent-task-running',
      ),
    ).toMatchObject({ kind: 'sequence', confidence: 'verified-headless' });
    expect(
      model.behavior.relations.find(
        (relation) => relation.from === 'subagent-child-idle' && relation.to === 'subagent-task-completed',
      ),
    ).toMatchObject({ kind: 'sequence', confidence: 'verified-headless' });
    expect(
      model.behavior.relations.find(
        (relation) =>
          relation.from === 'subagent-background-parent-idle' && relation.to === 'subagent-background-child-idle',
      ),
    ).toMatchObject({ kind: 'sequence', confidence: 'verified-headless' });
    expect(
      model.behavior.relations.find(
        (relation) => relation.from === 'direct-agent-part' && relation.to === 'agent-part-task-instruction',
      ),
    ).toMatchObject({ kind: 'sequence', confidence: 'verified-headless' });

    const claims = new Map(model.evidenceIndex?.claims.map((claim) => [claim.id, claim]));
    expect(claims.get('opencode-runtime-attach-permission-always')?.confidence).toBe('verified-interactive');
    expect(claims.get('opencode-runtime-file-write')).toMatchObject({
      confidence: 'verified-headless',
      capturedAt: '2026-08-11T06:31:05.993Z',
    });
    expect(claims.get('opencode-runtime-file-edit')).toMatchObject({
      confidence: 'verified-headless',
      capturedAt: '2026-08-11T06:31:06.819Z',
    });
    expect(claims.get('opencode-runtime-file-delete')).toMatchObject({
      confidence: 'verified-headless',
      capturedAt: '2026-08-11T06:31:04.089Z',
    });
    expect(claims.get('opencode-runtime-file-part')).toMatchObject({
      confidence: 'verified-headless',
      capturedAt: '2026-08-11T07:01:18.440Z',
    });
    expect(claims.get('opencode-runtime-session-lifecycle')).toMatchObject({
      confidence: 'verified-headless',
      capturedAt: '2026-08-11T07:10:18.767Z',
    });
    expect(claims.get('opencode-runtime-attach-exact-resume')).toMatchObject({
      confidence: 'verified-interactive',
      capturedAt: '2026-08-11T07:18:00.868Z',
    });
    expect(claims.get('opencode-runtime-manual-compaction')).toMatchObject({
      confidence: 'verified-headless',
      capturedAt: '2026-08-11T05:53:20.004Z',
    });
    expect(claims.get('opencode-runtime-auto-compaction')).toMatchObject({
      confidence: 'verified-headless',
      capturedAt: '2026-08-11T06:00:30.080Z',
    });
    expect(claims.get('opencode-runtime-overflow-compaction')).toMatchObject({
      confidence: 'verified-headless',
      capturedAt: '2026-08-11T06:37:52.297Z',
    });
    expect(claims.get('opencode-runtime-task-child')).toMatchObject({
      confidence: 'verified-headless',
      capturedAt: '2026-08-11T06:14:05.678Z',
    });
    expect(claims.get('opencode-runtime-subtask-part')).toMatchObject({
      confidence: 'verified-headless',
      capturedAt: '2026-08-11T06:17:34.203Z',
    });
    expect(claims.get('opencode-runtime-background-task')).toMatchObject({
      confidence: 'verified-headless',
      capturedAt: '2026-08-11T06:45:27.498Z',
    });
    expect(claims.get('opencode-runtime-detach-task')).toMatchObject({
      confidence: 'verified-headless',
      capturedAt: '2026-08-11T06:45:16.713Z',
    });
    expect(claims.get('opencode-runtime-agent-part')).toMatchObject({
      confidence: 'verified-headless',
      capturedAt: '2026-08-11T06:51:18.359Z',
    });
    expect(claims.get('opencode-runtime-unknown-context')).toMatchObject({
      confidence: 'verified-headless',
      capturedAt: '2026-08-11T06:55:14.225Z',
    });
    expect(claims.get('opencode-generated-openapi')?.confidence).toBe('unverified');
    expect(model.evidenceIndex?.records).toHaveLength(29);
  });

  it('keeps every committed carrier clean under vendor and shared privacy rules', () => {
    expect(checkCaptureDirectory(capturesRoot, opencodeRules)).toEqual([]);
    expect(checkCaptureDirectory(capturesRoot, defaultRules)).toEqual([]);
  });
});

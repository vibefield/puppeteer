import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadModel, validateSanitizedPayload } from '@vibefield/puppeteer-surface';
import { checkCaptureDirectory, defaultRules } from '@vibefield/puppeteer-surface/sanitize';
import { opencodeRules } from './privacy.mjs';

const VERSION = '1.19.5';
const vendorRoot = dirname(fileURLToPath(import.meta.url));
const capturesRoot = join(vendorRoot, 'captures', `opencode@${VERSION}`);
const model = loadModel(vendorRoot);
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

function valueAt(value: unknown, dottedPath: string): unknown {
  return dottedPath.split('.').reduce<unknown>((current, component) => {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    return (current as Record<string, unknown>)[component];
  }, value);
}

function matches(value: unknown, expected: Readonly<Record<string, unknown>> | undefined): boolean {
  return Object.entries(expected ?? {}).every(([path, candidate]) => Object.is(valueAt(value, path), candidate));
}

describe(`the OpenCode ${VERSION} ASM`, () => {
  it('loads the complete generated HTTP/SSE surface with distinct native rails', () => {
    expect(model.manifest).toMatchObject({ asmVersion: 3, vendor: 'opencode', vendorVersion: VERSION });
    expect(Object.keys(model.channels.channels).sort()).toEqual(['argv', 'http', 'sse', 'terminal']);
    expect(model.events).toHaveLength(278);
    expect(model.events.filter((event) => event.channel === 'http')).toHaveLength(188);
    expect(model.events.filter((event) => event.channel === 'sse')).toHaveLength(90);
    expect(new Set(model.events.map((event) => event.direction))).toEqual(
      new Set(['client-to-agent', 'agent-to-client']),
    );

    // The linux-x64 1.19.5 headless scenarios all settle inside one heartbeat interval; only the longer native-attach
    // captures observed `server.heartbeat`, so its runtime evidence is interactive rather than headless.
    const heartbeat = model.events.find((event) => event.event === 'server.heartbeat');
    expect(heartbeat).toMatchObject({ confidence: 'verified-interactive', transport: 'sse-event' });
    expect(heartbeat?.notes).toContain('absent from the pinned /doc Event union');
  });

  it('raises confidence only for the 21 HTTP and 24 SSE runtime observations', () => {
    expect(model.events.filter((event) => event.confidence === 'verified-headless')).toHaveLength(44);
    expect(model.events.filter((event) => event.confidence === 'unverified')).toHaveLength(233);
    expect(
      model.events.filter((event) => event.confidence === 'verified-interactive').map((event) => event.event),
    ).toEqual(['server.heartbeat']);

    expect(model.events.find((event) => event.event === 'http/session.prompt_async')?.confidence).toBe(
      'verified-headless',
    );
    expect(model.events.find((event) => event.event === 'http/session.diff')?.confidence).toBe('verified-headless');
    expect(model.events.find((event) => event.event === 'http/vcs.diff')?.confidence).toBe('verified-headless');
    expect(model.events.find((event) => event.event === 'http/session.summarize')?.confidence).toBe(
      'verified-headless',
    );
    expect(model.events.find((event) => event.event === 'http/session.children')?.confidence).toBe('verified-headless');
    expect(model.events.find((event) => event.event === 'http/experimental.session.background')?.confidence).toBe(
      'verified-headless',
    );
    expect(model.events.find((event) => event.event === 'http/session.fork')?.confidence).toBe('verified-headless');
    expect(model.events.find((event) => event.event === 'http/session.update')?.confidence).toBe('verified-headless');
    expect(model.events.find((event) => event.event === 'http/session.delete')?.confidence).toBe('verified-headless');
    expect(model.events.find((event) => event.event === 'http/experimental.session.list')?.confidence).toBe(
      'verified-headless',
    );
    expect(model.events.find((event) => event.event === 'session.deleted')?.confidence).toBe('verified-headless');
    expect(model.events.find((event) => event.event === 'session.compacted')?.confidence).toBe('verified-headless');

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

  it('joins exact workspace-tool source contracts to their runtime occurrences', () => {
    const event = model.events.find((entry) => entry.event === 'message.part.updated');
    const refinements = event?.payloadRefinements ?? [];
    expect(refinements).toHaveLength(9);
    expect(
      refinements.find(
        (refinement) =>
          refinement.match?.['part.tool'] === 'edit' &&
          refinement.match?.['part.state.status'] === 'running' &&
          refinement.path === 'part.state.input',
      ),
    ).toMatchObject({
      confidence: 'verified-headless',
      fidelity: 'exact',
      schema: {
        type: 'object',
        required: ['filePath', 'oldString', 'newString'],
        properties: {
          filePath: { type: 'string' },
          oldString: { type: 'string' },
          newString: { type: 'string' },
          replaceAll: { type: 'boolean' },
        },
      },
    });
    expect(
      refinements.find(
        (refinement) => refinement.match?.['part.tool'] === 'apply_patch' && refinement.path === 'part.state.metadata',
      ),
    ).toMatchObject({
      fidelity: 'semantic',
      limitations: expect.arrayContaining([
        '`truncated` describes model-facing output truncation; it does not describe diff or patch completeness.',
      ]),
      schema: {
        type: 'object',
        properties: {
          truncated: { type: 'boolean' },
          files: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                filePath: { type: 'string' },
                type: { type: 'string', enum: ['add', 'update', 'delete', 'move'] },
                patch: { type: 'string' },
                additions: { type: 'integer', minimum: 0 },
                deletions: { type: 'integer', minimum: 0 },
                movePath: { type: 'string' },
              },
            },
          },
        },
      },
    });
    expect(model.evidenceIndex?.records.some((record) => record.id === 'source-workspace-tools')).toBe(true);
    expect(model.evidenceIndex?.claims.some((claim) => claim.id === 'opencode-exact-release-source')).toBe(true);

    const failures: string[] = [];
    for (const scenario of ['file-write', 'file-edit', 'file-delete']) {
      for (const [index, record] of records(scenario, 'events.jsonl').entries()) {
        if (record.type !== 'message.part.updated') continue;
        for (const refinement of refinements.filter((candidate) => matches(record.properties, candidate.match))) {
          const value = valueAt(record.properties, refinement.path);
          if (value === undefined) continue;
          failures.push(
            ...validateSanitizedPayload(refinement.schema, value).map(
              (violation) => `${scenario}:${index + 1} ${refinement.path}: ${violation}`,
            ),
          );
        }
      }
    }
    expect(failures).toEqual([]);
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
        for (const violation of validateSanitizedPayload(event.payloadSchema!, record.properties)) {
          failures.push(`${scenario}:${index + 1} ${record.type} payload: ${violation}`);
        }
        for (const violation of validateSanitizedPayload(event.recordSchema!, record)) {
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
            ...validateSanitizedPayload(event.payloadSchema!, record.request).map(
              (violation) => `${scenario}:${index + 1} ${event.event} payload: ${violation}`,
            ),
            ...validateSanitizedPayload(event.recordSchema!, record).map(
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
            ...validateSanitizedPayload(event.resultSchema!, record.response).map(
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
        (relation) => relation.from === 'server-connected' && relation.to === 'post-restart-native-attach-permission',
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
      capturedAt: '2026-11-03T19:17:57.093Z',
    });
    expect(claims.get('opencode-runtime-file-edit')).toMatchObject({
      confidence: 'verified-headless',
      capturedAt: '2026-11-03T19:18:06.153Z',
    });
    expect(claims.get('opencode-runtime-file-delete')).toMatchObject({
      confidence: 'verified-headless',
      capturedAt: '2026-11-03T19:18:15.537Z',
    });
    expect(claims.get('opencode-runtime-file-part')).toMatchObject({
      confidence: 'verified-headless',
      capturedAt: '2026-11-03T19:17:47.837Z',
    });
    expect(claims.get('opencode-runtime-session-lifecycle')).toMatchObject({
      confidence: 'verified-headless',
      capturedAt: '2026-11-03T19:17:38.658Z',
    });
    expect(claims.get('opencode-runtime-attach-exact-resume')).toMatchObject({
      confidence: 'verified-interactive',
      capturedAt: '2026-11-03T19:27:52.397Z',
    });
    expect(claims.get('opencode-runtime-manual-compaction')).toMatchObject({
      confidence: 'verified-headless',
      capturedAt: '2026-11-03T19:20:33.516Z',
    });
    expect(claims.get('opencode-runtime-auto-compaction')).toMatchObject({
      confidence: 'verified-headless',
      capturedAt: '2026-11-03T19:20:41.944Z',
    });
    expect(claims.get('opencode-runtime-overflow-compaction')).toMatchObject({
      confidence: 'verified-headless',
      capturedAt: '2026-11-03T19:20:50.189Z',
    });
    expect(claims.get('opencode-runtime-task-child')).toMatchObject({
      confidence: 'verified-headless',
      capturedAt: '2026-11-03T19:18:24.243Z',
    });
    expect(claims.get('opencode-runtime-subtask-part')).toMatchObject({
      confidence: 'verified-headless',
      capturedAt: '2026-11-03T19:18:32.518Z',
    });
    expect(claims.get('opencode-runtime-background-task')).toMatchObject({
      confidence: 'verified-headless',
      capturedAt: '2026-11-03T19:18:49.823Z',
    });
    expect(claims.get('opencode-runtime-detach-task')).toMatchObject({
      confidence: 'verified-headless',
      capturedAt: '2026-11-03T19:18:59.621Z',
    });
    expect(claims.get('opencode-runtime-agent-part')).toMatchObject({
      confidence: 'verified-headless',
      capturedAt: '2026-11-03T19:18:41.198Z',
    });
    expect(claims.get('opencode-runtime-unknown-context')).toMatchObject({
      confidence: 'verified-headless',
      capturedAt: '2026-11-03T19:20:58.345Z',
    });
    expect(claims.get('opencode-generated-openapi')?.confidence).toBe('unverified');
    expect(model.evidenceIndex?.records).toHaveLength(31);
  });

  it('keeps every committed carrier clean under vendor and shared privacy rules', () => {
    expect(checkCaptureDirectory(capturesRoot, opencodeRules)).toEqual([]);
    expect(checkCaptureDirectory(capturesRoot, defaultRules)).toEqual([]);
  });
});

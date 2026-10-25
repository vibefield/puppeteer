import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadModel, validatePayload, validateSanitizedPayload } from '@vibefield/puppeteer-surface';
import { resolveAgentModel } from '../../../../scripts/agent-model-selection.mjs';
import { checkGrokCaptureDirectory } from './privacy.mjs';

type Json = Record<string, any>;

const selected = resolveAgentModel({ vendor: 'grok' });
const capturesDir = selected.capturesRoot;
const model = loadModel(selected.groundTruthPath);
const event = (name: string) => model.events.find((candidate) => candidate.event === name)!;
const capture = JSON.parse(readFileSync(join(capturesDir, 'capture.json'), 'utf8')) as Json;
const scenarios = capture.scenarios as string[];
const lines = (path: string) =>
  readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Json);
const wire = (scenario: string, file = 'acp-controller.jsonl') =>
  existsSync(join(capturesDir, scenario, file)) ? lines(join(capturesDir, scenario, file)) : [];
const observations = (scenario: string) =>
  JSON.parse(readFileSync(join(capturesDir, scenario, 'observations.json'), 'utf8')) as Json;
const allWire = scenarios.flatMap((scenario) => [...wire(scenario), ...wire(scenario, 'acp-resume.jsonl')]);
const durable = scenarios.flatMap((scenario) =>
  readdirSync(join(capturesDir, scenario))
    .filter((name) => /^updates.*\.jsonl$/.test(name))
    .flatMap((name) => lines(join(capturesDir, scenario, name))),
);
const xaiUpdates = (kind: string) =>
  allWire.filter(
    (frame) =>
      frame.message.method === '_x.ai/session_notification' && frame.message.params?.update?.sessionUpdate === kind,
  );
const variant = (name: string, value: string) =>
  event(name).variants?.find((entry) => entry.match['update.sessionUpdate'] === value);
const refinement = (name: string, value: string, fidelity: string) =>
  event(name).payloadRefinements?.find(
    (entry) => entry.match?.['update.sessionUpdate'] === value && entry.fidelity === fidelity,
  );

describe(`the Grok ${selected.version} candidate ASM`, () => {
  it('keeps live ACP, durable updates, state files, leader, and terminal as distinct native channels', () => {
    expect(Object.keys(model.channels.channels).sort()).toEqual([
      'acp',
      'argv',
      'leader',
      'session-log',
      'session-state',
      'terminal',
    ]);
  });

  it('is generated from type-preserving captures under an explicit binary-only evidence policy', () => {
    expect(capture).toMatchObject({ schemaVersion: 2, representation: 'type-preserving-redaction' });
    expect(model.evidenceIndex?.evidencePolicy).toMatchObject({ kind: 'binary-only' });
    expect(
      model.evidenceIndex?.limitations?.some((entry) => entry.includes('absent from the public source mirror')),
    ).toBe(true);
    expect(model.detection.versionOutput).toBe(`grok ${selected.version} (f50904eaee6c)`);
    expect(new RegExp(model.detection.versionPattern!).test('grok 1.0.70 (f50904eaee6c) [stable]')).toBe(true);
  });

  it('models every captured method in its captured direction and accepts every payload and result', () => {
    const failures: string[] = [];
    for (const scenario of scenarios) {
      for (const file of ['acp-controller.jsonl', 'acp-resume.jsonl']) {
        const pending = new Map<string, string>();
        for (const { direction, message } of wire(scenario, file)) {
          if (typeof message.method === 'string') {
            const document = event(message.method);
            if (!document) failures.push(`unmodelled ${message.method}`);
            else {
              if (document.direction !== direction) failures.push(`${message.method} captured ${direction}`);
              failures.push(...validateSanitizedPayload(document.payloadSchema!, message.params ?? {}));
            }
            if (message.id !== undefined) pending.set(`${direction}:${message.id}`, message.method);
            continue;
          }
          const requester = direction === 'agent-to-client' ? 'client-to-agent' : 'agent-to-client';
          const method = pending.get(`${requester}:${message.id}`);
          if (!method) failures.push(`${scenario}/${file}: uncorrelated result ${message.id}`);
          else if (message.result !== undefined) {
            failures.push(...validateSanitizedPayload(event(method).resultSchema!, message.result));
          }
        }
      }
    }
    for (const record of durable) {
      const document = event(record.method);
      failures.push(...validateSanitizedPayload(document.recordSchema!, record));
      failures.push(...validateSanitizedPayload(document.payloadSchema!, record.params));
    }
    expect(failures).toEqual([]);
  });

  it('models the durable carrier clock in Unix seconds, not milliseconds', () => {
    for (const name of ['session/update', '_x.ai/session/update']) {
      const document = event(name);
      expect(document.recordChannel).toBe('session-log');
      const params = { sessionId: 'session-1', update: { sessionUpdate: 'agent_message_chunk' } };
      expect(validatePayload(document.recordSchema!, { timestamp: 1_767_225_600, method: name, params })).toEqual([]);
      expect(validatePayload(document.recordSchema!, { timestamp: 1_767_225_600_000, method: name, params })).toContain(
        'field "timestamp" is above maximum 99999999999',
      );
    }
  });

  it('retains the 1.0.70 ACP capability and permission contracts', () => {
    const initialize = allWire.find((frame) => frame.message.id === 1 && frame.message.result?.agentCapabilities);
    expect(initialize?.message.result.agentCapabilities.promptCapabilities).toEqual({
      image: true,
      audio: false,
      embeddedContext: true,
    });
    expect(initialize?.message.result.agentCapabilities.sessionCapabilities).toEqual({
      list: {},
      resume: {},
      close: {},
    });
    expect(validatePayload(event('initialize').resultSchema!, { ...initialize!.message.result })).toEqual([]);
    const flipped = structuredClone(initialize!.message.result);
    flipped.agentCapabilities.promptCapabilities.image = false;
    expect(validatePayload(event('initialize').resultSchema!, flipped).length).toBeGreaterThan(0);

    const turns = observations('viewer-session').turns as Json[];
    const byLabel = (label: string) => turns.find((turn) => turn.label === label)!;
    expect(byLabel('safe-command').permissionRequests).toEqual([]);
    expect(byLabel('mutating-allow').permissionRequests[0].options).toEqual([
      'always-allow/allow_always',
      'allow-once/allow_once',
      'reject-once/reject_once',
      'reject-always/reject_always',
    ]);
    const offFlag = (observations('approvals-remembered-off').turns as Json[])[0];
    expect(offFlag.permissionRequests[0].options).toEqual(['allow-once/allow_once', 'reject-once/reject_once']);
    const spawn = (observations('subagent').turns as Json[])[0];
    expect(spawn.permissionRequests[0]).toEqual({
      tool: 'spawn_subagent',
      options: ['allow-once/allow_once', 'reject-once/reject_once'],
    });
    const permission = event('session/request_permission');
    expect(permission.confidence).toBe('verified-headless');
    expect(permission.payloadRefinements?.map((entry) => entry.match)).toEqual([
      { 'toolCall.rawInput.variant': 'Bash' },
      { 'toolCall.rawInput.variant': 'Task' },
    ]);
  });

  it('records the conditional live echo, asynchronous signals, and viewer fan-out as captured behavior', () => {
    expect(observations('headless-compact').headlessUserMessageEchoes).toBe(0);
    expect((observations('viewer-session').turns as Json[]).every((turn) => turn.userMessageEchoes > 0)).toBe(true);
    const turns = scenarios.flatMap((scenario) => (observations(scenario).turns as Json[] | undefined) ?? []);
    expect(
      turns.some(
        (turn) =>
          turn.signalsTurnCountAtResult === null ||
          (turn.signalsTurnCountSettled ?? 0) > (turn.signalsTurnCountAtResult ?? 0),
      ),
    ).toBe(true);
    expect(observations('viewer-prompt').viewerTurn.permissionRequestsToController).toBeGreaterThan(0);
    const relations = model.behavior.relations;
    expect(relations.find((entry) => entry.from === 'queue-changed' && entry.to === 'user-message-echo')).toMatchObject(
      {
        kind: 'conditional',
        confidence: 'verified-headless',
      },
    );
    expect(
      relations.find((entry) => entry.from === 'pending-interaction' && entry.to === 'interaction-resolved'),
    ).toMatchObject({ kind: 'conditional', confidence: 'verified-headless' });
    expect(relations.find((entry) => entry.from === 'turn-complete' && entry.to === 'signals')).toMatchObject({
      kind: 'async',
      confidence: 'verified-headless',
    });
  });

  it('promotes captured compaction and subagent branches while keeping source-only branches unverified', () => {
    for (const id of [
      'compact-complete',
      'compact-checkpoint',
      'subagent-spawned',
      'subagent-finished',
      'permission',
    ]) {
      expect(model.behavior.nodes.find((node) => node.id === id)?.confidence, id).toBe('verified-headless');
    }
    for (const id of ['compact-start', 'subagent-progress', 'workflow-updated', 'goal-updated', 'models', 'settings']) {
      expect(model.behavior.nodes.find((node) => node.id === id)?.confidence, id).toBe('unverified');
    }
    for (const value of [
      'hook_execution',
      'hook_run_started',
      'background_tasks',
      'subagent_spawned',
      'turn_completed',
    ]) {
      expect(variant('_x.ai/session_notification', value)?.confidence, value).toBe('verified-headless');
    }
    for (const value of ['workflow_updated', 'goal_updated', 'auto_compact_started', 'diff_review']) {
      expect(variant('_x.ai/session_notification', value)?.confidence, value).toBe('unverified');
    }
    for (const value of ['login_refused', 'backend_responsive', 'session_ended']) {
      expect(variant('_x.ai/session_notification', value)?.confidence, value).toBe('unverified');
      expect(refinement('_x.ai/session_notification', value, 'unknown')?.confidence, value).toBe('unverified');
    }
  });

  it('fixes the shared 1.0.0 schema defects against the captured shapes', () => {
    const servers = event('_x.ai/mcp/servers_updated');
    expect(servers.payloadSchema?.required).toEqual(['mcpServers']);
    const response = refinement('_x.ai/session_notification', 'response_completed', 'sampled')!;
    expect(Object.keys((response.schema as Json).properties.usage.properties).sort()).toEqual([
      'cache_creation_input_tokens',
      'cache_read_input_tokens',
      'input_tokens',
      'output_tokens',
      'reasoning_tokens',
    ]);
    const publicResponse = refinement('_x.ai/session_notification', 'response_completed', 'structural')!;
    expect((publicResponse.schema as Json).required).toEqual(['sessionUpdate']);
    expect((publicResponse.schema as Json).properties.signature).toBeDefined();
    const turn = refinement('_x.ai/session_notification', 'turn_completed', 'sampled')!;
    expect((turn.schema as Json).required).not.toContain('usage');
    const aborted = xaiUpdates('turn_completed').filter(
      (frame) => frame.message.params._meta?.cancellationCategory === 'MidTurnAbort',
    );
    const rejected = xaiUpdates('turn_completed').filter(
      (frame) => frame.message.params._meta?.cancellationCategory === 'PermissionRejected',
    );
    expect(aborted.length).toBeGreaterThan(0);
    expect(aborted.every((frame) => frame.message.params.update.usage === undefined)).toBe(true);
    expect(rejected.every((frame) => typeof frame.message.params.update.usage === 'object')).toBe(true);
    const toolUpdate = event('session/update').payloadRefinements?.find(
      (entry) => entry.match?.['update.sessionUpdate'] === 'tool_call_update' && entry.fidelity === 'sampled',
    );
    expect(((toolUpdate!.schema as Json).properties.content as Json).type).toBe('array');
  });

  it('models modelUsage as a map keyed by model id, never by the census model name', () => {
    const turnUsage = (refinement('_x.ai/session_notification', 'turn_completed', 'sampled')!.schema as Json).properties
      .usage;
    const promptUsage = (event('session/prompt').resultSchema as Json).allOf[1].properties._meta.properties.usage;
    const usageFile = event('usage.json').payloadSchema as Json;
    for (const modelUsage of [
      turnUsage.properties.modelUsage,
      promptUsage.properties.modelUsage,
      usageFile.properties.session.properties.modelUsage,
      usageFile.properties.turns.items.properties.modelUsage,
    ] as Json[]) {
      expect(modelUsage.properties).toBeUndefined();
      expect(modelUsage.required).toBeUndefined();
      expect(modelUsage.additionalProperties.required).toContain('totalTokens');
    }
    const perModel = {
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
      cachedReadTokens: 0,
      cacheCreationTokens: 0,
      reasoningTokens: 0,
      modelCalls: 1,
      apiDurationMs: 1,
    };
    const otherModel = {
      sessionId: 's',
      update: {
        sessionUpdate: 'turn_completed',
        prompt_id: 'p',
        stop_reason: 'end_turn',
        elapsed_ms: 1,
        usage: { ...perModel, numTurns: 1, modelUsage: { 'grok-other': perModel } },
      },
      _meta: { agentTimestampMs: 1_767_225_600_000 },
    };
    expect(validatePayload(event('_x.ai/session_notification'), otherModel)).toEqual([]);
  });

  it('models who answers a leader-routed permission request from the approval-ownership probe', () => {
    const probe = JSON.parse(
      readFileSync(join(selected.vendorRoot, 'probes', `grok@${selected.version}`, 'viewer-approvals.json'), 'utf8'),
    ) as Json;
    const cases = Object.values(probe.probes as Record<string, { cases: Json[] }>).flatMap((entry) => entry.cases);
    // The viewer, not the deferring controller, answered every case, and the
    // leader never cancelled the controller's copy; every late answer, the
    // `cancelled` one a deferring adapter sends included, was ignored.
    expect(cases.length).toBeGreaterThanOrEqual(6);
    for (const entry of cases) {
      expect(entry).toMatchObject({ fallbackControllerAnswer: false, interactionResolved: true });
      expect(entry.controllerCancelRequests).toBe(0);
      expect(entry.permissionRuleFilesWritten).toBe(0);
      expect((entry.lateControllerAnswers as Json[]).map(({ decision }) => decision)).toContain('cancelled');
      for (const late of entry.lateControllerAnswers as Json[]) {
        expect(late).toMatchObject({ framesAfter: [], leaderLoggedUnknownResponse: true });
      }
    }
    expect(model.evidenceIndex?.claims?.find(({ id }) => id === 'grok-approval-probe')).toMatchObject({
      kind: 'runtime-capture',
      record: 'binary-probes',
    });
    const relations = model.behavior.relations;
    expect(relations.find((entry) => entry.from === 'cancel' && entry.to === 'interaction-resolved')).toMatchObject({
      kind: 'conditional',
      confidence: 'verified-headless',
    });
    expect(
      relations.find((entry) => entry.from === 'interaction-resolved' && entry.to === 'tool-permission-cancelled'),
    ).toMatchObject({ kind: 'conditional', confidence: 'verified-headless' });
    expect(event('session/request_permission').notes).toContain('first answer wins');
  });

  it('contains no detectable private capture material', () => {
    expect(checkGrokCaptureDirectory(capturesDir)).toEqual([]);
  });
});

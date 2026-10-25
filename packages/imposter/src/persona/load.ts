/**
 * Persona loading (docs/archive/IMPOSTER.md §3.2).
 *
 * Reads the persona's own documents from `personas/<vendor>/`, then resolves
 * its captured ASM out of the neutral Surface package. The ASM is NOT vendored
 * here: it is capture-derived truth and stays Surface-owned, so adapter and
 * imposter projections are measured against the same evidence.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isClaimAddressableAsmVersion,
  loadModel,
  validatePayload,
  type PayloadSchema,
} from '@vibefield/puppeteer-surface';
import {
  OP_NAMES,
  RUNFLOW_DANGERS,
  RUNFLOW_KINDS,
  type OpBinding,
  type OpChannel,
  type HttpServeDocument,
  type HttpServeRoute,
  type OpsDocument,
  type Persona,
  type PersonaDocument,
  type NativeStoreDocument,
  type RunflowDescriptor,
} from './types.ts';
import type { ServeDocument } from '../session/serve.ts';
import { scenarioSteps, type ScenarioAction, type ScenarioStep } from '../session/scenario.ts';
import { mintPersonaSessionId } from './session-id.ts';

const PERSONA_NAME = /^[a-z][a-z0-9-]{0,63}$/;

/** ASM channel kind -> the delivery mechanism the op layer addresses it by. */
const DELIVERY_KIND: Record<string, OpChannel> = {
  'hook-http': 'hook',
  'hook-command': 'hook',
  'hook-callback': 'hook',
  'webhook-http': 'hook',
  transcript: 'transcript',
  statusline: 'statusline',
  jsonrpc: 'jsonrpc',
  'jsonrpc-stdio': 'jsonrpc',
  'app-server': 'jsonrpc',
  acp: 'jsonrpc',
  http: 'http',
  sse: 'sse',
  'native-log': 'native-log',
  'native-state': 'native-state',
  'native-index': 'native-index',
};

/** `personas/` sits beside `dist/` when published and beside `src/` in-repo. */
function personasRoot(): string {
  return join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), 'personas');
}

export function personaDirectory(vendor: string): string {
  if (!PERSONA_NAME.test(vendor)) {
    throw new Error(`persona name must be lowercase letters, digits, and hyphens (got "${vendor}")`);
  }
  return join(personasRoot(), vendor);
}

/** Persona directory names, sorted. Cheap: one readdir, no JSON parsed. */
export function availablePersonas(root = personasRoot()): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && PERSONA_NAME.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Shim name → vendor, e.g. `claude` → `claude`. Built by reading each
 * persona.json, so argv0 dispatch (§6) is answered by the same declaration a
 * `ln -s` would be made from — the imposter installs nothing itself (§11.1).
 */
export function shimNameMap(root = personasRoot()): Map<string, string> {
  const map = new Map<string, string>();
  for (const vendor of availablePersonas(root)) {
    try {
      const document = parsePersonaDocument(
        join(root, vendor, 'persona.json'),
        readJson(join(root, vendor, 'persona.json')),
      );
      for (const name of document.shimNames) map.set(name, vendor);
    } catch {
      // A malformed persona must not make every other persona unreachable.
    }
  }
  return map;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`imposter: cannot read ${path}: ${(error as Error).message}`);
  }
}

function requireRecord(path: string, value: unknown, what: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`imposter: ${path} ${what} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(path: string, record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`imposter: ${path} field "${field}" must be a non-empty string`);
  }
  return value;
}

function rejectUnknownFields(path: string, record: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(record).filter((field) => !allowed.includes(field));
  if (unknown.length > 0) throw new Error(`imposter: ${path} has unknown field(s): ${unknown.join(', ')}`);
}

function stringList(path: string, value: unknown, field: string, maximum = 32): string[] {
  if (
    !Array.isArray(value) ||
    value.length > maximum ||
    value.some((entry) => typeof entry !== 'string' || entry.length === 0 || entry.length > 128)
  ) {
    throw new Error(`imposter: ${path} field "${field}" must be an array of at most ${maximum} non-empty strings`);
  }
  const values = value as string[];
  if (new Set(values).size !== values.length) {
    throw new Error(`imposter: ${path} field "${field}" must not contain duplicates`);
  }
  return values;
}

const RUNFLOW_ID = /^[a-z][a-z0-9-]{0,63}$/;
const RUNFLOW_INTENT = /^[a-z][a-z0-9.-]{0,127}$/;

function actionFromStep(step: ScenarioStep): ScenarioAction | undefined {
  if (step === null || typeof step !== 'object' || Array.isArray(step)) return undefined;
  const record = step as Record<string, unknown>;
  const action = Object.hasOwn(record, 'do') ? record.do : record;
  return action !== null && typeof action === 'object' && !Array.isArray(action)
    ? (action as ScenarioAction)
    : undefined;
}

/** Load the optional curated catalog and derive its executable facts. */
function loadRunflows(directory: string, eventChannels: ReadonlyMap<string, readonly string[]>): RunflowDescriptor[] {
  const path = join(directory, 'runflows.json');
  if (!existsSync(path)) return [];
  const document = requireRecord(path, readJson(path), 'runflow catalog');
  rejectUnknownFields(path, document, ['version', 'flows']);
  if (document.version !== 1) throw new Error(`imposter: ${path} field "version" must be 1`);
  if (!Array.isArray(document.flows) || document.flows.length > 64) {
    throw new Error(`imposter: ${path} field "flows" must be an array of at most 64 entries`);
  }

  const ids = new Set<string>();
  return document.flows.map((rawFlow, index): RunflowDescriptor => {
    const flow = requireRecord(path, rawFlow, `flow[${index}]`);
    rejectUnknownFields(path, flow, [
      'id',
      'intent',
      'scenario',
      'title',
      'summary',
      'kind',
      'danger',
      'tags',
      'defaultStimulus',
      'defaultSpeed',
    ]);
    const id = requireString(path, flow, 'id');
    if (!RUNFLOW_ID.test(id)) throw new Error(`imposter: ${path} runflow id "${id}" is invalid`);
    if (ids.has(id)) throw new Error(`imposter: ${path} declares duplicate runflow id "${id}"`);
    ids.add(id);
    const intent = requireString(path, flow, 'intent');
    if (!RUNFLOW_INTENT.test(intent)) throw new Error(`imposter: ${path} runflow intent "${intent}" is invalid`);
    const scenario = requireString(path, flow, 'scenario');
    if (!RUNFLOW_ID.test(scenario)) throw new Error(`imposter: ${path} scenario name "${scenario}" is invalid`);
    const kind = requireString(path, flow, 'kind');
    if (!(RUNFLOW_KINDS as readonly string[]).includes(kind)) {
      throw new Error(`imposter: ${path} runflow "${id}" has unsupported kind "${kind}"`);
    }
    const danger = flow.danger === undefined ? 'safe' : requireString(path, flow, 'danger');
    if (!(RUNFLOW_DANGERS as readonly string[]).includes(danger)) {
      throw new Error(`imposter: ${path} runflow "${id}" has unsupported danger "${danger}"`);
    }
    const title = requireString(path, flow, 'title');
    const summary = requireString(path, flow, 'summary');
    if (title.length > 160 || summary.length > 1000) {
      throw new Error(`imposter: ${path} runflow "${id}" title or summary is too long`);
    }
    const tags = flow.tags === undefined ? [] : stringList(path, flow.tags, 'tags', 16);
    const defaultStimulus =
      flow.defaultStimulus === undefined
        ? { text: 'triggered by adaptation devkit' }
        : requireRecord(path, flow.defaultStimulus, `runflow "${id}" defaultStimulus`);
    const defaultSpeed = flow.defaultSpeed === undefined ? 4 : flow.defaultSpeed;
    if (typeof defaultSpeed !== 'number' || !Number.isFinite(defaultSpeed) || defaultSpeed <= 0 || defaultSpeed > 100) {
      throw new Error(`imposter: ${path} runflow "${id}" defaultSpeed must be greater than 0 and at most 100`);
    }

    const scenarioPath = join(directory, 'scenarios', `${scenario}.json`);
    if (!existsSync(scenarioPath)) {
      throw new Error(`imposter: ${path} runflow "${id}" references missing scenario "${scenario}"`);
    }
    const scenarioDocument = requireRecord(scenarioPath, readJson(scenarioPath), 'scenario');
    if (scenarioDocument.name !== scenario) {
      throw new Error(`imposter: ${scenarioPath} must declare name "${scenario}"`);
    }
    const steps = scenarioSteps(scenarioDocument);
    if (steps.length === 0 || steps.length > 10_000) {
      throw new Error(`imposter: ${scenarioPath} must contain 1..10000 steps`);
    }
    const events = new Set<string>();
    const channels = new Set<string>();
    let requiresClient = false;
    for (const step of steps) {
      const emit = actionFromStep(step)?.emit;
      if (!emit || typeof emit.event !== 'string') continue;
      events.add(emit.event);
      for (const channel of eventChannels.get(emit.event) ?? []) channels.add(channel);
      if (typeof emit.channel === 'string') channels.add(emit.channel);
      if (emit.request === true) requiresClient = true;
    }

    return {
      id,
      intent,
      scenario,
      title,
      summary,
      kind: kind as RunflowDescriptor['kind'],
      danger: danger as RunflowDescriptor['danger'],
      tags,
      defaultStimulus,
      defaultSpeed,
      steps: steps.length,
      events: [...events],
      channels: [...channels],
      requiresClient,
    };
  });
}

/**
 * Surface exports only runtime APIs and its manifest, so a model is reached by
 * resolving the package manifest and joining the declared persona path.
 */
function resolveAsmDirectory(document: PersonaDocument, from: string, personaDir: string): string {
  // No package means the model is persona-local: there is no real vendor and
  // therefore no evidence for Surface to own (the synthetic test persona).
  if (!document.asm.package) return join(personaDir, document.asm.path);
  const require = createRequire(from);
  let manifest: string;
  try {
    manifest = require.resolve(`${document.asm.package}/package.json`);
  } catch {
    throw new Error(
      `imposter: persona "${document.vendor}" needs ${document.asm.package}, which is not installed. ` +
        `Real-vendor ASMs stay Surface-owned, so the Surface package must be resolvable.`,
    );
  }
  return join(dirname(manifest), document.asm.path);
}

function parsePersonaDocument(path: string, value: unknown): PersonaDocument {
  const record = requireRecord(path, value, 'persona');
  const vendor = requireString(path, record, 'vendor');
  const asm = requireRecord(path, record.asm, 'field "asm"');
  const shimNames = record.shimNames;
  if (
    !Array.isArray(shimNames) ||
    shimNames.length === 0 ||
    shimNames.some((name) => typeof name !== 'string' || name.length === 0)
  ) {
    throw new Error(`imposter: ${path} field "shimNames" must be a non-empty array of strings`);
  }
  const boot = record.boot;
  if (!Array.isArray(boot)) throw new Error(`imposter: ${path} field "boot" must be an array`);
  for (const [index, entry] of boot.entries()) {
    const invocation = requireRecord(path, entry, `boot[${index}]`);
    requireString(path, invocation, 'op');
  }
  const envelope = requireRecord(path, record.envelope, 'field "envelope"');
  if (record.eventNameField !== undefined) requireString(path, record, 'eventNameField');
  if (record.jsonrpcEventMethod !== undefined) requireString(path, record, 'jsonrpcEventMethod');
  if (record.sessionIdTemplate !== undefined) requireString(path, record, 'sessionIdTemplate');
  // Every field is copied out by name rather than spread, so a persona cannot
  // smuggle in a key this loader has never validated. The cost is that adding
  // one to the type is not enough — `bindings` was silently dropped until it
  // was named here too (2026-08-09).
  const personaBindings =
    record.bindings === undefined ? undefined : requireRecord(path, record.bindings, '"bindings"');
  for (const name of Object.keys(personaBindings ?? {})) {
    if (!name.startsWith('$')) {
      throw new Error(`imposter: ${path} binding "${name}" must start with $, or nothing will ever substitute it`);
    }
  }
  const nativeStoreRecord =
    record.nativeStore === undefined ? undefined : requireRecord(path, record.nativeStore, '"nativeStore"');
  let nativeStore: PersonaDocument['nativeStore'];
  if (nativeStoreRecord) {
    const sessionPath = nativeStoreRecord.sessionPath;
    if (
      !Array.isArray(sessionPath) ||
      sessionPath.length === 0 ||
      sessionPath.some((component) => typeof component !== 'string' || component.length === 0)
    ) {
      throw new Error(`imposter: ${path} nativeStore.sessionPath must be a non-empty array of strings`);
    }
    const updatesFile =
      nativeStoreRecord.updatesFile === undefined ? undefined : requireString(path, nativeStoreRecord, 'updatesFile');
    const updatesPath = nativeStoreRecord.updatesPath;
    if ((updatesFile === undefined) === (updatesPath === undefined)) {
      throw new Error(`imposter: ${path} nativeStore must declare exactly one of updatesFile or updatesPath`);
    }
    if (
      updatesFile &&
      (updatesFile.includes('/') || updatesFile.includes('\\') || updatesFile === '.' || updatesFile === '..')
    ) {
      throw new Error(`imposter: ${path} nativeStore.updatesFile must be a filename`);
    }
    if (
      updatesPath !== undefined &&
      (!Array.isArray(updatesPath) ||
        updatesPath.length === 0 ||
        updatesPath.length > 16 ||
        updatesPath.some((component) => typeof component !== 'string' || component.length === 0))
    ) {
      throw new Error(`imposter: ${path} nativeStore.updatesPath must be an array of 1..16 non-empty strings`);
    }
    const indexPath = nativeStoreRecord.indexPath;
    if (
      indexPath !== undefined &&
      (!Array.isArray(indexPath) ||
        indexPath.length === 0 ||
        indexPath.length > 16 ||
        indexPath.some((component) => typeof component !== 'string' || component.length === 0))
    ) {
      throw new Error(`imposter: ${path} nativeStore.indexPath must be an array of 1..16 non-empty strings`);
    }
    const recordFormat = nativeStoreRecord.recordFormat;
    if (recordFormat !== undefined && !['method-params', 'flat-record'].includes(String(recordFormat))) {
      throw new Error(`imposter: ${path} nativeStore.recordFormat must be method-params or flat-record`);
    }
    const fieldName = (value: unknown, label: string): string => {
      if (typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)) {
        throw new Error(`imposter: ${path} nativeStore.${label} must be a safe field name`);
      }
      return value;
    };
    const stringArray = (value: unknown, label: string): string[] | undefined => {
      if (value === undefined) return undefined;
      if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
        throw new Error(`imposter: ${path} nativeStore.${label} must be an array of non-empty strings`);
      }
      return value as string[];
    };
    const recordTypeField =
      nativeStoreRecord.recordTypeField === undefined
        ? undefined
        : fieldName(nativeStoreRecord.recordTypeField, 'recordTypeField');
    const recordPayloadField =
      nativeStoreRecord.recordPayloadField === undefined
        ? undefined
        : fieldName(nativeStoreRecord.recordPayloadField, 'recordPayloadField');
    const timestampRecord =
      nativeStoreRecord.recordTimestamp === undefined
        ? undefined
        : requireRecord(path, nativeStoreRecord.recordTimestamp, 'nativeStore.recordTimestamp');
    let recordTimestamp: NonNullable<NativeStoreDocument['recordTimestamp']> | undefined;
    if (timestampRecord) {
      const format = requireString(path, timestampRecord, 'format');
      if (!['epoch-ms', 'epoch-seconds', 'iso'].includes(format)) {
        throw new Error(`imposter: ${path} nativeStore.recordTimestamp.format must be epoch-ms, epoch-seconds, or iso`);
      }
      const omitFor = stringArray(timestampRecord.omitFor, 'recordTimestamp.omitFor');
      recordTimestamp = {
        field: fieldName(timestampRecord.field, 'recordTimestamp.field'),
        format: format as 'epoch-ms' | 'epoch-seconds' | 'iso',
        ...(omitFor === undefined ? {} : { omitFor }),
      };
      // The method-params envelope has exactly one clock: its numeric `timestamp`.
      if (
        recordFormat !== 'flat-record' &&
        (recordTimestamp.field !== 'timestamp' || recordTimestamp.format === 'iso' || omitFor !== undefined)
      ) {
        throw new Error(
          `imposter: ${path} nativeStore.recordTimestamp on the method-params envelope must be a numeric "timestamp"`,
        );
      }
    }
    const eventIdRecord =
      nativeStoreRecord.recordEventId === undefined
        ? undefined
        : requireRecord(path, nativeStoreRecord.recordEventId, 'nativeStore.recordEventId');
    if (eventIdRecord && recordFormat === 'flat-record') {
      throw new Error(`imposter: ${path} nativeStore.recordEventId applies only to the method-params envelope`);
    }
    const recordEventId = eventIdRecord
      ? { metaField: fieldName(eventIdRecord.metaField, 'recordEventId.metaField') }
      : undefined;
    const replayMeta =
      nativeStoreRecord.replayMeta === undefined
        ? undefined
        : requireRecord(path, nativeStoreRecord.replayMeta, 'nativeStore.replayMeta');
    const sequenceRecord =
      nativeStoreRecord.recordSequence === undefined
        ? undefined
        : requireRecord(path, nativeStoreRecord.recordSequence, 'nativeStore.recordSequence');
    let recordSequence: NonNullable<NativeStoreDocument['recordSequence']> | undefined;
    if (sequenceRecord) {
      if (
        sequenceRecord.start !== undefined &&
        (!Number.isInteger(sequenceRecord.start) || (sequenceRecord.start as number) < 0)
      ) {
        throw new Error(`imposter: ${path} nativeStore.recordSequence.start must be a non-negative integer`);
      }
      recordSequence = {
        field: fieldName(sequenceRecord.field, 'recordSequence.field'),
        ...(sequenceRecord.start === undefined ? {} : { start: sequenceRecord.start as number }),
      };
    }
    const identityRecord =
      nativeStoreRecord.recordIdentity === undefined
        ? undefined
        : requireRecord(path, nativeStoreRecord.recordIdentity, 'nativeStore.recordIdentity');
    let recordIdentity: NonNullable<NativeStoreDocument['recordIdentity']> | undefined;
    if (identityRecord) {
      const omitParentFor = stringArray(identityRecord.omitParentFor, 'recordIdentity.omitParentFor');
      recordIdentity = {
        idField: fieldName(identityRecord.idField, 'recordIdentity.idField'),
        ...(identityRecord.parentField === undefined
          ? {}
          : { parentField: fieldName(identityRecord.parentField, 'recordIdentity.parentField') }),
        ...(omitParentFor === undefined ? {} : { omitParentFor }),
      };
    }
    const singletonEvents = stringArray(nativeStoreRecord.singletonEvents, 'singletonEvents');
    if (nativeStoreRecord.mirrorJsonRpc !== undefined && typeof nativeStoreRecord.mirrorJsonRpc !== 'boolean') {
      throw new Error(`imposter: ${path} nativeStore.mirrorJsonRpc must be a boolean`);
    }
    nativeStore = {
      ...(nativeStoreRecord.rootEnv === undefined
        ? {}
        : { rootEnv: requireString(path, nativeStoreRecord, 'rootEnv') }),
      sessionPath: sessionPath as string[],
      ...(updatesFile === undefined ? {} : { updatesFile }),
      ...(updatesPath === undefined ? {} : { updatesPath: updatesPath as string[] }),
      ...(indexPath === undefined ? {} : { indexPath: indexPath as string[] }),
      ...(recordFormat === undefined
        ? {}
        : { recordFormat: recordFormat as NonNullable<PersonaDocument['nativeStore']>['recordFormat'] }),
      ...(recordTypeField === undefined ? {} : { recordTypeField }),
      ...(recordPayloadField === undefined ? {} : { recordPayloadField }),
      ...(recordTimestamp === undefined ? {} : { recordTimestamp }),
      ...(recordEventId === undefined ? {} : { recordEventId }),
      ...(replayMeta === undefined ? {} : { replayMeta }),
      ...(recordSequence === undefined ? {} : { recordSequence }),
      ...(recordIdentity === undefined ? {} : { recordIdentity }),
      ...(singletonEvents === undefined ? {} : { singletonEvents }),
      ...(nativeStoreRecord.mirrorJsonRpc === undefined
        ? {}
        : { mirrorJsonRpc: nativeStoreRecord.mirrorJsonRpc as boolean }),
    };
  }
  return {
    vendor,
    asm: {
      ...(asm.package === undefined ? {} : { package: requireString(path, asm, 'package') }),
      path: requireString(path, asm, 'path'),
    },
    shimNames: shimNames as string[],
    envelope,
    ...(record.eventNameField === undefined ? {} : { eventNameField: record.eventNameField as string }),
    ...(record.jsonrpcEventMethod === undefined ? {} : { jsonrpcEventMethod: record.jsonrpcEventMethod as string }),
    ...(record.sessionIdTemplate === undefined ? {} : { sessionIdTemplate: record.sessionIdTemplate as string }),
    ...(personaBindings === undefined ? {} : { bindings: personaBindings }),
    ...(nativeStore === undefined ? {} : { nativeStore }),
    boot: boot as PersonaDocument['boot'],
  };
}

function parseOpsDocument(
  path: string,
  value: unknown,
  eventChannels: ReadonlyMap<string, readonly string[]>,
  channelByKind: ReadonlyMap<OpChannel, string>,
): OpsDocument {
  const record = requireRecord(path, value, 'ops');
  const ops: OpsDocument = {};
  for (const [op, rawBindings] of Object.entries(record)) {
    if (!(OP_NAMES as readonly string[]).includes(op)) {
      throw new Error(`imposter: ${path} declares unknown op "${op}" (known: ${OP_NAMES.join(', ')})`);
    }
    if (!Array.isArray(rawBindings) || rawBindings.length === 0) {
      throw new Error(`imposter: ${path} op "${op}" must be a non-empty array of bindings`);
    }
    ops[op] = rawBindings.map((rawBinding, index): OpBinding => {
      const binding = requireRecord(path, rawBinding, `op "${op}" binding ${index}`);
      const channel = requireString(path, binding, 'channel');
      if (
        !['hook', 'transcript', 'statusline', 'jsonrpc', 'sse', 'native-log', 'native-state', 'native-index'].includes(
          channel,
        )
      ) {
        throw new Error(`imposter: ${path} op "${op}" has unsupported channel "${channel}"`);
      }
      if (binding.event !== undefined && (typeof binding.event !== 'string' || binding.event.length === 0)) {
        throw new Error(`imposter: ${path} op "${op}" field "event" must be a non-empty string`);
      }
      if (binding.with !== undefined) requireRecord(path, binding.with, `op "${op}" field "with"`);
      if (binding.await !== undefined && typeof binding.await !== 'boolean') {
        throw new Error(`imposter: ${path} op "${op}" field "await" must be a boolean`);
      }
      if (binding.await === true && channel !== 'jsonrpc' && channel !== 'sse') {
        throw new Error(`imposter: ${path} op "${op}" sets "await" on the ${channel} channel, which cannot reply`);
      }
      // An op bound to a hook event the ASM has never seen would emit an
      // unmodeled payload, which is exactly what §7.3 item 3 forbids.
      if (
        (channel === 'hook' ||
          channel === 'jsonrpc' ||
          channel === 'sse' ||
          channel === 'native-log' ||
          channel === 'native-state' ||
          channel === 'native-index') &&
        typeof binding.event === 'string' &&
        !eventChannels.has(binding.event)
      ) {
        throw new Error(
          `imposter: ${path} op "${op}" binds ${channel} event "${binding.event}", which is not in the ASM`,
        );
      }
      if (typeof binding.event === 'string' && eventChannels.has(binding.event)) {
        const nativeChannel = channelByKind.get(channel as OpChannel);
        if (nativeChannel === undefined) {
          throw new Error(`imposter: ${path} op "${op}" uses ${channel}, but the ASM declares no such channel kind`);
        }
        if (!eventChannels.get(binding.event)!.includes(nativeChannel)) {
          throw new Error(
            `imposter: ${path} op "${op}" binds ${binding.event} to ${nativeChannel}, ` +
              `but the ASM declares it on ${eventChannels.get(binding.event)!.join(', ')}`,
          );
        }
      }
      if (binding.await !== undefined && typeof binding.await !== 'boolean') {
        throw new Error(`imposter: ${path} op "${op}" field "await" must be a boolean`);
      }
      return {
        channel: channel as OpBinding['channel'],
        ...(binding.await === undefined ? {} : { await: binding.await as boolean }),
        ...(binding.event === undefined ? {} : { event: binding.event as string }),
        ...(binding.with === undefined ? {} : { with: binding.with as Record<string, unknown> }),
      };
    });
  }
  return ops;
}

const HTTP_ACTIONS = new Set<HttpServeRoute['action']>([
  'event.subscribe',
  'session.create',
  'session.list',
  'session.get',
  'session.messages',
  'session.status',
  'session.prompt',
  'session.abort',
  'session.children',
  'session.diff',
  'session.delete',
  'session.update',
  'session.fork',
  'permission.list',
  'permission.reply',
  'question.list',
  'question.reply',
  'question.reject',
  'vcs.diff',
]);

function parseHttpServeDocument(path: string, value: unknown): HttpServeDocument {
  const document = requireRecord(path, value, 'HTTP serve document');
  rejectUnknownFields(path, document, ['$server', 'routes']);
  const server = requireRecord(path, document.$server, 'field "$server"');
  rejectUnknownFields(path, server, [
    'command',
    'hostnameFlag',
    'portFlag',
    'defaultHostname',
    'defaultPort',
    'directoryQuery',
    'directoryHeader',
    'auth',
    'attach',
  ]);
  const auth = requireRecord(path, server.auth, '$server.auth');
  rejectUnknownFields(path, auth, ['usernameEnv', 'passwordEnv', 'defaultUsername']);
  const attach = requireRecord(path, server.attach, '$server.attach');
  rejectUnknownFields(path, attach, ['command', 'sessionFlag', 'directoryFlag']);
  if (
    !Number.isInteger(server.defaultPort) ||
    (server.defaultPort as number) < 0 ||
    (server.defaultPort as number) > 65535
  ) {
    throw new Error(`imposter: ${path} $server.defaultPort must be an integer from 0 to 65535`);
  }
  if (!Array.isArray(document.routes) || document.routes.length === 0 || document.routes.length > 256) {
    throw new Error(`imposter: ${path} field "routes" must be an array of 1..256 routes`);
  }
  const signatures = new Set<string>();
  const routes = document.routes.map((rawRoute, index): HttpServeRoute => {
    const route = requireRecord(path, rawRoute, `routes[${index}]`);
    rejectUnknownFields(path, route, ['event', 'method', 'path', 'action']);
    const method = requireString(path, route, 'method').toUpperCase();
    const routePath = requireString(path, route, 'path');
    const action = requireString(path, route, 'action') as HttpServeRoute['action'];
    if (!/^[A-Z]+$/.test(method)) throw new Error(`imposter: ${path} route method "${method}" is invalid`);
    if (!routePath.startsWith('/')) throw new Error(`imposter: ${path} route path "${routePath}" must start with /`);
    if (!HTTP_ACTIONS.has(action)) throw new Error(`imposter: ${path} route action "${action}" is unsupported`);
    const signature = `${method} ${routePath}`;
    if (signatures.has(signature)) throw new Error(`imposter: ${path} declares duplicate route ${signature}`);
    signatures.add(signature);
    return { event: requireString(path, route, 'event'), method, path: routePath, action };
  });
  return {
    $server: {
      command: requireString(path, server, 'command'),
      hostnameFlag: requireString(path, server, 'hostnameFlag'),
      portFlag: requireString(path, server, 'portFlag'),
      defaultHostname: requireString(path, server, 'defaultHostname'),
      defaultPort: server.defaultPort as number,
      directoryQuery: requireString(path, server, 'directoryQuery'),
      directoryHeader: requireString(path, server, 'directoryHeader').toLowerCase(),
      auth: {
        usernameEnv: requireString(path, auth, 'usernameEnv'),
        passwordEnv: requireString(path, auth, 'passwordEnv'),
        defaultUsername: requireString(path, auth, 'defaultUsername'),
      },
      attach: {
        command: requireString(path, attach, 'command'),
        sessionFlag: requireString(path, attach, 'sessionFlag'),
        directoryFlag: requireString(path, attach, 'directoryFlag'),
      },
    },
    routes,
  };
}

export interface LoadPersonaOptions {
  /** Resolution base for the adapter package; defaults to this module. */
  resolveFrom?: string;
  /** Override the persona directory (tests, alternative persona sets). */
  directory?: string;
}

export function loadPersona(vendor: string, options: LoadPersonaOptions = {}): Persona {
  const directory = options.directory ?? personaDirectory(vendor);
  const personaPath = join(directory, 'persona.json');
  const document = parsePersonaDocument(personaPath, readJson(personaPath));
  if (document.vendor !== vendor) {
    throw new Error(`imposter: ${personaPath} declares vendor "${document.vendor}" but lives in "${vendor}"`);
  }

  const model = loadModel(resolveAsmDirectory(document, options.resolveFrom ?? import.meta.url, directory));
  const events = new Map(model.events.map((event) => [event.event, event]));
  const schemas = new Map<string, PayloadSchema | undefined>(
    model.events.map((event) => [event.event, event.payloadSchema]),
  );
  const resultSchemas = new Map<string, PayloadSchema | undefined>(
    model.events.map((event) => [event.event, event.resultSchema]),
  );
  const recordSchemas = new Map<string, PayloadSchema | undefined>(
    model.events.map((event) => [event.event, event.recordSchema]),
  );
  const recordChannels = new Map(model.events.map((event) => [event.event, event.recordChannel]));

  const eventChannels = new Map(model.events.map((event) => [event.event, event.channels]));

  // The ASM records what each channel *is*; the op layer addresses channels by
  // what they *do*. First declaration of a kind wins, which is why the ASM
  // lists a channel's primary transport in `kind` and its fallback separately.
  const channelByKind = new Map<OpChannel, string>();
  for (const [name, channel] of Object.entries(model.channels.channels)) {
    const kind = DELIVERY_KIND[(channel as { kind?: string }).kind ?? ''];
    if (kind && !channelByKind.has(kind)) channelByKind.set(kind, name);
  }

  // serve.json is optional: only the JSON-RPC family serves anything.
  const servePath = join(directory, 'serve.json');
  const serve = existsSync(servePath)
    ? (requireRecord(servePath, readJson(servePath), 'serve document') as ServeDocument)
    : undefined;
  const httpServePath = join(directory, 'http-serve.json');
  const httpServe = existsSync(httpServePath)
    ? parseHttpServeDocument(httpServePath, readJson(httpServePath))
    : undefined;
  if (serve && httpServe) {
    throw new Error(`imposter: ${directory} cannot declare both serve.json and http-serve.json`);
  }
  if (serve && isClaimAddressableAsmVersion(model.manifest.asmVersion)) {
    for (const [method, rawEntry] of Object.entries(serve)) {
      if (method === '$server') continue;
      requireRecord(servePath, rawEntry, `method "${method}"`);
      const event = events.get(method);
      if (!event) throw new Error(`imposter: ${servePath} serves ${method}, but that method is not in the ASM`);
      if (event.direction !== 'client-to-agent' || event.transport !== 'jsonrpc-request') {
        throw new Error(
          `imposter: ${servePath} serves ${method}, but the ASM does not declare it as a client-to-agent JSON-RPC request`,
        );
      }
      if (!event.resultSchema) {
        throw new Error(`imposter: ${servePath} serves ${method}, but the ASM has no result schema for it`);
      }
    }
  }
  if (httpServe && isClaimAddressableAsmVersion(model.manifest.asmVersion)) {
    for (const route of httpServe.routes) {
      const event = events.get(route.event);
      if (!event) throw new Error(`imposter: ${httpServePath} serves ${route.event}, but it is not in the ASM`);
      if (event.direction !== 'client-to-agent' || event.transport !== 'http') {
        throw new Error(
          `imposter: ${httpServePath} serves ${route.event}, but the ASM does not declare it as client-to-agent HTTP`,
        );
      }
      if (!event.resultSchema) {
        throw new Error(`imposter: ${httpServePath} serves ${route.event}, but the ASM has no result schema for it`);
      }
      const method = event.resultSchema.properties?.method?.enum;
      const path = event.resultSchema.properties?.route?.enum;
      if (method && !method.includes(route.method)) {
        throw new Error(
          `imposter: ${httpServePath} declares ${route.method} for ${route.event}, but the ASM declares ${method.join(', ')}`,
        );
      }
      if (path && !path.includes(route.path)) {
        throw new Error(
          `imposter: ${httpServePath} declares ${route.path} for ${route.event}, but the ASM declares ${path.join(', ')}`,
        );
      }
    }
  }

  const opsPath = join(directory, 'ops.json');
  const ops = parseOpsDocument(opsPath, readJson(opsPath), eventChannels, channelByKind);
  const runflows = loadRunflows(directory, eventChannels);

  const flagTable: Record<string, unknown> = {
    ...(model.detection.launchFlags && typeof model.detection.launchFlags === 'object'
      ? (model.detection.launchFlags as Record<string, unknown>)
      : {}),
    ...(model.detection.probedFlags && typeof model.detection.probedFlags === 'object'
      ? (model.detection.probedFlags as Record<string, unknown>)
      : {}),
  };

  return {
    vendor,
    ...(serve === undefined ? {} : { serve }),
    ...(httpServe === undefined ? {} : { httpServe }),
    version: model.manifest.vendorVersion,
    document,
    model,
    ops,
    runflows,
    channels: Object.keys(model.channels.channels),
    channelFor: (kind) => channelByKind.get(kind),
    schemaFor: (event) => schemas.get(event),
    resultSchemaFor: (event) => resultSchemas.get(event),
    recordSchemaFor: (event) => recordSchemas.get(event),
    validate(event, payload) {
      const schema = schemas.get(event);
      return schema ? validatePayload(schema, payload) : [];
    },
    validateResult(event, result) {
      const schema = resultSchemas.get(event);
      return schema ? validatePayload(schema, result) : [];
    },
    validateRecord(event, record, channel) {
      const schema = recordSchemas.get(event);
      const scopedChannel = recordChannels.get(event);
      if (scopedChannel !== undefined && channel !== scopedChannel) return [];
      return schema ? validatePayload(schema, record) : [];
    },
    flagsFor(key, fallback) {
      const raw = flagTable[key];
      return (typeof raw === 'string' ? raw : fallback)
        .split(',')
        .map((flag) => flag.trim())
        .filter(Boolean);
    },
  };
}

/** Resolve and apply the persona-owned native session identity convention. */
export function createPersonaSessionId(vendor: string, options: LoadPersonaOptions = {}): string {
  return mintPersonaSessionId(loadPersona(vendor, options));
}

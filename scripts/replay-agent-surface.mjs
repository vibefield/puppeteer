#!/usr/bin/env node
/** Exact, pre-normalization replay of sanitized native captures through an Imposter persona contract. */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadModel, validatePayload } from '@vibecook/puppeteer-surface';
import { loadPersona } from '../packages/imposter/src/persona/load.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function json(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function filesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? filesUnder(path) : entry.name.endsWith('.jsonl') ? [path] : [];
    })
    .sort();
}

function kimiReplayFiles(captureDirectory) {
  const files = new Map();
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name === 'wire.jsonl') files.set(path, new Set());
      else if (entry.name === 'session-index.jsonl') files.set(path, new Set(['session_index.entry']));
      else if (entry.name === 'state.json') files.set(path, new Set(['state.json']));
      else if (basename(directory) === 'hooks' && entry.name.endsWith('.jsonl')) files.set(path, new Set());
    }
  };
  visit(captureDirectory);
  return files;
}

/**
 * OpenCode's census retains provider fixtures and REST snapshots beside the
 * native app-server transcript. Exact surface replay intentionally selects
 * only the SSE carriers and correlated HTTP request/result carriers; the
 * vendor audit covers the other retained census artifacts.
 */
function hermesReplayFiles(captureDirectory) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      if (entry.isFile() && (entry.name === 'rpc.jsonl' || entry.name === 'plugin-hooks.jsonl')) files.push(path);
    }
  };
  visit(captureDirectory);
  return files.sort();
}

function opencodeReplayFiles(captureDirectory) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      if (
        entry.isFile() &&
        (entry.name === 'http-roundtrip.jsonl' || /^events(?:-[a-z-]+)?\.jsonl$/.test(entry.name))
      ) {
        files.push(path);
      }
    }
  };
  visit(captureDirectory);
  return files.sort();
}

function valueAt(value, dottedPath) {
  return dottedPath
    .split('.')
    .reduce(
      (current, component) => (current !== null && typeof current === 'object' ? current[component] : undefined),
      value,
    );
}

function matchesVariant(payload, variant) {
  return Object.entries(variant.match).every(([field, expected]) => Object.is(valueAt(payload, field), expected));
}

function inferredChannel(event, carrier) {
  if (event.recordChannel && Object.hasOwn(carrier, 'timestamp')) return event.recordChannel;
  return event.channel;
}

function routeKey(value) {
  return `${value?.method} ${value?.route}`;
}

function httpEventsByRoute(events) {
  const routes = new Map();
  for (const event of events.values()) {
    if (event.transport !== 'http') continue;
    const request = event.recordSchema?.properties?.request;
    const method = request?.properties?.method?.enum?.[0];
    const route = request?.properties?.route?.enum?.[0];
    if (typeof method === 'string' && typeof route === 'string') routes.set(`${method} ${route}`, event);
  }
  return routes;
}

function httpCorrelation(value) {
  return `${routeKey(value)} ${JSON.stringify(value?.params ?? {})}`;
}

function manifestForVendor(repoRoot, vendor) {
  const ledger = json(join(repoRoot, 'support', 'agents.json'));
  const agent = ledger.agents.find((entry) => entry.id === vendor);
  const path = agent?.candidateManifest ?? agent?.currentManifest;
  if (!path) throw new Error(`support ledger has no model manifest for ${vendor}`);
  return path;
}

function normalizePath(repoRoot, path) {
  const absolute = resolve(repoRoot, path);
  if (absolute !== resolve(repoRoot) && !absolute.startsWith(`${resolve(repoRoot)}${sep}`)) {
    throw new Error(`${path} is outside the repository`);
  }
  return absolute;
}

/**
 * Replays fixture bytes without translating them to AgentEvent. The model and
 * the actual Imposter persona validate the payload, result, and complete
 * carrier independently; the raw JSON line is then emitted byte-for-byte.
 */
export function replayAgentSurface({
  repoRoot = root,
  vendor,
  manifestPath = manifestForVendor(repoRoot, vendor),
  capturesDir,
} = {}) {
  if (!vendor) throw new Error('vendor is required');
  const manifestAbsolute = normalizePath(repoRoot, manifestPath);
  const model = loadModel(dirname(manifestAbsolute));
  if (model.manifest.vendor !== vendor) throw new Error(`${manifestPath} is a ${model.manifest.vendor} model`);
  const captureAbsolute = capturesDir
    ? normalizePath(repoRoot, capturesDir)
    : join(repoRoot, 'packages', 'surface', 'vendors', vendor, 'captures', `${vendor}@${model.manifest.vendorVersion}`);
  if (!existsSync(captureAbsolute) || !statSync(captureAbsolute).isDirectory()) {
    throw new Error(`capture directory does not exist: ${relative(repoRoot, captureAbsolute)}`);
  }

  const persona = loadPersona(vendor);
  if (
    persona.model.manifest.vendorVersion !== model.manifest.vendorVersion ||
    persona.model.manifest.asmVersion !== model.manifest.asmVersion
  ) {
    throw new Error(`Imposter persona ${vendor} does not target ${vendor}@${model.manifest.vendorVersion}`);
  }
  const events = new Map(model.events.map((event) => [event.event, event]));
  const httpEvents = httpEventsByRoute(events);
  const kimiFixtures = vendor === 'kimi' ? kimiReplayFiles(captureAbsolute) : undefined;
  const captureFiles = kimiFixtures
    ? [...kimiFixtures.keys()].sort()
    : vendor === 'opencode'
      ? opencodeReplayFiles(captureAbsolute)
      : vendor === 'hermes'
        ? hermesReplayFiles(captureAbsolute)
        : filesUnder(captureAbsolute);
  const issues = [];
  const digest = createHash('sha256');
  let frames = 0;
  let results = 0;
  let unattributedResults = 0;

  for (const file of captureFiles) {
    const pending = new Map();
    const pendingHttp = new Map();
    const document = file.endsWith('.jsonl') ? undefined : readFileSync(file, 'utf8').trim();
    const lines = document === undefined ? readFileSync(file, 'utf8').split('\n') : [document];
    for (const [index, source] of lines.entries()) {
      if (!source.trim()) continue;
      const location = `${relative(captureAbsolute, file).split(sep).join('/')}:${index + 1}`;
      let outer;
      try {
        outer = JSON.parse(source);
      } catch (error) {
        issues.push({ kind: 'invalid-json', location, message: error.message });
        continue;
      }
      if (document === undefined && source.trim() !== JSON.stringify(outer)) {
        issues.push({ kind: 'non-exact-jsonl', location, message: 'line is not canonical replay bytes' });
      }

      if (basename(file) === 'http-roundtrip.jsonl' && (outer?.request || outer?.response)) {
        if (outer.request) {
          const event = httpEvents.get(routeKey(outer.request));
          if (!event) {
            issues.push({
              kind: 'observed-unmodeled',
              location,
              event: routeKey(outer.request),
              message: 'capture has no HTTP event model',
            });
            continue;
          }
          if (outer.direction !== event.direction) {
            issues.push({
              kind: 'direction-mismatch',
              location,
              event: event.event,
              message: `captured ${String(outer.direction)}, model declares ${String(event.direction)}`,
            });
          }
          for (const message of persona.validate(event.event, outer.request)) {
            issues.push({ kind: 'payload-mismatch', location, event: event.event, message });
          }
          for (const message of persona.validateRecord(event.event, outer, event.channel)) {
            issues.push({ kind: 'carrier-mismatch', location, event: event.event, message });
          }
          for (const variant of event.variants ?? []) {
            if (matchesVariant(outer.request, variant) && variant.confidence === 'unverified') {
              issues.push({
                kind: 'observed-unverified-variant',
                location,
                event: event.event,
                message: `captured variant ${JSON.stringify(variant.match)} is still marked unverified`,
              });
            }
          }
          const correlation = httpCorrelation(outer.request);
          const queued = pendingHttp.get(correlation) ?? [];
          queued.push(event.event);
          pendingHttp.set(correlation, queued);
          frames += 1;
          digest.update(`${location}\0${source.trim()}\0`);
          continue;
        }

        const event = httpEvents.get(routeKey(outer.response));
        if (!event) {
          issues.push({
            kind: 'observed-unmodeled',
            location,
            event: routeKey(outer.response),
            message: 'capture has no HTTP event model',
          });
          continue;
        }
        if (outer.direction !== 'agent-to-client') {
          issues.push({
            kind: 'direction-mismatch',
            location,
            event: event.event,
            message: `captured ${String(outer.direction)}, HTTP result declares agent-to-client`,
          });
        }
        const correlation = httpCorrelation(outer.response);
        const queued = pendingHttp.get(correlation) ?? [];
        const requestEvent = queued.shift();
        if (requestEvent === undefined) {
          unattributedResults += 1;
          issues.push({
            kind: 'unattributed-result',
            location,
            event: event.event,
            message: `HTTP result ${correlation} has no preceding request in this capture`,
          });
        } else if (requestEvent !== event.event) {
          issues.push({
            kind: 'result-mismatch',
            location,
            event: event.event,
            message: `HTTP result is correlated to ${requestEvent}`,
          });
        }
        for (const message of persona.validateResult(event.event, outer.response)) {
          issues.push({ kind: 'result-mismatch', location, event: event.event, message });
        }
        results += 1;
        digest.update(`${location}\0${source.trim()}\0`);
        continue;
      }

      const wrapped =
        (outer?.direction === 'agent-to-client' || outer?.direction === 'client-to-agent') &&
        outer?.message !== null &&
        typeof outer?.message === 'object';
      const direction = wrapped ? outer.direction : undefined;
      const carrier = wrapped ? outer.message : outer;
      if (carrier === null || typeof carrier !== 'object' || Array.isArray(carrier)) {
        issues.push({ kind: 'invalid-carrier', location, message: 'native frame is not an object' });
        continue;
      }

      if (typeof carrier.method !== 'string') {
        if (carrier.id !== undefined && (carrier.result !== undefined || carrier.error !== undefined)) {
          const requestDirection =
            direction === 'agent-to-client'
              ? 'client-to-agent'
              : direction === 'client-to-agent'
                ? 'agent-to-client'
                : undefined;
          const method = requestDirection && pending.get(`${requestDirection}:${String(carrier.id)}`);
          if (!method) {
            unattributedResults += 1;
            // Historical output-only fixtures predate directional capture and
            // cannot be correlated. They still participate in the exact-byte
            // digest. A directional protocol capture has no such ambiguity:
            // an orphan result means the capture is incomplete or reordered.
            if (wrapped) {
              issues.push({
                kind: 'unattributed-result',
                location,
                message: `directional result ${String(carrier.id)} has no preceding request in this capture`,
              });
            }
            digest.update(`${location}\0${source.trim()}\0`);
            continue;
          }
          if (carrier.result !== undefined) {
            const violations = persona.validateResult(method, carrier.result);
            for (const message of violations)
              issues.push({ kind: 'result-mismatch', location, event: method, message });
          }
          results += 1;
          digest.update(`${location}\0${source.trim()}\0`);
          continue;
        }

        const fallback = basename(file, file.endsWith('.jsonl') ? '.jsonl' : '.json');
        const fixtureEvents = kimiFixtures?.get(file);
        const fixtureEvent = fixtureEvents?.size === 1 ? fixtureEvents.values().next().value : undefined;
        const eventName =
          typeof carrier.hook_event_name === 'string'
            ? carrier.hook_event_name
            : typeof carrier.type === 'string' && events.has(carrier.type)
              ? carrier.type
              : (fixtureEvent ?? fallback);
        const event = events.get(eventName);
        if (!event) {
          issues.push({
            kind: 'observed-unmodeled',
            location,
            event: eventName,
            message: 'capture has no event model',
          });
          continue;
        }
        const payload =
          carrier.type === eventName
            ? event.transport === 'sse-event' &&
              carrier.properties !== null &&
              typeof carrier.properties === 'object' &&
              !Array.isArray(carrier.properties)
              ? carrier.properties
              : Object.fromEntries(Object.entries(carrier).filter(([field]) => field !== 'type' && field !== 'time'))
            : carrier;
        for (const message of persona.validate(eventName, payload)) {
          issues.push({ kind: 'payload-mismatch', location, event: eventName, message });
        }
        const channel = inferredChannel(event, carrier);
        for (const message of persona.validateRecord(eventName, carrier, channel)) {
          issues.push({ kind: 'carrier-mismatch', location, event: eventName, message });
        }
        for (const variant of event.variants ?? []) {
          if (matchesVariant(payload, variant) && variant.confidence === 'unverified') {
            issues.push({
              kind: 'observed-unverified-variant',
              location,
              event: eventName,
              message: `captured variant ${JSON.stringify(variant.match)} is still marked unverified`,
            });
          }
        }
        frames += 1;
        digest.update(`${location}\0${source.trim()}\0`);
        continue;
      }

      const envelopeMethod = persona.document.jsonrpcEventMethod;
      const envelopeParams =
        envelopeMethod &&
        carrier.method === envelopeMethod &&
        carrier.params !== null &&
        typeof carrier.params === 'object' &&
        !Array.isArray(carrier.params)
          ? carrier.params
          : undefined;
      const eventName =
        envelopeParams && typeof envelopeParams.type === 'string' ? envelopeParams.type : carrier.method;
      const event = events.get(eventName);
      if (!event) {
        issues.push({
          kind: 'observed-unmodeled',
          location,
          event: eventName,
          message: 'capture has no event model',
        });
        continue;
      }
      if (direction && event.direction && direction !== event.direction) {
        issues.push({
          kind: 'direction-mismatch',
          location,
          event: eventName,
          message: `captured ${direction}, model declares ${event.direction}`,
        });
      }
      const params = envelopeParams
        ? envelopeParams.payload !== null &&
          typeof envelopeParams.payload === 'object' &&
          !Array.isArray(envelopeParams.payload)
          ? envelopeParams.payload
          : {}
        : carrier.params !== null && typeof carrier.params === 'object' && !Array.isArray(carrier.params)
          ? carrier.params
          : {};
      for (const message of persona.validate(eventName, params)) {
        issues.push({ kind: 'payload-mismatch', location, event: eventName, message });
      }
      const channel = inferredChannel(event, carrier);
      for (const message of persona.validateRecord(eventName, carrier, channel)) {
        issues.push({ kind: 'carrier-mismatch', location, event: eventName, message });
      }
      for (const variant of event.variants ?? []) {
        if (matchesVariant(params, variant) && variant.confidence === 'unverified') {
          issues.push({
            kind: 'observed-unverified-variant',
            location,
            event: eventName,
            message: `captured variant ${JSON.stringify(variant.match)} is still marked unverified`,
          });
        }
      }
      const requestDirection = direction ?? event.direction;
      if (!envelopeParams && event.transport === 'jsonrpc-request' && carrier.id !== undefined && requestDirection) {
        pending.set(`${requestDirection}:${String(carrier.id)}`, eventName);
      }
      frames += 1;
      digest.update(`${location}\0${source.trim()}\0`);
    }
    for (const [correlation, queued] of pendingHttp) {
      if (queued.length === 0) continue;
      issues.push({
        kind: 'missing-result',
        location: `${relative(captureAbsolute, file).split(sep).join('/')}:EOF`,
        event: queued[0],
        message: `${queued.length} HTTP request(s) lack a result for ${correlation}`,
      });
    }
  }

  return {
    schemaVersion: 1,
    vendor,
    vendorVersion: model.manifest.vendorVersion,
    asmVersion: model.manifest.asmVersion,
    manifest: relative(repoRoot, manifestAbsolute).split(sep).join('/'),
    captures: relative(repoRoot, captureAbsolute).split(sep).join('/'),
    status: issues.length === 0 ? 'passed' : 'failed',
    frames,
    results,
    unattributedResults,
    replayDigest: digest.digest('hex'),
    issues,
  };
}

function flag(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  const requested = flag('--vendor');
  const ledger = json(join(root, 'support', 'agents.json'));
  const vendors = requested ? [requested] : ledger.agents.filter((agent) => agent.persona).map((agent) => agent.id);
  const reports = vendors.map((vendor) =>
    replayAgentSurface({ vendor, ...(requested && flag('--manifest') ? { manifestPath: flag('--manifest') } : {}) }),
  );
  const output = flag('--output');
  const serialized = `${JSON.stringify(requested ? reports[0] : reports, null, 2)}\n`;
  if (output) writeFileSync(normalizePath(root, output), serialized);
  else process.stdout.write(serialized);
  if (reports.some((report) => report.status !== 'passed')) process.exitCode = 1;
}

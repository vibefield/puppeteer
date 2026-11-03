#!/usr/bin/env node
/**
 * Build the digest-pinned Hermes gateway/hook reference from the exact release checkout.
 *
 * From 0.21 the tui_gateway wire is declared once in Python (`tui_gateway/contracts/`, one
 * Pydantic model per method params/result, server→client request params/result, and event
 * payload) and rendered by upstream's `scripts/gen_gateway_contracts.py` into
 * `apps/shared/src/gateway-contract.openrpc.json`, which upstream CI keeps current. That
 * generated document is retained verbatim beside this reference and is the schema authority;
 * this projection pins its digest, cross-checks it against the contract registry and the
 * registered handler table of the same checkout, and adds the hook surface that the contract
 * does not describe.
 *
 * usage:
 *   node extract-source-reference.mjs --source <git checkout at the tag> --python <python with the
 *     checkout's locked dependencies> --retrieved-at <ISO timestamp>
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RELEASE_TAG, SOURCE_REVISION, VERSION } from './harness.mjs';

const vendorRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const defaultOutputRoot = join(vendorRoot, 'references', `hermes@${VERSION}`);
export const CONTRACT_PATH = 'apps/shared/src/gateway-contract.openrpc.json';
export const RETAINED_CONTRACT = 'gateway-contract.openrpc.json';

function flag(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function fail(message) {
  throw new Error(`Hermes source reference: ${message}`);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function git(sourceRoot, ...args) {
  return execFileSync('git', ['-C', sourceRoot, ...args], { encoding: 'utf8' }).trim();
}

function posix(path) {
  return path.split(sep).join('/');
}

function pythonFiles(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return pythonFiles(path);
    return entry.isFile() && entry.name.endsWith('.py') ? [path] : [];
  });
}

/** Run one snippet that prints JSON. The checkout path is an argument, never code. */
function python(interpreter, script, args, { cwd, env } = {}) {
  return JSON.parse(
    execFileSync(interpreter, ['-E', '-s', '-c', script, ...args], {
      cwd,
      env: { PATH: process.env.PATH ?? '', ...env },
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    }),
  );
}

const VALID_HOOKS_SCRIPT = `
import ast, json, sys
tree = ast.parse(open(sys.argv[1], encoding="utf-8").read())
for node in tree.body:
    target = node.target if isinstance(node, ast.AnnAssign) else (node.targets[0] if isinstance(node, ast.Assign) else None)
    if getattr(target, "id", None) == "VALID_HOOKS":
        print(json.dumps(sorted(ast.literal_eval(node.value))))
        break
else:
    raise SystemExit("VALID_HOOKS not found")
`;

// Importing the gateway registers every handler and builds the contract registry; it starts no
// agent, opens no provider, and runs under a disposable HERMES_HOME. The import redirects
// sys.stdout to stderr to protect stdio JSON-RPC, so the census writes to the original stream.
const REGISTRY_SCRIPT = `
import json, sys
sys.path.insert(0, sys.argv[1])
import tui_gateway.server as server
from tui_gateway.contracts import registry
print(json.dumps({
    "methods": sorted(server._methods),
    "contractMethods": sorted(registry.METHODS),
    "serverRequests": sorted(registry.SERVER_REQUESTS),
    "events": sorted(registry.EVENTS),
}), file=sys.__stdout__, flush=True)
`;

function topLevel(schema, components) {
  let current = schema ?? {};
  const seen = new Set();
  while (typeof current.$ref === 'string' && !seen.has(current.$ref)) {
    seen.add(current.$ref);
    current = components[current.$ref.split('/').at(-1)] ?? {};
  }
  return {
    ...(typeof schema?.$ref === 'string' ? { model: schema.$ref.split('/').at(-1) } : {}),
    keys: Object.keys(current.properties ?? {}).sort((a, b) => a.localeCompare(b)),
    required: [...(current.required ?? [])].sort((a, b) => a.localeCompare(b)),
    closed: current.additionalProperties === false,
  };
}

function sameNames(label, left, right) {
  const a = [...left].sort();
  const b = [...right].sort();
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    const missing = a.filter((name) => !b.includes(name));
    const extra = b.filter((name) => !a.includes(name));
    fail(`${label} disagree: missing ${missing.join(', ') || '-'}; extra ${extra.join(', ') || '-'}`);
  }
}

function extractWorkspaceMutation(files) {
  const display = files.get('agent/display.py');
  const progress = files.get('tui_gateway/tool_progress.py');
  if (!display || !progress) fail('workspace mutation projection requires agent/display.py and tool_progress.py');
  const maximumFiles = Number(/_MAX_INLINE_DIFF_FILES\s*=\s*(\d+)/.exec(display)?.[1]);
  const maximumRenderedLines = Number(/_MAX_INLINE_DIFF_LINES\s*=\s*(\d+)/.exec(display)?.[1]);
  if (!Number.isSafeInteger(maximumFiles) || !Number.isSafeInteger(maximumRenderedLines)) {
    fail('cannot recover inline diff preview bounds');
  }
  const resolver = /def _resolve_local_edit_paths\([\s\S]*?\n(?=def )/.exec(display)?.[0] ?? '';
  if (!/function_args\.get\(["']path["']\) if tool_name in \{["']write_file["'], ["']patch["']\}/.test(resolver)) {
    fail('cannot prove the write_file/patch path argument');
  }
  if (!resolver.includes('_resolve_skill_manage_paths(function_args)')) fail('skill_manage path resolution drifted');
  const supported = /if tool_name not in\s*\{([^}]+)\}/.exec(
    display.slice(display.indexOf('def extract_edit_diff')),
  )?.[1];
  const diffTools = [...(supported ?? '').matchAll(/["']([^"']+)["']/g)].map((match) => match[1]).sort();
  if (JSON.stringify(diffTools) !== JSON.stringify(['patch', 'skill_manage', 'write_file'])) {
    fail(`inline diff tool inventory drifted: ${diffTools.join(', ')}`);
  }
  if (
    !progress.includes('metadata["inline_diff"] = "\\n".join(rendered)') ||
    !progress.includes('render_edit_diff_with_delta(')
  ) {
    fail('cannot prove tool.complete inline_diff assembly');
  }
  return {
    event: 'tool.complete',
    detailField: 'inline_diff',
    representation: 'ansi-rendered-diff-preview',
    maximumFiles,
    maximumRenderedLines,
    mayBeTruncated: true,
    singlePathTools: [
      { name: 'patch', pathField: 'path' },
      { name: 'write_file', pathField: 'path' },
    ],
    dynamicPathTools: ['skill_manage'],
    localOnly: true,
    sources: [
      'tui_gateway/tool_progress.py:_prepare_tool_result_metadata',
      'agent/display.py:_resolve_local_edit_paths',
      'agent/display.py:render_edit_diff_with_delta',
    ],
  };
}

function extractHookEnvelopes(files) {
  const shell = files.get('agent/shell_hooks.py');
  const outbound = files.get('agent/outbound_webhooks.py');
  const fields = /def _payload_fields\([\s\S]*?return \{([\s\S]*?)\n    \}/.exec(shell ?? '')?.[1];
  if (!fields) fail('cannot locate the shared hook payload fields');
  const common = [...fields.matchAll(/^\s*"([a-z_]+)":/gm)].map((match) => match[1]);
  if (JSON.stringify(common) !== JSON.stringify(['tool_name', 'tool_input', 'session_id', 'cwd', 'profile', 'extra'])) {
    fail(`shared hook payload fields drifted: ${common.join(', ')}`);
  }
  if (!/json\.dumps\(\{"hook_event_name": event, \*\*_payload_fields\(kwargs\)\}/.test(shell)) {
    fail('shell-hook stdin envelope drifted');
  }
  if (
    !/"hook_event_name": event, "profile": get_active_profile_name\(\), \*\*_payload_fields\(kwargs\),\s*"delivery_id": delivery_id, "timestamp": _utc_now_iso\(\)/.test(
      outbound ?? '',
    )
  ) {
    fail('outbound webhook envelope drifted');
  }
  return {
    shellEnvelope: { fields: ['hook_event_name', ...common], source: 'agent/shell_hooks.py:_serialize_payload' },
    outboundEnvelope: {
      fields: ['hook_event_name', ...common, 'delivery_id', 'timestamp'],
      source: 'agent/outbound_webhooks.py:_serialize_payload',
    },
  };
}

export function buildSourceReference({ sourceRoot, interpreter, retrievedAt }) {
  if (!sourceRoot) fail('--source is required');
  if (!interpreter) fail('--python is required');
  if (!retrievedAt || Number.isNaN(Date.parse(retrievedAt))) fail('--retrieved-at must be an ISO timestamp');
  const revision = git(sourceRoot, 'rev-parse', 'HEAD');
  if (revision !== SOURCE_REVISION) fail(`expected revision ${SOURCE_REVISION}, got ${revision}`);
  if (git(sourceRoot, 'status', '--porcelain')) fail('checkout is dirty');
  const tags = git(sourceRoot, 'tag', '--points-at', 'HEAD').split('\n').filter(Boolean);
  if (!tags.includes(RELEASE_TAG)) fail(`revision is not tagged ${RELEASE_TAG}`);

  const contributing = [
    CONTRACT_PATH,
    'scripts/gen_gateway_contracts.py',
    ...pythonFiles(join(sourceRoot, 'tui_gateway', 'contracts')).map((path) => posix(relative(sourceRoot, path))),
    'tui_gateway/rpc_dispatch.py',
    'tui_gateway/server_requests.py',
    'tui_gateway/session_transports.py',
    'tui_gateway/session_lifecycle.py',
    'tui_gateway/transport.py',
    'tui_gateway/ws.py',
    'tui_gateway/event_replay.py',
    'tui_gateway/tool_progress.py',
    'agent/display.py',
    'agent/shell_hooks.py',
    'agent/outbound_webhooks.py',
    'hermes_cli/plugins.py',
    'ui-tui/src/gatewayClient.ts',
    'apps/shared/src/json-rpc-channel.ts',
  ].sort((a, b) => a.localeCompare(b));
  const files = new Map(contributing.map((path) => [path, readFileSync(join(sourceRoot, path), 'utf8')]));
  const sourceFiles = contributing.map((path) => ({
    path,
    bytes: Buffer.byteLength(files.get(path)),
    sha256: sha256(files.get(path)),
  }));

  const contract = JSON.parse(files.get(CONTRACT_PATH));
  const components = contract.components?.schemas ?? {};
  if (contract.openrpc !== '1.3.2') fail(`unexpected OpenRPC version ${contract.openrpc}`);
  const methods = contract.methods.map((method) => ({
    name: method.name,
    ...(method.summary ? { summary: method.summary } : {}),
    params: topLevel(method.params?.[0]?.schema, components),
    result: topLevel(method.result?.schema, components),
  }));
  const serverRequests = contract['x-server-requests'].map((request) => ({
    name: request.name,
    ...(request.summary ? { summary: request.summary } : {}),
    params: topLevel(request.params?.[0]?.schema, components),
    result: topLevel(request.result?.schema, components),
  }));
  const events = contract['x-notifications'].map((event) => ({
    name: event.name,
    ...(event.summary ? { summary: event.summary } : {}),
    payload: topLevel(event.params?.[0]?.schema, components),
  }));

  const home = mkdtempSync(join(tmpdir(), 'puppeteer-hermes-reference-'));
  let registry;
  try {
    registry = python(interpreter, REGISTRY_SCRIPT, [sourceRoot], {
      cwd: home,
      env: { HOME: home, HERMES_HOME: home, PYTHONDONTWRITEBYTECODE: '1' },
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  sameNames('contract methods and registered handlers', registry.contractMethods, registry.methods);
  sameNames(
    'OpenRPC methods and the contract registry',
    methods.map(({ name }) => name),
    registry.contractMethods,
  );
  sameNames(
    'OpenRPC server requests and the contract registry',
    serverRequests.map(({ name }) => name),
    registry.serverRequests,
  );
  sameNames(
    'OpenRPC notifications and the contract registry',
    events.map(({ name }) => name),
    registry.events,
  );

  const hooks = python(interpreter, VALID_HOOKS_SCRIPT, [join(sourceRoot, 'hermes_cli', 'plugins.py')]);
  const workspaceMutation = extractWorkspaceMutation(files);
  const envelopes = extractHookEnvelopes(files);

  return {
    referenceVersion: 3,
    vendor: 'hermes',
    vendorVersion: VERSION,
    repository: 'https://github.com/NousResearch/hermes-agent',
    revision: SOURCE_REVISION,
    tag: RELEASE_TAG,
    retrievedAt,
    contract: {
      path: CONTRACT_PATH,
      retained: RETAINED_CONTRACT,
      sha256: sha256(files.get(CONTRACT_PATH)),
      openrpc: contract.openrpc,
      generator: 'scripts/gen_gateway_contracts.py',
      registryCrossCheck: {
        registeredMethods: registry.methods.length,
        contractMethods: registry.contractMethods.length,
        serverRequests: registry.serverRequests.length,
        events: registry.events.length,
        agrees: true,
      },
    },
    projection: {
      method:
        'Every method, server→client request, and event is taken from the upstream-generated OpenRPC contract, whose names equal the contract registry and the registered handler table of the same checkout. Hooks come from VALID_HOOKS by literal evaluation.',
      limitations: [
        'Contract models are enforced at dispatch for unknown params keys only; production logs, rather than rejects, a result or payload that violates its model, so runtime captures remain the occurrence authority.',
        'OpenModel payloads (additionalProperties true) admit producer-owned fields that the contract does not enumerate.',
        'Contract declarations establish legal shape and existence, not runtime reachability.',
      ],
    },
    sourceFiles,
    gateway: { methods, serverRequests, events },
    workspaceMutation,
    hooks: { events: hooks, ...envelopes },
  };
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  const sourceFlag = flag('--source');
  const sourceRoot = sourceFlag && (isAbsolute(sourceFlag) ? sourceFlag : resolve(sourceFlag));
  const outputRoot = resolve(flag('--output', defaultOutputRoot));
  const reference = buildSourceReference({
    sourceRoot,
    interpreter: flag('--python'),
    retrievedAt: flag('--retrieved-at'),
  });
  mkdirSync(outputRoot, { recursive: true });
  copyFileSync(join(sourceRoot, CONTRACT_PATH), join(outputRoot, RETAINED_CONTRACT));
  writeFileSync(join(outputRoot, 'gateway-surface.json'), `${JSON.stringify(reference, null, 2)}\n`);
  console.log(
    `wrote Hermes ${VERSION} source reference: ${reference.gateway.methods.length} methods, ` +
      `${reference.gateway.serverRequests.length} server requests, ${reference.gateway.events.length} events, ` +
      `${reference.hooks.events.length} hooks`,
  );
}

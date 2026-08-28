#!/usr/bin/env node
/** Build a digest-pinned Hermes gateway/hook reference from the exact release checkout. */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RELEASE_TAG, SOURCE_REVISION, VERSION } from './harness.mjs';

const vendorRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const defaultOutput = join(vendorRoot, 'references', `hermes@${VERSION}`, 'gateway-surface.json');

const derivedGatewayEvents = [
  'clarify.expire',
  'secret.expire',
  'subagent.complete',
  'subagent.progress',
  'subagent.spawn_requested',
  'subagent.start',
  'subagent.text',
  'subagent.thinking',
  'subagent.tool',
  'sudo.expire',
  'terminal.read.expire',
];

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

function walkPythonFiles(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return walkPythonFiles(path);
    return entry.isFile() && entry.name.endsWith('.py') ? [path] : [];
  });
}

function lineAt(source, index) {
  return source.slice(0, index).split('\n').length;
}

function scanClosing(source, opening, open = '(', close = ')') {
  let depth = 0;
  let quote = '';
  let triple = false;
  let escaped = false;
  let comment = false;
  for (let index = opening; index < source.length; index += 1) {
    const character = source[index];
    const nextThree = source.slice(index, index + 3);
    if (comment) {
      if (character === '\n') comment = false;
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === '\\') {
        escaped = true;
        continue;
      }
      if (triple && nextThree === quote.repeat(3)) {
        index += 2;
        quote = '';
        triple = false;
      } else if (!triple && character === quote) {
        quote = '';
      }
      continue;
    }
    if (character === '#') {
      comment = true;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      triple = nextThree === character.repeat(3);
      if (triple) index += 2;
      continue;
    }
    if (character === open) depth += 1;
    else if (character === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function splitTopLevel(source) {
  const values = [];
  let start = 0;
  const depths = { '(': 0, '[': 0, '{': 0 };
  const closing = { ')': '(', ']': '[', '}': '{' };
  let quote = '';
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (Object.hasOwn(depths, character)) depths[character] += 1;
    else if (Object.hasOwn(closing, character)) depths[closing[character]] -= 1;
    else if (character === ',' && Object.values(depths).every((depth) => depth === 0)) {
      values.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  values.push(source.slice(start).trim());
  return values;
}

function literalObjectKeys(expression) {
  const opening = expression.indexOf('{');
  if (opening < 0) return null;
  const closing = scanClosing(expression, opening, '{', '}');
  if (closing < 0 || expression.slice(0, opening).trim()) return null;
  const body = expression.slice(opening + 1, closing);
  const keys = new Set();
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'") {
      if (depth === 0) {
        const end = body.indexOf(character, index + 1);
        if (end > index && /^\s*:/.test(body.slice(end + 1))) {
          keys.add(body.slice(index + 1, end));
        }
      }
      quote = character;
      continue;
    }
    if ('([{'.includes(character)) depth += 1;
    else if (')]}'.includes(character)) depth -= 1;
  }
  return [...keys].sort((a, b) => a.localeCompare(b));
}

function extractLiteralCalls(source, names) {
  const calls = [];
  const pattern = new RegExp(`\\b(${names.join('|')})\\(\\s*(["'])([^"']+)\\2`, 'g');
  for (const match of source.matchAll(pattern)) {
    const opening = source.indexOf('(', match.index);
    const closing = scanClosing(source, opening);
    if (closing < 0) continue;
    calls.push({
      callee: match[1],
      value: match[3],
      arguments: splitTopLevel(source.slice(opening + 1, closing)),
      index: match.index,
    });
  }
  return calls;
}

function extractCalls(source, name) {
  const calls = [];
  const pattern = new RegExp(`\\b${name}\\(`, 'g');
  for (const match of source.matchAll(pattern)) {
    const opening = source.indexOf('(', match.index);
    const closing = scanClosing(source, opening);
    if (closing < 0) continue;
    calls.push({ arguments: splitTopLevel(source.slice(opening + 1, closing)), index: match.index });
  }
  return calls;
}

function extractMethods(files) {
  const methods = [];
  for (const file of files) {
    const source = file.source;
    const matches = [...source.matchAll(/^@method\((["'])([^"']+)\1\)/gm)];
    for (const [index, match] of matches.entries()) {
      const end = matches[index + 1]?.index ?? source.length;
      const block = source.slice(match.index, end);
      const required = new Set([...block.matchAll(/\bparams\[\s*["']([^"']+)["']\s*\]/g)].map((item) => item[1]));
      const accessed = new Set(required);
      for (const item of block.matchAll(/\bparams\.(?:get|pop|setdefault)\(\s*["']([^"']+)["']/g)) {
        accessed.add(item[1]);
      }
      const resultKeys = new Set();
      let hasLiteralResult = false;
      for (const call of extractCalls(block, '_ok')) {
        const keys = literalObjectKeys(call.arguments[1] ?? '');
        if (keys !== null) {
          hasLiteralResult = true;
          for (const key of keys) resultKeys.add(key);
        }
      }
      methods.push({
        name: match[2],
        source: { path: file.path, line: lineAt(source, match.index) },
        params: {
          accessedKeys: [...accessed].sort((a, b) => a.localeCompare(b)),
          requiredByDirectIndexing: [...required].sort((a, b) => a.localeCompare(b)),
        },
        result: {
          literalTopLevelKeys: [...resultKeys].sort((a, b) => a.localeCompare(b)),
          hasLiteralSuccessObject: hasLiteralResult,
        },
      });
    }
  }
  return methods.sort((a, b) => a.name.localeCompare(b.name));
}

function extractGatewayEvents(files, evidenceSource) {
  const events = new Map();
  const add = (name, source, keys, projection) => {
    const event = events.get(name) ?? { name, payloadKeys: new Set(), sources: [], projections: new Set() };
    for (const key of keys ?? []) event.payloadKeys.add(key);
    event.sources.push(source);
    event.projections.add(projection);
    events.set(name, event);
  };
  for (const file of files) {
    for (const call of extractLiteralCalls(file.source, [
      '_emit',
      '_voice_emit',
      '_broadcast_global_event',
      '_block',
    ])) {
      const payloadIndex = call.callee === '_emit' || call.callee === '_block' ? 2 : 1;
      const keys = literalObjectKeys(call.arguments[payloadIndex] ?? '');
      add(
        call.value,
        { path: file.path, line: lineAt(file.source, call.index) },
        keys,
        keys === null ? 'dynamic-payload' : 'literal-top-level-keys',
      );
    }
    for (const match of file.source.matchAll(/["']type["']\s*:\s*["']gateway\.ready["']/g)) {
      add(
        'gateway.ready',
        { path: file.path, line: lineAt(file.source, match.index) },
        ['skin', 'change_events'],
        'literal-top-level-keys',
      );
    }
  }
  const combined = files.map((file) => file.source).join('\n');
  for (const name of derivedGatewayEvents) {
    if (!evidenceSource.includes(name.replace(/\.expire$/, '.request')) && !evidenceSource.includes(name)) {
      fail(`cannot substantiate derived gateway event ${name}`);
    }
    add(name, { path: 'tui_gateway/server.py', line: 0 }, [], 'derived-dynamic-event');
  }
  const watches = /_CHANGE_WATCHES[^=]*=\s*\{([\s\S]*?)\n\}/.exec(combined)?.[1] ?? '';
  for (const match of watches.matchAll(/^[ \t]*["']([^"']+)["']\s*:/gm)) {
    add(match[1], { path: 'tui_gateway/server.py', line: 0 }, [], 'watch-registry');
  }
  return [...events.values()]
    .map((event) => ({
      name: event.name,
      payloadKeys: [...event.payloadKeys].sort((a, b) => a.localeCompare(b)),
      sources: event.sources,
      projections: [...event.projections].sort((a, b) => a.localeCompare(b)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function extractStringSet(source, name) {
  const body = new RegExp(`${name}[^=]*=\\s*\\{([\\s\\S]*?)\\n\\}`, 'm').exec(source)?.[1];
  if (!body) fail(`cannot locate ${name}`);
  return [...body.matchAll(/^[ \t]*["']([^"']+)["']\s*,/gm)]
    .map((match) => match[1])
    .sort((a, b) => a.localeCompare(b));
}

function extractWorkspaceMutation(files) {
  const display = files.find((file) => file.path === 'agent/display.py');
  const server = files.find((file) => file.path === 'tui_gateway/server.py');
  if (!display || !server) fail('workspace mutation projection requires agent/display.py and tui_gateway/server.py');

  const maximumFiles = Number(/_MAX_INLINE_DIFF_FILES\s*=\s*(\d+)/.exec(display.source)?.[1]);
  const maximumRenderedLines = Number(/_MAX_INLINE_DIFF_LINES\s*=\s*(\d+)/.exec(display.source)?.[1]);
  if (!Number.isSafeInteger(maximumFiles) || !Number.isSafeInteger(maximumRenderedLines)) {
    fail('cannot recover inline diff preview bounds');
  }
  const pathTools = ['patch', 'write_file'];
  for (const tool of pathTools) {
    const branch = new RegExp(`if tool_name == ["']${tool}["']:[\\s\\S]{0,180}?function_args\\.get\\(["']path["']\\)`);
    if (!branch.test(display.source)) fail(`cannot prove ${tool} path argument`);
  }
  const extractEditDiff = /def extract_edit_diff\([\s\S]*?\ndef _emit_inline_diff/.exec(display.source)?.[0] ?? '';
  const supported = /if tool_name not in\s*\{([^}]+)\}/.exec(extractEditDiff)?.[1] ?? '';
  const diffTools = [...supported.matchAll(/["']([^"']+)["']/g)]
    .map((match) => match[1])
    .sort((left, right) => left.localeCompare(right));
  if (JSON.stringify(diffTools) !== JSON.stringify(['patch', 'skill_manage', 'write_file'])) {
    fail(`inline diff tool inventory drifted: ${diffTools.join(', ')}`);
  }
  if (
    !server.source.includes('payload["inline_diff"] = "\\n".join(rendered)') ||
    !server.source.includes('render_edit_diff_with_delta(')
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
    singlePathTools: pathTools.map((name) => ({ name, pathField: 'path' })),
    dynamicPathTools: ['skill_manage'],
    sources: [
      'tui_gateway/server.py:_on_tool_complete',
      'agent/display.py:_resolve_local_edit_paths',
      'agent/display.py:render_edit_diff_with_delta',
    ],
  };
}

export function buildSourceReference({ sourceRoot, retrievedAt }) {
  if (!sourceRoot) fail('--source is required');
  if (!retrievedAt || Number.isNaN(Date.parse(retrievedAt))) fail('--retrieved-at must be an ISO timestamp');
  const revision = git(sourceRoot, 'rev-parse', 'HEAD');
  if (revision !== SOURCE_REVISION) fail(`expected revision ${SOURCE_REVISION}, got ${revision}`);
  if (git(sourceRoot, 'status', '--porcelain')) fail('checkout is dirty');
  const tags = git(sourceRoot, 'tag', '--points-at', 'HEAD').split('\n').filter(Boolean);
  if (!tags.includes(RELEASE_TAG)) fail(`revision is not tagged ${RELEASE_TAG}`);

  const contributingPaths = [
    ...walkPythonFiles(join(sourceRoot, 'tui_gateway')),
    join(sourceRoot, 'agent', 'display.py'),
    join(sourceRoot, 'agent', 'outbound_webhooks.py'),
    join(sourceRoot, 'agent', 'shell_hooks.py'),
    join(sourceRoot, 'hermes_cli', 'hooks.py'),
    join(sourceRoot, 'hermes_cli', 'plugins.py'),
    join(sourceRoot, 'tools', 'delegate_tool.py'),
  ].sort((a, b) => a.localeCompare(b));
  const files = contributingPaths.map((path) => ({
    path: posix(relative(sourceRoot, path)),
    source: readFileSync(path, 'utf8'),
  }));
  const gatewayFiles = files.filter((file) => file.path.startsWith('tui_gateway/'));
  const plugins = files.find((file) => file.path === 'hermes_cli/plugins.py').source;

  const sourceFiles = files.map(({ path, source }) => ({
    path,
    bytes: Buffer.byteLength(source),
    sha256: sha256(source),
  }));
  const methods = extractMethods(gatewayFiles);
  const gatewayEvents = extractGatewayEvents(gatewayFiles, files.map((file) => file.source).join('\n'));
  const hooks = extractStringSet(plugins, 'VALID_HOOKS');
  const workspaceMutation = extractWorkspaceMutation(files);
  if (methods.length !== 130) fail(`gateway method inventory drifted: expected 130, got ${methods.length}`);
  if (hooks.length !== 23) fail(`plugin hook inventory drifted: expected 23, got ${hooks.length}`);

  return {
    referenceVersion: 2,
    vendor: 'hermes',
    vendorVersion: VERSION,
    repository: 'https://github.com/NousResearch/hermes-agent',
    revision: SOURCE_REVISION,
    tag: RELEASE_TAG,
    retrievedAt,
    projection: {
      method:
        'All @method registrations and statically/derivably named gateway events are inventoried. Parameter access, literal success-result keys, and literal event-payload keys are conservative source projections.',
      limitations: [
        'Python is dynamic: helper-produced, conditionally assembled, and forwarded payload/result fields remain unconstrained unless directly recoverable.',
        'Direct params indexing proves required access; params.get access proves a known field but not optionality.',
        'Source declarations establish legal/native shape and existence, not runtime reachability.',
      ],
    },
    sourceFiles,
    gateway: { methods, events: gatewayEvents },
    workspaceMutation,
    hooks: {
      events: hooks,
      shellEnvelope: {
        fields: ['hook_event_name', 'tool_name', 'tool_input', 'session_id', 'cwd', 'extra'],
        source: 'agent/shell_hooks.py:_serialize_payload',
      },
      outboundEnvelope: {
        fields: [
          'hook_event_name',
          'tool_name',
          'tool_input',
          'session_id',
          'cwd',
          'extra',
          'delivery_id',
          'timestamp',
        ],
        source: 'agent/outbound_webhooks.py:_serialize_payload',
      },
    },
  };
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  const sourceFlag = flag('--source');
  const sourceRoot = sourceFlag && (isAbsolute(sourceFlag) ? sourceFlag : resolve(sourceFlag));
  const output = resolve(flag('--output', defaultOutput));
  const reference = buildSourceReference({ sourceRoot, retrievedAt: flag('--retrieved-at') });
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(reference, null, 2)}\n`);
  console.log(
    `wrote Hermes ${VERSION} source reference: ${reference.gateway.methods.length} methods, ${reference.gateway.events.length} gateway events, ${reference.hooks.events.length} hooks`,
  );
}

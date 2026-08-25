#!/usr/bin/env node
/**
 * Antigravity capture privacy gate: captures-raw -> committed captures.
 *
 * Keeps native event names, hook families, step types, ids-as-aliases, and
 * usage counters. Drops prompts, model text, tool output, sqlite, and paths.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkCaptureDirectory, sanitizeRecord } from '@vibecook/puppeteer-surface/sanitize';
import { AUTHORIZED_SCENARIOS } from './census/authorized-census.mjs';
import { VERSION } from './census/harness.mjs';
import { antigravityRules } from './privacy.mjs';

const vendorRoot = dirname(fileURLToPath(import.meta.url));

function parseMaybeJson(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return { unparsed: true, bytes: Buffer.byteLength(trimmed) };
  }
}

function parseJsonLines(text) {
  return String(text ?? '')
    .split('\n')
    .filter((line) => line.trim())
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new Error(`jsonl line ${index + 1} is not valid JSON`);
      }
    });
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(sanitizeRecord(value, antigravityRules), null, 2)}\n`);
}

function writeJsonLines(path, records) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `${records.map((record) => JSON.stringify(sanitizeRecord(record, antigravityRules))).join('\n')}${records.length ? '\n' : ''}`,
  );
}

function projectCommandPayload(data) {
  if (!data || typeof data !== 'object') return data;
  if (Array.isArray(data.commands)) {
    return { commands: data.commands.map((command) => ({ name: command.name, aliases: command.aliases ?? [] })) };
  }
  if (Array.isArray(data.hooks)) {
    return {
      hooks: data.hooks.map((hook) => ({
        name: hook.name,
        enabled: hook.enabled,
        actionEvents: (hook.actions ?? []).map((action) => action.event),
        matchers: (hook.actions ?? []).map((action) => action.matcher ?? null),
      })),
    };
  }
  if (data.config && typeof data.config === 'object') {
    const config = data.config;
    return {
      config: {
        keys: Object.keys(config).sort(),
        toolPermission: config.toolPermission,
        artifactReviewPolicy: config.artifactReviewPolicy,
        enableTerminalSandbox: config.enableTerminalSandbox,
        statusLine: config.statusLine,
        trustedWorkspaceCount: Array.isArray(config.trustedWorkspaces) ? config.trustedWorkspaces.length : 0,
      },
    };
  }
  if (Array.isArray(data.permissions)) {
    return { permissions: data.permissions.map((entry) => ({ scope: entry.scope })) };
  }
  return { keys: Object.keys(data).sort() };
}

function projectPrintRecord(record) {
  const stdout = record.stdout ?? '';
  const firstLine = stdout.trim().split('\n')[0];
  const first = parseMaybeJson(firstLine);
  if (first && typeof first === 'object' && first.event) {
    return {
      status: record.status,
      events: parseJsonLines(stdout).map(projectStreamEvent),
    };
  }
  return {
    status: record.status,
    signal: record.signal,
    stdoutBytes: record.stdoutBytes,
    stderrBytes: record.stderrBytes,
    body: projectResultBody(parseMaybeJson(stdout)),
  };
}

function projectResultBody(body) {
  if (!body || typeof body !== 'object') return body;
  return {
    conversation_id: body.conversation_id,
    status: body.status,
    num_turns: body.num_turns,
    duration_seconds: body.duration_seconds,
    usage: body.usage,
    command: body.command ? { name: body.command.name, data: projectCommandPayload(body.command.data) } : undefined,
    hasResponse: typeof body.response === 'string' && body.response.length > 0,
  };
}

function projectStreamEvent(record) {
  if (record.event === 'init') {
    return {
      event: 'init',
      conversation_id: record.conversation_id,
      init: {
        permission_mode: record.init?.permission_mode,
        toolCount: Array.isArray(record.init?.tools) ? record.init.tools.length : 0,
        tools: record.init?.tools ?? [],
        cwdRedacted: true,
      },
    };
  }
  if (record.event === 'command_result') {
    return {
      event: 'command_result',
      command: record.command
        ? { name: record.command.name, data: projectCommandPayload(record.command.data) }
        : undefined,
    };
  }
  if (record.event === 'step_update') {
    const step = record.step_update ?? {};
    const info = step.tool_info && typeof step.tool_info === 'object' ? step.tool_info : null;
    return {
      event: 'step_update',
      step_update: {
        conversation_id: step.conversation_id,
        step_index: step.step_index,
        state: step.state,
        step_type: step.step_type,
        duration_seconds: step.duration_seconds,
        usage: step.usage,
        tool_name: step.tool_name,
        hasTextDelta: typeof step.text_delta === 'string',
        tool_info: info
          ? {
              name: info.name,
              parameterKeys:
                info.parameters && typeof info.parameters === 'object' ? Object.keys(info.parameters).sort() : [],
              hasOutput: typeof info.output === 'string',
            }
          : undefined,
      },
    };
  }
  if (record.event === 'result') {
    return { event: 'result', result: projectResultBody(record.result) };
  }
  return { event: record.event ?? 'unknown', keys: Object.keys(record).sort() };
}

function projectHook(record) {
  const stdin = record.stdin && typeof record.stdin === 'object' ? record.stdin : {};
  const toolCall = stdin.toolCall && typeof stdin.toolCall === 'object' ? stdin.toolCall : null;
  return {
    event: record.event,
    conversationId: stdin.conversationId,
    modelName: stdin.modelName,
    invocationNum: stdin.invocationNum,
    initialNumSteps: stdin.initialNumSteps,
    stepIdx: stdin.stepIdx,
    fullyIdle: stdin.fullyIdle,
    terminationReason: stdin.terminationReason,
    errorPresent: typeof stdin.error === 'string' ? stdin.error.length > 0 : undefined,
    workspacePathCount: Array.isArray(stdin.workspacePaths) ? stdin.workspacePaths.length : 0,
    toolCall: toolCall
      ? {
          name: toolCall.name,
          argKeys: toolCall.args && typeof toolCall.args === 'object' ? Object.keys(toolCall.args).sort() : [],
        }
      : undefined,
  };
}

function projectTranscript(record) {
  return {
    type: record.type,
    source: record.source,
    status: record.status,
    step_index: record.step_index,
    created_at: record.created_at,
    hasContent: record.content != null,
    contentChars: typeof record.content === 'string' ? record.content.length : undefined,
  };
}

function firstTranscript(root) {
  const files = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name === 'transcript.jsonl' && !path.includes(`${sep}chunks${sep}`)) files.push(path);
    }
  };
  walk(join(root, 'durable'));
  return files.sort()[0];
}

const sep = '/';

export function sanitizeAntigravityCaptureSet(
  input = join(vendorRoot, 'captures-raw', `antigravity@${VERSION}`),
  output = join(vendorRoot, 'captures', `antigravity@${VERSION}`),
) {
  if (!existsSync(input)) throw new Error(`raw captures missing: ${input}`);
  const scenarios = readdirSync(input, { withFileTypes: true }).filter(
    (entry) => entry.isDirectory() && AUTHORIZED_SCENARIOS.includes(entry.name),
  );
  if (scenarios.length === 0) throw new Error(`no Antigravity scenarios in ${input}`);
  const staging = `${output}.staging`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });

  for (const scenario of scenarios) {
    const source = join(input, scenario.name);
    const destination = join(staging, scenario.name);
    mkdirSync(destination, { recursive: true });
    const capture = existsSync(join(source, 'capture.json'))
      ? JSON.parse(readFileSync(join(source, 'capture.json'), 'utf8'))
      : { scenario: scenario.name };
    writeJson(join(destination, 'capture.json'), {
      schemaVersion: 1,
      vendor: 'antigravity',
      vendorVersion: VERSION,
      scenario: scenario.name,
      mode: 'authorized-print-oracle',
      artifactSha256: capture.artifactSha256,
      settingsMutated: capture.settingsMutated === true,
      hookEvents: capture.hookFiles?.filter((name) => name.endsWith('.stdin.json')).map((name) => name.split('.')[0]),
      durableKinds: (capture.copiedDurable ?? []).map((file) => {
        if (file.includes('transcript_full')) return 'transcript_full';
        if (file.endsWith('transcript.jsonl')) return 'transcript';
        if (file.endsWith('.db')) return 'sqlite';
        if (file.includes('last_conversations')) return 'last_conversations';
        if (file.includes('messages/')) return 'message';
        return 'other';
      }),
    });

    for (const name of readdirSync(source)) {
      if (!name.endsWith('.json') || name === 'capture.json') continue;
      const record = JSON.parse(readFileSync(join(source, name), 'utf8'));
      writeJson(join(destination, name), projectPrintRecord(record));
    }

    const hooksPath = join(source, 'hooks', 'hooks.jsonl');
    if (existsSync(hooksPath)) {
      writeJsonLines(
        join(destination, 'hooks.jsonl'),
        parseJsonLines(readFileSync(hooksPath, 'utf8')).map(projectHook),
      );
    }
    const transcript = firstTranscript(source);
    if (transcript) {
      writeJsonLines(
        join(destination, 'transcript.jsonl'),
        parseJsonLines(readFileSync(transcript, 'utf8')).map(projectTranscript),
      );
    }
  }

  const leaks = checkCaptureDirectory(staging, antigravityRules);
  if (leaks.length > 0) {
    rmSync(staging, { recursive: true, force: true });
    throw new Error(`sanitized Antigravity captures leaked:\n${leaks.join('\n')}`);
  }
  rmSync(output, { recursive: true, force: true });
  renameSync(staging, output);
  writeFileSync(
    join(output, 'SANITIZATION.md'),
    `# Antigravity capture sanitization

These fixtures were captured from the exact Antigravity CLI 1.1.12
darwin-arm64 executable through authorized print-mode survey oracles and
launch-scoped \`.agents/hooks.json\` observers.

Prompts, model text, tool output, account fields, sqlite databases, and
absolute paths stay in gitignored \`captures-raw/\`. Native event names,
hook families, step types, usage counters, and aliased conversation ids
are preserved.
`,
  );
  return output;
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  if (process.argv.includes('--check')) {
    const captures = join(vendorRoot, 'captures', `antigravity@${VERSION}`);
    const leaks = existsSync(captures)
      ? checkCaptureDirectory(captures, antigravityRules)
      : ['captures directory missing'];
    if (leaks.length > 0) {
      console.error(leaks.join('\n'));
      process.exit(1);
    }
    console.log(`antigravity@${VERSION} sanitized captures: clean`);
  } else {
    const output = sanitizeAntigravityCaptureSet();
    console.log(`wrote sanitized Antigravity captures to ${output}`);
  }
}

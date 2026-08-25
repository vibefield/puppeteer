#!/usr/bin/env node
/**
 * Hermes capture privacy gate: captures-raw -> committed captures.
 *
 * Keeps JSON-RPC method/type, webhook event names, and provider request
 * shape. Drops stderr logs and redacts prompts, model output, paths, and ids.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkCaptureDirectory, sanitizeRecord } from '@vibecook/chopsticks-surface/sanitize';
import { VERSION } from './census/harness.mjs';
import { hermesRules } from './privacy.mjs';

const vendorRoot = dirname(fileURLToPath(import.meta.url));

function parseJsonLines(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new Error(`${path}:${index + 1} is not valid JSON`);
      }
    });
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(sanitizeRecord(value, hermesRules), null, 2)}\n`);
}

function writeJsonLines(path, records) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${records.map((record) => JSON.stringify(sanitizeRecord(record, hermesRules))).join('\n')}\n`);
}

function projectProviderRequest(request) {
  const body = request.body && typeof request.body === 'object' ? request.body : null;
  return {
    method: request.method,
    endpoint: request.url,
    body: body
      ? {
          model: body.model ?? null,
          stream: body.stream ?? null,
          messageCount: Array.isArray(body.messages) ? body.messages.length : 0,
          messageRoles: Array.isArray(body.messages) ? body.messages.map((item) => item.role).filter(Boolean) : [],
          toolNames: Array.isArray(body.tools)
            ? body.tools.map((item) => item.function?.name ?? item.name).filter(Boolean)
            : [],
        }
      : null,
  };
}

function projectWebhook(delivery) {
  return {
    method: delivery.method,
    endpoint: delivery.url,
    headers: {
      'x-hermes-event': delivery.headers?.['x-hermes-event'] ?? null,
    },
    body:
      delivery.body && typeof delivery.body === 'object'
        ? {
            hook_event_name: delivery.body.hook_event_name ?? null,
            tool_name: delivery.body.tool_name ?? null,
            session_id: delivery.body.session_id ?? null,
            cwd: delivery.body.cwd ?? null,
            extraKeys:
              delivery.body.extra && typeof delivery.body.extra === 'object' ? Object.keys(delivery.body.extra) : [],
          }
        : delivery.body,
  };
}

function projectHook(record) {
  const kwargs = record.kwargs && typeof record.kwargs === 'object' ? record.kwargs : {};
  return {
    hook_event_name: record.hook_event_name,
    session_id: kwargs.session_id ?? kwargs.session_key ?? null,
    tool_name: kwargs.tool_name ?? null,
    platform: kwargs.platform ?? null,
    choice: kwargs.choice ?? null,
    keys: Object.keys(kwargs).sort(),
  };
}

function projectRpc(frame) {
  if (frame.direction === 'client') {
    return {
      direction: 'client',
      jsonrpc: frame.jsonrpc,
      id: frame.id,
      method: frame.method,
      params: {
        session_id: frame.params?.session_id,
        cwd: frame.params?.cwd,
        source: frame.params?.source,
        choice: frame.params?.choice,
        hasText: typeof frame.params?.text === 'string',
      },
    };
  }
  if (frame.method === 'event') {
    const payload = frame.params?.payload && typeof frame.params.payload === 'object' ? frame.params.payload : {};
    return {
      jsonrpc: frame.jsonrpc,
      method: 'event',
      params: {
        type: frame.params?.type,
        session_id: frame.params?.session_id,
        payload: {
          status: payload.status,
          model: payload.model,
          provider: payload.provider,
          approval_mode: payload.approval_mode,
          version: payload.version,
          cwd: payload.cwd,
          stored_session_id: payload.stored_session_id,
          name: payload.name,
          tool_id: payload.tool_id,
          choice: payload.choice,
          choices: payload.choices,
          running: payload.running,
          pattern_key: payload.pattern_key,
          allow_permanent: payload.allow_permanent,
          allow_session: payload.allow_session,
          toolNames: payload.tools ? Object.keys(payload.tools) : undefined,
          usage: payload.usage
            ? {
                model: payload.usage.model,
                calls: payload.usage.calls,
                hasTotals: payload.usage.total != null,
              }
            : undefined,
          duration_s: payload.duration_s,
          result:
            payload.result && typeof payload.result === 'object'
              ? {
                  exit_code: payload.result.exit_code,
                  status: payload.result.status,
                  hasOutput: typeof payload.result.output === 'string',
                  hasError: payload.result.error != null,
                }
              : undefined,
          hasText: typeof payload.text === 'string',
          hasContext: typeof payload.context === 'string',
        },
      },
    };
  }
  return {
    jsonrpc: frame.jsonrpc,
    id: frame.id,
    result: frame.result
      ? {
          session_id: frame.result.session_id,
          stored_session_id: frame.result.stored_session_id,
          session_key: frame.result.session_key,
          resumed: frame.result.resumed,
          status: frame.result.status,
          resolved: frame.result.resolved,
          message_count: frame.result.message_count,
          running: frame.result.running,
        }
      : undefined,
    error: frame.error,
  };
}

export function sanitizeHermesCaptureSet(input, output, version = VERSION) {
  const scenarios = readdirSync(input, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  if (scenarios.length === 0) throw new Error(`no Hermes scenarios in ${input}`);
  mkdirSync(output, { recursive: true });

  for (const scenario of scenarios) {
    const source = join(input, scenario.name);
    const destination = join(output, scenario.name);
    writeJsonLines(join(destination, 'rpc.jsonl'), parseJsonLines(join(source, 'rpc.jsonl')).map(projectRpc));
    writeJsonLines(
      join(destination, 'provider-requests.jsonl'),
      parseJsonLines(join(source, 'provider-requests.jsonl')).map(projectProviderRequest),
    );
    writeJsonLines(join(destination, 'webhooks.jsonl'), parseJsonLines(join(source, 'webhooks.jsonl')).map(projectWebhook));
    writeJsonLines(join(destination, 'plugin-hooks.jsonl'), parseJsonLines(join(source, 'plugin-hooks.jsonl')).map(projectHook));
    if (existsSync(join(source, 'follow-ups.jsonl'))) {
      writeJsonLines(
        join(destination, 'follow-ups.jsonl'),
        parseJsonLines(join(source, 'follow-ups.jsonl')).map((record) => ({
          type: record.type,
          followUp: record.followUp,
          frame: {
            type: record.frame?.type,
            session_id: record.frame?.session_id,
            payload: {
              choices: record.frame?.payload?.choices,
              name: record.frame?.payload?.name,
            },
          },
        })),
      );
    }
    if (existsSync(join(source, 'session.json'))) {
      writeJson(join(destination, 'session.json'), JSON.parse(readFileSync(join(source, 'session.json'), 'utf8')));
    }
    writeJson(join(destination, 'capture.json'), {
      schemaVersion: 1,
      vendor: 'hermes',
      version,
      scenario: scenario.name,
      mode: 'tui-gateway-stdio-hermetic',
    });
  }
  return { scenarios: scenarios.length };
}

function flag(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  const version = flag('--version', VERSION);
  const input = resolve(flag('--input', join(vendorRoot, 'captures-raw', `hermes@${version}`)));
  const output = resolve(flag('--output', join(vendorRoot, 'captures', `hermes@${version}`)));

  if (process.argv.includes('--check')) {
    const issues = checkCaptureDirectory(output, hermesRules);
    for (const issue of issues.slice(0, 20)) console.error(issue);
    console.log(issues.length === 0 ? `clean: ${output}` : `${issues.length} issue(s) in ${output}`);
    process.exit(issues.length === 0 ? 0 : 1);
  }

  if (!existsSync(input) || !statSync(input).isDirectory()) throw new Error(`raw capture directory missing: ${input}`);
  const staging = `${output}.staging`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  const result = sanitizeHermesCaptureSet(input, staging, version);
  const issues = checkCaptureDirectory(staging, hermesRules);
  if (issues.length > 0) {
    for (const issue of issues.slice(0, 20)) console.error(issue);
    rmSync(staging, { recursive: true, force: true });
    throw new Error(`${issues.length} privacy issue(s); committed captures were not replaced`);
  }
  const sanitizationNote = join(output, 'SANITIZATION.md');
  const sanitizationText = existsSync(sanitizationNote) ? readFileSync(sanitizationNote, 'utf8') : '';
  rmSync(output, { recursive: true, force: true });
  mkdirSync(dirname(output), { recursive: true });
  renameSync(staging, output);
  if (sanitizationText) writeFileSync(join(output, 'SANITIZATION.md'), sanitizationText);
  console.log(`sanitized ${result.scenarios} Hermes scenario(s) -> ${output}`);
  console.log('privacy check: clean');
}

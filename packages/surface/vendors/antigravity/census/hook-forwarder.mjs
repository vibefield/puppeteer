#!/usr/bin/env node
/**
 * Observation-only hook forwarder for authorized Antigravity census.
 *
 * Writes one bounded stdin record and replies with the event's documented
 * no-op JSON. It never reads credentials or the user's home.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const event = process.argv[2];
const dir = process.env.PUPPETEER_AGY_HOOK_DIR;
if (!event || !dir) {
  process.stderr.write('hook-forwarder requires <event> and PUPPETEER_AGY_HOOK_DIR\n');
  process.exit(2);
}

const replies = {
  PreToolUse: { decision: 'allow' },
  PostToolUse: {},
  PreInvocation: {},
  PostInvocation: {},
  Stop: {},
};

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const raw = Buffer.concat(chunks).toString('utf8');
if (raw.length > 256 * 1024) {
  process.stderr.write('hook stdin exceeded 256KiB\n');
  process.exit(2);
}

mkdirSync(dir, { recursive: true, mode: 0o700 });
const stamped = new Date().toISOString().replaceAll(':', '');
writeFileSync(join(dir, `${event}.${stamped}.stdin.json`), raw.endsWith('\n') ? raw : `${raw}\n`, { mode: 0o600 });
let parsed;
try {
  parsed = raw.trim() ? JSON.parse(raw) : null;
} catch {
  parsed = { unparsed: true, bytes: raw.length };
}
appendFileSync(
  join(dir, 'hooks.jsonl'),
  `${JSON.stringify({ event, receivedAt: new Date().toISOString(), stdin: parsed })}\n`,
);
process.stdout.write(`${JSON.stringify(replies[event] ?? {})}\n`);

import { writeFileSync } from 'node:fs';

/** The one tool the probe server lists: a name no Grok built-in or user server shares. */
export const GROK_PROBE_TOOL = 'puppeteer_briefing_probe';

/**
 * A stdio MCP server for the briefing proofs, as one self-contained ES module source. It appends one JSON line per
 * event to the log named by its first argument: its start (with its own parent's pid, read by the server itself), each
 * request it is sent, and the end of its input. It answers `initialize`, `tools/list` (one tool) and `tools/call`.
 */
export function probeMcpServerSource(): string {
  return `
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const log = process.argv[2];
const note = (entry) => appendFileSync(log, JSON.stringify({ at: Date.now(), pid: process.pid, ...entry }) + '\\n');
note({ event: 'start', ppid: process.ppid, probeEnv: process.env.GROK_PROBE_ENV ?? null });
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');
const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  note({ event: 'request', method: message.method ?? null });
  if (message.id === undefined) return;
  if (message.method === 'initialize') {
    send({ id: message.id, result: {
      protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'puppeteer-briefing-probe', version: '1.0.0' },
    } });
  } else if (message.method === 'tools/list') {
    send({ id: message.id, result: { tools: [{
      name: '${GROK_PROBE_TOOL}',
      description: 'Answers pong. Used only by the briefing proof.',
      inputSchema: { type: 'object', properties: {} },
    }] } });
  } else if (message.method === 'tools/call') {
    send({ id: message.id, result: { content: [{ type: 'text', text: 'pong' }] } });
  } else {
    send({ id: message.id, error: { code: -32601, message: 'method not found' } });
  }
});
lines.on('close', () => { note({ event: 'end' }); process.exit(0); });
`;
}

export function writeProbeMcpServer(path: string): void {
  writeFileSync(path, probeMcpServerSource(), { encoding: 'utf8', mode: 0o600 });
}

export interface ProbeLogEntry {
  readonly at: number;
  readonly pid: number;
  readonly event: 'start' | 'request' | 'end';
  readonly ppid?: number;
  readonly method?: string | null;
  readonly probeEnv?: string | null;
}

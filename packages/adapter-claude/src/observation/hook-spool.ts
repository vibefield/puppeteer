/**
 * The starts a Claude process could not deliver while no bridge listened, read back at an attach.
 *
 * A launch whose host keeps attach records runs its command hooks with the forwarder word `claude.hook.v2`
 * (launch/forwarder.ts): a `SessionStart` that reaches no bridge is appended to the launch's spool as one line,
 * `{"v":1,"at","hook_event_name":"SessionStart","session_id","source","transcript_path"}`, with no bearer. Claude
 * runs `SessionStart` as a command hook and `SessionEnd` as an HTTP one (generated/registry.ts), so the spool holds the
 * starts alone: a `/clear` or an in-pane `/resume` typed while the host was down is a start under the new id.
 *
 * An attach takes the spool by renaming it beside itself (`<spool>.<n>.taken`): the rename is atomic, so a start a
 * forwarder appends after it lands in a new spool, the next attach's, or in the taken file when its forwarder opened
 * the spool before the rename. A taken file is never deleted here: the run's own cleanup removes the launch's files.
 *
 * Any holder of the run's bearer can post a start that moves the observer, and the agent can read the launch's
 * settings, which name the spool: a line written into it moves the observer no further than such a post would.
 */

import { Buffer } from 'node:buffer';
import { existsSync, openSync, readSync, closeSync, renameSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { CLAUDE_HOOK_SPOOL_MAX_BYTES, CLAUDE_HOOK_SPOOL_MAX_LINES } from '../launch/forwarder.js';
import { isClaudeSessionFileName } from '../launch/prepare.js';

/** One start the forwarder kept: when it ran, the session it started, and Claude's word for how. */
export interface ClaudeSpooledStart {
  at: string;
  sessionId: string;
  source?: string | undefined;
  transcriptPath?: string | undefined;
}

/** How many taken files beside one spool are looked past for a free name; past it, nothing is taken. */
const MAX_TAKEN = 1024;

function takenName(spoolPath: string): string | undefined {
  for (let n = 1; n <= MAX_TAKEN; n += 1) {
    const candidate = `${spoolPath}.${n}.taken`;
    if (!existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** The first bytes of a file, at most `limit`: the forwarder never writes past its bound, so the rest is not its. */
function readHead(path: string, limit: number): string {
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(limit);
    let length = 0;
    while (length < limit) {
      const read = readSync(fd, buffer, length, limit - length, length);
      if (read === 0) break;
      length += read;
    }
    return buffer.subarray(0, length).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/**
 * A kept start's time as the forwarder writes it (`toISOString()`), or undefined when it is no time: the replay says
 * the start at this time, and an event whose time the runtime cannot read is dropped there after the replay has
 * already moved the observer.
 */
function spooledTime(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return undefined;
  const iso = new Date(ms).toISOString();
  // A year past four digits is no time a forwarder wrote, and no ISO time the runtime reads.
  return /^\d{4}-/u.test(iso) ? iso : undefined;
}

function spooledStart(line: string): ClaudeSpooledStart | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  const row = parsed as Record<string, unknown>;
  if (row.v !== 1 || row.hook_event_name !== 'SessionStart') return undefined;
  if (typeof row.session_id !== 'string' || row.session_id.trim().length === 0) return undefined;
  // The id becomes a transcript's file name under the config root (locateClaudeTranscript): a bare name, or no start.
  if (!isClaudeSessionFileName(row.session_id)) return undefined;
  const at = spooledTime(row.at);
  if (at === undefined) return undefined;
  return {
    at,
    sessionId: row.session_id,
    ...(typeof row.source === 'string' ? { source: row.source } : {}),
    ...(typeof row.transcript_path === 'string' ? { transcriptPath: row.transcript_path } : {}),
  };
}

/**
 * Take the spool at `spoolPath` and read the starts it kept, in the order they ran. No spool (none was ever written,
 * or the last attach took it) reads as none. A line that does not parse is skipped: the last one may be torn by a
 * forwarder still writing it. So is a start whose session id is no bare name, or whose time is no time: the agent can
 * write the spool. Throws only when the path is not absolute, which no launch writes.
 */
export function takeClaudeHookSpool(spoolPath: string): ClaudeSpooledStart[] {
  if (!isAbsolute(spoolPath)) throw new Error('a Claude hook spool is named by an absolute path');
  if (!existsSync(spoolPath)) return [];
  const taken = takenName(spoolPath);
  if (taken === undefined) return [];
  try {
    renameSync(spoolPath, taken);
  } catch {
    // Gone between the look and the rename (an OS temp sweep), or not ours to move: nothing is taken.
    return [];
  }
  let text: string;
  try {
    text = readHead(taken, CLAUDE_HOOK_SPOOL_MAX_BYTES);
  } catch {
    return [];
  }
  const starts: ClaudeSpooledStart[] = [];
  for (const line of text.split('\n')) {
    if (starts.length >= CLAUDE_HOOK_SPOOL_MAX_LINES) break;
    if (line.trim().length === 0) continue;
    const start = spooledStart(line);
    if (start !== undefined) starts.push(start);
  }
  return starts;
}

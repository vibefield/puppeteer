/** Claude-only test support. Real payloads resolve from the neutral Surface package. */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { CLAUDE_SURFACE_VERSION } from '../generated/registry.js';

const require = createRequire(import.meta.url);
const surfaceRoot = dirname(require.resolve('@vibefield/puppeteer-surface/package.json'));
const captureRoot = join(surfaceRoot, 'vendors', 'claude', 'captures', `claude@${CLAUDE_SURFACE_VERSION}`);
const captureModes = ['init', 'headless', 'interactive'].filter((mode) => existsSync(join(captureRoot, mode)));

export interface CapturedHookRecord {
  session_id: string;
  transcript_path: string;
  cwd: string;
  hook_event_name: string;
  [key: string]: unknown;
}

export function listHookFixtureEvents(): string[] {
  return [
    ...new Set(
      captureModes.flatMap((mode) =>
        readdirSync(join(captureRoot, mode))
          .filter((file) => file.endsWith('.jsonl'))
          .map((file) => file.replace(/\.jsonl$/, '')),
      ),
    ),
  ].sort();
}

function parseJsonl(path: string): CapturedHookRecord[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as CapturedHookRecord);
}

export function loadHookFixtures(event?: string): CapturedHookRecord[] {
  const events = event ? [event] : listHookFixtureEvents();
  return events.flatMap((name) =>
    captureModes.flatMap((mode) => {
      const path = join(captureRoot, mode, `${name}.jsonl`);
      return existsSync(path) ? parseJsonl(path) : [];
    }),
  );
}

export function fakeClaudeHookPayload(event: string, overrides: Record<string, unknown> = {}): CapturedHookRecord {
  const sessionId = (overrides.session_id as string) ?? '00000000-0000-4000-8000-000000000000';
  return {
    session_id: sessionId,
    transcript_path: `/tmp/fake-agent/${sessionId}.jsonl`,
    cwd: '/tmp/fake-agent',
    hook_event_name: event,
    ...overrides,
  };
}

interface CaptureOrderingEntry {
  mode: string;
  seq: number;
  channel: string;
  hook?: string;
}

/**
 * One capture mode's hook records in the order the census sink received them, joined from the
 * value-free `ordering.json` projection (each entry names its hook; the per-event files keep
 * arrival order within a hook). Throws when the two disagree, so a replay never runs a guess.
 */
export function loadOrderedHookLane(mode: string): Array<{ seq: number; record: CapturedHookRecord }> {
  const ordering = JSON.parse(readFileSync(join(captureRoot, 'ordering.json'), 'utf8')) as {
    entries: CaptureOrderingEntry[];
  };
  const remaining = new Map(
    readdirSync(join(captureRoot, mode))
      .filter((file) => file.endsWith('.jsonl'))
      .map((file) => [file.replace(/\.jsonl$/, ''), parseJsonl(join(captureRoot, mode, file))] as const),
  );
  const lane = ordering.entries
    .filter((entry) => entry.mode === mode && entry.channel === 'hook')
    .sort((left, right) => left.seq - right.seq)
    .map((entry) => {
      const hook = entry.hook ?? 'unknown';
      const record = remaining.get(hook)?.shift();
      if (!record) throw new Error(`${mode} ordering names more ${hook} hooks than were captured`);
      return { seq: entry.seq, record };
    });
  for (const [hook, records] of remaining) {
    if (records.length > 0) throw new Error(`${mode} captured ${records.length} ${hook} hook(s) the ordering omits`);
  }
  return lane;
}

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  alias,
  checkCaptureDirectory,
  checkRecord,
  extendRules,
  REDACTED_EPOCH_MS,
  sanitizeCaptureDirectory,
  sanitizeRecord,
} from './sanitize.js';

describe('correlation — the property that makes a fixture replayable', () => {
  it('gives one value one pseudonym, whatever key it appears under', () => {
    const uuid = '019f5d86-423a-7083-ab79-2deb044599c1';
    const out = sanitizeRecord({ id: uuid, sessionId: uuid, threadId: uuid, nested: { turnId: uuid } }) as Record<
      string,
      unknown
    >;
    const values = [out.id, out.sessionId, out.threadId, (out.nested as Record<string, unknown>).turnId];
    expect(new Set(values).size).toBe(1);
    // Shape-faithful: a uuid in yields a uuid out, so fixtures keep the
    // vendor format downstream tests legitimately assert on.
    expect(values[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('leaves numeric JSON-RPC ids untouched, so request↔response joins survive', () => {
    const out = sanitizeRecord({ id: 2, method: 'thread/start' }) as Record<string, unknown>;
    expect(out.id).toBe(2);
  });

  it('preserves short decimal turn/step counters across string and numeric carriers', () => {
    const out = sanitizeRecord({ stream: { turnId: '0', step_id: '12' }, terminal: { turnId: 0 } }) as Record<
      string,
      Record<string, unknown>
    >;
    expect(out.stream).toEqual({ turnId: '0', step_id: '12' });
    expect(out.terminal).toEqual({ turnId: 0 });
    expect(checkRecord(out)).toEqual([]);
    expect(sanitizeRecord({ turnId: '1786346001309' })).not.toEqual({ turnId: '1786346001309' });
  });

  it('keeps a vendor-declared structural value under an id key in both redaction and detection', () => {
    const rules = extendRules({ structuralEnumValue: /^main$/ });
    const out = sanitizeRecord({ agentId: 'main', parentAgentId: 'agent-7' }, rules) as Record<string, unknown>;
    expect(out.agentId).toBe('main');
    expect(out.parentAgentId).toMatch(/^anon-[0-9a-f]{16}$/);
    expect(checkRecord(out, rules)).toEqual([]);
    expect(checkRecord({ agentId: 'agent-7' }, rules)).not.toEqual([]);
  });

  it('is idempotent — re-sanitizing a fixture changes nothing', () => {
    const record = { threadId: '019f5d86-423a-7083-ab79-2deb044599c1', cwd: '/Users/someone/repo', text: 'hello' };
    const once = sanitizeRecord(record);
    expect(sanitizeRecord(once)).toEqual(once);
  });
});

describe('regressions from the real codex capture (2026-08-07)', () => {
  // Each case below was left INTACT by the pre-2026-08-07 sanitizer while its
  // privacy check reported the file clean. They are the reason the defaults
  // are broad.
  const leaky = {
    threadId: '019f5d86-423a-7083-ab79-2deb044599c1',
    installationId: '33dd9f00-3399-4a62-8fe3-0dd23055b087',
    serverName: 'Operators-MacBook-Pro.local',
    userAgent: 'probe/0.144.2 (Mac OS 26.5.1; arm64) ghostty/1.3.1',
    codexHome: '/Users/operator/.codex',
    diskCheck: 'rollout session_meta.session_id=019f5d86-423a-7083-ab79-2deb044599c1 :: matches',
    params: { input: [{ type: 'text', text: 'Reply with exactly the single word: pong.' }] },
    tmp: '/var/folders/hs/j754ys991yd3bss5c87lf0m40000gn/T/probe',
  };

  it('the detector flags every one of them on raw input', () => {
    const issues = checkRecord(leaky).join('\n');
    for (const key of ['threadId', 'installationId', 'serverName', 'userAgent', 'codexHome']) {
      expect(issues, `${key} not flagged`).toContain(key);
    }
    expect(issues).toContain('raw UUID');
  });

  it('the redactor removes them, and the detector then passes', () => {
    const clean = JSON.stringify(sanitizeRecord(leaky));
    expect(clean).not.toContain('Operators-MacBook-Pro');
    expect(clean).not.toContain('ghostty/');
    expect(clean).not.toContain('/Users/operator');
    expect(clean).not.toContain('Reply with exactly');
    expect(clean).not.toContain('33dd9f00-3399');
    expect(clean).not.toContain('var/folders/hs');
    // The ORIGINAL uuid is gone, and what replaces it is v4-shaped: never
    // v7, whose leading bits would re-encode the capture time.
    expect(clean).not.toContain('019f5d86-423a-7083');
    expect(clean).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/i);
    expect(checkRecord(sanitizeRecord(clean === '' ? {} : JSON.parse(clean)))).toEqual([]);
  });

  it('aliases a uuid embedded in free text rather than walking past it', () => {
    const out = sanitizeRecord({ diskCheck: leaky.diskCheck }) as Record<string, string>;
    expect(out.diskCheck).not.toContain('019f5d86');
    // Embedded and bare occurrences of the same id agree, so the join survives.
    expect(out.diskCheck).toContain(alias('019f5d86-423a-7083-ab79-2deb044599c1'));
  });
});

describe('redactor and detector stay in lockstep', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'puppeteer-sanitize-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('sanitize → check round-trips to zero issues on a JSON-RPC transcript', () => {
    const transcript = [
      { dt: 0, dir: 'send', msg: { id: 1, method: 'initialize', params: { clientInfo: { name: 'probe' } } } },
      { dt: 12, dir: 'recv', msg: { id: 1, result: { codexHome: '/Users/someone/.codex' } } },
      {
        dt: 30,
        dir: 'recv',
        msg: { method: 'thread/started', params: { threadId: '019f5d86-423a-7083-ab79-2deb044599c1' } },
      },
    ];
    writeFileSync(join(dir, 'capture.jsonl'), transcript.map((r) => JSON.stringify(r)).join('\n') + '\n');
    expect(checkCaptureDirectory(dir).length).toBeGreaterThan(0);
    sanitizeCaptureDirectory(dir);
    expect(checkCaptureDirectory(dir)).toEqual([]);
    // The envelope is metadata and must survive so the capture stays ordered.
    const first = JSON.parse(readFileSync(join(dir, 'capture.jsonl'), 'utf8').split('\n')[0]!);
    expect(first).toMatchObject({ dt: 0, dir: 'send' });
    expect(first.msg.method).toBe('initialize');
  });
});

describe('absolute temp roots', () => {
  // A relocated TMPDIR under /private/tmp names the uid and, slug-encoded, the
  // operator's checkout. A committed codex capture carried one under
  // `runtimeWorkspaceRoots`, which no path key named, and the check passed.
  const leaked = {
    runtimeWorkspaceRoots: ['/private/tmp/claude-501/-Users-<redacted>-Projects-private-name/scratch/cwd'],
    note: 'cd /tmp/probe-home-x8Yq && ls',
  };

  it('the detector flags /tmp and /private/tmp paths under any key, embedded or bare', () => {
    const issues = checkRecord(leaked);
    expect(issues).toEqual([
      expect.stringContaining('unsafe text at runtimeWorkspaceRoots'),
      expect.stringContaining('unsafe text at note'),
    ]);
  });

  it('the redactor removes them, and the detector then passes', () => {
    const clean = sanitizeRecord(leaked) as { runtimeWorkspaceRoots: string[]; note: string };
    expect(clean.runtimeWorkspaceRoots).toEqual(['/workspace/redacted-path']);
    expect(clean.note).toBe('cd /workspace/redacted-path && ls');
    expect(checkRecord(clean)).toEqual([]);
    expect(sanitizeRecord(clean)).toEqual(clean);
  });

  it('treats a file URL as the local temp path it names', () => {
    // A file URL's path is local, so the slash before it is not a URL path's.
    const raw = {
      note: 'attached file:///private/tmp/agent-1001/-Users-bob-secretproj/a.png',
      image: 'file:///tmp/probe-home-x8Yq/shot.png',
      local: 'file://localhost/private/tmp/agent-1001/x',
    };
    // Redacting the slug alone leaves the uid and the checkout name behind.
    const slugOnly = { note: 'attached file:///private/tmp/agent-1001/-Users-<redacted>-secretproj/a.png' };
    expect(checkRecord(slugOnly)).toEqual([expect.stringContaining('unsafe text at note')]);
    expect(checkRecord(raw)).toEqual([
      expect.stringContaining('unsafe text at note'),
      expect.stringContaining('unsafe text at image'),
      expect.stringContaining('unsafe text at local'),
    ]);
    const clean = sanitizeRecord(raw);
    expect(clean).toEqual({
      note: 'attached file:///workspace/redacted-path',
      image: 'file:///workspace/redacted-path',
      local: 'file://localhost/workspace/redacted-path',
    });
    expect(checkRecord(clean)).toEqual([]);
    expect(sanitizeRecord(clean)).toEqual(clean);
  });

  it('leaves other temp-like and URL paths alone', () => {
    const benign = {
      label: 'see /var/tmp/cache and https://example.invalid/tmp/x',
      remote: 'file://fileserver/tmp/shared and file:///var/tmp/cache',
      relative: 'build/tmp/out',
      flag: 'excludeSlashTmp',
    };
    expect(checkRecord(benign)).toEqual([]);
    expect(sanitizeRecord(benign)).toEqual(benign);
  });
});

describe('extendRules', () => {
  it('adds vendor keys without dropping the defaults', () => {
    const rules = extendRules({ sensitiveTextKey: /^vendorSecret$/ });
    const out = sanitizeRecord({ vendorSecret: 'hunter2', prompt: 'hello' }, rules) as Record<string, string>;
    expect(out.vendorSecret).toBe('<redacted:vendorSecret>');
    expect(out.prompt).toBe('<redacted:prompt>');
  });
});

describe('numeric wall-clock timestamps', () => {
  it('pins a numeric clock that no string pattern could reach', () => {
    // Codex ids are UUIDv7 and get aliased into synthetic v4s precisely to
    // destroy the clock they encode; `startedAtMs` beside them hands it back.
    const sanitized = sanitizeRecord({ itemId: 'exec-abc', startedAtMs: 1786207526734 }) as Record<string, unknown>;
    expect(sanitized.startedAtMs).toBe(REDACTED_EPOCH_MS);
    expect(new Date(sanitized.startedAtMs as number).toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('detects an unpinned clock, so the redactor cannot silently stop working', () => {
    expect(checkRecord({ startedAtMs: 1786207526734 })).toEqual([
      expect.stringContaining('unpinned wall-clock timestamp at startedAtMs'),
    ]);
    expect(checkRecord({ startedAtMs: REDACTED_EPOCH_MS })).toEqual([]);
  });

  it('leaves small integers under a timestamp-shaped key alone', () => {
    // `durationMs` is not a clock, and a fixture that zeroes it stops being
    // shape-faithful for anything that asserts on elapsed time.
    const sanitized = sanitizeRecord({ elapsedTime: 42, createdAt: 5 }) as Record<string, unknown>;
    expect(sanitized).toEqual({ elapsedTime: 42, createdAt: 5 });
  });

  it("pins a camelCase `…Time` clock such as copilot's epoch-ms `sessionStartTime`", () => {
    const raw = { accountingSnapshot: { sessionStartTime: 1793733259769, totalApiDurationMs: 4200 } };
    expect(checkRecord(raw)).toEqual([expect.stringContaining('unpinned wall-clock timestamp at sessionStartTime')]);
    const sanitized = sanitizeRecord(raw);
    expect(sanitized).toEqual({
      accountingSnapshot: { sessionStartTime: REDACTED_EPOCH_MS, totalApiDurationMs: 4200 },
    });
    expect(checkRecord(sanitized)).toEqual([]);
  });

  it('redacts the ISO-string form of a clock under a vendor text rule', () => {
    const rules = extendRules({ sensitiveTextKey: /^(?:sessionStartTime|resumeTime)$/ });
    const sanitized = sanitizeRecord(
      { sessionStartTime: '2026-11-03T19:14:19.769Z', resumeTime: '2026-11-03T19:14:26.626Z' },
      rules,
    );
    expect(sanitized).toEqual({ sessionStartTime: '<redacted:sessionStartTime>', resumeTime: '<redacted:resumeTime>' });
    expect(checkRecord(sanitized, rules)).toEqual([]);
  });

  it('flags an unpinned `sessionStartTime` in a capture directory until it is sanitised', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sanitize-time-'));
    try {
      writeFileSync(join(dir, 'events.jsonl'), `${JSON.stringify({ data: { sessionStartTime: 1793733259769 } })}\n`);
      expect(checkCaptureDirectory(dir)).toEqual([expect.stringContaining('unpinned wall-clock timestamp')]);
      sanitizeCaptureDirectory(dir);
      expect(checkCaptureDirectory(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('UUID-keyed maps', () => {
  // Copilot 1.0.105's `session.shutdown` keys its usage watermarks by the session UUID.
  const sessionId = '902724a7-80ac-4b9c-bd90-691a8cd00805';

  it('aliases a UUID key with the same pseudonym as the matching value', () => {
    const sanitized = sanitizeRecord({ data: { sessionId, usageAccountingWatermarks: { [sessionId]: 2 } } }) as {
      data: { sessionId: string; usageAccountingWatermarks: Record<string, number> };
    };
    expect(sanitized.data.sessionId).toBe(alias(sessionId));
    expect(sanitized.data.sessionId.startsWith('a11a5ed0-')).toBe(true);
    expect(sanitized.data.usageAccountingWatermarks).toEqual({ [alias(sessionId)]: 2 });
    expect(JSON.stringify(sanitized)).not.toContain(sessionId);
    expect(checkRecord(sanitized)).toEqual([]);
    expect(sanitizeRecord(sanitized)).toEqual(sanitized);
  });

  it('aliases a UUID embedded in a longer key', () => {
    expect(sanitizeRecord({ byFile: { [`session-${sessionId}.jsonl`]: 1 } })).toEqual({
      byFile: { [`session-${alias(sessionId)}.jsonl`]: 1 },
    });
  });

  it('detects a raw UUID that survives only as an object key, without echoing it', () => {
    const issues = checkRecord({
      data: { sessionId: alias(sessionId), usageAccountingWatermarks: { [sessionId]: 2 } },
    });
    expect(issues).toEqual([expect.stringContaining('raw UUID in object key under usageAccountingWatermarks')]);
    expect(issues.join('\n')).not.toContain(sessionId);
  });
});

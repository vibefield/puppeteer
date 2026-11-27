import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CLAUDE_FORWARDER_EXIT_UNKNOWN_WORD,
  CLAUDE_FORWARDER_WORDS,
  CLAUDE_HOOK_FORWARDER_WORD,
  CLAUDE_HOOK_SPOOL_FORWARDER_WORD,
  CLAUDE_HOOK_SPOOL_MAX_BYTES,
  CLAUDE_HOOK_SPOOL_MAX_LINES,
  CLAUDE_STATUS_LINE_FORWARDER_WORD,
  CLAUDE_STATUS_LINE_SUBAGENT,
  runClaudeForwarder,
  type ClaudeForwarderIo,
} from './forwarder.js';

interface Received {
  path: string;
  authorization: string | undefined;
  contentType: string | undefined;
  body: string;
}

/** What one run of the forwarder read and wrote: its stdin is `input`, its stderr is kept. */
function io(input: string, env: NodeJS.ProcessEnv, cwd = tmpdir()): ClaudeForwarderIo & { errors: string[] } {
  const errors: string[] = [];
  return {
    stdin: (async function* () {
      yield Buffer.from(input, 'utf8');
    })(),
    env,
    cwd,
    stderr: { write: (text: string) => errors.push(text) },
    errors,
  };
}

describe('the Claude forwarder', () => {
  let server: Server;
  let received: Received[];
  let status: number;
  let origin: string;

  beforeEach(async () => {
    received = [];
    status = 200;
    server = createServer((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => (body += chunk));
      req.on('end', () => {
        received.push({
          path: req.url ?? '',
          authorization: req.headers.authorization,
          contentType: req.headers['content-type'],
          body,
        });
        res.writeHead(status).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  it('ships exactly these words: the table is append-only across releases', () => {
    // A Claude launched by one build runs the forwarder a later build ships. A shipped word keeps its arguments
    // and meaning for good; a change is a new word, added here.
    expect(CLAUDE_FORWARDER_WORDS).toEqual(['claude.hook.v1', 'claude.statusline.v1', 'claude.hook.v2']);
    expect(CLAUDE_HOOK_FORWARDER_WORD).toBe('claude.hook.v1');
    expect(CLAUDE_STATUS_LINE_FORWARDER_WORD).toBe('claude.statusline.v1');
    expect(CLAUDE_STATUS_LINE_SUBAGENT).toBe('subagent');
    expect(CLAUDE_HOOK_SPOOL_FORWARDER_WORD).toBe('claude.hook.v2');
  });

  describe('claude.hook.v1 <endpoint> <token variable> <timeout ms>', () => {
    const body = JSON.stringify({
      session_id: 's-1',
      hook_event_name: 'SessionStart',
      source: 'startup',
      note: '模型 🌱',
    });

    it('relays stdin to the endpoint with the bearer its variable names, byte for byte', async () => {
      const run = io(body, { PUPPETEER_HOOK_TOKEN: 'sekrit' });
      await expect(
        runClaudeForwarder(['claude.hook.v1', `${origin}/hooks`, 'PUPPETEER_HOOK_TOKEN', '5000'], run),
      ).resolves.toBe(0);
      expect(received).toEqual([
        { path: '/hooks', authorization: 'Bearer sekrit', contentType: 'application/json', body },
      ]);
      expect(run.errors).toEqual([]);
    });

    it('posts nothing and exits 2 without its token', async () => {
      await expect(
        runClaudeForwarder(['claude.hook.v1', `${origin}/hooks`, 'PUPPETEER_HOOK_TOKEN', '5000'], io(body, {})),
      ).resolves.toBe(2);
      await expect(runClaudeForwarder(['claude.hook.v1'], io(body, { PUPPETEER_HOOK_TOKEN: 'sekrit' }))).resolves.toBe(
        2,
      );
      expect(received).toEqual([]);
    });

    it('exits 1 when the bridge refuses the post or cannot be reached', async () => {
      status = 401;
      const env = { PUPPETEER_HOOK_TOKEN: 'sekrit' };
      await expect(
        runClaudeForwarder(['claude.hook.v1', `${origin}/hooks`, 'PUPPETEER_HOOK_TOKEN', '5000'], io(body, env)),
      ).resolves.toBe(1);
      await expect(
        runClaudeForwarder(
          ['claude.hook.v1', 'http://127.0.0.1:1/hooks', 'PUPPETEER_HOOK_TOKEN', '5000'],
          io(body, env),
        ),
      ).resolves.toBe(1);
    });
  });

  describe('claude.hook.v2 <endpoint> <token variable> <timeout ms> <spool path>', () => {
    const start = {
      session_id: 's-cleared',
      transcript_path: '/root/projects/-tmp/s-cleared.jsonl',
      cwd: '/tmp',
      hook_event_name: 'SessionStart',
      source: 'clear',
      model: 'claude-opus',
    };
    const env = { PUPPETEER_HOOK_TOKEN: 'sekrit' };
    const down = 'http://127.0.0.1:1/hooks';
    let dir: string;
    let spool: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'claude-forwarder-spool-'));
      spool = join(dir, 'launch.hook-spool.jsonl');
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));
    const v2 = (endpoint: string, document: object, environment: NodeJS.ProcessEnv = env) =>
      runClaudeForwarder(
        ['claude.hook.v2', endpoint, 'PUPPETEER_HOOK_TOKEN', '5000', spool],
        io(JSON.stringify(document), environment),
      );

    it('relays as v1 does, and keeps nothing a bridge answered, whatever its status', async () => {
      await expect(v2(`${origin}/hooks`, start)).resolves.toBe(0);
      expect(received).toEqual([
        {
          path: '/hooks',
          authorization: 'Bearer sekrit',
          contentType: 'application/json',
          body: JSON.stringify(start),
        },
      ]);
      status = 401;
      await expect(v2(`${origin}/hooks`, start)).resolves.toBe(1);
      expect(existsSync(spool)).toBe(false);
    });

    it('keeps a start no bridge was there for as one line, owner-only, with no bearer', async () => {
      await expect(v2(down, start)).resolves.toBe(1);
      const text = readFileSync(spool, 'utf8');
      expect(text.endsWith('\n')).toBe(true);
      expect(text.split('\n')).toHaveLength(2);
      const kept = JSON.parse(text) as Record<string, unknown>;
      expect(kept).toEqual({
        v: 1,
        at: expect.any(String),
        hook_event_name: 'SessionStart',
        session_id: 's-cleared',
        source: 'clear',
        transcript_path: '/root/projects/-tmp/s-cleared.jsonl',
      });
      expect(Number.isNaN(Date.parse(kept.at as string))).toBe(false);
      expect(text).not.toContain('sekrit');
      if (process.platform !== 'win32') expect(statSync(spool).mode & 0o777).toBe(0o600);
      // the next one appends after it
      await expect(v2(down, { ...start, session_id: 's-next' })).resolves.toBe(1);
      expect(
        readFileSync(spool, 'utf8')
          .trimEnd()
          .split('\n')
          .map((row) => (JSON.parse(row) as { session_id: string }).session_id),
      ).toEqual(['s-cleared', 's-next']);
    });

    it('keeps only a start, with a session id, and nothing without its bearer', async () => {
      await expect(v2(down, { ...start, hook_event_name: 'Stop' })).resolves.toBe(1);
      await expect(v2(down, { ...start, session_id: '' })).resolves.toBe(1);
      await expect(
        runClaudeForwarder(['claude.hook.v2', down, 'PUPPETEER_HOOK_TOKEN', '5000', spool], io('not json', env)),
      ).resolves.toBe(1);
      await expect(v2(down, start, {})).resolves.toBe(2);
      expect(existsSync(spool)).toBe(false);
    });

    it('keeps no more than 256 starts, nor more than 64 KiB', async () => {
      const row = `${JSON.stringify({ v: 1, at: 'x', hook_event_name: 'SessionStart', session_id: 'old' })}\n`;
      writeFileSync(spool, row.repeat(CLAUDE_HOOK_SPOOL_MAX_LINES));
      await expect(v2(down, start)).resolves.toBe(1);
      expect(readFileSync(spool, 'utf8')).not.toContain('s-cleared');
      writeFileSync(spool, `${'x'.repeat(CLAUDE_HOOK_SPOOL_MAX_BYTES - 10)}\n`);
      await expect(v2(down, start)).resolves.toBe(1);
      expect(readFileSync(spool, 'utf8')).not.toContain('s-cleared');
      expect(CLAUDE_HOOK_SPOOL_MAX_LINES).toBe(256);
      expect(CLAUDE_HOOK_SPOOL_MAX_BYTES).toBe(64 * 1024);
    });

    it('keeps nothing, and still answers, when the spool’s folder is gone', async () => {
      spool = join(dir, 'gone', 'launch.hook-spool.jsonl');
      await expect(v2(down, start)).resolves.toBe(1);
      expect(existsSync(spool)).toBe(false);
    });
  });

  describe.skipIf(process.platform === 'win32')('claude.statusline.v1 [subagent]', () => {
    const body = JSON.stringify({ session_id: 's-1', context_window: { context_window_size: 200000 } });

    it('posts the line to its endpoint and runs the person’s own line beside it, returning its exit', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'claude-forwarder-status-'));
      try {
        const copy = join(dir, 'delegate-input.json');
        const run = io(
          body,
          {
            PATH: process.env.PATH,
            PUPPETEER_STATUSLINE_ENDPOINT: `${origin}/statusline`,
            PUPPETEER_STATUSLINE_DELEGATE: `cat > ${JSON.stringify(copy)}; exit 3`,
            PUPPETEER_STATUSLINE_TOKEN_ENV_VAR: 'PUPPETEER_HOOK_TOKEN',
            PUPPETEER_STATUSLINE_TIMEOUT_MS: '5000',
            PUPPETEER_HOOK_TOKEN: 'sekrit',
          },
          dir,
        );
        await expect(runClaudeForwarder(['claude.statusline.v1'], run)).resolves.toBe(3);
        expect(received).toEqual([
          { path: '/statusline', authorization: 'Bearer sekrit', contentType: 'application/json', body },
        ]);
        expect(readFileSync(copy, 'utf8')).toBe(body);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('the child line reads its own endpoint and delegate, never the root line’s', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'claude-forwarder-child-status-'));
      try {
        const copy = join(dir, 'child-input.json');
        const run = io(
          body,
          {
            PATH: process.env.PATH,
            PUPPETEER_STATUSLINE_ENDPOINT: `${origin}/statusline`,
            PUPPETEER_STATUSLINE_DELEGATE: 'exit 9',
            PUPPETEER_SUBAGENT_STATUSLINE_ENDPOINT: `${origin}/subagent-statusline`,
            PUPPETEER_SUBAGENT_STATUSLINE_DELEGATE: `cat > ${JSON.stringify(copy)}`,
            PUPPETEER_STATUSLINE_TOKEN_ENV_VAR: 'PUPPETEER_HOOK_TOKEN',
            PUPPETEER_STATUSLINE_TIMEOUT_MS: '5000',
            PUPPETEER_HOOK_TOKEN: 'sekrit',
          },
          dir,
        );
        await expect(runClaudeForwarder(['claude.statusline.v1', 'subagent'], run)).resolves.toBe(0);
        expect(received.map(({ path }) => path)).toEqual(['/subagent-statusline']);
        expect(readFileSync(copy, 'utf8')).toBe(body);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('with no line of the person’s and no token it posts nothing and exits 0', async () => {
      await expect(
        runClaudeForwarder(
          ['claude.statusline.v1'],
          io(body, { PUPPETEER_STATUSLINE_ENDPOINT: `${origin}/statusline` }),
        ),
      ).resolves.toBe(0);
      expect(received).toEqual([]);
    });

    it('a line of the person’s that never reads its input still answers with its exit', async () => {
      await expect(
        runClaudeForwarder(
          ['claude.statusline.v1'],
          io('x'.repeat(1 << 20), { PUPPETEER_STATUSLINE_DELEGATE: 'exit 4' }),
        ),
      ).resolves.toBe(4);
    });
  });

  it('answers a word it does not know with one line and 127, forwarding nothing', async () => {
    for (const argv of [['claude.hook.v0', `${origin}/hooks`, 'TOKEN', '5000'], ['constructor'], []]) {
      const run = io('{}', { TOKEN: 'sekrit' });
      await expect(runClaudeForwarder(argv, run), argv.join(' ')).resolves.toBe(CLAUDE_FORWARDER_EXIT_UNKNOWN_WORD);
      expect(run.errors, argv.join(' ')).toHaveLength(1);
      expect(run.errors[0]!.endsWith('\n')).toBe(true);
      expect(run.errors[0]).not.toContain('sekrit');
    }
    expect(CLAUDE_FORWARDER_EXIT_UNKNOWN_WORD).toBe(127);
    expect(received).toEqual([]);
  });
});

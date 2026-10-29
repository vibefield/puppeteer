import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectClaude } from '../detection.js';
import { CLAUDE_SURFACE_VERSION } from '../generated/registry.js';
import { isolatedClaudeExec, requireClaudeLiveExecutable } from './live-executable.js';

describe('requireClaudeLiveExecutable', () => {
  it('fails clearly instead of falling back to `claude` on PATH', () => {
    expect(() => requireClaudeLiveExecutable({})).toThrow(/PUPPETEER_CLAUDE_BIN=.*never fall back to `claude` on PATH/);
    expect(() => requireClaudeLiveExecutable({ PUPPETEER_CLAUDE_BIN: '  ' })).toThrow(/never fall back/);
  });

  it('refuses a bare command name, which PATH would resolve', () => {
    expect(() => requireClaudeLiveExecutable({ PUPPETEER_CLAUDE_BIN: 'claude' })).toThrow(/not a command resolved/);
  });

  it('returns the configured artifact as an absolute path', () => {
    expect(requireClaudeLiveExecutable({ PUPPETEER_CLAUDE_BIN: '/opt/artifacts/claude' })).toBe(
      resolve('/opt/artifacts/claude'),
    );
    expect(requireClaudeLiveExecutable({ PUPPETEER_CLAUDE_BIN: './artifacts/claude' })).toBe(
      resolve('./artifacts/claude'),
    );
  });
});

describe('isolatedClaudeExec', () => {
  const roots: string[] = [];
  const parentProbe = process.env.PUPPETEER_CLAUDE_LIVE_PARENT_PROBE;
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    if (parentProbe === undefined) delete process.env.PUPPETEER_CLAUDE_LIVE_PARENT_PROBE;
    else process.env.PUPPETEER_CLAUDE_LIVE_PARENT_PROBE = parentProbe;
  });

  // The stand-in is a POSIX shell script; Windows cannot execute it without a shell, which the probe
  // deliberately never uses. The Windows promotion lane exercises the same path with the real artifact.
  it.skipIf(process.platform === 'win32')(
    'probes with only the isolated environment, never the parent HOME or variables',
    async () => {
      const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'puppeteer-claude-exec-')));
      roots.push(root);
      const seen = join(root, 'seen');
      const fake = join(root, 'claude');
      // A stand-in executable: answers the probes and records the environment it was given.
      writeFileSync(
        fake,
        `#!/bin/sh
printf '%s|%s|%s\\n' "$HOME" "$CLAUDE_CONFIG_DIR" "\${PUPPETEER_CLAUDE_LIVE_PARENT_PROBE-unset}" >> '${seen}'
case "$1" in
  --version) echo '${CLAUDE_SURFACE_VERSION} (Claude Code)' ;;
  *) echo '--session-id --settings --setting-sources -n, --name --permission-mode --resume --model --effort --mcp-config --allowedTools --append-system-prompt-file --system-prompt-snapshot' ;;
esac
`,
        { mode: 0o700 },
      );
      process.env.PUPPETEER_CLAUDE_LIVE_PARENT_PROBE = 'parent';
      const home = join(root, 'home');
      const configDir = join(root, 'claude-config');

      const detection = await detectClaude({
        executable: fake,
        exec: isolatedClaudeExec({ PATH: '/usr/bin:/bin', HOME: home, CLAUDE_CONFIG_DIR: configDir }),
      });

      expect(detection.version).toBe(CLAUDE_SURFACE_VERSION);
      expect(detection.warnings).toEqual([]);
      expect(readFileSync(seen, 'utf8').trimEnd().split('\n')).toEqual([
        `${home}|${configDir}|unset`,
        `${home}|${configDir}|unset`,
      ]);
    },
  );

  it('refuses an environment that leaves HOME or CLAUDE_CONFIG_DIR to the account', () => {
    expect(() => isolatedClaudeExec({ PATH: '/usr/bin', CLAUDE_CONFIG_DIR: '/tmp/config' })).toThrow(/explicit HOME/);
    expect(() => isolatedClaudeExec({ PATH: '/usr/bin', HOME: '/tmp/home' })).toThrow(/explicit CLAUDE_CONFIG_DIR/);
  });
});

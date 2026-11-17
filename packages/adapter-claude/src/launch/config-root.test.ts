import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { claudeConfigDirectory, claudeConfigRoot } from './config-root.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('claudeConfigRoot', () => {
  const cwd = resolve('/work/repo');

  it('reads one root as the launched process does: an explicit dir, the launch environment, this process, the home', () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', resolve('/process/claude'));
    const launch = { CLAUDE_CONFIG_DIR: resolve('/launch/claude') };
    expect(claudeConfigRoot({ cwd, configDir: resolve('/explicit'), env: launch })).toBe(resolve('/explicit'));
    expect(claudeConfigRoot({ cwd, env: launch })).toBe(resolve('/launch/claude'));
    expect(claudeConfigRoot({ cwd })).toBe(resolve('/process/claude'));
    // a relative dir is Claude's from the launch's cwd
    expect(claudeConfigRoot({ cwd, configDir: 'claude-work' })).toBe(join(cwd, 'claude-work'));
    vi.stubEnv('CLAUDE_CONFIG_DIR', undefined);
    const home = resolve('/home/person');
    expect(claudeConfigRoot({ cwd, home })).toBe(join(home, '.claude'));
    expect(claudeConfigRoot({ cwd })).toBe(join(homedir(), '.claude'));
    // a blank name names nothing
    expect(claudeConfigRoot({ cwd, configDir: '  ', home })).toBe(join(home, '.claude'));
    // the imposter keeps the same layout under its own state root, whatever else is named
    expect(
      claudeConfigRoot({ cwd, configDir: resolve('/explicit'), env: { PUPPETEER_IMPOSTER_HOME: 'imposter' } }),
    ).toBe(join(cwd, 'imposter'));
  });

  it('names no config dir when none is given, so a launch passes none', () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', undefined);
    expect(claudeConfigDirectory({ cwd })).toBeUndefined();
    expect(claudeConfigDirectory({ cwd, env: { CLAUDE_CONFIG_DIR: 'relative' } })).toBe(join(cwd, 'relative'));
    // the imposter's root is not a config dir: the launch keeps the environment it was given
    expect(claudeConfigDirectory({ cwd, env: { PUPPETEER_IMPOSTER_HOME: resolve('/imposter') } })).toBeUndefined();
  });
});

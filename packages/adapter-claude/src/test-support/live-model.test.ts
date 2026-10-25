import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claudeTrustedProjectKeys, isolatedClaudeLiveEnvironment } from './live-model.js';

describe('claudeTrustedProjectKeys', () => {
  it('trusts the working directory as it is spelled on POSIX', () => {
    expect(claudeTrustedProjectKeys('/tmp/live/workspace', 'darwin')).toEqual(['/tmp/live/workspace']);
    expect(claudeTrustedProjectKeys('/tmp/live/workspace', 'linux', '/tmp/live/workspace')).toEqual([
      '/tmp/live/workspace',
    ]);
  });

  // The hosted windows-2025 lane stopped at the trust prompt with only the backslashed short-name key written.
  it('trusts the forward-slash key Claude looks up on Windows, under the short and the long name', () => {
    const short = 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\puppeteer-claude-live-CUO4mt\\workspace';
    const long = 'C:\\Users\\runneradmin\\AppData\\Local\\Temp\\puppeteer-claude-live-CUO4mt\\workspace';
    const keys = claudeTrustedProjectKeys(short, 'win32', long);
    expect(keys).toEqual(
      expect.arrayContaining([
        short,
        'C:/Users/RUNNER~1/AppData/Local/Temp/puppeteer-claude-live-CUO4mt/workspace',
        'C:/Users/runneradmin/AppData/Local/Temp/puppeteer-claude-live-CUO4mt/workspace',
        'c:/Users/runneradmin/AppData/Local/Temp/puppeteer-claude-live-CUO4mt/workspace',
      ]),
    );
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('isolatedClaudeLiveEnvironment', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('records onboarding and workspace trust only in its own config directory', () => {
    const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'puppeteer-claude-model-')));
    roots.push(root);
    const cwd = join(root, 'workspace');
    mkdirSync(cwd);
    const configDir = join(root, 'claude-config');
    const environment = isolatedClaudeLiveEnvironment(root, configDir, cwd, 'http://127.0.0.1:1');
    expect(environment.CLAUDE_CONFIG_DIR).toBe(configDir);
    const state = JSON.parse(readFileSync(join(configDir, '.claude.json'), 'utf8'));
    expect(state.hasCompletedOnboarding).toBe(true);
    for (const key of claudeTrustedProjectKeys(cwd, process.platform, realpathSync.native(cwd))) {
      expect(state.projects[key]?.hasTrustDialogAccepted, key).toBe(true);
    }
  });
});

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  inspectOpenCodeVersion,
  OPENCODE_LAUNCH_FLAGS,
  parseOpenCodeVersion,
  readOpenCodeVersion,
  resolveOpenCodeExecutable,
} from './detection.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('OpenCode detection projection', () => {
  it('matches the pinned Surface version shape and launch flags', () => {
    expect(parseOpenCodeVersion('1.18.16\n')).toBe('1.18.16');
    expect(parseOpenCodeVersion('opencode 1.18.16')).toBeUndefined();
    expect(OPENCODE_LAUNCH_FLAGS).toEqual({
      serve: 'serve',
      hostname: '--hostname',
      port: '--port',
      attach: 'attach',
      directory: '--dir',
      session: '--session',
      pure: '--pure',
    });
  });

  it('gives an explicit executable precedence over the environment', () => {
    expect(resolveOpenCodeExecutable('/test/opencode')).toBe('/test/opencode');
  });
});

describe('OpenCode release-line reading', () => {
  it('reads a bare 1.x version as supported and the 2.x banner as a typed refusal', () => {
    expect(readOpenCodeVersion('1.19.5\n')).toEqual({ status: 'supported', version: '1.19.5' });
    // `opencode --version` on 2.2.5 (probe 2026-11-04).
    expect(readOpenCodeVersion('opencode v2.2.5\n')).toEqual({
      status: 'unsupported-release-line',
      line: '2.x',
      version: '2.2.5',
      message: expect.stringContaining('2.x release line'),
    });
    expect(readOpenCodeVersion('opencode v3.0.0')).toMatchObject({ status: 'unrecognized' });
    expect(readOpenCodeVersion('')).toMatchObject({ status: 'unrecognized' });
  });

  it('inspects an executable without throwing, and without handing it a server password', async () => {
    const root = mkdtempSync(join(tmpdir(), 'opencode-version-'));
    roots.push(root);
    const v2 = join(root, 'v2.mjs');
    writeFileSync(
      v2,
      `if (process.env.OPENCODE_PASSWORD || process.env.OPENCODE_SERVER_PASSWORD) process.exit(9);
       if (process.argv[2] === '--version') console.log('opencode v2.2.5'); else process.exit(1);`,
    );
    await expect(
      inspectOpenCodeVersion(v2, { env: { ...process.env, OPENCODE_PASSWORD: 'x', OPENCODE_SERVER_PASSWORD: 'y' } }),
    ).resolves.toMatchObject({ status: 'unsupported-release-line', version: '2.2.5' });
    await expect(inspectOpenCodeVersion(join(root, 'missing-opencode'))).resolves.toMatchObject({
      status: 'failed',
    });
  });
});

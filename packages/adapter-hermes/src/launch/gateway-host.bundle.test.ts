import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterAll, describe, expect, it } from 'vitest';

const source = fileURLToPath(new URL('./gateway-host.ts', import.meta.url));
const hostScript = readFileSync(fileURLToPath(new URL('../../scripts/tui-gateway-host.py', import.meta.url)), 'utf8');
const directory = mkdtempSync(join(tmpdir(), 'puppeteer-hermes-bundle-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

// Stands in for Hermes's Python: records the script it was asked to run, then publishes a URL as the real host does.
const STUB_PYTHON = `#!/bin/sh
printf '%s' "$1" > "$STUB_RECORD.path"
cat "$1" > "$STUB_RECORD.script"
printf '{"url":"ws://127.0.0.1:1/api/ws"}\\n'
exec sleep 60
`;

const LAUNCH = `
const [bundle, python, home, record] = process.argv.slice(1);
require(bundle)
  .startHermesGatewayHost({ python, hermesHome: home, cwd: home, env: { STUB_RECORD: record } })
  .then((host) => host.close())
  .then(() => console.log('ok'));
`;

describe('the Hermes gateway host in a bundled Node host', () => {
  // The stub is a shell script, and the launch has nothing platform-specific in it to lose.
  it.skipIf(process.platform === 'win32')(
    "launches under fieldd's esbuild flags, with nothing beside the bundle",
    { timeout: 30_000 },
    async () => {
      const bundle = join(directory, 'bundle.cjs');
      await build({
        entryPoints: [source],
        outfile: bundle,
        bundle: true,
        platform: 'node',
        format: 'cjs',
        define: { 'import.meta.url': 'undefined' },
        logLevel: 'silent',
      });
      const python = join(directory, 'python');
      writeFileSync(python, STUB_PYTHON);
      chmodSync(python, 0o755);
      const record = join(directory, 'record');

      const child = spawnSync(process.execPath, ['-e', LAUNCH, bundle, python, directory, record], {
        cwd: directory,
        encoding: 'utf8',
        timeout: 25_000,
      });

      expect(child.status, child.stderr).toBe(0);
      expect(child.stdout.trim()).toBe('ok');
      expect(readFileSync(`${record}.script`, 'utf8')).toBe(hostScript);
      expect(existsSync(readFileSync(`${record}.path`, 'utf8'))).toBe(false);
    },
  );
});

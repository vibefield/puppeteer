import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterAll, describe, expect, it } from 'vitest';
import { TUI_GATEWAY_HOST_SOURCE } from '../generated/tui-gateway-host.js';

const source = fileURLToPath(new URL('./gateway-host.ts', import.meta.url));
const hostScript = readFileSync(fileURLToPath(new URL('../../scripts/tui-gateway-host.py', import.meta.url)), 'utf8');
const directory = mkdtempSync(join(tmpdir(), 'puppeteer-hermes-bundle-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

// Stands in for Hermes's Python: records how it was asked to run the script and the script itself, then publishes a URL
// as the real host does.
const STUB_PYTHON = `#!/bin/sh
printf '%s %s %s' "$1" "$2" "$3" > "$STUB_RECORD.flags"
printf '%s' "$4" > "$STUB_RECORD.script"
printf '%s' "$#" > "$STUB_RECORD.count"
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
  it('embeds the current host script (pnpm generate:gateway-host writes it)', () => {
    expect(TUI_GATEWAY_HOST_SOURCE).toBe(hostScript);
  });

  // The stub is a shell script, which Windows cannot spawn directly.
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
      // The bundled host's own temp directory: nothing may be written there for the host to run.
      const temporary = mkdtempSync(join(directory, 'tmp-'));

      const child = spawnSync(process.execPath, ['-e', LAUNCH, bundle, python, directory, record], {
        cwd: directory,
        encoding: 'utf8',
        env: { ...process.env, TMPDIR: temporary },
        timeout: 25_000,
      });

      expect(child.status, child.stderr).toBe(0);
      expect(child.stdout.trim()).toBe('ok');
      expect(readFileSync(`${record}.flags`, 'utf8')).toBe('-I -B -c');
      expect(readFileSync(`${record}.script`, 'utf8')).toBe(hostScript);
      // the script and nothing after it: a host that names its python and no checkout hands none
      expect(readFileSync(`${record}.count`, 'utf8')).toBe('4');
      expect(readdirSync(temporary)).toEqual([]);
    },
  );
});

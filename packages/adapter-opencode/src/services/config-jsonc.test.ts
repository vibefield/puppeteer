import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { afterAll, describe, expect, it } from 'vitest';

const source = fileURLToPath(new URL('./config-jsonc.ts', import.meta.url));
const directory = mkdtempSync(join(tmpdir(), 'puppeteer-config-jsonc-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

// Run by a child Node, so each row exercises a real module loader rather than Vite's.
const CHECK = String.raw`
const check = (parseOpenCodeJsonc) => {
  const accepted = JSON.stringify(parseOpenCodeJsonc('{// c\n"a":[1,/* d */],}'));
  if (accepted !== '{"a":[1]}') throw new Error('accepted: ' + accepted);
  for (const bad of ['{"a":1,,}', '{"a":', '{"a":1} x', '[,]', '']) {
    let error;
    try { parseOpenCodeJsonc(bad); } catch (caught) { error = caught; }
    if (!(error instanceof SyntaxError) || error.message !== 'Invalid OpenCode JSONC') throw new Error('refused: ' + bad);
  }
  console.log('ok');
};
`;

function run(args: string[]): void {
  const child = spawnSync(process.execPath, args, { cwd: directory, encoding: 'utf8', timeout: 25_000 });
  expect(child.status, child.stderr).toBe(0);
  expect(child.stdout.trim()).toBe('ok');
}

describe('parseOpenCodeJsonc loaders', () => {
  it('runs from an esbuild node/cjs bundle with nothing beside it', { timeout: 30_000 }, async () => {
    const outfile = join(directory, 'bundle.cjs');
    await build({ entryPoints: [source], outfile, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
    run(['-e', `${CHECK}\ncheck(require(process.argv[1]).parseOpenCodeJsonc);`, outfile]);
  });

  it('runs in plain Node', { timeout: 30_000 }, () => {
    run([
      '--input-type=module',
      '-e',
      `${CHECK}\ncheck((await import(process.argv[1])).parseOpenCodeJsonc);`,
      pathToFileURL(source).href,
    ]);
  });
});

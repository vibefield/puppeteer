import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export interface OpenCodeImposterFixture {
  root: string;
  cwd: string;
  home: string;
  executable: string;
  env: Record<string, string>;
}

/** Present the real Imposter HTTP/SSE persona through an OpenCode-shaped executable. */
export function createOpenCodeImposterFixture(): OpenCodeImposterFixture {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'puppeteer-opencode-adapter-')));
  const cwd = join(root, 'workspace');
  const home = join(root, 'imposter-home');
  const executable = join(root, 'opencode.mjs');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(home, { recursive: true });
  const imposter = resolve(dirname(fileURLToPath(import.meta.url)), '../../../imposter/bin/ai.mjs');
  writeFileSync(executable, `await import(${JSON.stringify(pathToFileURL(imposter).href)});\n`, { mode: 0o700 });
  return {
    root,
    cwd,
    home,
    executable,
    env: { PUPPETEER_IMPOSTER_HOME: home },
  };
}

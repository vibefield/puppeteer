// Session-free config-loader probes (the config1–config3 batches in parse-results.json): does codex
// accept a config.toml, with or without `-c` overrides?
//
//   PUPPETEER_CODEX_BIN=<codex> node config-probe.mjs <cases.json: [{ lines: [toml lines], argv?: [options] }]> <results.json>
//
// Each case writes its top-level lines into an empty isolated CODEX_HOME and runs
// `codex [argv] features list`, which loads the configuration and starts no session. HOME is isolated
// too, stdin is not a terminal and TERM is dumb, so nothing of anyone's is read or written. Since
// 0.164.0 the executable is the one named, never `codex` on PATH (the operator's own, signed-in
// install), and PATH keeps no directory with another codex.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hermeticPath, resolveCodexExecutable } from '../../census/harness.mjs';

const executable = resolveCodexExecutable();

const cases = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const results = [];
for (const { lines, argv } of cases) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'codex-config-'));
  const home = join(root, 'home');
  const codexHome = join(root, 'codex-home');
  const cwd = join(root, 'cwd');
  for (const directory of [home, codexHome, cwd]) mkdirSync(directory, { recursive: true });
  writeFileSync(join(codexHome, 'config.toml'), `${lines.join('\n')}\n`);
  const run = spawnSync(executable, [...(argv ?? []), 'features', 'list'], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: hermeticPath(process.env.PATH, executable),
      HOME: home,
      CODEX_HOME: codexHome,
      TERM: 'dumb',
      LANG: 'en_US.UTF-8',
    },
    timeout: 20_000,
    encoding: 'utf8',
  });
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`.split('\n').filter((line) => line.trim() !== '');
  results.push({
    lines,
    typed: argv ?? [],
    exit: run.status,
    firstLine: (output[0] ?? '').slice(0, 300),
    lastLine: (output.at(-1) ?? '').trim().slice(0, 300),
  });
}
writeFileSync(process.argv[3], `${JSON.stringify(results, null, 2)}\n`);
for (const { lines, typed, exit, lastLine } of results) {
  console.log(`${exit}\t${JSON.stringify(lines)} ${JSON.stringify(typed)}\t${lastLine}`);
}

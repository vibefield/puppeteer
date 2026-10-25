// Session-free config-loader probes (the config batches in parse-results.json): does codex accept a
// config.toml, with or without `-c` overrides? Unchanged from probes/codex@0.157.1 except that a case
// carries its batch and is spelled as its result is (configToml, typed), and the executable is named.
//
//   PUPPETEER_CODEX_BIN=<codex> node config-probe.mjs <cases.json: [{ batch, configToml: [toml], typed?: [options] }]> <results.json>
//
// Each case writes its top-level lines into an empty isolated CODEX_HOME and runs
// `codex [argv] features list`, which loads the configuration and starts no session. HOME is isolated
// too, stdin is not a terminal and TERM is dumb, so nothing of anyone's is read or written. The
// executable is the one named, never `codex` on PATH (the operator's own, signed-in install), and PATH
// keeps no directory with another codex.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hermeticPath, resolveCodexExecutable } from '../../census/harness.mjs';

const executable = resolveCodexExecutable();
const cases = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const results = [];
for (const { batch, configToml: lines, typed: argv } of cases) {
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
  rmSync(root, { recursive: true, force: true });
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`.split('\n').filter((line) => line.trim() !== '');
  results.push({
    ...(batch ? { batch } : {}),
    typed: argv ?? [],
    configToml: lines,
    exit: run.status,
    firstLine: (output[0] ?? '').slice(0, 300),
    lastLine: (output.at(-1) ?? '').trim().slice(0, 300),
  });
}
writeFileSync(process.argv[3], `${JSON.stringify(results, null, 2)}\n`);
for (const { configToml, typed, exit, lastLine } of results) {
  console.log(`${exit}\t${JSON.stringify(configToml)} ${JSON.stringify(typed)}\t${lastLine}`);
}

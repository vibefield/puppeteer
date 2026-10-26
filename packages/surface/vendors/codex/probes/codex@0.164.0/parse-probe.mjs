// Session-free parse probes for codex's CLI grammar (the method behind parse-results.json; unchanged
// from probes/codex@0.157.1 except that a case may carry its batch and the executable is named).
//
//   PUPPETEER_CODEX_BIN=<codex> node parse-probe.mjs <cases.json: [{ batch, typed: [argv] }]> <results.json>
//
// Safety net, every run: the executable is the one named, never `codex` on PATH (the operator's own,
// signed-in install), and PATH keeps no directory with another codex; argv is an explicit array (no
// shell — zsh does not split an unquoted variable, and a joined argv reads as a prompt), stdin is not
// a terminal and TERM is dumb (the TUI refuses both), the working directory is a throwaway one, and
// CODEX_HOME and HOME are empty isolated directories (no login, no config, no session of anyone's can
// be reached). Every case must still end in `--help`, `--version` or a clap error; `codex <opts>
// --help` is the shape proven to validate.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hermeticPath, resolveCodexExecutable } from '../../census/harness.mjs';

const executable = resolveCodexExecutable();
const root = mkdtempSync(join(realpathSync(tmpdir()), 'codex-parse-'));
const home = join(root, 'home');
const codexHome = join(root, 'codex-home');
const cwd = join(root, 'cwd');
for (const directory of [home, codexHome, cwd]) mkdirSync(directory, { recursive: true });

const cases = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const results = [];
for (const entry of cases) {
  const { batch, typed } = Array.isArray(entry) ? { typed: entry } : entry;
  const run = spawnSync(executable, typed, {
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
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  const firstLine = output.split('\n').find((line) => line.trim() !== '') ?? '';
  results.push({ ...(batch ? { batch } : {}), typed, exit: run.status, firstLine });
}
rmSync(root, { recursive: true, force: true });
writeFileSync(process.argv[3], `${JSON.stringify(results, null, 2)}\n`);
for (const { typed, exit, firstLine } of results) console.log(`${exit}\t${JSON.stringify(typed)}\t${firstLine}`);

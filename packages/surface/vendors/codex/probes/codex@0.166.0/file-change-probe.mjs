// Runtime evidence for what `FileUpdateChange.diff` means, per kind (findings C1d, C8).
//
//   node file-change-probe.mjs --version <semver> --package-root <extracted release package> [<results.json>]
//
// The exact-source contract (references/codex@<version>/source/file-changes.json) says `diff` is the
// whole new file for `add` and a unified diff for `update`. The sanitized census redacts every `diff`
// string, so it can prove where the field occurs but not what it says. This probe runs the census's
// own `file-change` scenario (census/harness.mjs: a seeded `hello.txt`, one patch that adds
// `added.txt` and updates `hello.txt`, a loopback model, isolated HOME and CODEX_HOME), then compares
// each change's `diff` with the patch it applied and with the bytes that landed on disk. Every value
// it records is the probe's own synthetic content; host paths are reduced to workspace-relative names.
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { basename, isAbsolute, relative } from 'node:path';
import {
  CODEX_VERSION,
  FILE_CHANGE_PATCH,
  FILE_CHANGE_SEED,
  codexArtifactIdentity,
  resolveCodexExecutable,
  runScenario,
  scenarioFailures,
} from '../../census/harness.mjs';

const argv = process.argv.slice(2);
const flag = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};
const output = argv.find((value, index) => !value.startsWith('--') && !argv[index - 1]?.startsWith('--'));

const executable = resolveCodexExecutable({ bin: flag('--bin'), packageRoot: flag('--package-root') });
const identity = codexArtifactIdentity(executable);
if (identity.versionOutput !== `codex-cli ${CODEX_VERSION}`) {
  throw new Error(`${executable} reports "${identity.versionOutput}", not codex-cli ${CODEX_VERSION}`);
}

const ADDED = 'new file line\n';
const UPDATED = 'hello world\n';
// The one hunk the patch's update makes, in unified form without file headers.
const UPDATE_HUNK = '@@ -1 +1 @@\n-hello\n+hello world\n';

const result = await runScenario('file-change', { bin: executable, collectFiles: ['added.txt', 'hello.txt'] });
const failures = scenarioFailures('file-change', result);
if (failures.length > 0) throw new Error(`file-change scenario failed:\n${failures.join('\n')}`);

const sha = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);
// The change paths are absolute and name the throwaway workspace; keep only the in-workspace name
// (the basename when codex reports the workspace through a different spelling, e.g. /private/var).
const workspaceName = (path, cwd) => {
  if (!isAbsolute(path)) return path;
  const inside = relative(cwd, path);
  return inside.startsWith('..') ? basename(path) : inside;
};
const cwd = result.messages.find((message) => message.result?.cwd)?.result?.cwd ?? '';

const changes = (method) =>
  result.messages
    .filter((message) => message.method === method && message.params?.item?.type === 'fileChange')
    .map((message) => ({
      status: message.params.item.status,
      changes: message.params.item.changes.map((change) => {
        const file = workspaceName(change.path, cwd);
        const onDisk = result.files[file];
        return {
          file,
          kind: change.kind,
          diffText: change.diff,
          diffSha256: sha(change.diff),
          diffEqualsFileOnDisk: change.diff === onDisk,
          diffIsUnifiedHunk: change.diff === UPDATE_HUNK,
        };
      }),
    }));

const started = changes('item/started');
const completed = changes('item/completed');
const kinds = (entry, kind) => entry.changes.filter((change) => change.kind?.type === kind);
const final = completed.at(-1);
const observed = {
  addDiffIsWholeNewFile: kinds(final, 'add').every(
    (change) => change.diffEqualsFileOnDisk && change.diffText === ADDED,
  ),
  updateDiffIsUnifiedDiff: kinds(final, 'update').every(
    (change) => change.diffIsUnifiedHunk && !change.diffEqualsFileOnDisk && change.kind.move_path === null,
  ),
  changesSortedByPath: final.changes.every(
    (change, index, list) => index === 0 || list[index - 1].file.localeCompare(change.file) <= 0,
  ),
  startedEqualsCompleted: JSON.stringify(started.at(-1)?.changes) === JSON.stringify(final.changes),
  turnDiffUpdated: result.messages.filter((message) => message.method === 'turn/diff/updated').length,
  patchUpdated: result.messages.filter((message) => message.method === 'item/fileChange/patchUpdated').length,
  completedStatus: final.status,
};

const record = {
  codex: CODEX_VERSION,
  probe: 'probes/codex@' + CODEX_VERSION + '/file-change-probe.mjs',
  scenario: 'file-change (packages/surface/vendors/codex/census/harness.mjs)',
  artifact: {
    versionOutput: identity.versionOutput,
    executableSha256: identity.executable.sha256,
    companions: Object.fromEntries(Object.entries(identity.companions).map(([name, file]) => [name, file.sha256])),
  },
  seededWorkspace: FILE_CHANGE_SEED,
  appliedPatch: FILE_CHANGE_PATCH,
  filesAfterTurn: result.files,
  expected: { addedFile: ADDED, updatedFile: UPDATED, updateHunk: UPDATE_HUNK },
  itemStarted: started,
  itemCompleted: completed,
  observed,
};
const serialized = `${JSON.stringify(record, null, 2)}\n`;
if (output) writeFileSync(output, serialized);
else process.stdout.write(serialized);
const holds = observed.addDiffIsWholeNewFile && observed.updateDiffIsUnifiedDiff && observed.changesSortedByPath;
console.error(holds ? 'file-change semantics hold' : 'file-change semantics DIFFER from the contract');
if (!holds) process.exitCode = 1;

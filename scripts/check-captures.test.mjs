/**
 * Repo-wide capture privacy gate.
 *
 * Runs as part of `pnpm test` (root: `node --test scripts/*.test.mjs`) so a raw
 * capture cannot reach a commit, a release, or an npm tarball.
 *
 * It exists because on 2026-08-07 three leaks were found at once:
 * `packages/testing/fixtures/hooks` shipped home paths and raw session UUIDs
 * inside the PUBLISHED `@vibefield/puppeteer-testing@0.1.8` tarball;
 * the former root `probe/codex/` held a raw JSON-RPC transcript on a public
 * repo; and the sanitiser of the day passed both as clean. Nothing was watching, so nothing
 * complained. This is the thing that watches.
 *
 * Scope: files GIT TRACKS under a capture root. Tracked, because the job is to
 * stop a leak reaching a commit. A gitignored local capture failing the build
 * is noise. Capture roots rather than every `*.jsonl`, because captures are the
 * only files copied verbatim out of a real session. Both `.json` and `.jsonl`,
 * because one leak hid in a `*-shapes.json` companion a `.jsonl`-only scan
 * never opened.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkCaptureFile } from '@vibefield/puppeteer-surface/sanitize';
import { claudeRepositoryGateRules } from '../packages/surface/vendors/claude/privacy.mjs';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/** Directories whose contents came from observing a real agent. */
const vendorsRoot = join(repoRoot, 'packages', 'surface', 'vendors');
const captureRoots = [
  ...readdirSync(vendorsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(vendorsRoot, entry.name, 'captures')))
    .map((entry) => `packages/surface/vendors/${entry.name}/captures`),
];

/**
 * Generated hook-settings documents are config, not captures: their `command`
 * values are the curl forwarder the adapter writes, which `sensitiveTextKey`
 * matches only because "command" means a USER-run tool command in a capture.
 * Their shape is asserted by adapter-claude's settings.test.ts instead.
 */
const notACapture = /-settings\.json$/;

/**
 * Vendor rule sets that relax the shared defaults on purpose. Claude's admits
 * only the closed StopFailure/SessionEnd enum values (protocol constants that
 * fall under the free-text `error`/`reason` keys); everything else is the
 * shared default detector. Any other vendor's captures use the defaults.
 */
const vendorRules = [['packages/surface/vendors/claude/captures/', claudeRepositoryGateRules]];

function rulesFor(file) {
  return vendorRules.find(([prefix]) => file.startsWith(prefix))?.[1];
}

function trackedCaptureFiles() {
  const listed = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...captureRoots],
    {
      cwd: repoRoot,
      encoding: 'utf8',
    },
  );
  return listed
    .split('\0')
    .filter((file) => file.endsWith('.json') || file.endsWith('.jsonl'))
    .filter((file) => !notACapture.test(file))
    .filter((file) => existsSync(join(repoRoot, file)))
    .sort();
}

test('committed captures carry no unsanitised session data', () => {
  const files = trackedCaptureFiles();
  // A scan that silently matches nothing would pass forever; assert it looked.
  assert.ok(files.length > 0, 'expected to find tracked capture files to scan');

  const findings = files.flatMap((file) => checkCaptureFile(join(repoRoot, file), file, rulesFor(file)));
  assert.deepEqual(
    findings.slice(0, 20),
    [],
    `${findings.length} capture privacy issue(s) across ${files.length} tracked capture file(s).\n` +
      `Sanitise before committing:\n` +
      `  node packages/surface/vendors/claude/sanitize-captures.mjs <dir>\n` +
      findings.slice(0, 20).join('\n'),
  );
});

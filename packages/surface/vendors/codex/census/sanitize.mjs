#!/usr/bin/env node
/**
 * Sanitize the codex census: `captures-raw/` (verbatim, gitignored) ->
 * `captures/` (shape-faithful, committed). ADAPTING-AN-AGENT step 1.
 *
 * The raw captures carry, verified against a real run: `userAgent` (OS version,
 * arch AND terminal emulator), `codexHome` (a real home path), `serverName`
 * (the machine hostname, which contains the operator's real first name),
 * `installationId`, and UUIDv7 thread/turn/item ids whose leading 48 bits are
 * the wall-clock capture time. The shared sanitizer covers all of these; this
 * script adds only what is codex-shaped and then REFUSES to write anything the
 * privacy check still flags.
 *
 * Never loosen a rule to make this pass. The captures are evidence, and a
 * fixture that leaks is worse than a missing fixture.
 *
 * usage: node sanitize.mjs [--in <dir>] [--out <dir>] [--check-only]
 */

import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkCaptureDirectory,
  defaultRules,
  extendRules,
  sanitizeCaptureDirectory,
} from '@vibefield/puppeteer-surface/sanitize';
import { writeCaptureFidelity } from '../../../scripts/capture-fidelity.mjs';
import { CODEX_VERSION } from './harness.mjs';

const surfaceRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Codex-specific additions to the shared rules.
 *
 * `startedAtMs`/`completedAtMs` are raw epoch milliseconds sitting beside the
 * UUIDv7 ids — aliasing the ids while leaving these behind would hand back the
 * same wall-clock the ids were scrubbed to hide.
 *
 * `runtimeWorkspaceRoots` (thread/start results, `thread.environments[]`,
 * turn/start) and `writableRoots` (sandbox policies) are absolute host
 * directories under keys the shared path rule does not name. Until 0.164.0 they
 * were rewritten only when a value pattern (`/var/folders`, `/Users`) happened to match, so
 * a census run with TMPDIR elsewhere committed the path verbatim.
 *
 * The detector patterns carry no `g` flag: `inspect` calls `RegExp.test`, which
 * keeps `lastIndex` between calls on a global pattern and skips every other hit.
 */
export const codexRules = extendRules(
  {
    idKey: /^(?:environmentId|processId|conversationId|rolloutId)$/,
    pathKey: /^(?:runtimeWorkspaceRoots|writableRoots)$/,
    sensitiveTextKey: /^(?:proposedExecpolicyAmendment|commandActions|scriptPath|displayCommand|execpolicy_amendment)$/,
    unsafeTextPatterns: [
      // Absolute home paths that no key rule catches because they are embedded
      // in a longer string, e.g. inside a shell command line.
      /\/(?:Users|home)\/[^/\s"']+/,
      // Bare epoch-millisecond timestamps for the next ~30 years.
      /\b1[7-9]\d{11}\b/,
    ],
  },
  defaultRules,
);

// Only the CLI runs; `audit.mjs` imports this module purely for `codexRules`,
// and an import that silently rewrote the committed fixtures would be a nasty
// surprise inside a check that is supposed to only read them.
if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const input = flag('--in') ?? join(surfaceRoot, 'captures-raw', `codex@${CODEX_VERSION}`);
  const output = flag('--out') ?? join(surfaceRoot, 'captures', `codex@${CODEX_VERSION}`);

  if (argv.includes('--check-only')) {
    const issues = checkCaptureDirectory(output, codexRules);
    for (const issue of issues.slice(0, 20)) console.error(issue);
    console.log(issues.length === 0 ? `clean: ${output}` : `${issues.length} issue(s) in ${output}`);
    process.exit(issues.length === 0 ? 0 : 1);
  }

  // Write to a staging directory first: a capture set that fails the check must
  // never land in the committed tree, not even briefly.
  const staging = `${output}.staging`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });

  const result = sanitizeCaptureDirectory(input, staging, codexRules);
  writeCaptureFidelity(staging, {
    vendor: 'codex',
    vendorVersion: CODEX_VERSION,
    defaultRepresentation: 'type-preserving-redaction',
    nativeArtifacts: ['*.jsonl'],
    limitations: [
      'Only app-server JSON records are promoted; process diagnostics and fake-provider internals remain outside the committed capture set.',
      'Sensitive scalar values are replaced in place while native keys, containers, primitive types, and record order are retained.',
      'Absolute paths under path keys (cwd, path, codexHome, runtimeWorkspaceRoots, writableRoots) become fixed placeholders, so a root no longer string-equals the cwd it named and file-change basenames are not retained.',
      'Free text under text, diff, patch, output and similar keys is redacted: a capture proves where such a field occurs and that it is a string, not what it says.',
    ],
  });
  const issues = checkCaptureDirectory(staging, codexRules);
  if (issues.length > 0) {
    for (const issue of issues.slice(0, 20)) console.error(issue);
    rmSync(staging, { recursive: true, force: true });
    console.error(`\n${issues.length} issue(s) — nothing was written. Fix the rules, not the check.`);
    process.exit(1);
  }

  rmSync(output, { recursive: true, force: true });
  mkdirSync(dirname(output), { recursive: true });
  const { renameSync } = await import('node:fs');
  renameSync(staging, output);
  console.log(`sanitized ${result.files} file(s), ${result.lines} line(s) -> ${output}`);
  console.log('privacy check: clean');
}

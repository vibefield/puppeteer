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

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkCaptureDirectory,
  checkRecord,
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

/** The probe records the gate reads; scripts are authored code and not evidence. */
const PROBE_RECORD = /\.(?:json|jsonl|txt|md)$/;

/**
 * The few probe values the detector flags by key or shape that are not private, each pinned as
 * narrowly as it can be: a live case's `id` is the harness's own label (`S12-typed-remote-…`); a
 * `<root>/…` path is the case-root placeholder the live harness writes in place of its directory;
 * `/tmp/codex-extra` is the 0.157.1 config probe's own synthetic literal (its README's erratum).
 */
const PROBE_CASE_ID = /^S\d+-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;
const PROBE_CASE_ROOT = /^<root>(?:\/[A-Za-z0-9._-]+)*$/;
const PROBE_SYNTHETIC_LITERALS = [/\/tmp\/codex-extra(?![\w./-])/g];

function withKnownProbeValues(value, key = '') {
  if (typeof value === 'string') {
    if (key === 'id' && PROBE_CASE_ID.test(value)) return '<redacted:id>';
    if (PROBE_CASE_ROOT.test(value)) return '/workspace';
    return PROBE_SYNTHETIC_LITERALS.reduce((text, literal) => text.replace(literal, '<synthetic>'), value);
  }
  if (Array.isArray(value)) return value.map((entry) => withKnownProbeValues(entry, key));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, child]) => [childKey, withKnownProbeValues(child, childKey)]),
    );
  }
  return value;
}

/** The detector over one parsed probe record, after the pinned exceptions above. */
export function checkProbeRecord(record, rules = codexRules) {
  return checkRecord(withKnownProbeValues(record), rules);
}

/**
 * The detector over every committed probe record (`probes/codex@<version>/`).
 *
 * No sanitizer writes these: each probe projects its own output (`whitelist-live.mjs` from raw TUI
 * sessions, the parse probe from argv and first lines), so a re-run that kept a path or token in an
 * error line would otherwise be committed with every other gate green. JSON is inspected with the
 * key rules; help captures and READMEs line by line, for value patterns only.
 */
export function checkProbeRecords(probesRoot = join(surfaceRoot, 'probes'), rules = codexRules) {
  const issues = [];
  if (!existsSync(probesRoot)) return issues;
  for (const version of readdirSync(probesRoot).sort()) {
    const directory = join(probesRoot, version);
    if (!statSync(directory).isDirectory()) continue;
    for (const file of readdirSync(directory).sort()) {
      if (!PROBE_RECORD.test(file) || !statSync(join(directory, file)).isFile()) continue;
      const label = `${version}/${file}`;
      const text = readFileSync(join(directory, file), 'utf8');
      const inspectRecord = (record, location) =>
        issues.push(...checkProbeRecord(record, rules).map((issue) => issue.replace('<record>', location)));
      if (file.endsWith('.json')) {
        let document;
        try {
          document = JSON.parse(text);
        } catch {
          issues.push(`${label}: not valid JSON`);
          continue;
        }
        inspectRecord(document, label);
      } else {
        for (const [index, line] of text.split('\n').entries()) {
          if (!line.trim()) continue;
          let record = line;
          if (file.endsWith('.jsonl')) {
            try {
              record = JSON.parse(line);
            } catch {
              issues.push(`${label}:${index + 1}: not valid JSON`);
              continue;
            }
          }
          inspectRecord(record, `${label}:${index + 1}`);
        }
      }
    }
  }
  return issues;
}

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
    const probeIssues = checkProbeRecords();
    for (const issue of probeIssues.slice(0, 20)) console.error(issue);
    console.log(
      probeIssues.length === 0 ? 'clean: probe records' : `${probeIssues.length} issue(s) in the probe records`,
    );
    process.exit(issues.length === 0 && probeIssues.length === 0 ? 0 : 1);
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

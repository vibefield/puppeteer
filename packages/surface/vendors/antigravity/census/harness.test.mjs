import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  REQUIRED_FLAGS,
  REQUIRED_PLATFORMS,
  REQUIRED_SUBCOMMANDS,
  VERSION,
  canonicalPlatform,
  validateReleaseContract,
} from './harness.mjs';
import {
  STATIC_STRING_CANDIDATES,
  scanStaticStringCandidates,
  validateDocumentationReference,
} from './documentation.mjs';

const vendorRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const reference = JSON.parse(
  readFileSync(join(vendorRoot, 'references', `antigravity@${VERSION}`, 'release.json'), 'utf8'),
);
const documentation = JSON.parse(
  readFileSync(join(vendorRoot, 'references', `antigravity@${VERSION}`, 'docs.json'), 'utf8'),
);
const upstream = JSON.parse(readFileSync(join(vendorRoot, 'upstream.json'), 'utf8'));

describe('Antigravity offline census contract', () => {
  it('pins the exact four-platform release assets to the reviewed acquisition policy', () => {
    expect(validateReleaseContract(reference, upstream)).toEqual([]);
    expect(reference.assets.map((asset) => asset.platform)).toEqual(REQUIRED_PLATFORMS);
    expect(reference.assets.every((asset) => /^[0-9a-f]{64}$/.test(asset.sha256))).toBe(true);
  });

  it('rejects malformed published identity and acquisition URL drift', () => {
    const changed = structuredClone(reference);
    changed.assets[0].sha256 = '0'.repeat(63);
    changed.assets[1].url = changed.assets[1].url.replace('mac_x64', 'mac_amd64');
    expect(validateReleaseContract(changed, upstream)).toEqual(
      expect.arrayContaining([
        'darwin-arm64: invalid published SHA-256',
        'darwin-x64: release URL differs from policy',
      ]),
    );
  });

  it('normalizes only supported execution hosts', () => {
    expect(canonicalPlatform('darwin', 'arm64')).toBe('darwin-arm64');
    expect(canonicalPlatform('darwin', 'x64')).toBe('darwin-x64');
    expect(canonicalPlatform('linux', 'x64')).toBe('linux-x64');
    expect(canonicalPlatform('win32', 'x64')).toBe('windows-x64');
    expect(() => canonicalPlatform('linux', 'arm64')).toThrow(/unsupported census platform/);
  });

  it('requires the native-TUI control and observation flags in offline help evidence', () => {
    expect(REQUIRED_FLAGS).toEqual(
      expect.arrayContaining(['--add-dir', '--conversation', '--continue', '--log-file', '--prompt-interactive']),
    );
    expect(REQUIRED_SUBCOMMANDS).toEqual(expect.arrayContaining(['models', 'agents', 'update']));
  });

  it('keeps the public documentation projection internally consistent and non-runtime', () => {
    expect(validateDocumentationReference(documentation)).toEqual([]);
    expect(documentation.projection.printMode.authorizedToRun).toBe(false);
  });

  it('rejects a documentation projection that upgrades print mode into a runtime claim', () => {
    const changed = structuredClone(documentation);
    changed.projection.printMode.authorizedToRun = true;
    changed.kind = 'runtime-evidence';
    expect(validateDocumentationReference(changed)).toEqual(
      expect.arrayContaining([
        'documentation reference must remain a documentation-lead',
        'documentation print-mode survey oracle must stay unauthorized and non-runtime',
      ]),
    );
  });

  it('records static-string presence without promoting the bytes into a runtime contract', () => {
    const haystack = Buffer.from(STATIC_STRING_CANDIDATES.map((candidate) => candidate.value).join('\0'));
    const scanned = scanStaticStringCandidates(haystack);
    expect(
      Object.values(scanned).every((candidate) => candidate.present && candidate.status === 'unverified-contract'),
    ).toBe(true);
    expect(scanStaticStringCandidates(Buffer.from('unrelated')).envDisableAutoUpdate.present).toBe(false);
  });
});

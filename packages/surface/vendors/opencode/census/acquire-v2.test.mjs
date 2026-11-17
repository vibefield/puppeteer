import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { resolveArtifactDownload } from '../../../../../scripts/download-agent-artifact.mjs';
import {
  CENSUS_PLATFORMS,
  censusAcquisitionPolicy,
  integrityMatches,
  latestStableVersion,
  ledgerArtifactSha256,
  platformPackage,
  registryMetadataURL,
  registryVersionProblems,
  teamIdentifier,
  unverifiedName,
} from './acquire-v2.mjs';

describe('2.x census acquisition policy', () => {
  it('expands to the scoped registry tarball through the governed resolver, on the allowlisted host only', () => {
    const spec = resolveArtifactDownload(censusAcquisitionPolicy(), 'darwin-arm64', '2.2.5');
    expect(spec.urls).toEqual(['https://registry.npmjs.org/@opencode/cli-darwin-arm64/-/cli-darwin-arm64-2.2.5.tgz']);
    expect(spec).toMatchObject({
      artifactKind: 'standalone-executable',
      format: 'tar.gz',
      executableBasenames: ['opencode'],
      allowedHosts: ['registry.npmjs.org'],
    });
    expect(spec.maxBytes).toBeGreaterThan(259_169_160);
    const windows = resolveArtifactDownload(censusAcquisitionPolicy(), 'windows-x64', '2.2.5');
    expect(windows.executableBasenames).toEqual(['opencode.exe']);
    expect(() => resolveArtifactDownload(censusAcquisitionPolicy(), 'linux-arm64', '2.2.5')).toThrow(
      'unsupported platform linux-arm64',
    );
  });

  it('names the scoped platform packages and their registry documents', () => {
    expect(CENSUS_PLATFORMS.map(platformPackage)).toEqual([
      '@opencode/cli-darwin-arm64',
      '@opencode/cli-darwin-x64',
      '@opencode/cli-linux-x64',
      '@opencode/cli-windows-x64',
    ]);
    expect(() => platformPackage('linux-x64-musl')).toThrow('unsupported census platform');
    expect(registryMetadataURL('@opencode/cli-linux-x64', '2.2.5')).toBe(
      'https://registry.npmjs.org/@opencode%2fcli-linux-x64/2.2.5',
    );
    expect(registryMetadataURL('@opencode/cli')).toBe('https://registry.npmjs.org/@opencode%2fcli');
  });
});

describe('registry checks', () => {
  const tarballUrl = 'https://registry.npmjs.org/@opencode/cli-darwin-arm64/-/cli-darwin-arm64-2.2.5.tgz';
  const bytes = Buffer.from('controlled tarball bytes');
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  const document = {
    name: '@opencode/cli-darwin-arm64',
    version: '2.2.5',
    dist: { tarball: tarballUrl, integrity },
  };
  const expected = { name: '@opencode/cli-darwin-arm64', version: '2.2.5', tarballUrl };

  it('accepts the document whose tarball is the policy URL, and names every mismatch otherwise', () => {
    expect(registryVersionProblems(document, expected)).toEqual([]);
    expect(
      registryVersionProblems(
        { ...document, version: '2.2.4', deprecated: 'use 2.2.5', dist: { tarball: 'https://elsewhere.invalid/x.tgz' } },
        expected,
      ),
    ).toEqual([
      'registry version 2.2.4 is not 2.2.5',
      'registry marks @opencode/cli-darwin-arm64@2.2.5 deprecated: use 2.2.5',
      'registry tarball https://elsewhere.invalid/x.tgz is not the policy URL ' + tarballUrl,
      'registry document has no sha512 integrity',
    ]);
  });

  it('checks the tarball against the sha512 integrity', () => {
    expect(integrityMatches(bytes, integrity)).toBe(true);
    expect(integrityMatches(Buffer.from('other bytes'), integrity)).toBe(false);
    expect(integrityMatches(bytes, undefined)).toBe(false);
  });

  it('takes only a stable 2.x latest', () => {
    expect(latestStableVersion({ 'dist-tags': { latest: '2.2.5', dev: '0.0.0-dev-583' } })).toBe('2.2.5');
    expect(() => latestStableVersion({ 'dist-tags': { latest: '3.0.0' } })).toThrow('not a stable 2.x version');
    expect(() => latestStableVersion({ 'dist-tags': { latest: '2.3.0-beta.1' } })).toThrow('not a stable 2.x');
    expect(() => latestStableVersion({})).toThrow('not a stable 2.x');
  });

  it('reads the TeamIdentifier from codesign output', () => {
    expect(teamIdentifier('Executable=x\nTeamIdentifier=5NZ4Q7NXJ4\nSealed Resources=none\n')).toBe('5NZ4Q7NXJ4');
    expect(teamIdentifier('TeamIdentifier=not set\n')).toBeUndefined();
    expect(teamIdentifier('')).toBeUndefined();
  });
});

describe('seed digest', () => {
  const digest = `sha256:${'a'.repeat(64)}`;
  const ledger = {
    agents: [
      {
        id: 'opencode',
        currentVersion: '1.19.5',
        verification: { platformArtifacts: [{ platform: 'darwin-arm64', artifactSha256: digest }] },
      },
    ],
  };

  it('reads the seed digest from the ledger row, and refuses a ledger past 1.19.5 or a missing platform', () => {
    expect(ledgerArtifactSha256(ledger, 'darwin-arm64')).toBe('a'.repeat(64));
    expect(() => ledgerArtifactSha256(ledger, 'linux-x64')).toThrow('names no linux-x64 artifact');
    const promoted = { agents: [{ ...ledger.agents[0], currentVersion: '2.2.5' }] };
    expect(() => ledgerArtifactSha256(promoted, 'darwin-arm64')).toThrow('is not at 1.19.5');
  });

  it('keeps unverified seed bytes off the path the census is pointed at', () => {
    expect(unverifiedName('artifacts/opencode@1.19.5/darwin-arm64/opencode')).toBe(
      'artifacts/opencode@1.19.5/darwin-arm64/opencode.unverified',
    );
    expect(unverifiedName('opencode')).not.toBe('opencode');
  });
});

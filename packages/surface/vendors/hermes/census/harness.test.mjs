import { describe, expect, it } from 'vitest';
import {
  RELEASES,
  RELEASE_TAG,
  REQUIRED_FLAGS,
  REQUIRED_SUBCOMMANDS,
  SOURCE_REVISION,
  VERSION,
  canonicalizePlatform,
  redactProbeRoots,
  sanitizeProcessTree,
  sanitizeVersionOutput,
  validateSourceContract,
} from './harness.mjs';

describe('Hermes census contract', () => {
  it('pins the reviewed source identity', () => {
    expect(
      validateSourceContract({
        sourceRevision: SOURCE_REVISION,
        releaseTag: RELEASE_TAG,
        vendorVersion: VERSION,
      }),
    ).toEqual([]);
    expect(
      validateSourceContract({
        sourceRevision: 'deadbeef',
        releaseTag: RELEASE_TAG,
        vendorVersion: VERSION,
      }),
    ).toEqual([`source revision drifted from ${SOURCE_REVISION}`]);
  });

  it('maps each date tag to the product version its annotated tag and pyproject name', () => {
    expect(VERSION).toBe('0.21.5');
    expect(RELEASES['0.21.5']).toMatchObject({ releaseTag: 'v2026.9.24', releaseDate: '2026.9.24' });
    expect(RELEASES['0.20.0']).toMatchObject({
      releaseTag: 'v2026.8.3',
      sourceRevision: '3c27eb6234bf91b8ceee9e9071591b31e9b148cb',
    });
    for (const [version, release] of Object.entries(RELEASES)) {
      expect(release.releaseTag).toBe(`v${release.releaseDate}`);
      expect(release.sourceRevision).toMatch(/^[0-9a-f]{40}$/);
      expect(release.tagObject).toMatch(/^[0-9a-f]{40}$/);
      expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it('redacts the probe checkout and environment from native diagnostics', () => {
    expect(
      redactProbeRoots('  cd /work/h0215 && /work/venv/bin/python -m pip install -e .', ['/work/h0215', '/work/venv']),
    ).toBe('  cd <redacted:path> && <redacted:path>/bin/python -m pip install -e .');
  });

  it('redacts install directories and host paths from version output and process trees', () => {
    expect(
      sanitizeVersionOutput(
        'Hermes Agent v0.20.0 (2026.8.3)\nInstall directory: /private/tmp/puppeteer-hermes-v0.20.0\n',
      ),
    ).toContain('Install directory: <redacted:install-directory>');
    expect(
      sanitizeProcessTree(
        '82714\t82713\t/Users/ada/.nvm/versions/node/v26.5.0/bin/node --expose-gc /tmp/puppeteer-hermes-v0.20.0/ui-tui/dist/entry.js\n',
      ),
    ).toMatch(/<pid>\t<ppid>\t<node> --expose-gc <redacted:path>/);
  });

  it('requires native-TUI and isolation flags in help evidence', () => {
    expect(REQUIRED_FLAGS).toEqual(
      expect.arrayContaining(['--tui', '--resume', '--ignore-user-config', '--safe-mode']),
    );
    expect(REQUIRED_SUBCOMMANDS).toEqual(expect.arrayContaining(['acp', 'chat', 'sessions']));
  });

  it('normalizes only supported execution hosts', () => {
    expect(canonicalizePlatform('darwin', 'arm64')).toBe('darwin-arm64');
    expect(canonicalizePlatform('linux', 'x64')).toBe('linux-x64');
    expect(() => canonicalizePlatform('linux', 'arm64')).toThrow(/unsupported census platform/);
  });
});

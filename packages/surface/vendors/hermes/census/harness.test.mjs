import { describe, expect, it } from 'vitest';
import {
  REQUIRED_FLAGS,
  REQUIRED_SUBCOMMANDS,
  SOURCE_REVISION,
  VERSION,
  canonicalizePlatform,
  sanitizeProcessTree,
  sanitizeVersionOutput,
  validateSourceContract,
} from './harness.mjs';

describe('Hermes census contract', () => {
  it('pins the reviewed source identity', () => {
    expect(
      validateSourceContract({
        sourceRevision: SOURCE_REVISION,
        releaseTag: 'v2026.8.3',
        vendorVersion: VERSION,
      }),
    ).toEqual([]);
    expect(
      validateSourceContract({
        sourceRevision: 'deadbeef',
        releaseTag: 'v2026.8.3',
        vendorVersion: VERSION,
      }),
    ).toEqual([`source revision drifted from ${SOURCE_REVISION}`]);
  });

  it('redacts install directories and host paths from version output and process trees', () => {
    expect(
      sanitizeVersionOutput(
        'Hermes Agent v0.20.0 (2026.8.3)\nInstall directory: /private/tmp/chopsticks-hermes-v0.20.0\n',
      ),
    ).toContain('Install directory: <redacted:install-directory>');
    expect(
      sanitizeProcessTree(
        '82714\t82713\t/Users/ada/.nvm/versions/node/v26.5.0/bin/node --expose-gc /tmp/chopsticks-hermes-v0.20.0/ui-tui/dist/entry.js\n',
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

import { describe, expect, it } from 'vitest';
import { checkRecord, defaultRules, sanitizeRecord } from '@vibefield/puppeteer-surface/sanitize';
import { codexRules } from './sanitize.mjs';

describe('codex capture privacy', () => {
  // The 0.164.0 survey found these roots verbatim in sanitized output whenever
  // TMPDIR sat outside the directories the value patterns know about.
  const started = {
    method: 'thread/started',
    params: {
      thread: {
        id: '019f5d86-423a-7083-ab79-2deb044599c1',
        cwd: '/opt/census/cwd',
        environments: [
          {
            environmentId: 'env-local',
            cwd: '/opt/census/cwd',
            runtimeWorkspaceRoots: ['/opt/census/cwd'],
          },
        ],
      },
      runtimeWorkspaceRoots: ['/opt/census/cwd'],
      sandbox: { type: 'workspaceWrite', writableRoots: ['/opt/census/extra'], networkAccess: false },
    },
  };

  it('treats workspace and writable roots as paths, wherever they nest', () => {
    const issues = checkRecord(started, codexRules).join('\n');
    expect(issues).toContain('environments[0].runtimeWorkspaceRoots[0]: unsanitized sensitive field');
    expect(issues).toContain('params.runtimeWorkspaceRoots[0]: unsanitized sensitive field');
    expect(issues).toContain('writableRoots[0]: unsanitized sensitive field');

    const sanitized = sanitizeRecord(started, codexRules);
    expect(JSON.stringify(sanitized)).not.toContain('/opt/census');
    expect(sanitized).toMatchObject({
      params: {
        thread: {
          cwd: '/workspace',
          environments: [{ cwd: '/workspace', runtimeWorkspaceRoots: ['/workspace/redacted-file'] }],
        },
        runtimeWorkspaceRoots: ['/workspace/redacted-file'],
        sandbox: { type: 'workspaceWrite', writableRoots: ['/workspace/redacted-file'], networkAccess: false },
      },
    });
    expect(checkRecord(sanitized, codexRules)).toEqual([]);
    expect(checkRecord(sanitized, defaultRules)).toEqual([]);
    expect(sanitizeRecord(sanitized, codexRules)).toEqual(sanitized);
  });

  it('keeps an empty root list empty, so the container shape survives', () => {
    const sanitized = sanitizeRecord({ sandbox: { writableRoots: [] }, runtimeWorkspaceRoots: [] }, codexRules);
    expect(sanitized).toEqual({ sandbox: { writableRoots: [] }, runtimeWorkspaceRoots: [] });
  });

  it('reports every embedded epoch clock, not every other one', () => {
    // Only codex's own pattern sees these. As a global pattern under
    // RegExp.test it resumed at lastIndex and missed the next value that
    // matched at an earlier offset.
    const issues = checkRecord(
      {
        first: 'turn began at 1786207526734 on the fake provider',
        second: 'at 1786207526735',
        third: 'at 1786207526736',
      },
      codexRules,
    );
    for (const key of ['first', 'second', 'third']) expect(issues.join('\n')).toContain(`unsafe text at ${key}`);
  });
});

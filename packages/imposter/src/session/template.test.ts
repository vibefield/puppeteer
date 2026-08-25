import { describe, expect, it } from 'vitest';
import { substitute } from './template.ts';

describe('session template transforms', () => {
  it('derives the exact Kimi v2 workspace key from an absolute cwd', () => {
    const bindings = { $cwd: '/Users/example/Projects/puppeteer' };
    expect(substitute('$workdirKey:$cwd', { bindings })).toBe('wd_puppeteer_8be84339a83f');
    expect(substitute('$workdirKey:$cwd', { bindings: { $cwd: '/Users/example/Projects/puppeteer/' } })).toBe(
      'wd_puppeteer_8be84339a83f',
    );
    expect(substitute('$workdirKey:$cwd', { bindings: { $cwd: '/' } })).toBe('wd_workspace_8a5edab28263');
    expect(substitute('$workdirKey:$cwd', { bindings: { $cwd: 'C:\\Repo' } })).toBe('wd_repo_99094984865d');
  });

  it('rejects a workspace-key transform whose nested template is not a string', () => {
    expect(() => substitute('$workdirKey:$cwd', { bindings: { $cwd: 42 } })).toThrow(/requires a string/);
  });

  it('preserves a numeric binding when requested and can stringify it for native mixed-type ids', () => {
    const bindings = { $turnIndex: 2 };
    expect(substitute('$turnIndex', { bindings })).toBe(2);
    expect(substitute('$string:$turnIndex', { bindings })).toBe('2');
    expect(() => substitute('$string:$value', { bindings: { $value: { turn: 2 } } })).toThrow(/requires a primitive/);
  });
});

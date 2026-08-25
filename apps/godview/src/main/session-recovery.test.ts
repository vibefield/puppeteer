import { describe, expect, it } from 'vitest';
import {
  missingManagedSessionIds,
  resolveRestoredSessionAlias,
  restoredSessionAliasOrigins,
  setRestoredSessionAlias,
} from './session-recovery.js';

describe('missingManagedSessionIds', () => {
  it('reconciles only managed terminals lost across backend recovery', () => {
    expect(missingManagedSessionIds(['live', 'lost'], ['live', 'unmanaged'])).toEqual(['lost']);
  });

  it('flattens repeated recoveries so stale mirrored pane ids reach the newest session', () => {
    const aliases = new Map([['persisted', 'first-runtime']]);

    setRestoredSessionAlias(aliases, 'first-runtime', 'second-runtime');

    expect(aliases).toEqual(
      new Map([
        ['persisted', 'second-runtime'],
        ['first-runtime', 'second-runtime'],
      ]),
    );
    expect(resolveRestoredSessionAlias(aliases, 'persisted')).toBe('second-runtime');
    expect(restoredSessionAliasOrigins(aliases, 'second-runtime')).toEqual(['persisted', 'first-runtime']);
  });

  it('refuses to follow an accidental alias cycle', () => {
    const aliases = new Map([
      ['one', 'two'],
      ['two', 'one'],
    ]);

    expect(resolveRestoredSessionAlias(aliases, 'one')).toBe('one');
  });
});

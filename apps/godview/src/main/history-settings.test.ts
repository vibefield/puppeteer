import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createHistorySettingsStore, parseHistorySettings } from './history-settings.js';

describe('parseHistorySettings', () => {
  it('keeps only a loopback origin and an explicit opt-out', () => {
    expect(parseHistorySettings({ version: 1, origin: 'http://127.0.0.1:5050', enabled: true })).toEqual({
      origin: 'http://127.0.0.1:5050',
      enabled: true,
    });
    expect(parseHistorySettings({ version: 1, origin: 'http://example.com:5050' })).toEqual({ enabled: true });
    expect(parseHistorySettings({ version: 1, enabled: false })).toEqual({ enabled: false });
    expect(parseHistorySettings({ version: 2, enabled: false })).toEqual({ enabled: true });
    expect(parseHistorySettings('nonsense')).toEqual({ enabled: true });
  });
});

describe('createHistorySettingsStore', () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  function scratch(): string {
    const directory = mkdtempSync(join(tmpdir(), 'godview-history-settings-'));
    directories.push(directory);
    return directory;
  }

  it('reads the defaults when the file is absent or corrupt, and the file when it is sound', () => {
    const path = join(scratch(), 'history-search.json');
    const store = createHistorySettingsStore(path);
    expect(store.read()).toEqual({ enabled: true });
    writeFileSync(path, '{ not json');
    expect(store.read()).toEqual({ enabled: true });
    writeFileSync(path, JSON.stringify({ version: 1, origin: 'http://localhost:4641', enabled: true }));
    expect(store.read()).toEqual({ origin: 'http://localhost:4641', enabled: true });
  });
});

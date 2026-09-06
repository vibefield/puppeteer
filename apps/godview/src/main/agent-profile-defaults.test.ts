import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AGENT_PROFILE_DEFAULTS_VERSION,
  applyProfileDefault,
  createProfileDefaultsStore,
  parseProfileDefaults,
  profileDefaultIds,
  retainKnownProfileDefaults,
  serializeProfileDefaults,
} from './agent-profile-defaults.js';

const directories: string[] = [];

function temporaryFile(name = 'agent-profile-defaults.json'): string {
  const directory = mkdtempSync(join(tmpdir(), 'godview-profile-defaults-'));
  directories.push(directory);
  return join(directory, name);
}

afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
});

describe('profile defaults document', () => {
  it('keeps only well-formed provider and profile ids', () => {
    const defaults = parseProfileDefaults({
      version: AGENT_PROFILE_DEFAULTS_VERSION,
      defaults: {
        'example-agent': 'example-agent:native-default',
        'other-agent': '11111111-2222-3333-4444-555555555555',
        '/etc/passwd': 'example-agent:native-default',
        'bad-value-agent': { id: 'nope' },
        'empty-agent': '',
        'traversal-agent': '../../elsewhere',
      },
    });

    expect(defaults).toEqual({
      'example-agent': 'example-agent:native-default',
      'other-agent': '11111111-2222-3333-4444-555555555555',
    });
  });

  it('rejects an unknown version or a non-object document', () => {
    expect(parseProfileDefaults({ version: 99, defaults: { 'example-agent': 'a' } })).toEqual({});
    expect(parseProfileDefaults({ version: AGENT_PROFILE_DEFAULTS_VERSION, defaults: ['a'] })).toEqual({});
    expect(parseProfileDefaults('not a document')).toEqual({});
    expect(parseProfileDefaults(undefined)).toEqual({});
  });

  it('serializes providers in a stable order', () => {
    const serialized = serializeProfileDefaults({ 'zed-agent': 'z1', 'alpha-agent': 'a1' });
    expect(serialized).toBe(
      `${JSON.stringify({ version: 1, defaults: { 'alpha-agent': 'a1', 'zed-agent': 'z1' } }, null, 2)}\n`,
    );
  });

  it('sets and clears one provider without touching the others', () => {
    const base = { 'example-agent': 'p1', 'other-agent': 'p2' };
    expect(applyProfileDefault(base, 'example-agent', 'p3')).toEqual({ 'example-agent': 'p3', 'other-agent': 'p2' });
    expect(applyProfileDefault(base, 'example-agent', null)).toEqual({ 'other-agent': 'p2' });
    expect(applyProfileDefault(base, 'example-agent', 'not a valid id')).toEqual(base);
    expect(base).toEqual({ 'example-agent': 'p1', 'other-agent': 'p2' });
  });

  it('drops defaults whose profile is no longer registered', () => {
    const retained = retainKnownProfileDefaults({ 'example-agent': 'p1', 'other-agent': 'gone' }, ['p1', 'p9']);
    expect(retained).toEqual({ 'example-agent': 'p1' });
    expect(profileDefaultIds({ 'zed-agent': 'z1', 'alpha-agent': 'a1' })).toEqual(['a1', 'z1']);
  });
});

describe('createProfileDefaultsStore', () => {
  it('starts empty when no file exists and persists what it is given', () => {
    const path = temporaryFile();
    const store = createProfileDefaultsStore(path);
    expect(store.read()).toEqual({});

    expect(store.set('example-agent', 'example-agent:native-default')).toEqual({
      'example-agent': 'example-agent:native-default',
    });
    expect(createProfileDefaultsStore(path).read()).toEqual({ 'example-agent': 'example-agent:native-default' });

    expect(store.set('example-agent', null)).toEqual({});
    expect(createProfileDefaultsStore(path).read()).toEqual({});
  });

  it('writes the file readable only by its owner and replaces it atomically', () => {
    const path = temporaryFile();
    const store = createProfileDefaultsStore(path);
    store.set('example-agent', 'p1');
    store.set('other-agent', 'p2');

    expect(JSON.parse(readFileSync(path, 'utf8')) as unknown).toEqual({
      version: AGENT_PROFILE_DEFAULTS_VERSION,
      defaults: { 'example-agent': 'p1', 'other-agent': 'p2' },
    });
    // No temporary file survives a completed write.
    expect(readFileSync(path, 'utf8').startsWith('{')).toBe(true);
  });

  it('treats an unreadable document as no defaults at all', () => {
    const path = temporaryFile();
    writeFileSync(path, '{ not json', 'utf8');
    expect(createProfileDefaultsStore(path).read()).toEqual({});

    writeFileSync(path, JSON.stringify({ version: 7, defaults: { 'example-agent': 'p1' } }), 'utf8');
    expect(createProfileDefaultsStore(path).read()).toEqual({});
  });

  it('refuses to persist entries it would not accept back', () => {
    const path = temporaryFile();
    const store = createProfileDefaultsStore(path);
    expect(store.write({ 'example-agent': 'p1', 'bad provider': 'p2' })).toEqual({ 'example-agent': 'p1' });
    expect(createProfileDefaultsStore(path).read()).toEqual({ 'example-agent': 'p1' });
  });
});

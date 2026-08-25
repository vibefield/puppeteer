import { describe, expect, it } from 'vitest';
import { parseImportedScenario } from './imported-scenario.js';

describe('parseImportedScenario', () => {
  it('accepts Godview recording envelopes and bare scenario arrays', () => {
    expect(
      parseImportedScenario(
        JSON.stringify({ name: 'real-turn', recording: { version: 1 }, steps: [{ delay: { ms: 0 } }] }),
        'capture.json',
      ),
    ).toMatchObject({ label: 'real-turn', steps: 1 });
    expect(parseImportedScenario(JSON.stringify([{ delay: { ms: 0 } }]), 'bare.json')).toMatchObject({
      label: 'bare',
      steps: 1,
    });
  });

  it('surfaces recording vendor metadata for session compatibility checks', () => {
    expect(
      parseImportedScenario(
        JSON.stringify({ recording: { vendor: 'claude' }, steps: [{ delay: { ms: 0 } }] }),
        'capture.json',
      ),
    ).toMatchObject({ vendor: 'claude' });
  });

  it('rejects malformed and empty documents before contacting the control plane', () => {
    expect(() => parseImportedScenario('{', 'bad.json')).toThrow(/valid JSON/);
    expect(() => parseImportedScenario(JSON.stringify({ steps: [] }), 'empty.json')).toThrow(/1\.\.10000/);
    expect(() => parseImportedScenario(JSON.stringify({ nope: [] }), 'wrong.json')).toThrow(/1\.\.10000/);
  });
});

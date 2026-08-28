import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  captureRepresentationForPath,
  isNativeCaptureArtifact,
  loadCaptureFidelity,
  matchesCapturePattern,
  validateCaptureFidelity,
  writeCaptureFidelity,
} from './capture-fidelity.mjs';

const temporaryRoots = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot() {
  const root = mkdtempSync(join(tmpdir(), 'puppeteer-capture-fidelity-'));
  temporaryRoots.push(root);
  return root;
}

describe('capture fidelity contracts', () => {
  it('requires an explicit representation for every capture set', () => {
    const root = temporaryRoot();
    expect(validateCaptureFidelity(root)).toEqual([expect.stringContaining('missing capture fidelity contract')]);
    writeFileSync(join(root, 'sample.jsonl'), '{}\n');

    writeCaptureFidelity(root, {
      vendor: 'example',
      vendorVersion: '1.0.0',
      defaultRepresentation: 'legacy-privacy-projection',
      nativeArtifacts: ['*.jsonl'],
      limitations: ['Native fields were removed.'],
    });
    expect(validateCaptureFidelity(root, { vendor: 'example', vendorVersion: '1.0.0' })).toEqual([]);
  });

  it('rejects ambiguous or unexplained projections', () => {
    const root = temporaryRoot();
    expect(() =>
      writeCaptureFidelity(root, {
        vendor: 'example',
        vendorVersion: '1.0.0',
        defaultRepresentation: 'unknown',
        nativeArtifacts: ['../raw.jsonl'],
        overrides: [{ paths: ['process.json'], representation: 'semantic-projection' }],
      }),
    ).toThrow(/invalid capture fidelity contract/);
  });

  it('resolves native artifacts and per-path fidelity without platform-specific paths', () => {
    const root = temporaryRoot();
    mkdirSync(join(root, 'turn', 'agents'), { recursive: true });
    mkdirSync(join(root, 'legacy'), { recursive: true });
    writeFileSync(join(root, 'turn', 'wire.jsonl'), '{}\n');
    writeFileSync(join(root, 'turn', 'agents', 'agent-1.jsonl'), '{}\n');
    writeFileSync(join(root, 'legacy', 'wire.jsonl'), '{}\n');
    writeCaptureFidelity(root, {
      vendor: 'example',
      vendorVersion: '1.0.0',
      defaultRepresentation: 'type-preserving-redaction',
      nativeArtifacts: ['*/wire.jsonl', '*/agents/*.jsonl'],
      limitations: ['Only native journals are promoted.'],
      overrides: [
        {
          paths: ['legacy/*.jsonl'],
          representation: 'legacy-privacy-projection',
          limitations: ['The original native fields are unavailable.'],
        },
      ],
    });
    const document = loadCaptureFidelity(root, { vendor: 'example', vendorVersion: '1.0.0' });

    expect(matchesCapturePattern('turn/agents/agent-1.jsonl', '*/agents/*.jsonl')).toBe(true);
    expect(isNativeCaptureArtifact(document, 'turn/wire.jsonl')).toBe(true);
    expect(isNativeCaptureArtifact(document, 'turn/process.json')).toBe(false);
    expect(captureRepresentationForPath(document, 'turn/wire.jsonl')).toBe('type-preserving-redaction');
    expect(captureRepresentationForPath(document, 'legacy/wire.jsonl')).toBe('legacy-privacy-projection');
  });

  it('rejects contradictory overrides at the artifact where they overlap', () => {
    expect(() =>
      captureRepresentationForPath(
        {
          defaultRepresentation: 'type-preserving-redaction',
          overrides: [
            { paths: ['turn/*.jsonl'], representation: 'semantic-projection' },
            { paths: ['*/wire.jsonl'], representation: 'legacy-privacy-projection' },
          ],
        },
        'turn/wire.jsonl',
      ),
    ).toThrow(/overrides disagree/);
  });

  it('rejects stale patterns and contradictory declarations against committed artifacts', () => {
    const stale = temporaryRoot();
    writeFileSync(join(stale, 'capture.json'), '{}\n');
    writeCaptureFidelity(stale, {
      vendor: 'example',
      vendorVersion: '1.0.0',
      defaultRepresentation: 'semantic-projection',
      nativeArtifacts: ['missing/*.jsonl'],
      limitations: ['Only a projected artifact was expected.'],
    });
    expect(validateCaptureFidelity(stale)).toEqual([
      expect.stringContaining('matches no committed artifact'),
      expect.stringContaining('selects no committed artifacts'),
    ]);

    const contradictory = temporaryRoot();
    mkdirSync(join(contradictory, 'turn'));
    writeFileSync(join(contradictory, 'turn', 'wire.jsonl'), '{}\n');
    writeCaptureFidelity(contradictory, {
      vendor: 'example',
      vendorVersion: '1.0.0',
      defaultRepresentation: 'type-preserving-redaction',
      nativeArtifacts: ['turn/*.jsonl'],
      limitations: ['Sensitive scalars are redacted without changing types.'],
      overrides: [
        {
          paths: ['turn/*.jsonl'],
          representation: 'semantic-projection',
          limitations: ['The record is projected.'],
        },
        {
          paths: ['*/wire.jsonl'],
          representation: 'legacy-privacy-projection',
          limitations: ['The record is legacy-projected.'],
        },
      ],
    });
    expect(validateCaptureFidelity(contradictory)).toEqual([expect.stringContaining('overrides disagree')]);
  });
});

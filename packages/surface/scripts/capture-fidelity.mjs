#!/usr/bin/env node
/** Machine-readable statement of how a committed capture set represents native data. */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

export const CAPTURE_FIDELITY_FORMAT = 'puppeteer-capture-fidelity/1';
export const CAPTURE_FIDELITY_FILE = 'capture-fidelity.json';

const representations = new Set(['type-preserving-redaction', 'semantic-projection', 'legacy-privacy-projection']);

function normalizeRelativePath(path, label) {
  if (typeof path !== 'string' || path.length === 0) throw new Error(`${label} must be a non-empty string`);
  const normalized = path.replaceAll('\\', '/');
  if (normalized.startsWith('/') || normalized.split('/').includes('..')) {
    throw new Error(`${label} must be capture-root relative`);
  }
  return normalized.replace(/^\.\//, '');
}

function globExpression(pattern) {
  let source = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        source += '.*';
        index += 1;
      } else {
        source += '[^/]*';
      }
    } else if (character === '?') {
      source += '[^/]';
    } else {
      source += character.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
    }
  }
  return new RegExp(`${source}$`, 'u');
}

/** Match a capture-root-relative path against the small portable glob subset used by fidelity contracts. */
export function matchesCapturePattern(path, pattern) {
  const normalizedPath = normalizeRelativePath(path, 'capture path');
  const normalizedPattern = normalizeRelativePath(pattern, 'capture pattern');
  return globExpression(normalizedPattern).test(normalizedPath);
}

/** True when a path is one of the capture artifacts covered by the fidelity declaration. */
export function isNativeCaptureArtifact(document, path) {
  return document.nativeArtifacts.some((pattern) => matchesCapturePattern(path, pattern));
}

/** Resolve the declared fidelity for one artifact, rejecting contradictory overlapping overrides. */
export function captureRepresentationForPath(document, path) {
  const matches = (document.overrides ?? []).filter((override) =>
    override.paths.some((pattern) => matchesCapturePattern(path, pattern)),
  );
  const declared = new Set(matches.map((override) => override.representation));
  if (declared.size > 1) {
    throw new Error(`${path}: matching capture fidelity overrides disagree`);
  }
  return matches[0]?.representation ?? document.defaultRepresentation;
}

function nonEmptyStrings(value) {
  return (
    Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === 'string' && entry.length > 0)
  );
}

function captureFiles(root, directory = root, files = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) captureFiles(root, path, files);
    else if (entry.isFile()) files.push(relative(root, path).replaceAll('\\', '/'));
  }
  return files;
}

function validateDocument(document, label, expected = {}) {
  const issues = [];
  if (document === null || typeof document !== 'object' || Array.isArray(document))
    return [`${label}: must be an object`];
  const allowed = new Set([
    'format',
    'vendor',
    'vendorVersion',
    'defaultRepresentation',
    'nativeArtifacts',
    'limitations',
    'overrides',
  ]);
  for (const key of Object.keys(document)) {
    if (!allowed.has(key)) issues.push(`${label}: unsupported field ${key}`);
  }
  if (document.format !== CAPTURE_FIDELITY_FORMAT) issues.push(`${label}: unsupported format`);
  if (typeof document.vendor !== 'string' || document.vendor.length === 0) issues.push(`${label}: missing vendor`);
  if (typeof document?.vendorVersion !== 'string' || document.vendorVersion.length === 0) {
    issues.push(`${label}: missing vendorVersion`);
  }
  if (expected.vendor && document.vendor !== expected.vendor) {
    issues.push(`${label}: vendor ${String(document.vendor)} does not match ${expected.vendor}`);
  }
  if (expected.vendorVersion && document.vendorVersion !== expected.vendorVersion) {
    issues.push(`${label}: vendorVersion ${String(document.vendorVersion)} does not match ${expected.vendorVersion}`);
  }
  if (!representations.has(document.defaultRepresentation)) {
    issues.push(`${label}: invalid defaultRepresentation ${String(document.defaultRepresentation)}`);
  }
  if (!nonEmptyStrings(document.nativeArtifacts)) {
    issues.push(`${label}: nativeArtifacts must be a non-empty array of path patterns`);
  }
  for (const [index, pattern] of (document.nativeArtifacts ?? []).entries()) {
    if (pattern.startsWith('/') || pattern.split('/').includes('..')) {
      issues.push(`${label}: nativeArtifacts[${index}] must be capture-root relative`);
    }
  }
  if (new Set(document.nativeArtifacts ?? []).size !== (document.nativeArtifacts ?? []).length) {
    issues.push(`${label}: nativeArtifacts contains duplicates`);
  }
  if (!nonEmptyStrings(document.limitations)) {
    issues.push(`${label}: limitations must explain the declared default representation`);
  }
  if (document.overrides !== undefined && !Array.isArray(document.overrides)) {
    issues.push(`${label}: overrides must be an array`);
  }
  for (const [index, override] of (document.overrides ?? []).entries()) {
    const overrideLabel = `${label}: overrides[${index}]`;
    if (override === null || typeof override !== 'object' || Array.isArray(override)) {
      issues.push(`${overrideLabel} must be an object`);
      continue;
    }
    for (const key of Object.keys(override)) {
      if (!['paths', 'representation', 'limitations'].includes(key)) {
        issues.push(`${overrideLabel} has unsupported field ${key}`);
      }
    }
    if (!nonEmptyStrings(override.paths)) issues.push(`${overrideLabel}.paths must be non-empty`);
    for (const [pathIndex, pattern] of (override.paths ?? []).entries()) {
      if (pattern.startsWith('/') || pattern.split('/').includes('..')) {
        issues.push(`${overrideLabel}.paths[${pathIndex}] must be capture-root relative`);
      }
    }
    if (!representations.has(override?.representation)) {
      issues.push(`${overrideLabel} has invalid representation`);
    }
    if (!nonEmptyStrings(override.limitations)) {
      issues.push(`${overrideLabel}.limitations must explain the projection`);
    }
  }
  return issues;
}

export function validateCaptureFidelity(captureRoot, expected = {}) {
  const path = join(captureRoot, CAPTURE_FIDELITY_FILE);
  if (!existsSync(path)) return [`${path}: missing capture fidelity contract`];
  try {
    const document = JSON.parse(readFileSync(path, 'utf8'));
    const issues = validateDocument(document, path, expected);
    if (issues.length > 0) return issues;

    const files = captureFiles(captureRoot).filter((file) => file !== CAPTURE_FIDELITY_FILE);
    for (const pattern of document.nativeArtifacts) {
      if (!files.some((file) => matchesCapturePattern(file, pattern))) {
        issues.push(`${path}: nativeArtifacts pattern ${pattern} matches no committed artifact`);
      }
    }
    for (const override of document.overrides ?? []) {
      for (const pattern of override.paths) {
        if (!files.some((file) => matchesCapturePattern(file, pattern))) {
          issues.push(`${path}: override pattern ${pattern} matches no committed artifact`);
        }
      }
    }

    const nativeFiles = files.filter((file) => isNativeCaptureArtifact(document, file));
    if (nativeFiles.length === 0) issues.push(`${path}: nativeArtifacts selects no committed artifacts`);
    for (const file of nativeFiles) {
      try {
        captureRepresentationForPath(document, file);
      } catch (error) {
        issues.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return issues;
  } catch (error) {
    return [`${path}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`];
  }
}

/** Read a validated fidelity document. Consumers must not silently invent a default. */
export function loadCaptureFidelity(captureRoot, expected = {}) {
  const path = join(captureRoot, CAPTURE_FIDELITY_FILE);
  const issues = validateCaptureFidelity(captureRoot, expected);
  if (issues.length > 0) throw new Error(`invalid capture fidelity contract:\n${issues.join('\n')}`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function writeCaptureFidelity(captureRoot, document) {
  const value = { format: CAPTURE_FIDELITY_FORMAT, ...document };
  const issues = validateDocument(value, '<capture-fidelity>');
  if (issues.length > 0) throw new Error(`invalid capture fidelity contract:\n${issues.join('\n')}`);
  writeFileSync(join(captureRoot, CAPTURE_FIDELITY_FILE), `${JSON.stringify(value, null, 2)}\n`);
}

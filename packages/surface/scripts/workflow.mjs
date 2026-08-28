#!/usr/bin/env node
/** Audit the Layer 0 workflow itself, including inputs that have no model yet. */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCaptureFidelity } from './capture-fidelity.mjs';

const defaultPackageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

export function discoverVendorRoots(packageRoot = defaultPackageRoot) {
  const vendorsRoot = join(packageRoot, 'vendors');
  return readdirSync(vendorsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(vendorsRoot, entry.name, 'upstream.json')))
    .map((entry) => join(vendorsRoot, entry.name))
    .sort();
}

export function auditSurfaceWorkflow(packageRoot = defaultPackageRoot) {
  const issues = [];
  const packageDocument = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  const scripts = packageDocument.scripts ?? {};
  const roots = discoverVendorRoots(packageRoot);
  if (roots.length === 0) return [`${join(packageRoot, 'vendors')}: no upstream vendors declared`];

  for (const root of roots) {
    const vendor = basename(root);
    let upstream;
    try {
      upstream = JSON.parse(readFileSync(join(root, 'upstream.json'), 'utf8'));
    } catch (error) {
      issues.push(
        `${join(root, 'upstream.json')}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    if (upstream.vendor !== vendor) issues.push(`${join(root, 'upstream.json')}: vendor must be ${vendor}`);
    for (const relativePath of ['audit.mjs', 'census/generate-model.mjs', 'groundtruth.json', 'groundtruth.html']) {
      if (!existsSync(join(root, relativePath)))
        issues.push(`${join(root, relativePath)}: required Layer 0 workflow file is missing`);
    }
    for (const name of [
      `surface:audit:${vendor}`,
      `surface:model:${vendor}`,
      `surface:sanitize:${vendor}`,
      `surface:privacy:${vendor}`,
    ]) {
      if (typeof scripts[name] !== 'string' || scripts[name].length === 0) {
        issues.push(`${join(packageRoot, 'package.json')}: missing script ${name}`);
      }
    }

    const groundTruthPath = join(root, 'groundtruth.json');
    if (!existsSync(groundTruthPath)) continue;
    let groundTruth;
    try {
      groundTruth = JSON.parse(readFileSync(groundTruthPath, 'utf8'));
    } catch (error) {
      issues.push(`${groundTruthPath}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const version = groundTruth?.manifest?.vendorVersion;
    if (groundTruth?.manifest?.vendor !== vendor || typeof version !== 'string') {
      issues.push(`${groundTruthPath}: canonical identity does not match ${vendor}`);
      continue;
    }
    const activeModel = join(root, 'model', `${vendor}@${version}`);
    if (!existsSync(join(activeModel, 'manifest.json'))) {
      issues.push(`${activeModel}: canonical ground truth has no matching authoring model`);
    }
    if (!existsSync(join(activeModel, 'evidence.json'))) {
      issues.push(`${join(activeModel, 'evidence.json')}: active ASM requires an evidence index`);
    }

    const capturesRoot = join(root, 'captures');
    if (!existsSync(capturesRoot)) {
      issues.push(`${capturesRoot}: vendor has no committed capture sets`);
      continue;
    }
    for (const entry of readdirSync(capturesRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const match = new RegExp(`^${vendor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}@(.+)$`).exec(entry.name);
      if (!match) {
        issues.push(`${join(capturesRoot, entry.name)}: capture set directory must be named ${vendor}@<version>`);
        continue;
      }
      issues.push(
        ...validateCaptureFidelity(join(capturesRoot, entry.name), {
          vendor,
          vendorVersion: match[1],
        }),
      );
    }
    if (!existsSync(join(capturesRoot, `${vendor}@${version}`))) {
      issues.push(`${join(capturesRoot, `${vendor}@${version}`)}: active ground truth has no matching capture set`);
    }
  }
  return issues.sort();
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  const issues = auditSurfaceWorkflow();
  if (issues.length > 0) {
    for (const issue of issues) console.error(issue);
    process.exit(1);
  }
  console.log(`surface workflow: ${discoverVendorRoots().length} declared vendors clean`);
}

#!/usr/bin/env node
/**
 * The first job of agent-surface-promotion.yml. The dispatch inputs reach every later job, including `run:`
 * lines on all four runner shells, so they are refused here, read from the environment and never from an
 * expression substituted into a script, unless each is exactly the narrow form the lanes accept. A promotion is
 * also refused where its final push could never land: a tag, or the default branch, whose protection requires a
 * pull request and checks that a workflow token's push cannot satisfy.
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

export function validatePromotionDispatch({ environment, repoRoot = root }) {
  const vendor = environment.AGENT_VENDOR ?? '';
  const version = environment.AGENT_VERSION ?? '';
  const sourceReference = environment.AGENT_SOURCE_REFERENCE ?? '';
  const groundTruth = environment.AGENT_GROUND_TRUTH ?? '';
  const confirm = environment.AGENT_CONFIRM ?? '';
  const issues = [];
  if (!/^[a-z][a-z0-9-]*$/.test(vendor)) {
    issues.push('vendor must be a normalized vendor id');
  } else if (!existsSync(resolve(repoRoot, 'packages', 'surface', 'vendors', vendor, 'upstream.json'))) {
    issues.push(`vendor ${vendor} has no upstream platform policy`);
  }
  if (!/^\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.-]+)?$/.test(version)) {
    issues.push('version must be an exact normalized vendor version');
  }
  if (sourceReference !== '' && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sourceReference)) {
    issues.push('source_reference must be empty or an exact release tag');
  }
  if (groundTruth !== `packages/surface/vendors/${vendor}/groundtruth.json`) {
    issues.push(`ground_truth must be exactly packages/surface/vendors/${vendor}/groundtruth.json`);
  }
  if (confirm !== 'rehearse' && confirm !== 'promote') issues.push('confirm must be rehearse or promote');
  if (confirm === 'promote') {
    if (environment.GITHUB_REF_TYPE !== 'branch') {
      issues.push('a promotion commits to the branch it was dispatched from; dispatch it from a branch');
    } else if (!environment.DEFAULT_BRANCH || environment.GITHUB_REF_NAME === environment.DEFAULT_BRANCH) {
      issues.push(
        'a promotion never runs on the default branch: its protection rejects the workflow push; dispatch it ' +
          'from the candidate branch',
      );
    }
  }
  return issues;
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  const issues = validatePromotionDispatch({ environment: process.env });
  if (issues.length > 0) {
    console.error(`dispatch refused (${issues.length} issue(s)):`);
    for (const issue of issues) console.error(`  - ${issue}`);
    process.exit(1);
  }
  console.log(
    `dispatch accepted: ${process.env.AGENT_CONFIRM} ${process.env.AGENT_VENDOR} ${process.env.AGENT_VERSION}`,
  );
}

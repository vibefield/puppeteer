import { describe, expect, it } from 'vitest';
import { isAgentLaunchRefusedError } from '@vibefield/puppeteer-core';
import { AppServerError } from './app-server-client.js';
import {
  CodexModelProviderRefusedError,
  asCodexModelProviderRefusal,
  codexModelProviderRefusal,
} from './model-provider-error.js';

// The `data` of the three refusals in probes/codex@0.166.0/provider-mismatch-results.json, plus the
// policy variant read from rust-v0.166.0 (v2/model_provider_error.rs), which the census cannot provoke.
const refused = (data: unknown, code = -32600) =>
  new AppServerError({ code, message: 'display text the adapter must not parse', data });

describe('Codex model-provider refusals (0.166.0)', () => {
  it('decodes each variant from the error data alone', () => {
    expect(
      codexModelProviderRefusal(
        refused({ type: 'modelProviderMismatch', modelProvider: 'fake', currentModelProvider: 'other' }),
      ),
    ).toEqual({ type: 'modelProviderMismatch', modelProvider: 'fake', currentModelProvider: 'other' });
    expect(codexModelProviderRefusal(refused({ type: 'modelProviderNotConfigured', modelProvider: 'fake' }))).toEqual({
      type: 'modelProviderNotConfigured',
      modelProvider: 'fake',
    });
    expect(
      codexModelProviderRefusal(
        refused({ type: 'modelProviderPolicyConflict', modelProvider: 'fake', requiredModelProvider: 'openai' }),
      ),
    ).toEqual({ type: 'modelProviderPolicyConflict', modelProvider: 'fake', requiredModelProvider: 'openai' });
  });

  it('leaves every other failure alone, including 0.164.0 answering an unconfigured provider without data', () => {
    expect(codexModelProviderRefusal(refused(null))).toBeUndefined();
    expect(codexModelProviderRefusal(refused({ type: 'cloudConfigBundle' }))).toBeUndefined();
    expect(
      codexModelProviderRefusal(refused({ type: 'modelProviderMismatch', modelProvider: 'fake' })),
    ).toBeUndefined();
    expect(
      codexModelProviderRefusal(refused({ type: 'modelProviderNotConfigured', modelProvider: 'fake' }, -32603)),
    ).toBeUndefined();
    expect(codexModelProviderRefusal(new Error('no rollout found for thread id'))).toBeUndefined();
    const other = refused(null);
    expect(asCodexModelProviderRefusal(other)).toBe(other);
  });

  it("is the adapter's launch refusal, with a code and a sentence built from the data", () => {
    const error = asCodexModelProviderRefusal(
      refused({ type: 'modelProviderPolicyConflict', modelProvider: 'fake', requiredModelProvider: 'openai' }),
    );
    expect(error).toBeInstanceOf(CodexModelProviderRefusedError);
    expect(isAgentLaunchRefusedError(error)).toBe(true);
    expect(error).toMatchObject({
      code: 'CODEX_MODEL_PROVIDER_POLICY_CONFLICT',
      message: 'This Codex thread uses model provider "fake", but the organization requires "openai".',
    });
  });

  it('quotes back no provider id that is not a plain identifier', () => {
    expect(
      codexModelProviderRefusal(refused({ type: 'modelProviderNotConfigured', modelProvider: 'a "quoted"\nid' })),
    ).toBeUndefined();
  });
});

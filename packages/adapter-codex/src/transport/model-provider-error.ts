/**
 * Codex's model-provider admission refusals (findings C9).
 *
 * rust-v0.166.0 checks a thread's provider before it resumes or takes input
 * (`ConfigManager::load_for_resume` and `check_thread_model_provider_for_input`,
 * app-server/src/config_manager.rs) and answers a refusal as JSON-RPC -32600 whose
 * `data` is the serialized `ModelProviderError` (`config_load_error`,
 * request_processors/config_errors.rs; schema `v2/ModelProviderError.json`).
 * Measured hermetically in probes/codex@0.166.0/provider-mismatch-results.json:
 * a cold `thread/resume` after the configured provider changed, one whose saved
 * provider is no longer configured, and `turn/start` or `thread/resume` on a loaded
 * thread after the configuration changed. 0.164.0 adopted the saved provider instead.
 *
 * Retrying cannot clear any of the three: they last until the person changes the
 * configuration. So the refusal is decoded from `data` alone — never from the
 * server's text — and carried as the adapter's own launch refusal.
 */

import { AgentLaunchRefusedError } from '@vibefield/puppeteer-core';
import { AppServerError } from './app-server-client.js';

export type CodexModelProviderRefusal =
  | { type: 'modelProviderMismatch'; modelProvider: string; currentModelProvider: string }
  | { type: 'modelProviderNotConfigured'; modelProvider: string }
  | { type: 'modelProviderPolicyConflict'; modelProvider: string; requiredModelProvider: string };

export type CodexModelProviderRefusalCode =
  'CODEX_MODEL_PROVIDER_MISMATCH' | 'CODEX_MODEL_PROVIDER_NOT_CONFIGURED' | 'CODEX_MODEL_PROVIDER_POLICY_CONFLICT';

const rec = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

/** A provider id fit to quote back to the person; anything else is left out of the sentence. */
const providerId = (v: unknown): string | undefined =>
  typeof v === 'string' && /^[\w.:@/-]{1,128}$/u.test(v) ? v : undefined;

/** The `ModelProviderError` a refused request carries, or `undefined` for every other failure. */
export function codexModelProviderRefusal(error: unknown): CodexModelProviderRefusal | undefined {
  if (!(error instanceof AppServerError) || error.body.code !== -32600) return undefined;
  const data = rec(error.body.data);
  const modelProvider = providerId(data?.modelProvider);
  if (!data || !modelProvider) return undefined;
  if (data.type === 'modelProviderMismatch') {
    const currentModelProvider = providerId(data.currentModelProvider);
    return currentModelProvider ? { type: data.type, modelProvider, currentModelProvider } : undefined;
  }
  if (data.type === 'modelProviderNotConfigured') return { type: data.type, modelProvider };
  if (data.type === 'modelProviderPolicyConflict') {
    const requiredModelProvider = providerId(data.requiredModelProvider);
    return requiredModelProvider ? { type: data.type, modelProvider, requiredModelProvider } : undefined;
  }
  return undefined;
}

function describe(refusal: CodexModelProviderRefusal): { code: CodexModelProviderRefusalCode; message: string } {
  switch (refusal.type) {
    case 'modelProviderMismatch':
      return {
        code: 'CODEX_MODEL_PROVIDER_MISMATCH',
        message: `This Codex thread uses model provider "${refusal.modelProvider}", but the configured provider is "${refusal.currentModelProvider}".`,
      };
    case 'modelProviderNotConfigured':
      return {
        code: 'CODEX_MODEL_PROVIDER_NOT_CONFIGURED',
        message: `This Codex thread uses model provider "${refusal.modelProvider}", which is no longer configured.`,
      };
    case 'modelProviderPolicyConflict':
      return {
        code: 'CODEX_MODEL_PROVIDER_POLICY_CONFLICT',
        message:
          refusal.modelProvider === refusal.requiredModelProvider
            ? "This Codex thread's model provider settings no longer meet the organization's requirements."
            : `This Codex thread uses model provider "${refusal.modelProvider}", but the organization requires "${refusal.requiredModelProvider}".`,
      };
  }
}

/** A thread Codex will not resume or take input on until its provider configuration changes. */
export class CodexModelProviderRefusedError extends AgentLaunchRefusedError<CodexModelProviderRefusalCode> {
  constructor(readonly refusal: CodexModelProviderRefusal) {
    const { code, message } = describe(refusal);
    super(code, message);
    this.name = 'CodexModelProviderRefusedError';
  }
}

/** `error` as the adapter's refusal when it is a provider admission refusal; otherwise `error` unchanged. */
export function asCodexModelProviderRefusal(error: unknown): unknown {
  const refusal = codexModelProviderRefusal(error);
  return refusal ? new CodexModelProviderRefusedError(refusal) : error;
}

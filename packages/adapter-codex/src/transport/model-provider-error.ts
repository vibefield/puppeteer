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

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** The `ModelProviderError` a refused request carries, or `undefined` for every other failure. */
export function codexModelProviderRefusal(error: unknown): CodexModelProviderRefusal | undefined {
  if (!(error instanceof AppServerError) || error.body.code !== -32600) return undefined;
  // The variant is `data.type` alone; the ids are whatever Codex's configuration names (any
  // string), so they are only sanitised where a sentence quotes them back.
  const data = rec(error.body.data);
  const modelProvider = str(data?.modelProvider);
  if (!data || modelProvider === undefined) return undefined;
  if (data.type === 'modelProviderMismatch') {
    const currentModelProvider = str(data.currentModelProvider);
    return currentModelProvider === undefined ? undefined : { type: data.type, modelProvider, currentModelProvider };
  }
  if (data.type === 'modelProviderNotConfigured') return { type: data.type, modelProvider };
  if (data.type === 'modelProviderPolicyConflict') {
    const requiredModelProvider = str(data.requiredModelProvider);
    return requiredModelProvider === undefined ? undefined : { type: data.type, modelProvider, requiredModelProvider };
  }
  return undefined;
}

/**
 * A provider id as the sentence quotes it: control, format and separator characters
 * dropped, quotes replaced, and at most 64 characters. `undefined` when nothing is left.
 */
function quoted(id: string): string | undefined {
  const shown = id
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '')
    .replace(/"/gu, "'")
    .trim();
  if (!shown) return undefined;
  const chars = [...shown];
  return `"${chars.length > 64 ? `${chars.slice(0, 63).join('')}…` : shown}"`;
}

function describe(refusal: CodexModelProviderRefusal): { code: CodexModelProviderRefusalCode; message: string } {
  const thread = quoted(refusal.modelProvider);
  const uses = thread ? `This Codex thread uses model provider ${thread}` : "This Codex thread's model provider";
  switch (refusal.type) {
    case 'modelProviderMismatch': {
      const current = quoted(refusal.currentModelProvider);
      return {
        code: 'CODEX_MODEL_PROVIDER_MISMATCH',
        message: thread
          ? `${uses}, but the configured provider is ${current ?? 'a different one'}.`
          : `${uses} differs from the configured provider${current ? ` ${current}` : ''}.`,
      };
    }
    case 'modelProviderNotConfigured':
      return {
        code: 'CODEX_MODEL_PROVIDER_NOT_CONFIGURED',
        message: thread ? `${uses}, which is no longer configured.` : `${uses} is no longer configured.`,
      };
    case 'modelProviderPolicyConflict': {
      const required = quoted(refusal.requiredModelProvider);
      return {
        code: 'CODEX_MODEL_PROVIDER_POLICY_CONFLICT',
        message:
          refusal.modelProvider === refusal.requiredModelProvider || !thread || !required
            ? "This Codex thread's model provider settings no longer meet the organization's requirements."
            : `${uses}, but the organization requires ${required}.`,
      };
    }
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

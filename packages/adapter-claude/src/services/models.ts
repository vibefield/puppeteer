import { defineModelService, type AgentModelChoice, type AgentModelService } from '@vibefield/puppeteer-core';
import {
  createNativeRpc,
  nativeArray,
  nativeRecord,
  nativeStrings,
  nativeVersion,
  nativeProbeOptions,
  nativeModelEnvironment,
  type NativeModelProbeOptions,
} from '@vibefield/puppeteer-native-observation';
import { resolveClaudeExecutable } from '../detection.js';
import { createClaudeProfileService, CLAUDE_PROFILE_ROOT_VARIABLE } from './profiles.js';

/** Native initialization model choices, including aliases and their model-specific effort domains. */
export function decodeClaudeModels(value: unknown): AgentModelChoice[] {
  return nativeArray(value).map((item) => {
    const row = nativeRecord(item);
    const efforts =
      row?.supportsEffort === false || row?.supportedEffortLevels === undefined
        ? []
        : nativeStrings(row.supportedEffortLevels);
    return {
      id: row?.value as string,
      label: row?.displayName as string,
      ...(typeof row?.description === 'string' && row.description ? { description: row.description } : {}),
      controls: efforts.length
        ? [{ id: 'effort', label: 'Effort', role: 'effort', values: efforts.map((id) => ({ id, label: id })) }]
        : [],
    };
  });
}

export function createClaudeModelService(options: NativeModelProbeOptions = {}): AgentModelService {
  const profiles = createClaudeProfileService(options);
  return defineModelService({
    provider: { id: 'claude', label: 'Claude', discovery: 'prelaunch' },
    async discover(context) {
      const env = nativeModelEnvironment(
        { ...(options.env ?? process.env), ...(options.home ? { HOME: options.home } : {}) },
        context.profile ? profiles.bindingEnvironment(context.profile) : undefined,
        CLAUDE_PROFILE_ROOT_VARIABLE,
      );
      delete env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
      env.DISABLE_AUTOUPDATER = '1';
      env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
      const probe = nativeProbeOptions(resolveClaudeExecutable(options.executable, env), context, env);
      const version = await nativeVersion(probe);
      const client = createNativeRpc(
        {
          ...probe,
          args: [
            '--print',
            '--input-format',
            'stream-json',
            '--output-format',
            'stream-json',
            '--verbose',
            '--no-session-persistence',
            '--strict-mcp-config',
            '--settings',
            '{"disableAllHooks":true}',
            '--tools',
            '',
          ],
        },
        {
          request: (id, method, params) => ({
            type: 'control_request',
            request_id: id,
            request: { subtype: method, ...nativeRecord(params) },
          }),
          response: (message) => {
            const response = nativeRecord(message.response);
            return {
              id: response?.request_id,
              result: response?.response,
              ...(response?.subtype === 'error' ? { error: response.error } : {}),
            };
          },
        },
      );
      try {
        const initialized = nativeRecord(await client.request('initialize', { hooks: {} }));
        return {
          status: 'available',
          catalog: {
            provider: 'claude',
            cwd: context.cwd,
            ...(context.profile ? { profileId: context.profile.id } : {}),
            observedAt: new Date().toISOString(),
            source: { kind: 'native-protocol', freshness: 'unknown', ...(version ? { nativeVersion: version } : {}) },
            completeness: 'complete',
            customModels: true,
            models: decodeClaudeModels(initialized?.models),
          },
        };
      } finally {
        await client.close();
      }
    },
    toAgentOptions: (selection) => ({
      model: selection.modelId,
      ...(selection.controls?.effort ? { effort: selection.controls.effort } : {}),
    }),
  });
}

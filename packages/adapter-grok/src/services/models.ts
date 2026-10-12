import { defineModelService, type AgentModelChoice, type AgentModelService } from '@vibecook/puppeteer-core';
import {
  NativeProbeError,
  runNativeCommand,
  nativeVersion,
  nativeProbeOptions,
  nativeModelEnvironment,
  type NativeModelProbeOptions,
} from '@vibecook/puppeteer-native-observation';
import { resolveGrokExecutable } from '../detection.js';
import { createGrokProfileService, GROK_PROFILE_ROOT_VARIABLE } from './profiles.js';

/** The explicit utility's output, never an interactive terminal screen. Verified on Grok 1.0.50. */
export function decodeGrokModels(output: string): AgentModelChoice[] {
  const text = output.replace(/\u001b\[[0-9;]*[A-Za-z]/gu, '');
  const index = text.indexOf('Available models:');
  if (index < 0) throw new NativeProbeError('invalid-response');
  return text
    .slice(index + 'Available models:'.length)
    .split(/\r?\n/u)
    .filter((line) => line.trim())
    .map((line) => {
      const match = /^\s*[*-]\s+(\S+)(?:\s+\(default\))?\s*$/u.exec(line);
      if (!match?.[1]) throw new NativeProbeError('invalid-response');
      return { id: match[1], label: match[1], controls: [] };
    });
}

export function createGrokModelService(options: NativeModelProbeOptions = {}): AgentModelService {
  const profiles = createGrokProfileService(options);
  return defineModelService({
    // Every managed TUI, fresh or resumed, joins its session through --resume with the launch's --model.
    provider: { id: 'grok', label: 'Grok', discovery: 'prelaunch', resumeSelection: true },
    async discover(context) {
      const env = nativeModelEnvironment(
        { ...(options.env ?? process.env), ...(options.home ? { HOME: options.home } : {}), NO_COLOR: '1' },
        context.profile ? profiles.bindingEnvironment(context.profile) : undefined,
        GROK_PROFILE_ROOT_VARIABLE,
      );
      const probe = nativeProbeOptions(resolveGrokExecutable(options.executable, env), context, env);
      const version = await nativeVersion(probe);
      const result = await runNativeCommand({ ...probe, args: ['models'] });
      return {
        status: 'available',
        catalog: {
          provider: 'grok',
          cwd: context.cwd,
          ...(context.profile ? { profileId: context.profile.id } : {}),
          observedAt: new Date().toISOString(),
          source: {
            kind: 'native-command',
            freshness: result.stderr.trim() ? 'stale' : 'unknown',
            ...(version ? { nativeVersion: version } : {}),
          },
          completeness: result.stderr.trim() ? 'partial' : 'complete',
          customModels: true,
          models: decodeGrokModels(result.stdout),
        },
      };
    },
    toAgentOptions: (selection) => ({ model: selection.modelId }),
  });
}

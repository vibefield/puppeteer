import { defineModelService, type AgentModelChoice, type AgentModelService } from '@vibefield/puppeteer-core';
import {
  NativeProbeError,
  nativeArray,
  nativeRecord,
  nativeStrings,
  nativeProbeOptions,
  nativeModelEnvironment,
  readNativeJsonResponse,
  runNativeCommand,
  type NativeModelProbeOptions,
} from '@vibefield/puppeteer-native-observation';
import { OPENCODE_VERSION_FLAG, readOpenCodeVersion, resolveOpenCodeExecutable } from '../detection.js';
import { startOpenCodeBackend, type OpenCodeBackend } from '../launch/backend.js';
import { withoutOpenCodeServerPasswords } from '../launch/credentials.js';
import { loopbackFetch } from '../transport/loopback-fetch.js';
import { createOpenCodeProfileService, OPENCODE_PROFILE_ROOT_VARIABLE } from './profiles.js';

/** The global catalog contains disconnected providers; only connected choices may be launched immediately. */
export function decodeOpenCodeModels(value: unknown): AgentModelChoice[] {
  const response = nativeRecord(value);
  const connected = new Set(nativeStrings(response?.connected));
  return nativeArray(response?.all).flatMap((item) => {
    const provider = nativeRecord(item);
    if (typeof provider?.id !== 'string') throw new NativeProbeError('invalid-response');
    if (!connected.has(provider.id)) return [];
    const records = nativeRecord(provider.models);
    if (!records) throw new NativeProbeError('invalid-response');
    return Object.values(records).map((item) => {
      const row = nativeRecord(item);
      if (typeof row?.id !== 'string') throw new NativeProbeError('invalid-response');
      if (row.variants !== undefined && !nativeRecord(row.variants)) throw new NativeProbeError('invalid-response');
      const variants = Object.keys(nativeRecord(row.variants) ?? {});
      return {
        id: JSON.stringify([provider.id, row.id]),
        label: typeof row.name === 'string' && row.name ? row.name : row.id,
        group: typeof provider.name === 'string' && provider.name ? provider.name : (provider.id as string),
        controls: variants.length
          ? [
              {
                id: 'variant',
                label: 'Variant',
                role: 'variant' as const,
                values: variants.map((id) => ({ id, label: id })),
              },
            ]
          : [],
      };
    });
  });
}

/**
 * `GET /provider` on the probe's private backend. A `serve --port 0` backend usually reuses the origin a stopped
 * predecessor held, so the request goes through the loopback fetch that survives that predecessor's stale socket.
 */
export async function readOpenCodeProviders(
  backend: Pick<OpenCodeBackend, 'origin' | 'username' | 'password'>,
  directory: string,
  signal: AbortSignal | undefined,
  fetchImpl: typeof fetch = loopbackFetch,
): Promise<unknown> {
  const response = await fetchImpl(backend.origin + '/provider?directory=' + encodeURIComponent(directory), {
    headers: {
      Authorization: 'Basic ' + Buffer.from(backend.username + ':' + backend.password).toString('base64'),
    },
    ...(signal ? { signal } : {}),
  });
  return readNativeJsonResponse(response);
}

export function createOpenCodeModelService(options: NativeModelProbeOptions = {}): AgentModelService {
  const profiles = createOpenCodeProfileService(options);
  return defineModelService({
    // The private server sets a session's model only when it creates one (POST /session); session.update carries
    // title, metadata, permission and time (openapi 1.18.16 and 1.19.5), and the managed TUI's `attach` takes no --model
    // (1.18.34, draft/artifacts/resume-selection-2026-10-12), so a resumed session keeps its own model.
    provider: { id: 'opencode', label: 'OpenCode', discovery: 'prelaunch', resumeSelection: false },
    async discover(context) {
      const env = nativeModelEnvironment(
        { ...(options.env ?? process.env), ...(options.home ? { HOME: options.home } : {}) },
        context.profile ? profiles.bindingEnvironment(context.profile) : undefined,
        OPENCODE_PROFILE_ROOT_VARIABLE,
      );
      if (context.profile) delete env.OPENCODE_AUTH_CONTENT;
      const probe = nativeProbeOptions(resolveOpenCodeExecutable(options.executable), context, env);
      // The version read is this discovery's release-line check: 2.x is refused before `serve` can open the
      // profile's store, and the backend below does not read it again. It runs without inherited server passwords.
      const { stdout } = await runNativeCommand({
        ...probe,
        env: withoutOpenCodeServerPasswords(probe.env),
        args: [OPENCODE_VERSION_FLAG],
        maxOutputBytes: 64 * 1024,
      });
      const reading = readOpenCodeVersion(stdout);
      if (reading.status === 'unsupported-release-line') throw new NativeProbeError('unsupported');
      const version = reading.status === 'supported' ? reading.version : undefined;
      const backend = await startOpenCodeBackend({
        checkReleaseLine: false,
        executable: probe.executable,
        cwd: context.cwd,
        signal: probe.signal,
        startupTimeoutMs: probe.timeoutMs,
        inheritEnvironment: false,
        env: Object.fromEntries(Object.entries(env).filter((pair): pair is [string, string] => pair[1] !== undefined)),
      });
      try {
        const document = await readOpenCodeProviders(backend, context.cwd, probe.signal);
        return {
          status: 'available',
          catalog: {
            provider: 'opencode',
            cwd: context.cwd,
            ...(context.profile ? { profileId: context.profile.id } : {}),
            observedAt: new Date().toISOString(),
            source: { kind: 'native-protocol', freshness: 'unknown', ...(version ? { nativeVersion: version } : {}) },
            completeness: 'partial',
            customModels: false,
            models: decodeOpenCodeModels(document),
          },
        };
      } finally {
        await backend.dispose();
      }
    },
    toAgentOptions(selection) {
      const [providerID, modelID] = JSON.parse(selection.modelId) as [string, string];
      return {
        model: { providerID, modelID, ...(selection.controls?.variant ? { variant: selection.controls.variant } : {}) },
      };
    },
  });
}

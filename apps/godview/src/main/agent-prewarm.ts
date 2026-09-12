import type { AgentRuntime } from '@vibecook/puppeteer-runtime';

interface AgentPrewarmOptions {
  runtime: Pick<AgentRuntime, 'launchProviders' | 'profiles' | 'prewarm'>;
  defaults: Readonly<Record<string, string>>;
  profileIds?: readonly string[];
  available(executable: string): boolean;
}

/** Optional work for the accounts a new pane binds; callers never await it to show a window. */
export async function prewarmTerminalAgents(options: AgentPrewarmOptions): Promise<void> {
  const explicit = options.profileIds?.filter((id) => id.trim().length > 0) ?? [];
  const selected = explicit.length > 0 ? explicit : Object.values(options.defaults);
  const profiles = selected.length > 0 ? await options.runtime.profiles() : [];
  const bindings = new Map(
    profiles.filter((profile) => selected.includes(profile.id)).map((profile) => [profile.provider, profile.id]),
  );
  const providers = options.runtime
    .launchProviders()
    .filter((provider) => provider.nativeInvocation?.commands.some((command) => options.available(command.executable)));
  await Promise.allSettled(
    providers.map((provider) => options.runtime.prewarm(provider.id, bindings.get(provider.id))),
  );
}

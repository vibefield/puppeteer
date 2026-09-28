import { resolve } from 'node:path';
import { z } from 'zod';
import type { AgentNativeInvocation, AgentNativeInvocationResolution } from '@vibecook/puppeteer-core';
import { readCodexInvocation, type CodexOptionUse, type CodexSessionReading } from './invocation-grammar.js';
import type { CreateCodexTuiSessionOptions } from './tui-session.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ContinuationPathSchema = z.string().trim().min(1).max(8_192);
const CodexContinuationStateSchema = z.union([
  z.strictObject({ version: z.literal(1), home: ContinuationPathSchema }),
  z
    .strictObject({
      version: z.literal(2),
      home: ContinuationPathSchema.optional(),
      imposterRoot: ContinuationPathSchema.optional(),
    })
    .refine((value) => value.home !== undefined || value.imposterRoot !== undefined),
]);

const SANDBOXED_OR_APPROVED =
  'it changes how commands are sandboxed or approved, which a managed session cannot pass on yet';

/**
 * Settings a typed `-c` names that the managed recipe does not carry, each with the
 * clause a person reads. No probe has shown them reaching the thread as they do typed.
 */
const NOT_CARRIED: Readonly<Record<string, string>> = {
  approval_policy: SANDBOXED_OR_APPROVED,
  approvals_reviewer: 'it changes who reviews approvals, which a managed session cannot pass on yet',
  default_permissions: 'it picks a permission profile, which a managed session cannot pass on yet',
  permissions: 'it defines a permission profile, which a managed session cannot pass on yet',
  profile: 'it selects a settings profile, which a managed session cannot pass on yet',
  projects: 'it changes which folders codex trusts, which a managed session cannot pass on yet',
  sandbox_mode: SANDBOXED_OR_APPROVED,
  sandbox_permissions: 'it grants the sandbox extra permissions, which a managed session cannot pass on yet',
  sandbox_workspace_write: SANDBOXED_OR_APPROVED,
};

export interface CodexNativeInvocationOptions {
  resumeInvocation?: string[] | undefined;
  executable?: string | undefined;
  env?: Record<string, string> | undefined;
  appServerEnv?: Record<string, string> | undefined;
  /** Start parameters of the thread the adapter starts, as typed. */
  model?: string | undefined;
  sandbox?: CreateCodexTuiSessionOptions['sandbox'];
  approvalPolicy?: CreateCodexTuiSessionOptions['approvalPolicy'];
  /**
   * A typed launch of a new thread: the sandbox and approval policy the person did not
   * type come from their configuration, as they do typed. Never set for a resume, which
   * starts nothing, nor for the imposter, which has no configuration to read.
   */
  permissionDefaults?: 'configuration' | undefined;
  /** Typed settings for the private app-server's own command line. */
  appServerArguments?: string[] | undefined;
  /** Typed arguments for the TUI's command line, after the adapter's `--remote`. */
  tuiArguments?: string[] | undefined;
  /** The typed prompt, which the TUI submits when it joins the thread. */
  prompt?: string | undefined;
}

export interface RestoreCodexContinuationOptions {
  imposterExecutable?: string | undefined;
}

interface Refusal {
  readonly index: number;
  readonly reason: string;
  readonly argument: string;
}

/** Two settings overlap when they are one setting or one contains the other (`features`, `features.goals`). */
function overlaps(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}.`) || right.startsWith(`${left}.`);
}

/**
 * What the managed recipe carries of a session reading, or the first argument (in
 * argv order) it cannot carry. `imposter`: the stand-in's app-server takes the
 * thread's start parameters, but its attach mode reads only `resume <id>` and
 * `--remote` — anything for the TUI or the server would be silently dropped.
 */
function carry(
  session: CodexSessionReading,
  imposter: boolean,
): { refusal: Refusal } | { resume?: string; options: CodexNativeInvocationOptions } {
  const refusals: Refusal[] = [];
  const refuse = (index: number, reason: string, argument: string): void => {
    refusals.push({ index, reason, argument });
  };
  const options: CodexNativeInvocationOptions = {};
  const appServerArguments: string[] = [];
  const tuiArguments: string[] = [];
  const settings: Array<{ setting: string; use: CodexOptionUse }> = [];
  const selectors: CodexOptionUse[] = [];
  let bypass: CodexOptionUse | undefined;
  let images = false;

  for (const use of session.options) {
    const { row } = use;
    if (row.class === 'rejected') {
      refuse(use.index, row.why, use.token);
      continue;
    }
    const landing = row.landing;
    if (landing === 'selector') {
      selectors.push(use);
      continue;
    }
    if (landing?.startsWith('thread-')) {
      if (session.resume) {
        refuse(
          use.index,
          'a managed session cannot change the model or permissions of a session it resumes',
          use.token,
        );
        continue;
      }
      if (landing === 'thread-model') {
        options.model = use.values[0];
        settings.push({ setting: 'model', use });
      }
      if (landing === 'thread-sandbox') options.sandbox = use.values[0] as CodexNativeInvocationOptions['sandbox'];
      if (landing === 'thread-approval') {
        options.approvalPolicy = use.values[0] as CodexNativeInvocationOptions['approvalPolicy'];
      }
      if (landing === 'thread-bypass') bypass = use;
      continue;
    }
    if (imposter) {
      refuse(use.index, 'the imposter stand-in cannot carry this argument', use.token);
      continue;
    }
    if (landing === 'server' || landing === 'server-search') {
      if (session.resume) {
        refuse(use.index, 'a managed session cannot carry settings into a session it resumes yet', use.token);
        continue;
      }
      const name = row.names[row.names.length - 1]!;
      if (landing === 'server-search') {
        settings.push({ setting: 'web_search', use });
        appServerArguments.push('--config=web_search=live');
        tuiArguments.push('--search');
        continue;
      }
      const value = use.values[0]!;
      let setting = `features.${value}`;
      if (name === '--config') {
        const equals = value.indexOf('=');
        if (equals < 0) {
          refuse(use.index, '-c needs key=value', use.token);
          continue;
        }
        // A dotted TOML key, quotes and spaces dropped: `"sandbox_mode"` is sandbox_mode.
        setting = value.slice(0, equals).replace(/["'\s]/gu, '');
        const family = setting.split('.')[0]!;
        if (Object.hasOwn(NOT_CARRIED, family)) {
          refuse(use.index, NOT_CARRIED[family]!, use.token);
          continue;
        }
      }
      settings.push({ setting, use });
      appServerArguments.push(`${name}=${value}`);
      tuiArguments.push(`${name}=${value}`);
      continue;
    }
    // landing === 'tui'
    const name = row.names[row.names.length - 1]!;
    if (name === '--image') {
      images = true;
      for (const value of use.values) tuiArguments.push(`--image=${value}`);
    } else {
      tuiArguments.push(name);
    }
  }

  if (bypass) {
    const pair = session.options.find(
      (use) => use.row.landing === 'thread-sandbox' || use.row.landing === 'thread-approval',
    );
    if (pair) {
      const later = pair.index > bypass.index ? pair : bypass;
      refuse(
        later.index,
        '--dangerously-bypass-approvals-and-sandbox already sets the sandbox and the approvals',
        later.token,
      );
    }
    options.sandbox = 'danger-full-access';
    options.approvalPolicy = 'never';
  }
  // One thing is said once: two different options may not both decide one setting.
  settings.forEach(({ setting, use }, at) => {
    const earlier = settings
      .slice(0, at)
      .find((other) => other.use.row !== use.row && overlaps(other.setting, setting));
    if (earlier) refuse(use.index, `${setting} is given twice`, use.token);
  });

  let resume: string | undefined;
  let prompt = session.prompt;
  if (session.resume) {
    if (session.prompt) {
      refuse(
        session.prompt.index,
        'a managed session cannot carry a prompt typed before resume yet',
        session.prompt.value,
      );
    }
    const [target, afterTarget] = session.resumePositionals;
    prompt = afterTarget;
    if (selectors.length > 1) {
      refuse(
        selectors[1]!.index,
        'a managed session carries one of --last and --all at a time yet',
        selectors[1]!.token,
      );
    }
    if (selectors.length > 0 || target === undefined) {
      if (target !== undefined) {
        refuse(target.index, 'a managed session cannot carry a word after --last or --all yet', target.value);
      }
      if (images) {
        const image = session.options.find((use) => use.row.names.includes('--image'))!;
        refuse(image.index, 'a managed session cannot carry images into the resume picker yet', image.token);
      }
      options.resumeInvocation = ['resume', ...selectors.map((use) => use.token)];
    } else if (UUID.test(target.value)) {
      resume = target.value;
    } else {
      refuse(target.index, 'a managed session resumes a session by its id, not by its name, yet', target.value);
    }
  }
  if (prompt !== undefined) {
    if (imposter) refuse(prompt.index, 'the imposter stand-in cannot carry this argument', prompt.value);
    options.prompt = prompt.value;
  }

  if (refusals.length > 0) {
    return { refusal: refusals.reduce((first, next) => (next.index < first.index ? next : first)) };
  }
  if (appServerArguments.length > 0) options.appServerArguments = appServerArguments;
  if (tuiArguments.length > 0) options.tuiArguments = tuiArguments;
  if (!session.resume && !imposter) options.permissionDefaults = 'configuration';
  return { ...(resume ? { resume } : {}), options };
}

/**
 * Codex owns its CLI grammar (invocation-grammar.ts) and the app-server/socket
 * topology behind it: a utility, a one-shot or an agent elsewhere passes through
 * as typed; a session is carried into the managed recipe, or rejected naming the
 * first argument the recipe cannot carry.
 */
export function normalizeCodexNativeInvocation(
  invocation: AgentNativeInvocation,
): AgentNativeInvocationResolution<CodexNativeInvocationOptions> {
  if (invocation.providerId !== 'codex') return { status: 'rejected', reason: 'provider mismatch' };
  const reading = readCodexInvocation(invocation.argv);
  if (reading.kind === 'passthrough')
    return { status: 'passthrough', kind: reading.passthrough, reason: reading.reason };
  if (reading.kind === 'rejected') return { status: 'rejected', reason: reading.reason, argument: reading.argument };

  const carried = carry(reading.session, invocation.implementation.kind === 'imposter');
  if ('refusal' in carried) {
    return { status: 'rejected', reason: carried.refusal.reason, argument: carried.refusal.argument };
  }
  const options = carried.options;

  const sharedEnv: Record<string, string> = {};
  const codexHome = invocation.environment.CODEX_HOME;
  if (codexHome) sharedEnv.CODEX_HOME = resolve(invocation.cwd, codexHome);
  if (invocation.implementation.kind === 'imposter') {
    const stateRoot = invocation.implementation.stateRoot;
    if (!stateRoot) return { status: 'rejected', reason: 'Codex imposter requires an isolated state root' };
    options.executable = invocation.implementation.executable;
    sharedEnv.AI_PERSONA = 'codex';
    sharedEnv.PUPPETEER_IMPOSTER_HOME = stateRoot;
  }
  if (Object.keys(sharedEnv).length > 0) {
    options.env = { ...sharedEnv };
    options.appServerEnv = { ...sharedEnv };
  }
  return {
    status: 'accepted',
    ...(carried.resume ? { resume: carried.resume } : {}),
    ...(Object.keys(options).length > 0 ? { options } : {}),
  };
}

export function captureCodexContinuationState(
  options: CodexNativeInvocationOptions | undefined,
  cwd: string,
  processEnvironment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const environment = options?.appServerEnv ?? options?.env;
  const home = environment?.CODEX_HOME ?? processEnvironment.CODEX_HOME;
  const imposterRoot = environment?.PUPPETEER_IMPOSTER_HOME;
  if (!home?.trim() && !imposterRoot?.trim()) return undefined;
  return JSON.stringify({
    version: 2,
    ...(home?.trim() ? { home: resolve(cwd, home) } : {}),
    ...(imposterRoot?.trim() ? { imposterRoot: resolve(cwd, imposterRoot) } : {}),
  });
}

export function restoreCodexContinuationState(
  state: string | undefined,
  options: RestoreCodexContinuationOptions = {},
): CodexNativeInvocationOptions | undefined {
  if (!state) return undefined;
  let decoded: unknown;
  try {
    decoded = JSON.parse(state);
  } catch (cause) {
    throw new Error('invalid Codex continuation state', { cause });
  }
  const parsed = CodexContinuationStateSchema.safeParse(decoded);
  if (!parsed.success) throw new Error('invalid Codex continuation state', { cause: parsed.error });
  const value = parsed.data;
  if (value.version === 1) {
    return {
      env: { CODEX_HOME: value.home },
      appServerEnv: { CODEX_HOME: value.home },
    };
  }
  if (value.imposterRoot && !options.imposterExecutable) {
    throw new Error('Codex continuation requires the configured imposter executable');
  }
  const environment: Record<string, string> = {
    ...(value.home ? { CODEX_HOME: value.home } : {}),
    ...(value.imposterRoot ? { AI_PERSONA: 'codex', PUPPETEER_IMPOSTER_HOME: value.imposterRoot } : {}),
  };
  return {
    ...(value.imposterRoot ? { executable: options.imposterExecutable } : {}),
    env: { ...environment },
    appServerEnv: { ...environment },
  };
}

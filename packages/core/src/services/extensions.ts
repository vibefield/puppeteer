import { z } from 'zod';
import { AgentProviderDescriptorSchema, AgentProviderIdSchema } from './provider.js';
import { AgentProfileIdSchema, type AgentProfile } from './profiles.js';

/**
 * Extensions: what an agent loads beyond itself, read per account profile from
 * the agent's own stores and protocols (RFC 006 track C). Plugins are bundles a
 * marketplace delivers; marketplaces are the catalogs they come from; MCP
 * servers are tool connections; skills are instruction folders.
 *
 * An inventory is native evidence, never a host's intention: every item is
 * what the agent itself holds, from a store file, a protocol read, or its own
 * listing command. Reading never starts an MCP server, never opens a session
 * with one, and never starts an agent session; an agent's own listing may
 * still fetch a server's public sign-in metadata to say whether it needs a
 * sign-in. It never carries a secret: a server's environment and headers are
 * names, its address loses userinfo, query and fragment, and any argument that
 * could hold a credential is masked. Two definitions that differ only in a
 * secret therefore read as one server, which is what a host comparing agents
 * wants.
 */

const NonEmptyStringSchema = z.string().trim().min(1).max(8_192);
const TimestampSchema = z.iso.datetime({ offset: true });

export const ExtensionKindSchema = z.enum(['plugin', 'marketplace', 'mcp-server', 'skill']);
export type ExtensionKind = z.infer<typeof ExtensionKindSchema>;

/** Where an item comes from, as the agent keeps it. */
export const ExtensionOriginSchema = z.enum([
  /** Added to the root by the person, with the agent's own command or in its own folder. */
  'own',
  /** Kept for one project in the agent's store: it belongs to the project, not the profile. */
  'project',
  /** Brought by an installed plugin; it comes and goes with the plugin. */
  'plugin',
  /** Ships with the agent. */
  'bundled',
  /** Put there by an organization, an account, or an app the agent runs inside. */
  'managed',
  /** Written by the agent itself, from its own sessions. */
  'agent',
  /** Another agent's own, which this agent loads from that agent's store. */
  'borrowed',
]);
export type ExtensionOrigin = z.infer<typeof ExtensionOriginSchema>;

const ItemIdSchema = z.string().trim().min(1).max(512);

const itemBase = {
  /** Unique per kind within an inventory: the agent's own key where it has one. */
  id: ItemIdSchema,
  name: z.string().trim().min(1).max(256),
  origin: ExtensionOriginSchema,
  /** Whether the agent loads it, after its own switches. */
  enabled: z.boolean(),
  /**
   * Every profile of this agent reads it from one place (a shared folder, a
   * config the profiles share), so changing it changes it for all of them.
   */
  shared: z.literal(true).optional(),
  /** The plugin item that brought it; only with origin `plugin`. */
  plugin: ItemIdSchema.optional(),
  /** The agent whose own store it is loaded from; only with origin `borrowed`. */
  lender: AgentProviderIdSchema.optional(),
  /** The project it is kept for; only with origin `project`. */
  project: NonEmptyStringSchema.optional(),
  /** Where the agent keeps it, for a host to show: a folder or a store file. */
  location: NonEmptyStringSchema.optional(),
};

export const PluginItemSchema = z.strictObject({
  kind: z.literal('plugin'),
  ...itemBase,
  /** The agent's own version string: semver, or a commit where the agent uses one. */
  version: z.string().trim().min(1).max(128).optional(),
  /** The marketplace item it was installed from. */
  marketplace: ItemIdSchema.optional(),
  description: z.string().trim().min(1).max(2_048).optional(),
});
export type PluginItem = z.infer<typeof PluginItemSchema>;

export const MarketplaceItemSchema = z.strictObject({
  kind: z.literal('marketplace'),
  ...itemBase,
  /** Where the catalog comes from: `owner/repo`, an address, or a folder. */
  source: NonEmptyStringSchema.optional(),
  updatedAt: TimestampSchema.optional(),
});
export type MarketplaceItem = z.infer<typeof MarketplaceItemSchema>;

export const McpTransportSchema = z.enum(['stdio', 'http', 'sse', 'ws']);
export type McpTransport = z.infer<typeof McpTransportSchema>;

const EnvironmentNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u);
const HeaderNameSchema = z.string().regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/u);

export const McpServerItemSchema = z.strictObject({
  kind: z.literal('mcp-server'),
  ...itemBase,
  transport: McpTransportSchema,
  /**
   * The address or command line, as {@link describeMcpUrl} and
   * {@link describeMcpCommand} render it: nothing that could be a secret.
   */
  target: NonEmptyStringSchema,
  /** Names of the environment variables the definition sets; never their values. */
  env: z.array(EnvironmentNameSchema).max(64).optional(),
  /** Names of the headers the definition sends; never their values. */
  headers: z.array(HeaderNameSchema).max(64).optional(),
  /** What the agent says about signing in to it, read without a session. Absent: not known without one. */
  auth: z.enum(['signed-in', 'needs-sign-in']).optional(),
});
export type McpServerItem = z.infer<typeof McpServerItemSchema>;

export const SkillItemSchema = z.strictObject({
  kind: z.literal('skill'),
  ...itemBase,
  description: z.string().trim().min(1).max(2_048).optional(),
  /** The skill's folder is a link, and this is where it points. */
  linkTarget: NonEmptyStringSchema.optional(),
  /**
   * The agent has a switch for this one skill that a host can drive — its own
   * command or protocol, not a settings file only the agent may write.
   */
  switchable: z.literal(true).optional(),
});
export type SkillItem = z.infer<typeof SkillItemSchema>;

export const ExtensionItemSchema = z
  .discriminatedUnion('kind', [PluginItemSchema, MarketplaceItemSchema, McpServerItemSchema, SkillItemSchema])
  .superRefine((item, context) => {
    if (item.plugin !== undefined && item.origin !== 'plugin') {
      context.addIssue({ code: 'custom', message: 'only a plugin-brought item names its plugin', path: ['plugin'] });
    }
    if (item.lender !== undefined && item.origin !== 'borrowed') {
      context.addIssue({ code: 'custom', message: 'only a borrowed item names its lender', path: ['lender'] });
    }
    if (item.origin === 'borrowed' && item.lender === undefined) {
      context.addIssue({ code: 'custom', message: 'a borrowed item names its lender', path: ['lender'] });
    }
    if (item.project !== undefined && item.origin !== 'project') {
      context.addIssue({ code: 'custom', message: 'only a project item names its project', path: ['project'] });
    }
  });
export type ExtensionItem = z.infer<typeof ExtensionItemSchema>;

export const ExtensionSourceSchema = z.strictObject({
  /** How the adapter read the agent: its store files, its protocol, or its own listing command. */
  kind: z.enum(['native-store', 'native-protocol', 'native-listing']),
  stability: z.enum(['documented', 'experimental']),
});
export type ExtensionSource = z.infer<typeof ExtensionSourceSchema>;

export const ExtensionInventorySchema = z
  .strictObject({
    provider: AgentProviderIdSchema,
    profileId: AgentProfileIdSchema,
    fetchedAt: TimestampSchema,
    items: z.array(ExtensionItemSchema).max(4_096),
    /**
     * Kinds the agent has that this read could not cover, each with the reason;
     * every other supported kind is complete.
     */
    unread: z
      .array(z.strictObject({ kind: ExtensionKindSchema, message: z.string().trim().min(1).max(512) }))
      .max(4)
      .optional(),
    source: ExtensionSourceSchema,
  })
  .superRefine((inventory, context) => {
    const keys = new Set<string>();
    inventory.items.forEach((item, index) => {
      const key = `${item.kind} ${item.id}`;
      if (keys.has(key)) {
        context.addIssue({
          code: 'custom',
          message: `duplicate ${item.kind} id: ${item.id}`,
          path: ['items', index, 'id'],
        });
      }
      keys.add(key);
    });
  });
export type ExtensionInventory = z.infer<typeof ExtensionInventorySchema>;

/** How an agent keeps one kind, declared by its adapter. */
export const ExtensionKindSupportSchema = z.strictObject({
  /** In each profile's root, in one place every profile reads, or some of each. */
  store: z.enum(['profile', 'shared', 'mixed']),
  /**
   * How a person changes one: the agent's own command, its protocol, its
   * folders (a skill is a folder where the agent looks), or only inside its app.
   */
  changes: z.enum(['command', 'protocol', 'folder', 'in-app']),
  /** Whether this adapter's inventory reads them. */
  read: z.boolean(),
});
export type ExtensionKindSupport = z.infer<typeof ExtensionKindSupportSchema>;

/** Per kind; a kind that is absent is one the agent does not have. */
export const ExtensionSupportSchema = z.strictObject({
  plugins: ExtensionKindSupportSchema.optional(),
  marketplaces: ExtensionKindSupportSchema.optional(),
  mcpServers: ExtensionKindSupportSchema.optional(),
  skills: ExtensionKindSupportSchema.optional(),
});
export type ExtensionSupport = z.infer<typeof ExtensionSupportSchema>;

export const ExtensionProviderSchema = z.strictObject({
  ...AgentProviderDescriptorSchema.shape,
  support: ExtensionSupportSchema,
});
export type ExtensionProvider = z.infer<typeof ExtensionProviderSchema>;

export const ExtensionFailureSchema = z.strictObject({
  status: z.enum(['unsupported', 'unavailable', 'not-found', 'invalid']),
  provider: AgentProviderIdSchema.optional(),
  message: NonEmptyStringSchema,
  retryable: z.boolean(),
});
export type ExtensionFailure = z.infer<typeof ExtensionFailureSchema>;

/*
 * RFC 006 C2 — acts. A person asks for one server or skill an agent holds to be
 * turned on, turned off or removed; the adapter answers with a plan (the
 * agent's own command or protocol call, and what the act reaches beyond that
 * one item) or with why the agent cannot do it; the runtime runs the plan and
 * reads the agent again. The outcome is that second read, never the output.
 */

export const ExtensionActKindSchema = z.enum(['enable', 'disable', 'remove']);
export type ExtensionActKind = z.infer<typeof ExtensionActKindSchema>;

/** The item an act is about, by the key its inventory gave it. */
export const ExtensionActTargetSchema = z.strictObject({
  kind: z.enum(['mcp-server', 'skill']),
  id: ItemIdSchema,
});
export type ExtensionActTarget = z.infer<typeof ExtensionActTargetSchema>;

/** What an act changes beyond one agent's one item, said before it runs. */
export const ExtensionReachSchema = z.enum([
  /** The definition goes with it: turning it back on needs it again. */
  'definition',
  /** A remote server's stored sign-in goes with it. */
  'sign-in',
  /** One config serves every profile of the agent. */
  'every-profile',
  /** It lives in a folder other profiles, and other agents, read. */
  'shared-folder',
]);
export type ExtensionReach = z.infer<typeof ExtensionReachSchema>;

/** How an available act runs: the agent's own command, or a call on its protocol. */
export const ExtensionActRunSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('command'),
    /** The executable and its arguments, run with no shell and no stdin. */
    argv: z.array(z.string().min(1).max(4_096)).min(1).max(64),
    /** The variables that point the agent at the profile: paths, never a credential. */
    env: z.record(EnvironmentNameSchema, z.string().max(4_096)).optional(),
  }),
  z.strictObject({
    kind: z.literal('protocol'),
    method: NonEmptyStringSchema,
    /** The call's parameters, for the adapter's own `perform`: names and switches, never a secret. */
    params: z.record(z.string(), z.unknown()).optional(),
  }),
]);
export type ExtensionActRun = z.infer<typeof ExtensionActRunSchema>;

const actPlanBase = {
  target: ExtensionActTargetSchema,
  act: ExtensionActKindSchema,
};

export const AvailableExtensionActPlanSchema = z.strictObject({
  ...actPlanBase,
  available: z.literal(true),
  runs: ExtensionActRunSchema,
  /** What runs, as a person reads it: the command line, or the protocol call. */
  display: NonEmptyStringSchema,
  reaches: z.array(ExtensionReachSchema).max(4),
});
export type AvailableExtensionActPlan = z.infer<typeof AvailableExtensionActPlanSchema>;

export const UnavailableExtensionActPlanSchema = z.strictObject({
  ...actPlanBase,
  available: z.literal(false),
  /**
   * `in-app`: only the agent's own app changes it. `no-command`: the agent
   * keeps the switch in a settings file only it may write. `not-own`: it comes
   * with a plugin, a project, an app or another agent, and changes there.
   * `not-held`: the profile's agent does not hold it.
   */
  reason: z.enum(['in-app', 'no-command', 'not-own', 'not-held']),
  /** Why, in the agent's own terms. */
  message: NonEmptyStringSchema,
});
export type UnavailableExtensionActPlan = z.infer<typeof UnavailableExtensionActPlanSchema>;

export const ExtensionActPlanSchema = z.discriminatedUnion('available', [
  AvailableExtensionActPlanSchema,
  UnavailableExtensionActPlanSchema,
]);
export type ExtensionActPlan = z.infer<typeof ExtensionActPlanSchema>;

/** What an adapter's `perform` reports: whether the agent accepted the call. The receipt still reads the agent again. */
export interface ExtensionActOutcome {
  ok: boolean;
  exitCode?: number;
  /** Short reason, never the agent's output. */
  error?: string;
}

export interface ExtensionActIo {
  /** Aborting stops the act and everything it started. */
  signal?: AbortSignal;
  /** Opaque display text as it arrives; never parsed. */
  onOutput?: (chunk: string) => void;
}

/** An act's receipt: decided by reading the agent again after it ran. */
export const ExtensionActReceiptSchema = z.strictObject({
  provider: AgentProviderIdSchema,
  profileId: AgentProfileIdSchema,
  target: ExtensionActTargetSchema,
  act: ExtensionActKindSchema,
  /**
   * `changed`: the second read shows it done. `unchanged`: the agent accepted
   * it and still holds it as before (another layer may decide). `failed`: the
   * agent refused or could not be run, and nothing changed. `unavailable`: the
   * plan said the agent cannot, or the item was not held.
   */
  status: z.enum(['changed', 'unchanged', 'failed', 'unavailable']),
  startedAt: TimestampSchema,
  finishedAt: TimestampSchema,
  /** What ran, as a person reads it. */
  display: NonEmptyStringSchema.optional(),
  exitCode: z.number().int().optional(),
  message: NonEmptyStringSchema,
});
export type ExtensionActReceipt = z.infer<typeof ExtensionActReceiptSchema>;

/** A command line as a person reads it: each argument quoted only where it needs to be. */
export function describeArgv(argv: readonly string[]): string {
  return argv.map(quoteForShow).join(' ');
}

/**
 * A name an agent's own command can take as an argument: letters, digits,
 * underscores and hyphens, never starting with a hyphen (a command would read
 * it as a flag) and never a path. Also safe as one segment of a dotted key.
 */
export const EXTENSION_COMMAND_NAME = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,127}$/u;

/**
 * Why an item that is not the profile's own changes where it comes from, in
 * words a person reads: `label` is the agent's, `lender` the lending agent's.
 */
export function extensionNotOwnWords(label: string, item: ExtensionItem, lender?: string): string {
  switch (item.origin) {
    case 'plugin':
      return item.plugin === undefined
        ? 'It comes with a plugin and changes with it'
        : `It comes with the ${item.plugin} plugin and changes with it`;
    case 'project':
      return `It is kept for one project${item.project === undefined ? '' : `, ${item.project}`}, and changes there`;
    case 'bundled':
      return `It ships with ${label}`;
    case 'borrowed':
      return `${label} loads it from ${lender ?? item.lender ?? 'another agent'} on This Mac, and it changes there`;
    case 'agent':
      return `${label} wrote it itself, and changes it itself`;
    case 'managed':
      return `${label}'s app or your organization adds it, and changes it`;
    default:
      return `It is ${label}'s own`;
  }
}

/** An available plan for one of the agent's own commands. */
export function extensionCommandPlan(fields: {
  target: ExtensionActTarget;
  act: ExtensionActKind;
  argv: readonly string[];
  env?: Record<string, string>;
  reaches?: readonly ExtensionReach[];
}): AvailableExtensionActPlan {
  return {
    target: fields.target,
    act: fields.act,
    available: true,
    runs: {
      kind: 'command',
      argv: [...fields.argv],
      ...(fields.env !== undefined && Object.keys(fields.env).length > 0 ? { env: { ...fields.env } } : {}),
    },
    display: describeArgv(fields.argv),
    reaches: [...(fields.reaches ?? [])],
  };
}

/** Why an agent cannot do an act, in its own terms. */
export function extensionActUnavailable(
  target: ExtensionActTarget,
  act: ExtensionActKind,
  reason: UnavailableExtensionActPlan['reason'],
  message: string,
): UnavailableExtensionActPlan {
  return { target, act, available: false, reason, message };
}

/** One adapter-owned extensions capability, independent of live sessions. */
export interface ExtensionService {
  readonly provider: ExtensionProvider;
  /**
   * What the agent holds for one profile, read from its own stores and
   * protocols: the native default's root for a native-default profile, the
   * managed root otherwise. Never connects to an MCP server, never starts a
   * session, never returns a secret.
   */
  inventory(profile: AgentProfile): Promise<ExtensionInventory | ExtensionFailure>;
  /**
   * RFC 006 C2: what an act on a server or skill this profile's agent holds
   * would run, without running it — or why the agent cannot. Pure: the runtime
   * passes the item as a fresh read found it. Absent, the agent has no acts.
   */
  plan?(profile: AgentProfile, item: McpServerItem | SkillItem, act: ExtensionActKind): ExtensionActPlan;
  /**
   * Runs a protocol plan through the adapter's own transport. A command plan
   * is the runtime's to run, in the clean environment with the plan's variables.
   */
  perform?(profile: AgentProfile, plan: AvailableExtensionActPlan, io: ExtensionActIo): Promise<ExtensionActOutcome>;
}

const MASK = '•••';
/** Argument names and keys that carry a credential. */
const SECRET_NAME =
  /(?:^|[-_.])(?:token|secret|password|passwd|pwd|pass|key|apikey|auth|authorization|credentials?|bearer|cookie|session)(?:$|[-_.])/iu;
/** Known credential prefixes: OpenAI and Anthropic keys, GitHub, Slack, AWS, Google, GitLab, Hugging Face. */
const TOKEN_PREFIX = /^(?:sk-|sk_|ghp_|gho_|ghu_|ghs_|github_pat_|xox[abpr]-|AKIA|AIza|glpat-|hf_)/u;
/** `scheme://[userinfo@]host[path][?query][#fragment]`, the parts a listing may show and must drop. */
const ADDRESS = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/(?:([^@/?#]*)@)?([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/u;
const ENV_REFERENCE = /^\$\{[A-Za-z_][A-Za-z0-9_]*(?::-[^}]*)?\}$/u;

/**
 * An MCP server's address as a host may show it: scheme, host and path. The
 * userinfo, query and fragment go — a query marks itself with `?•••` — and an
 * address that does not parse is masked whole.
 */
export function describeMcpUrl(raw: string): string {
  const trimmed = raw.trim();
  if (ENV_REFERENCE.test(trimmed)) return trimmed;
  const address = ADDRESS.exec(trimmed);
  if (!address || address[3] === '') return MASK;
  const [, scheme, userinfo, host, path, query] = address;
  return `${scheme!.toLowerCase()}://${userinfo !== undefined ? `${MASK}@` : ''}${host}${path}${query !== undefined ? `?${MASK}` : ''}`;
}

/**
 * An MCP server's command line as a host may show it. Arguments that could
 * hold a credential are masked: the value of a secret-named flag (`--token x`,
 * `--api-key=x`) or assignment (`API_KEY=x`), an address's userinfo and query,
 * and any value shaped like a token. Environment references (`${VAR}`) stay:
 * they are names.
 */
export function describeMcpCommand(command: string, args: readonly string[] = []): string {
  const shown: string[] = [maskArgument(command)];
  let maskNext = false;
  for (const arg of args) {
    if (maskNext) {
      shown.push(ENV_REFERENCE.test(arg) ? arg : MASK);
      maskNext = false;
      continue;
    }
    const flag = /^(--?[A-Za-z][A-Za-z0-9_.-]*)(?:=(.*))?$/su.exec(arg);
    if (flag) {
      const name = flag[1]!.replace(/^-+/u, '');
      if (flag[2] !== undefined) {
        shown.push(SECRET_NAME.test(name) ? `${flag[1]}=${maskValue(flag[2])}` : `${flag[1]}=${maskArgument(flag[2])}`);
      } else {
        shown.push(arg);
        maskNext = SECRET_NAME.test(name);
      }
      continue;
    }
    const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/su.exec(arg);
    if (assignment) {
      shown.push(
        `${assignment[1]}=${SECRET_NAME.test(assignment[1]!) ? maskValue(assignment[2]!) : maskArgument(assignment[2]!)}`,
      );
      continue;
    }
    shown.push(maskArgument(arg));
  }
  return shown.map(quoteForShow).join(' ');
}

function maskValue(value: string): string {
  return ENV_REFERENCE.test(value) ? value : MASK;
}

function maskArgument(value: string): string {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(value)) return describeMcpUrl(value);
  return looksLikeToken(value) ? MASK : value;
}

/**
 * A value shaped like a credential whatever its name: a known key prefix, a
 * long hex run, or a long mixed-case run with digits. A package name or a path
 * (lower case, hyphens, slashes) is not.
 */
function looksLikeToken(value: string): boolean {
  if (TOKEN_PREFIX.test(value)) return true;
  if (value.length < 32 || !/^[A-Za-z0-9_+=-]+$/u.test(value)) return false;
  if (/^[0-9a-f]+$/iu.test(value)) return true;
  return /[A-Z]/u.test(value) && /[a-z]/u.test(value) && (value.match(/[0-9]/gu) ?? []).length >= 3;
}

function quoteForShow(value: string): string {
  return /[\s"'\\]/u.test(value) ? JSON.stringify(value) : value;
}

/** A skill's `SKILL.md` frontmatter, as far as a listing needs it. */
export interface SkillFrontmatter {
  name?: string;
  description?: string;
}

/**
 * Reads the top-level `name` and `description` of a `SKILL.md`'s YAML
 * frontmatter: plain, quoted, and folded or literal block scalars. The opening
 * `---` must be the file's first line, as the agents require; anything else is
 * body text and yields nothing.
 */
export function parseSkillFrontmatter(text: string): SkillFrontmatter {
  const lines = text.replace(/^\uFEFF/u, '').split(/\r?\n/u);
  if (lines[0]?.trim() !== '---') return {};
  const end = lines.findIndex((line, index) => index > 0 && /^(?:---|\.\.\.)\s*$/u.test(line));
  if (end < 0) return {};
  const body = lines.slice(1, end);
  const result: SkillFrontmatter = {};
  for (let index = 0; index < body.length; index += 1) {
    const match = /^(name|description):(.*)$/u.exec(body[index]!);
    if (!match) continue;
    const key = match[1] as keyof SkillFrontmatter;
    const rest = match[2]!.trim();
    let value: string;
    if (/^[>|][+-]?$/u.test(rest)) {
      const block: string[] = [];
      while (index + 1 < body.length && (/^\s+\S/u.test(body[index + 1]!) || body[index + 1]!.trim() === '')) {
        index += 1;
        block.push(body[index]!.trim());
      }
      value = rest.startsWith('>') ? block.join(' ').replace(/\s+/gu, ' ') : block.join('\n');
    } else if (/^"(?:[^"\\]|\\.)*"$/u.test(rest)) {
      try {
        value = JSON.parse(rest) as string;
      } catch {
        value = rest.slice(1, -1);
      }
    } else if (/^'(?:[^']|'')*'$/u.test(rest)) {
      value = rest.slice(1, -1).replace(/''/gu, "'");
    } else {
      value = rest.replace(/\s+#.*$/u, '');
    }
    value = value.trim();
    if (value !== '' && result[key] === undefined) result[key] = value;
  }
  return result;
}

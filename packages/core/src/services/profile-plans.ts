import type { AgentProfile, ProfileSet, ProfileSignIn, ProfileSupport, SignInService } from './profiles.js';

/**
 * Plans: what a profile set runs on (RFC 006, "Plans").
 *
 * A person pays for plans — a Claude Max account, a ChatGPT Pro account — and
 * the agents in a set sign in to them. This is the pure reading of a set's
 * identities as plans: which plans the set runs on, whose account each one
 * is, which of the set's agents hold a sign-in on it, and which sign-in each
 * agent runs on. Nothing here is stored or asked of a person; a host
 * recomputes it whenever an identity changes.
 *
 * A sign-in is placed by the first rule that fits:
 * - `api-key`, the method label every adapter gives a raw key, is pay per use
 *   and never a plan.
 * - A sign-in whose agent names the account (a handle or an email) is on that
 *   account's plan. Where several agents in the set name one account, the
 *   service's own agent is the one it is read through: its usage is the plan's.
 * - A borrowed sign-in (`borrowedFrom`) that names no account is on the plan
 *   of the same program's credential: every root that borrows it answers for
 *   one account.
 * - Any other sign-in that names no account is on the plan the service's own
 *   agent named in the set, else on the first plan another agent named without
 *   borrowing. Inside one set a sign-in to a company is taken to be the set's
 *   account with that company, and a host says that the agent did not name it.
 *   With no such plan it is on the service's unnamed plan.
 */

/** The method label every adapter gives a raw, pay-per-use key. */
const API_KEY_METHOD = 'api-key';

/** The account a plan is, as the agent that named it reported it. */
export type ProfilePlanAccount = {
  email?: string;
  /** A non-email handle, such as a GitHub login. */
  account?: string;
  organization?: string;
  /** The agent's own plan label ("max", "Pro"). */
  plan?: string;
};

export type ProfilePlan = {
  /**
   * Unique within its set and stable while the set's sign-ins are: the service
   * id, then `-2`, `-3` … for further plans with the same service.
   */
  id: string;
  service: SignInService;
  /** Whose account, when an agent in the set named it. */
  account?: ProfilePlanAccount;
  /** The profile whose identity named the account; the account's usage is read through it. */
  namedBy?: string;
  /** The program whose sign-in the plan's holders run as, when it is borrowed. */
  borrowedFrom?: string;
  /** The set's profiles holding a sign-in on this plan, in set order. */
  holders: string[];
  /** The other sets with a plan for the same account or the same borrowed sign-in, in set order. */
  alsoIn: string[];
};

/** One sign-in a profile holds, placed on its plan. */
export type ProfileHolding = {
  service: SignInService;
  /** The agent's own method label; absent when a vendor agent reported none. */
  method?: string;
  subscription?: boolean;
  inUse?: boolean;
  email?: string;
  account?: string;
  organization?: string;
  plan?: string;
  borrowedFrom?: string;
  /** A pay-per-use key: never on a plan. */
  key: boolean;
  /** The plan it is on, a `ProfilePlan.id` of its set; absent for a key. */
  planId?: string;
  /**
   * The sign-in the agent runs on: the one in use, else its first
   * subscription, else the first that names an account, else its first.
   */
  runsOn: boolean;
};

export type ProfileSetPlans = {
  setId: string;
  /** In the order the set's agents first hold a sign-in on them. */
  plans: ProfilePlan[];
  /**
   * What each profile in the set holds, in the agent's own order. A profile
   * whose identity is unknown or says nobody is signed in has no entry.
   */
  holdings: Record<string, ProfileHolding[]>;
};

/** A set and its profiles, as the runtime's `profileSets()` answers them. */
export type ProfileSetPlansInput = {
  set: Pick<ProfileSet, 'id'>;
  profiles: readonly AgentProfile[];
};

type SignInLike = Omit<ProfileSignIn, 'method'> & { method?: string };

interface Entry {
  profileId: string;
  /** encounter order across the set: profiles in set order, sign-ins in the agent's */
  order: number;
  holding: ProfileHolding;
  /** the service is the agent's own (its provider declares it) */
  own: boolean;
  /** the account's key, when the sign-in names one */
  who?: string;
}

interface Draft {
  service: SignInService;
  account?: ProfilePlanAccount;
  namedBy?: string;
  namerOwn: boolean;
  borrowedFrom?: string;
  named: boolean;
  entries: Entry[];
  /** what makes a plan in another set the same one */
  matches: Set<string>;
}

const accountKey = (signIn: { account?: string | undefined; email?: string | undefined }): string | undefined =>
  (signIn.account ?? signIn.email)?.trim().toLowerCase() || undefined;

function signInsOf(profile: AgentProfile, service: SignInService | undefined): SignInLike[] {
  const identity = profile.identity;
  if (identity === undefined || !identity.loggedIn) return [];
  if (identity.signIns !== undefined) return identity.signIns;
  // A vendor agent reports one sign-in, to the service its provider declares.
  if (service === undefined) return [];
  return [
    {
      service,
      ...(identity.method !== undefined ? { method: identity.method } : {}),
      ...(identity.email !== undefined ? { email: identity.email } : {}),
      ...(identity.account !== undefined ? { account: identity.account } : {}),
      ...(identity.organization !== undefined ? { organization: identity.organization } : {}),
      ...(identity.plan !== undefined ? { plan: identity.plan } : {}),
      ...(identity.borrowedFrom !== undefined ? { borrowedFrom: identity.borrowedFrom } : {}),
    },
  ];
}

function runsOnIndex(signIns: readonly SignInLike[]): number {
  const inUse = signIns.findIndex((signIn) => signIn.inUse === true);
  if (inUse >= 0) return inUse;
  const subscription = signIns.findIndex((signIn) => signIn.subscription === true);
  if (subscription >= 0) return subscription;
  const named = signIns.findIndex((signIn) => accountKey(signIn) !== undefined);
  return named >= 0 ? named : 0;
}

function holdingOf(signIn: SignInLike, runsOn: boolean): ProfileHolding {
  return {
    service: { id: signIn.service.id, label: signIn.service.label },
    ...(signIn.method !== undefined ? { method: signIn.method } : {}),
    ...(signIn.subscription !== undefined ? { subscription: signIn.subscription } : {}),
    ...(signIn.inUse !== undefined ? { inUse: signIn.inUse } : {}),
    ...(signIn.email !== undefined ? { email: signIn.email } : {}),
    ...(signIn.account !== undefined ? { account: signIn.account } : {}),
    ...(signIn.organization !== undefined ? { organization: signIn.organization } : {}),
    ...(signIn.plan !== undefined ? { plan: signIn.plan } : {}),
    ...(signIn.borrowedFrom !== undefined ? { borrowedFrom: signIn.borrowedFrom } : {}),
    key: signIn.method === API_KEY_METHOD,
    runsOn,
  };
}

function accountOf(holding: ProfileHolding): ProfilePlanAccount {
  return {
    ...(holding.email !== undefined ? { email: holding.email } : {}),
    ...(holding.account !== undefined ? { account: holding.account } : {}),
    ...(holding.organization !== undefined ? { organization: holding.organization } : {}),
    ...(holding.plan !== undefined ? { plan: holding.plan } : {}),
  };
}

function planSet(input: ProfileSetPlansInput, services: ReadonlyMap<string, SignInService | undefined>) {
  const entries: Entry[] = [];
  const holdings: Record<string, ProfileHolding[]> = {};
  for (const profile of input.profiles) {
    const own = services.get(profile.provider);
    const signIns = signInsOf(profile, own);
    if (signIns.length === 0) continue;
    const runsOn = runsOnIndex(signIns);
    const held = signIns.map((signIn, index) => holdingOf(signIn, index === runsOn));
    holdings[profile.id] = held;
    for (const holding of held) {
      const who = accountKey(holding);
      entries.push({
        profileId: profile.id,
        order: entries.length,
        holding,
        own: own?.id === holding.service.id,
        ...(who !== undefined ? { who } : {}),
      });
    }
  }

  // Map order is the order each plan's first rule-fitting sign-in was met.
  const drafts = new Map<string, Draft>();
  const draft = (key: string, entry: Entry, named: boolean): Draft => {
    let found = drafts.get(key);
    if (found === undefined) {
      found = { service: entry.holding.service, namerOwn: false, named, entries: [], matches: new Set() };
      drafts.set(key, found);
    }
    return found;
  };
  const place = (target: Draft, entry: Entry): void => {
    target.entries.push(entry);
  };
  const placed = new Set<Entry>();

  for (const entry of entries) {
    if (entry.holding.key || entry.who === undefined) continue;
    const sid = entry.holding.service.id;
    const target = draft(`named\u0000${sid}\u0000${entry.who}`, entry, true);
    if (target.namedBy === undefined || (entry.own && !target.namerOwn)) {
      target.namedBy = entry.profileId;
      target.namerOwn = entry.own;
      target.account = accountOf(entry.holding);
      if (entry.holding.borrowedFrom !== undefined) target.borrowedFrom = entry.holding.borrowedFrom;
      else delete target.borrowedFrom;
    }
    target.matches.add(`named\u0000${sid}\u0000${entry.who}`);
    if (entry.holding.borrowedFrom !== undefined) {
      target.matches.add(`via\u0000${sid}\u0000${entry.holding.borrowedFrom}`);
    }
    place(target, entry);
    placed.add(entry);
  }

  for (const entry of entries) {
    const from = entry.holding.borrowedFrom;
    if (placed.has(entry) || entry.holding.key || from === undefined) continue;
    const sid = entry.holding.service.id;
    const target =
      [...drafts.values()].find((candidate) => candidate.service.id === sid && candidate.borrowedFrom === from) ??
      draft(`via\u0000${sid}\u0000${from}`, entry, false);
    target.borrowedFrom = from;
    target.matches.add(`via\u0000${sid}\u0000${from}`);
    place(target, entry);
    placed.add(entry);
  }

  for (const entry of entries) {
    if (placed.has(entry) || entry.holding.key) continue;
    const sid = entry.holding.service.id;
    const named = [...drafts.values()].filter(
      (candidate) => candidate.service.id === sid && candidate.named && candidate.borrowedFrom === undefined,
    );
    const target =
      named.find((candidate) => candidate.namerOwn) ?? named[0] ?? draft(`unnamed\u0000${sid}`, entry, false);
    place(target, entry);
    placed.add(entry);
  }

  // Plans in the order the set's agents first hold them; ids by service.
  const ordered = [...drafts.values()]
    .map((candidate) => ({ candidate, first: Math.min(...candidate.entries.map((entry) => entry.order)) }))
    .sort((a, b) => a.first - b.first)
    .map(({ candidate }) => candidate);
  const perService = new Map<string, number>();
  const profileOrder = new Map(input.profiles.map((profile, index) => [profile.id, index]));
  const plans = ordered.map((candidate) => {
    const count = (perService.get(candidate.service.id) ?? 0) + 1;
    perService.set(candidate.service.id, count);
    const id = count === 1 ? candidate.service.id : `${candidate.service.id}-${count}`;
    for (const entry of candidate.entries) entry.holding.planId = id;
    const holders = [...new Set(candidate.entries.map((entry) => entry.profileId))].sort(
      (a, b) => (profileOrder.get(a) ?? 0) - (profileOrder.get(b) ?? 0),
    );
    const plan: ProfilePlan = {
      id,
      service: { ...candidate.service },
      ...(candidate.account !== undefined ? { account: candidate.account } : {}),
      ...(candidate.namedBy !== undefined ? { namedBy: candidate.namedBy } : {}),
      ...(candidate.borrowedFrom !== undefined ? { borrowedFrom: candidate.borrowedFrom } : {}),
      holders,
      alsoIn: [],
    };
    return { plan, matches: candidate.matches };
  });
  return { setId: input.set.id, plans, holdings };
}

/**
 * Every set's plans, and what each of its profiles holds. `providers` gives
 * each agent's own service (`support.service`), which is how a vendor agent's
 * one sign-in is known to be to its own company.
 */
export function profileSetPlans(
  sets: readonly ProfileSetPlansInput[],
  providers: readonly { id: string; support: Pick<ProfileSupport, 'service'> }[],
): ProfileSetPlans[] {
  const services = new Map(providers.map((provider) => [provider.id, provider.support.service]));
  const read = sets.map((input) => planSet(input, services));
  // A plan is also used in another set when that set has a plan for the same
  // account, or runs on the same borrowed sign-in.
  for (const [index, current] of read.entries()) {
    for (const { plan, matches } of current.plans) {
      if (matches.size === 0) continue;
      plan.alsoIn = read
        .filter(
          (other, otherIndex) =>
            otherIndex !== index &&
            other.plans.some((candidate) => [...candidate.matches].some((key) => matches.has(key))),
        )
        .map((other) => other.setId);
    }
  }
  return read.map(({ setId, plans, holdings }) => ({ setId, plans: plans.map(({ plan }) => plan), holdings }));
}

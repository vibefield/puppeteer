/**
 * Kimi Code's managed platform (`managed:kimi-code`), read the way the official
 * CLI reads it (`packages/oauth/src/managed-*.ts` in kimi-code): the OAuth
 * access token Kimi Code keeps in `<root>/credentials/kimi-code.json`, the
 * platform that root signed in to, and one authorized GET.
 *
 * Read-only by construction. Kimi Code owns refresh and persistence, so nothing
 * here writes the credential file, spends the refresh token, or starts `kimi
 * web`: that server's userinfo route refreshes the grant first and, when the
 * refresh fails, rewrites the file with blank tokens (probed 2026-09-23 on Kimi
 * Code 2.0.2, where it signed the account out).
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Points every platform call elsewhere, as it does for the official CLI. */
export const KIMI_CODE_BASE_URL_VARIABLE = 'KIMI_CODE_BASE_URL';
/** The mainland platform, and the CLI's default. */
export const KIMI_CODE_DEFAULT_BASE_URL = 'https://api.kimi.com/coding/v1';
export const KIMI_CODE_GLOBAL_BASE_URL = 'https://api.kimi.ai/coding/v1';

const MANAGED_BASE_URLS = [KIMI_CODE_DEFAULT_BASE_URL, KIMI_CODE_GLOBAL_BASE_URL];

/** The CLI writes `mainland-cn` or `global`; a 2.0.2 root on disk held `cn`. */
const REGION_BASE_URLS = new Map([
  ['cn', KIMI_CODE_DEFAULT_BASE_URL],
  ['mainland-cn', KIMI_CODE_DEFAULT_BASE_URL],
  ['global', KIMI_CODE_GLOBAL_BASE_URL],
]);

/** A token this close to `expires_at` is treated as lapsed rather than raced. */
const TOKEN_EXPIRY_SKEW_MS = 60_000;

const MANAGED_PROVIDER_TABLE = /^\[\s*providers\s*\.\s*(?:"managed:kimi-code"|'managed:kimi-code')\s*\]\s*(?:#.*)?$/u;
const BASE_URL_ENTRY = /^(?:base_url|"base_url"|'base_url')\s*=\s*(?:"([^"\\]*)"|'([^']*)')\s*(?:#.*)?$/u;

const rec = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

const finite = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
};

/**
 * What the stored credential allows without renewing it. It never carries the
 * refresh token: whether one is present is all that is ever read of it.
 */
export type KimiCodeCredential =
  | { state: 'fresh'; accessToken: string }
  /** No credential file (Kimi Code's sign-out removes it), or one whose tokens are blank (what a failed refresh leaves). */
  | { state: 'signed-out' }
  /** The access token is missing or past `expires_at`; renewing it is Kimi Code's alone. */
  | { state: 'expired' }
  /** A file that exists but could not be read or decoded. */
  | { state: 'unreadable' };

export function kimiCodeCredentialPath(root: string): string {
  return join(root, 'credentials', 'kimi-code.json');
}

/** `expires_at` is Unix seconds as Kimi Code writes it; milliseconds are tolerated. */
function expiresAtMs(value: unknown): number | undefined {
  const numeric = finite(value);
  if (numeric === undefined || numeric < 0) return undefined;
  return numeric > 10_000_000_000 ? numeric : numeric * 1_000;
}

/** Decode `credentials/kimi-code.json`: snake_case as Kimi Code writes it, camelCase tolerated. */
export function kimiCodeCredentialFrom(document: unknown, nowMs: number): KimiCodeCredential {
  const credential = rec(document);
  if (!credential) return { state: 'unreadable' };
  const accessToken = str(credential.access_token) ?? str(credential.accessToken);
  const refreshable = str(credential.refresh_token) !== undefined || str(credential.refreshToken) !== undefined;
  if (!accessToken && !refreshable) return { state: 'signed-out' };
  const expiresAt = expiresAtMs(credential.expires_at ?? credential.expiresAt);
  if (!accessToken || (expiresAt !== undefined && expiresAt <= nowMs + TOKEN_EXPIRY_SKEW_MS)) {
    return { state: 'expired' };
  }
  return { state: 'fresh', accessToken };
}

/** Read a root's credential without writing it. A missing file is a signed-out root. */
export async function readKimiCodeCredential(path: string, nowMs: number): Promise<KimiCodeCredential> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { state: 'signed-out' } : { state: 'unreadable' };
  }
  let document: unknown;
  try {
    document = JSON.parse(raw) as unknown;
  } catch {
    // The parser's message can quote the file, and the file holds tokens.
    return { state: 'unreadable' };
  }
  return kimiCodeCredentialFrom(document, nowMs);
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * `base_url` of `[providers."managed:kimi-code"]`, the table Kimi Code writes at
 * login. A line scan rather than a TOML parser: a spelling it does not know
 * falls through to the region marker.
 */
function configuredBaseUrl(toml: string | undefined): string | undefined {
  if (!toml) return undefined;
  let inManagedTable = false;
  for (const line of toml.split(/\r?\n/u)) {
    const entry = line.trim();
    if (entry.startsWith('[')) {
      inManagedTable = MANAGED_PROVIDER_TABLE.test(entry);
      continue;
    }
    if (!inManagedTable) continue;
    const match = BASE_URL_ENTRY.exec(entry);
    if (match) return match[1] ?? match[2];
  }
  return undefined;
}

/** Compared as the CLI compares them: origin without case, path without trailing slashes. */
function normalizedUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return `${url.origin.toLowerCase()}${url.pathname.replace(/\/+$/u, '')}`;
  } catch {
    return undefined;
  }
}

function managedPlatform(value: string | undefined): string | undefined {
  const candidate = value === undefined ? undefined : normalizedUrl(value);
  return candidate === undefined ? undefined : MANAGED_BASE_URLS.find((url) => normalizedUrl(url) === candidate);
}

/**
 * The platform a root signed in to: `KIMI_CODE_BASE_URL`, then the managed
 * provider's `base_url` in the root's config.toml, then the root's `region`
 * marker, then the mainland default. A configured URL counts only when it names
 * one of the two managed platforms, so the access token travels nowhere else
 * unless the environment override sends it there, as it would Kimi Code's own.
 */
export async function resolveKimiCodeBaseUrl(root: string, env: NodeJS.ProcessEnv): Promise<string> {
  const override = env[KIMI_CODE_BASE_URL_VARIABLE]?.trim().replace(/\/+$/u, '');
  if (override) return override;
  const configured = managedPlatform(configuredBaseUrl(await readOptional(join(root, 'config.toml'))));
  if (configured) return configured;
  const region = (await readOptional(join(root, 'region')))?.trim().toLowerCase();
  return (region && REGION_BASE_URLS.get(region)) || KIMI_CODE_DEFAULT_BASE_URL;
}

export type KimiCodeResponse =
  | { status: 'ok'; body: unknown }
  /** A non-2xx answer. Its body is never read: it can echo native detail. */
  | { status: 'http-error'; httpStatus: number; retryAfter?: string }
  | { status: 'invalid-json' }
  /** No answer: the request failed or timed out. */
  | { status: 'failed' };

export interface KimiCodeRequestOptions {
  timeoutMs: number;
  /** Injected so unit tests never reach Kimi's platform. */
  fetchImpl?: typeof fetch | undefined;
}

/**
 * One authorized GET with the headers the CLI's own tests assert. The token
 * travels only in the Authorization header and never reaches a result.
 */
export async function getKimiCodeDocument(
  url: string,
  accessToken: string,
  options: KimiCodeRequestOptions,
): Promise<KimiCodeResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  timer.unref?.();
  try {
    const response = await (options.fetchImpl ?? fetch)(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) {
      const retryAfter = response.headers.get('retry-after')?.trim();
      return { status: 'http-error', httpStatus: response.status, ...(retryAfter ? { retryAfter } : {}) };
    }
    const text = await response.text();
    try {
      return { status: 'ok', body: JSON.parse(text) as unknown };
    } catch {
      return { status: 'invalid-json' };
    }
  } catch {
    return { status: 'failed' };
  } finally {
    clearTimeout(timer);
  }
}

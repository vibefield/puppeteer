/**
 * Payload templating, shared by the op timeline and the scenario runner.
 *
 * It lives in one module on purpose: ops and scenarios both emit onto the same
 * channels, so if they substituted differently the same template string would
 * mean two things depending on which layer ran it — the kind of quiet
 * divergence draft/IMPOSTER.md §2 exists to prevent.
 *
 * Supported forms:
 *   "$<scope>.<field>"  scoped lookup — `$op.tool`, `$stimulus.text`
 *   "$uuid" | "$uuid:name"  stable per run; the same name yields the same uuid,
 *                           which is what correlates a prompt_id across events
 *   "$now"              ISO timestamp at substitution time
 *   "$<binding>"        whole-string binding — `$sessionId`, `$cwd`
 *   "$string:<template>" coerce one resolved primitive binding to a string
 *   "$encodeURIComponent:<template>" URI-encode one resolved string binding
 *   "$workdirKey:<template>" Kimi-v2-compatible opaque workspace key
 */

import { createHash } from 'node:crypto';
import { posix, resolve, win32 } from 'node:path';

export interface TemplateContext {
  /** `$<name>.<field>` lookups, e.g. `{ op: {...}, stimulus: {...} }`. */
  scopes?: Record<string, Record<string, unknown>>;
  /** Whole-string bindings, e.g. `{ $sessionId: '...' }`. */
  bindings?: Record<string, unknown>;
  /**
   * Per-run uuid memo; callers own its lifetime so names stay stable. Optional
   * for templates that cannot contain `$uuid` — the envelope, for instance,
   * where a per-emission uuid would be meaningless.
   */
  uuids?: Map<string, string>;
}

function workdirKey(value: string): string {
  const windowsAbsolute = /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/.test(value);
  const normalized = windowsAbsolute
    ? win32.resolve(value).replaceAll('\\', '/')
    : value.startsWith('/')
      ? posix.resolve(value)
      : resolve(value).replaceAll('\\', '/');
  const base = posix.basename(normalized);
  const slug = base
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .slice(0, 40)
    .replaceAll(/^-+|-+$/g, '');
  const safeSlug = slug === '' || slug === '.' || slug === '..' ? 'workspace' : slug;
  const hash = createHash('sha256').update(normalized).digest('hex').slice(0, 12);
  return `wd_${safeSlug}_${hash}`;
}

export function substitute(value: unknown, context: TemplateContext): unknown {
  if (typeof value === 'string') {
    const stringPrefix = '$string:';
    if (value.startsWith(stringPrefix)) {
      const resolved = substitute(value.slice(stringPrefix.length), context);
      if (!['string', 'number', 'boolean'].includes(typeof resolved)) {
        throw new Error(`${stringPrefix} requires a primitive template`);
      }
      return String(resolved);
    }
    const encodePrefix = '$encodeURIComponent:';
    if (value.startsWith(encodePrefix)) {
      const resolved = substitute(value.slice(encodePrefix.length), context);
      if (typeof resolved !== 'string') {
        throw new Error(`${encodePrefix} requires a string template`);
      }
      return encodeURIComponent(resolved);
    }
    const workdirPrefix = '$workdirKey:';
    if (value.startsWith(workdirPrefix)) {
      const resolved = substitute(value.slice(workdirPrefix.length), context);
      if (typeof resolved !== 'string') throw new Error(`${workdirPrefix} requires a string template`);
      return workdirKey(resolved);
    }
    if (value.startsWith('$uuid')) {
      const name = value.includes(':') ? value.slice(value.indexOf(':') + 1) : value;
      let uuid = context.uuids?.get(name);
      if (!uuid) {
        uuid = crypto.randomUUID();
        context.uuids?.set(name, uuid);
      }
      return uuid;
    }
    if (value === '$now') return new Date().toISOString();
    // Epoch milliseconds, because several codex params are typed as numbers
    // (`startedAtMs`, `completedAtMs`) and an ISO string is off-model there.
    if (value === '$nowMs') return Date.now();
    if (value.startsWith('$') && value.includes('.')) {
      const separator = value.indexOf('.');
      const scopeName = value.slice(1, separator);
      const scope = context.scopes?.[scopeName];
      // An unknown scope is a literal, not an error: a persona may legitimately
      // template a dotted string the imposter does not own.
      if (scope) return scope[value.slice(separator + 1)];
    }
    if (context.bindings && value in context.bindings) return context.bindings[value];
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => substitute(entry, context));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, substitute(entry, context)]),
    );
  }
  return value;
}

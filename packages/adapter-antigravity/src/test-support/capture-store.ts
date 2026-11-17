import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';

/**
 * Raw-capture privacy for the native-TUI evidence capture. Everything the capture writes passes one scrubber:
 * the disposable root becomes `$CAPTURE_ROOT`, the runner's own home `$OPERATOR_HOME`, and each whole-word
 * occurrence of the runner's account name `$OPERATOR_NAME`. Home and name hits are counted; the sanitizer refuses a
 * capture with any home hit, and one with a name hit until a person has looked where it landed (census/README.md).
 */
export class CaptureScrubber {
  operatorHomeHits = 0;
  operatorNameHits = 0;
  private readonly replacements: Array<[string, string]>;
  private readonly name: RegExp | undefined;

  constructor(root: string) {
    const spellings: Array<[string, string]> = [[root, '$CAPTURE_ROOT']];
    // macOS reports a temp root under /private while a process may name it through the /var or /tmp link.
    if (root.startsWith('/private/')) spellings.push([root.slice('/private'.length), '$CAPTURE_ROOT']);
    const home = homedir();
    if (home.length > 1) spellings.push([home, '$OPERATOR_HOME']);
    this.replacements = spellings.sort((a, b) => b[0].length - a[0].length);
    let account = '';
    try {
      account = userInfo().username;
    } catch {
      // No account name to count.
    }
    const escaped = account.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    this.name = account.length >= 3 ? new RegExp(`\\b${escaped}\\b`, 'g') : undefined;
  }

  /** Scrub text the capture writes, counting what it replaced. */
  scrub(text: string): string {
    return this.replace(text, true);
  }

  /** Scrub text that is only printed (an error rethrown to the runner's console): replaced, never counted. */
  redact(text: string): string {
    return this.replace(text, false);
  }

  private replace(text: string, count: boolean): string {
    let scrubbed = text;
    for (const [needle, placeholder] of this.replacements) {
      const hits = scrubbed.split(needle).length - 1;
      if (hits === 0) continue;
      if (count && placeholder === '$OPERATOR_HOME') this.operatorHomeHits += hits;
      scrubbed = scrubbed.replaceAll(needle, () => placeholder);
    }
    if (this.name) {
      const hits = scrubbed.match(this.name)?.length ?? 0;
      if (count) this.operatorNameHits += hits;
      if (hits > 0) scrubbed = scrubbed.replace(this.name, () => '$OPERATOR_NAME');
    }
    return scrubbed;
  }

  writeJson(path: string, value: unknown): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${this.scrub(JSON.stringify(value, null, 2))}\n`);
  }
}

export interface StoreInventoryEntry {
  /** Relative to the capture root's `home/` or `workspace/`; never `path`, which the sanitizer would blank. */
  entry: string;
  kind: 'file' | 'directory' | 'symlink' | 'other';
  bytes?: number | undefined;
  sha256?: string | undefined;
  target?: string | undefined;
  /** The entry could not be read; the walk goes on. Never the error text, which can name a path. */
  unreadable?: true | undefined;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function portable(path: string): string {
  return path.split(sep).join('/');
}

/** Every entry under `directory`, with sizes and digests but no contents. An unreadable entry is marked, not fatal. */
export function inventory(base: string, directory: string, scrubber: CaptureScrubber): StoreInventoryEntry[] {
  if (!existsSync(directory)) return [];
  const entries: StoreInventoryEntry[] = [];
  const walk = (current: string): void => {
    let names: string[];
    try {
      names = readdirSync(current).sort();
    } catch {
      entries.push({ entry: portable(relative(base, current)), kind: 'directory', unreadable: true });
      return;
    }
    for (const name of names) {
      const path = join(current, name);
      const entry = portable(relative(base, path));
      try {
        const stat = lstatSync(path);
        if (stat.isSymbolicLink()) {
          entries.push({ entry, kind: 'symlink', target: scrubber.scrub(readlinkSync(path)) });
        } else if (stat.isDirectory()) {
          entries.push({ entry, kind: 'directory' });
          walk(path);
        } else if (stat.isFile()) {
          entries.push({ entry, kind: 'file', bytes: stat.size, sha256: sha256(readFileSync(path)) });
        } else {
          entries.push({ entry, kind: 'other' });
        }
      } catch {
        entries.push({ entry, kind: 'other', unreadable: true });
      }
    }
  };
  walk(directory);
  return entries;
}

export interface CopiedJournals {
  conversations: string[];
  copied: string[];
  withheldBinary: string[];
  /** Files that could not be read or written; listed by name only, and the copy goes on. */
  unreadable: string[];
}

/**
 * Copy every conversation's `brain/<id>/.system_generated/logs/*` text file, scrubbed, to `<output>/logs/<id>/`.
 * A file holding a NUL byte is binary: it is listed, never copied. Nothing else in the store is copied.
 */
export function copyConversationLogs(dataRoot: string, output: string, scrubber: CaptureScrubber): CopiedJournals {
  const result: CopiedJournals = { conversations: [], copied: [], withheldBinary: [], unreadable: [] };
  const brain = join(dataRoot, 'brain');
  if (!existsSync(brain)) return result;
  for (const id of readdirSync(brain).sort()) {
    const logs = join(brain, id, '.system_generated', 'logs');
    if (!existsSync(logs) || !lstatSync(logs).isDirectory()) continue;
    result.conversations.push(id);
    const walk = (current: string): void => {
      let names: string[];
      try {
        names = readdirSync(current).sort();
      } catch {
        result.unreadable.push(`${portable(join(id, relative(logs, current)))}/`);
        return;
      }
      for (const name of names) {
        const path = join(current, name);
        const entry = portable(join(id, relative(logs, path)));
        try {
          const stat = lstatSync(path);
          if (stat.isDirectory()) {
            walk(path);
            continue;
          }
          if (!stat.isFile()) continue;
          const bytes = readFileSync(path);
          if (bytes.includes(0)) {
            result.withheldBinary.push(entry);
            continue;
          }
          const target = join(output, 'logs', entry);
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, scrubber.scrub(bytes.toString('utf8')));
          result.copied.push(entry);
        } catch {
          result.unreadable.push(entry);
        }
      }
    };
    walk(logs);
  }
  return result;
}

/** True once any conversation's journal (`*.jsonl` in its logs) holds `token`. */
export function journalHolds(dataRoot: string, token: string): boolean {
  const brain = join(dataRoot, 'brain');
  if (!existsSync(brain)) return false;
  try {
    for (const id of readdirSync(brain)) {
      const logs = join(brain, id, '.system_generated', 'logs');
      if (!existsSync(logs)) continue;
      for (const name of readdirSync(logs)) {
        if (!name.endsWith('.jsonl')) continue;
        try {
          if (readFileSync(join(logs, name), 'utf8').includes(token)) return true;
        } catch {
          // A journal mid-rotation is read again on the next poll.
        }
      }
    }
  } catch {
    // A folder mid-creation is read again on the next poll.
  }
  return false;
}

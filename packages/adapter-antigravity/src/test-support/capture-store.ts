import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';

/**
 * Raw-capture privacy for the native-TUI evidence capture. Everything the capture writes passes one scrubber:
 * the disposable root becomes `$CAPTURE_ROOT` and the runner's own home `$OPERATOR_HOME`. The runner's account
 * name is never written or printed; its whole-word occurrences are only counted, and the sanitizer refuses a
 * capture that names it until a person has looked (census/README.md).
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

  scrub(text: string): string {
    let scrubbed = text;
    for (const [needle, placeholder] of this.replacements) {
      const hits = scrubbed.split(needle).length - 1;
      if (hits === 0) continue;
      if (placeholder === '$OPERATOR_HOME') this.operatorHomeHits += hits;
      scrubbed = scrubbed.replaceAll(needle, placeholder);
    }
    if (this.name) this.operatorNameHits += scrubbed.match(this.name)?.length ?? 0;
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
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function portable(path: string): string {
  return path.split(sep).join('/');
}

/** Every entry under `directory`, with sizes and digests but no contents. */
export function inventory(base: string, directory: string, scrubber: CaptureScrubber): StoreInventoryEntry[] {
  if (!existsSync(directory)) return [];
  const entries: StoreInventoryEntry[] = [];
  const walk = (current: string): void => {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name);
      const entry = portable(relative(base, path));
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
    }
  };
  walk(directory);
  return entries;
}

export interface CopiedJournals {
  conversations: string[];
  copied: string[];
  withheldBinary: string[];
}

/**
 * Copy every conversation's `brain/<id>/.system_generated/logs/*` text file, scrubbed, to `<output>/logs/<id>/`.
 * A file holding a NUL byte is binary: it is listed, never copied. Nothing else in the store is copied.
 */
export function copyConversationLogs(dataRoot: string, output: string, scrubber: CaptureScrubber): CopiedJournals {
  const result: CopiedJournals = { conversations: [], copied: [], withheldBinary: [] };
  const brain = join(dataRoot, 'brain');
  if (!existsSync(brain)) return result;
  for (const id of readdirSync(brain).sort()) {
    const logs = join(brain, id, '.system_generated', 'logs');
    if (!existsSync(logs) || !lstatSync(logs).isDirectory()) continue;
    result.conversations.push(id);
    const walk = (current: string): void => {
      for (const name of readdirSync(current).sort()) {
        const path = join(current, name);
        const stat = lstatSync(path);
        if (stat.isDirectory()) {
          walk(path);
          continue;
        }
        if (!stat.isFile()) continue;
        const entry = portable(join(id, relative(logs, path)));
        const bytes = readFileSync(path);
        if (bytes.includes(0)) {
          result.withheldBinary.push(entry);
          continue;
        }
        const target = join(output, 'logs', entry);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, scrubber.scrub(bytes.toString('utf8')));
        result.copied.push(entry);
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
  return false;
}

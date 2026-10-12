import { cp, lstat, mkdir, readlink, rename, rm, stat, symlink, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describeFileSteps, type ExtensionFileStep } from '@vibefield/puppeteer-core';

/**
 * RFC 006 C2: a skill's folder placed where an agent looks for skills, or
 * taken away — the steps an adapter planned, performed here one by one and
 * checked as they go. Nothing is ever overwritten or deleted: a link is made
 * only where nothing is, `unlink` takes away only a link (never the folder it
 * points to), and a move takes only a real folder that holds a `SKILL.md` to
 * where nothing is. A step that fails undoes the ones before it, so a skill is
 * never left half placed.
 */

export interface FileStepsResult {
  /** Why it stopped, in words a person reads; absent when every step held. */
  error?: string;
  /** Takes back every step that held, last first — for steps the agent turned out not to read. */
  undo?: () => Promise<boolean>;
}

interface Done {
  step: ExtensionFileStep;
  /** An unlink's old target, to put the link back. */
  previous?: string;
}

/** A failure's reason, never a path or the folder's contents. */
function reason(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  switch (code) {
    case 'EEXIST':
    case 'ENOTEMPTY':
      return 'something is already there';
    case 'ENOENT':
      return 'is not there';
    case 'EACCES':
    case 'EPERM':
      return 'is not allowed';
    case 'ENOTDIR':
      return 'is not a folder';
    case 'EXDEV':
      return 'cannot move across disks';
    default:
      return error instanceof StepRefused ? error.message : 'could not be done';
  }
}

class StepRefused extends Error {}

async function nothingAt(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new StepRefused('something is already there');
}

/** A real folder (never a link) holding a `SKILL.md`: what a skill's move takes. */
async function skillFolderAt(path: string, followLink: boolean): Promise<void> {
  const found = followLink ? await stat(path) : await lstat(path);
  if (!found.isDirectory())
    throw new StepRefused(found.isSymbolicLink() ? 'is a link, not a folder' : 'is not a folder');
  const skill = await stat(join(path, 'SKILL.md')).catch(() => undefined);
  if (skill === undefined || !skill.isFile()) throw new StepRefused('holds no SKILL.md');
}

/** A move within one disk is a rename; across disks, a copy that lands whole, then the old folder goes. */
async function move(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
  }
  try {
    await cp(from, to, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
  } catch (error) {
    await rm(to, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  await rm(from, { recursive: true, force: true });
}

async function perform(step: ExtensionFileStep): Promise<Done> {
  switch (step.op) {
    case 'link': {
      await nothingAt(step.path);
      await skillFolderAt(step.target, true);
      await mkdir(dirname(step.path), { recursive: true });
      await symlink(step.target, step.path, 'dir');
      return { step };
    }
    case 'unlink': {
      const found = await lstat(step.path);
      if (!found.isSymbolicLink()) throw new StepRefused('is a folder, not a link');
      const previous = await readlink(step.path);
      await unlink(step.path);
      return { step, previous };
    }
    default: {
      await skillFolderAt(step.from, false);
      await nothingAt(step.to);
      await mkdir(dirname(step.to), { recursive: true });
      await move(step.from, step.to);
      return { step };
    }
  }
}

async function undo(done: Done): Promise<void> {
  const { step } = done;
  switch (step.op) {
    case 'link':
      if ((await lstat(step.path)).isSymbolicLink()) await unlink(step.path);
      return;
    case 'unlink':
      if (done.previous !== undefined) await symlink(done.previous, step.path, 'dir');
      return;
    default:
      await move(step.to, step.from);
  }
}

/** A path as a person reads it: from `~` when it is under the home. */
function shownPath(path: string, home: string | undefined): string {
  if (home === undefined || home === '') return path;
  if (path === home) return '~';
  return path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}

/** Which step stopped, as a clause that stands alone. */
function failed(step: ExtensionFileStep, home: string | undefined): string {
  switch (step.op) {
    case 'link':
      return `the link at ${shownPath(step.path, home)} could not be made`;
    case 'unlink':
      return `the link at ${shownPath(step.path, home)} could not be taken away`;
    default:
      return `${shownPath(step.from, home)} could not be moved`;
  }
}

/**
 * Performs the steps in order, saying each on `onOutput` as it lands. A step
 * that fails is said with its reason, the ones before it are undone, and the
 * result names the step.
 */
export async function performFileSteps(
  steps: readonly ExtensionFileStep[],
  io: { home?: string; onOutput?: (chunk: string) => void; report?: (error: unknown) => void } = {},
): Promise<FileStepsResult> {
  const say = (line: string) => {
    try {
      io.onOutput?.(`${line}\n`);
    } catch (error) {
      // a host's display failing must not stop the act
      io.report?.(error);
    }
  };
  const done: Done[] = [];
  for (const step of steps) {
    const shown = describeFileSteps([step], io.home);
    try {
      done.push(await perform(step));
      say(shown);
    } catch (error) {
      const why = reason(error);
      say(`${shown}: ${why}`);
      for (const earlier of done.reverse()) {
        try {
          await undo(earlier);
          say(`undone: ${describeFileSteps([earlier.step], io.home)}`);
        } catch (undoError) {
          io.report?.(undoError);
          say(`not undone: ${describeFileSteps([earlier.step], io.home)}`);
        }
      }
      return { error: `${failed(step, io.home)}: ${why}` };
    }
  }
  return {
    undo: async () => {
      let whole = true;
      for (const earlier of [...done].reverse()) {
        try {
          await undo(earlier);
          say(`undone: ${describeFileSteps([earlier.step], io.home)}`);
        } catch (undoError) {
          io.report?.(undoError);
          say(`not undone: ${describeFileSteps([earlier.step], io.home)}`);
          whole = false;
        }
      }
      return whole;
    },
  };
}

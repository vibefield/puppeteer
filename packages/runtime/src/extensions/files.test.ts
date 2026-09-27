import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { performFileSteps } from './files.js';

let root: string | undefined;
afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true });
  root = undefined;
});

async function setup() {
  root = await mkdtemp(join(tmpdir(), 'puppeteer-files-'));
  const kept = join(root, 'kept', 'release-notes');
  await mkdir(kept, { recursive: true });
  await writeFile(join(kept, 'SKILL.md'), '---\nname: release-notes\n---\nWrite the notes.\n');
  const agent = join(root, 'agent', 'skills');
  return { root, kept, agent };
}

describe('performFileSteps', () => {
  it('links a kept folder where the agent looks, making the folder it goes in, and takes the link away again', async () => {
    const { kept, agent } = await setup();
    const output: string[] = [];
    const place = join(agent, 'release-notes');
    const linked = await performFileSteps([{ op: 'link', path: place, target: kept }], {
      onOutput: (chunk) => output.push(chunk),
    });
    expect(linked.error).toBeUndefined();
    expect(await readlink(place)).toBe(kept);
    expect(await readFile(join(place, 'SKILL.md'), 'utf8')).toContain('Write the notes.');
    expect(output.join('')).toBe(`link ${kept} → ${place}\n`);

    expect((await performFileSteps([{ op: 'unlink', path: place }])).error).toBeUndefined();
    await expect(lstat(place)).rejects.toMatchObject({ code: 'ENOENT' });
    // the folder a link pointed at stays
    expect(await readFile(join(kept, 'SKILL.md'), 'utf8')).toContain('Write the notes.');
  });

  it('never overwrites, never unlinks a folder, and never moves a link or a folder without a SKILL.md', async () => {
    const { root, kept, agent } = await setup();
    const own = join(agent, 'own');
    await mkdir(own, { recursive: true });
    await writeFile(join(own, 'SKILL.md'), 'mine');
    const home = root;

    const taken = await performFileSteps([{ op: 'link', path: own, target: kept }], { home });
    expect(taken.error).toBe('the link at ~/agent/skills/own could not be made: something is already there');
    const folder = await performFileSteps([{ op: 'unlink', path: own }], { home });
    expect(folder.error).toBe('the link at ~/agent/skills/own could not be taken away: is a folder, not a link');
    expect(await readFile(join(own, 'SKILL.md'), 'utf8')).toBe('mine');

    const linked = join(agent, 'linked');
    await symlink(kept, linked, 'dir');
    const aLink = await performFileSteps([{ op: 'move', from: linked, to: join(root, 'elsewhere') }], { home });
    expect(aLink.error).toBe('~/agent/skills/linked could not be moved: is a link, not a folder');
    const empty = join(agent, 'empty');
    await mkdir(empty);
    const noSkill = await performFileSteps([{ op: 'move', from: empty, to: join(root, 'elsewhere') }], { home });
    expect(noSkill.error).toBe('~/agent/skills/empty could not be moved: holds no SKILL.md');
    // a link to a folder that is no skill is not made either
    const notSkill = await performFileSteps([{ op: 'link', path: join(agent, 'x'), target: empty }], { home });
    expect(notSkill.error).toBe('the link at ~/agent/skills/x could not be made: holds no SKILL.md');
  });

  it("moves an agent's own folder to where it is kept, and undoes every step when a later one fails", async () => {
    const { root, agent } = await setup();
    const own = join(agent, 'changelog');
    await mkdir(own, { recursive: true });
    await writeFile(join(own, 'SKILL.md'), 'changelog');
    const keptAt = join(root, 'kept', 'changelog');
    const blocker = join(root, 'shared', 'changelog');
    await mkdir(blocker, { recursive: true });
    const output: string[] = [];

    const result = await performFileSteps(
      [
        { op: 'move', from: own, to: keptAt },
        { op: 'link', path: own, target: keptAt },
        // something is already in the shared folder under that name: the whole act is undone
        { op: 'move', from: keptAt, to: blocker },
      ],
      { home: root, onOutput: (chunk) => output.push(chunk) },
    );
    expect(result.error).toBe('~/kept/changelog could not be moved: something is already there');
    expect((await lstat(own)).isDirectory()).toBe(true);
    expect((await lstat(own)).isSymbolicLink()).toBe(false);
    expect(await readFile(join(own, 'SKILL.md'), 'utf8')).toBe('changelog');
    await expect(lstat(keptAt)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(output.join('')).toBe(
      [
        'move ~/agent/skills/changelog → ~/kept/changelog',
        'link ~/kept/changelog → ~/agent/skills/changelog',
        'move ~/kept/changelog → ~/shared/changelog: something is already there',
        'undone: link ~/kept/changelog → ~/agent/skills/changelog',
        'undone: move ~/agent/skills/changelog → ~/kept/changelog',
        '',
      ].join('\n'),
    );
  });
});

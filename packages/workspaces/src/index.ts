/**
 * @vibecook/puppeteer-workspaces — direct, exclusive, worktree, and copy
 * workspace providers plus canonical workspace identity and final metadata.
 */

export * from './workspace.js';
export * from './provenance.js';
export { commonGitDirectory, filesFromPorcelain, headRef, parseShortstat } from './git.js';

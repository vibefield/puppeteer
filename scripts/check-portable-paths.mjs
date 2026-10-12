import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function portablePathIssues(paths) {
  const issues = [];
  const spellings = new Map();
  for (const path of paths) {
    const parts = path.split('/');
    if (
      parts.some(
        (part) =>
          !part ||
          /[<>:"\\|?*\u0000-\u001f]/.test(part) ||
          /[ .]$/.test(part) ||
          /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)(?:\.|$)/i.test(part),
      )
    ) {
      issues.push(`${path} cannot be checked out on Windows`);
    }
    for (let i = 1; i <= parts.length; i += 1) {
      const prefix = parts.slice(0, i).join('/');
      const key = prefix.normalize('NFC').toLowerCase();
      const previous = spellings.get(key);
      if (previous && previous !== prefix)
        issues.push(`${prefix} collides with ${previous} on case-insensitive filesystems`);
      else spellings.set(key, prefix);
    }
  }
  return [...new Set(issues)];
}

export function auditPortablePaths(root = fileURLToPath(new URL('..', import.meta.url))) {
  const paths = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\0')
    .filter((path) => path && existsSync(join(root, path)));
  return portablePathIssues(new Set(paths));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const issues = auditPortablePaths();
  if (issues.length) {
    console.error(issues.join('\n'));
    process.exitCode = 1;
  } else console.log('repository paths: portable across supported platforms');
}

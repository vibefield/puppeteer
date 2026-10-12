import assert from 'node:assert/strict';
import test from 'node:test';
import { auditPortablePaths, portablePathIssues } from './check-portable-paths.mjs';

test('tracked working files can be checked out on all supported platforms', () => {
  assert.deepEqual(auditPortablePaths(), []);
});

test('portable paths reject Windows device names, forbidden characters and case collisions', () => {
  for (const path of [
    'events/a:b.json',
    'events/<dynamic>.json',
    'CON.json',
    'x/NUL',
    'COM¹.txt',
    'x/trailing.',
    'x/a\\b',
  ]) {
    assert.ok(
      portablePathIssues([path]).some((issue) => issue.includes('Windows')),
      path,
    );
  }
  assert.ok(portablePathIssues(['src/Foo/a.ts', 'src/foo/b.ts']).some((issue) => issue.includes('collides')));
  assert.deepEqual(portablePathIssues(['events/a%3Ab.json', 'events/thread/started.json', 'events/%43ON.json']), []);
});

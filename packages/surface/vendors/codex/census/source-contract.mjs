#!/usr/bin/env node
/**
 * Carry the exact-source file-change contract (findings C1d) to a new release —
 * only when the source it rests on is unchanged.
 *
 * The contract's meaning (add/delete `diff` = whole file content, update =
 * unified diff, the move suffix, path ordering) was read from named Rust items
 * at one release tag. This script fetches the pinned files at the previous and
 * the new tag, checks the previous pins byte for byte, extracts every named
 * item (with the attributes and doc comments above it, which decide the wire
 * shape) from both, and refuses unless each is byte-identical. Only then does
 * it write the new contract: the same schemas and semantics, the new release
 * identity, and the new file digests. A changed item means the semantics must
 * be re-read by a person, never carried forward.
 *
 * usage: node source-contract.mjs --from <previous version> --version <new version> [--sources <dir>]
 *
 * `--sources <dir>` reads `<dir>/rust-v<version>/<repository path>` instead of
 * raw.githubusercontent.com, for an offline re-check of already fetched files.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const vendorRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function contractPath(version) {
  return join(vendorRoot, 'references', `codex@${version}`, 'source', 'file-changes.json');
}

/** Index of the brace that closes the one opened at `open`, ignoring strings, chars and comments. */
function closingBrace(source, open) {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const character = source[index];
    if (character === '/' && source[index + 1] === '/') {
      index = source.indexOf('\n', index);
      if (index < 0) break;
      continue;
    }
    if (character === '/' && source[index + 1] === '*') {
      index = source.indexOf('*/', index + 2) + 1;
      if (index <= 0) break;
      continue;
    }
    if (character === '"') {
      for (index += 1; index < source.length && source[index] !== '"'; index += 1) {
        if (source[index] === '\\') index += 1;
      }
      continue;
    }
    if (character === "'" && /^'(?:\\.|[^\\'])'/.test(source.slice(index, index + 4))) {
      index = source.indexOf("'", index + 2);
      continue;
    }
    if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new Error('unbalanced braces');
}

/** Start of the attribute and doc-comment block directly above the line holding `offset`. */
function leadingBlockStart(source, offset) {
  let start = source.lastIndexOf('\n', offset - 1) + 1;
  while (start > 0) {
    const previousStart = source.lastIndexOf('\n', start - 2) + 1;
    const line = source.slice(previousStart, start - 1).trim();
    if (!(line.startsWith('#[') || line.startsWith('///'))) break;
    start = previousStart;
  }
  return start;
}

/** The exact text of one named item: `fn`, `struct`, `enum`, or `Enum::Variant`. */
export function extractRustItem(source, symbol) {
  const [owner, variant] = symbol.split('::');
  const header = new RegExp(`\\b(?:fn|struct|enum)\\s+${owner}\\b`).exec(source);
  if (!header) throw new Error(`${symbol}: item not found`);
  const brace = source.indexOf('{', header.index);
  const semicolon = source.indexOf(';', header.index);
  const start = leadingBlockStart(source, header.index);
  if (semicolon >= 0 && (brace < 0 || semicolon < brace)) return source.slice(start, semicolon + 1);
  const end = closingBrace(source, brace);
  const item = source.slice(start, end + 1);
  if (!variant) return item;
  const body = item.slice(brace - start);
  const match = new RegExp(`\\n([ \\t]*)${variant}\\b\\s*(\\{|\\(|,)`).exec(body);
  if (!match) throw new Error(`${symbol}: variant not found`);
  const variantStart = leadingBlockStart(body, match.index + 1);
  const opener = match.index + match[0].length - 1;
  if (match[2] === ',') return body.slice(variantStart, opener + 1);
  const close = match[2] === '{' ? closingBrace(body, opener) : body.indexOf(')', opener);
  return body.slice(variantStart, close + 1);
}

async function fetchSource({ repository, tag, path, sources }) {
  if (sources) {
    const local = join(sources, tag, path);
    if (!existsSync(local)) throw new Error(`missing ${local}`);
    return readFileSync(local);
  }
  const slug = new URL(repository).pathname.replace(/^\/|\/$/g, '');
  const response = await fetch(`https://raw.githubusercontent.com/${slug}/${tag}/${path}`);
  if (!response.ok) throw new Error(`${tag}:${path}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Resolve a release tag to the commit it names, so the record states both. */
function tagCommit(repository, tag) {
  const listing = execFileSync('git', ['ls-remote', repository, `refs/tags/${tag}`, `refs/tags/${tag}^{}`], {
    encoding: 'utf8',
  });
  const lines = listing.trim().split('\n').filter(Boolean);
  const peeled = lines.find((line) => line.endsWith('^{}')) ?? lines[0];
  const commit = peeled?.split(/\s+/)[0];
  if (!/^[0-9a-f]{40}$/.test(commit ?? '')) throw new Error(`cannot resolve ${tag}`);
  return commit;
}

export async function deriveSourceContract({ from, version, sources }) {
  const previous = JSON.parse(readFileSync(contractPath(from), 'utf8'));
  if (previous.vendorVersion !== from || previous.sourceRevision !== `rust-v${from}`) {
    throw new Error(`references/codex@${from} does not pin rust-v${from}`);
  }
  const tag = `rust-v${version}`;
  const sourceFiles = [];
  const items = [];
  for (const file of previous.sourceFiles) {
    const before = await fetchSource({
      repository: previous.sourceRepository,
      tag: previous.sourceRevision,
      ...file,
      sources,
    });
    if (sha256(before) !== file.sha256 || before.length !== file.bytes) {
      throw new Error(`${previous.sourceRevision}:${file.path} no longer matches its pin`);
    }
    const after = await fetchSource({ repository: previous.sourceRepository, tag, path: file.path, sources });
    for (const symbol of file.symbols) {
      const was = extractRustItem(before.toString('utf8'), symbol);
      const now = extractRustItem(after.toString('utf8'), symbol);
      if (was !== now) throw new Error(`${file.path} ${symbol} changed between ${previous.sourceRevision} and ${tag}`);
      items.push({ path: file.path, symbol, sha256: sha256(now), bytes: Buffer.byteLength(now) });
    }
    sourceFiles.push({ ...file, sha256: sha256(after), bytes: after.length });
  }
  const commit = sources ? undefined : tagCommit(previous.sourceRepository, tag);
  const { sourceCommit: _previousCommit, sourceFiles: _previousFiles, ...carried } = previous;
  const contract = {};
  for (const [key, value] of Object.entries(carried)) {
    contract[key] = key === 'vendorVersion' ? version : key === 'sourceRevision' ? tag : value;
    // The tag stays the generator's release pin; the commit it names is recorded beside it.
    if (key === 'sourceRevision' && commit) contract.sourceCommit = commit;
    if (key === 'sourceRevision') contract.sourceFiles = sourceFiles;
  }
  return { contract, items, commit };
}

const argv = process.argv.slice(2);
const flag = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const from = flag('--from');
  const version = flag('--version');
  if (!from || !version) throw new Error('usage: source-contract.mjs --from <version> --version <version>');
  const { contract, items, commit } = await deriveSourceContract({ from, version, sources: flag('--sources') });
  const target = contractPath(version);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(contract, null, 2)}\n`);
  for (const item of items)
    console.log(`unchanged ${item.symbol.padEnd(36)} ${item.sha256.slice(0, 16)} ${item.bytes}B`);
  if (commit) console.log(`${contract.sourceRevision} -> ${commit}`);
  console.log(`wrote ${target}`);
}

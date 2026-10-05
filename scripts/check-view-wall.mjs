#!/usr/bin/env node

// THE VIEW WALL (design-mv §3): a monitor view is a plugged-in module that
// touches nothing outside the root it is given. This checker reads every view
// folder and reports what crosses the wall:
//
//   MV-W1 imports    only the SDK subpaths a view may import (L16), React, and
//                    files inside the view's own folder (worker and CSS
//                    references included)
//   MV-W2 own root   no `document.*`, no `window.*` beyond the allow-list, no
//                    `closest()`, no reaching the root's document or root node,
//                    no global listeners (so no global keys); and in its CSS
//                    (L18) no rule outside its root class `.mv-<view>`, and no
//                    custom property read but the skin's (`MONITOR_SKIN`) and
//                    its own `--mv-<view>-*`
//   MV-W3 no reach   no network or storage, no dynamic `import()`; a worker the
//                    view bundles is allowed
//   MV-W5 host CSS   no host stylesheet names a class a view draws
//
// MV-W4 (conformance) is a test suite in `@vibecook/puppeteer-view-sdk/testing`,
// not a reading of source. Report mode exits 0 whatever it finds (MV-D9: report,
// then fail per view); `--fail <view…>` exits 1 when a listed view breaches,
// which is how each view is closed as it moves onto the SDK, and MV-8 lists them
// all. Sources are parsed with TypeScript, so comments, strings and JSX text
// never count.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** L16: what a view may import from the SDK. */
export const VIEW_SDK_IMPORTS = [
  '@vibecook/puppeteer-view-sdk',
  '@vibecook/puppeteer-view-sdk/react',
  '@vibecook/puppeteer-view-sdk/toolkit',
];
/** L16: what a view's tests may import besides. */
export const VIEW_TEST_IMPORTS = ['@vibecook/puppeteer-view-sdk/testing', 'vitest'];
/**
 * A dependency a view bundles into itself, per view (MV-5, the swarm's physics engine): a pure library the views
 * package declares, which the view carries into its own worker and reaches nothing with. W3 still bans network and
 * storage in the view's own code; the list is finite and named so an isolated realm later knows what to carry.
 */
export const VIEW_RUNTIME_IMPORTS = Object.freeze({ swarm: Object.freeze(['matter-js']) });
const FRAMEWORK_IMPORT = /^react(?:-dom)?(?:\/.*)?$/;

/**
 * The globals a view may reach through `window.` (or `globalThis.`, `self.`):
 * the lead's list, plus the timers, which touch nothing outside the view.
 */
export const WINDOW_ALLOWED = new Set([
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'devicePixelRatio',
  'matchMedia',
  'ResizeObserver',
  'performance',
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
]);
/** MV-W3: network and storage. */
export const REACH_GLOBALS = new Set([
  'fetch',
  'WebSocket',
  'XMLHttpRequest',
  'EventSource',
  'BroadcastChannel',
  'localStorage',
  'sessionStorage',
  'indexedDB',
]);
const GLOBAL_OBJECTS = new Set(['window', 'globalThis', 'self']);
/** What a view may do with its root's document: make detached nodes, nothing else. */
const DOCUMENT_CREATE = new Set(['createElement', 'createElementNS', 'createTextNode', 'createDocumentFragment']);

/** L18: where the SDK lists the skin, the only host custom properties a view's stylesheet may read. */
export const SKIN_SOURCE = 'packages/view-sdk/src/skin.ts';

const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

function walk(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(path));
    else files.push(path);
  }
  return files.sort();
}

function inside(directory, path) {
  const offset = relative(directory, path);
  return offset === '' || (!offset.startsWith('..') && !offset.startsWith(sep) && !/^[A-Za-z]:/.test(offset));
}

/** Why `specifier` crosses the wall from a view's file, or undefined when it does not. */
export function importBreach(specifier, file, viewDirectory, test, runtime = []) {
  if (runtime.includes(specifier)) return undefined;
  if (specifier.startsWith('.') || specifier.startsWith('/')) {
    return inside(viewDirectory, resolve(dirname(file), specifier))
      ? undefined
      : `imports ${specifier}, outside the view's folder`;
  }
  if (VIEW_SDK_IMPORTS.includes(specifier) || FRAMEWORK_IMPORT.test(specifier)) return undefined;
  if (test && VIEW_TEST_IMPORTS.includes(specifier)) return undefined;
  if (specifier === '@vibecook/puppeteer-view-sdk/host') return `imports ${specifier}, which only hosts may (L16)`;
  if (specifier === '@vibecook/puppeteer-view-sdk/testing') return `imports ${specifier} outside a test (L16)`;
  if (specifier.startsWith('@vibecook/puppeteer-view-sdk/')) return `imports ${specifier}, not a view's subpath (L16)`;
  return `imports ${specifier}, which is not the SDK`;
}

const CLASS_TOKEN = /^-?[_a-zA-Z][\w-]*$/;

/** Keeps the class names that identify a view: not a generic state (`is-…`, `has-…`), not a template's stub. */
function viewClasses(text, into) {
  for (const token of text.split(/\s+/)) {
    if (!CLASS_TOKEN.test(token) || token.length < 3 || token.endsWith('-')) continue;
    if (/^(?:is|has)-/.test(token)) continue;
    into.add(token);
  }
}

function stringParts(node, parts) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) parts.push(node.text);
  else if (ts.isTemplateExpression(node)) {
    parts.push(node.head.text);
    for (const span of node.templateSpans) {
      stringParts(span.expression, parts);
      parts.push(span.literal.text);
    }
    return;
  }
  ts.forEachChild(node, (child) => stringParts(child, parts));
}

function insideType(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isTypeNode(current) && !ts.isExpressionWithTypeArguments(current)) return true;
    if (ts.isExpressionStatement(current) || ts.isBlock(current) || ts.isSourceFile(current)) return false;
  }
  return false;
}

/** An identifier used as a value, rather than declared, named as a member, or written in a type. */
function valueReference(node) {
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (ts.isQualifiedName(parent)) return false;
  if (
    (ts.isPropertyAssignment(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent) ||
      ts.isEnumMember(parent) ||
      ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isBindingElement(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isInterfaceDeclaration(parent) ||
      ts.isTypeAliasDeclaration(parent) ||
      ts.isJsxAttribute(parent)) &&
    parent.name === node
  ) {
    return false;
  }
  if (ts.isBindingElement(parent) && parent.propertyName === node) return false;
  if (
    ts.isImportSpecifier(parent) ||
    ts.isImportClause(parent) ||
    ts.isNamespaceImport(parent) ||
    ts.isExportSpecifier(parent)
  ) {
    return false;
  }
  if (ts.isLabeledStatement(parent) || ts.isBreakOrContinueStatement(parent)) return false;
  return !insideType(node);
}

/** Every name a file declares itself, anywhere in it: a global it shadows is not the global. */
function declaredNames(source) {
  const names = new Set();
  const add = (name) => {
    if (ts.isIdentifier(name)) names.add(name.text);
    else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
      for (const element of name.elements) if (!ts.isOmittedExpression(element)) add(element.name);
    }
  };
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) add(node.name);
    else if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) add(node.name);
    else if (ts.isImportClause(node) && node.name) add(node.name);
    else if (ts.isImportSpecifier(node) || ts.isNamespaceImport(node)) add(node.name);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

function scriptKind(file) {
  const extension = extname(file);
  if (extension === '.tsx') return ts.ScriptKind.TSX;
  if (extension === '.jsx') return ts.ScriptKind.JSX;
  if (extension === '.js' || extension === '.mjs' || extension === '.cjs') return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/** Reads one source file of a view: its breaches of W1–W3, and the classes it draws (for W5). */
export function readViewSource(file, viewDirectory, { test = TEST_FILE.test(file), runtime = [] } = {}) {
  const text = readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file));
  const breaches = [];
  const classes = new Set();
  const declared = declaredNames(source);
  const isGlobal = (name) => !declared.has(name);
  const lineOf = (node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const breach = (rule, node, message) => breaches.push({ rule, file, line: lineOf(node), message });
  const checkImport = (node, specifier) => {
    const why = importBreach(specifier, file, viewDirectory, test, runtime);
    if (why) breach('MV-W1', node, why);
  };

  const visit = (node) => {
    // MV-W1: every way a module names another.
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      if (ts.isStringLiteral(node.moduleSpecifier)) checkImport(node, node.moduleSpecifier.text);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const expression = node.moduleReference.expression;
      if (ts.isStringLiteral(expression)) checkImport(node, expression.text);
    } else if (ts.isImportTypeNode(node)) {
      const argument = node.argument;
      if (ts.isLiteralTypeNode(argument) && ts.isStringLiteral(argument.literal))
        checkImport(node, argument.literal.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      if (!test) breach('MV-W3', node, 'loads code with a dynamic import()');
    } else if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'URL' &&
      node.arguments?.length === 2 &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      node.arguments[1].getText(source) === 'import.meta.url'
    ) {
      // A file the view refers to by URL (its worker, an asset) must be its own too.
      const url = node.arguments[0].text;
      if (url.startsWith('.') && !inside(viewDirectory, resolve(dirname(file), url))) {
        breach('MV-W1', node, `refers to ${url}, outside the view's folder`);
      }
    }

    // A test is not the view at run time: it may make a root, stub a global or load a module
    // fresh. Only W1 (with the test's own imports) reads it.
    if (test) {
      ts.forEachChild(node, visit);
      return;
    }

    // MV-W2 and MV-W3 through a global object: `window.x`, `document.x`, `globalThis.x`, `self.x`.
    // A listener's removal is the cleanup of one already counted where it was added.
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && isGlobal(node.expression.text)) {
      const object = node.expression.text;
      const name = node.name.text;
      if (name === 'removeEventListener') {
        // counted at the add
      } else if (object === 'document') {
        breach('MV-W2', node, `reads the host's document (document.${name})`);
      } else if (GLOBAL_OBJECTS.has(object)) {
        if (REACH_GLOBALS.has(name)) breach('MV-W3', node, `reaches out through ${object}.${name}`);
        else if (name === 'addEventListener') breach('MV-W2', node, `listens globally (${object}.addEventListener)`);
        else if (!WINDOW_ALLOWED.has(name)) breach('MV-W2', node, `reaches ${object}.${name}, beyond the allow-list`);
      } else if (object === 'navigator' && name === 'sendBeacon') {
        breach('MV-W3', node, 'reaches out through navigator.sendBeacon');
      }
    } else if (
      ts.isElementAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      isGlobal(node.expression.text) &&
      (GLOBAL_OBJECTS.has(node.expression.text) || node.expression.text === 'document')
    ) {
      breach('MV-W2', node, `reaches ${node.expression.text}[…]`);
    }

    // MV-W2: climbing out of the root.
    if (ts.isPropertyAccessExpression(node)) {
      const name = node.name.text;
      if (name === 'closest' && ts.isCallExpression(node.parent) && node.parent.expression === node) {
        breach('MV-W2', node, 'climbs the tree with closest()');
      } else if (name === 'getRootNode' && ts.isCallExpression(node.parent) && node.parent.expression === node) {
        breach('MV-W2', node, 'reaches the root node with getRootNode()');
      } else if (name === 'ownerDocument') {
        const parent = node.parent;
        const creates =
          ts.isPropertyAccessExpression(parent) && parent.expression === node && DOCUMENT_CREATE.has(parent.name.text);
        if (!creates) {
          const member =
            ts.isPropertyAccessExpression(parent) && parent.expression === node ? `.${parent.name.text}` : '';
          breach('MV-W2', node, `reaches the root's document (ownerDocument${member}) beyond making nodes`);
        }
      }
    }

    // Bare globals: a global listener, a global object handed around, network and storage.
    if (ts.isIdentifier(node) && isGlobal(node.text) && valueReference(node)) {
      const name = node.text;
      const parent = node.parent;
      const calledBare = ts.isCallExpression(parent) && parent.expression === node;
      const asObject =
        (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === node;
      if (REACH_GLOBALS.has(name)) {
        breach('MV-W3', node, `reaches out through ${name}`);
      } else if (calledBare && name === 'addEventListener') {
        breach('MV-W2', node, `listens globally (${name})`);
      } else if ((name === 'window' || name === 'document') && !asObject && !ts.isTypeOfExpression(parent)) {
        breach('MV-W2', node, `hands the host's ${name} around`);
      }
    }

    // MV-W5's vocabulary: the classes this view draws.
    if (
      ts.isJsxAttribute(node) &&
      (node.name.getText(source) === 'className' || node.name.getText(source) === 'class')
    ) {
      const parts = [];
      if (node.initializer) stringParts(node.initializer, parts);
      for (const part of parts) viewClasses(part, classes);
    } else if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isPropertyAccessExpression(node.expression.expression) &&
      node.expression.expression.name.text === 'classList'
    ) {
      for (const argument of node.arguments) {
        const parts = [];
        stringParts(argument, parts);
        for (const part of parts) viewClasses(part, classes);
      }
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      node.left.name.text === 'className'
    ) {
      const parts = [];
      stringParts(node.right, parts);
      for (const part of parts) viewClasses(part, classes);
    } else if (ts.isStringLiteralLike(node) && node.text.includes('class=')) {
      for (const match of node.text.matchAll(/\bclass="([^"]*)"/g)) viewClasses(match[1], classes);
    }

    ts.forEachChild(node, visit);
  };
  visit(source);
  return { breaches, classes };
}

function stripCssComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '));
}

/** Each rule prelude in a stylesheet (`selector {`), with its line. */
export function cssPreludes(css) {
  const text = stripCssComments(css);
  const preludes = [];
  for (const match of text.matchAll(/([^{};]+)\{/g)) {
    const selector = match[1].trim();
    if (selector === '' || selector.startsWith('@')) continue;
    const line = text.slice(0, match.index + match[1].length).split('\n').length;
    preludes.push({ selector: selector.replace(/\s+/g, ' '), line });
  }
  return preludes;
}

function cssClasses(selector) {
  return [...selector.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((match) => match[1]);
}

/** The names `MONITOR_SKIN` lists in the SDK's skin.ts under `root`, read from its source; none when it is absent. */
export function readMonitorSkin(root = scriptRoot) {
  const file = resolve(root, SKIN_SOURCE);
  if (!existsSync(file)) return [];
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const names = [];
  const collect = (node) => {
    if (ts.isStringLiteralLike(node)) names.push(node.text);
    ts.forEachChild(node, collect);
  };
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'MONITOR_SKIN') {
      if (node.initializer) collect(node.initializer);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

/** A selector list split at its top-level commas (a comma inside `:is(…)` or `[…]` is not a separator). */
function splitSelectors(list) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < list.length; index += 1) {
    const character = list[index];
    if (character === '(' || character === '[') depth += 1;
    else if (character === ')' || character === ']') depth -= 1;
    else if (character === ',' && depth === 0) {
      parts.push(list.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(list.slice(start).trim());
  return parts.filter((part) => part !== '');
}

const KEYFRAME_SELECTOR = /^(?:from|to|\d+(?:\.\d+)?%)(?:\s*,\s*(?:from|to|\d+(?:\.\d+)?%))*$/;

/**
 * L18 in a view's own stylesheet (MV-W2: no global selectors, no host reads):
 * every rule sits under the view's root class `.mv-<view>`, and every custom
 * property it reads is the skin's or its own `--mv-<view>-*`.
 */
export function viewStylesheetBreaches(css, file, viewName, skin) {
  const text = stripCssComments(css);
  const root = `.mv-${viewName}`;
  const own = `--mv-${viewName}-`;
  const skinNames = new Set(skin);
  const breaches = [];
  for (const { selector, line } of cssPreludes(text)) {
    if (KEYFRAME_SELECTOR.test(selector)) continue;
    for (const part of splitSelectors(selector)) {
      const scoped = part.startsWith(root) && !/[\w-]/.test(part.charAt(root.length));
      if (!scoped) {
        breaches.push({ rule: 'MV-W2', file, line, message: `styles outside its root class ${root} (${part})` });
      }
    }
  }
  for (const match of text.matchAll(/var\(\s*(--[\w-]+)/g)) {
    const name = match[1];
    if (skinNames.has(name) || name.startsWith(own)) continue;
    const line = text.slice(0, match.index).split('\n').length;
    breaches.push({
      rule: 'MV-W2',
      file,
      line,
      message: `reads ${name}, neither the skin (MONITOR_SKIN) nor its own ${own}*`,
    });
  }
  return breaches;
}

/**
 * Reads one of a view's own stylesheets for references outside its folder and
 * for L18. Its selectors are not the view's vocabulary: W5 takes only the
 * classes the view's code draws, and its root class.
 */
function readViewStylesheet(file, viewDirectory, viewName, skin) {
  const raw = readFileSync(file, 'utf8');
  const text = stripCssComments(raw);
  const breaches = viewStylesheetBreaches(raw, file, viewName, skin);
  const references = [
    ...text.matchAll(/@import\s+(?:url\()?\s*['"]?([^'")\s;]+)/g),
    ...text.matchAll(/url\(\s*['"]?([^'")\s]+)/g),
  ];
  for (const match of references) {
    const target = match[1];
    if (!target.startsWith('.')) continue;
    if (!inside(viewDirectory, resolve(dirname(file), target))) {
      const line = text.slice(0, match.index).split('\n').length;
      breaches.push({ rule: 'MV-W1', file, line, message: `refers to ${target}, outside the view's folder` });
    }
  }
  return breaches;
}

function stylesheetsUnder(root, paths) {
  const files = [];
  for (const path of paths) {
    const absolute = resolve(root, path);
    if (!existsSync(absolute)) continue;
    if (statSync(absolute).isDirectory()) files.push(...walk(absolute).filter((file) => file.endsWith('.css')));
    else if (absolute.endsWith('.css')) files.push(absolute);
  }
  return [...new Set(files)].sort();
}

/**
 * Reads every view folder under `views` and the host stylesheets under
 * `hostStylesheets` (files or directories, relative to `root`). Labs — a
 * `lab/` directory inside a view — build their own page, so the wall does not
 * read them unless `includeLabs`.
 */
export function checkViewWall({
  root = scriptRoot,
  views = 'packages/views/src/views',
  // M14: views.css is loaded globally by every host, so a monitor-view selector there is the host's side naming a view.
  hostStylesheets = ['apps/godview/src/renderer', 'packages/views/src/styles'],
  includeLabs = false,
  // L18: the skin a view's CSS may read, from the root's own SDK (a fixture without one reads this repository's).
  skin = readMonitorSkin(existsSync(resolve(root, SKIN_SOURCE)) ? root : scriptRoot),
} = {}) {
  const viewsRoot = resolve(root, views);
  const folders = existsSync(viewsRoot)
    ? readdirSync(viewsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
    : [];
  const report = { root, views: [], hostStylesheets: [] };
  for (const name of folders) {
    const directory = join(viewsRoot, name);
    const files = walk(directory).filter(
      (file) => includeLabs || !relative(directory, file).split(sep).includes('lab'),
    );
    // Its root class is its vocabulary too: a host stylesheet naming `.mv-<view>` names the view (W5).
    const view = { name, directory, files: 0, breaches: [], classes: new Set([`mv-${name}`]) };
    for (const file of files) {
      if (SOURCE.test(file) && !file.endsWith('.d.ts')) {
        view.files += 1;
        const read = readViewSource(file, directory, { runtime: VIEW_RUNTIME_IMPORTS[name] ?? [] });
        view.breaches.push(...read.breaches);
        if (!TEST_FILE.test(file)) for (const name of read.classes) view.classes.add(name);
      } else if (file.endsWith('.css')) {
        view.files += 1;
        view.breaches.push(...readViewStylesheet(file, directory, name, skin));
      }
    }
    report.views.push(view);
  }

  // MV-W5: a host stylesheet naming a class a view draws. A view's own stylesheet never counts.
  const stylesheets = stylesheetsUnder(root, hostStylesheets).filter(
    (file) => !report.views.some((view) => inside(view.directory, file)),
  );
  report.hostStylesheets = stylesheets;
  for (const file of stylesheets) {
    const preludes = cssPreludes(readFileSync(file, 'utf8'));
    for (const view of report.views) {
      for (const { selector, line } of preludes) {
        const named = cssClasses(selector).filter((name) => view.classes.has(name));
        if (named.length > 0) {
          view.breaches.push({
            rule: 'MV-W5',
            file,
            line,
            message: `the host styles .${[...new Set(named)].join(', .')} (${selector})`,
          });
        }
      }
    }
  }
  return report;
}

export const RULES = ['MV-W1', 'MV-W2', 'MV-W3', 'MV-W5'];

export function summarizeViewWall(report, failing = []) {
  const views = {};
  const total = { files: 0, total: 0 };
  for (const rule of RULES) total[rule] = 0;
  for (const view of report.views) {
    const counts = { files: view.files };
    for (const rule of RULES) counts[rule] = view.breaches.filter((breach) => breach.rule === rule).length;
    counts.total = view.breaches.length;
    views[view.name] = counts;
    total.files += view.files;
    total.total += view.breaches.length;
    for (const rule of RULES) total[rule] += counts[rule];
  }
  return { mode: failing.length > 0 ? 'fail' : 'report', views, total, failing };
}

export function formatViewWall(report, { verbose = false, failing = [] } = {}) {
  const summary = summarizeViewWall(report, failing);
  const lines = [];
  const where = (file) => relative(report.root, file);
  lines.push(
    `view wall (${summary.mode === 'fail' ? `failing ${failing.join(', ')}` : 'report mode, MV-D9'}): ${report.views.length} views under ${where(
      report.views[0] ? dirname(report.views[0].directory) : report.root,
    )}; host CSS: ${report.hostStylesheets.map(where).join(', ') || 'none'}`,
  );
  const header = ['view', 'files', 'W1 imports', 'W2 own root', 'W3 no reach', 'W5 host CSS', 'total'];
  const rows = Object.entries(summary.views).map(([name, counts]) => [
    name,
    counts.files,
    counts['MV-W1'],
    counts['MV-W2'],
    counts['MV-W3'],
    counts['MV-W5'],
    counts.total,
  ]);
  rows.push([
    'total',
    summary.total.files,
    summary.total['MV-W1'],
    summary.total['MV-W2'],
    summary.total['MV-W3'],
    summary.total['MV-W5'],
    summary.total.total,
  ]);
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => String(row[column]).length)),
  );
  const format = (row) =>
    row
      .map((cell, column) => (column === 0 ? String(cell).padEnd(widths[0]) : String(cell).padStart(widths[column])))
      .join('  ');
  lines.push(format(header), ...rows.map(format));

  const shown = verbose ? Number.POSITIVE_INFINITY : 3;
  for (const view of report.views) {
    if (view.breaches.length === 0) continue;
    lines.push('', `${view.name}:`);
    for (const rule of RULES) {
      const breaches = view.breaches.filter((breach) => breach.rule === rule);
      for (const breach of breaches.slice(0, shown)) {
        lines.push(`  ${rule} ${where(breach.file)}:${breach.line}  ${breach.message}`);
      }
      if (breaches.length > shown) lines.push(`  ${rule} … and ${breaches.length - shown} more (--verbose)`);
    }
  }
  lines.push('', `view-wall summary: ${JSON.stringify(summary)}`);
  return lines.join('\n');
}

function parseArguments(argv) {
  const options = { hostStylesheets: [], fail: [], verbose: false, includeLabs: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--views') options.views = argv[++index];
    else if (argument === '--host-css') options.hostStylesheets.push(argv[++index]);
    else if (argument === '--verbose') options.verbose = true;
    else if (argument === '--include-labs') options.includeLabs = true;
    else if (argument === '--root') options.root = argv[++index];
    else if (argument === '--fail') {
      while (index + 1 < argv.length && !argv[index + 1].startsWith('--')) options.fail.push(argv[++index]);
    } else if (argument !== '--') throw new Error(`unknown argument ${argument}`);
  }
  return options;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(`view wall: ${error.message}`);
    process.exit(1);
  }
  const report = checkViewWall({
    ...(options.root ? { root: resolve(options.root) } : {}),
    ...(options.views ? { views: options.views } : {}),
    ...(options.hostStylesheets.length > 0 ? { hostStylesheets: options.hostStylesheets } : {}),
    includeLabs: options.includeLabs,
  });
  console.log(formatViewWall(report, { verbose: options.verbose, failing: options.fail }));
  const known = new Set(report.views.map((view) => view.name));
  const unknown = options.fail.filter((name) => !known.has(name));
  if (unknown.length > 0) {
    console.error(`view wall: no view named ${unknown.join(', ')}`);
    process.exit(1);
  }
  const breached = report.views.filter((view) => options.fail.includes(view.name) && view.breaches.length > 0);
  if (breached.length > 0) {
    console.error(`view wall: FAIL ${breached.map((view) => `${view.name} (${view.breaches.length})`).join(', ')}`);
    process.exit(1);
  }
}

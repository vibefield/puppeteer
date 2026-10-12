#!/usr/bin/env node

// THE VIEW WALL (design-mv §3): a monitor view is a plugged-in module that
// touches nothing outside the root it is given. This checker reads every
// REGISTERED view, the entries of the registry the hosts mount (`MONITOR_VIEWS`,
// which puppeteer's Godview and VibeField both mount), each in the folder its
// module lives in, and reports what crosses the wall:
//
//   MV-W1 imports    only the SDK subpaths a view may import (L16), React, and
//                    files inside the view's own folder (worker and CSS
//                    references included), never its lab or its fixtures
//   MV-W2 own root   no `document.*`, no `window.*`/`globalThis.*`/`self.*`
//                    beyond the allow-list, none of those handed around (an
//                    alias reaches anything), no bare `location`/`navigator`,
//                    no `closest()`, no climbing above the root
//                    (`parentElement`, `parentNode`, `offsetParent`), no
//                    reaching the root's document or root node, no global
//                    listeners (so no global keys); and in its CSS (L18) no rule
//                    outside its root class `.mv-<view>`, none that leaves it
//                    for its siblings (`~`, `+`), and no custom property read
//                    but the skin's (`MONITOR_SKIN`) and its own `--mv-<view>-*`
//   MV-W3 no reach   no network or storage (`caches` and `open` among them), no
//                    dynamic `import()` or `importScripts()`, no absolute
//                    `url()` in its CSS; a worker the view bundles is allowed
//   MV-W5 host CSS   no host stylesheet names a class a view draws
//
// What a view may do beyond that is named per view in `VIEW_RUNTIME_IMPORTS`,
// the one allow-list (M59.2), never special-cased in a rule.
//
// MV-W4 (conformance) is a test suite in `@vibefield/puppeteer-view-sdk/testing`,
// not a reading of source. The checker FAILS: it exits 1 when any registered
// view breaches, when a folder under the views directory is no registered
// view's, or when the registry cannot be read, so a new view enters failing and
// no list of views is kept beside the registry (MV-8, MV-8b; MV-D9 reported
// first, then closed each view as it moved onto the SDK). `--report` is the
// opt-in that prints the same table and exits 0 whatever it finds. Sources are
// parsed with TypeScript, so comments, strings and JSX text never count.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** L16: what a view may import from the SDK. */
export const VIEW_SDK_IMPORTS = [
  '@vibefield/puppeteer-view-sdk',
  '@vibefield/puppeteer-view-sdk/react',
  '@vibefield/puppeteer-view-sdk/toolkit',
];
/** L16: what a view's tests may import besides. */
export const VIEW_TEST_IMPORTS = ['@vibefield/puppeteer-view-sdk/testing', 'vitest'];
/**
 * THE ONE ALLOW-LIST (M59.2): what a view may reach beyond the wall, named per view, each entry a lead decision.
 * - A module specifier: a dependency the view bundles into itself (MV-5, the swarm's physics engine), a pure library
 *   the views package declares, which the view carries into its own worker and reaches nothing with.
 * - A host global's member, `<global>.<member>`: the one member of a bare host global the view may read (MV-8b, the
 *   swarm draws with WebGPU, which it reaches through `navigator.gpu`).
 * W3 still bans network and storage in the view's own code; the list is finite and named so an isolated realm later
 * knows what to carry.
 */
export const VIEW_RUNTIME_IMPORTS = Object.freeze({ swarm: Object.freeze(['matter-js', 'navigator.gpu']) });
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
/** MV-W3: network and storage, a window opened, and code loaded by URL. */
export const REACH_GLOBALS = new Set([
  'fetch',
  'WebSocket',
  'XMLHttpRequest',
  'EventSource',
  'BroadcastChannel',
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'caches',
  'open',
  'importScripts',
]);
/** MV-W2: host globals a view reaches bare, without `window.`: the host's address and its browser. */
export const HOST_GLOBALS = new Set(['location', 'navigator']);
const GLOBAL_OBJECTS = new Set(['window', 'globalThis', 'self']);
/** MV-W2: what a view may not hand around, since a value of one reaches everything it holds. */
const HOST_OBJECTS = new Set([...GLOBAL_OBJECTS, 'document']);
/** MV-W2: climbing above the view's root. */
const CLIMBS = new Set(['parentElement', 'parentNode', 'offsetParent']);
/** What a view may do with its root's document: make detached nodes, nothing else. */
const DOCUMENT_CREATE = new Set(['createElement', 'createElementNS', 'createTextNode', 'createDocumentFragment']);

/** L18: where the SDK lists the skin, the only host custom properties a view's stylesheet may read. */
export const SKIN_SOURCE = 'packages/view-sdk/src/skin.ts';

/** The registry the hosts mount, and the list in it: the views the wall reads (MV-8b, registration, not folders). */
export const VIEW_REGISTRY = 'packages/views/src/monitor/registry.ts';
export const VIEW_REGISTRY_LIST = 'MONITOR_VIEWS';

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

/** A view's lab (its own page) or its fixtures: what shipping code never imports. */
function labOrFixture(viewDirectory, path) {
  return relative(viewDirectory, path).split(sep).includes('lab') || /fixture/i.test(basename(path));
}

/** Why `specifier` crosses the wall from a view's file, or undefined when it does not. */
export function importBreach(specifier, file, viewDirectory, test, runtime = []) {
  if (runtime.includes(specifier)) return undefined;
  if (specifier.startsWith('.') || specifier.startsWith('/')) {
    const target = resolve(dirname(file), specifier);
    if (!inside(viewDirectory, target)) return `imports ${specifier}, outside the view's folder`;
    // Labs are not read unless asked (they build their own page), so a lab imported by shipping code would carry
    // whatever it reaches into the view unread.
    if (!test && labOrFixture(viewDirectory, target) && !labOrFixture(viewDirectory, file)) {
      return `imports ${specifier}, a lab or fixtures (shipping code never imports them)`;
    }
    return undefined;
  }
  if (VIEW_SDK_IMPORTS.includes(specifier) || FRAMEWORK_IMPORT.test(specifier)) return undefined;
  if (test && VIEW_TEST_IMPORTS.includes(specifier)) return undefined;
  if (specifier === '@vibefield/puppeteer-view-sdk/host') return `imports ${specifier}, which only hosts may (L16)`;
  if (specifier === '@vibefield/puppeteer-view-sdk/testing') return `imports ${specifier} outside a test (L16)`;
  if (specifier.startsWith('@vibefield/puppeteer-view-sdk/')) return `imports ${specifier}, not a view's subpath (L16)`;
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

/** Parentheses and type assertions: `(window as Host).x` is `window.x`. */
function wraps(node) {
  return (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isSatisfiesExpression(node)
  );
}

function unwrap(expression) {
  let current = expression;
  while (wraps(current)) current = current.expression;
  return current;
}

/** The outermost of the wrappers around `node`, which is what its parent sees. */
function outermost(node) {
  let current = node;
  while (current.parent && wraps(current.parent) && current.parent.expression === current) current = current.parent;
  return current;
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
  /** The global object an expression is, through wrappers (`window`, `(globalThis as T)`), else undefined. */
  const globalObjectOf = (expression) => {
    const bare = unwrap(expression);
    return ts.isIdentifier(bare) && isGlobal(bare.text) ? bare.text : undefined;
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
      // A file the view refers to by URL (its worker, an asset) must be its own too, and never its lab.
      const url = node.arguments[0].text;
      if (url.startsWith('.') && !inside(viewDirectory, resolve(dirname(file), url))) {
        breach('MV-W1', node, `refers to ${url}, outside the view's folder`);
      } else if (url.startsWith('.') && !test && labOrFixture(viewDirectory, resolve(dirname(file), url))) {
        if (!labOrFixture(viewDirectory, file)) breach('MV-W1', node, `refers to ${url}, a lab or fixtures`);
      }
    }

    // A test is not the view at run time: it may make a root, stub a global or load a module
    // fresh. Only W1 (with the test's own imports) reads it.
    if (test) {
      ts.forEachChild(node, visit);
      return;
    }

    // MV-W2 and MV-W3 through a global object: `window.x`, `document.x`, `globalThis.x`, `self.x`, wrapped or not.
    // A listener's removal is the cleanup of one already counted where it was added.
    const object =
      ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)
        ? globalObjectOf(node.expression)
        : undefined;
    if (object !== undefined && ts.isPropertyAccessExpression(node)) {
      const name = node.name.text;
      if (name === 'removeEventListener') {
        // counted at the add
      } else if (object === 'document') {
        breach('MV-W2', node, `reads the host's document (document.${name})`);
      } else if (GLOBAL_OBJECTS.has(object)) {
        if (REACH_GLOBALS.has(name)) breach('MV-W3', node, `reaches out through ${object}.${name}`);
        else if (name === 'addEventListener') breach('MV-W2', node, `listens globally (${object}.addEventListener)`);
        else if (!WINDOW_ALLOWED.has(name)) breach('MV-W2', node, `reaches ${object}.${name}, beyond the allow-list`);
      }
    } else if (object !== undefined && HOST_OBJECTS.has(object)) {
      breach('MV-W2', node, `reaches ${object}[…]`);
    }

    // MV-W2: climbing out of the root.
    if (ts.isPropertyAccessExpression(node)) {
      const name = node.name.text;
      if (name === 'closest' && ts.isCallExpression(node.parent) && node.parent.expression === node) {
        breach('MV-W2', node, 'climbs the tree with closest()');
      } else if (name === 'getRootNode' && ts.isCallExpression(node.parent) && node.parent.expression === node) {
        breach('MV-W2', node, 'reaches the root node with getRootNode()');
      } else if (CLIMBS.has(name)) {
        breach('MV-W2', node, `climbs above its root (${name})`);
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

    if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      CLIMBS.has(node.argumentExpression.text)
    ) {
      breach('MV-W2', node, `climbs above its root (${node.argumentExpression.text})`);
    }

    // Bare globals: a global listener, a global object handed around (an alias reaches anything), the host's
    // address and browser, network and storage. Wrappers are seen through: `(globalThis as T).x` is a member.
    if (ts.isIdentifier(node) && isGlobal(node.text) && valueReference(node)) {
      const name = node.text;
      const top = outermost(node);
      const parent = top.parent;
      const calledBare = ts.isCallExpression(parent) && parent.expression === top;
      const asObject =
        (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === top;
      const member = asObject && ts.isPropertyAccessExpression(parent) ? parent.name.text : undefined;
      const typeOf = ts.isTypeOfExpression(parent);
      if (name === 'importScripts') {
        breach('MV-W3', node, 'loads code with importScripts()');
      } else if (REACH_GLOBALS.has(name)) {
        breach('MV-W3', node, `reaches out through ${name}`);
      } else if (calledBare && name === 'addEventListener') {
        breach('MV-W2', node, `listens globally (${name})`);
      } else if (HOST_OBJECTS.has(name) && !asObject && !typeOf) {
        breach('MV-W2', node, `hands the host's ${name} around`);
      } else if (HOST_GLOBALS.has(name) && !typeOf) {
        const reached = member === undefined ? name : `${name}.${member}`;
        if (member !== undefined && runtime.includes(reached)) {
          // named in VIEW_RUNTIME_IMPORTS
        } else if (reached === 'navigator.sendBeacon') {
          breach('MV-W3', node, 'reaches out through navigator.sendBeacon');
        } else {
          breach('MV-W2', node, `reaches ${reached}, beyond the allow-list`);
        }
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
 * Whether a selector that starts with the root's compound goes on to the root's siblings: `.mv-x ~ a`, `.mv-x + a`.
 * A descendant or child of the root stays inside; a sibling of one of those is still inside the root.
 */
function leavesRoot(part, from) {
  let depth = 0;
  let index = from;
  for (; index < part.length; index += 1) {
    const character = part[index];
    if (character === '(' || character === '[') depth += 1;
    else if (character === ')' || character === ']') depth -= 1;
    else if (depth === 0 && /[\s>~+]/.test(character)) break;
  }
  while (index < part.length && /\s/.test(part[index])) index += 1;
  return part[index] === '~' || part[index] === '+';
}

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
      } else if (leavesRoot(part, root.length)) {
        breaches.push({
          rule: 'MV-W2',
          file,
          line,
          message: `leaves its root class ${root} for its siblings (${part})`,
        });
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
  // `@import url(x)` matches both patterns: one reference, counted once, at its own place.
  const seen = new Set();
  for (const match of references) {
    const target = match[1];
    const at = match.index + match[0].lastIndexOf(target);
    if (seen.has(at)) continue;
    seen.add(at);
    const line = text.slice(0, at).split('\n').length;
    // An absolute url, a scheme (`https:`, `data:` alike) or a root-absolute path, fetches from beyond the view.
    if (/^[a-z][a-z\d+.-]*:/i.test(target) || target.startsWith('/')) {
      breaches.push({ rule: 'MV-W3', file, line, message: `reaches out through ${target}, an absolute url` });
      continue;
    }
    if (!target.startsWith('.')) continue;
    if (!inside(viewDirectory, resolve(dirname(file), target))) {
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

const MODULE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs'];

/** The file a relative module specifier names from `fromFile`, as TypeScript resolves it (`./x.js` is `./x.ts`). */
function resolveModule(fromFile, specifier) {
  if (!specifier.startsWith('.')) return undefined;
  const base = resolve(dirname(fromFile), specifier);
  const extension = extname(base);
  const stem = ['.js', '.jsx', '.mjs'].includes(extension) ? base.slice(0, -extension.length) : undefined;
  const candidates = [
    base,
    ...(stem ? [`${stem}.ts`, `${stem}.tsx`, `${stem}.mts`] : []),
    ...MODULE_EXTENSIONS.map((ext) => `${base}${ext}`),
    ...MODULE_EXTENSIONS.map((ext) => join(base, `index${ext}`)),
  ];
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
}

function parseModule(file) {
  return ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, scriptKind(file));
}

/** The initializer of the module-level variable `name`. */
function initializerOf(source, name) {
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name) return declaration.initializer;
    }
  }
  return undefined;
}

/** A module's named imports, by local name: the specifier and the name the other module exports. */
function namedImports(source) {
  const imports = new Map();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      imports.set(element.name.text, {
        specifier: statement.moduleSpecifier.text,
        exported: (element.propertyName ?? element.name).text,
      });
    }
  }
  return imports;
}

/** An object literal's property `key`: its value, or the identifier a shorthand names. */
function propertyOf(literal, key) {
  for (const property of literal.properties) {
    if (ts.isShorthandPropertyAssignment(property) && property.name.text === key) return property.name;
    if (
      ts.isPropertyAssignment(property) &&
      (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
      property.name.text === key
    ) {
      return property.initializer;
    }
  }
  return undefined;
}

/** What an expression is, followed through local variables and named imports to its literal (three hops at most). */
function follow(expression, source, file, hops = 3) {
  const bare = unwrap(expression);
  if (!ts.isIdentifier(bare) || hops === 0) return { node: bare, source, file };
  const local = initializerOf(source, bare.text);
  if (local) return follow(local, source, file, hops - 1);
  const imported = namedImports(source).get(bare.text);
  const module = imported && resolveModule(file, imported.specifier);
  if (!module) return { node: bare, source, file };
  const other = parseModule(module);
  const value = initializerOf(other, imported.exported);
  return value ? follow(value, other, module, hops - 1) : { node: bare, source: other, file: module };
}

/**
 * The manifest id of the view `exported` from `module`: `reactMonitorView(MANIFEST, …)`, or `defineMonitorView({
 * manifest, … })`, followed to the manifest's literal and its `id`.
 */
function manifestIdOf(module, exported) {
  const source = parseModule(module);
  const value = initializerOf(source, exported);
  if (!value) return undefined;
  const view = unwrap(value);
  if (!ts.isCallExpression(view) || view.arguments.length === 0) return undefined;
  let manifest = follow(view.arguments[0], source, module);
  if (ts.isObjectLiteralExpression(manifest.node) && !propertyOf(manifest.node, 'id')) {
    const inner = propertyOf(manifest.node, 'manifest');
    if (inner) manifest = follow(inner, manifest.source, manifest.file);
  }
  if (!ts.isObjectLiteralExpression(manifest.node)) return undefined;
  const id = propertyOf(manifest.node, 'id');
  return id && ts.isStringLiteralLike(unwrap(id)) ? unwrap(id).text : undefined;
}

/**
 * The views the registry lists, which are what the hosts mount: each entry of `list` (`monitorViewEntry(view)` or the
 * view itself) followed to the module it is imported from. A view's folder is that module's directory and its name is
 * its manifest's id. Anything the wall cannot follow is a problem, never a view silently left out.
 */
export function readRegisteredViews(registryFile, { list = VIEW_REGISTRY_LIST, root = scriptRoot } = {}) {
  const where = (path) => relative(root, path);
  const views = [];
  const problems = [];
  if (!existsSync(registryFile)) {
    return { views, problems: [`${where(registryFile)}: no registry to read the views from`] };
  }
  const source = parseModule(registryFile);
  const listed = initializerOf(source, list);
  const array = listed && unwrap(listed);
  if (!array || !ts.isArrayLiteralExpression(array)) {
    return { views, problems: [`${where(registryFile)}: ${list} is not an array the wall can read`] };
  }
  const imports = namedImports(source);
  for (const element of array.elements) {
    const entry = unwrap(element);
    const named = ts.isCallExpression(entry) && entry.arguments.length > 0 ? unwrap(entry.arguments[0]) : entry;
    if (!ts.isIdentifier(named)) {
      problems.push(`${where(registryFile)}: an entry of ${list} the wall cannot follow (${element.getText(source)})`);
      continue;
    }
    const imported = imports.get(named.text);
    const module = imported && resolveModule(registryFile, imported.specifier);
    if (!module) {
      problems.push(`${named.text}: not imported from a view module the wall can find (${where(registryFile)})`);
      continue;
    }
    const id = manifestIdOf(module, imported.exported);
    if (id === undefined) problems.push(`${named.text}: the wall cannot read its manifest's id (${where(module)})`);
    views.push({ binding: named.text, module, directory: dirname(module), name: id ?? basename(dirname(module)) });
  }
  return { views, problems };
}

/**
 * Reads the given view folders (`views`: `{ name, directory }`, a directory absolute or relative to `root`) and the
 * host stylesheets under `hostStylesheets` (files or directories, relative to `root`). Labs — a `lab/` directory
 * inside a view — build their own page, so the wall does not read them unless `includeLabs`.
 */
export function checkViews({
  root = scriptRoot,
  views = [],
  // M14: views.css is loaded globally by every host, so a monitor-view selector there is the host's side naming a view.
  hostStylesheets = ['apps/godview/src/renderer', 'packages/views/src/styles'],
  includeLabs = false,
  // L18: the skin a view's CSS may read, from the root's own SDK (a fixture without one reads this repository's).
  skin = readMonitorSkin(existsSync(resolve(root, SKIN_SOURCE)) ? root : scriptRoot),
} = {}) {
  const report = { root, views: [], hostStylesheets: [], registration: [] };
  for (const { name, directory: given } of views) {
    const directory = resolve(root, given);
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

/**
 * THE WALL: every registered view (`registry`'s `MONITOR_VIEWS`), each in its own folder, wherever that is. A folder
 * under `views` that no entry registers is a registration problem: it is never counted as a view that holds.
 */
export function checkViewWall({
  root = scriptRoot,
  registry = VIEW_REGISTRY,
  views = 'packages/views/src/views',
  hostStylesheets,
  includeLabs = false,
  skin,
} = {}) {
  const where = (path) => relative(root, path);
  const registryFile = resolve(root, registry);
  const registered = readRegisteredViews(registryFile, { root });
  const registration = [...registered.problems];
  const byDirectory = new Map();
  const byName = new Map();
  for (const view of registered.views) {
    if (byDirectory.has(view.directory)) {
      registration.push(
        `${where(view.directory)}: registered twice (${byDirectory.get(view.directory)}, ${view.binding})`,
      );
      continue;
    }
    if (byName.has(view.name)) {
      registration.push(`${view.name}: the id of two registered views (${byName.get(view.name)}, ${view.binding})`);
    }
    byDirectory.set(view.directory, view.binding);
    byName.set(view.name, view.binding);
  }
  const viewsRoot = resolve(root, views);
  if (existsSync(viewsRoot)) {
    for (const entry of readdirSync(viewsRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const directory = join(viewsRoot, entry.name);
      if (entry.isDirectory() && !byDirectory.has(directory)) {
        registration.push(
          `${where(directory)}: a view folder no host registers (${where(registryFile)} ${VIEW_REGISTRY_LIST})`,
        );
      }
    }
  }
  const checked = registered.views.filter(
    (view, index, all) => all.findIndex((other) => other.directory === view.directory) === index,
  );
  const report = checkViews({
    root,
    views: checked.map(({ name, directory }) => ({ name, directory })),
    ...(hostStylesheets ? { hostStylesheets } : {}),
    includeLabs,
    ...(skin ? { skin } : {}),
  });
  return { ...report, registry: registryFile, registration };
}

export const RULES = ['MV-W1', 'MV-W2', 'MV-W3', 'MV-W5'];

/** `mode` is `fail` (every view fails on a breach: the default) or `report` (exit 0 whatever is found). */
export function summarizeViewWall(report, mode = 'fail') {
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
  const failing =
    mode === 'fail' ? report.views.filter((view) => view.breaches.length > 0).map((view) => view.name) : [];
  return { mode, views, total, failing, registration: [...(report.registration ?? [])] };
}

export function formatViewWall(report, { verbose = false, mode = 'fail' } = {}) {
  const summary = summarizeViewWall(report, mode);
  const lines = [];
  const where = (file) => relative(report.root, file);
  const source = report.registry ? `registered in ${where(report.registry)} ${VIEW_REGISTRY_LIST}` : 'given';
  lines.push(
    `view wall (${summary.mode === 'fail' ? 'every view fails on a breach' : 'report mode (--report)'}): ${report.views.length} views ${source}; host CSS: ${report.hostStylesheets.map(where).join(', ') || 'none'}`,
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
  if (summary.registration.length > 0) {
    lines.push('', 'registration:', ...summary.registration.map((problem) => `  ${problem}`));
  }
  lines.push('', `view-wall summary: ${JSON.stringify(summary)}`);
  return lines.join('\n');
}

function parseArguments(argv) {
  const options = { hostStylesheets: [], mode: 'fail', verbose: false, includeLabs: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--registry') options.registry = argv[++index];
    else if (argument === '--views') options.views = argv[++index];
    else if (argument === '--host-css') options.hostStylesheets.push(argv[++index]);
    else if (argument === '--verbose') options.verbose = true;
    else if (argument === '--include-labs') options.includeLabs = true;
    else if (argument === '--root') options.root = argv[++index];
    else if (argument === '--report') options.mode = 'report';
    else if (argument !== '--') throw new Error(`unknown argument ${argument}`);
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
    ...(options.registry ? { registry: options.registry } : {}),
    ...(options.views ? { views: options.views } : {}),
    ...(options.hostStylesheets.length > 0 ? { hostStylesheets: options.hostStylesheets } : {}),
    includeLabs: options.includeLabs,
  });
  console.log(formatViewWall(report, { verbose: options.verbose, mode: options.mode }));
  const breached = report.views.filter((view) => view.breaches.length > 0);
  const failures = breached.map((view) => `${view.name} (${view.breaches.length})`);
  if (report.registration.length > 0) failures.push(`registration (${report.registration.length})`);
  if (options.mode === 'fail' && failures.length > 0) {
    console.error(`view wall: FAIL ${failures.join(', ')}`);
    process.exit(1);
  }
}

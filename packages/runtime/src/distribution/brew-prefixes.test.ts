import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentHost } from '@vibefield/puppeteer-core';
import { createAgentRuntime } from '../runtime.js';
import type { AgentRuntimeOptions } from '../types.js';

// The inventory is replaced by a recorder of the options the runtime hands it: no folder is listed and no Homebrew
// prefix is probed, whether this row is red or green.
const handed = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock('./inventory.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./inventory.js')>();
  return {
    ...actual,
    createInstallationInventory: (options: Record<string, unknown>) => {
      handed.push(options);
      return actual.createInstallationInventory({
        ...options,
        providers: [],
        searchPath: '',
        brewPrefixes: [],
        home: '/nonexistent-tests/home',
      } as never);
    },
  };
});
// Strict: nothing in a runtime's construction may start a program, so every child_process member throws by name.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const strict: Record<string, unknown> = Object.fromEntries(
    Object.keys(actual).map((name) => [
      name,
      () => {
        throw new Error(`child_process.${name} is not mocked`);
      },
    ]),
  );
  return { ...strict, default: strict };
});

const host = { spawnTerminal: vi.fn(), automateTerminal: vi.fn() } as unknown as AgentHost;
const NOWHERE = '/nonexistent-tests';

async function inventoryOptionsFor(distribution: AgentRuntimeOptions['distribution']) {
  handed.length = 0;
  const runtime = createAgentRuntime({
    host,
    defaultCwd: NOWHERE,
    providers: [],
    ...(distribution === undefined ? {} : { distribution }),
  });
  await runtime.dispose();
  expect(handed.length).toBe(1);
  return handed[0]!;
}

describe('the Homebrew prefixes a host lets the inventory probe', () => {
  afterEach(() => {
    handed.length = 0;
  });

  it('hands an empty list through, so a harness probes no Homebrew prefix', async () => {
    const options = await inventoryOptionsFor({ brewPrefixes: [] } as AgentRuntimeOptions['distribution']);
    expect(options.brewPrefixes).toEqual([]);
  });

  it('hands a named list through as given', async () => {
    const prefixes = [`${NOWHERE}/brew`];
    const options = await inventoryOptionsFor({ brewPrefixes: prefixes } as AgentRuntimeOptions['distribution']);
    expect(options.brewPrefixes).toEqual(prefixes);
  });

  it('names no list when the host names none, so the inventory keeps its own default', async () => {
    const options = await inventoryOptionsFor({ searchPath: `${NOWHERE}/bin` });
    expect('brewPrefixes' in options).toBe(false);
  });
});

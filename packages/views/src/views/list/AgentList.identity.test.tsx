// @vitest-environment happy-dom
import { act } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MonitorViewInstance } from '@vibefield/puppeteer-view-sdk';
import {
  agentViewFixture,
  countingCommands,
  fixtureInput,
  fixtureModel,
  fixtureTheme,
  parameterDefaults,
} from '@vibefield/puppeteer-view-sdk/testing';
import { LIST_MANIFEST, listMonitorView } from './index.js';

// MV-D21 in the list: an unchanged `AgentView` costs no render. Each row draws
// the toolkit's line under its name once per render of that row, so counting
// `detailLine` counts row renders.

const words = vi.hoisted(() => ({ detailLine: vi.fn() }));
vi.mock('@vibefield/puppeteer-view-sdk/toolkit', async (importOriginal) => {
  const original = await importOriginal<typeof import('@vibefield/puppeteer-view-sdk/toolkit')>();
  words.detailLine.mockImplementation(original.detailLine);
  return { ...original, detailLine: words.detailLine };
});

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

const PARAMETERS = parameterDefaults(LIST_MANIFEST);
let instance: MonitorViewInstance | undefined;
afterEach(async () => {
  const mounted = instance;
  instance = undefined;
  if (mounted) await act(async () => mounted.unmount());
  document.body.replaceChildren();
});

describe('the list keeps a row that kept its identity (MV-D21)', () => {
  it('re-renders only the rows a change touched, and none for a change no row reads', async () => {
    const agents = [
      agentViewFixture({ id: 'agent-1', createdAt: 1, status: 'working', project: { name: 'billing-api', seq: 1 } }),
      agentViewFixture({ id: 'agent-2', createdAt: 2, status: 'idle', project: { name: 'vibe-field', seq: 2 } }),
      agentViewFixture({ id: 'agent-3', createdAt: 3, status: 'idle', project: { name: 'rosetta', seq: 3 } }),
    ];
    const root = document.createElement('div');
    document.body.append(root);
    const input = fixtureInput({ agents, parameters: PARAMETERS });
    await act(async () => {
      instance = listMonitorView.mount(root, input, countingCommands().commands);
    });
    expect(words.detailLine).toHaveBeenCalledTimes(3);

    // One row moves: the other two are the same objects, so only the moved row draws again.
    words.detailLine.mockClear();
    const moved = { ...agents[1]!, status: 'blocked' as const, statusSince: 9 };
    const next = { ...input, model: fixtureModel([agents[0]!, moved, agents[2]!], 2) };
    await act(async () => instance!.update(next));
    expect(words.detailLine).toHaveBeenCalledTimes(1);
    expect(words.detailLine).toHaveBeenLastCalledWith(moved);
    expect(root.querySelectorAll('.vf-monitor-list-row.is-blocked')).toHaveLength(1);

    // The theme reaches the list's own properties, never a row's words: no row draws again.
    words.detailLine.mockClear();
    await act(async () => instance!.update({ ...next, theme: fixtureTheme('light') }));
    expect(words.detailLine).not.toHaveBeenCalled();
  });
});

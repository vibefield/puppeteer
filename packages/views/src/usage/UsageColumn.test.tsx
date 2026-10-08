// @vitest-environment happy-dom
import { act, type ComponentProps } from 'react';
import { createRoot } from 'react-dom/client';
import type { AccountUsageBatch } from '@vibecook/puppeteer-core';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MONITOR_STAGE_CLASS } from '../chrome/stage.js';
import type { AccountUsagePort } from './account-usage-port.js';
import { UsageColumn } from './UsageColumn.js';

const draws = vi.hoisted(() => vi.fn());
vi.mock('@vibecook/puppeteer-view-sdk/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@vibecook/puppeteer-view-sdk/react')>();
  return {
    ...actual,
    AgentIcon(props: ComponentProps<typeof actual.AgentIcon>) {
      draws();
      return <actual.AgentIcon {...props} />;
    },
  };
});

const NOW = Date.parse('2026-07-23T20:00:00.000Z');
function reading(usedPercent: number): AccountUsageBatch {
  return {
    refreshedAt: new Date(NOW).toISOString(),
    entries: [
      {
        provider: { id: 'example-agent', label: 'Example Agent', refresh: { pollIntervalMs: 60_000 } },
        result: {
          status: 'available',
          snapshot: {
            provider: 'example-agent',
            fetchedAt: new Date(NOW).toISOString(),
            scope: 'subscription',
            source: { kind: 'native-protocol', stability: 'documented' },
            metrics: [
              {
                id: 'short',
                label: 'SHORT',
                kind: 'window',
                usedPercent,
                resetsAt: new Date(NOW + 60_001).toISOString(),
              },
            ],
          },
        },
      },
    ],
  };
}

function feed(initial: AccountUsageBatch) {
  const listeners = new Set<(batch: AccountUsageBatch) => void>();
  const off = vi.fn();
  const port: AccountUsagePort = {
    snapshot: vi.fn(async () => initial),
    subscribe: vi.fn((listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        off();
      };
    }),
  };
  return { port, listeners, off, emit: (batch: AccountUsageBatch) => listeners.forEach((listener) => listener(batch)) };
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  draws.mockClear();
});
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.useRealTimers();
});

function harness() {
  const container = document.createElement('main');
  document.body.append(container);
  const root = createRoot(container);
  cleanups.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return {
    container,
    render: (port: AccountUsagePort, hostTick = 0) =>
      act(async () => {
        root.render(
          <section className={MONITOR_STAGE_CLASS} data-host-tick={hostTick}>
            <UsageColumn port={port} />
          </section>,
        );
      }),
  };
}

describe('the usage column owns its feed and clock', () => {
  it('skips unrelated host updates, while readings, focus and reset countdowns stay live', async () => {
    const source = feed(reading(35));
    const test = harness();
    await test.render(source.port);
    const tile = test.container.querySelector<HTMLButtonElement>('.vf-usage-tile')!;
    expect(tile.querySelector('b')?.textContent).toBe('35%');
    draws.mockClear();
    await test.render(source.port, 1);
    expect(draws).not.toHaveBeenCalled();
    expect(source.port.subscribe).toHaveBeenCalledTimes(1);

    await act(async () => tile.focus());
    expect(test.container.querySelector('[role="tooltip"]')?.textContent).toContain('↻ 2m');
    await act(async () => source.emit(reading(73)));
    expect(tile.querySelector('b')?.textContent).toBe('73%');
    expect(document.activeElement).toBe(tile);
    expect(test.container.querySelector('[role="tooltip"]')?.textContent).toContain('73%');
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    expect(test.container.querySelector('[role="tooltip"]')?.textContent).toContain('↻ 1m');
    expect(test.container.querySelector('[role="tooltip"]')?.textContent).toContain('1s AGO');
  });

  it('rebinds a replaced port, keeps the focused popup and ignores late answers from the old port', async () => {
    const old = feed(reading(35));
    let answer!: (batch: AccountUsageBatch) => void;
    old.port.snapshot = () =>
      new Promise((resolve) => {
        answer = resolve;
      });
    const test = harness();
    await test.render(old.port);
    await act(async () => old.emit(reading(35)));
    const late = [...old.listeners][0]!;
    const tile = test.container.querySelector<HTMLButtonElement>('.vf-usage-tile')!;
    await act(async () => tile.focus());
    const next = feed(reading(64));
    await test.render(next.port);
    expect(old.off).toHaveBeenCalledTimes(1);
    expect(old.listeners.size).toBe(0);
    expect(next.listeners.size).toBe(1);
    expect(document.activeElement).toBe(tile);
    expect(test.container.querySelector('[role="tooltip"]')?.textContent).toContain('64%');
    await act(async () => {
      late(reading(99));
      answer(reading(98));
    });
    expect(tile.querySelector('b')?.textContent).toBe('64%');
    await act(async () => next.emit(reading(71)));
    expect(tile.querySelector('b')?.textContent).toBe('71%');
  });
});

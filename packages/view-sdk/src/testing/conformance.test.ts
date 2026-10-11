// @vitest-environment happy-dom
import { createElement, useEffect } from 'react';
import { describe, expect, it } from 'vitest';
import { reactMonitorView, type ReactMonitorViewProps } from '../react/index.js';
import { defineMonitorView, type MonitorView, type MonitorViewInput, type MonitorViewManifest } from '../view.js';
import { checkConformance, runConformance, type ConformanceCheckId, type ConformanceReport } from './conformance.js';

const manifest = (id: string): MonitorViewManifest => ({
  sdk: 1,
  id,
  label: id.toUpperCase(),
  mark: { viewBox: '0 0 16 16', paths: ['M2 2h12v12H2z'] },
  parameters: [
    { title: 'MOTION', controls: [{ key: 'speed', label: 'SPEED', min: 0, max: 2, step: 0.1, defaultValue: 1 }] },
  ],
  motion: { loops: true },
});

const moves = (input: MonitorViewInput): boolean => input.theme.animations && !input.theme.reducedMotion;

interface Misbehaviour {
  mount?(root: HTMLElement, input: MonitorViewInput): void;
  update?(input: MonitorViewInput): void;
  unmount?(root: HTMLElement): void;
  /** Loop even when told to keep still. */
  restless?: boolean;
  /** Keep the loop running after unmount. */
  leakLoop?: boolean;
}

/**
 * A view that draws a list and animates only when allowed — well-behaved
 * unless told how to misbehave.
 */
function listView(id: string, misbehave: Misbehaviour = {}): MonitorView {
  return defineMonitorView({
    manifest: manifest(id),
    mount(root, input) {
      const list = root.ownerDocument.createElement('ul');
      root.append(list);
      // A key bound on its own root is the view's business (MV-D8).
      root.addEventListener('keydown', () => undefined);
      let current = input;
      let frame = 0;
      const loop = (): void => {
        frame = requestAnimationFrame(loop);
      };
      const draw = (): void => {
        list.replaceChildren(
          ...current.model.agents.map((agent) => {
            const item = root.ownerDocument.createElement('li');
            item.textContent = `${agent.project.name} ${agent.status} ${current.stage.width}`;
            item.style.color = agent.colour;
            return item;
          }),
        );
        cancelAnimationFrame(frame);
        frame = moves(current) || misbehave.restless ? requestAnimationFrame(loop) : 0;
      };
      draw();
      misbehave.mount?.(root, input);
      return {
        update(next) {
          misbehave.update?.(next);
          current = next;
          draw();
        },
        unmount() {
          if (!misbehave.leakLoop) cancelAnimationFrame(frame);
          list.remove();
          misbehave.unmount?.(root);
        },
      };
    },
  });
}

function failedChecks(report: ConformanceReport): Set<ConformanceCheckId> {
  return new Set(report.failures.map((failure) => failure.check));
}

runConformance(listView('calm'));

describe('checkConformance', () => {
  it('passes a well-behaved view, across every case', async () => {
    const report = await checkConformance(listView('calm'));
    expect(report.failures).toEqual([]);
    expect(report.ok).toBe(true);
    // Two schemes × three sizes, then the two motion cases.
    expect(report.cases).toBe(8);
  });

  it('hands the view the three commands alone unless told the host lends openEnded (TV-8)', async () => {
    const given: boolean[] = [];
    const probe = (id: string): MonitorView =>
      defineMonitorView({
        manifest: manifest(id),
        mount(_root, _input, commands) {
          given.push(commands.openEnded !== undefined);
          return { update: () => undefined, unmount: () => undefined };
        },
      });
    await checkConformance(probe('plain'));
    expect(new Set(given)).toEqual(new Set([false]));
    given.length = 0;
    await checkConformance(probe('door'), { openEnded: true });
    expect(new Set(given)).toEqual(new Set([true]));
  });

  it('passes a well-behaved React view', async () => {
    function Calm({ input, commands }: ReactMonitorViewProps) {
      useEffect(() => {
        if (!moves(input)) return undefined;
        let frame = requestAnimationFrame(function tick() {
          frame = requestAnimationFrame(tick);
        });
        return () => cancelAnimationFrame(frame);
      }, [input]);
      useEffect(() => commands.report({ renderer: 'dom' }), [commands]);
      return createElement(
        'ol',
        null,
        input.model.agents.map((agent) => createElement('li', { key: agent.id }, agent.project.name)),
      );
    }
    const report = await checkConformance(reactMonitorView(manifest('calm-react'), Calm));
    expect(report.failures).toEqual([]);
  });

  it('fails a view that writes to its input, and only on that', async () => {
    const report = await checkConformance(
      listView('writer', {
        mount: (_root, input) => {
          (input.stage as { width: number }).width = 0;
        },
      }),
    );
    expect(failedChecks(report)).toEqual(new Set(['immutable-input']));
    expect(report.failures[0]!.message).toMatch(/TypeError/);
  });

  it('fails a view that writes to the model index', async () => {
    const report = await checkConformance(
      listView('indexer', {
        update: (input) => {
          (input.model.byId as Map<string, unknown>).set('cached', input.model.agents[0]);
        },
      }),
    );
    expect(failedChecks(report)).toEqual(new Set(['immutable-input']));
    expect(report.failures[0]!.message).toMatch(/frozen map/);
  });

  it('fails a view that puts a node outside its root', async () => {
    const report = await checkConformance(
      listView('escapee', {
        mount: (root) => {
          const banner = root.ownerDocument.createElement('div');
          banner.id = 'escaped-banner';
          root.ownerDocument.body.append(banner);
        },
        unmount: (root) => root.ownerDocument.getElementById('escaped-banner')?.remove(),
      }),
    );
    expect(failedChecks(report)).toEqual(new Set(['own-root']));
  });

  it("fails a view that touches the host's element above its root", async () => {
    const report = await checkConformance(
      listView('reacher', {
        mount: (root) => root.parentElement?.setAttribute('data-reached', 'yes'),
      }),
    );
    expect(failedChecks(report)).toEqual(new Set(['own-root']));
  });

  it('fails a view that keeps a frame loop running when told to keep still', async () => {
    const report = await checkConformance(listView('restless', { restless: true }));
    expect(failedChecks(report)).toEqual(new Set(['still-when-asked']));
    expect(report.failures.map((failure) => failure.case)).toEqual(['animations off', 'reduced motion']);
  });

  it('fails a view whose loop outlives it', async () => {
    const report = await checkConformance(listView('undying', { leakLoop: true }), {
      schemes: ['dark'],
      sizes: ['default'],
    });
    expect(failedChecks(report)).toEqual(new Set(['cleans-up']));
    expect(report.failures[0]!.message).toMatch(/still asks for animation frames after unmount/);
  });

  it('fails a view that leaves a listener on the window', async () => {
    const report = await checkConformance(
      listView('leaky', { mount: () => window.addEventListener('resize', () => undefined) }),
      { schemes: ['light'], sizes: ['compact'] },
    );
    expect(failedChecks(report)).toEqual(new Set(['cleans-up']));
    expect(report.failures[0]!.message).toBe("left a 'resize' listener on the window");
  });

  it('accepts a listener removed through its abort signal', async () => {
    let controller = new AbortController();
    const report = await checkConformance(
      listView('aborting', {
        mount: () => {
          controller = new AbortController();
          window.addEventListener('resize', () => undefined, { signal: controller.signal });
        },
        unmount: () => controller.abort(),
      }),
    );
    expect(report.failures).toEqual([]);
  });

  it('fails a view that binds keys on the window, even when it lets go of them', async () => {
    const handler = (): void => undefined;
    const report = await checkConformance(
      listView('grabby', {
        mount: () => window.addEventListener('keydown', handler),
        unmount: () => window.removeEventListener('keydown', handler),
      }),
      { schemes: ['dark'], sizes: ['wide'] },
    );
    expect(failedChecks(report)).toEqual(new Set(['no-global-keys']));
  });

  it('fails a view that leaves nodes in its root', async () => {
    const report = await checkConformance(
      listView('litter', { mount: (root) => root.append(root.ownerDocument.createElement('canvas')) }),
      { schemes: ['dark'], sizes: ['default'] },
    );
    expect(failedChecks(report)).toEqual(new Set(['cleans-up']));
    expect(report.failures[0]!.message).toBe('left 1 node(s) in its root');
  });

  it('fails a view that breaks on a crowded stage, naming the case', async () => {
    const report = await checkConformance(
      listView('fragile', {
        update: (input) => {
          if (input.model.agents.length >= 20) throw new Error('too many bodies');
        },
      }),
      { schemes: ['dark'], sizes: ['compact'] },
    );
    expect(failedChecks(report)).toEqual(new Set(['renders']));
    expect(report.failures[0]).toEqual({
      check: 'renders',
      case: 'dark · compact · 20 agents',
      message: 'Error: too many bodies',
    });
  });

  it('fails a React view whose render throws', async () => {
    function Fragile({ input }: ReactMonitorViewProps) {
      if (input.model.agents.length >= 20) throw new Error('render broke');
      return createElement('p', null, String(input.model.agents.length));
    }
    const report = await checkConformance(reactMonitorView(manifest('fragile-react'), Fragile), {
      schemes: ['dark'],
      sizes: ['default'],
    });
    expect(failedChecks(report).has('renders')).toBe(true);
    expect(report.failures.some((failure) => /render broke/.test(failure.message))).toBe(true);
  });

  it('fails a view whose mount hands back no instance', async () => {
    const hollow = defineMonitorView({
      manifest: manifest('hollow'),
      mount: () => undefined as unknown as ReturnType<MonitorView['mount']>,
    });
    const report = await checkConformance(hollow, { schemes: ['dark'], sizes: ['default'] });
    expect(failedChecks(report)).toEqual(new Set(['renders']));
    expect(report.failures[0]!.message).toBe('mount returned no { update, unmount }');
  });

  it('skips a check it was told to skip', async () => {
    const report = await checkConformance(listView('restless-skipped', { restless: true }), {
      skip: ['still-when-asked'],
    });
    expect(report.ok).toBe(true);
  });

  it('leaves the page as it found it', async () => {
    const before = {
      body: document.body.innerHTML,
      requestAnimationFrame: window.requestAnimationFrame,
      cancelAnimationFrame: window.cancelAnimationFrame,
      windowAdd: window.addEventListener,
      documentAdd: document.addEventListener,
      act: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT,
    };
    await checkConformance(listView('tidy'), { schemes: ['dark'], sizes: ['default'] });
    expect({
      body: document.body.innerHTML,
      requestAnimationFrame: window.requestAnimationFrame,
      cancelAnimationFrame: window.cancelAnimationFrame,
      windowAdd: window.addEventListener,
      documentAdd: document.addEventListener,
      act: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT,
    }).toEqual(before);
    expect(window.requestAnimationFrame).toBe(before.requestAnimationFrame);
    expect(window.addEventListener).toBe(before.windowAdd);
    expect(Object.hasOwn(document, 'addEventListener')).toBe(false);
  });
});

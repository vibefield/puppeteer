/**
 * A view that draws one line and remembers everything a host did to it: for a
 * host's tests (the slot's own, and MV-2/MV-3's), where the question is what
 * the host delivered and when, not what a real view draws.
 */

import {
  defineMonitorView,
  type MonitorView,
  type MonitorViewCommands,
  type MonitorViewInput,
  type MonitorViewManifest,
} from '../view.js';

export interface RecordingView {
  readonly view: MonitorView;
  readonly mounts: number;
  readonly updates: number;
  readonly unmounts: number;
  /** Mounted and not yet unmounted. */
  readonly live: number;
  /** Every input received, the mount's first. */
  readonly inputs: readonly MonitorViewInput[];
  readonly lastInput: MonitorViewInput | undefined;
  /** The commands each mount was given. */
  readonly commands: readonly MonitorViewCommands[];
  /** The root each mount was given. */
  readonly roots: readonly HTMLElement[];
}

export interface RecordingViewOptions {
  /** Shared between views to read the order of their mounts and unmounts: `"<id>:mount"`, … */
  readonly log?: string[] | undefined;
  readonly manifest?: Partial<MonitorViewManifest> | undefined;
  readonly onMount?: ((root: HTMLElement, input: MonitorViewInput, commands: MonitorViewCommands) => void) | undefined;
  readonly onUpdate?: ((input: MonitorViewInput) => void) | undefined;
}

export function createRecordingView(id = 'recording', options: RecordingViewOptions = {}): RecordingView {
  const log = options.log ?? [];
  const inputs: MonitorViewInput[] = [];
  const commands: MonitorViewCommands[] = [];
  const roots: HTMLElement[] = [];
  let mounts = 0;
  let updates = 0;
  let unmounts = 0;
  const view = defineMonitorView({
    manifest: {
      sdk: 1,
      id,
      label: id.toUpperCase(),
      mark: { viewBox: '0 0 16 16', paths: ['M2 2h12v12H2z'] },
      parameters: [],
      motion: { loops: false },
      ...options.manifest,
    },
    mount(root, input, given) {
      mounts += 1;
      log.push(`${id}:mount`);
      inputs.push(input);
      commands.push(given);
      roots.push(root);
      const line = root.ownerDocument.createElement('p');
      line.textContent = id;
      root.append(line);
      options.onMount?.(root, input, given);
      return {
        update(next) {
          updates += 1;
          log.push(`${id}:update`);
          inputs.push(next);
          options.onUpdate?.(next);
        },
        unmount() {
          unmounts += 1;
          log.push(`${id}:unmount`);
          line.remove();
        },
      };
    },
  });
  return {
    view,
    get mounts() {
      return mounts;
    },
    get updates() {
      return updates;
    },
    get unmounts() {
      return unmounts;
    },
    get live() {
      return mounts - unmounts;
    },
    inputs,
    get lastInput() {
      return inputs.at(-1);
    },
    commands,
    roots,
  };
}

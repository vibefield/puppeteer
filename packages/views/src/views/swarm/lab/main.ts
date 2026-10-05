import { AGENT_MARK_CANDIDATES, resolveCssColor, type Rgba } from '@vibecook/puppeteer-view-sdk/toolkit';
import { labAgentView } from '../../../lab/lab-model.js';
import { mountViewLab } from '../../../lab/lab-stage.js';
import { readMonitorPalette } from '../../../monitor/palette.js';
import { monitorParameterDefaults, type MonitorParameters } from '../../../monitor/parameters.js';
import { paneTint, projectTint } from '../../../colour/project-tint.js';
import { bubbleModel, type SwarmBubbleModel } from '../bubble-model.js';
import {
  createSwarmRenderer,
  type RenderBody,
  type RenderMark,
  type SwarmRenderer,
  type SwarmTheme,
} from '../gpu/swarm-renderer.js';
import {
  DEFAULT_SWARM_PARAMETERS,
  SWARM_PARAMETER_GROUPS,
  normalizeSwarmParameters,
  type SwarmParameters,
} from '../swarm-parameters.js';
import { SWARM_MANIFEST, swarmMonitorView } from '../index.js';
import { resolveSwarmTheme } from '../swarm-theme.js';
import {
  bloomStages,
  burnStages,
  clusterStages,
  lightStages,
  pendingStages,
  profileStages,
  stateStages,
  type LabFieldStage,
  type LabStage,
} from './fixtures.js';
// The lab's own layout, bundled beside the view's stylesheets (the page inlines what the bundle emits).
import './lab.css';

// The swarm design lab: one page, the production renderer, fixture agents in
// every state and setting, and the view's own tunables as live controls. It
// exists so a design change is reviewed as the pixels the app will draw, then
// the losing variant is deleted — never as a mock that the build has to chase.
//
// The page is one WebGPU canvas behind a normal-flow document: each stage is a
// DOM cell whose rectangle is measured and handed to the renderer as a body's
// position, so captions and layout stay ordinary HTML.
//
// Above the parts, the SHIPPING view: the swarm as the SDK view it is, over the
// seeded world in Godview's stage (`lab/lab-stage.ts`), so what ships —
// its models, its physics, its chrome avoidance — is under review too, not only
// the renderer. The theme, the motion box and the sliders drive both. Its URL is
// the other view labs': `?n=`, `?size=`, `?theme=dark`, `?animations=0`, and
// `?capture=1` shows the view alone, on the capture clock.

interface PlacedStage {
  stage: LabStage;
  cell: HTMLElement;
  model: SwarmBubbleModel;
  accent: Rgba;
  link?: Rgba;
  /** Offset inside the cell for cluster bodies; centred otherwise. */
  offset?: { x: number; y: number };
}

interface Cluster {
  cell: HTMLElement;
  stages: LabStage[];
  positions: { x: number; y: number }[];
}

/** A whole field in one cell, with its own canvas and renderer: its frame carries the veil, clearings, hub. */
interface FieldCell {
  stage: LabFieldStage;
  cell: HTMLElement;
  canvas: HTMLCanvasElement;
  renderer?: SwarmRenderer;
  extras: PlacedStage[];
}

const PHYSICAL_GAP = 4;

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** A settled field: centre pull and pairwise separation, the way the swarm rests. */
function settle(radii: readonly number[], width: number, height: number, seed = 3): { x: number; y: number }[] {
  const golden = Math.PI * (3 - Math.sqrt(5));
  const points = radii.map((_, index) => ({
    x: width / 2 + Math.cos(index * golden + seed) * 18 * Math.sqrt(index + 1),
    y: height / 2 + Math.sin(index * golden + seed) * 18 * Math.sqrt(index + 1),
  }));
  for (let iteration = 0; iteration < 600; iteration += 1) {
    points.forEach((point, index) => {
      point.x += (width / 2 - point.x) * 0.02;
      point.y += (height / 2 - point.y) * 0.02;
      const r = radii[index]! + PHYSICAL_GAP;
      point.x = Math.min(Math.max(point.x, r), width - r);
      point.y = Math.min(Math.max(point.y, r), height - r);
    });
    for (let a = 0; a < points.length; a += 1) {
      for (let b = a + 1; b < points.length; b += 1) {
        const pa = points[a]!;
        const pb = points[b]!;
        const dx = pb.x - pa.x;
        const dy = pb.y - pa.y;
        const distance = Math.hypot(dx, dy) || 0.01;
        const minimum = radii[a]! + radii[b]! + PHYSICAL_GAP * 2;
        if (distance >= minimum) continue;
        const push = (minimum - distance) / 2;
        const ux = dx / distance;
        const uy = dy / distance;
        pa.x -= ux * push;
        pa.y -= uy * push;
        pb.x += ux * push;
        pb.y += uy * push;
      }
    }
  }
  return points;
}

async function main(): Promise<void> {
  const root = document.getElementById('lab');
  if (!root) return;
  let viewParameters: MonitorParameters = monitorParameterDefaults(SWARM_MANIFEST.parameters);
  // The shipping view through the view host, as Godview mounts it (MV-5). The lab page is one IIFE, so the
  // view's physics run inline (`import.meta.url` is empty there) and it reports `physics: 'inline'`, honestly.
  const view = mountViewLab({
    root,
    mount: root.querySelector('.lab-view')!,
    view: swarmMonitorView,
    parameters: viewParameters,
  });
  // The golden page is the view alone: the renderer-direct parts would only draw under it.
  if (view.params.capture) return;
  const nowMs = Date.now();
  let parameters: SwarmParameters = { ...DEFAULT_SWARM_PARAMETERS };
  let motion = view.params.animations;
  let theme: SwarmTheme | undefined;
  const colourCache = new Map<string, Rgba>();
  const accentOf = (value: string): Rgba => {
    const cached = colourCache.get(value);
    if (cached) return cached;
    const resolved = resolveCssColor(value, root);
    colourCache.set(value, resolved);
    return resolved;
  };

  // The tuning panel: fixed to the viewport, and collapsible to its own bar,
  // because the page runs to several screens of stages and a tunable that has
  // scrolled away is no tunable at all.
  const controls = root.querySelector<HTMLElement>('.lab-controls')!;
  const panelHead = element('header', 'lab-panel-head');
  const panelToggle = element('button', 'lab-panel-toggle', 'Hide');
  panelToggle.type = 'button';
  panelToggle.setAttribute('aria-expanded', 'true');
  panelHead.append(element('span', undefined, 'Tune'), panelToggle);
  const panelBody = element('div', 'lab-panel-body');
  panelBody.id = 'lab-tune';
  panelToggle.setAttribute('aria-controls', panelBody.id);
  controls.append(panelHead, panelBody);
  panelToggle.addEventListener('click', () => {
    const opening = panelBody.hidden;
    panelBody.hidden = !opening;
    panelToggle.textContent = opening ? 'Hide' : 'Show';
    panelToggle.setAttribute('aria-expanded', String(opening));
  });

  const themeButton = element('button', 'lab-theme', view.params.theme === 'dark' ? 'Light' : 'Dark');
  themeButton.type = 'button';
  const motionLabel = element('label', 'lab-check');
  const motionInput = element('input');
  motionInput.type = 'checkbox';
  motionInput.checked = motion;
  motionLabel.append(motionInput, document.createTextNode('motion'));
  const panelRow = element('div', 'lab-panel-row');
  panelRow.append(themeButton, motionLabel);
  panelBody.append(panelRow);

  const sliders = new Map<string, HTMLInputElement>();
  for (const group of SWARM_PARAMETER_GROUPS) {
    if (group.title === 'ENGINE VARIABLES') continue;
    // The panel keeps the parameter groups' own titles: seventeen sliders in a
    // narrow column need saying where one family ends and the next begins.
    const section = element('div', 'lab-group');
    section.append(element('span', 'lab-group-title', group.title));
    for (const control of group.controls) {
      const label = element('label', 'lab-slider');
      const name = element('span', 'lab-slider-name', control.label);
      const value = element('span', 'lab-slider-value', String(control.defaultValue));
      const input = element('input');
      input.type = 'range';
      input.min = String(control.min);
      input.max = String(control.max);
      input.step = String(control.step);
      input.value = String(control.defaultValue);
      input.addEventListener('input', () => {
        value.textContent = input.value;
        parameters = normalizeSwarmParameters({ ...parameters, [control.key]: Number(input.value) });
        viewParameters = { ...viewParameters, [control.key]: Number(input.value) };
        view.setParameters(viewParameters);
        // The STATE GLOW colours are resolved into the theme rather than sent as
        // uniforms, so a slider re-applies the theme rather than only rebuilding.
        applyTheme();
      });
      sliders.set(control.key, input);
      // Name and reading share the first row, the slider spans the second, so the
      // grid has to receive them in that order.
      label.append(name, value, input);
      section.append(label);
    }
    panelBody.append(section);
  }

  // Stages.
  const canvas = root.querySelector<HTMLCanvasElement>('canvas.lab-canvas')!;
  const placed: PlacedStage[] = [];
  const clusters: Cluster[] = [];
  const stageIndex = new Map<string, PlacedStage>();

  const markCells: { cell: HTMLElement; tile: { x: number; y: number }; chosen: boolean }[] = [];
  const addMarks = (): void => {
    const section = element('section', 'lab-part');
    section.append(
      element('h2', undefined, 'Marks'),
      element(
        'p',
        'lab-lede',
        'Each agent’s mark from the signed-distance atlas, beside the neighbours it could be confused with. The chosen one is full ink; the others are dimmed.',
      ),
    );
    const grid = element('div', 'lab-grid lab-marks');
    for (const candidate of AGENT_MARK_CANDIDATES) {
      const figure = element('figure', 'lab-stage');
      const cell = element('div', 'lab-cell lab-mark-cell');
      const caption = element('figcaption');
      caption.append(
        element('b', undefined, `${candidate.title}${candidate.chosen ? ' ✓' : ''}`),
        element('span', undefined, `${candidate.id}${candidate.provider ? ` · for ${candidate.provider}` : ''}`),
      );
      figure.append(cell, caption);
      grid.append(figure);
      markCells.push({ cell, tile: candidate.tile, chosen: candidate.chosen === true });
    }
    section.append(grid);
    root.querySelector('.lab-parts')!.append(section);
  };

  const addPart = (title: string, lede: string, stages: LabStage[], kind: 'grid' | 'cluster'): void => {
    const partId = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    const section = element('section', 'lab-part');
    section.append(element('h2', undefined, title), element('p', 'lab-lede', lede));
    if (kind === 'grid') {
      const grid = element('div', 'lab-grid');
      stages.forEach((stage, index) => {
        const figure = element('figure', 'lab-stage');
        // The stage's id on the figure: a capture script can clip one body by name.
        figure.dataset.stage = stage.id;
        const cell = element('div', 'lab-cell');
        const caption = element('figcaption');
        caption.append(
          element('b', undefined, `${String(index + 1).padStart(2, '0')} · ${stage.title}`),
          element('span', undefined, stage.note),
        );
        figure.append(cell, caption);
        grid.append(figure);
        const entry: PlacedStage = { stage, cell, model: modelOf(stage), accent: [0, 0, 0, 1] };
        placed.push(entry);
        stageIndex.set(stage.id, entry);
      });
      section.append(grid);
    } else {
      const cell = element('div', 'lab-cluster');
      // The field's id on the cell: a capture script can clip one field by name.
      cell.dataset.field = partId;
      section.append(cell);
      clusters.push({ cell, stages, positions: [] });
      for (const stage of stages) {
        const entry: PlacedStage = { stage, cell, model: modelOf(stage), accent: [0, 0, 0, 1] };
        placed.push(entry);
        stageIndex.set(stage.id, entry);
      }
    }
    root.querySelector('.lab-parts')!.append(section);
  };

  /** A stable phase per stage, so bodies that breathe or ping do not do it in
   * unison. The app seeds this at random; the lab needs it to be the same on
   * every reload, and taking the id's LENGTH gave every two-character id in a
   * cluster the same phase. */
  function phaseOf(id: string): number {
    let hash = 0;
    for (let index = 0; index < id.length; index += 1) hash = (hash * 31 + id.charCodeAt(index)) % 9973;
    return (hash / 9973) * Math.PI * 2;
  }

  function modelOf(stage: LabStage): SwarmBubbleModel {
    const built = Date.now();
    const model = bubbleModel({
      // The fixtures are legacy rows (a host's catalog still mounts them); the body reads the row as the model says it.
      agent: labAgentView(stage.agent, built),
      parameters,
      nowMs: built,
      unread: stage.unread === true,
      ...(stage.runningSinceMs === undefined ? {} : { runningSinceMs: stage.runningSinceMs }),
      ...(stage.workingShare === undefined ? {} : { workingShare: stage.workingShare }),
      ...(stage.profile ? { profile: stage.profile } : {}),
      // Pinned to its age at every rebuild, so a stage "before 320 ms" stays before.
      ...(stage.opening
        ? { opening: { sinceMs: built - stage.opening.agoMs, ...(stage.opening.on ? { on: stage.opening.on } : {}) } }
        : {}),
    });
    return stage.patch ? stage.patch(model) : model;
  }

  // The field under the spawn bloom: whole fields, each its own canvas and renderer.
  const fieldCells: FieldCell[] = [];
  const fieldBodies: PlacedStage[] = clusterStages(nowMs).map((stage) => ({
    stage,
    cell: root,
    model: modelOf(stage),
    accent: [0, 0, 0, 1],
  }));
  const addFieldPart = (title: string, lede: string, stages: LabFieldStage[]): void => {
    const section = element('section', 'lab-part');
    section.append(element('h2', undefined, title), element('p', 'lab-lede', lede));
    const grid = element('div', 'lab-fields');
    stages.forEach((stage, index) => {
      const figure = element('figure', 'lab-stage');
      figure.dataset.stage = stage.id;
      const cell = element('div', 'lab-cell lab-field-cell');
      const canvas = element('canvas', 'lab-field-canvas');
      canvas.setAttribute('aria-hidden', 'true');
      cell.append(canvas);
      const caption = element('figcaption');
      caption.append(
        element('b', undefined, `${String(index + 1).padStart(2, '0')} · ${stage.title}`),
        element('span', undefined, stage.note),
      );
      figure.append(cell, caption);
      grid.append(figure);
      const extras = (stage.extra ?? []).map((extra) => ({
        stage: extra.stage,
        cell,
        model: modelOf(extra.stage),
        accent: [0, 0, 0, 1] as Rgba,
      }));
      fieldCells.push({ stage, cell, canvas, extras });
    });
    section.append(grid);
    root.querySelector('.lab-parts')!.append(section);
  };

  addMarks();
  addPart('States', 'Every drawn state, one body each, at the sizes the sliders hold.', stateStages(nowMs), 'grid');
  addPart(
    'The burn ladder',
    'How hard a session is spending, as up to four flames on a fixed absolute ladder of estimated USD per minute — about three times the spend per step, and only as many flames as the rate has lit. Absolute, so one body’s reading means what another’s does.',
    burnStages(nowMs),
    'grid',
  );
  addPart(
    'The pane light, weighed',
    'The selected pane’s light under three settings on the idle body. The sliders above set the app’s; these are fixed for comparison.',
    lightStages(nowMs),
    'grid',
  );
  addPart(
    'The field',
    'Eight bodies settled under centre gravity, as the swarm actually rests.',
    clusterStages(nowMs),
    'cluster',
  );
  addPart(
    'The body being born',
    'Where the person let go of the spawn bloom, a pending body stands until the host’s terminal row arrives.',
    pendingStages(nowMs),
    'grid',
  );
  addPart(
    'Born under a profile',
    'A terminal born under an Agent Profile names it on its body, where the desktop has more than one.',
    profileStages(nowMs),
    'grid',
  );
  addFieldPart(
    'The field under the spawn bloom',
    'What a frame carries while the bloom is open, each field drawn by its own renderer: the veil, the clearings the bloom and its words stand on, the hub above everything, and the body being born.',
    bloomStages(nowMs),
  );

  const rebuild = (): void => {
    for (const entry of [...placed, ...fieldBodies, ...fieldCells.flatMap((field) => field.extras)]) {
      entry.model = modelOf(entry.stage);
      entry.accent = accentOf(entry.model.accent);
      if (entry.model.linked) entry.link = accentOf(entry.model.linked);
      else delete entry.link;
    }
    // Every field cell is the same size, so one settled field serves them all.
    const fieldRect = fieldCells[0]?.cell.getBoundingClientRect();
    if (fieldRect) {
      const positions = settle(
        fieldBodies.map((entry) => entry.model.radius),
        fieldRect.width,
        fieldRect.height,
      );
      fieldBodies.forEach((entry, index) => {
        entry.offset = positions[index]!;
      });
    }
    for (const cluster of clusters) {
      const rect = cluster.cell.getBoundingClientRect();
      const radii = cluster.stages.map((stage) => stageIndex.get(stage.id)!.model.radius);
      cluster.positions = settle(radii, rect.width, rect.height);
      cluster.stages.forEach((stage, index) => {
        stageIndex.get(stage.id)!.offset = cluster.positions[index]!;
      });
    }
  };

  // The fixtures name their projects by sequence (`--lab-project-N`); the
  // colours are dealt here from the theme's tint, exactly as the app deals them.
  const dealProjects = (): void => {
    const { tint } = readMonitorPalette();
    for (let seq = 0; seq < 8; seq += 1) {
      root.style.setProperty(`--lab-project-${seq}`, projectTint(seq, tint));
      root.style.setProperty(`--lab-pane-${seq}`, paneTint(seq, tint));
    }
  };
  const applyTheme = (): void => {
    dealProjects();
    theme = resolveSwarmTheme(readMonitorPalette().swarm, root, parameters);
    colourCache.clear();
    rebuild();
  };
  themeButton.addEventListener('click', () => {
    const dark = !root.classList.contains('theme-dark');
    view.setTheme(dark ? 'dark' : 'light');
    themeButton.textContent = dark ? 'Light' : 'Dark';
    applyTheme();
  });
  motionInput.addEventListener('change', () => {
    motion = motionInput.checked;
    // The view reads the host's switch, as it does in Godview.
    view.setAnimations(motion);
  });

  const result = await createSwarmRenderer(canvas);
  const notice = root.querySelector<HTMLElement>('.lab-notice')!;
  if (!result.ok) {
    notice.textContent = `WebGPU is unavailable here: ${result.reason}`;
    notice.hidden = false;
    return;
  }
  notice.hidden = true;
  const renderer: SwarmRenderer = result.renderer;
  for (const field of fieldCells) {
    const made = await createSwarmRenderer(field.canvas);
    if (made.ok) field.renderer = made.renderer;
    else console.warn('[swarm lab] a field stage has no renderer:', made.reason);
  }

  let width = 1;
  let height = 1;
  const resize = (): void => {
    const rect = root.getBoundingClientRect();
    width = rect.width;
    height = rect.height;
    renderer.resize(width, height, window.devicePixelRatio || 1);
    for (const field of fieldCells) {
      const cell = field.cell.getBoundingClientRect();
      field.renderer?.resize(cell.width, cell.height, window.devicePixelRatio || 1);
    }
    rebuild();
  };
  new ResizeObserver(resize).observe(root);
  applyTheme();
  resize();

  const started = performance.now();
  let lastModelRefresh = 0;
  const frame = (time: number): void => {
    requestAnimationFrame(frame);
    if (!theme) return;
    if (time - lastModelRefresh > 1000) {
      lastModelRefresh = time;
      rebuild();
    }
    const rootRect = root.getBoundingClientRect();
    const bodies: RenderBody[] = [];
    const marks: RenderMark[] = [];
    let hold: { x: number; y: number; progress: number } | undefined;
    for (const mark of markCells) {
      const rect = mark.cell.getBoundingClientRect();
      marks.push({
        tile: mark.tile,
        size: 40,
        x: rect.left - rootRect.left + rect.width / 2,
        y: rect.top - rootRect.top + rect.height / 2,
        colour: theme.ink,
        alpha: mark.chosen ? 1 : 0.4,
      });
    }
    for (const entry of placed) {
      const rect = entry.cell.getBoundingClientRect();
      const x = rect.left - rootRect.left + (entry.offset ? entry.offset.x : rect.width / 2);
      const y = rect.top - rootRect.top + (entry.offset ? entry.offset.y : rect.height / 2);
      if (entry.stage.hold) {
        hold = { x, y, progress: 1 };
        continue;
      }
      bodies.push({
        model: entry.model,
        x,
        y,
        radius: entry.model.radius,
        scale: 1,
        opacity: 1,
        focus: entry.stage.focus === true,
        seed: phaseOf(entry.stage.id),
        accent: entry.accent,
        ...(entry.link ? { link: entry.link } : {}),
        ...(entry.stage.glow ? { glow: entry.stage.glow } : {}),
      });
    }
    const shared = {
      time: (time - started) / 1000,
      motion,
      fillOpacity: parameters.bubbleFillOpacity,
      gridPitch: 24,
      glow: { reach: parameters.glowReach, strength: parameters.glowStrength, breath: parameters.glowBreath },
      stateGlow: {
        inner: parameters.stateGlowInner,
        full: parameters.stateGlowFull,
        strength: parameters.stateGlowStrength,
        count: parameters.stateWaveCount,
        speed: parameters.stateWaveSpeed,
        depth: parameters.stateWaveDepth,
      },
      theme,
    };
    renderer.render({ ...shared, bodies, marks, ...(hold ? { hold } : {}) });

    // Each field stage is one frame: the host's part (AgentSwarm, once the bloom
    // feeds it) done by hand — a body's opacity already carries the veil unless
    // it is lit, and places are the cell's own, from its centre.
    for (const field of fieldCells) {
      if (!field.renderer) continue;
      const rect = field.cell.getBoundingClientRect();
      const cx = rect.width / 2;
      const cy = rect.height / 2;
      const { veil = 0, lit = [], clearings, hold: hub, extra = [] } = field.stage;
      const place = (entry: PlacedStage, x: number, y: number, opacity: number, above: boolean): RenderBody => ({
        model: entry.model,
        x,
        y,
        radius: entry.model.radius,
        scale: 1,
        opacity,
        focus: false,
        seed: phaseOf(entry.stage.id),
        accent: entry.accent,
        ...(entry.link ? { link: entry.link } : {}),
        ...(above ? { aboveClearings: true } : {}),
      });
      const fieldBodyList = fieldBodies.map((entry) =>
        place(entry, entry.offset?.x ?? cx, entry.offset?.y ?? cy, lit.includes(entry.stage.id) ? 1 : 1 - veil, false),
      );
      field.extras.forEach((entry, index) => {
        const at = extra[index]!;
        fieldBodyList.push(place(entry, cx + at.x, cy + at.y, 1, at.above === true));
      });
      field.renderer.render({
        ...shared,
        bodies: fieldBodyList,
        ...(veil > 0 ? { veil } : {}),
        ...(clearings
          ? { clearings: clearings.map((clearing) => ({ ...clearing, x: cx + clearing.x, y: cy + clearing.y })) }
          : {}),
        ...(hub ? { hold: { ...hub, x: cx + hub.x, y: cy + hub.y, progress: hub.progress ?? 1 } } : {}),
      });
    }
  };
  requestAnimationFrame(frame);
}

void main();

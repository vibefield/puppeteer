import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { monitorChromeElements } from '../../../monitor/chrome.js';
import { approachRecede, everyReceded, recedeTarget } from '../../../monitor/recede.js';
import type { AgentMonitorProps, MonitorAgent } from '../../../monitor/types.js';
import { birthAgent, birthOf, birthOverdue, birthRow, profileLineFor, type BloomBirth } from './bloom/birth.js';
import { BLOOM } from '../../../views/swarm/bloom/constants.js';
import {
  arrivalFrom,
  bloomFieldMemory,
  departure,
  stepBloomField,
  stepLit,
  veiledOpacity,
} from './bloom/field-frame.js';
import type { BloomBody } from './bloom/model.js';
import { SpawnBloom } from './bloom/SpawnBloom.js';
import { useSpawnBloom } from './bloom/use-spawn-bloom.js';
import { bubbleModel, workingShares, type SwarmBubbleModel } from './bubble-model.js';
import { resolveCssColor, type Rgba } from '../../../views/swarm/gpu/color.js';
import {
  createSwarmRenderer,
  MAX_CLEARINGS,
  type RenderBody,
  type SwarmRenderer,
  type SwarmTheme,
} from '../../../views/swarm/gpu/swarm-renderer.js';
import { useSwarmPhysicsDriverFactory } from '../../../views/swarm/physics/context.js';
import { readSwarmFrame, type BubbleState } from '../../../views/swarm/physics/frame.js';
import type { SwarmPhysicsDriver } from '../../../views/swarm/physics/inline-driver.js';
import type { SwarmPhysicsEvent } from '../../../views/swarm/physics/protocol.js';
import {
  PHYSICS_HZ_FLOOR,
  type SwarmAgentSpec,
  type SwarmObstacleRect,
  type SwarmPhysicsParameters,
} from '../../../views/swarm/physics/world.js';
import { normalizeSwarmParameters, type SwarmParameters } from '../../../views/swarm/swarm-parameters.js';
import { resolveSwarmTheme } from '../../../views/swarm/swarm-theme.js';

// The swarm — the matter.js agent field, drawn by WebGPU (RFC 005).
//
// Status is size and treatment, never a decorative hue: the per-bubble color is
// the project's (record §02, stable per session, groups and labels), and the
// state reading comes from the theme the stage hands down.
//
// THE SIMULATION IS NOT HERE. matter, the accumulator, the springs and the
// spawn search live in `physics/world.ts`, behind a driver the host chooses
// (`physics/context.tsx`): in this thread by default, in a worker where the
// host runs one. What is left in this file is everything that genuinely needs
// a document or a GPU: measuring chrome, mapping pointers into world
// coordinates, the WebGPU renderer, the models the bodies draw, the hidden
// button per body for keyboard and assistive access, and the hover tooltip.
// `bubble-model.ts` owns what a body says; `gpu/swarm-renderer.ts` owns how it
// is painted.
//
// The render loop draws at the display's rate by interpolating between the
// last two states the physics published, and the visual radius follows the
// physics radius on a critically damped spring — so the field looks the same
// whether the physics steps at 15Hz or 120.

/** What this thread keeps about one body beyond the physics' own frame. */
interface BodyVisual {
  /** The physics radius jumps; this one springs after it. */
  visualRadius: number;
  visualVelocity: number;
  spawnedAt: number;
  seed: number;
  /** Arrival order, for a stable draw order within one status. */
  arrival: number;
  /** The weight it is drawn at while the host shows another group: 1 when shown (`monitor/recede.ts`). */
  recede: number;
  /** Born from a bloom's bud: its arrival starts from the bud's size over its own (the spawn bloom, SB). */
  from?: number;
  /** Drawn above the bloom's clearings until then: the body being born (record §2.8 (4)). */
  aboveUntil?: number;
}

/** A birth on its way (SB §2.6), and the seed its body keeps when its row takes over. */
interface Birthing {
  birth: BloomBirth;
  readonly seed: number;
}

interface Drag {
  id: string;
  pointerId: number;
  startX: number;
  startY: number;
  dragged: boolean;
}

interface Hold {
  pointerId: number;
  clientX: number;
  clientY: number;
  x: number;
  y: number;
  startedAt: number;
}

const LONG_PRESS_DURATION_MS = 520;
const LONG_PRESS_MOVE_TOLERANCE = 8;
const SPAWN_DURATION_MS = 720;
/** Critically damped: about 90% of a size change lands within 300ms. */
const RADIUS_SPRING_OMEGA = 16;
const GRID_PITCH = 24;
/** The burn rate moves on its own: models are refreshed on this cadence even when nothing else changed. */
const MODEL_REFRESH_MS = 1000;
const STATUS_RANK: Record<SwarmBubbleModel['appearance'], number> = { idle: 0, working: 1, blocked: 2 };
/** The signifier (SB §2.11): a pointer still this long over empty ground is told what a hold does… */
const SIGNIFIER_STILL_MS = 1200;
/** …the first this-many times per page load. */
const SIGNIFIER_TIMES = 3;
/** A still pointer may wander this far. */
const SIGNIFIER_SLOP = 3;
let signifiersShown = 0;

/** Whether the element has the keyboard's focus ring (a click's focus does not). */
function focusVisible(element: Element): boolean {
  try {
    return element.matches(':focus-visible');
  } catch {
    return false;
  }
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** The physics' half of the panel's parameters. The rest describe how a body LOOKS. */
function physicsParameters(swarm: SwarmParameters): SwarmPhysicsParameters {
  return {
    gravityPull: swarm.gravityPull,
    restitution: swarm.restitution,
    frictionAir: swarm.frictionAir,
    physicsHz: swarm.physicsHz,
  };
}

/** The arrival curve: 0 → 1.2 → 0.96 → 1.035 → 1 over 720ms. */
function arrival(elapsedMs: number): { scale: number; opacity: number } {
  const t = elapsedMs / SPAWN_DURATION_MS;
  if (t >= 1) return { scale: 1, opacity: 1 };
  if (t <= 0) return { scale: 0, opacity: 0 };
  const outQuint = (u: number): number => 1 - (1 - u) ** 5;
  const outQuad = (u: number): number => 1 - (1 - u) ** 2;
  const inOut = (u: number): number => (u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2);
  if (t < 0.52) {
    const u = outQuint(t / 0.52);
    return { scale: 1.2 * u, opacity: u };
  }
  if (t < 0.72) return { scale: 1.2 + (0.96 - 1.2) * outQuint((t - 0.52) / 0.2), opacity: 1 };
  if (t < 0.88) return { scale: 0.96 + (1.035 - 0.96) * outQuad((t - 0.72) / 0.16), opacity: 1 };
  return { scale: 1.035 + (1 - 1.035) * inOut((t - 0.88) / 0.12), opacity: 1 };
}

interface Models {
  byId: Map<string, SwarmBubbleModel>;
  at: number;
  agents: readonly MonitorAgent[];
}

export function AgentSwarm({ agents, parameters, actions, palette, spawnMenu }: AgentMonitorProps) {
  const swarm = useMemo<SwarmParameters>(() => normalizeSwarmParameters(parameters), [parameters]);
  const createDriver = useSwarmPhysicsDriverFactory();
  const containerRef = useRef<HTMLElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const driverRef = useRef<SwarmPhysicsDriver | undefined>(undefined);
  /** Index → id for the frames arriving now, and the generation it belongs to. */
  const tableRef = useRef<{ generation: number; ids: readonly string[] }>({ generation: -1, ids: [] });
  /** The last two solved positions per body: the two ends of the blend. */
  const statesRef = useRef(new Map<string, BubbleState>());
  const visualsRef = useRef(new Map<string, BodyVisual>());
  /** When this terminal's foreground job was first seen, per row. */
  const runningSinceRef = useRef(new Map<string, number>());
  /** When the newest frame landed, in this thread's clock. */
  const frameAtRef = useRef<number | null>(null);
  const rendererRef = useRef<SwarmRenderer | undefined>(undefined);
  const parametersRef = useRef(swarm);
  const agentsRef = useRef<readonly MonitorAgent[]>(agents);
  /** Which rows the host has receded, and whether that is all of them; read by the render loop. */
  const recedeRef = useRef<{ ids: ReadonlySet<string>; every: boolean }>({ ids: new Set(), every: false });
  const modelsRef = useRef<Models>({ byId: new Map(), at: 0, agents: [] });
  const themeRef = useRef<SwarmTheme | undefined>(undefined);
  const colourCacheRef = useRef(new Map<string, Rgba>());
  const orderRef = useRef<readonly RenderBody[]>([]);
  const arrivalCounterRef = useRef(0);
  const dragRef = useRef<Drag | undefined>(undefined);
  const holdRef = useRef<Hold | undefined>(undefined);
  const holdTimerRef = useRef<number | undefined>(undefined);
  const focusedIdRef = useRef<string | undefined>(undefined);
  const hoveredIdRef = useRef<string | undefined>(undefined);
  const [hovered, setHovered] = useState<{ agent: MonitorAgent; x: number; y: number } | undefined>(undefined);
  const [cursor, setCursor] = useState<'default' | 'grab' | 'grabbing'>('default');
  const [failure, setFailure] = useState<string | undefined>(undefined);
  /** What is painting: `starting` until the device answers, then `webgpu` or `unavailable`. */
  const [rendererState, setRendererState] = useState<'starting' | 'webgpu' | 'unavailable'>('starting');
  /** The chrome over the field as rectangles, read by the render effect's own measure. */
  const readChromeRef = useRef<() => readonly SwarmObstacleRect[]>(() => []);
  const newTerminalRef = useRef<HTMLButtonElement>(null);
  /** The keys door is focused from the keyboard: its echo shows where the bloom will open. */
  const [newTerminalFocus, setNewTerminalFocus] = useState(false);
  /** The signifier under a still pointer, and the stillness it waits on. */
  const [signifier, setSignifier] = useState<{ x: number; y: number } | undefined>(undefined);
  const stillRef = useRef<{ timer: number; x: number; y: number } | undefined>(undefined);
  /** The field under a bloom — the veil, what it lights, its clearings — eased across frames. */
  const fieldMemoryRef = useRef(bloomFieldMemory());
  /** Births on their way: drawn where the person let go until the host's row takes over. */
  const birthsRef = useRef<Birthing[]>([]);
  const birthSeqRef = useRef(0);
  const spawnMenuRef = useRef(spawnMenu);
  spawnMenuRef.current = spawnMenu;

  // The spawn bloom (SB): with a spawn menu, a completed hold opens it instead of
  // creating at once; without one, the hold creates at once as it always has.
  const bloom = useSpawnBloom(spawnMenu, {
    container: containerRef,
    readChrome: () => readChromeRef.current(),
    bodies: () =>
      orderRef.current.map((body): BloomBody => ({
        x: body.x,
        y: body.y,
        r: body.radius,
        scale: body.scale,
        agent: agentById(body.model.id),
      })),
    idleRadius: () => parametersRef.current.radiusIdle,
    motion: () =>
      !prefersReducedMotion() &&
      containerRef.current?.closest('.vf-godview')?.getAttribute('data-godview-animations') !== 'off',
    createAt: (position, target) => (target ? actions.createAt(position, target) : actions.createAt(position)),
    born: (choice, answer) => {
      birthSeqRef.current += 1;
      const record: Birthing = {
        birth: birthOf({
          id: `spawn-bloom-birth-${birthSeqRef.current}`,
          choice,
          menu: spawnMenuRef.current,
          idleRadius: parametersRef.current.radiusIdle,
          field: {
            width: containerRef.current?.clientWidth ?? 0,
            height: containerRef.current?.clientHeight ?? 0,
          },
          now: performance.now(),
          nowMs: Date.now(),
          rows: agentsRef.current,
        }),
        seed: Math.random() * Math.PI * 2,
      };
      birthsRef.current = [...birthsRef.current, record];
      // The host's answer starts the wait for its row; a refusal gives the birth up at once.
      const settle = (patch: { answeredAt?: number; failedAt?: number }): void => {
        if (birthsRef.current.includes(record)) record.birth = { ...record.birth, ...patch };
      };
      Promise.resolve(answer).then(
        () => settle({ answeredAt: performance.now() }),
        () => settle({ failedAt: performance.now() }),
      );
    },
  });
  const bloomRef = useRef(bloom);
  bloomRef.current = bloom;
  const blooming = bloom.state !== null && bloom.state.closed === null;

  useEffect(() => {
    agentsRef.current = agents;
    recedeRef.current = {
      ids: new Set(agents.filter((agent) => agent.receded === true).map((agent) => agent.visualId ?? agent.id)),
      every: everyReceded(agents),
    };
  }, [agents]);

  useEffect(() => {
    parametersRef.current = swarm;
    modelsRef.current.at = 0;
    driverRef.current?.post({ type: 'updateParameters', parameters: physicsParameters(swarm) });
  }, [swarm]);

  // The palette arrives as CSS; the GPU wants numbers. Resolved here, once per
  // theme, in the container's own cascade so any syntax the tokens use resolves.
  useEffect(() => {
    themeRef.current = resolveSwarmTheme(palette.swarm, containerRef.current ?? undefined, swarm);
    colourCacheRef.current.clear();
    // The chroma and the two grounds are resolved into the theme rather than sent
    // as uniforms, so moving one of those three has to re-resolve it. The rest of
    // the glow travels in the frame and needs nothing here — and naming them
    // keeps a slider drag from clearing the colour cache every frame.
  }, [palette, swarm.stateChroma, swarm.stateGroundDark, swarm.stateGroundLight]);

  const cancelHold = (): void => {
    if (holdTimerRef.current !== undefined) window.clearTimeout(holdTimerRef.current);
    holdTimerRef.current = undefined;
    holdRef.current = undefined;
  };

  useEffect(
    () => () => {
      if (holdTimerRef.current !== undefined) window.clearTimeout(holdTimerRef.current);
      if (stillRef.current) window.clearTimeout(stillRef.current.timer);
    },
    [],
  );

  /** The signifier: a pointer still over empty ground (`at`) learns what a hold does, the first
   * few times per page load; any other place, or none, puts it away. Only with a spawn menu. */
  const watchStill = (at: { x: number; y: number } | undefined): void => {
    const still = stillRef.current;
    if (still && at && Math.hypot(at.x - still.x, at.y - still.y) <= SIGNIFIER_SLOP) return;
    if (still) window.clearTimeout(still.timer);
    stillRef.current = undefined;
    setSignifier(undefined);
    if (!at || !spawnMenu || signifiersShown >= SIGNIFIER_TIMES) return;
    const timer = window.setTimeout(() => {
      if (signifiersShown >= SIGNIFIER_TIMES || holdRef.current || dragRef.current || bloomRef.current.isOpen()) return;
      signifiersShown += 1;
      setSignifier(at);
    }, SIGNIFIER_STILL_MS);
    stillRef.current = { timer, x: at.x, y: at.y };
  };

  // The renderer: created once the canvas exists, rebuilt if the device is lost.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let alive = true;
    let current: SwarmRenderer | undefined;
    const start = async (): Promise<void> => {
      const result = await createSwarmRenderer(canvas);
      if (!alive) {
        if (result.ok) result.renderer.destroy();
        return;
      }
      if (!result.ok) {
        setFailure(result.reason);
        setRendererState('unavailable');
        return;
      }
      current = result.renderer;
      rendererRef.current = current;
      setFailure(undefined);
      setRendererState('webgpu');
      const container = containerRef.current;
      if (container) current.resize(container.clientWidth, container.clientHeight, window.devicePixelRatio || 1);
      void current.lost.then((info) => {
        if (!alive || rendererRef.current !== current) return;
        console.warn('[swarm] WebGPU device lost, rebuilding', info.message);
        rendererRef.current = undefined;
        void start();
      });
    };
    void start();
    return () => {
      alive = false;
      rendererRef.current = undefined;
      current?.destroy();
    };
  }, []);

  /** A terminal born under a profile of the desktop you sit at names it, when there is more than one (SB §2.10). */
  const terminalProfile = (agent: MonitorAgent) =>
    agent.agent || agent.remote ? undefined : profileLineFor(spawnMenuRef.current, agent.profileSet);

  // A new tree can change which terminals name their profile.
  useEffect(() => {
    modelsRef.current.at = 0;
  }, [spawnMenu]);

  /** The models every body draws from, rebuilt when the rows change or the clock says so. */
  const refreshModels = (now: number): void => {
    const models = modelsRef.current;
    const nowMs = Date.now();
    const byId = new Map<string, SwarmBubbleModel>();
    const shares = workingShares(agentsRef.current);
    for (const agent of agentsRef.current) {
      const runningSince = runningSinceRef.current.get(agent.visualId ?? agent.id);
      const profile = terminalProfile(agent);
      byId.set(
        agent.visualId ?? agent.id,
        bubbleModel({
          agent,
          parameters: parametersRef.current,
          nowMs,
          unread: agent.unread === true,
          workingShare: shares.get(agent.id) ?? 0,
          ...(runningSince === undefined ? {} : { runningSinceMs: runningSince }),
          ...(profile ? { profile } : {}),
        }),
      );
    }
    models.byId = byId;
    models.at = now;
    models.agents = agentsRef.current;
  };

  /** The agents as the physics needs them: an id, the size to grow toward, where a creation gesture happened. */
  const agentSpecs = (): readonly SwarmAgentSpec[] =>
    agentsRef.current.map((agent) => {
      const model = modelsRef.current.byId.get(agent.visualId ?? agent.id);
      const spec: SwarmAgentSpec = {
        id: agent.visualId ?? agent.id,
        radius: model?.radius ?? parametersRef.current.radiusIdle,
      };
      if (agent.spawnHint) spec.spawnHint = agent.spawnHint;
      return spec;
    });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Shell chrome is solid: bubbles settle around the usage column rather than
    // drifting under it. Which elements those are is the shell's business, and
    // OBSERVING them stays here — a worker has no getBoundingClientRect. What
    // crosses the wire is rectangles.
    const chrome = monitorChromeElements(container);
    const readObstacles = (): SwarmObstacleRect[] => {
      if (chrome.length === 0) return [];
      const containerRect = container.getBoundingClientRect();
      return chrome.map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          x: rect.left - containerRect.left,
          y: rect.top - containerRect.top,
          width: rect.width,
          height: rect.height,
        };
      });
    };
    readChromeRef.current = readObstacles;

    const applyTable = (event: Extract<SwarmPhysicsEvent, { type: 'idTable' }>): void => {
      tableRef.current = { generation: event.generation, ids: event.ids };
      const living = new Set(event.ids);
      for (const id of [...statesRef.current.keys()]) {
        if (living.has(id)) continue;
        statesRef.current.delete(id);
        visualsRef.current.delete(id);
        if (dragRef.current?.id === id) dragRef.current = undefined;
      }
    };

    const driver = createDriver({
      onEvent: (event) => {
        if (event.type === 'idTable') applyTable(event);
      },
      onFrame: (frame) => {
        // READ, THEN RELEASE, and never the other way round: handing the buffer
        // back transfers it, which detaches this thread's view of it, and a
        // detached array reads as empty rather than throwing.
        if (readSwarmFrame(frame, tableRef.current, statesRef.current)) frameAtRef.current = performance.now();
        driver.post({ type: 'releaseFrame', buffer: frame }, [frame.buffer]);
      },
    });
    driverRef.current = driver;
    refreshModels(performance.now());
    driver.post({
      type: 'init',
      agents: agentSpecs(),
      parameters: physicsParameters(parametersRef.current),
      bounds: { width: container.clientWidth, height: container.clientHeight },
      obstacles: readObstacles(),
      reducedMotion: prefersReducedMotion(),
    });

    const root = container.closest<HTMLElement>('.vf-godview');
    let width = container.clientWidth;
    let height = container.clientHeight;
    const updateBounds = (): void => {
      width = container.clientWidth;
      height = container.clientHeight;
      rendererRef.current?.resize(width, height, window.devicePixelRatio || 1);
      driver.post({ type: 'updateBounds', bounds: { width, height } });
      if (chrome.length > 0) driver.post({ type: 'updateObstacles', obstacles: readObstacles() });
    };
    const resizeObserver = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(updateBounds);
    resizeObserver?.observe(container);
    for (const element of chrome) resizeObserver?.observe(element);

    const accentOf = (value: string): Rgba => {
      const cached = colourCacheRef.current.get(value);
      if (cached) return cached;
      const resolved = resolveCssColor(value, container);
      colourCacheRef.current.set(value, resolved);
      return resolved;
    };

    let frame = 0;
    let previousTime = performance.now();
    let dpr = window.devicePixelRatio || 1;
    const started = performance.now();
    const render = (time: number): void => {
      frame = requestAnimationFrame(render);
      const delta = Math.min(1000 / 30, Math.max(1000 / 120, time - previousTime));
      previousTime = time;
      const currentParameters = parametersRef.current;
      const nextDpr = window.devicePixelRatio || 1;
      if (nextDpr !== dpr) {
        dpr = nextDpr;
        rendererRef.current?.resize(width, height, dpr);
      }
      const models = modelsRef.current;
      if (models.agents !== agentsRef.current || time - models.at >= MODEL_REFRESH_MS) refreshModels(time);

      // Age of the newest frame as a fraction of a step: the blend runs 0 → 1
      // across the interval before the next one is due and holds at 1 if it
      // is late, rather than extrapolating.
      const stepMs = 1000 / Math.max(PHYSICS_HZ_FLOOR, currentParameters.physicsHz);
      const arrivedAt = frameAtRef.current;
      const alpha = arrivedAt === null ? 1 : Math.min(1, Math.max(0, (time - arrivedAt) / stepMs));
      const dt = delta / 1000;

      const renderer = rendererRef.current;
      const theme = themeRef.current;
      const motion = !prefersReducedMotion() && root?.getAttribute('data-godview-animations') !== 'off';
      const focused = focusedIdRef.current;
      const recede = recedeRef.current;
      // The field under a bloom (SB §2.8): the veil, what the bloom lights above it, the clearings.
      const bloomField = bloomRef.current.field();
      const field = stepBloomField(fieldMemoryRef.current, {
        state: bloomField.state,
        closedAt: bloomField.closedAt,
        now: time,
        dtMs: delta,
        reduced: !motion,
      });
      const rows =
        field.veil > 0 || fieldMemoryRef.current.lit.size > 0
          ? new Map(agentsRef.current.map((agent) => [agent.visualId ?? agent.id, agent] as const))
          : undefined;
      // A birth whose row has arrived: the row takes over where the birth stood.
      const takeovers = new Map<string, Birthing>();
      for (const record of birthsRef.current) {
        const row = birthRow(record.birth, agentsRef.current);
        if (row) takeovers.set(row.visualId ?? row.id, record);
      }
      const bodies: RenderBody[] = [];
      for (const [id, state] of statesRef.current) {
        const model = models.byId.get(id);
        if (!model) continue;
        // A receded body stays in the physics and only fades: the host is
        // showing another group, and this one keeps its place for when it returns.
        const recedeTo = recedeTarget(recede.ids.has(id), recede.every);
        let visual = visualsRef.current.get(id);
        if (!visual) {
          arrivalCounterRef.current += 1;
          // The host's row for a birth continues the birth's own arrival: no second one.
          const born = takeovers.get(id);
          visual = {
            visualRadius: model.radius,
            visualVelocity: 0,
            spawnedAt: born ? born.birth.bornAt : time,
            seed: born ? born.seed : Math.random() * Math.PI * 2,
            arrival: arrivalCounterRef.current,
            recede: recedeTo,
            ...(born ? { from: born.birth.from, aboveUntil: born.birth.bornAt + SPAWN_DURATION_MS + 400 } : {}),
          };
          visualsRef.current.set(id, visual);
          if (born) birthsRef.current = birthsRef.current.filter((record) => record !== born);
        }
        visual.recede = motion ? approachRecede(visual.recede, recedeTo, delta) : recedeTo;
        // The visual radius follows the model's on a critically damped spring;
        // the physics body already jumped (the frame carries its radius).
        const displacement = visual.visualRadius - model.radius;
        visual.visualVelocity +=
          (-RADIUS_SPRING_OMEGA * RADIUS_SPRING_OMEGA * displacement -
            2 * RADIUS_SPRING_OMEGA * visual.visualVelocity) *
          dt;
        visual.visualRadius += visual.visualVelocity * dt;
        if (Math.abs(visual.visualRadius - model.radius) < 0.01 && Math.abs(visual.visualVelocity) < 0.01) {
          visual.visualRadius = model.radius;
          visual.visualVelocity = 0;
        }
        const landing = motion
          ? visual.from
            ? arrivalFrom(time - visual.spawnedAt, visual.from, SPAWN_DURATION_MS)
            : arrival(time - visual.spawnedAt)
          : { scale: 1, opacity: 1 };
        // Being born, it is drawn above the clearings and under no veil; the rest of the
        // field recedes under the veil but for what the bloom points at.
        const above = visual.aboveUntil !== undefined && time < visual.aboveUntil;
        let opacity = landing.opacity * visual.recede;
        if (rows && !above) {
          const row = rows.get(id);
          const lit = stepLit(fieldMemoryRef.current, id, row ? field.lit(row) : false, delta, !motion);
          opacity = veiledOpacity(opacity, field.veil, lit);
        }
        bodies.push({
          model,
          x: state.previousX + (state.x - state.previousX) * alpha,
          y: state.previousY + (state.y - state.previousY) * alpha,
          radius: visual.visualRadius,
          scale: landing.scale,
          opacity,
          focus: focused === id,
          seed: visual.seed,
          accent: accentOf(model.accent),
          ...(model.linked ? { link: accentOf(model.linked) } : {}),
          ...(above ? { aboveClearings: true } : {}),
        });
      }
      bodies.sort((left, right) => {
        const rank = STATUS_RANK[left.model.appearance] - STATUS_RANK[right.model.appearance];
        if (rank !== 0) return rank;
        return (
          (visualsRef.current.get(left.model.id)?.arrival ?? 0) - (visualsRef.current.get(right.model.id)?.arrival ?? 0)
        );
      });
      orderRef.current = bodies;
      // Births on their way: hollow where the person let go, above the clearings, their model
      // rebuilt every frame so OPENING lands the moment the quiet runs out; given up, they shrink away.
      const births: RenderBody[] = [];
      birthsRef.current = birthsRef.current.filter((record) => {
        if (birthOverdue(record.birth, time)) record.birth = { ...record.birth, failedAt: time };
        const birth = record.birth;
        if (birth.failedAt !== null && time - birth.failedAt >= BLOOM.retract) return false;
        const model = bubbleModel({
          agent: birthAgent(birth),
          parameters: currentParameters,
          nowMs: Date.now(),
          unread: false,
          workingShare: 0,
          opening: { sinceMs: birth.sinceMs, on: birth.on },
          ...(birth.profile ? { profile: birth.profile } : {}),
        });
        const land = motion
          ? arrivalFrom(time - birth.bornAt, birth.from, SPAWN_DURATION_MS)
          : { scale: 1, opacity: 1 };
        const gone =
          birth.failedAt === null
            ? { scale: 1, opacity: 1 }
            : motion
              ? departure(time - birth.failedAt)
              : { scale: 0, opacity: 0 };
        births.push({
          model,
          x: birth.drawAt.x,
          y: birth.drawAt.y,
          radius: model.radius,
          scale: land.scale * gone.scale,
          opacity: land.opacity * gone.opacity,
          focus: false,
          seed: record.seed,
          accent: accentOf(model.accent),
          aboveClearings: true,
        });
        return true;
      });
      if (!renderer || !theme) return;

      const hold = holdRef.current;
      // The spawn bloom's hub: the hold ring kept at full size while the bloom is open.
      const hub = hold ? undefined : bloomRef.current.hub(time);
      renderer.render({
        time: (time - started) / 1000,
        motion,
        fillOpacity: currentParameters.bubbleFillOpacity,
        gridPitch: GRID_PITCH,
        glow: {
          reach: currentParameters.glowReach,
          strength: currentParameters.glowStrength,
          breath: currentParameters.glowBreath,
        },
        stateGlow: {
          inner: currentParameters.stateGlowInner,
          full: currentParameters.stateGlowFull,
          strength: currentParameters.stateGlowStrength,
          count: currentParameters.stateWaveCount,
          speed: currentParameters.stateWaveSpeed,
          depth: currentParameters.stateWaveDepth,
        },
        theme,
        bodies: births.length > 0 ? [...bodies, ...births] : bodies,
        ...(field.veil > 0 ? { veil: field.veil } : {}),
        ...(field.clearings.length > 0
          ? {
              clearings: field.clearings
                .slice(0, MAX_CLEARINGS)
                .map((cleared) => ({ ...cleared.clearing, opacity: cleared.opacity })),
            }
          : {}),
        ...(hold
          ? { hold: { x: hold.x, y: hold.y, progress: (time - hold.startedAt) / LONG_PRESS_DURATION_MS } }
          : hub
            ? { hold: hub }
            : {}),
      });
    };
    frame = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(frame);
      readChromeRef.current = () => [];
      resizeObserver?.disconnect();
      statesRef.current.clear();
      visualsRef.current.clear();
      orderRef.current = [];
      // Both halves, in order: the host tears its engine down and stops its
      // timer, then the thread (if any) goes. A closed stage runs no physics.
      driver.post({ type: 'dispose' });
      driver.dispose();
      driverRef.current = undefined;
      frameAtRef.current = null;
      tableRef.current = { generation: -1, ids: [] };
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the driver factory is the host's, fixed for the stage's life
  }, []);

  useEffect(() => {
    const nowMs = Date.now();
    const ids = new Set(agents.map((agent) => agent.visualId ?? agent.id));
    for (const id of [...runningSinceRef.current.keys()]) if (!ids.has(id)) runningSinceRef.current.delete(id);
    const shares = workingShares(agents);
    for (const agent of agents) {
      const model = bubbleModel({
        agent,
        parameters: swarm,
        nowMs,
        unread: agent.unread === true,
        workingShare: shares.get(agent.id) ?? 0,
      });
      // The clock starts at the first sight of a foreground job and survives
      // an `unknown` observation; only the shell's idle prompt, or an agent
      // claiming the terminal, stops it.
      if (model.state === 'terminal-running') {
        if (!runningSinceRef.current.has(agent.visualId ?? agent.id))
          runningSinceRef.current.set(agent.visualId ?? agent.id, nowMs);
      } else if (agent.agent || agent.session?.activity?.kind !== 'unknown') {
        runningSinceRef.current.delete(agent.visualId ?? agent.id);
      }
    }
    modelsRef.current.at = 0;
    refreshModels(performance.now());
    driverRef.current?.post({ type: 'updateAgents', agents: agentSpecs() });
  }, [agents, swarm]);

  const localPoint = (event: { clientX: number; clientY: number }): { x: number; y: number } | undefined => {
    const bounds = containerRef.current?.getBoundingClientRect();
    if (!bounds) return undefined;
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  };

  /** The topmost body under the point, in draw order. */
  const hitTest = (x: number, y: number): RenderBody | undefined => {
    const order = orderRef.current;
    for (let index = order.length - 1; index >= 0; index -= 1) {
      const candidate = order[index]!;
      if (Math.hypot(x - candidate.x, y - candidate.y) <= candidate.radius * candidate.scale) return candidate;
    }
    return undefined;
  };

  const agentById = (id: string): MonitorAgent | undefined =>
    agentsRef.current.find((agent) => (agent.visualId ?? agent.id) === id);

  const endDrag = (): void => {
    const drag = dragRef.current;
    if (!drag) return;
    driverRef.current?.post({ type: 'dragEnd', id: drag.id });
    dragRef.current = undefined;
  };

  const updateHover = (id: string | undefined, x: number, y: number): void => {
    if (id === hoveredIdRef.current) {
      if (id) setHovered((current) => (current ? { ...current, x, y } : current));
      return;
    }
    hoveredIdRef.current = id;
    const agent = id ? agentById(id) : undefined;
    setHovered(agent ? { agent, x, y } : undefined);
    setCursor(agent ? 'grab' : 'default');
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLElement>): void => {
    watchStill(undefined);
    // A bloom held open takes the press: a primary click commits, any other button puts it away.
    if (bloom.pointerDown(event, localPoint(event))) return;
    if (event.button !== 0) return;
    const point = localPoint(event);
    if (!point) return;
    cancelHold();
    const hit = hitTest(point.x, point.y);
    if (hit) {
      endDrag();
      driverRef.current?.post({ type: 'dragStart', id: hit.model.id, point });
      dragRef.current = {
        id: hit.model.id,
        pointerId: event.pointerId,
        startX: point.x,
        startY: point.y,
        dragged: false,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      setCursor('grabbing');
      setHovered(undefined);
      event.preventDefault();
      return;
    }
    // Empty field: hold to create a terminal here.
    const hold: Hold = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      x: point.x,
      y: point.y,
      startedAt: performance.now(),
    };
    holdRef.current = hold;
    event.currentTarget.setPointerCapture(event.pointerId);
    holdTimerRef.current = window.setTimeout(() => {
      if (holdRef.current !== hold) return;
      holdTimerRef.current = undefined;
      holdRef.current = undefined;
      // With a spawn menu the hold blooms and keeps the pointer; without one it creates here, now.
      bloomRef.current.held({ x: hold.x, y: hold.y }, hold.pointerId);
    }, LONG_PRESS_DURATION_MS);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLElement>): void => {
    const point = localPoint(event);
    if (!point) return;
    const drag = dragRef.current;
    if (drag && drag.pointerId === event.pointerId) {
      if (Math.hypot(point.x - drag.startX, point.y - drag.startY) >= 5) drag.dragged = true;
      driverRef.current?.post({ type: 'dragMove', id: drag.id, point });
      return;
    }
    if (bloom.pointerMove(event, point)) return;
    const hold = holdRef.current;
    if (hold && hold.pointerId === event.pointerId) {
      if (Math.hypot(event.clientX - hold.clientX, event.clientY - hold.clientY) > LONG_PRESS_MOVE_TOLERANCE)
        cancelHold();
      return;
    }
    const hit = hitTest(point.x, point.y);
    updateHover(hit?.model.id, point.x, point.y);
    watchStill(hit ? undefined : point);
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLElement>): void => {
    const point = localPoint(event);
    // A hold's bloom commits where it is let go.
    if (bloom.pointerUp(event, point)) {
      if (event.currentTarget.hasPointerCapture(event.pointerId))
        event.currentTarget.releasePointerCapture(event.pointerId);
      return;
    }
    const drag = dragRef.current;
    if (drag && drag.pointerId === event.pointerId) {
      if (point) driverRef.current?.post({ type: 'dragMove', id: drag.id, point });
      const wasDragged = drag.dragged;
      const id = drag.id;
      endDrag();
      if (!wasDragged) {
        const agent = agentById(id);
        if (agent) actions.select(agent);
        driverRef.current?.post({ type: 'nudge', id });
      }
      setCursor(point && hitTest(point.x, point.y) ? 'grab' : 'default');
    }
    if (holdRef.current?.pointerId === event.pointerId) cancelHold();
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const onPointerCancel = (event: ReactPointerEvent<HTMLElement>): void => {
    bloom.pointerCancel(event);
    if (dragRef.current?.pointerId === event.pointerId) endDrag();
    if (holdRef.current?.pointerId === event.pointerId) cancelHold();
    setCursor('default');
  };

  const onPointerLeave = (): void => {
    watchStill(undefined);
    if (dragRef.current) return;
    updateHover(undefined, 0, 0);
  };

  /** A secondary click on empty ground holds a bloom open (SB-D12); on an open one, puts it away. */
  const onContextMenu = (event: ReactMouseEvent<HTMLElement>): void => {
    if (!spawnMenu) return;
    watchStill(undefined);
    const point = localPoint(event);
    const blocked = !point || !!dragRef.current || !!hitTest(point.x, point.y);
    if (!blocked && !bloom.isOpen()) cancelHold();
    bloom.contextMenu(event, point, blocked);
  };

  const modelFor = (agent: MonitorAgent): SwarmBubbleModel => {
    const known = modelsRef.current.byId.get(agent.visualId ?? agent.id);
    if (known) return known;
    const profile = terminalProfile(agent);
    return bubbleModel({
      agent,
      parameters: swarm,
      nowMs: Date.now(),
      unread: agent.unread === true,
      workingShare: workingShares(agentsRef.current).get(agent.id) ?? 0,
      ...(profile ? { profile } : {}),
    });
  };

  return (
    <section
      ref={containerRef}
      className={blooming ? 'vf-monitor-swarm is-blooming' : 'vf-monitor-swarm'}
      style={{ cursor }}
      aria-label="Running agent status field"
      data-swarm-renderer={rendererState}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={(event) => bloom.pointerCancel(event)}
      onPointerLeave={onPointerLeave}
      onContextMenu={spawnMenu ? onContextMenu : undefined}
    >
      <canvas ref={canvasRef} className="vf-monitor-swarm-canvas" aria-hidden="true" />
      {failure ? (
        <div className="vf-monitor-empty" role="status" data-swarm-renderer="unavailable">
          <span>WEBGPU UNAVAILABLE</span>
          <small>{failure}</small>
        </div>
      ) : agents.length === 0 ? (
        <div className="vf-monitor-empty">
          <span>NO ACTIVE AGENTS</span>
          <small>Launch an agent from a terminal pane.</small>
          {spawnMenu ? <small>Hold empty ground for a terminal.</small> : null}
        </div>
      ) : null}
      {spawnMenu ? (
        <SpawnBloom
          state={bloom.state}
          reduced={bloom.reduced}
          menuRef={bloom.menuRef}
          onKeyDown={bloom.onKeyDown}
          onBlur={bloom.onBlur}
        />
      ) : null}
      {signifier && !blooming ? (
        <span className="vf-monitor-swarm-signifier" style={{ left: signifier.x, top: signifier.y }} aria-hidden="true">
          Hold for a terminal
        </span>
      ) : null}
      {newTerminalFocus && !blooming ? (
        // The keys door has the keyboard: say so where its bloom will open.
        <span className="vf-monitor-swarm-new-echo" aria-hidden="true">
          ＋ New terminal…
        </span>
      ) : null}
      {hovered ? (
        <span
          className="vf-monitor-swarm-tooltip"
          style={{ left: hovered.x, top: hovered.y }}
          role="tooltip"
          aria-hidden="true"
        >
          {modelFor(hovered.agent).title}
        </span>
      ) : null}
      {/* Every body, reachable without a pointer. Focus draws a ring on the canvas. */}
      <ul className="vf-monitor-swarm-list" aria-label="Agents">
        {spawnMenu ? (
          // The keys door (SB §2.11): a bloom at the field's middle with the keyboard in it.
          <li>
            <button
              ref={newTerminalRef}
              type="button"
              aria-haspopup="menu"
              aria-expanded={blooming && bloom.state?.mode === 'keys'}
              data-swarm-new-terminal=""
              onFocus={(event) => setNewTerminalFocus(focusVisible(event.currentTarget))}
              onBlur={() => setNewTerminalFocus(false)}
              onClick={() => bloom.openKeys(newTerminalRef.current)}
            >
              ＋ New terminal…
            </button>
          </li>
        ) : null}
        {agents.map((agent) => {
          const model = modelFor(agent);
          return (
            <li key={agent.visualId ?? agent.id}>
              <button
                type="button"
                aria-label={model.ariaLabel}
                aria-current={agent.active ? 'true' : undefined}
                data-agent-bubble-id={agent.visualId ?? agent.id}
                data-agent-bubble-status={agent.status}
                data-agent-bubble-visual={model.state}
                data-agent-bubble-source={agent.remote ? 'remote' : agent.agent ? 'agent' : 'terminal'}
                data-agent-bubble-receded={agent.receded === true ? 'true' : undefined}
                onFocus={() => {
                  focusedIdRef.current = agent.visualId ?? agent.id;
                }}
                onBlur={() => {
                  if (focusedIdRef.current === (agent.visualId ?? agent.id)) focusedIdRef.current = undefined;
                }}
                onClick={() => actions.select(agent)}
              >
                {model.title}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

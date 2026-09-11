import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import Matter from 'matter-js';
import { monitorChromeElements } from '../../monitor/chrome.js';
import type { AgentMonitorProps, MonitorAgent } from '../../monitor/types.js';
import { bubbleModel, workingShares, type SwarmBubbleModel } from './bubble-model.js';
import { resolveCssColor, type Rgba } from './gpu/color.js';
import { createSwarmRenderer, type RenderBody, type SwarmRenderer, type SwarmTheme } from './gpu/swarm-renderer.js';
import { normalizeSwarmParameters, type SwarmParameters } from './swarm-parameters.js';
import { resolveSwarmTheme } from './swarm-theme.js';
import './swarm.css';

// The swarm — the matter.js agent field, drawn by WebGPU (RFC 005).
//
// Status is size and treatment, never a decorative hue: the per-bubble color is
// a §2.6 ORGANIZATIONAL accent (stable per session, groups and labels), and the
// state reading comes from §2.5 through the palette the stage hands down.
//
// This file owns physics, placement, pointer gestures, field-level creation,
// and the DOM that is not drawing: a hidden button per body for keyboard and
// assistive access, and the hover tooltip. `bubble-model.ts` owns what a body
// says; `gpu/swarm-renderer.ts` owns how it is painted.

interface PhysicsBody {
  body: Matter.Body;
  /** The physics radius, which jumps; the visual one springs after it. */
  currentRadius: number;
  targetRadius: number;
  visualRadius: number;
  visualVelocity: number;
  spawnedAt: number;
  seed: number;
  /** Arrival order, for a stable draw order within one status. */
  arrival: number;
  dragConstraint?: Matter.Constraint;
  /** When this terminal's foreground job was first seen. */
  runningSince?: number;
}

interface ChromeObstacle {
  element: HTMLElement;
  body: Matter.Body;
  width: number;
  height: number;
}

interface PhysicsWorld {
  engine: Matter.Engine;
  walls: [Matter.Body, Matter.Body, Matter.Body, Matter.Body];
  obstacles: readonly ChromeObstacle[];
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

const PHYSICAL_GAP = 4;
const CHROME_OBSTACLE_PADDING = 7;
const DRAG_STIFFNESS = 0.2;
const WALL_THICKNESS = 5000;
const SPAWN_CLEARANCE = 12;
const SPAWN_CANDIDATES = 40;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const LONG_PRESS_DURATION_MS = 520;
const LONG_PRESS_MOVE_TOLERANCE = 8;
const SPAWN_DURATION_MS = 720;
/** Critically damped: about 90% of a size change lands within 300ms. */
const RADIUS_SPRING_OMEGA = 16;
const GRID_PITCH = 24;
/** The burn graph scrolls: models are refreshed on this cadence even when nothing else changed. */
const MODEL_REFRESH_MS = 1000;
const STATUS_RANK: Record<SwarmBubbleModel['appearance'], number> = { idle: 0, working: 1, blocked: 2 };

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function findSpawnPosition(
  width: number,
  height: number,
  radius: number,
  existingBodies: Iterable<PhysicsBody>,
): Matter.Vector {
  const bodies = [...existingBodies];
  const center = { x: width / 2, y: height / 2 };
  if (bodies.length === 0) return center;

  const collisionRadius = radius + PHYSICAL_GAP;
  const horizontalReach = Math.max(0, Math.min(width * 0.28, width / 2 - collisionRadius - SPAWN_CLEARANCE));
  const verticalReach = Math.max(0, Math.min(height * 0.28, height / 2 - collisionRadius - SPAWN_CLEARANCE));
  const phase = Math.random() * Math.PI * 2;
  let bestPosition = center;
  let bestClearance = Number.NEGATIVE_INFINITY;

  for (let index = 0; index < SPAWN_CANDIDATES; index += 1) {
    const progress = index === 0 ? 0 : Math.sqrt(index / (SPAWN_CANDIDATES - 1));
    const angle = phase + index * GOLDEN_ANGLE;
    const candidate = {
      x: center.x + Math.cos(angle) * horizontalReach * progress,
      y: center.y + Math.sin(angle) * verticalReach * progress,
    };
    let clearance = Number.POSITIVE_INFINITY;
    for (const wrapper of bodies) {
      const distance = Math.hypot(candidate.x - wrapper.body.position.x, candidate.y - wrapper.body.position.y);
      clearance = Math.min(
        clearance,
        distance - (collisionRadius + wrapper.currentRadius + PHYSICAL_GAP + SPAWN_CLEARANCE),
      );
    }
    if (clearance > bestClearance) {
      bestPosition = candidate;
      bestClearance = clearance;
    }
    if (clearance >= 0) return candidate;
  }

  return bestPosition;
}

function clampSpawnPosition(width: number, height: number, radius: number, position: Matter.Vector): Matter.Vector {
  const margin = radius + PHYSICAL_GAP;
  return {
    x: Math.min(Math.max(position.x, margin), Math.max(margin, width - margin)),
    y: Math.min(Math.max(position.y, margin), Math.max(margin, height - margin)),
  };
}

/** The arrival curve the DOM used to replay: 0 → 1.2 → 0.96 → 1.035 → 1 over 720ms. */
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

export function AgentSwarm({ agents, parameters, actions, palette }: AgentMonitorProps) {
  const swarm = useMemo<SwarmParameters>(() => normalizeSwarmParameters(parameters), [parameters]);
  const containerRef = useRef<HTMLElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bodiesRef = useRef(new Map<string, PhysicsBody>());
  const worldRef = useRef<PhysicsWorld | undefined>(undefined);
  const rendererRef = useRef<SwarmRenderer | undefined>(undefined);
  const parametersRef = useRef(swarm);
  const agentsRef = useRef<readonly MonitorAgent[]>(agents);
  const modelsRef = useRef<{ byId: Map<string, SwarmBubbleModel>; at: number; agents: readonly MonitorAgent[] }>({
    byId: new Map(),
    at: 0,
    agents: [],
  });
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

  useEffect(() => {
    agentsRef.current = agents;
  }, [agents]);

  useEffect(() => {
    parametersRef.current = swarm;
    modelsRef.current.at = 0;
    const world = worldRef.current;
    if (!world) return;
    for (const wrapper of bodiesRef.current.values()) {
      wrapper.body.restitution = swarm.restitution;
      wrapper.body.frictionAir = swarm.frictionAir;
    }
    for (const wall of world.walls) wall.restitution = swarm.restitution;
    for (const obstacle of world.obstacles) obstacle.body.restitution = swarm.restitution;
  }, [swarm]);

  // The palette arrives as CSS; the GPU wants numbers. Resolved here, once per
  // theme, in the container's own cascade so any syntax the tokens use resolves.
  useEffect(() => {
    themeRef.current = resolveSwarmTheme(palette.swarm, containerRef.current ?? undefined);
    colourCacheRef.current.clear();
  }, [palette]);

  const cancelHold = (): void => {
    if (holdTimerRef.current !== undefined) window.clearTimeout(holdTimerRef.current);
    holdTimerRef.current = undefined;
    holdRef.current = undefined;
  };

  useEffect(
    () => () => {
      if (holdTimerRef.current !== undefined) window.clearTimeout(holdTimerRef.current);
    },
    [],
  );

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
        return;
      }
      current = result.renderer;
      rendererRef.current = current;
      setFailure(undefined);
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

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let width = container.clientWidth;
    let height = container.clientHeight;
    const engine = Matter.Engine.create();
    engine.gravity.x = 0;
    engine.gravity.y = 0;
    const wallOptions = { isStatic: true, restitution: parametersRef.current.restitution };
    const walls: [Matter.Body, Matter.Body, Matter.Body, Matter.Body] = [
      Matter.Bodies.rectangle(width / 2, height + WALL_THICKNESS / 2, 10000, WALL_THICKNESS, wallOptions),
      Matter.Bodies.rectangle(width / 2, -WALL_THICKNESS / 2, 10000, WALL_THICKNESS, wallOptions),
      Matter.Bodies.rectangle(-WALL_THICKNESS / 2, height / 2, WALL_THICKNESS, 10000, wallOptions),
      Matter.Bodies.rectangle(width + WALL_THICKNESS / 2, height / 2, WALL_THICKNESS, 10000, wallOptions),
    ];
    // Shell chrome is solid: bubbles settle around the usage panel rather than
    // drifting under it. Which elements those are is the shell's business.
    const obstacles: ChromeObstacle[] = monitorChromeElements(container).map((element) => {
      const rect = element.getBoundingClientRect();
      const obstacleWidth = Math.max(1, rect.width + CHROME_OBSTACLE_PADDING * 2);
      const obstacleHeight = Math.max(1, rect.height + CHROME_OBSTACLE_PADDING * 2);
      return {
        element,
        body: Matter.Bodies.rectangle(0, 0, obstacleWidth, obstacleHeight, wallOptions),
        width: obstacleWidth,
        height: obstacleHeight,
      };
    });
    Matter.Composite.add(engine.world, [...walls, ...obstacles.map((obstacle) => obstacle.body)]);
    worldRef.current = { engine, walls, obstacles };
    const root = container.closest<HTMLElement>('.vf-godview');

    const updateBounds = (): void => {
      width = container.clientWidth;
      height = container.clientHeight;
      rendererRef.current?.resize(width, height, window.devicePixelRatio || 1);
      Matter.Body.setPosition(walls[0], { x: width / 2, y: height + WALL_THICKNESS / 2 });
      Matter.Body.setPosition(walls[1], { x: width / 2, y: -WALL_THICKNESS / 2 });
      Matter.Body.setPosition(walls[2], { x: -WALL_THICKNESS / 2, y: height / 2 });
      Matter.Body.setPosition(walls[3], { x: width + WALL_THICKNESS / 2, y: height / 2 });
      if (obstacles.length === 0) return;
      const containerRect = container.getBoundingClientRect();
      for (const obstacle of obstacles) {
        const rect = obstacle.element.getBoundingClientRect();
        const nextWidth = Math.max(1, rect.width + CHROME_OBSTACLE_PADDING * 2);
        const nextHeight = Math.max(1, rect.height + CHROME_OBSTACLE_PADDING * 2);
        Matter.Body.scale(obstacle.body, nextWidth / obstacle.width, nextHeight / obstacle.height);
        obstacle.width = nextWidth;
        obstacle.height = nextHeight;
        Matter.Body.setPosition(obstacle.body, {
          x: rect.left - containerRect.left + rect.width / 2,
          y: rect.top - containerRect.top + rect.height / 2,
        });
      }
    };

    const resizeObserver = new ResizeObserver(updateBounds);
    resizeObserver.observe(container);
    for (const obstacle of obstacles) resizeObserver.observe(obstacle.element);
    updateBounds();

    const accentOf = (value: string): Rgba => {
      const cached = colourCacheRef.current.get(value);
      if (cached) return cached;
      const resolved = resolveCssColor(value, container);
      colourCacheRef.current.set(value, resolved);
      return resolved;
    };

    const refreshModels = (now: number): void => {
      const models = modelsRef.current;
      const nowMs = Date.now();
      const byId = new Map<string, SwarmBubbleModel>();
      const shares = workingShares(agentsRef.current);
      for (const agent of agentsRef.current) {
        const wrapper = bodiesRef.current.get(agent.id);
        byId.set(
          agent.id,
          bubbleModel({
            agent,
            parameters: parametersRef.current,
            nowMs,
            unread: agent.unread === true,
            workingShare: shares.get(agent.id) ?? 0,
            ...(wrapper?.runningSince === undefined ? {} : { runningSinceMs: wrapper.runningSince }),
          }),
        );
      }
      models.byId = byId;
      models.at = now;
      models.agents = agentsRef.current;
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

      for (const wrapper of bodiesRef.current.values()) {
        const { body } = wrapper;
        if (!wrapper.dragConstraint) {
          Matter.Body.applyForce(body, body.position, {
            x: (width / 2 - body.position.x) * currentParameters.gravityPull,
            y: (height / 2 - body.position.y) * currentParameters.gravityPull,
          });
        }
        if (Math.abs(wrapper.targetRadius - wrapper.currentRadius) > 0.5) {
          const scale = (wrapper.targetRadius + PHYSICAL_GAP) / (wrapper.currentRadius + PHYSICAL_GAP);
          Matter.Body.scale(body, scale, scale);
          wrapper.currentRadius = wrapper.targetRadius;
        }
        // The visual radius follows on a critically damped spring.
        const dt = delta / 1000;
        const displacement = wrapper.visualRadius - wrapper.targetRadius;
        wrapper.visualVelocity +=
          (-RADIUS_SPRING_OMEGA * RADIUS_SPRING_OMEGA * displacement -
            2 * RADIUS_SPRING_OMEGA * wrapper.visualVelocity) *
          dt;
        wrapper.visualRadius += wrapper.visualVelocity * dt;
        if (Math.abs(wrapper.visualRadius - wrapper.targetRadius) < 0.01 && Math.abs(wrapper.visualVelocity) < 0.01) {
          wrapper.visualRadius = wrapper.targetRadius;
          wrapper.visualVelocity = 0;
        }
      }

      Matter.Engine.update(engine, delta);

      const renderer = rendererRef.current;
      const theme = themeRef.current;
      if (!renderer || !theme) return;
      const motion = !prefersReducedMotion() && root?.getAttribute('data-godview-animations') !== 'off';
      const focused = focusedIdRef.current;
      const bodies: RenderBody[] = [];
      for (const [id, wrapper] of bodiesRef.current) {
        const model = models.byId.get(id);
        if (!model) continue;
        const landing = motion ? arrival(time - wrapper.spawnedAt) : { scale: 1, opacity: 1 };
        bodies.push({
          model,
          x: wrapper.body.position.x,
          y: wrapper.body.position.y,
          radius: wrapper.visualRadius,
          scale: landing.scale,
          opacity: landing.opacity,
          focus: focused === id,
          seed: wrapper.seed,
          accent: accentOf(model.accent),
          ...(model.linked ? { link: accentOf(model.linked) } : {}),
        });
      }
      bodies.sort((left, right) => {
        const rank = STATUS_RANK[left.model.appearance] - STATUS_RANK[right.model.appearance];
        if (rank !== 0) return rank;
        return (
          (bodiesRef.current.get(left.model.id)?.arrival ?? 0) - (bodiesRef.current.get(right.model.id)?.arrival ?? 0)
        );
      });
      orderRef.current = bodies;

      const hold = holdRef.current;
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
        theme,
        bodies,
        ...(hold ? { hold: { x: hold.x, y: hold.y, progress: (time - hold.startedAt) / LONG_PRESS_DURATION_MS } } : {}),
      });
    };
    frame = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      bodiesRef.current.clear();
      orderRef.current = [];
      Matter.Engine.clear(engine);
      Matter.Composite.clear(engine.world, false, true);
      worldRef.current = undefined;
    };
  }, []);

  useEffect(() => {
    const world = worldRef.current;
    const container = containerRef.current;
    if (!world || !container) return;
    const width = Math.max(container.clientWidth, 320);
    const height = Math.max(container.clientHeight, 180);
    const ids = new Set(agents.map((agent) => agent.id));
    for (const [id, wrapper] of bodiesRef.current) {
      if (ids.has(id)) continue;
      if (wrapper.dragConstraint) Matter.Composite.remove(world.engine.world, wrapper.dragConstraint);
      Matter.Composite.remove(world.engine.world, wrapper.body);
      bodiesRef.current.delete(id);
      if (dragRef.current?.id === id) dragRef.current = undefined;
    }
    const nowMs = Date.now();
    const shares = workingShares(agents);
    for (const agent of agents) {
      const model = bubbleModel({
        agent,
        parameters: swarm,
        nowMs,
        unread: agent.unread === true,
        workingShare: shares.get(agent.id) ?? 0,
      });
      const targetRadius = model.radius;
      const existing = bodiesRef.current.get(agent.id);
      if (existing) {
        existing.targetRadius = targetRadius;
        // The clock starts at the first sight of a foreground job and survives
        // an `unknown` observation; only the shell's idle prompt, or an agent
        // claiming the terminal, stops it.
        if (model.state === 'terminal-running') existing.runningSince ??= nowMs;
        else if (agent.agent || agent.session.activity?.kind !== 'unknown') delete existing.runningSince;
        continue;
      }
      const spawnPosition = agent.spawnHint
        ? clampSpawnPosition(width, height, targetRadius, agent.spawnHint)
        : findSpawnPosition(width, height, targetRadius, bodiesRef.current.values());
      const body = Matter.Bodies.circle(spawnPosition.x, spawnPosition.y, targetRadius + PHYSICAL_GAP, {
        restitution: swarm.restitution,
        frictionAir: swarm.frictionAir,
        friction: 0.1,
      });
      arrivalCounterRef.current += 1;
      bodiesRef.current.set(agent.id, {
        body,
        currentRadius: targetRadius,
        targetRadius,
        visualRadius: targetRadius,
        visualVelocity: 0,
        spawnedAt: performance.now(),
        seed: Math.random() * Math.PI * 2,
        arrival: arrivalCounterRef.current,
        ...(model.state === 'terminal-running' ? { runningSince: nowMs } : {}),
      });
      Matter.Composite.add(world.engine.world, body);
    }
    modelsRef.current.at = 0;
  }, [agents, swarm]);

  const localPoint = (event: ReactPointerEvent<HTMLElement>): { x: number; y: number } | undefined => {
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

  const agentById = (id: string): MonitorAgent | undefined => agentsRef.current.find((agent) => agent.id === id);

  const endDrag = (): void => {
    const drag = dragRef.current;
    const world = worldRef.current;
    if (!drag) return;
    const wrapper = bodiesRef.current.get(drag.id);
    if (world && wrapper?.dragConstraint) Matter.Composite.remove(world.engine.world, wrapper.dragConstraint);
    if (wrapper) delete wrapper.dragConstraint;
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
    if (event.button !== 0) return;
    const point = localPoint(event);
    const world = worldRef.current;
    if (!point || !world) return;
    cancelHold();
    const hit = hitTest(point.x, point.y);
    if (hit) {
      const wrapper = bodiesRef.current.get(hit.model.id);
      if (!wrapper) return;
      endDrag();
      wrapper.dragConstraint = Matter.Constraint.create({
        pointA: { x: point.x, y: point.y },
        bodyB: wrapper.body,
        pointB: { x: point.x - wrapper.body.position.x, y: point.y - wrapper.body.position.y },
        stiffness: DRAG_STIFFNESS,
        render: { visible: false },
      });
      Matter.Composite.add(world.engine.world, wrapper.dragConstraint);
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
      void actions.createAt({ x: hold.x, y: hold.y });
    }, LONG_PRESS_DURATION_MS);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLElement>): void => {
    const point = localPoint(event);
    if (!point) return;
    const drag = dragRef.current;
    if (drag && drag.pointerId === event.pointerId) {
      const wrapper = bodiesRef.current.get(drag.id);
      if (!wrapper?.dragConstraint) return;
      if (Math.hypot(point.x - drag.startX, point.y - drag.startY) >= 5) drag.dragged = true;
      wrapper.dragConstraint.pointA.x = point.x;
      wrapper.dragConstraint.pointA.y = point.y;
      return;
    }
    const hold = holdRef.current;
    if (hold && hold.pointerId === event.pointerId) {
      if (Math.hypot(event.clientX - hold.clientX, event.clientY - hold.clientY) > LONG_PRESS_MOVE_TOLERANCE)
        cancelHold();
      return;
    }
    updateHover(hitTest(point.x, point.y)?.model.id, point.x, point.y);
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLElement>): void => {
    const point = localPoint(event);
    const drag = dragRef.current;
    if (drag && drag.pointerId === event.pointerId) {
      const wrapper = bodiesRef.current.get(drag.id);
      if (point && wrapper?.dragConstraint) {
        wrapper.dragConstraint.pointA.x = point.x;
        wrapper.dragConstraint.pointA.y = point.y;
      }
      const wasDragged = drag.dragged;
      endDrag();
      if (!wasDragged) {
        const agent = agentById(drag.id);
        if (agent) actions.select(agent);
        if (wrapper) {
          Matter.Body.applyForce(wrapper.body, wrapper.body.position, {
            x: (Math.random() - 0.5) * 0.003,
            y: (Math.random() - 0.5) * 0.003,
          });
        }
      }
      setCursor(point && hitTest(point.x, point.y) ? 'grab' : 'default');
    }
    if (holdRef.current?.pointerId === event.pointerId) cancelHold();
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const onPointerCancel = (event: ReactPointerEvent<HTMLElement>): void => {
    if (dragRef.current?.pointerId === event.pointerId) endDrag();
    if (holdRef.current?.pointerId === event.pointerId) cancelHold();
    setCursor('default');
  };

  const onPointerLeave = (): void => {
    if (dragRef.current) return;
    updateHover(undefined, 0, 0);
  };

  const modelFor = (agent: MonitorAgent): SwarmBubbleModel =>
    modelsRef.current.byId.get(agent.id) ??
    bubbleModel({
      agent,
      parameters: swarm,
      nowMs: Date.now(),
      unread: agent.unread === true,
      workingShare: workingShares(agentsRef.current).get(agent.id) ?? 0,
    });

  return (
    <section
      ref={containerRef}
      className="vf-monitor-swarm"
      style={{ cursor }}
      aria-label="Running agent status field"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onPointerLeave={onPointerLeave}
    >
      <canvas ref={canvasRef} className="vf-monitor-swarm-canvas" aria-hidden="true" />
      {failure ? (
        <div className="vf-monitor-empty" role="status">
          <span>WEBGPU UNAVAILABLE</span>
          <small>{failure}</small>
        </div>
      ) : agents.length === 0 ? (
        <div className="vf-monitor-empty">
          <span>NO ACTIVE AGENTS</span>
          <small>Launch an agent from a terminal pane.</small>
        </div>
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
        {agents.map((agent) => {
          const model = modelFor(agent);
          return (
            <li key={agent.id}>
              <button
                type="button"
                aria-label={model.ariaLabel}
                aria-current={agent.active ? 'true' : undefined}
                data-agent-bubble-status={agent.status}
                data-agent-bubble-visual={model.state}
                onFocus={() => {
                  focusedIdRef.current = agent.id;
                }}
                onBlur={() => {
                  if (focusedIdRef.current === agent.id) focusedIdRef.current = undefined;
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

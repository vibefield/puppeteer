import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement } from 'react';
import type { AgentStatus, AgentView, MonitorPalette } from '@vibefield/puppeteer-view-sdk';
import type { ReactMonitorViewProps } from '@vibefield/puppeteer-view-sdk/react';
import {
  approachRecede,
  createMotionLoop,
  detailLine,
  everyReceded,
  modelWord,
  projectName,
  recedeTarget,
  sizeCanvas,
  themeMotion,
  watchDevicePixelRatio,
  type MotionLoop,
} from '@vibefield/puppeteer-view-sdk/toolkit';
import { normalizeRainParameters, type RainParameters } from './rain-parameters.js';
import { rainDataString, rainTailLength, reconcileRainColumns, type RainDrop } from './rain-streams.js';

// The rain — the reference app's matrix stream, ported from vibe-field's
// views/rain/RainView.tsx and restyled onto the tokens.
//
// The reference hardcodes its palette (a green tail, a yellow stuck state, a
// magenta hover). Every one of those is read from the live tokens the stage
// hands down: §2.5's green/orange for working/blocked, §2.4's ramp for idle, and
// the mounted-session tail is the agent's own §2.6 organizational accent — which
// is precisely what an organizational accent is for ("this session", never a
// state). Hover deliberately gains NO color of its own: it brightens the head
// and doubles the glow, because §2.5 hands out no hue for "the pointer is here"
// and inventing one would put a fourth meaning on a three-meaning scale.
//
// On the SDK (MV-4) it reads only its input. Its loop is the toolkit's, which
// asks for no frame while the host's animations are off or motion is reduced
// (MV-W4); the field then stands still, drawn once per change, on one still
// frame. With the stage out of sight (`theme.hidden`) nothing is drawn at all
// until it is shown.

interface Geometry {
  columns: number;
  rows: number;
  cell: number;
  width: number;
  height: number;
  /** The display's ratio at that size: the context's transform. */
  ratio: number;
}

const matrixGlyph = (): string => String.fromCharCode(0x30a0 + Math.random() * 96);

/** The three status readings, resolved from the live tokens. Speeds are the
 * reference's: blocked crawls (stuck, and impossible to miss in a field where
 * everything else moves), idle drifts, working runs at its own drop speed. */
function statusPresentation(
  palette: MonitorPalette,
): Record<AgentStatus, { head: string; tail: string; speed?: number }> {
  return {
    working: { head: palette.rain.status.working.head, tail: palette.rain.status.working.tailRgb },
    blocked: { head: palette.rain.status.blocked.head, tail: palette.rain.status.blocked.tailRgb, speed: 0.02 },
    idle: { head: palette.rain.status.idle.head, tail: palette.rain.status.idle.tailRgb, speed: 0.1 },
  };
}

function agentName(agent: AgentView): string {
  return agent.kind === 'agent' ? modelWord(agent) : 'terminal';
}

export function RainView({ input, commands }: ReactMonitorViewProps): ReactElement {
  const { theme } = input;
  const agents = input.model.agents;
  const palette = theme.tokens;
  const rain = useMemo<RainParameters>(() => normalizeRainParameters(input.parameters), [input.parameters]);
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const agentsRef = useRef<ReadonlyMap<string, AgentView>>(new Map());
  const orderRef = useRef<readonly string[]>([]);
  const parametersRef = useRef(rain);
  const paletteRef = useRef(palette);
  const dropsRef = useRef(new Map<number, RainDrop>());
  const geometryRef = useRef<Geometry>({ columns: 0, rows: 0, cell: 14, width: 0, height: 0, ratio: 1 });
  const hoveredRef = useRef<string | undefined>(undefined);
  const tooltipRef = useRef<HTMLElement>(null);
  const pointerRef = useRef({ x: 0, y: 0 });
  const motionRef = useRef(themeMotion(theme));
  const loopRef = useRef<MotionLoop | null>(null);
  /** Draws a resized field at once where it stands, or, out of sight, owes it to the loop. Set by the loop's effect. */
  const stillRef = useRef<(() => void) | null>(null);
  /** The row under the pointer, by id: the tooltip reads the row as the input has it now. */
  const [hoveredId, setHoveredId] = useState<string>();

  /** Deals the columns to the agents in the field as last measured. It never measures and never draws. */
  const reconcile = useCallback((): void => {
    const { columns, rows } = geometryRef.current;
    dropsRef.current = reconcileRainColumns({
      agents: orderRef.current,
      columns,
      previous: dropsRef.current,
      createDrop: (agentId) => ({ agentId, y: Math.random() * rows, speed: 0.3 + Math.random() * 0.4 }),
    });
  }, []);

  /**
   * Fits the canvas to the stage: at mount, on a resize, a font change and a change of the display's ratio, never on
   * a publish. The backing store is written only when its size changes, and a write clears it, so the field is then
   * drawn at once where it stands, whether or not the loop runs: a cleared canvas is never shown. A zoom can move the
   * stage's size and the ratio together and leave the backing store as it was (1000 CSS px at 2× and 800 at 2.5× are
   * both 2000 device pixels): nothing is cleared, but the columns and the transform are new, so that field is drawn
   * at once too, as a held-still one has no next frame. Out of sight nothing is shown: the draw is owed to the loop,
   * and made once the stage is shown.
   */
  const measure = useCallback((): void => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const sizing = sizeCanvas(canvas, container.clientWidth, container.clientHeight, { pixels: 'floor' });
    const cell = parametersRef.current.fontSize;
    const previous = geometryRef.current;
    geometryRef.current = {
      columns: Math.max(1, Math.floor(sizing.width / cell)),
      rows: Math.max(1, Math.floor(sizing.height / cell)),
      cell,
      width: sizing.width,
      height: sizing.height,
      ratio: sizing.ratio,
    };
    reconcile();
    // The field is drawn in CSS pixels at the display's ratio. A resize resets the context's transform and a new ratio
    // (a zoom can leave the backing size as it was) needs a new one; setting the same one again changes nothing drawn.
    canvas.getContext('2d')?.setTransform(sizing.ratio, 0, 0, sizing.ratio, 0, 0);
    // Last: the still draw reads the geometry and the columns just set. A font change alone draws nothing here: the
    // loop's next frame does, or, stopped, the still effect.
    const moved =
      sizing.width !== previous.width || sizing.height !== previous.height || sizing.ratio !== previous.ratio;
    if (sizing.resized || moved) stillRef.current?.();
  }, [reconcile]);

  // A publish deals the columns and nothing else: it never measures, so nothing is cleared. A running loop draws it
  // on its next frame; a stopped one is drawn by the still effect below.
  useEffect(() => {
    agentsRef.current = new Map(agents.map((agent) => [agent.id, agent] as const));
    orderRef.current = agents.map((agent) => agent.id);
    reconcile();
  }, [agents, reconcile]);

  // A new font re-measures the cells; with the stage's size unchanged nothing is cleared, and the change is drawn by
  // the loop's next frame or, stopped, by the still effect (its deps include the parameters).
  useEffect(() => {
    const previousFont = parametersRef.current.fontSize;
    parametersRef.current = rain;
    loopRef.current?.update({ fps: rain.refreshRate });
    if (previousFont !== rain.fontSize) measure();
  }, [rain, measure]);

  // The draw loop reads the palette through a ref, so a theme change repaints
  // the next frame without tearing the loop down and re-randomizing the field.
  useEffect(() => {
    paletteRef.current = palette;
  }, [palette]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const context = canvas.getContext('2d');
    if (!context) return;

    /** Each column's recede weight as last drawn, stepped toward its target per draw (the toolkit's steps). */
    const recedes = new Map<string, number>();

    // A still draw (`elapsed` undefined) shows the field where it stands: no drop falls, no glyph scrambles, and a
    // receded column sits at its weight; nothing in it moves until the loop runs again.
    const draw = (context2d: CanvasRenderingContext2D, settings: RainParameters, elapsed?: number): void => {
      const still = elapsed === undefined;
      const { columns, rows, cell, width, height } = geometryRef.current;
      const drops = dropsRef.current;
      const byId = agentsRef.current;
      const colors = paletteRef.current;
      const presentationByStatus = statusPresentation(colors);
      context2d.fillStyle = colors.rain.stage;
      context2d.fillRect(0, 0, width, height);

      // A receded column keeps falling, faint: the host is showing another group.
      const every = everyReceded(byId.values());
      for (const id of [...recedes.keys()]) if (!byId.has(id)) recedes.delete(id);
      for (const agent of byId.values()) {
        const target = recedeTarget(agent.receded, every);
        recedes.set(agent.id, still ? target : approachRecede(recedes.get(agent.id) ?? target, target, elapsed));
      }

      // Pane linkage rides its own channel — a wash behind the column in the
      // session's own colour, one stripe per further pane showing it — so the
      // glyph colors stay free to mean status, selection, and hover.
      if (settings.paneTint > 0) {
        for (const [column, drop] of drops) {
          const agent = byId.get(drop.agentId);
          const attachment = agent?.attachment;
          if (!agent || !attachment) continue;
          const weight = recedes.get(agent.id) ?? 1;
          context2d.globalAlpha = settings.paneTint * weight;
          context2d.fillStyle = agent.colour;
          context2d.fillRect(column * cell, 0, cell, height);
          context2d.globalAlpha = Math.min(0.6, settings.paneTint * 2.2) * weight;
          for (let mirror = 1; mirror < attachment.panes; mirror += 1) {
            context2d.fillRect(column * cell + (mirror - 1) * 2, 0, 2, height);
          }
        }
        context2d.globalAlpha = 1;
      }

      // §3: data is the mono stack. Terminal text belongs to Ghosttea's
      // renderer; this is our own drawing of our own data, so it takes ours.
      context2d.font = `bold ${cell}px "Courier New", Courier, monospace`;
      context2d.textAlign = 'center';

      for (const [column, drop] of drops) {
        if (column >= columns) continue;
        const agent = byId.get(drop.agentId);
        if (!agent) continue;

        const data = rainDataString(agent);
        const tailLength = rainTailLength(agent, rows, settings.tailMultiplier, data.length);
        const presentation = presentationByStatus[agent.status];
        const hoveredHere = hoveredRef.current === agent.id;
        // The mounted session is marked by its own §2.6 accent — "this session",
        // the same color its bubble wears in the swarm — while status keeps the
        // whole green/orange/muted scale. Hover only brightens; it takes no hue.
        const headColor = hoveredHere || agent.active ? colors.rain.activeHead : presentation.head;
        const tailColor = hoveredHere ? colors.rain.hoverTailRgb : presentation.tail;

        if (!still) drop.y += presentation.speed ?? drop.speed * settings.speedMultiplier;
        if (drop.y - tailLength > rows) drop.y = 0;

        const headRow = Math.floor(drop.y);
        const showHead = agent.status !== 'idle';
        const x = column * cell + cell / 2;

        const glyphAt = (row: number, distance: number): string => {
          if (still) return data[row % data.length] as string;
          let scramble = settings.scrambleWorking;
          if (agent.status === 'blocked') {
            // The text block stays clear while everything past it glitches, so
            // the one agent that is stuck is also the one you can read.
            scramble = distance < data.length ? 0 : settings.scramblePending;
          } else if (agent.status === 'idle') {
            scramble = 0;
          }
          return Math.random() < scramble ? matrixGlyph() : (data[row % data.length] as string);
        };

        context2d.shadowBlur = 0;
        context2d.globalAlpha = recedes.get(agent.id) ?? 1;
        // Clamped rather than guarded inside: a long tail on a short stage runs
        // most of its length off-screen, and this is the hot loop.
        const first = Math.min(headRow, rows - 1);
        const last = Math.max(-1, Math.floor(drop.y - tailLength));
        for (let row = first; row > last; row -= 1) {
          if (row < 0) break;
          const distance = drop.y - row;
          if (showHead && distance < 1) continue;
          context2d.fillStyle = `rgba(${tailColor}, ${Math.max(0, 1 - distance / tailLength)})`;
          context2d.fillText(glyphAt(row, distance), x, row * cell);
        }

        if (showHead && headRow >= 0 && headRow < rows) {
          context2d.shadowBlur = hoveredHere || agent.active ? settings.headGlow * 1.5 : settings.headGlow;
          context2d.shadowColor = `rgba(${tailColor}, 1)`;
          context2d.fillStyle = headColor;
          context2d.fillText(glyphAt(headRow, 0), x, headRow * cell);
          context2d.shadowBlur = 0;
        }
      }
      context2d.globalAlpha = 1;
    };

    // A still frame draws the field where it stands, never the moving draw with no time passed: that would let the
    // drops fall and the glyphs scramble.
    const drawStill = (): void => draw(context, parametersRef.current);
    // Driven from rAF rather than setInterval so the loop stops with the window
    // instead of repainting behind other applications; the refresh rate is the
    // loop's cap, which keeps the deliberately chunky sub-60 cadence.
    const loop = createMotionLoop((_time, elapsed) => draw(context, parametersRef.current, elapsed), {
      ...motionRef.current,
      fps: parametersRef.current.refreshRate,
      still: drawStill,
    });
    loopRef.current = loop;
    stillRef.current = () => {
      if (motionRef.current.hidden) loop.requestStill();
      else drawStill();
    };

    // Measured once the still draw exists, so a canvas the measure clears is drawn at once. What a stopped loop shows
    // of each change, the mount's among them, is the still effect's, on the loop's one still frame.
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => measure());
    observer?.observe(container);
    const stopWatchingRatio = watchDevicePixelRatio(() => measure());
    measure();
    return () => {
      stopWatchingRatio();
      observer?.disconnect();
      loop.dispose();
      loopRef.current = null;
      stillRef.current = null;
    };
  }, [measure]);

  // The host's animations switch, the reduced-motion preference and the stage out of sight start or stop the loop;
  // stopped, every change the field shows (its agents, their words, the palette, the parameters) is drawn once where
  // it stands, on one still frame however many arrive before it, and out of sight once the stage is shown.
  useEffect(() => {
    motionRef.current = themeMotion(theme);
    loopRef.current?.update(motionRef.current);
  }, [theme.animations, theme.reducedMotion, theme.hidden]);
  useEffect(() => {
    loopRef.current?.requestStill();
  }, [agents, palette, rain, theme.animations, theme.reducedMotion, theme.hidden]);

  /** Columns run the full height, so the pointer's row never matters. */
  const agentAt = useCallback((clientX: number): AgentView | undefined => {
    const container = containerRef.current;
    if (!container) return undefined;
    const bounds = container.getBoundingClientRect();
    const column = Math.floor((clientX - bounds.left) / geometryRef.current.cell);
    const drop = dropsRef.current.get(column);
    return drop ? agentsRef.current.get(drop.agentId) : undefined;
  }, []);

  // The view's own properties (L18): the palette's rain colours for the DOM it draws over the canvas (M46).
  const style = {
    '--mv-rain-stage': palette.rain.stage,
    '--mv-rain-title': palette.text.primary,
    '--mv-rain-ink-working': palette.rain.ink.working,
    '--mv-rain-ink-blocked': palette.rain.ink.blocked,
    '--mv-rain-ink-idle': palette.rain.ink.idle,
    '--mv-rain-focus': palette.rain.focus,
  } as CSSProperties;
  // A changed row is a new object (MV-D21), so the tooltip says the row as it is now, and nothing once it has left.
  const hovered = hoveredId === undefined ? undefined : input.model.byId.get(hoveredId);
  const hoveredContext = hovered?.kind === 'agent' ? hovered.context?.usedPercent : undefined;
  const hoveredBranch = hovered?.kind === 'agent' ? hovered.project.branch : undefined;

  return (
    <div ref={containerRef} className="vf-monitor-rain" style={style}>
      {/* No `aria-hidden` and no role: a canvas exposes its FALLBACK content to
          the accessible tree and this one has none, so it is already silent.
          The agents it draws are offered as real controls at the bottom of this
          view instead. */}
      <canvas ref={canvasRef} />
      {agents.length === 0 ? (
        <div className="vf-monitor-rain-empty">
          <span>NO ACTIVE AGENTS</span>
          <small>Launch an agent from a terminal pane.</small>
        </div>
      ) : null}
      {/* A pointer hit-target over the canvas, and DELIBERATELY out of the
          accessible tree: it has no name a screen reader could use and its
          keyboard equivalent is the real button list below, one control per
          agent. */}
      <div
        className="vf-monitor-rain-surface"
        aria-hidden="true"
        onPointerMove={(event) => {
          const agent = agentAt(event.clientX);
          hoveredRef.current = agent?.id;
          const bounds = event.currentTarget.getBoundingClientRect();
          pointerRef.current = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
          // The tooltip follows the cursor through the DOM directly. Re-rendering
          // on every move would put a full React pass between two canvas frames.
          if (tooltipRef.current) {
            tooltipRef.current.style.left = `${pointerRef.current.x + 15}px`;
            tooltipRef.current.style.top = `${pointerRef.current.y + 15}px`;
          }
          setHoveredId(agent?.id);
        }}
        onPointerLeave={() => {
          hoveredRef.current = undefined;
          setHoveredId(undefined);
        }}
        onClick={(event) => {
          const agent = agentAt(event.clientX);
          if (agent) commands.select(agent.id);
        }}
      />
      {hovered ? (
        <aside
          ref={tooltipRef}
          className={`vf-monitor-rain-tooltip is-${hovered.status}`}
          style={{ left: pointerRef.current.x + 15, top: pointerRef.current.y + 15 }}
          aria-hidden="true"
        >
          <header className="vf-monitor-rain-tooltip-head">
            <strong>{projectName(hovered)}</strong>
            <span>{hovered.status}</span>
          </header>
          <dl>
            {hoveredBranch ? (
              <>
                <dt>BRN</dt>
                <dd>{hoveredBranch}</dd>
              </>
            ) : null}
            <dt>MOD</dt>
            <dd>{agentName(hovered)}</dd>
            <dt>ACT</dt>
            <dd>{detailLine(hovered)}</dd>
          </dl>
          {hoveredContext === undefined ? null : (
            <p className="vf-monitor-rain-context">
              <span className="vf-monitor-rain-context-track">
                <i style={{ width: `${hoveredContext}%` }} />
              </span>
              CTX {Math.round(hoveredContext)}%
            </p>
          )}
        </aside>
      ) : null}
      {/* The canvas carries no accessible tree of its own, so the agents it draws are also offered as controls. */}
      <ul className="vf-monitor-rain-agents">
        {agents.map((agent) => (
          <li key={agent.id}>
            <button
              type="button"
              onClick={() => commands.select(agent.id)}
              aria-current={agent.active ? 'true' : undefined}
            >
              {`${projectName(agent)}, ${agentName(agent)}, ${agent.status}: ${detailLine(agent)}`}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

import type { NormalizationSnapshot } from '../../types.js';

const LIFECYCLES = [
  'preparing',
  'starting',
  'ready',
  'running',
  'interrupting',
  'terminating',
  'exited',
  'failed',
] as const;

type Lifecycle = (typeof LIFECYCLES)[number];

interface LifecycleNode {
  id: Lifecycle;
  x: number;
  y: number;
  reserved?: boolean;
}

interface LifecycleEdge {
  from: Lifecycle;
  to: Lifecycle;
  label?: string;
  kind?: 'terminal' | 'reserved';
  bow?: number;
}

const WIDTH = 1600;
const HEIGHT = 174;
const NODE_WIDTH = 132;
const NODE_HEIGHT = 32;

const NODES: LifecycleNode[] = [
  { id: 'preparing', x: 90, y: 52 },
  { id: 'starting', x: 310, y: 52 },
  { id: 'ready', x: 585, y: 52 },
  { id: 'running', x: 860, y: 52 },
  { id: 'interrupting', x: 1060, y: 126, reserved: true },
  { id: 'terminating', x: 1280, y: 126, reserved: true },
  { id: 'exited', x: 1510, y: 52 },
  { id: 'failed', x: 1510, y: 126 },
];

const EDGES: LifecycleEdge[] = [
  { from: 'preparing', to: 'starting', label: 'process.started' },
  { from: 'preparing', to: 'ready', label: 'session.*', bow: -34 },
  { from: 'starting', to: 'ready', label: 'session.ready' },
  { from: 'ready', to: 'running', label: 'turn.started', bow: -13 },
  { from: 'running', to: 'ready', label: 'turn.done', bow: 25 },
  { from: 'ready', to: 'exited', kind: 'terminal', bow: -58 },
  { from: 'running', to: 'exited', label: 'exit', kind: 'terminal', bow: -20 },
  { from: 'ready', to: 'failed', kind: 'terminal', bow: 60 },
  { from: 'running', to: 'failed', label: 'crash', kind: 'terminal', bow: 31 },
  { from: 'running', to: 'interrupting', label: 'interrupt', kind: 'reserved', bow: 8 },
  { from: 'interrupting', to: 'running', kind: 'reserved', bow: 25 },
  { from: 'ready', to: 'terminating', kind: 'reserved', bow: 45 },
  { from: 'running', to: 'terminating', label: 'terminate', kind: 'reserved', bow: 24 },
  { from: 'interrupting', to: 'terminating', kind: 'reserved' },
  { from: 'terminating', to: 'exited', kind: 'reserved', bow: -8 },
];

const nodeById = new Map(NODES.map((node) => [node.id, node]));

function lifecycle(value: unknown): Lifecycle | undefined {
  return typeof value === 'string' && (LIFECYCLES as readonly string[]).includes(value)
    ? (value as Lifecycle)
    : undefined;
}

export interface NormalizedLifecycleState {
  current: Lifecycle;
  observed: ReadonlySet<Lifecycle>;
  traversed: ReadonlySet<string>;
}

export function deriveNormalizedLifecycleState(
  projection: NormalizationSnapshot | undefined,
  selectedSequence: number | null,
): NormalizedLifecycleState {
  const visibleTraces = (projection?.traces ?? []).filter(
    (trace) => selectedSequence === null || trace.nativeSequence <= selectedSequence,
  );
  const observed = new Set<Lifecycle>();
  const traversed = new Set<string>();
  for (const trace of visibleTraces) {
    const before = lifecycle(trace.stateBefore.lifecycle);
    const after = lifecycle(trace.stateAfter.lifecycle);
    if (before) observed.add(before);
    if (after) observed.add(after);
    if (before && after && before !== after) traversed.add(`${before}\0${after}`);
  }
  const selectedTrace = visibleTraces.at(-1);
  const current =
    lifecycle(selectedTrace?.stateAfter.lifecycle) ??
    (selectedSequence === null ? lifecycle(projection?.state.lifecycle) : undefined) ??
    'preparing';
  observed.add(current);
  return { current, observed, traversed };
}

function borderFor(from: LifecycleNode, to: LifecycleNode) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (dx === 0 && dy === 0) return { x: from.x, y: from.y };
  const scale = Math.min(
    dx === 0 ? Infinity : (NODE_WIDTH / 2 + 3) / Math.abs(dx),
    dy === 0 ? Infinity : (NODE_HEIGHT / 2 + 3) / Math.abs(dy),
  );
  return { x: from.x + dx * scale, y: from.y + dy * scale };
}

interface NormalizedLifecycleGraphProps {
  projection: NormalizationSnapshot | undefined;
  selectedSequence: number | null;
  markerPrefix: string;
}

export function NormalizedLifecycleGraph({
  projection,
  selectedSequence,
  markerPrefix,
}: NormalizedLifecycleGraphProps) {
  const state = deriveNormalizedLifecycleState(projection, selectedSequence);
  const modeled = new Set(EDGES.map((edge) => `${edge.from}\0${edge.to}`));
  const extraEdges: LifecycleEdge[] = [...state.traversed]
    .filter((key) => !modeled.has(key))
    .map((key) => {
      const [from, to] = key.split('\0') as [Lifecycle, Lifecycle];
      return { from, to, label: 'observed' };
    });
  const arrowId = `${markerPrefix}-normalized-arrow`;
  const observedArrowId = `${markerPrefix}-normalized-observed-arrow`;

  return (
    <div className="normalized-graph graph">
      <svg width="100%" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label="Normalized Core lifecycle">
        <defs>
          <marker
            id={arrowId}
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 1 L 10 5 L 0 9 z" fill="#3a4050" />
          </marker>
          <marker
            id={observedArrowId}
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 1 L 10 5 L 0 9 z" fill="#a78bfa" />
          </marker>
        </defs>

        {[...EDGES, ...extraEdges].map((edge, index) => {
          const from = nodeById.get(edge.from);
          const to = nodeById.get(edge.to);
          if (!from || !to) return null;
          const start = borderFor(from, to);
          const end = borderFor(to, from);
          const midX = (start.x + end.x) / 2;
          const midY = (start.y + end.y) / 2;
          const dx = end.x - start.x;
          const dy = end.y - start.y;
          const length = Math.hypot(dx, dy) || 1;
          const bow = edge.bow ?? 0;
          const controlX = midX - (dy / length) * bow;
          const controlY = midY + (dx / length) * bow;
          const key = `${edge.from}\0${edge.to}`;
          const traversed = state.traversed.has(key);
          return (
            <g
              className={`normalized-edge ${edge.kind ?? 'primary'}${traversed ? ' traversed' : ''}`}
              key={`${key}-${index}`}
            >
              <path
                d={`M ${start.x} ${start.y} Q ${controlX} ${controlY} ${end.x} ${end.y}`}
                markerEnd={`url(#${traversed ? observedArrowId : arrowId})`}
              />
              {edge.label ? (
                <text x={(midX + controlX) / 2} y={(midY + controlY) / 2 - 5}>
                  {edge.label}
                </text>
              ) : null}
            </g>
          );
        })}

        {NODES.map((node) => {
          const classes = [
            'normalized-node',
            node.reserved ? 'reserved' : '',
            state.observed.has(node.id) ? 'observed' : '',
            state.current === node.id ? 'current' : '',
          ]
            .filter(Boolean)
            .join(' ');
          return (
            <g className={classes} key={node.id}>
              <rect
                className="halo"
                x={node.x - NODE_WIDTH / 2}
                y={node.y - NODE_HEIGHT / 2}
                width={NODE_WIDTH}
                height={NODE_HEIGHT}
                rx="9"
              />
              <rect
                x={node.x - NODE_WIDTH / 2}
                y={node.y - NODE_HEIGHT / 2}
                width={NODE_WIDTH}
                height={NODE_HEIGHT}
                rx="9"
              />
              <text x={node.x} y={node.y + 1}>
                {node.id}
              </text>
              {node.reserved ? (
                <text className="normalized-node-note" x={node.x} y={node.y + 29}>
                  declared / host-driven
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

import { useEffect, useMemo, useRef } from 'react';
import type { EmittedEntry, NativeEventDescriptor, SessionView } from '../../types.js';

type NativeBehavior = SessionView['nativeBehavior'];
type NativeNode = NativeBehavior['nodes'][number];

const NATIVE_COL = 178;
const NATIVE_ROW = 52;
const NATIVE_EMPTY_ROW = 28;
const NATIVE_LEFT = 128;
const NATIVE_TOP = 28;
const NATIVE_NODE_W = 158;
const NATIVE_NODE_H = 32;

function dottedValue(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, part) => {
    if (current === null || typeof current !== 'object') return undefined;
    return (current as Record<string, unknown>)[part];
  }, value);
}

function recordMatchesNode(record: EmittedEntry, node: NativeNode): boolean {
  return (
    record.event === node.event &&
    Object.entries(node.match ?? {}).every(([path, expected]) => dottedValue(record.payload ?? {}, path) === expected)
  );
}

function wrappedLines(value: string, max = 26): string[] {
  if (value.length <= max) return [value];
  const separator = value.includes(' · ') ? ' · ' : value.includes('/') ? '/' : value.includes(' ') ? ' ' : '';
  if (!separator) return [`${value.slice(0, max - 1)}…`];
  const lines: string[] = [];
  for (const part of value.split(separator)) {
    if (lines.length === 0) {
      lines.push(part);
      continue;
    }
    const candidate = `${lines.at(-1)}${separator}${part}`;
    if (candidate.length <= max) lines[lines.length - 1] = candidate;
    else lines.push(part);
  }
  return lines.slice(0, 2);
}

export interface NativeGraphState {
  records: EmittedEntry[];
  observed: ReadonlySet<string>;
  latest: ReadonlySet<string>;
  traversed: ReadonlySet<string>;
  last?: EmittedEntry | undefined;
}

export function deriveNativeGraphState(
  behavior: NativeBehavior,
  allRecords: readonly EmittedEntry[],
  selectedSequence: number | null,
): NativeGraphState {
  const records =
    selectedSequence === null ? [...allRecords] : allRecords.filter((record) => record.sequence <= selectedSequence);
  records.sort((left, right) => left.sequence - right.sequence);
  const matched = records.map((record) => ({
    record,
    nodes: behavior.nodes.filter((node) => recordMatchesNode(record, node)),
  }));
  const observed = new Set(matched.flatMap(({ nodes }) => nodes.map((node) => node.id)));
  const latest = new Set(matched.at(-1)?.nodes.map((node) => node.id) ?? []);
  const traversed = new Set<string>();
  for (let index = 1; index < matched.length; index += 1) {
    for (const from of matched[index - 1]!.nodes) {
      for (const to of matched[index]!.nodes) traversed.add(`${from.id}\0${to.id}`);
    }
  }
  return { records, observed, latest, traversed, last: matched.at(-1)?.record };
}

interface NativeGraphProps {
  behavior: NativeBehavior;
  nativeEvents: readonly NativeEventDescriptor[];
  state: NativeGraphState;
  markerPrefix: string;
}

export function NativeGraph({ behavior, nativeEvents, state, markerPrefix }: NativeGraphProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const nodeRefs = useRef(new Map<string, SVGGElement>());
  const laneLayout = useMemo(() => {
    const occupied = new Set(behavior.nodes.map((node) => node.lane));
    const rows = new Map<string, { top: number; height: number; center: number }>();
    let top = NATIVE_TOP;
    for (const lane of behavior.lanes) {
      const height = occupied.has(lane.id) ? NATIVE_ROW : NATIVE_EMPTY_ROW;
      rows.set(lane.id, { top, height, center: top + height / 2 });
      top += height;
    }
    return { rows, height: top + 4 };
  }, [behavior.lanes, behavior.nodes]);
  const nodes = useMemo(() => new Map(behavior.nodes.map((node) => [node.id, node])), [behavior.nodes]);
  const descriptors = useMemo(
    () => new Map(nativeEvents.map((descriptor) => [descriptor.event, descriptor])),
    [nativeEvents],
  );
  const maxOrder = Math.max(0, ...behavior.nodes.map((node) => node.order));
  const width = NATIVE_LEFT + (maxOrder + 1) * NATIVE_COL + 42;
  const height = laneLayout.height;
  const arrowId = `${markerPrefix}-native-arrow`;
  const observedArrowId = `${markerPrefix}-native-observed-arrow`;

  const pointFor = (node: NativeNode) => ({
    x: NATIVE_LEFT + node.order * NATIVE_COL + NATIVE_NODE_W / 2,
    y: laneLayout.rows.get(node.lane)?.center ?? NATIVE_TOP + NATIVE_ROW / 2,
  });
  const borderFor = (from: NativeNode, to: NativeNode) => {
    const start = pointFor(from);
    const end = pointFor(to);
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    if (dx === 0 && dy === 0) return start;
    const scale = Math.min(
      dx === 0 ? Infinity : (NATIVE_NODE_W / 2 + 4) / Math.abs(dx),
      dy === 0 ? Infinity : (NATIVE_NODE_H / 2 + 4) / Math.abs(dy),
    );
    return { x: start.x + dx * scale, y: start.y + dy * scale };
  };

  const latestId = state.latest.values().next().value as string | undefined;
  useEffect(() => {
    if (!latestId) return;
    const focusNode = nodeRefs.current.get(latestId);
    const viewport = viewportRef.current;
    if (!focusNode || !viewport) return;
    const bounds = focusNode.getBBox();
    viewport.scrollLeft = Math.max(0, bounds.x + bounds.width / 2 - viewport.clientWidth / 2);
  }, [latestId, state.last?.sequence]);

  return (
    <div className="graph" ref={viewportRef}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
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
            <path d="M 0 1 L 10 5 L 0 9 z" fill="#333a4d" />
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
            <path d="M 0 1 L 10 5 L 0 9 z" fill="#38bdf8" />
          </marker>
        </defs>

        {behavior.lanes.map((lane) => {
          const row = laneLayout.rows.get(lane.id);
          if (!row) return null;
          return (
            <g className="native-lane" key={lane.id}>
              <rect x="8" y={row.top} width={width - 16} height={row.height - 4} rx="8" />
              <text x="20" y={row.top + 16}>
                {lane.label.toUpperCase()}
              </text>
              <title>{lane.description || lane.label}</title>
            </g>
          );
        })}

        {behavior.relations.map((relation, index) => {
          const from = nodes.get(relation.from);
          const to = nodes.get(relation.to);
          if (!from || !to) return null;
          const wasTraversed = state.traversed.has(`${relation.from}\0${relation.to}`);
          let path: string;
          let labelPoint: { x: number; y: number };
          if (relation.from === relation.to) {
            const centre = pointFor(from);
            const top = centre.y - NATIVE_NODE_H / 2;
            path = `M ${centre.x - 24} ${top} C ${centre.x - 32} ${top - 22}, ${centre.x + 32} ${top - 22}, ${centre.x + 24} ${top}`;
            labelPoint = { x: centre.x, y: top - 16 };
          } else {
            const start = borderFor(from, to);
            const end = borderFor(to, from);
            const midX = (start.x + end.x) / 2;
            const midY = (start.y + end.y) / 2;
            const sameLane = from.lane === to.lane;
            const bend = sameLane ? -13 : relation.kind === 'async' ? 18 : 8;
            path = `M ${start.x} ${start.y} Q ${midX} ${midY + bend} ${end.x} ${end.y}`;
            labelPoint = { x: midX, y: midY + bend / 2 - 5 };
          }
          return (
            <g
              className={`native-relation ${relation.kind}${relation.confidence === 'unverified' ? ' unverified' : ''}${wasTraversed ? ' observed' : ''}`}
              key={`${relation.from}-${relation.to}-${index}`}
            >
              <path d={path} markerEnd={`url(#${wasTraversed ? observedArrowId : arrowId})`} />
              {relation.label ? (
                <text x={labelPoint.x} y={labelPoint.y}>
                  {relation.label}
                </text>
              ) : null}
              <title>{`${relation.kind} · ${relation.confidence}${relation.source ? ` · ${relation.source}` : ''}`}</title>
            </g>
          );
        })}

        {behavior.nodes.map((node) => {
          const point = pointFor(node);
          const descriptor = descriptors.get(node.event);
          const lines = wrappedLines(node.label || node.event);
          const classes = [
            'native-node',
            node.confidence === 'unverified' ? 'unverified' : '',
            state.observed.has(node.id) ? 'observed' : '',
            state.latest.has(node.id) ? 'latest' : '',
          ]
            .filter(Boolean)
            .join(' ');
          const selector = Object.keys(node.match ?? {}).length ? ` · ${JSON.stringify(node.match)}` : '';
          const rails = descriptor?.channels.length ? ` · ${descriptor.channels.join(' + ')}` : '';
          return (
            <g
              className={classes}
              key={node.id}
              ref={(element) => {
                if (element) nodeRefs.current.set(node.id, element);
                else nodeRefs.current.delete(node.id);
              }}
            >
              <rect
                className="halo"
                x={point.x - NATIVE_NODE_W / 2}
                y={point.y - NATIVE_NODE_H / 2}
                width={NATIVE_NODE_W}
                height={NATIVE_NODE_H}
                rx="8"
              />
              <rect
                x={point.x - NATIVE_NODE_W / 2}
                y={point.y - NATIVE_NODE_H / 2}
                width={NATIVE_NODE_W}
                height={NATIVE_NODE_H}
                rx="8"
              />
              <text x={point.x} y={point.y + 3 - (lines.length - 1) * 7}>
                {lines.map((line, index) => (
                  <tspan x={point.x} dy={index === 0 ? 0 : 14} key={`${line}-${index}`}>
                    {line}
                  </tspan>
                ))}
              </text>
              <title>{`${node.event}${selector}${rails} · ${node.confidence}${node.description ? ` · ${node.description}` : ''}`}</title>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

import type {
  AgentEvent,
  AgentEventCategory,
  AgentEventCategoryOf,
  AgentEventForType,
  AgentEventType,
} from './catalog.js';
import type { AgentEventEnvelope } from './envelope.js';

type EnvelopeForCategory<Event extends AgentEvent, Category extends AgentEventCategory> = Event extends AgentEvent
  ? AgentEventCategoryOf<Event> extends Category
    ? AgentEventEnvelope<Event>
    : never
  : never;

/** Envelope narrowed to the schema registered for one exact public route. */
export type AgentEnvelopeForType<Type extends AgentEventType> = AgentEventEnvelope<AgentEventForType<Type>>;

/** Envelope union for all routes in one public event category. */
export type AgentEnvelopeForCategory<Category extends AgentEventCategory> = EnvelopeForCategory<AgentEvent, Category>;

/** Exact route, category wildcard, or the complete per-Agent rail. */
export type AgentEventSelector = '*' | `${AgentEventCategory}:*` | AgentEventType;

export type AgentEnvelopeForSelector<Selector extends AgentEventSelector> = Selector extends '*'
  ? AgentEventEnvelope
  : Selector extends `${infer Category extends AgentEventCategory}:*`
    ? AgentEnvelopeForCategory<Category>
    : Selector extends AgentEventType
      ? AgentEnvelopeForType<Selector>
      : never;

export type AgentEventListener<Envelope extends AgentEventEnvelope = AgentEventEnvelope> = (envelope: Envelope) => void;

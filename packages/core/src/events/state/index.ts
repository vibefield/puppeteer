import { z } from 'zod';
import { DelegationStateEventSchema, type DelegationStateEvent } from './delegation.js';
import { InteractionStateEventSchema, type InteractionStateEvent } from './interaction.js';
import { PlanningStateEventSchema, type PlanningStateEvent } from './planning.js';
import { ReasoningStateEventSchema, type ReasoningStateEvent } from './reasoning.js';
import { SessionStateEventSchema, type SessionStateEvent } from './session.js';
import { ToolStateEventSchema, type ToolStateEvent } from './tool.js';
import { TurnStateEventSchema, type TurnStateEvent } from './turn.js';

export * from './session.js';
export * from './turn.js';
export * from './reasoning.js';
export * from './tool.js';
export * from './interaction.js';
export * from './delegation.js';
export * from './planning.js';

/** Events published through the public `state:*` category. */
export type StateEvent =
  | SessionStateEvent
  | TurnStateEvent
  | ReasoningStateEvent
  | ToolStateEvent
  | InteractionStateEvent
  | DelegationStateEvent
  | PlanningStateEvent;

export const StateEventSchema: z.ZodType<StateEvent> = z.union([
  SessionStateEventSchema,
  TurnStateEventSchema,
  ReasoningStateEventSchema,
  ToolStateEventSchema,
  InteractionStateEventSchema,
  DelegationStateEventSchema,
  PlanningStateEventSchema,
]);

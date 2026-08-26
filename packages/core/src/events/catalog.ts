import { z } from 'zod';
import { UnknownNativeEventSchema, type AdapterEvent } from './adapter.js';
import { CompactionCompletedEventSchema, CompactionStartedEventSchema, type CompactionEvent } from './compaction.js';
import {
  ContextWindowInvalidatedEventSchema,
  ContextWindowUpdatedEventSchema,
  type ContextWindowEvent,
} from './context-window.js';
import { AssistantMessageEventSchema, type ConversationEvent } from './conversation.js';
import {
  SubagentStartedEventSchema,
  SubagentStoppedEventSchema,
  TaskCompletedEventSchema,
  TaskCreatedEventSchema,
  TaskUpdatedEventSchema,
  TeammateIdleEventSchema,
  type DelegationEvent,
} from './delegation.js';
import { EffortUpdatedEventSchema, type EffortEvent } from './effort.js';
import { EnvironmentUpdatedEventSchema, type EnvironmentEvent } from './environment.js';
import type { AgentEventContract } from './contract.js';
import {
  PermissionRequestedEventSchema,
  PermissionResolvedEventSchema,
  QuestionRequestedEventSchema,
  QuestionResolvedEventSchema,
  type InteractionEvent,
} from './interaction.js';
import { ModeUpdatedEventSchema, type ModeEvent } from './mode.js';
import { ModelUpdatedEventSchema, type ModelEvent } from './model.js';
import { MonitorObservationBatchEventSchema, type MonitorEvent } from './monitor.js';
import { NativeNotificationEventSchema, type NotificationEvent } from './notification.js';
import { PlanUpdatedEventSchema, type PlanningEvent } from './planning.js';
import { ProcessExitedEventSchema, ProcessStartedEventSchema, type ProcessEvent } from './process.js';
import {
  ReasoningCompletedEventSchema,
  ReasoningProgressEventSchema,
  ReasoningStartedEventSchema,
  ReasoningSummaryEventSchema,
  type ReasoningEvent,
} from './reasoning.js';
import {
  SessionExitedEventSchema,
  SessionReadyEventSchema,
  SessionStartedEventSchema,
  type SessionEvent,
} from './session.js';
import {
  ToolCompletedEventSchema,
  ToolFailedEventSchema,
  ToolRequestedEventSchema,
  ToolStartedEventSchema,
  type ToolEvent,
} from './tool.js';
import { TurnCompletedEventSchema, TurnFailedEventSchema, TurnStartedEventSchema, type TurnEvent } from './turn.js';
import { TokensUsedEventSchema, type UsageEvent } from './usage.js';
import { WorkflowUpdatedEventSchema, type WorkflowEvent } from './workflow.js';
import { WorkspaceChangedEventSchema, type WorkspaceEvent } from './workspace.js';

/** Complete normalized event union. Category modules own the individual members. */
export type AgentEvent =
  | SessionEvent
  | TurnEvent
  | ReasoningEvent
  | ToolEvent
  | InteractionEvent
  | DelegationEvent
  | PlanningEvent
  | CompactionEvent
  | ContextWindowEvent
  | ConversationEvent
  | UsageEvent
  | WorkflowEvent
  | EnvironmentEvent
  | ModelEvent
  | EffortEvent
  | ModeEvent
  | WorkspaceEvent
  | ProcessEvent
  | NotificationEvent
  | MonitorEvent
  | AdapterEvent;

/** Top-level categories on the public `category:event-name` rail. */
export type AgentEventCategory =
  | 'session'
  | 'turn'
  | 'reasoning'
  | 'tool'
  | 'interaction'
  | 'delegation'
  | 'planning'
  | 'compaction'
  | 'context-window'
  | 'conversation'
  | 'usage'
  | 'workflow'
  | 'environment'
  | 'model'
  | 'effort'
  | 'mode'
  | 'workspace'
  | 'process'
  | 'notification'
  | 'monitor'
  | 'adapter';

interface AgentEventCatalogDefinition {
  category: AgentEventCategory;
  eventType: AgentEvent['type'];
  schema: z.ZodObject;
  description: string;
}

function defineAgentEvent<
  const Category extends AgentEventCategory,
  const EventType extends AgentEvent['type'],
  const Schema extends z.ZodObject,
>(category: Category, eventType: EventType, schema: Schema, description: string) {
  return { category, eventType, schema, description } as const;
}

/**
 * Exhaustive schema and metadata catalog keyed by the one public event name.
 * Adding an event means adding a category-owned schema and an explicit entry.
 */
export const agentEventCatalog = {
  'session:started': defineAgentEvent(
    'session',
    'session:started',
    SessionStartedEventSchema,
    'A provider session started or rebound to a new native identity.',
  ),
  'session:ready': defineAgentEvent('session', 'session:ready', SessionReadyEventSchema, 'The session is ready.'),
  'session:exited': defineAgentEvent(
    'session',
    'session:exited',
    SessionExitedEventSchema,
    'The semantic provider session exited.',
  ),
  'turn:started': defineAgentEvent('turn', 'turn:started', TurnStartedEventSchema, 'A user turn started.'),
  'turn:completed': defineAgentEvent(
    'turn',
    'turn:completed',
    TurnCompletedEventSchema,
    'A user turn completed successfully.',
  ),
  'turn:failed': defineAgentEvent('turn', 'turn:failed', TurnFailedEventSchema, 'A user turn failed.'),
  'reasoning:started': defineAgentEvent(
    'reasoning',
    'reasoning:started',
    ReasoningStartedEventSchema,
    'A provider-authoritative reasoning phase started.',
  ),
  'reasoning:progress': defineAgentEvent(
    'reasoning',
    'reasoning:progress',
    ReasoningProgressEventSchema,
    'A reasoning activity pulse was observed.',
  ),
  'reasoning:summary': defineAgentEvent(
    'reasoning',
    'reasoning:summary',
    ReasoningSummaryEventSchema,
    'A user-displayable reasoning summary was emitted.',
  ),
  'reasoning:completed': defineAgentEvent(
    'reasoning',
    'reasoning:completed',
    ReasoningCompletedEventSchema,
    'A reasoning phase completed.',
  ),
  'tool:requested': defineAgentEvent(
    'tool',
    'tool:requested',
    ToolRequestedEventSchema,
    'A tool invocation was requested.',
  ),
  'tool:started': defineAgentEvent('tool', 'tool:started', ToolStartedEventSchema, 'A tool invocation started.'),
  'tool:completed': defineAgentEvent(
    'tool',
    'tool:completed',
    ToolCompletedEventSchema,
    'A tool invocation completed.',
  ),
  'tool:failed': defineAgentEvent('tool', 'tool:failed', ToolFailedEventSchema, 'A tool invocation failed.'),
  'interaction:permission-requested': defineAgentEvent(
    'interaction',
    'interaction:permission-requested',
    PermissionRequestedEventSchema,
    'The agent requested a permission decision.',
  ),
  'interaction:permission-resolved': defineAgentEvent(
    'interaction',
    'interaction:permission-resolved',
    PermissionResolvedEventSchema,
    'A permission request was resolved.',
  ),
  'interaction:question-requested': defineAgentEvent(
    'interaction',
    'interaction:question-requested',
    QuestionRequestedEventSchema,
    'The agent requested structured user input.',
  ),
  'interaction:question-resolved': defineAgentEvent(
    'interaction',
    'interaction:question-resolved',
    QuestionResolvedEventSchema,
    'A structured question request was resolved.',
  ),
  'delegation:subagent-started': defineAgentEvent(
    'delegation',
    'delegation:subagent-started',
    SubagentStartedEventSchema,
    'A delegated subagent started.',
  ),
  'delegation:subagent-stopped': defineAgentEvent(
    'delegation',
    'delegation:subagent-stopped',
    SubagentStoppedEventSchema,
    'A delegated subagent stopped.',
  ),
  'delegation:task-created': defineAgentEvent(
    'delegation',
    'delegation:task-created',
    TaskCreatedEventSchema,
    'A delegated task was created.',
  ),
  'delegation:task-completed': defineAgentEvent(
    'delegation',
    'delegation:task-completed',
    TaskCompletedEventSchema,
    'A delegated task completed.',
  ),
  'delegation:task-updated': defineAgentEvent(
    'delegation',
    'delegation:task-updated',
    TaskUpdatedEventSchema,
    'A delegated task changed state.',
  ),
  'delegation:teammate-idle': defineAgentEvent(
    'delegation',
    'delegation:teammate-idle',
    TeammateIdleEventSchema,
    'A provider teammate became idle.',
  ),
  'planning:updated': defineAgentEvent(
    'planning',
    'planning:updated',
    PlanUpdatedEventSchema,
    'The active plan changed.',
  ),
  'compaction:started': defineAgentEvent(
    'compaction',
    'compaction:started',
    CompactionStartedEventSchema,
    'Context compaction started.',
  ),
  'compaction:completed': defineAgentEvent(
    'compaction',
    'compaction:completed',
    CompactionCompletedEventSchema,
    'Context compaction finished.',
  ),
  'context-window:updated': defineAgentEvent(
    'context-window',
    'context-window:updated',
    ContextWindowUpdatedEventSchema,
    'The provider reported current context-window pressure.',
  ),
  'context-window:invalidated': defineAgentEvent(
    'context-window',
    'context-window:invalidated',
    ContextWindowInvalidatedEventSchema,
    'The previous context-window measurement became untrustworthy.',
  ),
  'conversation:assistant-message': defineAgentEvent(
    'conversation',
    'conversation:assistant-message',
    AssistantMessageEventSchema,
    'A normalized assistant message or message update was emitted.',
  ),
  'usage:tokens-used': defineAgentEvent(
    'usage',
    'usage:tokens-used',
    TokensUsedEventSchema,
    'The provider reported token consumption.',
  ),
  'workflow:updated': defineAgentEvent(
    'workflow',
    'workflow:updated',
    WorkflowUpdatedEventSchema,
    'A provider workflow and its observed worker membership changed.',
  ),
  'environment:updated': defineAgentEvent(
    'environment',
    'environment:updated',
    EnvironmentUpdatedEventSchema,
    'The effective filesystem environment changed.',
  ),
  'model:updated': defineAgentEvent(
    'model',
    'model:updated',
    ModelUpdatedEventSchema,
    'The configured or effective provider model changed.',
  ),
  'effort:updated': defineAgentEvent(
    'effort',
    'effort:updated',
    EffortUpdatedEventSchema,
    'The configured or effective reasoning effort changed.',
  ),
  'mode:updated': defineAgentEvent(
    'mode',
    'mode:updated',
    ModeUpdatedEventSchema,
    'A configured or effective provider mode changed.',
  ),
  'workspace:changed': defineAgentEvent(
    'workspace',
    'workspace:changed',
    WorkspaceChangedEventSchema,
    'The session workspace changed.',
  ),
  'process:started': defineAgentEvent(
    'process',
    'process:started',
    ProcessStartedEventSchema,
    'The provider process started.',
  ),
  'process:exited': defineAgentEvent(
    'process',
    'process:exited',
    ProcessExitedEventSchema,
    'The provider process exited.',
  ),
  'notification:received': defineAgentEvent(
    'notification',
    'notification:received',
    NativeNotificationEventSchema,
    'A provider-native notification was received.',
  ),
  'monitor:batch': defineAgentEvent(
    'monitor',
    'monitor:batch',
    MonitorObservationBatchEventSchema,
    'An atomic semantic monitor observation batch was emitted.',
  ),
  'adapter:native-event': defineAgentEvent(
    'adapter',
    'adapter:native-event',
    UnknownNativeEventSchema,
    'Unrecognized or degraded provider evidence was retained.',
  ),
} as const satisfies Record<`${AgentEventCategory}:${string}`, AgentEventCatalogDefinition>;

export type AgentEventCatalog = typeof agentEventCatalog;
/** Stable public event identifiers. Every identifier follows `category:event-name`. */
export type AgentEventType = keyof AgentEventCatalog;
export type AgentEventForType<Type extends AgentEventType> = z.output<AgentEventCatalog[Type]['schema']> & AgentEvent;

type AssertNever<Value extends never> = Value;
export type AgentEventContractViolation = AssertNever<Exclude<AgentEvent, AgentEventContract>>;
type CatalogEventType = AgentEventCatalog[AgentEventType]['eventType'];
export type AgentEventCatalogMissingEventType = AssertNever<Exclude<AgentEvent['type'], CatalogEventType>>;
export type AgentEventCatalogIdentityMismatch = AssertNever<
  { [Type in AgentEventType]: Type extends AgentEventCatalog[Type]['eventType'] ? never : Type }[AgentEventType]
>;
export type AgentEventCatalogRouteCategoryMismatch = AssertNever<
  {
    [Type in AgentEventType]: Type extends `${AgentEventCatalog[Type]['category']}:${string}` ? never : Type;
  }[AgentEventType]
>;

export type AgentEventCategoryOf<T extends AgentEvent = AgentEvent> = T extends AgentEvent
  ? {
      [Type in AgentEventType]: T['type'] extends AgentEventCatalog[Type]['eventType']
        ? AgentEventCatalog[Type]['category']
        : never;
    }[AgentEventType]
  : never;

export type AgentEventTypeFor<T extends AgentEvent> = T extends AgentEvent
  ? {
      [Type in AgentEventType]: T['type'] extends AgentEventCatalog[Type]['eventType'] ? Type : never;
    }[AgentEventType]
  : never;

type CatalogEntry = AgentEventCatalog[AgentEventType];

const catalogEntries = Object.entries(agentEventCatalog) as Array<[AgentEventType, CatalogEntry]>;
const catalogByEventType = new Map<AgentEvent['type'], [AgentEventType, CatalogEntry]>(
  catalogEntries.map(([type, definition]) => [definition.eventType, [type, definition]]),
);

export function isAgentEventType(value: unknown): value is AgentEventType {
  return typeof value === 'string' && Object.hasOwn(agentEventCatalog, value);
}

function definitionForEvent(event: AgentEvent): [AgentEventType, CatalogEntry] | undefined {
  return catalogByEventType.get(event.type);
}

export function agentEventCategory<T extends AgentEvent>(event: T): AgentEventCategoryOf<T> {
  const definition = definitionForEvent(event);
  if (!definition) throw new TypeError(`unregistered canonical agent event: ${String(event.type)}`);
  return definition[1].category as AgentEventCategoryOf<T>;
}

export function agentEventType<T extends AgentEvent>(event: T): AgentEventTypeFor<T> {
  return event.type as AgentEventTypeFor<T>;
}

/** Validate one normalized event against the schema registered for its public route. */
export function parseAgentEvent<Type extends AgentEventType>(type: Type, input: unknown): AgentEventForType<Type> {
  return agentEventCatalog[type].schema.parse(input) as AgentEventForType<Type>;
}

export type AgentEventParseResult<Type extends AgentEventType> =
  { success: true; data: AgentEventForType<Type> } | { success: false; error: z.ZodError };

export function safeParseAgentEvent<Type extends AgentEventType>(
  type: Type,
  input: unknown,
): AgentEventParseResult<Type> {
  return agentEventCatalog[type].schema.safeParse(input) as AgentEventParseResult<Type>;
}

/** The payload schema excludes the canonical routing discriminator. */
export function agentEventPayloadSchema<Type extends AgentEventType>(
  type: Type,
): z.ZodType<Omit<AgentEventForType<Type>, 'type'>> {
  const definition = agentEventCatalog[type];
  const schema = definition.schema as z.ZodObject;
  const { type: _discriminator, ...payloadShape } = schema.shape;
  return z.strictObject(payloadShape).transform((payload, context) => {
    const parsed = schema.safeParse({ type: definition.eventType, ...payload });
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        context.addIssue({ code: 'custom', message: issue.message, path: issue.path });
      }
      return z.NEVER;
    }
    const { type: _type, ...validatedPayload } = parsed.data as AgentEvent;
    return validatedPayload;
  }) as unknown as z.ZodType<Omit<AgentEventForType<Type>, 'type'>>;
}

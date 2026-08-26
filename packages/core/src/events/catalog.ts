import { z } from 'zod';
import { UnknownNativeEventSchema, type AdapterEvent } from './adapter.js';
import {
  ContextWindowInvalidatedEventSchema,
  ContextWindowUpdatedEventSchema,
  type ContextWindowEvent,
} from './context-window.js';
import { AssistantMessageEventSchema, type ConversationEvent } from './conversation.js';
import { SessionEnvironmentUpdatedEventSchema, type EnvironmentEvent } from './environment.js';
import { MonitorObservationBatchEventSchema, type MonitorEvent } from './monitor.js';
import { NativeNotificationEventSchema, type NotificationEvent } from './notification.js';
import { ProcessExitedEventSchema, ProcessStartedEventSchema, type ProcessEvent } from './process.js';
import {
  CompactionCompletedEventSchema,
  CompactionStartedEventSchema,
  PermissionRequestedEventSchema,
  PermissionResolvedEventSchema,
  PlanUpdatedEventSchema,
  QuestionRequestedEventSchema,
  QuestionResolvedEventSchema,
  ReasoningCompletedEventSchema,
  ReasoningProgressEventSchema,
  ReasoningStartedEventSchema,
  ReasoningSummaryEventSchema,
  SessionExitedEventSchema,
  SessionReadyEventSchema,
  SessionStartedEventSchema,
  SubagentStartedEventSchema,
  SubagentStoppedEventSchema,
  TaskCompletedEventSchema,
  TaskCreatedEventSchema,
  TaskUpdatedEventSchema,
  TeammateIdleEventSchema,
  ToolCompletedEventSchema,
  ToolFailedEventSchema,
  ToolRequestedEventSchema,
  ToolStartedEventSchema,
  TurnCompletedEventSchema,
  TurnFailedEventSchema,
  TurnStartedEventSchema,
  type StateEvent,
} from './state/index.js';
import { TokensUsedEventSchema, type UsageEvent } from './usage.js';
import { WorkflowUpdatedEventSchema, type WorkflowEvent } from './workflow.js';
import { WorkspaceChangedEventSchema, type WorkspaceEvent } from './workspace.js';

/** Complete normalized event union. Category modules own the individual members. */
export type AgentEvent =
  | StateEvent
  | ContextWindowEvent
  | ConversationEvent
  | UsageEvent
  | WorkflowEvent
  | EnvironmentEvent
  | WorkspaceEvent
  | ProcessEvent
  | NotificationEvent
  | MonitorEvent
  | AdapterEvent;

/** Top-level categories on the public `category:event-name` rail. */
export type AgentEventService =
  | 'state'
  | 'context-window'
  | 'conversation'
  | 'usage'
  | 'workflow'
  | 'environment'
  | 'workspace'
  | 'process'
  | 'notification'
  | 'monitor'
  | 'adapter';

interface AgentEventCatalogDefinition {
  category: AgentEventService;
  /** Temporary compatibility identity inside the pre-payload normalized event. */
  legacyType: AgentEvent['type'];
  schema: z.ZodObject;
  description: string;
}

function defineAgentEvent<
  const Category extends AgentEventService,
  const LegacyType extends AgentEvent['type'],
  const Schema extends z.ZodObject,
>(category: Category, legacyType: LegacyType, schema: Schema, description: string) {
  return { category, legacyType, schema, description } as const;
}

/**
 * Exhaustive schema and metadata catalog keyed by the one public event name.
 * Adding an event means adding a category-owned schema and an explicit entry.
 */
export const agentEventCatalog = {
  'state:session-started': defineAgentEvent(
    'state',
    'session.started',
    SessionStartedEventSchema,
    'A provider session started or rebound to a new native identity.',
  ),
  'state:session-ready': defineAgentEvent('state', 'session.ready', SessionReadyEventSchema, 'The session is ready.'),
  'state:session-exited': defineAgentEvent(
    'state',
    'session.exited',
    SessionExitedEventSchema,
    'The semantic provider session exited.',
  ),
  'state:turn-started': defineAgentEvent('state', 'turn.started', TurnStartedEventSchema, 'A user turn started.'),
  'state:turn-completed': defineAgentEvent(
    'state',
    'turn.completed',
    TurnCompletedEventSchema,
    'A user turn completed successfully.',
  ),
  'state:turn-failed': defineAgentEvent('state', 'turn.failed', TurnFailedEventSchema, 'A user turn failed.'),
  'state:reasoning-started': defineAgentEvent(
    'state',
    'reasoning.started',
    ReasoningStartedEventSchema,
    'A provider-authoritative reasoning phase started.',
  ),
  'state:reasoning-progress': defineAgentEvent(
    'state',
    'reasoning.progress',
    ReasoningProgressEventSchema,
    'A reasoning activity pulse was observed.',
  ),
  'state:reasoning-summary': defineAgentEvent(
    'state',
    'reasoning.summary',
    ReasoningSummaryEventSchema,
    'A user-displayable reasoning summary was emitted.',
  ),
  'state:reasoning-completed': defineAgentEvent(
    'state',
    'reasoning.completed',
    ReasoningCompletedEventSchema,
    'A reasoning phase completed.',
  ),
  'state:tool-requested': defineAgentEvent(
    'state',
    'tool.requested',
    ToolRequestedEventSchema,
    'A tool invocation was requested.',
  ),
  'state:tool-started': defineAgentEvent('state', 'tool.started', ToolStartedEventSchema, 'A tool invocation started.'),
  'state:tool-completed': defineAgentEvent(
    'state',
    'tool.completed',
    ToolCompletedEventSchema,
    'A tool invocation completed.',
  ),
  'state:tool-failed': defineAgentEvent('state', 'tool.failed', ToolFailedEventSchema, 'A tool invocation failed.'),
  'state:permission-requested': defineAgentEvent(
    'state',
    'permission.requested',
    PermissionRequestedEventSchema,
    'The agent requested a permission decision.',
  ),
  'state:permission-resolved': defineAgentEvent(
    'state',
    'permission.resolved',
    PermissionResolvedEventSchema,
    'A permission request was resolved.',
  ),
  'state:question-requested': defineAgentEvent(
    'state',
    'question.requested',
    QuestionRequestedEventSchema,
    'The agent requested structured user input.',
  ),
  'state:question-resolved': defineAgentEvent(
    'state',
    'question.resolved',
    QuestionResolvedEventSchema,
    'A structured question request was resolved.',
  ),
  'state:subagent-started': defineAgentEvent(
    'state',
    'subagent.started',
    SubagentStartedEventSchema,
    'A delegated subagent started.',
  ),
  'state:subagent-stopped': defineAgentEvent(
    'state',
    'subagent.stopped',
    SubagentStoppedEventSchema,
    'A delegated subagent stopped.',
  ),
  'state:task-created': defineAgentEvent(
    'state',
    'task.created',
    TaskCreatedEventSchema,
    'A delegated task was created.',
  ),
  'state:task-completed': defineAgentEvent(
    'state',
    'task.completed',
    TaskCompletedEventSchema,
    'A delegated task completed.',
  ),
  'state:task-updated': defineAgentEvent(
    'state',
    'task.updated',
    TaskUpdatedEventSchema,
    'A delegated task changed state.',
  ),
  'state:teammate-idle': defineAgentEvent(
    'state',
    'teammate.idle',
    TeammateIdleEventSchema,
    'A provider teammate became idle.',
  ),
  'state:plan-updated': defineAgentEvent('state', 'plan.updated', PlanUpdatedEventSchema, 'The active plan changed.'),
  'state:compaction-started': defineAgentEvent(
    'state',
    'compaction.started',
    CompactionStartedEventSchema,
    'Context compaction started.',
  ),
  'state:compaction-completed': defineAgentEvent(
    'state',
    'compaction.completed',
    CompactionCompletedEventSchema,
    'Context compaction finished.',
  ),
  'context-window:updated': defineAgentEvent(
    'context-window',
    'context-window.updated',
    ContextWindowUpdatedEventSchema,
    'The provider reported current context-window pressure.',
  ),
  'context-window:invalidated': defineAgentEvent(
    'context-window',
    'context-window.invalidated',
    ContextWindowInvalidatedEventSchema,
    'The previous context-window measurement became untrustworthy.',
  ),
  'conversation:assistant-message': defineAgentEvent(
    'conversation',
    'assistant.message',
    AssistantMessageEventSchema,
    'A normalized assistant message or message update was emitted.',
  ),
  'usage:tokens-used': defineAgentEvent(
    'usage',
    'tokens.used',
    TokensUsedEventSchema,
    'The provider reported token consumption.',
  ),
  'workflow:updated': defineAgentEvent(
    'workflow',
    'workflow.updated',
    WorkflowUpdatedEventSchema,
    'A provider workflow and its observed worker membership changed.',
  ),
  'environment:updated': defineAgentEvent(
    'environment',
    'session.environment.updated',
    SessionEnvironmentUpdatedEventSchema,
    'The effective or configured session environment changed.',
  ),
  'workspace:changed': defineAgentEvent(
    'workspace',
    'workspace.changed',
    WorkspaceChangedEventSchema,
    'The session workspace changed.',
  ),
  'process:started': defineAgentEvent(
    'process',
    'process.started',
    ProcessStartedEventSchema,
    'The provider process started.',
  ),
  'process:exited': defineAgentEvent(
    'process',
    'process.exited',
    ProcessExitedEventSchema,
    'The provider process exited.',
  ),
  'notification:received': defineAgentEvent(
    'notification',
    'notification',
    NativeNotificationEventSchema,
    'A provider-native notification was received.',
  ),
  'monitor:batch': defineAgentEvent(
    'monitor',
    'monitor.batch',
    MonitorObservationBatchEventSchema,
    'An atomic semantic monitor observation batch was emitted.',
  ),
  'adapter:native-event': defineAgentEvent(
    'adapter',
    'adapter.native-event',
    UnknownNativeEventSchema,
    'Unrecognized or degraded provider evidence was retained.',
  ),
} as const satisfies Record<`${AgentEventService}:${string}`, AgentEventCatalogDefinition>;

export type AgentEventCatalog = typeof agentEventCatalog;
/** Stable public event identifiers. Every identifier follows `category:event-name`. */
export type AgentEventType = keyof AgentEventCatalog;
export type AgentEventForType<Type extends AgentEventType> = z.output<AgentEventCatalog[Type]['schema']> & AgentEvent;

type AssertNever<Value extends never> = Value;
type CatalogLegacyType = AgentEventCatalog[AgentEventType]['legacyType'];
export type AgentEventCatalogMissingLegacyType = AssertNever<Exclude<AgentEvent['type'], CatalogLegacyType>>;
export type AgentEventCatalogRouteCategoryMismatch = AssertNever<
  {
    [Type in AgentEventType]: Type extends `${AgentEventCatalog[Type]['category']}:${string}` ? never : Type;
  }[AgentEventType]
>;

export type AgentEventServiceOf<T extends AgentEvent = AgentEvent> = T extends AgentEvent
  ? {
      [Type in AgentEventType]: T['type'] extends AgentEventCatalog[Type]['legacyType']
        ? AgentEventCatalog[Type]['category']
        : never;
    }[AgentEventType]
  : never;

export type AgentServiceEventTypeFor<T extends AgentEvent> = T extends AgentEvent
  ? {
      [Type in AgentEventType]: T['type'] extends AgentEventCatalog[Type]['legacyType'] ? Type : never;
    }[AgentEventType]
  : never;

/** Compatibility name retained while callers migrate to `AgentEventType`. */
export type AgentServiceEventType<T extends AgentEvent = AgentEvent> = AgentServiceEventTypeFor<T>;

type CatalogEntry = AgentEventCatalog[AgentEventType];

const catalogEntries = Object.entries(agentEventCatalog) as Array<[AgentEventType, CatalogEntry]>;
const catalogByLegacyType = new Map<AgentEvent['type'], [AgentEventType, CatalogEntry]>(
  catalogEntries.map(([type, definition]) => [definition.legacyType, [type, definition]]),
);

export function isAgentEventType(value: unknown): value is AgentEventType {
  return typeof value === 'string' && Object.hasOwn(agentEventCatalog, value);
}

function definitionForEvent(event: AgentEvent): [AgentEventType, CatalogEntry] | undefined {
  return catalogByLegacyType.get(event.type);
}

export function agentEventService<T extends AgentEvent>(event: T): AgentEventServiceOf<T> {
  const definition = definitionForEvent(event);
  // Compatibility for pre-catalog adapters and deliberately malformed reducer
  // tests. Runtime candidate validation will remove this deprecated fallback.
  return (definition?.[1].category ?? 'state') as AgentEventServiceOf<T>;
}

export function agentServiceEventType<T extends AgentEvent>(event: T): AgentServiceEventTypeFor<T> {
  const definition = definitionForEvent(event);
  return (definition?.[0] ?? `state:${event.type.replaceAll('.', '-')}`) as AgentServiceEventTypeFor<T>;
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

/** The payload schema excludes the temporary dotted compatibility discriminator. */
export function agentEventPayloadSchema<Type extends AgentEventType>(
  type: Type,
): z.ZodType<Omit<AgentEventForType<Type>, 'type'>> {
  const schema = agentEventCatalog[type].schema as z.ZodObject;
  return schema.omit({ type: true }) as unknown as z.ZodType<Omit<AgentEventForType<Type>, 'type'>>;
}

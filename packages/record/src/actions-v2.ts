import { createHash } from 'node:crypto';
import type {
  EvidenceCompleteness,
  EvidenceQuality,
  ExternalRef,
  NativeSessionRef,
  ProcessExitReason,
  RuntimeRunId,
  WorkspaceInstanceId,
} from '@vibecook/puppeteer-core';

export const OWN_ACTION_SCHEMA_VERSION = 2 as const;
export const MAX_PERSISTED_PROMPT_BODY_BYTES = 1024 * 1024;

export interface OwnActionEvidenceRef {
  namespace: string;
  id: string;
  revisionKey?: string;
}

/** Keyed, non-secret bridge back to the control-critical creation claim. */
export interface CreationClaimEvidenceRef {
  claimId: string;
  requestFingerprint: string;
}

export interface WorkspaceKeyedFingerprintV2 {
  algorithm: 'hmac-sha256';
  value: string;
}

export type WorkspaceIsolationV2 = 'managed-isolated' | 'cooperative-exclusive' | 'shared' | 'unknown';

export interface WorkspaceChangeSummaryV2 {
  total: number;
  added: number;
  modified: number;
  deleted: number;
  renamed: number;
  copied: number;
  unmerged: number;
  untracked: number;
  other: number;
}

export interface WorkspaceGitObservationV2 {
  state: 'attached' | 'detached' | 'unborn' | 'non-git' | 'unavailable';
  headCommit?: string;
  headRef?: string;
  index: WorkspaceChangeSummaryV2;
  worktree: WorkspaceChangeSummaryV2;
  conflicts: number;
  indexFingerprint?: WorkspaceKeyedFingerprintV2;
  worktreeFingerprint?: WorkspaceKeyedFingerprintV2;
}

export interface WorkspaceReachableCommitRangeV2 {
  relation: 'unchanged' | 'fast-forward' | 'rewritten' | 'created' | 'removed' | 'unavailable';
  initialCommit?: string;
  finalCommit?: string;
  commits: string[];
  totalCount: number;
  truncated: boolean;
}

export interface WorkspaceInterferenceObservationV2 {
  kind: 'known-concurrent-claim' | 'baseline-dirty-overlap' | 'repository-identity-changed' | 'observation-gap';
  observedAt: string;
  count?: number;
}

export type WorkspaceFinalizationTriggerV2 =
  'clean-exit' | 'unclassified-exit' | 'crash' | 'cancellation' | 'preparation-failure' | 'runtime-disposal';

export type WorkspaceCleanupOutcomeV2 = 'not-applicable' | 'removed' | 'retained-dirty' | 'failed';

export interface OwnActionV2Base {
  schemaVersion: typeof OWN_ACTION_SCHEMA_VERSION;
  recordId: string;
  runtimeRunId: RuntimeRunId;
  runtimeEpoch: number;
  observedAt: string;
  effectiveAt?: string;
  quality: EvidenceQuality;
  completeness: EvidenceCompleteness;
  terminalSessionId?: string;
  nativeSession?: NativeSessionRef;
  workspaceInstanceId?: WorkspaceInstanceId;
  correctionOfRecordId?: string;
  evidence: OwnActionEvidenceRef[];
}

export interface RunAllocatedActionV2 extends OwnActionV2Base {
  type: 'run.allocated';
  providerId: string;
  operation: 'create' | 'prepare';
  externalRefs: ExternalRef[];
  creationClaim?: CreationClaimEvidenceRef;
}

export interface RunStartFailedActionV2 extends OwnActionV2Base {
  type: 'run.start-failed';
  stage:
    | 'validation'
    | 'provider-lookup'
    | 'workspace'
    | 'process-spawn'
    | 'binding'
    | 'preparation'
    | 'adoption'
    | 'restore';
  code: string;
}

export interface WorkspaceAllocatedActionV2 extends OwnActionV2Base {
  type: 'workspace.allocated';
  workspaceInstanceId: WorkspaceInstanceId;
  mode: 'direct' | 'exclusive' | 'worktree' | 'copy';
  branch?: string;
  repositoryKind?: 'git' | 'directory';
  repositoryDigest?: WorkspaceKeyedFingerprintV2;
  isolation?: WorkspaceIsolationV2;
  knownConcurrentClaims?: number;
}

export interface WorkspaceBaselineActionV2 extends OwnActionV2Base {
  type: 'workspace.baseline';
  workspaceInstanceId: WorkspaceInstanceId;
  initialCommit?: string;
  initialDirtyFileCount: number;
  capturedAt?: string;
  git?: WorkspaceGitObservationV2;
}

export interface ProcessSpawnedActionV2 extends OwnActionV2Base {
  type: 'process.spawned';
  terminalSessionId: string;
  processId?: number;
  restored?: boolean;
}

export interface NativeSessionCorrelatedActionV2 extends OwnActionV2Base {
  type: 'native-session.correlated';
  nativeSession: NativeSessionRef;
  nativeSessionRevision: number;
}

export interface ProcessExitedActionV2 extends OwnActionV2Base {
  type: 'process.exited';
  terminalSessionId: string;
  exitCode: number | null;
  signal?: string | null;
  reason: ProcessExitReason;
}

export interface WorkspaceFinalizedActionV2 extends OwnActionV2Base {
  type: 'workspace.finalized';
  workspaceInstanceId: WorkspaceInstanceId;
  initialCommit?: string;
  finalCommit?: string;
  filesTouchedCount: number;
  insertions: number;
  deletions: number;
  retained: boolean;
  outcome?: 'complete' | 'partial' | 'unavailable';
  trigger?: WorkspaceFinalizationTriggerV2;
  cleanupOutcome?: WorkspaceCleanupOutcomeV2;
  git?: WorkspaceGitObservationV2;
  reachableCommits?: WorkspaceReachableCommitRangeV2;
  filesFingerprint?: WorkspaceKeyedFingerprintV2;
  interference?: WorkspaceInterferenceObservationV2[];
  knownConcurrentClaims?: number;
}

export interface WorkspaceFinalizationFailedActionV2 extends OwnActionV2Base {
  type: 'workspace.finalization-failed';
  workspaceInstanceId: WorkspaceInstanceId;
  code: string;
  outcome?: 'failed' | 'unavailable';
  trigger?: WorkspaceFinalizationTriggerV2;
  cleanupOutcome?: WorkspaceCleanupOutcomeV2;
  retained?: boolean;
}

export interface InjectionPromptDigest {
  algorithm: 'hmac-sha256';
  value: string;
}

export interface InjectionReceiptActionV2 extends OwnActionV2Base {
  type: 'injection.receipt';
  injectionId: string;
  promptByteLength: number;
  promptPersistence: 'metadata-only' | 'keyed-digest' | 'body' | 'body-too-large';
  promptDigest?: InjectionPromptDigest;
  /** Present only under the explicitly unsafe `body` persistence policy. */
  promptBody?: string;
  outcome: 'confirmed' | 'rejected' | 'uncertain';
  reasonPresent?: boolean;
  turnId?: string;
}

export interface ArtifactReadActionV2 extends OwnActionV2Base {
  type: 'artifact.read';
  artifactId: string;
  maxBytes: number;
  outcome: 'ok' | 'denied' | 'unavailable' | 'too-large';
  returnedBytes?: number;
  mediaType?: string;
}

export interface PolicyConflictActionV2 extends OwnActionV2Base {
  type: 'policy.conflict';
  code: string;
  policy: 'workspace-isolation' | 'runtime-identity' | 'other';
}

export type OwnActionV2 =
  | RunAllocatedActionV2
  | RunStartFailedActionV2
  | WorkspaceAllocatedActionV2
  | WorkspaceBaselineActionV2
  | ProcessSpawnedActionV2
  | NativeSessionCorrelatedActionV2
  | ProcessExitedActionV2
  | WorkspaceFinalizedActionV2
  | WorkspaceFinalizationFailedActionV2
  | InjectionReceiptActionV2
  | ArtifactReadActionV2
  | PolicyConflictActionV2;

type ToInput<T> = T extends OwnActionV2
  ? Omit<T, 'schemaVersion' | 'observedAt' | 'evidence'> & {
      observedAt?: string;
      evidence?: readonly OwnActionEvidenceRef[];
    }
  : never;

export type OwnActionV2Input = ToInput<OwnActionV2>;

export type OwnActionV2InputFor<TType extends OwnActionV2['type']> = ToInput<Extract<OwnActionV2, { type: TType }>>;

export type InjectionReceiptActionV2Input = Omit<
  ToInput<InjectionReceiptActionV2>,
  'promptByteLength' | 'promptPersistence' | 'promptDigest' | 'promptBody'
> & {
  prompt: string;
};

/** Stable across retries; timestamps deliberately do not participate. */
export function createOwnActionRecordId(runtimeRunId: RuntimeRunId, semanticActionKey: string): string {
  if (runtimeRunId.length === 0 || semanticActionKey.length === 0) {
    throw new RangeError('runtimeRunId and semanticActionKey must be non-empty');
  }
  const digest = createHash('sha256')
    .update(JSON.stringify([runtimeRunId, semanticActionKey]))
    .digest('hex');
  return `own:${digest}`;
}

export function isOwnActionV2(value: unknown): value is OwnActionV2 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Partial<OwnActionV2>;
  return (
    record.schemaVersion === OWN_ACTION_SCHEMA_VERSION &&
    typeof record.recordId === 'string' &&
    record.recordId.length > 0 &&
    typeof record.runtimeRunId === 'string' &&
    record.runtimeRunId.length > 0 &&
    Number.isSafeInteger(record.runtimeEpoch) &&
    record.runtimeEpoch! > 0 &&
    typeof record.observedAt === 'string' &&
    typeof record.type === 'string' &&
    Array.isArray(record.evidence)
  );
}

function boundedString(value: unknown, field: string, maxBytes = 512): string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new TypeError(`${field} must be a non-empty string of at most ${maxBytes} UTF-8 bytes`);
  }
  return value;
}

function boundedPossiblyEmptyString(value: unknown, field: string, maxBytes: number): string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new TypeError(`${field} must be a string of at most ${maxBytes} UTF-8 bytes`);
  }
  return value;
}

function optionalString(value: unknown, field: string, maxBytes = 512): string | undefined {
  return value === undefined ? undefined : boundedString(value, field, maxBytes);
}

function optionalNullableString(value: unknown, field: string, maxBytes = 512): string | null | undefined {
  return value === null ? null : optionalString(value, field, maxBytes);
}

function enumValue<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new TypeError(`${field} is invalid`);
  }
  return value as T;
}

function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`${field} must be a boolean`);
  return value;
}

function timestamp(value: unknown, field: string): string {
  const result = boundedString(value, field, 64);
  if (!Number.isFinite(Date.parse(result))) throw new TypeError(`${field} must be an ISO-compatible timestamp`);
  return result;
}

function nonnegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer`);
  }
  return value as number;
}

function optionalPositiveInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new TypeError(`${field} must be a positive safe integer`);
  }
  return value as number;
}

function copyNativeSession(value: NativeSessionRef | undefined): NativeSessionRef | undefined {
  if (value === undefined) return undefined;
  const basis = value.basis;
  const quality = value.quality;
  if (!['configured', 'observed', 'inferred'].includes(basis)) throw new TypeError('nativeSession.basis is invalid');
  if (!['exact', 'strong', 'derived', 'estimated', 'inferred', 'unknown'].includes(quality)) {
    throw new TypeError('nativeSession.quality is invalid');
  }
  return {
    namespace: boundedString(value.namespace, 'nativeSession.namespace', 64),
    id: boundedString(value.id, 'nativeSession.id', 1024),
    basis,
    quality,
  };
}

function copyEvidence(values: readonly OwnActionEvidenceRef[] | undefined): OwnActionEvidenceRef[] {
  if (values === undefined) return [];
  if (!Array.isArray(values) || values.length > 64) throw new TypeError('evidence must contain at most 64 entries');
  return values.map((value, index) => ({
    namespace: boundedString(value.namespace, `evidence[${index}].namespace`, 64),
    id: boundedString(value.id, `evidence[${index}].id`, 512),
    ...(value.revisionKey === undefined
      ? {}
      : { revisionKey: boundedString(value.revisionKey, `evidence[${index}].revisionKey`, 256) }),
  }));
}

function copyExternalRefs(values: readonly ExternalRef[]): ExternalRef[] {
  if (!Array.isArray(values) || values.length > 32) throw new TypeError('externalRefs must contain at most 32 entries');
  return values.map((value, index) => {
    if (!['project', 'contributor', 'workflow', 'caller', 'other'].includes(value.kind)) {
      throw new TypeError(`externalRefs[${index}].kind is invalid`);
    }
    return {
      namespace: boundedString(value.namespace, `externalRefs[${index}].namespace`, 64),
      id: boundedString(value.id, `externalRefs[${index}].id`, 256),
      kind: value.kind,
    };
  });
}

function copyWorkspaceFingerprint(
  value: WorkspaceKeyedFingerprintV2 | undefined,
  field: string,
): WorkspaceKeyedFingerprintV2 | undefined {
  if (value === undefined) return undefined;
  if (value.algorithm !== 'hmac-sha256' || !/^[0-9a-f]{64}$/.test(value.value)) {
    throw new TypeError(`${field} must be a keyed HMAC-SHA256 fingerprint`);
  }
  return { algorithm: 'hmac-sha256', value: value.value };
}

function copyWorkspaceChangeSummary(value: WorkspaceChangeSummaryV2, field: string): WorkspaceChangeSummaryV2 {
  return {
    total: nonnegativeInteger(value.total, `${field}.total`),
    added: nonnegativeInteger(value.added, `${field}.added`),
    modified: nonnegativeInteger(value.modified, `${field}.modified`),
    deleted: nonnegativeInteger(value.deleted, `${field}.deleted`),
    renamed: nonnegativeInteger(value.renamed, `${field}.renamed`),
    copied: nonnegativeInteger(value.copied, `${field}.copied`),
    unmerged: nonnegativeInteger(value.unmerged, `${field}.unmerged`),
    untracked: nonnegativeInteger(value.untracked, `${field}.untracked`),
    other: nonnegativeInteger(value.other, `${field}.other`),
  };
}

function copyWorkspaceGitObservation(
  value: WorkspaceGitObservationV2 | undefined,
  field: string,
): WorkspaceGitObservationV2 | undefined {
  if (value === undefined) return undefined;
  const headCommit = optionalString(value.headCommit, `${field}.headCommit`, 256);
  const headRef = optionalString(value.headRef, `${field}.headRef`, 512);
  const indexFingerprint = copyWorkspaceFingerprint(value.indexFingerprint, `${field}.indexFingerprint`);
  const worktreeFingerprint = copyWorkspaceFingerprint(value.worktreeFingerprint, `${field}.worktreeFingerprint`);
  return {
    state: enumValue(value.state, `${field}.state`, ['attached', 'detached', 'unborn', 'non-git', 'unavailable']),
    ...(headCommit === undefined ? {} : { headCommit }),
    ...(headRef === undefined ? {} : { headRef }),
    index: copyWorkspaceChangeSummary(value.index, `${field}.index`),
    worktree: copyWorkspaceChangeSummary(value.worktree, `${field}.worktree`),
    conflicts: nonnegativeInteger(value.conflicts, `${field}.conflicts`),
    ...(indexFingerprint === undefined ? {} : { indexFingerprint }),
    ...(worktreeFingerprint === undefined ? {} : { worktreeFingerprint }),
  };
}

function copyWorkspaceReachableCommits(
  value: WorkspaceReachableCommitRangeV2 | undefined,
): WorkspaceReachableCommitRangeV2 | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value.commits) || value.commits.length > 1_024) {
    throw new TypeError('reachableCommits.commits must contain at most 1024 entries');
  }
  const commits = value.commits.map((commit, index) =>
    boundedString(commit, `reachableCommits.commits[${index}]`, 256),
  );
  const totalCount = nonnegativeInteger(value.totalCount, 'reachableCommits.totalCount');
  const truncated = booleanValue(value.truncated, 'reachableCommits.truncated');
  if (totalCount < commits.length || (!truncated && totalCount !== commits.length)) {
    throw new TypeError('reachableCommits totalCount/truncated fields are inconsistent');
  }
  const initialCommit = optionalString(value.initialCommit, 'reachableCommits.initialCommit', 256);
  const finalCommit = optionalString(value.finalCommit, 'reachableCommits.finalCommit', 256);
  return {
    relation: enumValue(value.relation, 'reachableCommits.relation', [
      'unchanged',
      'fast-forward',
      'rewritten',
      'created',
      'removed',
      'unavailable',
    ]),
    ...(initialCommit === undefined ? {} : { initialCommit }),
    ...(finalCommit === undefined ? {} : { finalCommit }),
    commits,
    totalCount,
    truncated,
  };
}

function copyWorkspaceInterference(
  values: readonly WorkspaceInterferenceObservationV2[] | undefined,
): WorkspaceInterferenceObservationV2[] | undefined {
  if (values === undefined) return undefined;
  if (!Array.isArray(values) || values.length > 64) {
    throw new TypeError('interference must contain at most 64 entries');
  }
  return values.map((value, index) => {
    const count = optionalPositiveInteger(value.count, `interference[${index}].count`);
    return {
      kind: enumValue(value.kind, `interference[${index}].kind`, [
        'known-concurrent-claim',
        'baseline-dirty-overlap',
        'repository-identity-changed',
        'observation-gap',
      ]),
      observedAt: timestamp(value.observedAt, `interference[${index}].observedAt`),
      ...(count === undefined ? {} : { count }),
    };
  });
}

function commonFields(input: OwnActionV2Input, observedAt: string): OwnActionV2Base {
  if (!Number.isSafeInteger(input.runtimeEpoch) || input.runtimeEpoch < 1) {
    throw new TypeError('runtimeEpoch must be a positive safe integer');
  }
  if (!['exact', 'strong', 'derived', 'estimated', 'inferred', 'unknown'].includes(input.quality)) {
    throw new TypeError('quality is invalid');
  }
  if (!['complete', 'partial', 'unavailable'].includes(input.completeness)) {
    throw new TypeError('completeness is invalid');
  }
  const terminalSessionId = optionalString(input.terminalSessionId, 'terminalSessionId');
  const nativeSession = copyNativeSession(input.nativeSession);
  const workspaceInstanceId = optionalString(input.workspaceInstanceId, 'workspaceInstanceId', 256);
  const correctionOfRecordId = optionalString(input.correctionOfRecordId, 'correctionOfRecordId', 256);
  const effectiveAt = input.effectiveAt === undefined ? undefined : timestamp(input.effectiveAt, 'effectiveAt');
  return {
    schemaVersion: OWN_ACTION_SCHEMA_VERSION,
    recordId: boundedString(input.recordId, 'recordId', 256),
    runtimeRunId: boundedString(input.runtimeRunId, 'runtimeRunId', 256),
    runtimeEpoch: input.runtimeEpoch,
    observedAt: timestamp(input.observedAt ?? observedAt, 'observedAt'),
    quality: input.quality,
    completeness: input.completeness,
    evidence: copyEvidence(input.evidence),
    ...(effectiveAt === undefined ? {} : { effectiveAt }),
    ...(terminalSessionId === undefined ? {} : { terminalSessionId }),
    ...(nativeSession === undefined ? {} : { nativeSession }),
    ...(workspaceInstanceId === undefined ? {} : { workspaceInstanceId }),
    ...(correctionOfRecordId === undefined ? {} : { correctionOfRecordId }),
  };
}

/** Selects only schema-owned fields; arbitrary input properties never reach JSONL. */
export function normalizeOwnActionV2Input(
  input: OwnActionV2Input,
  observedAt: string,
  options: { allowInjectionContent?: boolean } = {},
): OwnActionV2 {
  const common = commonFields(input, observedAt);
  switch (input.type) {
    case 'run.allocated':
      return {
        ...common,
        type: input.type,
        providerId: boundedString(input.providerId, 'providerId', 128),
        operation: enumValue(input.operation, 'operation', ['create', 'prepare']),
        externalRefs: copyExternalRefs(input.externalRefs),
        ...(input.creationClaim
          ? {
              creationClaim: {
                claimId: boundedString(input.creationClaim.claimId, 'creationClaim.claimId', 128),
                requestFingerprint: boundedString(
                  input.creationClaim.requestFingerprint,
                  'creationClaim.requestFingerprint',
                  128,
                ),
              },
            }
          : {}),
      };
    case 'run.start-failed':
      return {
        ...common,
        type: input.type,
        stage: enumValue(input.stage, 'stage', [
          'validation',
          'provider-lookup',
          'workspace',
          'process-spawn',
          'binding',
          'preparation',
          'adoption',
          'restore',
        ]),
        code: boundedString(input.code, 'code', 128),
      };
    case 'workspace.allocated': {
      const repositoryDigest = copyWorkspaceFingerprint(input.repositoryDigest, 'repositoryDigest');
      const knownConcurrentClaims =
        input.knownConcurrentClaims === undefined
          ? undefined
          : nonnegativeInteger(input.knownConcurrentClaims, 'knownConcurrentClaims');
      return {
        ...common,
        type: input.type,
        workspaceInstanceId: boundedString(input.workspaceInstanceId, 'workspaceInstanceId', 256),
        mode: enumValue(input.mode, 'mode', ['direct', 'exclusive', 'worktree', 'copy']),
        ...(input.branch === undefined ? {} : { branch: boundedString(input.branch, 'branch', 512) }),
        ...(input.repositoryKind === undefined
          ? {}
          : { repositoryKind: enumValue(input.repositoryKind, 'repositoryKind', ['git', 'directory'] as const) }),
        ...(repositoryDigest === undefined ? {} : { repositoryDigest }),
        ...(input.isolation === undefined
          ? {}
          : {
              isolation: enumValue(input.isolation, 'isolation', [
                'managed-isolated',
                'cooperative-exclusive',
                'shared',
                'unknown',
              ] as const),
            }),
        ...(knownConcurrentClaims === undefined ? {} : { knownConcurrentClaims }),
      };
    }
    case 'workspace.baseline': {
      const capturedAt = input.capturedAt === undefined ? undefined : timestamp(input.capturedAt, 'capturedAt');
      const workspaceGit = copyWorkspaceGitObservation(input.git, 'git');
      return {
        ...common,
        type: input.type,
        workspaceInstanceId: boundedString(input.workspaceInstanceId, 'workspaceInstanceId', 256),
        ...(input.initialCommit === undefined
          ? {}
          : { initialCommit: boundedString(input.initialCommit, 'initialCommit', 256) }),
        initialDirtyFileCount: nonnegativeInteger(input.initialDirtyFileCount, 'initialDirtyFileCount'),
        ...(capturedAt === undefined ? {} : { capturedAt }),
        ...(workspaceGit === undefined ? {} : { git: workspaceGit }),
      };
    }
    case 'process.spawned': {
      const processId = optionalPositiveInteger(input.processId, 'processId');
      return {
        ...common,
        type: input.type,
        terminalSessionId: boundedString(input.terminalSessionId, 'terminalSessionId'),
        ...(processId === undefined ? {} : { processId }),
        ...(input.restored === undefined ? {} : { restored: booleanValue(input.restored, 'restored') }),
      };
    }
    case 'native-session.correlated':
      return {
        ...common,
        type: input.type,
        nativeSession: copyNativeSession(input.nativeSession)!,
        nativeSessionRevision: optionalPositiveInteger(input.nativeSessionRevision, 'nativeSessionRevision')!,
      };
    case 'process.exited': {
      if (
        ![
          'completed',
          'user-terminated',
          'runtime-terminated',
          'signal',
          'crash',
          'spawn-failed',
          'workspace-failed',
          'unknown',
        ].includes(input.reason)
      ) {
        throw new TypeError('process exit reason is invalid');
      }
      const signal = optionalNullableString(input.signal, 'signal', 64);
      return {
        ...common,
        type: input.type,
        terminalSessionId: boundedString(input.terminalSessionId, 'terminalSessionId'),
        exitCode: input.exitCode === null ? null : nonnegativeInteger(input.exitCode, 'exitCode'),
        ...(signal === undefined ? {} : { signal }),
        reason: input.reason,
      };
    }
    case 'workspace.finalized': {
      const workspaceGit = copyWorkspaceGitObservation(input.git, 'git');
      const reachableCommits = copyWorkspaceReachableCommits(input.reachableCommits);
      const filesFingerprint = copyWorkspaceFingerprint(input.filesFingerprint, 'filesFingerprint');
      const interference = copyWorkspaceInterference(input.interference);
      const knownConcurrentClaims =
        input.knownConcurrentClaims === undefined
          ? undefined
          : nonnegativeInteger(input.knownConcurrentClaims, 'knownConcurrentClaims');
      return {
        ...common,
        type: input.type,
        workspaceInstanceId: boundedString(input.workspaceInstanceId, 'workspaceInstanceId', 256),
        ...(input.initialCommit === undefined
          ? {}
          : { initialCommit: boundedString(input.initialCommit, 'initialCommit', 256) }),
        ...(input.finalCommit === undefined
          ? {}
          : { finalCommit: boundedString(input.finalCommit, 'finalCommit', 256) }),
        filesTouchedCount: nonnegativeInteger(input.filesTouchedCount, 'filesTouchedCount'),
        insertions: nonnegativeInteger(input.insertions, 'insertions'),
        deletions: nonnegativeInteger(input.deletions, 'deletions'),
        retained: booleanValue(input.retained, 'retained'),
        ...(input.outcome === undefined
          ? {}
          : { outcome: enumValue(input.outcome, 'outcome', ['complete', 'partial', 'unavailable'] as const) }),
        ...(input.trigger === undefined
          ? {}
          : {
              trigger: enumValue(input.trigger, 'trigger', [
                'clean-exit',
                'unclassified-exit',
                'crash',
                'cancellation',
                'preparation-failure',
                'runtime-disposal',
              ] as const),
            }),
        ...(input.cleanupOutcome === undefined
          ? {}
          : {
              cleanupOutcome: enumValue(input.cleanupOutcome, 'cleanupOutcome', [
                'not-applicable',
                'removed',
                'retained-dirty',
                'failed',
              ] as const),
            }),
        ...(workspaceGit === undefined ? {} : { git: workspaceGit }),
        ...(reachableCommits === undefined ? {} : { reachableCommits }),
        ...(filesFingerprint === undefined ? {} : { filesFingerprint }),
        ...(interference === undefined ? {} : { interference }),
        ...(knownConcurrentClaims === undefined ? {} : { knownConcurrentClaims }),
      };
    }
    case 'workspace.finalization-failed':
      return {
        ...common,
        type: input.type,
        workspaceInstanceId: boundedString(input.workspaceInstanceId, 'workspaceInstanceId', 256),
        code: boundedString(input.code, 'code', 128),
        ...(input.outcome === undefined
          ? {}
          : { outcome: enumValue(input.outcome, 'outcome', ['failed', 'unavailable'] as const) }),
        ...(input.trigger === undefined
          ? {}
          : {
              trigger: enumValue(input.trigger, 'trigger', [
                'clean-exit',
                'unclassified-exit',
                'crash',
                'cancellation',
                'preparation-failure',
                'runtime-disposal',
              ] as const),
            }),
        ...(input.cleanupOutcome === undefined
          ? {}
          : {
              cleanupOutcome: enumValue(input.cleanupOutcome, 'cleanupOutcome', [
                'not-applicable',
                'removed',
                'retained-dirty',
                'failed',
              ] as const),
            }),
        ...(input.retained === undefined ? {} : { retained: booleanValue(input.retained, 'retained') }),
      };
    case 'injection.receipt': {
      if ((input.promptBody !== undefined || input.promptDigest !== undefined) && !options.allowInjectionContent) {
        throw new TypeError('injection prompt persistence must use the configured recorder policy');
      }
      const promptDigest = input.promptDigest;
      if (
        promptDigest !== undefined &&
        (promptDigest.algorithm !== 'hmac-sha256' || !/^[0-9a-f]{64}$/.test(promptDigest.value))
      ) {
        throw new TypeError('promptDigest must be a keyed HMAC-SHA256 digest');
      }
      const promptPersistence = enumValue(input.promptPersistence, 'promptPersistence', [
        'metadata-only',
        'keyed-digest',
        'body',
        'body-too-large',
      ]);
      const promptBody =
        input.promptBody === undefined
          ? undefined
          : boundedPossiblyEmptyString(input.promptBody, 'promptBody', MAX_PERSISTED_PROMPT_BODY_BYTES);
      if (promptPersistence === 'keyed-digest' && promptDigest === undefined) {
        throw new TypeError('keyed-digest prompt persistence requires promptDigest');
      }
      if (promptPersistence === 'body' && promptBody === undefined) {
        throw new TypeError('body prompt persistence requires promptBody');
      }
      if (promptPersistence !== 'keyed-digest' && promptDigest !== undefined) {
        throw new TypeError(`${promptPersistence} prompt persistence cannot contain promptDigest`);
      }
      if (promptPersistence !== 'body' && promptBody !== undefined) {
        throw new TypeError(`${promptPersistence} prompt persistence cannot contain promptBody`);
      }
      const promptByteLength = nonnegativeInteger(input.promptByteLength, 'promptByteLength');
      if (promptBody !== undefined && Buffer.byteLength(promptBody, 'utf8') !== promptByteLength) {
        throw new TypeError('promptBody UTF-8 length must equal promptByteLength');
      }
      return {
        ...common,
        type: input.type,
        injectionId: boundedString(input.injectionId, 'injectionId', 256),
        promptByteLength,
        promptPersistence,
        ...(promptDigest === undefined ? {} : { promptDigest: { ...promptDigest } }),
        ...(promptBody === undefined ? {} : { promptBody }),
        outcome: enumValue(input.outcome, 'outcome', ['confirmed', 'rejected', 'uncertain']),
        ...(input.reasonPresent === undefined
          ? {}
          : { reasonPresent: booleanValue(input.reasonPresent, 'reasonPresent') }),
        ...(input.turnId === undefined ? {} : { turnId: boundedString(input.turnId, 'turnId', 512) }),
      };
    }
    case 'artifact.read': {
      const returnedBytes =
        input.returnedBytes === undefined ? undefined : nonnegativeInteger(input.returnedBytes, 'returnedBytes');
      return {
        ...common,
        type: input.type,
        artifactId: boundedString(input.artifactId, 'artifactId', 512),
        maxBytes: nonnegativeInteger(input.maxBytes, 'maxBytes'),
        outcome: enumValue(input.outcome, 'outcome', ['ok', 'denied', 'unavailable', 'too-large']),
        ...(returnedBytes === undefined ? {} : { returnedBytes }),
        ...(input.mediaType === undefined ? {} : { mediaType: boundedString(input.mediaType, 'mediaType', 128) }),
      };
    }
    case 'policy.conflict':
      return {
        ...common,
        type: input.type,
        code: boundedString(input.code, 'code', 128),
        policy: enumValue(input.policy, 'policy', ['workspace-isolation', 'runtime-identity', 'other']),
      };
  }
}

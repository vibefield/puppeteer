import { z } from 'zod';

const FilePathSchema = z.string().min(1);
const CountSchema = z.number().int().nonnegative().safe();

/** What kind of filesystem mutation the native surface identifies. */
export const WorkspaceFileChangeKindSchema = z.enum(['create', 'modify', 'delete', 'move', 'unknown']);
export type WorkspaceFileChangeKind = z.infer<typeof WorkspaceFileChangeKindSchema>;

/** The native value that supplied one particular change-detail representation. */
export const WorkspaceFileChangeDetailBasisSchema = z.enum(['tool-input', 'tool-result', 'native-file-operation']);
export type WorkspaceFileChangeDetailBasis = z.infer<typeof WorkspaceFileChangeDetailBasisSchema>;

/**
 * Native detail representations remain explicit instead of pretending every
 * provider emits a raw unified diff. `diff-preview` is presentation evidence,
 * not an applicable patch. `basis` describes this detail only; lifecycle phase
 * is established independently by the enclosing operation. In `content`, null
 * means the provider explicitly reported that side as absent; omission means it
 * was not reported.
 */
export const WorkspaceFileChangeDetailSchema = z.discriminatedUnion('representation', [
  z.strictObject({
    representation: z.literal('unified-diff'),
    basis: WorkspaceFileChangeDetailBasisSchema,
    text: z.string(),
  }),
  z.strictObject({
    representation: z.literal('diff-preview'),
    basis: WorkspaceFileChangeDetailBasisSchema,
    text: z.string(),
    completeness: z.enum(['complete', 'truncated', 'unknown']),
  }),
  z
    .strictObject({
      representation: z.literal('content'),
      basis: WorkspaceFileChangeDetailBasisSchema,
      before: z.string().nullable().optional(),
      after: z.string().nullable().optional(),
    })
    .refine((detail) => Object.hasOwn(detail, 'before') || Object.hasOwn(detail, 'after'), {
      message: 'content detail must report before, after, or both',
    }),
  z.strictObject({
    representation: z.literal('write'),
    basis: WorkspaceFileChangeDetailBasisSchema,
    content: z.string(),
    mode: z.enum(['overwrite', 'append', 'unknown']),
  }),
  z.strictObject({
    representation: z.literal('replacement'),
    basis: WorkspaceFileChangeDetailBasisSchema,
    oldText: z.string(),
    newText: z.string(),
    replaceAll: z.boolean().optional(),
  }),
]);
export type WorkspaceFileChangeDetail = z.infer<typeof WorkspaceFileChangeDetailSchema>;

/**
 * One provider-neutral file mutation. `path` is the original path for moves.
 * Multiple details preserve complementary native representations instead of
 * overwriting exact input with a weaker result preview (or vice versa).
 */
export const WorkspaceFileChangeSchema = z
  .strictObject({
    path: FilePathSchema,
    kind: WorkspaceFileChangeKindSchema,
    newPath: FilePathSchema.optional(),
    details: z.array(WorkspaceFileChangeDetailSchema).min(1).optional(),
    additions: CountSchema.optional(),
    deletions: CountSchema.optional(),
  })
  .superRefine((change, context) => {
    if (change.newPath !== undefined && change.kind !== 'move') {
      context.addIssue({ code: 'custom', message: 'newPath is valid only for move changes', path: ['newPath'] });
    }
    const identities = new Set<string>();
    for (const [index, detail] of (change.details ?? []).entries()) {
      const identity = `${detail.basis}:${detail.representation}`;
      if (identities.has(identity)) {
        context.addIssue({
          code: 'custom',
          message: 'duplicate detail representation for the same evidence basis',
          path: ['details', index],
        });
      }
      identities.add(identity);
    }
  });
export type WorkspaceFileChange = z.infer<typeof WorkspaceFileChangeSchema>;

export const WorkspaceFileOperationPhaseSchema = z.enum(['proposed', 'in-progress', 'applied', 'failed']);
export type WorkspaceFileOperationPhase = z.infer<typeof WorkspaceFileOperationPhaseSchema>;

/**
 * An agent-owned file operation lifecycle update. A proposed operation is not
 * a filesystem mutation. `applied` means the native operation reported
 * success; it is not independent post-operation disk verification. Consumers
 * that require observation use the separate `workspace:file-changed` route.
 */
export const WorkspaceFileOperationEventSchema = z.strictObject({
  type: z.literal('workspace:file-operation'),
  toolCallId: z.string().trim().min(1),
  phase: WorkspaceFileOperationPhaseSchema,
  changes: z.array(WorkspaceFileChangeSchema).min(1),
});
export type WorkspaceFileOperationEvent = z.infer<typeof WorkspaceFileOperationEventSchema>;

/** Direct native filesystem observation, which may not identify the causing tool. */
export const WorkspaceFileChangedEventSchema = z.strictObject({
  type: z.literal('workspace:file-changed'),
  changes: z.array(WorkspaceFileChangeSchema).min(1),
});
export type WorkspaceFileChangedEvent = z.infer<typeof WorkspaceFileChangedEventSchema>;

export type WorkspaceEvent = WorkspaceFileOperationEvent | WorkspaceFileChangedEvent;
export const WorkspaceEventSchema = z.discriminatedUnion('type', [
  WorkspaceFileOperationEventSchema,
  WorkspaceFileChangedEventSchema,
]);

/** Programmatic prompt submission through a provider control capability. */
export interface PromptSubmission {
  text: string;
  /** Paste-and-submit is the default; paste-only leaves native-TUI text staged. */
  mode?: 'paste-and-submit' | 'paste-only';
  confirmationTimeoutMs?: number;
}

export type PromptReceipt =
  | { status: 'confirmed'; turnId?: string }
  | { status: 'rejected'; reason: string }
  | { status: 'uncertain'; reason: string };

export interface AgentPromptService {
  submit(submission: PromptSubmission): Promise<PromptReceipt>;
}

import type { AgentEvent } from '@vibefield/puppeteer-core';

export interface ClaudeHookPayload {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  prompt_id?: string;
  [key: string]: unknown;
}

export interface NormalizedHook {
  events: AgentEvent[];
  diagnostics: ClaudeHookDiagnostic[];
  sessionId?: string | undefined;
  transcriptPath?: string | undefined;
  promptId?: string | undefined;
  turnId?: string | undefined;
  agentId?: string | undefined;
  agentType?: string | undefined;
  providerVersion?: string | undefined;
}

export interface ClaudeHookDiagnostic {
  code: 'malformed-known-hook' | 'permission-outlived-turn';
  hookEventName: string;
  issues: string[];
}

export interface PendingPermission {
  requestId: string;
  promptId?: string | undefined;
  /** The subagent that asked; absent for the main thread. */
  agentId?: string | undefined;
  agentType?: string | undefined;
  toolName: string;
  inputKey: string;
  toolCallId?: string | undefined;
}

export interface RecentToolRequest {
  toolCallId: string;
  promptId?: string | undefined;
  toolName: string;
  inputKey: string;
  input?: unknown;
  permissionRequestId?: string | undefined;
  questionRequestId?: string | undefined;
}

export interface PendingQuestion {
  requestId: string;
  promptId?: string | undefined;
  toolCallId: string;
}

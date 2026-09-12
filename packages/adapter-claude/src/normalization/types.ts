import type { AgentEvent } from '@vibecook/puppeteer-core';

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
  sessionId?: string;
  transcriptPath?: string;
  promptId?: string;
  turnId?: string;
  agentId?: string;
  agentType?: string;
  providerVersion?: string;
}

export interface ClaudeHookDiagnostic {
  code: 'malformed-known-hook' | 'permission-outlived-turn';
  hookEventName: string;
  issues: string[];
}

export interface PendingPermission {
  requestId: string;
  promptId?: string;
  toolName: string;
  inputKey: string;
  toolCallId?: string;
}

export interface RecentToolRequest {
  toolCallId: string;
  promptId?: string;
  toolName: string;
  inputKey: string;
  input?: unknown;
  permissionRequestId?: string;
  questionRequestId?: string;
}

export interface PendingQuestion {
  requestId: string;
  promptId?: string;
  toolCallId: string;
}

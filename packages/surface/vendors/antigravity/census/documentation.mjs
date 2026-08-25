/**
 * Curated public-documentation projection for Antigravity CLI 1.1.12.
 *
 * These facts are documentation leads plus exact-byte static presence. They
 * are not runtime evidence, not an Agent Surface Model, and not a support
 * claim. Live rails stay blocked on draft/ANTIGRAVITY-ADAPTATION-PLAN.md §2.
 */

export const DOCUMENTATION_KIND = 'documentation-lead';
export const DOCUMENTATION_REFERENCE_VERSION = 1;

export const DOCUMENTATION_SOURCES = [
  {
    id: 'cli-overview',
    title: 'Antigravity CLI Overview',
    url: 'https://antigravity.google/docs/cli/overview',
  },
  {
    id: 'cli-reference',
    title: 'CLI reference',
    url: 'https://antigravity.google/docs/cli/reference',
  },
  {
    id: 'hooks',
    title: 'Hooks',
    url: 'https://antigravity.google/docs/hooks',
  },
  {
    id: 'statusline',
    title: 'Status line customization',
    url: 'https://antigravity.google/docs/cli/statusline',
  },
  {
    id: 'statusline-command',
    title: 'Status Line Command',
    url: 'https://antigravity.google/docs/cli/commands/statusline',
  },
  {
    id: 'conversations',
    title: 'Managing conversations',
    url: 'https://antigravity.google/docs/cli/conversations',
  },
  {
    id: 'resume',
    title: 'Resume Command',
    url: 'https://antigravity.google/docs/cli/commands/resume',
  },
  {
    id: 'settings',
    title: 'Settings, rendering & keybindings',
    url: 'https://antigravity.google/docs/cli/settings',
  },
  {
    id: 'getting-started',
    title: 'Getting Started',
    url: 'https://antigravity.google/docs/cli/getting-started',
  },
  {
    id: 'changelog-1.1.12',
    title: 'Antigravity CLI Changelog 1.1.12',
    url: 'https://raw.githubusercontent.com/google-antigravity/antigravity-cli/1.1.12/CHANGELOG.md',
  },
  {
    id: 'statusline-example',
    title: 'Official statusline.sh example',
    url: 'https://raw.githubusercontent.com/google-antigravity/antigravity-cli/1.1.12/examples/statusline/statusline.sh',
  },
];

export const HOOK_EVENTS = ['PreToolUse', 'PostToolUse', 'PreInvocation', 'PostInvocation', 'Stop'];
export const PRE_TOOL_DECISIONS = ['allow', 'deny', 'ask', 'force_ask', 'deny_unless_prior_grant'];
export const STOP_CONTINUE_DECISION = 'continue';
export const AGENT_STATES = ['idle', 'thinking', 'working', 'tool_use', 'initializing'];

// Exact byte sequences confirmed in the 1.1.12 darwin-arm64 executable.
// Presence is static only; it does not prove the contract is honored at runtime.
export const STATIC_STRING_CANDIDATES = [
  { id: 'envDisableAutoUpdate', value: 'AGY_CLI_DISABLE_AUTO_UPDATE', kind: 'environment' },
  { id: 'envHideAccountInfo', value: 'AGY_CLI_HIDE_ACCOUNT_INFO', kind: 'environment' },
  { id: 'envDisableLatex', value: 'AGY_CLI_DISABLE_LATEX', kind: 'environment' },
  { id: 'envCmdOutputPercentage', value: 'AGY_CLI_CMD_OUTPUT_PERCENTAGE', kind: 'environment' },
  { id: 'envDisableMermaidAscii', value: 'AGY_CLI_DISABLE_MERMAID_ASCII', kind: 'environment' },
  { id: 'envExperimentalRendering', value: 'AGY_CLI_EXPERIMENTAL_RENDERING', kind: 'environment' },
  { id: 'envForceOsc8', value: 'AGY_CLI_FORCE_OSC8', kind: 'environment' },
  { id: 'envInteractiveHeadless', value: 'AGY_CLI_INTERACTIVE_HEADLESS', kind: 'environment' },
  { id: 'envLogoStyle', value: 'AGY_CLI_LOGO_STYLE', kind: 'environment' },
  { id: 'envNewHarness', value: 'AGY_CLI_NEW_HARNESS', kind: 'environment' },
  { id: 'pathAgentsHooks', value: '.agents/hooks.json', kind: 'path' },
  { id: 'pathGeminiAntigravityCli', value: '.gemini/antigravity-cli', kind: 'path' },
  { id: 'pathGeminiAntigravityDesktop', value: '.gemini/antigravity/', kind: 'path' },
  { id: 'pathGeminiConfig', value: '.gemini/config', kind: 'path' },
  { id: 'pathLastConversations', value: 'last_conversations.json', kind: 'path' },
  { id: 'pathTranscriptJsonl', value: 'transcript.jsonl', kind: 'path' },
  { id: 'pathTranscriptFullJsonl', value: 'transcript_full.jsonl', kind: 'path' },
  { id: 'pathSystemGeneratedLogs', value: '.system_generated/logs', kind: 'path' },
  { id: 'hookPreToolUse', value: 'PreToolUse', kind: 'hook-event' },
  { id: 'hookPostToolUse', value: 'PostToolUse', kind: 'hook-event' },
  { id: 'hookPreInvocation', value: 'PreInvocation', kind: 'hook-event' },
  { id: 'hookPostInvocation', value: 'PostInvocation', kind: 'hook-event' },
  { id: 'hookConversationId', value: 'conversationId', kind: 'hook-field' },
  { id: 'hookTranscriptPath', value: 'transcriptPath', kind: 'hook-field' },
  { id: 'hookArtifactDirectoryPath', value: 'artifactDirectoryPath', kind: 'hook-field' },
  { id: 'hookWorkspacePaths', value: 'workspacePaths', kind: 'hook-field' },
  { id: 'hookStepIdx', value: 'stepIdx', kind: 'hook-field' },
  { id: 'hookFullyIdle', value: 'fullyIdle', kind: 'hook-field' },
  { id: 'hookTerminationReason', value: 'terminationReason', kind: 'hook-field' },
  { id: 'hookInjectSteps', value: 'injectSteps', kind: 'hook-field' },
  { id: 'hookPermissionOverrides', value: 'permissionOverrides', kind: 'hook-field' },
  { id: 'hookForceAsk', value: 'force_ask', kind: 'hook-field' },
  { id: 'hookDenyUnlessPriorGrant', value: 'deny_unless_prior_grant', kind: 'hook-field' },
  { id: 'hookTerminationBehavior', value: 'terminationBehavior', kind: 'hook-field' },
  { id: 'hookForceContinue', value: 'force_continue', kind: 'hook-field' },
  { id: 'hookUnknownPreToolDecision', value: 'unknown pre-tool hook decision', kind: 'hook-field' },
  { id: 'statusConversationId', value: 'conversation_id', kind: 'statusline-field' },
  { id: 'statusTranscriptPath', value: 'transcript_path', kind: 'statusline-field' },
  { id: 'statusAgentState', value: 'agent_state', kind: 'statusline-field' },
  { id: 'statusToolConfirmationPending', value: 'tool_confirmation_pending', kind: 'statusline-field' },
  { id: 'statusPendingInputCount', value: 'pending_input_count', kind: 'statusline-field' },
  { id: 'statusStackWithDefault', value: 'stack_with_default', kind: 'statusline-field' },
  { id: 'statusLineKey', value: 'statusLine', kind: 'statusline-field' },
  { id: 'oracleStreamJson', value: 'stream-json', kind: 'survey-oracle' },
  { id: 'oracleStepUpdate', value: 'step_update', kind: 'survey-oracle' },
  { id: 'oracleToolInfo', value: 'tool_info', kind: 'survey-oracle' },
  { id: 'oracleSubagentInfo', value: 'subagent_info', kind: 'survey-oracle' },
  { id: 'transcriptUserInputType', value: '"type":"USER_INPUT"', kind: 'transcript' },
  { id: 'modelsRequireSignIn', value: 'Please sign in to view available models', kind: 'auth-boundary' },
];

export const REQUIRED_SUBCOMMAND_HELP = [
  { id: 'help-agents', args: ['help', 'agents'] },
  { id: 'help-models', args: ['help', 'models'] },
  { id: 'help-plugin', args: ['help', 'plugin'] },
  { id: 'help-update', args: ['help', 'update'] },
  { id: 'help-install', args: ['help', 'install'] },
  { id: 'help-changelog', args: ['help', 'changelog'] },
  { id: 'agents-help', args: ['agents', '--help'] },
  { id: 'models-help', args: ['models', '--help'] },
  { id: 'plugin-help', args: ['plugin', '--help'] },
  { id: 'update-help', args: ['update', '--help'] },
  { id: 'changelog-help', args: ['changelog', '--help'] },
];

export function scanStaticStringCandidates(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return Object.fromEntries(
    STATIC_STRING_CANDIDATES.map((candidate) => [
      candidate.id,
      {
        value: candidate.value,
        kind: candidate.kind,
        present: buffer.includes(Buffer.from(candidate.value)),
        status: 'unverified-contract',
      },
    ]),
  );
}

export function validateDocumentationReference(docs) {
  const problems = [];
  if (docs?.referenceVersion !== DOCUMENTATION_REFERENCE_VERSION) {
    problems.push('documentation referenceVersion drifted');
  }
  if (docs?.vendor !== 'antigravity' || docs?.vendorVersion !== '1.1.12') {
    problems.push('documentation reference identity must be antigravity@1.1.12');
  }
  if (docs?.kind !== DOCUMENTATION_KIND) {
    problems.push('documentation reference must remain a documentation-lead');
  }
  if (!Array.isArray(docs?.limitations) || docs.limitations.length < 3) {
    problems.push('documentation reference must retain explicit limitations');
  }
  const sources = new Map((docs?.sources ?? []).map((source) => [source.id, source]));
  for (const expected of DOCUMENTATION_SOURCES) {
    const source = sources.get(expected.id);
    if (!source) {
      problems.push(`documentation source missing: ${expected.id}`);
      continue;
    }
    if (source.url !== expected.url) problems.push(`documentation source URL drifted: ${expected.id}`);
    if (source.title !== expected.title) problems.push(`documentation source title drifted: ${expected.id}`);
  }
  const projection = docs?.projection ?? {};
  const hookEvents = projection.hooks?.events ?? [];
  if (JSON.stringify(hookEvents) !== JSON.stringify(HOOK_EVENTS)) {
    problems.push('documentation hook event inventory drifted');
  }
  if (JSON.stringify(projection.hooks?.preToolDecisions ?? []) !== JSON.stringify(PRE_TOOL_DECISIONS)) {
    problems.push('documentation PreToolUse decision inventory drifted');
  }
  if (projection.hooks?.stopContinueDecision !== STOP_CONTINUE_DECISION) {
    problems.push('documentation Stop continue decision drifted');
  }
  if (projection.paths?.cliDataDir !== '~/.gemini/antigravity-cli') {
    problems.push('documentation CLI data directory drifted');
  }
  if (projection.paths?.workspaceHooks !== '.agents/hooks.json') {
    problems.push('documentation workspace hook path drifted');
  }
  if (projection.paths?.globalHooks !== '~/.gemini/config/hooks.json') {
    problems.push('documentation global hook path drifted');
  }
  if (projection.paths?.transcriptTemplate?.includes('<conversationId>') !== true) {
    problems.push('documentation transcript template must keep the conversation UUID join');
  }
  if (projection.statusLine?.configFile !== '~/.gemini/antigravity-cli/settings.json') {
    problems.push('documentation status-line config file drifted');
  }
  if (JSON.stringify(projection.statusLine?.agentStates ?? []) !== JSON.stringify(AGENT_STATES)) {
    problems.push('documentation status-line agent_state inventory drifted');
  }
  if (projection.resume?.explicitFlag !== '--conversation') {
    problems.push('documentation explicit resume flag drifted');
  }
  if (projection.resume?.continueFlag !== '--continue') {
    problems.push('documentation continue flag drifted');
  }
  if (projection.printMode?.startsAgentTurn !== false || projection.printMode?.authorizedToRun !== false) {
    problems.push('documentation print-mode survey oracle must stay unauthorized and non-runtime');
  }
  const serialized = JSON.stringify(docs);
  if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(serialized)) {
    problems.push('documentation reference contains an email-shaped value');
  }
  if (/\/Users\/|\/home\/[a-z]|ya29\.|AIza/i.test(serialized)) {
    problems.push('documentation reference contains a private path or credential-shaped value');
  }
  return problems.sort();
}

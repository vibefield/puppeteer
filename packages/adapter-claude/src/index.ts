/**
 * @vibecook/puppeteer-adapter-claude — Claude Code native adapter
 * (DESIGN §16): hook-event registry, loopback hook bridge, and the
 * hook → AgentEvent normalizer. Detection, settings generation, and the
 * native driver build on these.
 */

export * from './generated/registry.js';
export * from './observation/hook-bridge.js';
export * from './normalization/index.js';
export * from './detection.js';
export * from './launch/settings.js';
export * from './launch/prepare.js';
export * from './launch/native-invocation.js';
export * from './observation/status-channel.js';
export * from './observation/semantic-provider.js';
export * from './observation/otel/index.js';
export * from './observation/transcript/index.js';
export {
  CLAUDE_OAUTH_BETA,
  CLAUDE_OAUTH_CLIENT_ID,
  CLAUDE_OAUTH_TOKEN_ENDPOINT,
  CLAUDE_ACCOUNT_USAGE_PROVIDER,
  CLAUDE_USAGE_ENDPOINT,
  claudeAccountUsageFromStatusLine,
  claudeKeychainService,
  createClaudeAccountUsageService,
  fetchClaudeAccountUsage,
  fetchClaudeAccountUsageForProfile,
  getClaudeStatusLineAccountUsage,
  normalizeClaudeAccountUsage,
  observeClaudeStatusLineAccountUsage,
  onClaudeAccountUsage,
  type FetchClaudeAccountUsageOptions,
} from './services/account-usage.js';
export * from './services/prompt.js';
export * from './services/distribution.js';
export * from './services/profiles.js';
export * from './services/extensions.js';
export * from './driver.js';

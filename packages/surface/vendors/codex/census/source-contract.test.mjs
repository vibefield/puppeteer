import { describe, expect, it } from 'vitest';
import { deriveSourceContract, extractRustItem } from './source-contract.mjs';

// The 0.166.0 shape change in miniature: the enum that held the variant became the payload of a
// struct, so the variant moved owner while its own text stayed the same (findings C9).
const before = `
#[serde(tag = "type")]
pub enum ThreadItem {
    /// A user message.
    UserMessage { id: String },
    #[serde(rename_all = "camelCase")]
    FileChange {
        id: String,
        changes: Vec<FileUpdateChange>,
    },
}
`;
const after = `
pub struct ThreadItem {
    #[serde(flatten)]
    pub payload: ThreadItemPayload,
    pub started_at_ms: Option<i64>,
}

#[serde(tag = "type")]
pub enum ThreadItemPayload {
    /// A user message.
    UserMessage { id: String },
    #[serde(rename_all = "camelCase")]
    FileChange {
        id: String,
        changes: Vec<FileUpdateChange>,
    },
}
`;

describe('the exact-source contract carry-forward', () => {
  it('finds a moved variant byte for byte only under the name it was renamed to', () => {
    const was = extractRustItem(before, 'ThreadItem::FileChange');
    expect(extractRustItem(after, 'ThreadItemPayload::FileChange')).toBe(was);
    expect(was).toContain('#[serde(rename_all = "camelCase")]');
    // The old owner is now a struct without the variant: the carry-forward refuses rather than guesses.
    expect(() => extractRustItem(after, 'ThreadItem::FileChange')).toThrow('variant not found');
  });

  it('refuses a rename of a symbol the previous contract never pinned', async () => {
    await expect(
      deriveSourceContract({
        from: '0.164.0',
        version: '0.166.0',
        sources: '/nonexistent',
        renames: { 'ThreadItem::Bogus': 'ThreadItemPayload::Bogus' },
      }),
    ).rejects.toThrow('--rename ThreadItem::Bogus: not a symbol of references/codex@0.164.0');
  });
});

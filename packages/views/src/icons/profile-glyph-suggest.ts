import { PROFILE_GLYPHS, type ProfileGlyphName } from '@vibefield/puppeteer-view-sdk/toolkit';

// The glyph a new Agent Profile set is offered (RFC 006 "Profile sets"): a
// host's settings suggest one from the set's name. No monitor view draws a
// suggestion, so it stays with the hosts' surface here while the glyphs
// themselves are the SDK's (`PROFILE_GLYPHS` in the toolkit, `ProfileGlyph` in
// `/react`, M6).

/** What a name is for, read from its words; first match wins. */
const SUGGESTIONS: ReadonlyArray<readonly [ProfileGlyphName, readonly string[]]> = [
  ['flask', ['demo', 'test', 'lab', 'experiment', 'sandbox', 'playground', 'trial', 'prototype', 'research']],
  ['briefcase', ['work', 'job', 'office', 'client', 'company', 'business', 'team', 'corp', 'consult', 'freelance']],
  ['house', ['home', 'personal', 'family', 'private', 'me', 'mine', 'own']],
  ['book', ['learn', 'study', 'school', 'course', 'class', 'read', 'docs', 'writing', 'notes']],
  ['gamepad', ['game', 'games', 'play', 'fun', 'hobby']],
  ['rocket', ['launch', 'startup', 'ship', 'side', 'project', 'venture']],
  ['bolt', ['fast', 'quick', 'urgent', 'prod', 'production', 'ops', 'deploy', 'power']],
  ['moon', ['night', 'late', 'weekend', 'evening', 'sleep']],
  ['cup', ['coffee', 'cafe', 'tea', 'break', 'morning']],
  ['leaf', ['garden', 'green', 'nature', 'eco', 'calm', 'open', 'oss', 'community']],
  ['star', ['star', 'favourite', 'favorite', 'main', 'primary', 'best']],
];

/**
 * The glyph a new set's name suggests: a word it recognises, else one picked
 * steadily from the name itself, so two unfamiliar names rarely share a mark
 * and the same name always suggests the same one.
 */
export function suggestProfileGlyph(label: string): ProfileGlyphName {
  const words = label
    .normalize('NFKD')
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((word) => word.length > 0);
  for (const [glyph, cues] of SUGGESTIONS) {
    if (words.some((word) => cues.some((cue) => word === cue || (cue.length >= 4 && word.startsWith(cue))))) {
      return glyph;
    }
  }
  let hash = 0;
  for (const char of label.trim().toLowerCase()) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return PROFILE_GLYPHS[hash % PROFILE_GLYPHS.length]!;
}

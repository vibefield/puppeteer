// The spawn bloom (SB): hold empty ground, reach a desktop, let go on a
// profile. Pure logic — the numbers, the geometry, the menu, targeting, the
// words and the machine — for AgentSwarm and the list view to render.
export * from './constants.js';
export * from './geometry.js';
// The menu's own word only: its reading of the tree is the SDK toolkit's (`menuOf`, `blooms`, …), which a host imports
// from `@vibefield/puppeteer-view-sdk/toolkit` (M54: the views index forwards no SDK name).
export { deviceWord } from './menu.js';
export * from './targeting.js';
export * from './words.js';
export * from './model.js';
export * from './scenarios.js';

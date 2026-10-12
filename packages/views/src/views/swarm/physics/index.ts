// The swarm's physics, with no view attached (ported from VibeField's GT-3c,
// GT-D16): the matter.js world, the wire protocol between a view and its
// physics, the host that speaks it, the frame reader, and an inline driver. A
// host that runs the host in a worker imports these from
// `@vibefield/puppeteer-views/physics` and wires the thread itself.
export * from './world.js';
export * from './protocol.js';
export * from './host.js';
export * from './frame.js';
export * from './inline-driver.js';
// `context.js` (the React provider) is the MAIN entry's: this subpath is what a
// host imports inside its physics WORKER, and a barrel that carried React into
// that graph would pull a renderer into a thread that has none.

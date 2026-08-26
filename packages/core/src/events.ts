/**
 * Compatibility entry point for normalized Agent events.
 *
 * Contracts now live under `events/`, grouped by their public event category.
 * Keep this barrel so existing package-internal and published imports remain
 * stable while the schema-first event shape is migrated incrementally.
 */

export * from './events/index.js';

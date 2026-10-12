/**
 * The host's monitor stage: the element a host mounts the view host and its chrome in (Godview's and VibeField's
 * `<section>`, the labs' too). Host chrome reads it, the usage column to place its popover inside the stage, and the
 * hosts' own stylesheets size it. A view never does: it is handed its stage as `input.stage` (MV-D19) and reaches no
 * host DOM (MV-W2).
 */
export const MONITOR_STAGE_CLASS = 'vf-godview-monitor-stage';

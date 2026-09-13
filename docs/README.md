# Documentation map

The repository keeps current decisions, active work, and history in separate places so a reader can tell whether a document is authoritative from its path.

## Current architecture

- [`architecture.html`](architecture.html) is the top-level visual guide to foundations, layers, repository ownership, conventions, and public contracts.
- [`rfcs/004-layered-agent-runtime.md`](rfcs/004-layered-agent-runtime.md) is the repository-wide layer and dependency model.
- [`rfcs/002-modular-agent-events-and-services.md`](rfcs/002-modular-agent-events-and-services.md) defines category event schemas, `category:event-name` routes, and adapter service ownership.
- [`rfcs/003-native-observation-sources.md`](rfcs/003-native-observation-sources.md) assigns live semantic observation to adapters and retires the Spaghetti runtime dependency.
- [`rfcs/001-evidence-backed-runtime-observation.md`](rfcs/001-evidence-backed-runtime-observation.md) defines the implemented evidence accumulator, three-state monitor, lifecycle, retention, and privacy contract.
- [`rfcs/007-history-search.md`](rfcs/007-history-search.md) adds Godview's Find sheet: transcript search through an external loopback daemon, joined to live runs by native session id.
- [`agent-api.html`](agent-api.html) is the visual Agent API and event-flow reference.
- [`agent-monitor.html`](agent-monitor.html) is the current monitor system diagram and React/Godview interface reference.

## Current developer guides

- [`guides/adapting-an-agent.md`](guides/adapting-an-agent.md) is the end-to-end provider adaptation workflow.
- [`guides/surface-adaptation.md`](guides/surface-adaptation.md) defines evidence ownership, reconciliation, and promotion.
- [`guides/normalization-devkit.md`](guides/normalization-devkit.md) documents the normalization workbench.

## Active work

Unfinished vendor adaptation plans live in [`../draft/`](../draft/). Canonical guides move here; completed designs and rollout plans move to [`archive/`](archive/).

- [`../draft/CLAUDE-TRANSCRIPT-DEPENDENCIES.md`](../draft/CLAUDE-TRANSCRIPT-DEPENDENCIES.md) tracks the Claude transcript dependency audit and removal of transcript-derived live usage, conversation replay, model observation, child transcript scans, workflow journal observation and unused metadata events.
- [`../draft/TRANSCRIPT-SERVICE-NEEDS.md`](../draft/TRANSCRIPT-SERVICE-NEEDS.md) inventories transcript and indexed-history needs across every adapter, Godview and Vibefield, and tracks the keep/remove decisions before designing an app-provided service interface.
- [`../draft/WORKFLOW-TEAM-SUBAGENT-AUDIT.md`](../draft/WORKFLOW-TEAM-SUBAGENT-AUDIT.md) records the completed artifact/team/workflow removal, minimal subagent API, usage/activity aggregation and retained provider sources.

## Historical material

[`archive/`](archive/) preserves rationale that is useful for archaeology but is not an implementation contract. Git history, rather than a permanent live document, retains obsolete operational runbooks and one-off migration instructions.

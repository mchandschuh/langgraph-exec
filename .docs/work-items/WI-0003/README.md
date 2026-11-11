# WI-0003 — Phase 3: bounded loops

## Objective

Deliver release 0.3.0 with explicit bounded loops in YAML graphs. Every loop declares entry, body, exit condition, maximum iterations, and failure behavior; arbitrary cycles remain invalid.

## Scope

- Versioned loop declarations and effective loop limits.
- Validation of cycles, exits, conditions, nested bounds, and graph step budgets.
- LangGraph conditional lowering with graph-owned counters.
- Deterministic early-exit, exhaustion, failure, and observability tests.
- CLI loop inspection plus the full local build/link/release gate.

## Explicit boundaries

Phase 3 does not add checkpointing, interrupt/resume, durable side-effect receipts, or arbitrary unbounded cycles. Live provider execution is not required for unit evidence. Phase-one node and phase-two graph compatibility is not required; changed contracts require an explicit schema/version migration.

## Planned task order

1. Design the bounded loop contract and safety invariants.
2. Define loop-specific unit tests and fixtures.
3. Implement validation, lowering, counters, budgets, and CLI inspection.
4. Validate full regression and release gates.
5. Review and deliver v0.3.0 locally.

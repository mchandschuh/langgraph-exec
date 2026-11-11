# WI-0001 — Phase 1: direct YAML LLM invocation

## Objective

Deliver release 0.1.0 with one direct YAML-defined node type, initially llm.complete, and a thin installed CLI using /home/michael/src/github/llm.

## Scope

- Define and validate a versioned node artifact.
- Resolve typed parameters and runtime input bindings.
- Construct and invoke an llm/request/v1 request through an injected service.
- Return bounded structured response/error envelopes.
- Implement validate, inspect, and run.
- Add deterministic fake-service unit tests.
- Build and register the CLI through npm --prefix $HOME/.local link.

## Explicit boundaries

Phase 1 does not implement graphs, imports, nested components, loops, checkpointing, interrupts, arbitrary tools, or live-provider release tests. Phase-one node compatibility across later phases is not required; later phases may revise or replace the contract through an explicit schema/version migration.

## Planned task order

1. Define the direct-node contract and request/response boundary.
2. Define the deterministic unit-test strategy.
3. Implement the node, llm adapter, CLI, and tests.
4. Validate typecheck, tests, build, and user-local npm link.
5. Review scope/evidence and deliver v0.1.0 locally.

## Evidence boundary

Unit tests, build output, CLI help, and user-local linking establish local static/unit/CLI-audit evidence only; they do not establish provider availability, deployment readiness, or production safety.

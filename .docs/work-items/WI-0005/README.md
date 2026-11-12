# WI-0005 — Align execution with LangGraph built-in capabilities

## Objective

Refactor `langgraph-exec` so its YAML compiler and application-specific policy
layer rely on LangGraph's tested runtime capabilities wherever they already
cover the required behavior, while preserving the repository's trusted YAML,
component-port, provider-boundary, and bounded-execution contracts.

## Ordered implementation steps

1. Architecture and compatibility design — `.docs/work-items/WI-0005/steps/WI-0005-00000000-design.yaml`
2. Deterministic test strategy — `.docs/work-items/WI-0005/steps/WI-0005-10000000-test-strategy.yaml`
3. Native graph lowering — `.docs/work-items/WI-0005/steps/WI-0005-20000000-native-lowering.yaml`
4. Runtime policy and observability — `.docs/work-items/WI-0005/steps/WI-0005-30000000-runtime-policies.yaml`
5. Repository validation — `.docs/work-items/WI-0005/steps/WI-0005-40000000-validation.yaml`
6. Scope and evidence review — `.docs/work-items/WI-0005/steps/WI-0005-50000000-review.yaml`
7. Local delivery — `.docs/work-items/WI-0005/steps/WI-0005-60000000-delivery.yaml`

## Explicit boundaries

This work item preserves custom functionality that LangGraph does not provide:

- YAML parsing, versioned schemas, trusted-root imports, digest checks, and
  import-cycle validation;
- public component ports and nested-component state encapsulation;
- the registered implementation boundary and `/home/michael/src/github/llm`
  provider/structured-output contract; and
- repository-specific semantic budgets such as `maxIterations`, `maxSteps`,
  branch limits, and map-item limits.

The implementation must use LangGraph for graph scheduling, conditional edges,
reducers, fan-out/fan-in, dynamic `Send` work, node retry policies, node
timeouts, runtime streaming, and graph state transitions where those features
match the required semantics.

Checkpoint persistence, interrupt/resume, durable side-effect receipts, live
provider release tests, arbitrary YAML code execution, and production deployment
remain out of scope. The work may expose an extension point for a future
checkpointer without claiming persistence or resume behavior.

## Required outcome

The repository must have one authoritative execution path for graph behavior.
Manual `Promise.all`, `Promise.race`, retry loops, and loop `while` execution may
remain only where they implement a provider-specific or DSL-specific behavior
that LangGraph does not represent; such exceptions must be documented and
covered by tests.
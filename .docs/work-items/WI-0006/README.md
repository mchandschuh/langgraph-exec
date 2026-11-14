---
status: planned
---

# WI-0006 — One authoritative LangGraph execution path

## Objective

Remove the remaining standalone control-runtime path from `langgraph-exec` and
make the repository's guiding architecture explicit: YAML/JSON is a declarative
LangGraph definition format, while compiled LangGraph owns graph execution,
scheduling, state transitions, reducers, routing, retries, timeouts, fan-out,
streaming, and runtime events.

The work retires `src/controls.ts` rather than rebuilding it under another name.
The conversation sample and its tests must use declarative graph definitions and
native LangGraph policies instead of importing manual `try`/`retry` helpers.

## Scope

- define one reusable trusted-component-to-LangGraph node adapter;
- unify graph and control-loop execution behind one compiled graph runtime;
- lower declarative routes, loops, reducers, retry policies, and timeouts to
  LangGraph primitives;
- define the smallest graph-level failure representation needed by the sample;
- migrate `samples/two-llm-conversation` away from `src/controls.ts`;
- replace standalone control-helper tests with compiled-graph tests;
- delete `src/controls.ts` and stale references;
- document the execution philosophy in `README.md` and relevant samples;
- preserve YAML/JSON schemas, trusted imports, public ports, component
  registration, LLM provider contracts, and bounded semantic budgets.

## Explicit boundaries

LangGraph is the sole authority for runtime graph behavior. The compiler remains
the authority for parsing, validation, trusted artifact resolution, bindings,
public ports, and lowering. The LLM package remains the provider and structured
response boundary.

This work does not implement checkpoint persistence, interrupt/resume, human
approval, durable side-effect recovery, Vector work-queue integration, or live
provider release evidence.

## Ordered implementation steps

1. Architecture and migration design — `steps/WI-0006-00000000-design.yaml`
2. Deterministic test strategy — `steps/WI-0006-10000000-test-strategy.yaml`
3. Unified LangGraph adapter/runtime — `steps/WI-0006-20000000-runtime-adapter.yaml`
4. Sample migration and controls removal — `steps/WI-0006-30000000-controls-removal.yaml`
5. Validation — `steps/WI-0006-40000000-validation.yaml`
6. Review — `steps/WI-0006-50000000-review.yaml`
7. Delivery — `steps/WI-0006-60000000-delivery.yaml`

## Required outcome

After this work, a graph definition should follow one path:

```text
YAML/JSON
  -> parse and validate
  -> normalized DSL IR
  -> trusted component adapter
  -> LangGraph StateGraph
  -> invoke or stream
```

No production graph behavior should execute through manual `Promise.all`,
`Promise.race`, retry loops, `while` loop runners, or a separate control helper
runtime when equivalent LangGraph facilities exist.

# WI-0002 — Phase 2: graph composition

## Objective

Deliver release 0.2.0 with YAML-defined acyclic graphs composed from registered nodes and other YAML graph components, lowered through LangGraph StateGraph.

## Scope

- Trusted relative imports, aliases, digests, and cycle detection.
- Graph state fields, public ports, node instances, bindings, edges, routes, and reducers.
- LangGraph StateGraph lowering for DAGs, START/END, and conditional edges.
- Nested graph composition through explicit public ports.
- Deterministic graph tests, build, link, and CLI verification.

## Explicit boundaries

Phase 2 rejects arbitrary cycles and does not implement bounded loops, checkpointing, interrupts, resume, or arbitrary YAML code execution. Phase-one node compatibility is not required; changed contracts require an explicit schema/version migration.

## Planned task order

1. Design imports, graph state, ports, routes, reducers, and lowering.
2. Define graph and nested-composition tests.
3. Implement resolver, IR, compiler, backend, CLI inspection, and tests.
4. Validate regression tests, build, link, and graph CLI behavior.
5. Review and deliver v0.2.0 locally.

# langgraph-exec

`langgraph-exec` is a TypeScript/Node.js compiler, CLI, and library for defining
LangGraph workflows in YAML or JSON. Definition files select trusted node and
component types, bind parameters and ports, and describe graph topology without
embedding executable JavaScript in workflow definitions.

The central architectural rule is:

> The repository compiles and validates declarative definitions; LangGraph is the
> sole authority for graph execution.

`langgraph-exec` is not intended to contain a second workflow scheduler. The
compiled LangGraph runtime owns execution behavior wherever its primitives match
the definition contract.

The repository is developed through independently scoped work items and releases:

| Phase | Work item | Scope | Planned release |
| --- | --- | --- | --- |
| 1 | `WI-0001` | Direct parameterized LLM invocation from YAML and CLI | `0.1.0` |
| 2 | `WI-0002` | Acyclic graphs composed from nodes and nested graphs | `0.2.0` |
| 3 | `WI-0003` | Explicit bounded loops | `0.3.0` |
| 4 | `WI-0005` | Align compiled execution with LangGraph built-ins | `0.4.0` |
| 5 | `WI-0006` | Retire the remaining standalone control runtime | planned |

## Current state

Phase 1 implements a closed direct `llm.complete` node contract, typed parameter
and input bindings, schema-registry-backed request/response contracts,
provider-free `validate`/`inspect`, and bounded `run` execution through the
injected `/home/michael/src/github/llm` service boundary. Phase 2 adds trusted
imports, closed acyclic graph composition, StateGraph lowering, conditional
routes, reducers, and nested public-port components. Phase 3 adds explicit
bounded loops with compiler-enforced iteration and step budgets, deterministic
exhaustion statuses, and loop inspection.

`WI-0005` moved applicable compiled graph scheduling, reducers, static
fan-out/fan-in, node retry/timeout policies, streaming, and runtime diagnostics
onto LangGraph. `WI-0006` tracks the remaining cleanup: one reusable trusted
component adapter, one compiled runtime boundary, migration of the conversation
sample, and removal of the standalone `src/controls.ts` execution helpers.

## Planned architecture

```text
YAML/JSON definition
  -> parse and schema validation
  -> normalized DSL IR
  -> trusted component registry and adapter
  -> LangGraph StateGraph
  -> invoke or stream through LangGraph
  -> injected services, including /home/michael/src/github/llm
```

The repository owns the compiler and trust boundary:

- YAML/JSON parsing and versioned schema validation;
- trusted-root imports, digest checks, and cycle validation;
- normalized state, port, parameter, and binding contracts;
- registered component lookup and component-to-LangGraph adaptation;
- public-port projection and nested-component encapsulation; and
- repository-specific semantic budgets such as bounded iterations, steps, or
  map items.

LangGraph owns runtime behavior:

- graph scheduling and state transitions;
- reducer channels and supersteps;
- static and conditional edges;
- bounded cycles compiled from declarative loop definitions;
- retry policies and node timeouts;
- dynamic fan-out through `Send` where the DSL supports it; and
- streaming, task, debug, and execution events.

The `llm` package remains the provider and structured-output boundary. Provider
response validation and provider-specific retry semantics stay at that boundary;
they are not replaced by generic graph scheduling policies.

Node, graph, and control-loop documents may be YAML or JSON. Primitive `type`
fields remain supported; parameters, ports, state fields, and node contracts may
also use inline JSON Schema or registry `$ref` expressions. The built-in registry
includes this package's `schemas/` directory and the installed `llm/schemas/`
directory. Additional schema directories can be listed one per line in
`~/.langgraph-exec/schemas/registry/paths.txt`, supplied with
`LANGGRAPH_EXEC_SCHEMA_REGISTRY`, or passed with `--schema-registry`.

## Local development

```bash
corepack enable
yarn install
yarn typecheck
yarn test
yarn build
```

Register the CLI in the user-local npm prefix without requiring root access:

```bash
node scripts/install_cli.mjs
```

Equivalent explicit release/link commands are:

```bash
corepack yarn install
corepack yarn typecheck
corepack yarn test
corepack yarn build
npm --prefix "$HOME/.local" link /home/michael/src/github/langgraph-exec
command -v langgraph-exec
langgraph-exec --help
```

## Sample

From the repository root, execute the direct-completion sample with:

```bash
yarn build
yarn start run samples/direct-completion/node.yml --input samples/direct-completion/input.json
```

See [`samples/README.md`](./samples/README.md) for capability-organized direct,
nested-graph, and bounded-loop samples.

## Design constraints

- YAML/JSON composes registered capabilities; it does not execute arbitrary code.
- Components expose public input/output ports and keep child state private.
- Imports are trusted-root constrained and must be deterministic and cycle-safe.
- Compiled definitions execute through LangGraph rather than a parallel custom
  scheduler or standalone control helper runtime.
- Declarative routes, reducers, loops, retries, timeouts, streams, and supported
  fan-out lower to LangGraph primitives.
- Phase 1 node compatibility across later phases is not a requirement. Later
  phases may revise or replace the node contract with an explicit schema/version
  migration.
- Provider-backed execution and side effects are never implied by validation or
  inspection commands.
- LLM nodes default to `llm/request/v1` and `llm/response/v1`; v2 contracts can be
  selected with the node's `requestSchema` and `responseSchema` parameters.
- Checkpoint persistence, interrupt/resume, human approval, durable side-effect
  recovery, and production deployment are not implied by compiled execution.

See [`SKILL.md`](./SKILL.md) for operational guidance and the phased records
under [`.docs/work-items/`](./.docs/work-items/) for the implementation plan.
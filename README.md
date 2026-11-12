# langgraph-exec

`langgraph-exec` is a TypeScript/Node.js CLI and library for defining bounded,
composable LangGraph workflows in YAML. YAML files select trusted node types,
bind parameters and ports, and compose increasingly complex execution systems
without embedding executable JavaScript in workflow definitions.

The repository is delivered in three independently releasable phases:

| Phase | Work item | Scope | Planned release |
| --- | --- | --- | --- |
| 1 | `WI-0001` | Direct parameterized LLM invocation from YAML and CLI | `0.1.0` |
| 2 | `WI-0002` | Acyclic graphs composed from nodes and nested graphs | `0.2.0` |
| 3 | `WI-0003` | Explicit bounded loops | `0.3.0` |

## Current state

Phase 1 implements a closed direct `llm.complete` node contract, typed parameter
and input bindings, schema-registry-backed request/response contracts, provider-free `validate`/`inspect`, and bounded `run`
execution through the injected `/home/michael/src/github/llm` service boundary.
Phase 2 adds trusted imports, closed acyclic graph composition, StateGraph
lowering, conditional routes, reducers, and nested public-port components.
Phase 3 adds explicit bounded loops with compiler-enforced iteration and step
budgets, deterministic exhaustion statuses, and loop inspection.

## Planned architecture

```text
YAML component
  -> schema validation
  -> normalized component IR
  -> trusted node registry
  -> LangGraph StateGraph backend
  -> injected services, including /home/michael/src/github/llm
```

The `llm` package remains the provider and structured-output boundary. The graph
runtime will own YAML resolution, composition, state transitions, routing,
budgets, and graph-level observability rather than duplicating provider logic.

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

- YAML composes registered capabilities; it does not execute arbitrary code.
- Components expose public input/output ports and keep child state private.
- Imports are trusted-root constrained and must be deterministic and cycle-safe.
- Phase 2 graphs are DAGs; Phase 3 introduces explicit bounded loops.
- Phase 1 node compatibility across later phases is not a requirement. Later
  phases may revise or replace the node contract with an explicit schema/version
  migration.
- Provider-backed execution and side effects are never implied by validation or
  inspection commands.
- LLM nodes default to `llm/request/v1` and `llm/response/v1`; v2 contracts can be
  selected with the node's `requestSchema` and `responseSchema` parameters.

See [`SKILL.md`](./SKILL.md) for operational guidance and the phased records
under [`.docs/work-items/`](./.docs/work-items/) for the implementation plan.
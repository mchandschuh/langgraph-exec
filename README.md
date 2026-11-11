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

This initial commit establishes the package, CLI, installation script, skill
documentation, and phased work-item records. The CLI currently supports
provider-free `--help` and `--version`; the `validate`, `inspect`, and `run`
command boundaries are reserved for Phase 1.

## Planned architecture

```text
YAML component
  -> schema validation
  -> normalized component IR
  -> trusted node registry
  -> LangGraph backend
  -> injected services, including /home/michael/src/github/llm
```

The `llm` package remains the provider and structured-output boundary. The graph
runtime will own YAML resolution, composition, state transitions, routing,
budgets, and graph-level observability rather than duplicating provider logic.

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

See [`SKILL.md`](./SKILL.md) for operational guidance and the phased records
under [`.docs/work-items/`](./.docs/work-items/) for the implementation plan.
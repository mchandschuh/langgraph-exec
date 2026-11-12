---
name: langgraph-exec
description: Define, validate, inspect, and run bounded YAML LangGraph components through the langgraph-exec CLI.
category: [nodejs, typescript, langgraph, yaml, workflows]
tags: [langgraph-exec, langgraph, yaml, graph, node, llm, composition, loops]
triggers: ["langgraph-exec", "YAML graph", "YAML workflow", "LangGraph workflow"]
file_patterns: ["*.yml", "*.yaml", "langgraph-exec/**"]
intent_patterns: [define, validate, inspect, run, compose, execute]
priority: 0.9
auto_load: false
metadata:
  importance: high
  relevance: Use when authoring or operating langgraph-exec YAML definitions.
---

# langgraph-exec

`langgraph-exec` is the YAML-defined workflow CLI at
`/home/michael/src/github/langgraph-exec`. It will use the provider-agnostic
`llm` package at `/home/michael/src/github/llm` for LLM request/response
execution.

## Phase status

- **Phase 1 / WI-0001:** direct parameterized LLM invocation from YAML and CLI.
- **Phase 2 / WI-0002:** composition of nodes and nested acyclic graphs.
- **Phase 3 / WI-0003:** explicit bounded loops.

Phase 1 provides a closed direct `llm.complete` node contract, provider-free
`validate` and `inspect`, and bounded `run` execution through the injected
`llm/request/v1` service boundary. Phase 2 adds trusted acyclic graph
composition and StateGraph lowering. Phase 3 provides explicit bounded loops
with graph-owned counters and budgets; do not claim persistence or
interrupt/resume behavior from the loop capability.

## Safety boundary

- `validate` and `inspect` are intended to be offline and non-mutating.
- `run` may invoke an external LLM provider after Phase 1 is implemented.
- Later registered nodes may perform side effects only when explicitly selected
  by a graph and authorized by the runtime host.
- YAML must never contain arbitrary JavaScript, shell text, dynamic imports, or
  executable expressions.
- Never place credentials in YAML, committed prompts, work-item records, or
  command arguments.
- Validation, unit tests, and local linking do not prove provider availability,
  deployment readiness, production safety, or external side-effect recovery.

## Planned CLI

```text
langgraph-exec --help
langgraph-exec --version
langgraph-exec validate <component.yml>
langgraph-exec inspect <component.yml> [--resolved] [--format json]
langgraph-exec run <component.yml> --input <input.json>
```

Phase-specific behavior and acceptance criteria are authoritative in:

```text
.docs/work-items/WI-0001/
.docs/work-items/WI-0002/
.docs/work-items/WI-0003/
```

## Release/link workflow

Each phase must pass its own unit tests plus all earlier regression tests:

```bash
corepack enable
yarn install --frozen-lockfile
yarn typecheck
yarn test
yarn build
npm --prefix "$HOME/.local" link /home/michael/src/github/langgraph-exec
command -v langgraph-exec
langgraph-exec --help
langgraph-exec --version
```

The local link is user-local package delivery evidence only. It is not npm
registry publication or production installation evidence.
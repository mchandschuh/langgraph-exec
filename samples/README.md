# Samples by capability

Samples are organized by the capability they demonstrate rather than by phase.
No credentials are stored in the samples; the `llm` package must be configured
separately when running against a provider.

## Direct completion

Build and execute from the repository root with:

```bash
yarn build
yarn start run samples/direct-completion/node.yml --input samples/direct-completion/input.json
```

The command prints the bounded `llm/response/v1` response envelope. To check
the YAML without provider access, run:

```bash
yarn start validate samples/direct-completion/node.yml
yarn start inspect samples/direct-completion/node.yml --resolved --format json
```

## Nested graph composition

`nested-graph/graph.yml` demonstrates trusted relative imports and nested graph
composition through public `task` and `result` ports. Its child graph imports a
direct-completion node, while the parent graph imports the child graph.

Validate and inspect it without provider access:

```bash
yarn build
yarn --silent start validate samples/nested-graph/graph.yml
yarn --silent start inspect samples/nested-graph/graph.yml --resolved --format json
```

Execute it from the repository root when the `llm` provider is configured:

```bash
yarn start run samples/nested-graph/graph.yml --input samples/nested-graph/input.json
```

## Bounded loop

`bounded-loop/loop.yml` demonstrates an explicit finite loop with a counter,
maximum iteration count, maximum step budget, exhaustion policy, and an imported
loop body.

Inspect it without provider access and execute it when the provider is configured:

```bash
yarn --silent start validate samples/bounded-loop/loop.yml
yarn --silent start inspect samples/bounded-loop/loop.yml --resolved --format json
yarn start run samples/bounded-loop/loop.yml --input samples/bounded-loop/input.json
```

## Two-LLM conversation

`two-llm-conversation/` demonstrates two declarative `llm.complete` nodes
composed by a sample-local runner. It executes ten rounds of `alpha -> beta`,
then `beta -> alpha`, passing the complete aggregate conversation into every
request. Each turn uses `control.retry` inside `control.try` so transient
provider or schema failures are retried up to three times and permanently
failed turns become bounded transcript records.

The opening message is supplied as a command-line argument:

```bash
yarn tsx samples/two-llm-conversation/run.ts \
  "Discuss how bounded workflow systems should handle partial failure."
```

See [`two-llm-conversation/README.md`](./two-llm-conversation/README.md) for
the node roles, schemas, retry predicate, failure behavior, and test design.
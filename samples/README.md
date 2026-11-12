# Direct completion sample

This directory contains a phase-one direct `llm.complete` node and its JSON
input document. No credentials are stored in the sample; the `llm` package
must be configured separately when running against a provider.

From the repository root, build and execute the sample with:

```bash
yarn build
yarn start run samples/direct-completion.yml --input samples/input.json
```

The command prints the bounded `llm/response/v1` response envelope. To check
the YAML without provider access, run:

```bash
yarn start validate samples/direct-completion.yml
yarn start inspect samples/direct-completion.yml --resolved --format json
```

## Phase-two nested graph sample

`phase-two/nested-answer.yml` demonstrates trusted relative imports and nested
graph composition through public `task` and `result` ports. Its child graph
imports the phase-two-local direct-completion node, while the parent graph
imports the child graph.

Validate and inspect it without provider access:

```bash
yarn build
yarn --silent start validate samples/phase-two/nested-answer.yml
yarn --silent start inspect samples/phase-two/nested-answer.yml --resolved --format json
```

Execute it from the repository root when the `llm` provider is configured:

```bash
yarn start run samples/phase-two/nested-answer.yml --input samples/phase-two/input.json
```
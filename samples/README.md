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
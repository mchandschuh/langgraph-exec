# Two-LLM conversation

This sample runs a bounded conversation between two `llm.complete` nodes named
Alpha and Beta. It accepts the opening message as a command-line argument and
executes exactly ten rounds:

```text
round 1: alpha -> beta, then beta -> alpha
round 2: alpha -> beta, then beta -> alpha
...
round 10: alpha -> beta, then beta -> alpha
```

The result contains twenty ordered turn records. Every request receives the
complete conversation accumulated before that turn, including bounded failure
records when a participant cannot complete after its retry budget.

## Run it

From the repository root:

```bash
yarn tsx samples/two-llm-conversation/run.ts \
  "Discuss how bounded workflow systems should handle partial failure."
```

Add `--debug` before the opening message to emit bounded lifecycle diagnostics
on stderr:

```bash
yarn tsx samples/two-llm-conversation/run.ts --debug \
  "Discuss how bounded workflow systems should handle partial failure."
```

The live command uses the configured `llm` provider. No credentials are stored
in this sample. `validate` and `inspect` remain provider-free:

```bash
yarn start validate samples/two-llm-conversation/alpha.yml
yarn start validate samples/two-llm-conversation/beta.yml
yarn start inspect samples/two-llm-conversation/alpha.yml --resolved --format json
```

## Why each node exists

### `alpha.yml`

This is the first participant node. Its system prompt defines Alpha as one of
two LLMs and tells it to read the entire aggregate conversation, respond as
Alpha, and add one concrete idea. It uses a separate node so the participant
identity and model configuration are explicit and inspectable.

### `beta.yml`

This is the second participant node. Its system prompt defines Beta as Alpha's
LLM conversation partner and tells it to read the same aggregate conversation,
respond as Beta, and challenge or refine one concrete idea. Keeping Beta as a
separate registered node prevents participant identity from being hidden in
runner logic.

### `task.schema.json`

This schema is loaded from the sample file and inlined into every request. It
protects the input contract for every turn. It requires the
conversation ID, opening message, round number, current speaker, complete
transcript, and participant instruction. It bounds the transcript at twenty
turns and bounds message and diagnostic sizes.

### `output.schema.json`

This schema is loaded and inlined into every request. It requires every
successful LLM response to be structured JSON with
the expected speaker, round, and message. The live `llm` service validates this
schema before returning success. The runner repeats the speaker/round check so
an injected completion service cannot silently return another participant's
response.

## Why the control nodes are used this way

The current repository exposes `control.try` and `control.retry` as runtime
helpers in `src/controls.ts`. The YAML loader currently loads direct nodes,
graphs, and `control.loop`; it does not yet load `control.try` or
`control.retry` as standalone YAML component files. The sample therefore uses
the helpers in `run.ts` while keeping both LLM participants declarative.

Each participant invocation has this nesting:

```text
control.try(
  control.retry(
    execute the participant's llm.complete node,
    maxAttempts = 3
  )
)
```

### `control.retry`

`control.retry` is used around one participant turn because provider-backed
completion is a transient boundary. It makes the maximum number of attempts
explicit and prevents a failed provider call from creating an unbounded loop.

The retry predicate is:

```text
retry when status is provider_error
        or output_invalid
        or attempts_exhausted
```

`output_invalid` includes a response whose structured value does not contain
the expected participant, round, and non-empty message. In live execution,
`outputSchema` validation normally turns malformed provider JSON into
`output_invalid`; the runner also checks the normalized response envelope.

The sample sends the request boundary in this form:

```text
task:        structured object
taskSchema:  inline JSON Schema object
outputSchema: inline JSON Schema object
```

The `llm` package serializes these objects only while constructing the textual
provider prompt. They are not stringified by the conversation runner.

The following statuses are not retried because another attempt cannot repair
the request or configuration:

```text
input_invalid
configuration_error
```

Each node sets `maxFailedAttempts: 0` and `maxIterations: 1` so the sample's
outer retry policy is the visible retry boundary. The maximum is therefore:

```text
10 rounds * 2 participants * 3 attempts = 60 participant invocations
```

### `control.try`

`control.try` wraps the retry operation so the conversation can handle a
participant that remains unavailable after all permitted attempts. It prevents
one failed turn from aborting the remaining nine rounds. Its failure branch
adds a bounded record like this to the shared transcript:

```json
{
  "round": 4,
  "speaker": "beta",
  "status": "failure",
  "message": "[beta unavailable after bounded retries]",
  "error": {
    "code": "PROVIDER_REQUEST_FAILED",
    "status": "provider_error",
    "attempts": 3,
    "message": "The provider request failed before a usable response was returned."
  }
}
```

The next participant receives that failure record as part of the full
conversation. The final result is `completed_with_failures` if any such record
was required; execution still ends after exactly twenty turn slots.

## Deterministic testing

The sample test injects a fake `CompletionService`, so it does not initialize
an LLM provider. It verifies:

- Alpha runs before Beta in every round;
- each request includes `taskSchema` and `outputSchema`;
- each task contains the complete conversation available at that point;
- a transient response failure succeeds through `control.retry`;
- a permanent response failure is handled by `control.try`;
- the failure record is visible to later participants;
- exactly ten rounds and twenty turn records are produced.
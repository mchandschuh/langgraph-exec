# WI-0004 — Registered control-flow node types

## Objective

Deliver a versioned control-node registry for explicit declarative workflow control flow. The first implementation step migrates the existing `loop/v1` / `kind: loop` contract to `control-loop/v1` / `kind: control.loop`.

## Ordered implementation steps

1. `control.loop` — `.docs/work-items/WI-0004/steps/WI-0004-01000000-bounded-loop.yaml`
2. `control.parallel` — `.docs/work-items/WI-0004/steps/WI-0004-02000000-parallel.yaml`
3. `control.join` — `.docs/work-items/WI-0004/steps/WI-0004-03000000-join.yaml`
4. `control.switch` — `.docs/work-items/WI-0004/steps/WI-0004-04000000-switch.yaml`
5. `control.map` — `.docs/work-items/WI-0004/steps/WI-0004-05000000-map.yaml`
6. `control.try` — `.docs/work-items/WI-0004/steps/WI-0004-06000000-try.yaml`
7. `control.retry` — `.docs/work-items/WI-0004/steps/WI-0004-07000000-retry.yaml`
8. `control.timeout` — `.docs/work-items/WI-0004/steps/WI-0004-08000000-timeout.yaml`
9. `control.return` — `.docs/work-items/WI-0004/steps/WI-0004-09000000-return.yaml`
10. `control.fail` — `.docs/work-items/WI-0004/steps/WI-0004-10000000-fail.yaml`

## Explicit boundaries

WI-0004 does not add checkpointing, interrupt/resume, durable side-effect receipts, live-provider release tests, arbitrary unbounded cycles, or unbounded parallel/map expansion. Each control node must have a closed versioned contract, deterministic fake-component tests, provider-free inspection, and bounded failure behavior.

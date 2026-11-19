# factory-core (FT1, production-line material-flow simulation)

Private pure TypeScript model of the factory digital twin plan (FT1, ADR 023). Not a registered editor or a stable public API. No React, no kernel, no Worker, no other domain.

- `model.ts`: `FactoryDocument` schema 1: product types, objects (`source`, `station`, `parallel`, `assembly`, `buffer`, `conveyor`, `drain`), links (with an optional product filter) and the default run (duration, warm-up, seed). Times are whole milliseconds, lengths whole millimetres. `factoryLimits` holds the initial safety limits (500 objects, 2,000 links, 10 million events a run, one year), not performance promises.
- `validation.ts`: `validateFactory(unknown)` returns every problem with a code and a JSON path (exact keys, IDs, distributions, references, link rules, buffer-only loops). `factoryWarnings` lists objects without links and assembly parts that no source can bring.
- `random.ts`: `FactoryRandom` (sfc32, one stream per object ID and seed) and `sampleDistribution` (const, uniform, triangular, truncated normal, lognormal by its own mean/sd, exponential, empirical), rounded to whole ms.
- `engine.ts`: `runFactory(doc, options)` — the discrete-event run. Blocking after service; parts move instantly; a source makes its next part an interval after the last one left. Conveyors carry at length ÷ speed with part-length spacing, either accumulating or stopping as a whole. Results: production (per product), throughput per hour, lead time, WIP, per-object time in `working` / `waiting` / `blocked` and content, and `activePeriodBottlenecks` (sole and shifting time). FT1b: `flows` per link, lead-time percentiles and histogram, and with `record` a `timeline` of state intervals and part moves (for Gantt charts and replay).
- `operations.ts`: `applyFactoryOperation` (whole-document validation; removed IDs are retired) and `factoryEditorCommand` (base hash and edit authority re-checked, several operations = one Undo step).
- `fixtures.ts`: F170, a small e-Axle line (machining cell of two, buffer, conveyor, gear-set assembly, end-of-line test).

Tests: `npx vitest run packages/factory-core` (TS-2650 to TS-2652).

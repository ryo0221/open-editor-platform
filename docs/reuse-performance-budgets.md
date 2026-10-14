# V2.2 additional performance budgets

Declared before the first V2.2 nesting/fan-out performance measurement, while the
working source extends parent `92cc52f486a0c1c112c940610826d637a0777da6`.
These are acceptance targets, **not measured results**. Do not revise them after a
slow run merely to label it passing; preserve all results and investigate failures.

The original #6 fixtures, input p95 ≤100 ms and page/view navigation p95 ≤500 ms
remain unchanged (see the R01–R16 plan). Repeat their
normal editor measurements three times at their original sizes. Separate local
input from authority confirmation and report transport conditions.

Additional fixtures and budgets:

| Condition                      | Fixed load                                                                                 | p95 budget |
| ------------------------------ | ------------------------------------------------------------------------------------------ | ---------- |
| Token resolution               | 2,048 tokens, light/dark mode, aliases included                                            | 100 ms     |
| Nested insertion preparation   | 10 instance levels, 1,000 expanded native parts, exact retained closure                    | 3,000 ms   |
| Version update preview         | 50 selected instances × 20 native parts, one changed style plus retained body/local inputs | 3,000 ms   |
| Native update authority commit | Same 50-instance prepared update, local reference transport                                | 1,000 ms   |
| Selective Undo                 | Same committed update, intervening independent body edit                                   | 1,000 ms   |

Record 5 warm-ups followed by 20 samples per condition in each of three repetitions,
including failures, max and p95. Measure Design/Slide/Document native update paths
separately rather than averaging domains together. Report native JSON size and
retained-definition size; the 1,000-part fixture must remain within 10 MiB. Record
available browser/process memory measures and require additional retained heap
below 256 MiB where an actual heap measure is available; do not substitute process
RSS for heap or claim an unsupported measurement passed.

Source/test manifest, exact build, browser, hardware, cache/warm-up state and timing
boundaries belong with the raw samples. Ordinary edits after adoption must not
resolve the catalog or expand all instances for every keystroke. Large preparation
budgets do not relax the normal input/navigation goals. Depth/expansion rejection
at the declared limits remains a separate correctness check.

Additional conditions declared before their first measurement on 2026-10-05:
artifact mode preview uses the same 50 × 20 native fixture and the existing
3,000 ms preview budget. Ordinary editing of that adopted fixture uses the existing
100 ms local response target, with five warm-ups and twenty samples, three repeats.
Measure local mode and shared loopback with both 0 and 80 ms added acknowledgement
delay. Authority confirmation is reported separately; the transport delay is not
subtracted from it. These conditions do not replace the original #6 fixtures.

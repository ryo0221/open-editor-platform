# F43 PMI fixture

The PMI fixture of docs/cad/pmi.md (F43, CAD80–CAD82). It is
written by `scripts/cad-kernel/f43-pmi.py` with a native OCCT 8.0 (`cadquery-ocp` 8.0.1.1), a
different OCCT version and build from the Wasm kernel that reads it. The script fixes the
timestamp, file name and author fields, so it reproduces the file byte for byte. The OCCT 8
writer writes the lower deviation's magnitude (0.05 for −0.05); the script then writes the
signed lower bound that `TOLERANCE_VALUE` means (text edit), so the file says −0.05.

| File                       | Content                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pmi-plate.step`           | AP242: the F07 plate (80 × 50 × 5 mm, a 10 mm hole) with semantic PMI from the XDE writer: thickness 5 mm (bottom to top), hole Ø10 ±0.05 mm, datums A (bottom) and B (side x = 0), flatness 0.02 (top), parallelism 0.05 to A (top), position Ø0.1 to A, B (hole)                                                                                                   |
| `loss-component-path.step` | F44 (one of its three files): `pmi-plate.step` plus one `COMPONENT_PATH_SHAPE_ASPECT` (a reference through an assembly path, text edit), which OCCT 7.6 does not read. The other two F44 files (user-defined attributes, a broken target) come with a later PMI-2 step                                                                                               |
| `pmi-assembly.step`        | PMI-2a: the plate placed twice and a 20 × 20 × 10 mm block at x = 100 in one assembly, with the plate's thickness, hole Ø10 ±0.05, datums A and B and position Ø0.1 to A, B, plus one distance from the plate's top to the block's top (on two parts, so a part's `pmi` asset cannot hold it)                                                                        |
| `expected.json`            | The values the script wrote, from the same tables: the reader's result is checked against these, not against itself                                                                                                                                                                                                                                                  |
| `pmi-presented.step`       | PMI-3: the plate with thickness 5 mm, hole Ø10, flatness 0.02 (no presentation), position Ø0.1 to A, B and datums A and B, written by `f43-presentation.py`. The distance, the diameter, the position and datum A have tessellated presentation lines; two saved views are added to the text: "Hole" from above (diameter and position) and "Datum A" from the front |
| `pmi-placeholder.step`     | PMI-3: `pmi-presented.step` with the diameter's and the position's links rewritten as AP242 ed3's `DRAUGHTING_MODEL_ITEM_ASSOCIATION_WITH_PLACEHOLDER` (empty name, a placeholder occurrence in the callout), as the JAMA files link them. OCCT 7.6 does not read these links                                                                                        |
| `presented.json`           | The lines, planes and views `f43-presentation.py` wrote                                                                                                                                                                                                                                                                                                              |

The design names one saved view for F43. The OCCT writer does not write saved views (PMI-U7), so
`pmi-plate.step` has none; `f43-presentation.py` adds two to its own files as text
(`CAMERA_MODEL_D3` in a `DRAUGHTING_MODEL` of its own), and reproduces them byte for byte too. Both views have
their x axis along −X, so that y (= z × x, up) is +Y from above and +Z from the front (PMI-3b).

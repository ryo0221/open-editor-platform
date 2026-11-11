# F07 STEP corpus

STEP files for the D2 import (docs/cad/verification-plan.md, F07; CAD11 and ST-29 #1/#2). They are
written by `scripts/cad-kernel/f07-corpus.py` with a native OCCT 8.0 (`cadquery-ocp` 8.0.1.1), a
different OCCT version and build from the Wasm kernel that reads them, as another CAD would be.
The script fixes the timestamp, file name and author fields, so it reproduces the files byte for
byte.

| File                             | Content                                                                                   | Expected import                                               |
| -------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `normal-mm-plate.step`           | AP214, mm: 80 × 50 × 5 plate with a 10 mm hole                                            | One solid, 19,607.300918 mm³                                  |
| `normal-ap203.step`              | The plate written as AP203 (`CONFIG_CONTROL_DESIGN`)                                      | One solid, same volume                                        |
| `normal-colour.step`             | The plate with a surface colour (XCAF)                                                    | One solid; the colour is reported as not kept                 |
| `normal-inch-block.step`         | 2 × 1 × 0.5 inch block, unit `INCH`                                                       | `in`, × 25.4: 16,387.064 mm³                                  |
| `normal-millimetre-plate.step`   | The plate with the unit `CONVERSION_BASED_UNIT('MILLIMETRE')` = 1 SI mm (text edit, #810) | `mm`: same volume as the plate                                |
| `normal-m-cone.step`             | Cone (radii 200/50 mm, height 300 mm), unit `METRE`                                       | `m`, × 1000: 16,493,361.43134 mm³                             |
| `normal-analytic.step`           | Torus fused with a sphere (analytic surfaces)                                             | One solid, 60,431.434744 mm³                                  |
| `normal-ap242.step`              | The plate as AP242 (one part, no assembly)                                                | One solid, same volume (#811)                                 |
| `reject-ap209.step`              | The plate with `FILE_SCHEMA` AP209 (`STRUCTURAL_ANALYSIS_DESIGN`, text edit, #811)        | `step-schema-unsupported`                                     |
| `reject-assembly.step`           | Two instances of one box in an assembly                                                   | `step-assembly`                                               |
| `reject-pmi-dimension.step`      | The plate plus one `DIMENSIONAL_SIZE` entity (text edit)                                  | `step-pmi`                                                    |
| `reject-external-reference.step` | The plate plus one `DOCUMENT_FILE` entity (text edit)                                     | `step-external-reference`                                     |
| `reject-two-solids.step`         | Two boxes in one product (assembly writing off)                                           | `step-multiple-solids`                                        |
| `reject-free-face.step`          | A box and a loose face in one product                                                     | `step-not-single-solid`                                       |
| `loose-tolerance-gap.step`       | A box with one vertex moved 0.005 mm off its edges                                        | One solid, its tolerance (about 0.005 mm) kept as read (#820) |
| `reject-tolerance-wide.step`     | The same box with the vertex moved 2 mm (text edit, #820)                                 | `step-tolerance-unsupported` (about 2 mm, over 1 mm)          |
| `reject-unit-mile.step`          | A box with the length unit `MILE`                                                         | `step-unit-unknown`                                           |
| `reject-truncated.step`          | The first half of the plate file                                                          | `step-unreadable`                                             |
| `reject-not-step.step`           | An ASCII STL                                                                              | `step-unreadable`                                             |
| `sheet-open-box.step`            | A box without its top face (an open shell, no solid)                                      | One sheet (R2a-1): 500 mm², 4 open edges                      |
| `sheet-closed-box.step`          | All six faces of a box as a shell, no solid                                               | One sheet, not a solid: 600 mm², no open edge                 |
| `reject-two-shells.step`         | Two open boxes apart (two shells, no solid)                                               | `step-multiple-shells`                                        |

The R2a-1 files are written after the others, so the earlier files keep their bytes.
`normal-millimetre-plate.step` is a text edit of the plate's file, so it keeps the plate's geometry
and needs no writer change.
`sheet-open-box.step` was `reject-open-shell.step` before sheets were imported, and
`loose-tolerance-gap.step` was `reject-tolerance-gap.step` before a tolerance up to 1 mm was kept as
read (#820), and `normal-ap242.step` was `reject-ap242.step` before one part as AP242 was read (#811). Volumes are the
native reader's; `kernel.test.ts` compares the Wasm reader with them (relative
difference below 1e-6).

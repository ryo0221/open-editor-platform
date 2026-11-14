# schematic-core (SL1–SL3, pure schematic model)

Private pure TypeScript model for schematics in the circuit domain of the circuit simulation plan and ADR 021 (addendum). No DOM, React or Worker, and no import of another domain's package.

- `model.ts`: `schemaVersion: 1` types, the only schema (`SchematicDocument`: sheet, symbols, parts, wires, junctions, labels, power ports). Millimetres on the sheet, y down; every point on the 1.27 mm grid.
- `validateSchematic(unknown)`: strict plain-JSON validation with path diagnostics (errors and warnings): exact keys, one ID namespace, grid and sheet bounds, orthogonal wires that do not double back, unique references, existing symbols; warnings `wire-touch` (an end inside another wire without a junction) and `junction-alone`.
- `schematicNets`: the nets the drawing makes (wire vertices, junctions, labels and power ports of the same name), independent of list order; `schematicNetProblems` for one net with two names.
- `applySchematicOperation`: pure, atomic operations (`insert`, `update`, `delete`, `setSheet`, `move` with wires that follow), each result validated as a whole. `schematicEditorCommand`: one `EditorSession` transaction per operation, re-checking the base hash and edit authority.
- `symbols.ts` (SL2): parametric symbols (`generateSchematicSymbol`: resistor, capacitor, inductor, diode, LED, BJT, MOSFET, push button, battery, voltage and current sources, a 1×N connector, an IC box from pin lists), `schematicSymbolLibrary` (one of each), and `schematicPartSuggestion` (a new part's value, model, footprint and pin map).
- Parts (SL2) may carry a `footprint` (a `pcb-core` generator and its parameters; it must make a footprint), a `pinMap` (every pin to a pad of that footprint), a circuit `model` (`models.ts`: kind, terminals on the symbol's pins, values in range) and `noConnect` pins. `parts.ts` starts them: `schematicFootprintStart` (a footprint sized for the symbol's pins), `schematicAutoPinMap`, `schematicModelFor`, `schematicWithFootprint`.
- `schematicErc` (SL2): driver conflicts (`erc-output-conflict`, `erc-power-conflict`), nets of inputs only (`erc-no-driver`), supply pins nothing drives (`erc-power-undriven`), pins left alone (`erc-unconnected`) and not-connected marks that are connected (`erc-no-connect-connected`).
- `fixtures.ts`: `schematicStarter` (A4 with the symbol library) and `schematicLedExample`.
- `hat-example.ts` (SL8d, F90): `schematicHatExample`, the schematic of the project's own sensor HAT+ (F76): no ERC findings, and sending it to `f76HatBoard` changes nothing. R4, D1 and SW1 carry circuit models.

- `board.ts` (SL3): `schematicBoardDiff` (the changes that bring one board version in line with the schematic: parts by reference, nets as `REF.PAD`) and `schematicBoardOperations` (the selected changes as `pcb-core` operations, applied as one transaction by `pcbBatchCommand`). The schematic is the source; the board never writes back.

Not yet here: the send-to-board screen (SL3b), circuit simulation (SL4–SL5). See the verification record.

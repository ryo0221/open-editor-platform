# schematic (SL1, schematic Surface)

Private React Surface for schematics (circuit simulation plan, ADR 021 addendum). It edits a `schematic-core` document through `SchematicController`, a React-free controller whose every edit is one `EditorSession` command; the Host saves and owns Undo/Redo.

- `SchematicSurface`: an SVG sheet (mm, y down) with wheel zoom and drag or Shift/middle/right-drag pan; tools to place parts (R turns), draw orthogonal wires, add net labels, power ports and junctions; drag to move with wires following; part list, net list and warnings; Inspector for the sheet, parts, labels and power ports.
- Simulation (SL5b, `simulate.ts`, `simulate-panel.tsx`): the Inspector's "Simulation" section runs `circuit-sim-core` in a Worker (`simulate-worker.ts`; on this thread where no Worker starts) for a DC operating point or a transient. Its settings belong to the screen, not the document: named nets as 3.3 V GPIO pins (output high/low with an optional toggle time, input with pull-up/down/none) and switch presses. Results show as voltage tags on the sheet, LED glow, tables of net voltages and part currents at a time cursor, inputs read, a waveform of probed nets and a CSV download; a result for an earlier drawing is not shown.
- `view.ts`: pure view math (fit, zoom, screen ↔ sheet, part boxes, wire legs).
- Test host: `npx vite --config packages/schematic/vite.config.ts` (port 4209), `?fixture=starter|led|led-sim`, `?readonly=1`. Browser tests: `E2E_SUITE=schematic npx playwright test`.

# cosim (SL8b, co-simulation Surface)

The co-simulation Surface of the circuit simulation plan (SL8) and ADR 021 (addendum): a ladder program and a schematic running together (`cosim-core`).

- `controller.ts`: `CosimController` over an `EditorSession<CosimDocument>`. The Host gives `CosimSources` (saved versions of schematics and ladder programs; one exact version is read by its content hash). Edits (name, the chosen versions, bindings) replace the document as one session command, re-checking the base and edit authority; they are refused while running. `load` reads the chosen versions and lists the nets the calculation uses. Running: `step`, `start` (one scan per `scanMs`), `stop`, `reset`; `press` (a switch) and `setInput` (an unbound BOOL input) are queued one per scan, so a press and its release both reach the circuit.
- `surface.tsx`: `CosimSurface`: version pickers and the bindings table on the left; the schematic (read only, `SchematicSheetView`) with net voltages and LED glow, and the ladder diagram (`LadderDiagramView`) with power; switches, unbound inputs, the program's BOOL values, LED currents and net voltages on the right.
- `test-host`: `?fixture=hold|empty`, `?readonly=1`, with saved versions in memory (port 4217, suite `cosim`).

Unit tests: TS-2118. Browser tests: TS-2119. The Playground kind `cosim` (SL8c) reads saved versions of the Playground's schematics and ladder programs.

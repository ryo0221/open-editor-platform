# cosim-core (SL8a, ladder ↔ schematic co-simulation)

Private pure TypeScript co-simulation of a PLC ladder program (`ladder-core`) and a schematic (`schematic-core` through `circuit-sim-core`) for the circuit simulation plan, SL8 and SL-U6; ADR 021 addendum. No React, no other domain.

- `CosimBinding { variable, net, kind, pull?, activeLow? }`: a BOOL ladder input reads a named net against the GPIO threshold (with a pull resistor, up by default); a BOOL output drives a net through the GPIO output resistance (`cosimGpio`: 3.3 V, 40 Ω, 50 kΩ pulls, 1.65 V threshold, as the schematic screen's GPIO). `activeLow` inverts both (a button to ground is TRUE while pressed).
- `Cosim`: per scan, as a PLC: switches pressed by hand and unbound inputs/forcing change → the bound inputs are read from the circuit at the period's start → one `ladderScan` → the outputs drive the circuit → the transient advances one scan period (`circuitTransientStepper`). Outputs and switches change only at period boundaries, so a press is seen one scan later. Each `CosimFrame` has the ladder state, the power of every node and coil, and the circuit at the period's end (net volts, each part's main current). `cosimRun` runs a schedule of changes.
- Refused (`CosimError`): `ladder-invalid`, `cosim-variable` (not a BOOL of the binding's role, or bound twice), `cosim-net` (not a net the calculation uses, ground, or bound twice), `limit-bindings`; the circuit's own refusals stay `CircuitError`. A run is bounded by `cosimLimits.seconds` (a safety limit, not a performance promise).

- `document.ts` (SL8b): `CosimDocument` (schema 1): a name, the schematic and ladder versions it runs (artifact, version and content hash; the documents stay in their own Artifacts) and the bindings. `validateCosim` (strict, with paths; a variable or net bound twice is `binding-duplicate`), `cosimStarter`.
- `fixtures.ts`: the LED example with circuit models and the self-hold bindings (`cosimSelfHoldExample`), and F92 `cosimHatExample` (the HAT schematic F90 with the self-hold program F91), written for this project.

The screen is `@editor-platform/cosim` (SL8b). Unit tests: TS-2116, TS-2117.

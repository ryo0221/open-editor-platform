# Fishbone / FTA structured analysis prototypes

Status: **Prototype; not an accepted domain Editor or a certified safety/quality analysis tool.**

This experiment reuses the existing Structured Graph kind, retained versions and commands. It adds two Host-owned Profiles and starter Graphs, without new Artifact kinds, servers or persistence.

## Try in the Playground

1. Launch the existing Playground and open the Library / new Artifact flow.
2. Choose **Structured Graph** and select **Fishbone / Cause analysis (prototype)** or **FTA / Fault tree (prototype)** from the Graph template selector.
3. Create an Artifact; select nodes to edit attributes in the Inspector; use the existing editing, Undo, save-version and export functions.
4. In FTA, edit basic-event probability between 0 and 1. The read-only banner recalculates against the current draft. Invalid models show a reason instead of a guessed probability.

## Semantics

- Fishbone defines typed problem, category, cause nodes and contributes edges; cause status can be candidate, confirmed or excluded, with evidence notes.
- FTA defines typed top, basic, and, or nodes and directed input edges. Probability is a typed number, not a label.
- Both are native Structured Graph documents. The sample fishbone is pre-positioned as a cause-and-effect map; it is not a custom Ishikawa-bone renderer.
- Cause hypotheses are not automatically treated as verified FTA basic events. The formats do not create cross-Artifact references automatically.

## FTA math and limitations

Under the explicit independence assumption: AND = product of probabilities; OR = 1 minus product of complements. Two independent events at 0.01 and 0.02 give OR = 0.0298 and AND = 0.0002.

- The calculator assumes independence; it does **not** prove it.
- It refuses repeated basic events, disconnected nodes, missing gate inputs, cycles, invalid probabilities and ambiguous top events.
- Common-cause failures, dependence/correlation, repair processes, time-dependence, rates and time units, dynamic/voting gates, cut sets, uncertainty, sensitivity and certification are **not supported**.
- The result must not be treated as a certified safety analysis or an approved quantitative assessment.
- Editing uses the generic Graph Surface, not a bespoke fishbone or FTA interaction.
- Local editing and save follow the existing Graph Host; shared editing, product workflow integration, and cross-Artifact conversion are out of scope.

## Verification and next steps

Relevant automated tests: apps/playground/src/app/analysis-graph-templates.test.ts and apps/playground/src/app/graph-templates.test.ts. Also run repository lint, typecheck, build, and relevant desktop/mobile Graph E2E scenarios. Unexecuted checks must be reported as NOT RUN.

Use this prototype to evaluate the user experience of creating and linking causes, attaching evidence, editing fault-tree gates, understanding invalid input, and preserving structured data. Do not add a new Editor kind without demonstrating a semantic need under docs/editor-development.md and docs/editor-acceptance.md.

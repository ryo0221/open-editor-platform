# Open Editor Platform

Issue #264 adds reference embeds from committed Data/Graph versions to Document,
Slide, Design and Whiteboard. Choose **fixed** or **follow saved changes** at creation;
source updates affect rendering without entering destination Undo. Native files retain
exact source hashes and Graph Profiles. See the [public contract](docs/artifact-references.md)
and [verification](docs/verification/issue-264/README.md). Shared reference editing and
Office/React live-reference export are explicitly unsupported.

Issues #255–#257 add opt-in 10px Design reusable text, public text-fit preflight,
attributed vector shapes with token-bound fill/stroke, and Noto Sans CJK SVG defaults.
Existing immutable definitions keep their hashes and layout behavior. See the
[API contract](docs/design-reuse-graphics.md) and
[verification](docs/verification/issues-255-257/README.md).
Vectors render within their declared view box; instance-aware reuse reports text
hidden by fixed clipping frames, including after expansion.
SVG clip IDs belong to drawing occurrences; custom Whiteboard/Data SVG builders use
the same Noto fallback as Drawing-based exports.
Compact arc flags and XML-safe provenance are supported; template overflow diagnostics
identify the input field while empty placeholders keep their geometry and sizing.
Text expansion accounts for rich line height/padding and updated sibling layout;
vector records require own fields that survive native JSON save/reload.

Design now stores frame interactions and named prototype flows. The ordinary Inspector
edits element and component-part links; the separate prototype view runs navigation,
state switches, back and overlays without changing editing history. Headless diagnostics
and Host callbacks cover broken links, flow completion and anchored comments. See the
[contract](docs/design-prototype-contract.md) and
[verification](docs/verification/issue-246/README.md) for compatibility and tested scope.

The opt-in internal Rust/Wasm spatial experiment preserves normal Hosts' TS
selection path. See [boundary and optional build](docs/spatial-wasm-design.md) and
[functional verification](docs/verification/issue-247/README.md). Performance
measurement remains paused and no speedup is claimed.

A host-independent editor workspace for documents, structured data, text review,
file inspection, whiteboards, design compositions, slide decks and registered React UI.
The local editor runs without authentication, a backend, an API key or an AI service.

Graph reading Hosts can hide editing tools/Inspector, configure initial and filtered
Fit, set node sizes, filter relation types and emphasize adjacent nodes. Full label
names, collision-aware edge labels and declarative Profile line styles improve
reading without changing native content or Undo. See [embedding](docs/embedding.md#structured-graph-local-mode),
[design](docs/graph-reading-design.md) and [verification](docs/verification/issues-224-228/README.md).

The latest [audit scope](docs/issues-53-73-audit.md) covers PDF text/search, table
navigation, source/annotation boundaries, Data view history and CSV scopes,
Office capabilities, native Design semantics and accessibility. Its
[verification record](docs/verification/issues-53-73/README.md) separates tested
local behavior from unrun native IME, devices, Office and performance acceptance.
The [review follow-up](docs/verification/issues-53-73/pr52-review-followup.md) covers
input rejection/formatting, multiple annotation references, image components, row
frame fitting and the independent Graph Host's hit testing and private history.
CSV formula targets block append, and version restoration flushes retained inputs.
Three rare-case findings were initially deferred and subsequently corrected.
The [next review corrections](docs/verification/issues-53-73/pr52-review-triage.md)
flush shared Form input before version save, normalize tabbed PDF text, route around
visible Graph nodes, connect to visible Whiteboard targets, re-decode replacement
bytes after encoding changes and keep definition JSON errors independent. New
fictional Definition edges retain canonical IDs. The later completion initializes
the first-column Graph label, retrieves legacy Review sources, preserves File anchors
on remap and marks partial PDF search results. Field decimals and widget titles
belong to their parent draft, Host CSV uses confirmed shared Data, and absolute
frames offer fixed sizing with child fitting disabled. The triage report records
the current checks and previous checkpoints separately.

The preceding review fixes ordinary Document text export, shared-session exit, Slide
add/delete, blurred input retention, CSV row width/read-only mapping diagnostics,
stale annotation source navigation and independent Host keyboard history. Concurrent
Graph route removal during endpoint dragging and explicitly duplicated component
IDs are excluded as rare cases; their threads remain unresolved in the triage report.

The preceding selected scope fixes collaboration-start input loss, independent Host
Surface-switch/shared-Detach input loss, and image-first native publication slot
selection. Invalid/composing or refused inputs block unmount; accepted operations
use the existing native session and shared checkpoint. Reapplying an identical preset
size to a Hug frame remains a known constraint with an explicit fixed-size alternative.
The two previously excluded rare conditions remain outside this scope.

The preceding ordinary follow-up aligns Document Surface MD/HTML/PDF snapshot capture,
template/reusable authoring input checks and retained preview/save source, and Graph
connection selection/stamp validation during both submit and Host flush. Host text/
CSV/Office capture share the current canonical reader; text export rechecks context
and newly pending input after confirmation. A separate native publication correction
checks primitive public fields and non-image slot targets without depending on the
optional Surface extension. The existing known constraint kinds remain unchanged.

The preceding follow-up fixes Data chart output capture, typed Graph edge labels,
PDF error notices and image-safe Design publication/conversion.
Slide/Whiteboard/Design graphic capture also uses refreshed content/scope/settings.
Date-range Data templates use typed reference mapping across creation and linked reuse: literal
dates/text stay unchanged while column/row/view/Graph bindings remain valid.
Retained native/template versions are unchanged. See the
[review record](docs/verification/issues-53-73/pr52-review-triage.md).

The current three-comment follow-up shares input/acceptance checks for all Slide
additions, keeps legacy null Data Graph labels readable without rewriting saved
versions, and aligns inherited Canvas typography across local/shared text engines,
display and native serialization. Peer edits, checkpoints and selective Undo retain
selected false overrides. Previously held condition kinds remain outside this scope.
Common Canvas/SVG output resolves decorations per run to display partial removals.

## Run

Use Node.js 20.20.2 (or a compatible version >=20.19), npm and Python 3.10+.

```sh
npm ci
npm run fonts:fetch
npm run dev
```

Open the URL printed by Vite (normally http://localhost:5173). Local drafts and
versions live in the browser's IndexedDB; export native JSON to keep a portable
backup. Clearing browser storage removes local data.

For the optional in-memory shared-editing reference, also run
`npm run collaboration:server`. For the registered React preview/build reference,
run `npm run react-ui:dev` in another terminal. Production authentication,
authorization policy, durable servers and AI execution belong to the consuming Host.

## Use and integrate

- Document: semantic blocks, rich text, lists, tables, annotations and DOCX export/import.
- Data: Grid, Form, Graph, Chart, Kanban, Dashboard, Timeline, Roadmap and Summary.
- Structured Graph: typed local graphs, guarded connections/attributes/layout and native JSON.
  External adapters edit their own canonical source; `/graph-host.html` demonstrates
  independent native/Data/fictional Definition embedding. Graph shared editing,
  annotations, templates/reuse and format exports are unavailable.
- Review and File Viewer: text comparison, original-byte retention and annotations.
- Whiteboard, Design and Slide: native canvas editing, versions, templates and exports.
- React UI: registered Host components, isolated preview and declared TSX output.
- Design/React bridge: declared semantic components, routes and explicit regeneration.

Recent [usability improvements](docs/issues-42-51-usability.md) add Graph endpoint
dragging, source/definition navigation, retained input with save preflight, in-place
Canvas text, native React publication settings, adjacent Slide copies and
Whiteboard full-body search. [Source checks and limits](docs/verification/issues-42-51/README.md)
separate the tested Chromium subset from native OS IME and other environments.

Import workspace packages through their existing `@editor-platform/*` entrypoints.
The package scope is retained for API compatibility. Packages expose TypeScript
source for a bundler-aware Host; npm package publication is separate from this repository.

See [architecture](docs/architecture.md), [embedding](docs/embedding.md),
[collaboration](docs/collaboration-host.md), [templates](docs/template-contract.md),
[native reuse](docs/reuse-contract.md), [React UI](docs/react-ui-contract.md),
[Design/React](docs/design-react-contract.md),
[Structured Graph](docs/structured-graph-contract.md) and [status/limits](docs/status.md).

## Develop an Editor

Start with the [developer guide](docs/developer-guide.md) (Japanese). The
[Editor development guide](docs/editor-development.md) covers domain design,
native models, commands/Undo, independent embedding, Host registration and
capability adapters. Use the [acceptance criteria](docs/editor-acceptance.md)
to review mandatory requirements and conditions for declared capabilities.

Copy the [design proposal](docs/editor-proposal-template.md) and
[verification report](docs/editor-verification-template.md) templates for a new
Editor or a substantial capability addition. Define supported and unsupported
behavior first; distinguish PASS, FAIL, NOT RUN and justified N/A in the report.
Local-only or Viewer-only scope is possible when its limits are explicit.
Functional acceptance does not lift the current performance hold.

## Verify

```sh
npm run check:files
npm run test:tooling
npm run lint
npm run typecheck
npm test
npm run build
npx playwright install --with-deps chromium
npm run test:e2e
```

Browser tests exercise desktop and mobile viewports and fail on browser errors.
Generated reports, screenshots and exports stay outside Git. Additional Office
rendering requires its separately pinned verification environment; see
[assets and verification](docs/repository-assets.md).

## Updates and contributions

This repository receives reviewed, sanitized snapshots with its own Git history.
See [CONTRIBUTING](CONTRIBUTING.md). A source synchronization does not imply that
all release, performance or external-product acceptance checks passed.
Third-party license and provenance notices remain attached to their respective assets.

## License

Project source is licensed under [MIT](LICENSE). Third-party dependencies, fonts
and upstream test fixtures retain their own license/provenance notices.


Geo is available in the Playground artifact library. It supports local geographic
editing, pinned Data joins, map styling and fixed PNG or explicit fixed/follow
Slide map references. See [the Geo guide](docs/geo-guide.md) for the complete flow,
resource limits and the explicit adoption boundary for Data updates.

# Design / React bridge (#29)

Read ADR011 and the existing
[React registration contract](react-ui-contract.md). Implementation/verification status
must be checked in status.md; this contract is not an acceptance result.

## Native data and public API

`@editor-platform/design/web-contract` declares `DesignReactReference`,
`DesignWebElement`, `DesignWebComponent` and `DesignWebSettings`.
`@editor-platform/design-react-core` exposes deterministic conversion/export,
public-input/slot edits, explicit revision adoption, conversion acceptance and regeneration
review/application. Human and Host commands use the normal Design domain codec.
References, public inputs, slot node IDs, binding schemas and page/frame IDs survive native
save/reload and artifact JSON export/import. Unresolved runtime references remain data.
The ordinary `DesignSurface` exposes an optional extension; `DesignReactSurface` adds
the registered Library, typed public-input Inspector and live isolated preview without
replacing its native tree or history. Leaf conversion to an original preserves the
native ID, parent and geometry; changing an original's internal TSX stays Host-owned.

Set an explicit HTML tag on every native semantic part. For a compound native component,
set a PascalCase export symbol, immutable version, typed public inputs with native part
IDs/fields, explicit variants and optional normalized callbacks. An instance's `webProps`
provides its public values. Original React props/events/slots/layout come only from its
retained registration. An original slot must explicitly accept a generated native component
identity; otherwise assignment is rejected and requires a reviewed Host registration.
Native public slots also target explicit part IDs. Removing a slot assignment detaches
the native child rather than deleting it. Slot descendants are drawn by their outer React
owner; React flow controls their position, unless explicit Web positioning is declared.
Required props can have preview-only sample values without becoming production defaults.
Native public slots currently accept visible generated non-image HTML parts only;
original React nodes, nested native instances and images cannot consume their context
and receive addressed `slot-target` diagnostics. Publication settings initialize and
reconcile the slot target from those same eligible parts; an image-first component can
select its sole non-image part, while no eligible part disables slot addition.
Public fields follow the rendered tag:
images expose `src`/`alt`, other supported primitives expose `text`/`fill`. Unsupported
target fields diagnose `public-target`.
The native publication command checks these primitive fields and non-image slot
targets before creating a command, including when no optional Surface extension is
installed. Other conversion, HTML, asset and Host build diagnostics still apply.
Ordinary subtree duplication remaps both
original `react.slots` and native `webSlots`, keeping the original subtree unchanged.
Duplicating only a slot child inserts its new ID immediately after the original in
the existing owner's slot. Slot limits are checked before any change; the copy and
owner update share Undo. Reassignment removes the child from all previous slot owners
and validates both old and new ownership atomically.
Ordinary Delete/Cut removes every deleted descendant from surviving public slots in the
same native command. Required-slot minima reject without changing the draft; deleting
the owner together with its subtree is allowed. Undo restores elements and ownership
together. Original insertion checks the exact retained destination slot, its accepted
component identities and cardinality before committing. Slot-contract reads survive
serialized authority submission.
React UI's single-node Library insertion is disabled for registrations with required
children and describes the addressed slots/minima. Import a complete composition JSON,
or obtain a Host-proposed complete composition. Public multi-edit commands validate once
after all parent/child insertions, so required slots can be supplied atomically.
Named variants reserve the input `variant`, and variant text/fill patches require a
native part that actually renders those fields. Page inputs/callbacks cannot use the
Site router's reserved `path`. Preview preserves explicit nullable values and installs
event handlers only for callback-bound events, matching emitted TSX.
Environment CSS/asset paths must be distinct, including case differences. Export
preflight checks dependency paths against actual generated filenames, including named
Design pages/components. Host build/provider/typecheck diagnostics block React UI
download even when exact reference resolution is present.

Declare sorted minimum-width breakpoints and allowed CSS/token layout values. AutoLayout
maps to Flex, ordinary absolute children to positioned HTML and horizontal stretch to
percentages. Right/center/scale, vertical constraints, strokes/rotation/rich text runs and
unsupported shapes require an explicit supported mapping or graphic output. They are not
silently claimed as responsive/semantic UI. Images require alt text and embedded PNG/JPEG/
WebP bytes; original registered assets/providers/CSS stay pinned by the Host environment.
Embedded payloads must have canonical base64 and the declared PNG/JPEG/WebP signature;
PNG also requires its IHDR header. This is a byte-format guard, not a full image decoder.
Known native HTML is checked across generated component documents and injected slots:
nested forms/anchors/labels and block content inside phrasing-only containers are refused
with addressed `html-content` diagnostics. Original component internals remain opaque.
The supported semantic subset includes ordinary text, rectangular frames, embedded
images and compound instances. Rich text runs, non-rectangular shapes, strokes, rotation,
reflection, non-unit opacity and non-identity image crops are diagnosed.

Native image layers must declare `img`: Inspector/publication choices and the
native publication command share this constraint. Existing/imported image parts
with a different tag produce a blocking `image-semantics` conversion diagnostic,
so a valid native image cannot silently export as a text/fill primitive.
The explicit Web layout can intentionally differ from the fixed native canvas geometry. Whole-canvas
pixel identity is not promised; isolated Web preview and emitted output share the same
semantic program and viewport rules.

## Output and recovery

Main Web UI output includes semantic native components, original imports, named page TSX,
CSS, `Site.tsx`, dependency/route manifest, conversion mapping/config and native resume JSON.
Public data/callbacks are typed props; preview mock state is not production callback code.
The Host supplies path/router/entry/build/dependency bytes, never an Editor selection or
history runtime. React SVG is auxiliary, non-interactive graphic output with a loss warning.
It refuses external React references, including those inside native component definitions;
the normal SVG/PNG toolbar uses the same guard. Without declared pages, export requires an
explicit selection. Multiple selected roots are all included. The manifest pins the native
draft by content hash, native component versions, original identities, environment and
each generated implementation file. `native.json` resumes ordinary Design editing.
The bundle retains the reviewed root IDs and output mode. Acceptance reconverts the
same selection; source changes anywhere in the native content still reject it.
Original registrations nested only inside native components are deduplicated into
the manifest with their complete exact references/import metadata.
Page symbols must not collide with `Site`, `NativeComponents` or any generated component/
variant module; case-insensitive output path checks reject collisions before returning
a bundle. A hidden declared page frame diagnoses `page-hidden` rather than producing
an empty successful route.

Accepting output stores a bounded receipt (`sourceHash`, `fingerprint`, per-file hashes),
never copies TSX/native JSON/image bodies into native Web metadata. Legacy file receipts
remain readable and are upgraded on acceptance. Image `src` fields may explicitly use
the existing 4 MiB JSON budget; default ordinary string limits remain unchanged.
Acceptance validates the complete next native state inside its ordinary command.
Acceptance and Host-publication commands declare complete native source reads; serialized
authority operations retain element/component/style, collection order and root/reuse
preconditions through peer edits after client-side preparation.
Native publication references are retained independently across receipts, saved versions,
Host registration and native JSON. Reusing an ID/version with changed contract or
implementation diagnoses `publication-version` before Web export; an explicit version
increment is required, and earlier references remain retained. Implementation hashes
cover each native program's generated dependency closure and original reference pins;
adding an unrelated component does not change an existing publication. The manifest
separately pins the complete emitted module bundle and each exact generated file.

Missing references/slots/required inputs/bindings/assets, duplicate routes, unsafe identifiers,
unsafe CSS and unspecified semantics prevent atomic Web output. Diagnostics address native
IDs or composition paths and explain recovery. Original source is never rewritten.
Regeneration compares stable source/config/output hashes and returns file-level changes.
`reviewDesignRegeneration` / `applyDesignRegeneration` check the reviewed fingerprint and
current owned bytes, preserve handwritten paths and refuse local edits in generated files.
`reviewDesignReactDocumentRegeneration` merges a retained baseline, new native conversion
and current React UI document by stable IDs. Independent public-input/layout/slot edits and
user nodes survive; overlapping edits, removed edited nodes and invalid merged compositions
conflict. `applyDesignReactDocumentRegeneration` checks the target hash and uses its normal
command/history/authority path. There is no reverse parser for manually edited TSX.
Root order is a three-way field too: a React-side reorder or insertion position survives
when native roots are unchanged; incompatible changes on both sides conflict at `roots`.

## Reference Host and verification limits

Run both `npm run dev` and `npm run react-ui:dev`. The reference Host resolves exact
originals and immutable generated publications, validates and recomputes the native program
before preview, checks message origin/session/request/revision/environment and supplies
verified CSS/assets/modules for export. It never evaluates submitted TSX. Missing retained
publication bytes require Host recovery even when native JSON remains readable.
Resolving generated components under a different retained source environment is rejected
before preview success; an environment change requires explicit reviewed regeneration.

For the dependency acceptance fixture, open Playground with `/?design-dependencies=1`
before enabling React Web settings in ordinary Design. This opts into a separate immutable
Host environment. Library's `DependencyBadge` is a default export whose original source
imports the named `Card`, a PNG and scoped CSS through fixed aliases. It requires the
existing theme Provider and exposes `label`, `onPress` and the named `footer` slot.
The original default environment and registration hashes remain unchanged. Saved native
content retains this new environment and can resolve it after reloading without the query.
The fixture resolves trusted local source; it does not install or evaluate arbitrary npm
packages or uploaded TSX.

`node scripts/design-react-export-host.mjs <downloaded.zip> [site|page|component]`
checks the ordinary fixture's output in an independent React app. The default is `site`;
`page` uses the first declared page and `component` uses its native `ProductCard`.
It now uses default tree-shaking with the corrected Rollup 4.64.9 lock. The earlier
dependency-fixture attempt with Rollup 4.64.0 stalled and was stopped; its raw failure
remains in the [original evidence](verification/issues-29-260-278/README.md).
The [new follow-up](verification/issues-38-261/README.md) records the patch and independent
component/page/site checks. Each compiler/build invocation has a 60-second diagnostic
deadline; this is not a performance acceptance budget or a requirement for other Hosts.

The reference registry currently accepts one complete native publication per composition.
Publishing changed native definitions requires a new explicit native component version.
Every retained reference-Host reviewed Card edition is checked against the Host's original
contract rule and resolved to the unchanged original TSX, even after new native component
IDs create a newer edition. Arbitrary modified editions are not approved. Previously
saved experimental output retains its old pins; a generator identity change requires
explicit re-publication rather than silently substituting new implementation bytes.
Its cross-artifact registration/regeneration UI is local-only; a shared consuming Host must
route the public regeneration command through the target authority. JSON editors remain for
advanced component contracts, Web layout and page/root settings; no visual CSS designer,
router/auth/API implementation or consuming-product integration is claimed. See the
local verification and limitations. CI and performance
measurement stay paused; product trials belong in the consuming Host.

# Reusable definitions and tokens (#18 / ADR009)

Design reusable text can explicitly use a 10px minimum. Attributed path shapes use
the existing fill/stroke styles and artifact token modes, including SVG/PNG export.
See [Design text and graphics (#255–#257)](design-reuse-graphics.md) for authoring APIs,
fit preflight and immutable-definition compatibility.

`@editor-platform/reuse-core` is a pure public package. It depends on
`artifact-core` and the pinned `@noble/hashes` SHA-256 implementation, never React,
a catalog, network access or Editor chrome. It owns
reference/closure validation, typed token and public-input resolution, addressed
diagnostics and the declared domain contracts. Native materialization and updates
belong to domain adapters; a hash-valid generic payload is not proof of native
validity. Publish/import/apply must also use the corresponding native validator.

The implementation stages are recorded in [status](status.md). The capability
table below is the contract for W2–W4, not a claim that their UI is complete at W1.

Public async component insertion, property/slot/settings preparation and revision
or mode preview take ownership of input values at call entry. Mutating caller-owned
identity, snapshots, input objects or update choices while awaiting a result cannot
change the prepared transaction. Permission enforcement still belongs to the
trusted authority, independent of the captured operation identity.

## Identity, storage and validation

- `DefinitionRef` contains library ID, stable definition ID, exact integer version,
  SHA-256 content hash, kind and domain. Names and array indexes are not identity.
  A shared definition is a token set; native structures retain their own domain.
- `ReusableDefinition<T>` hashes its complete unsigned JSON, including dependencies
  and payload. `sealReusableDefinition` returns frozen data. Hashing does not grant
  publication rights. The Host owns catalog access and atomic publication.
- `lockClosure` requires every direct/transitive exact reference, rejects extra or
  duplicate identities, and normalizes order with code-unit comparison. The closure
  includes each definition's payload/assets and has its own fingerprint. It performs
  no discovery or fetch and never chooses `latest`.
- `ReuseInstance` records the adopted ref/closure, public inputs, explicit overrides
  and stable part/slot-to-native-ID maps. Explicit keys remain explicit even when
  their value equals a default. Native content is the editable authority. The
  adopted definition is an immutable update base, not a second editable document.
- `readReuseState` is a bounded structural read; `validateReuseState` additionally
  checks all closure hashes and exact adopted references. Domain adapters must
  verify native addresses, payload/input/slot semantics and their current content.
- Absence of reuse metadata is the legacy copy-only state. Unknown schemas reject.
  Existing template definitions, built-in hashes, native drafts and immutable
  versions are not migrated into linked instances or rewritten by this package.

The schema-1 bounds are 100 definitions per closure, dependency depth 16, 2,048
tokens, 16 modes, alias depth 32, 2,000 instances, 10,000 parts per definition and
20,000 expanded parts. Generic JSON processing allows 200,000 values, depth 64 and
32 MiB UTF-8 JSON. Native/template/image limits can be lower and still apply.
Nonfinite numbers, cyclic objects, reserved keys, executable values and sparse
arrays reject before cloning/hashing. Limits are public through `reuseLimits`.

## Public properties and slots

`ComponentContract` declares stable parts, typed properties, named variants and
typed slots. Public types are text, rich spans, number, boolean, enum and portable
image/manifest asset. Defaults and variant values are validated with the same rules
as human/Host inputs. Unknown properties and variants reject rather than falling
back. Required empty text, unsupported rich marks, live URLs and invalid ranges
reject before native operations.

Resolution is property default → selected variant → explicit public input. Domain
style/token defaults precede this; explicit native-part overrides follow it.
`resolveComponentProperties` returns the explicit key set separately from values.
Reset removes an explicit key; it does not infer ownership by comparing values.
Visibility is a boolean property, distinct from deletion. Slots declare a domain,
accepted component/body kinds and min/max count. A native adapter validates the
actual payload, insertion point, nesting, IDs and references after this common check.

## Domain responsibilities

| Domain      | Create / insert                                                | Update and preservation                                                          | Export / private scope                                        |
| ----------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Design      | Native Artifact, Frame-local parts                             | Stable canvas/definition scopes, layout, properties, variants, slots, overrides  | Resolved SVG; external linking is opt-in                      |
| Document    | Semantic block/section and body slots                          | Text-engine steps, native IDs, flow, selection and annotations                   | Resolved HTML/DOCX; no whole-document replacement for updates |
| Slide       | Whole page and same-page objects are distinct                  | Finite dimensions, page order, notes, explicit layout→part priority              | Resolved SVG/PPTX                                             |
| Whiteboard  | World-coordinate nodes, Sections, typed ports                  | Preserve connector endpoints; deleted ports need explicit mapping or hold        | Resolved SVG; no finite-page semantics                        |
| Data        | Typed field set or view/widget                                 | Preserve records, field/row/formula/relation/view IDs; explicit schema migration | Native/CSV; schema and formulas are not design tokens         |
| Review      | No source-copy creation; annotation settings only              | Private comparison settings, explicit source/revision/anchor for new annotation  | Source/revision and existing comments stay unchanged          |
| File/Viewer | No source-copy creation; file-type display/annotation settings | Private settings separate from shared annotation operations                      | Original bytes/hash stay unchanged                            |

`reuseCapabilities` exposes these semantic responsibilities. Actual operations use
the corresponding native adapter and the existing preparation/proposal/authority/
transaction/selective-Undo route. Common contracts are not a universal content model.

## Token and media style subset

`TokenSet` supports typed sRGB color with alpha, absolute dimensions in px/pt,
font-family strings/fallback lists, numeric font weight and unitless numbers.
Primitive values and whole-token aliases share a type. Every declared mode is
validated, including modes not currently selected. Cycles, missing targets, mismatched
types, excessive chains and invalid values reject deterministically.

Mode priority is instance selection → Artifact selection → declared default. An
unknown selection rejects; there is no fallback to a different mode. An omitted
token override within a valid mode uses that token's base value. Modes contain data,
never condition scripts.

`resolveStyle` permits only `styleCapabilities[domain]` targets and verifies each
token type and native range. It returns resolved domain fields with explicit units,
not executable property paths. Canvas dimensions are px; Document style measures
are pt (`1 pt = 4/3 px`). Adapters own rendering/font availability and must diagnose
unrepresentable values instead of silently coercing them. Data permits a view accent;
Review/Viewer permit annotation color, never a source ID/hash or organization setting.

The shared [brand fixture](../tests/fixtures/reuse/brand.ts) resolves the same brand
color and Japanese font family with 16px Design UI, 32px Slide presentation and 12pt
Document prose sizes. The same file supplies the 2,048-token scale fixture. These
are media-specific mappings; arbitrary Design-to-Document conversion is not offered.

## DTCG 2025.10 exchange

The reference is the Final Community Group Report, not a W3C Standard. This package
does **not** claim full Format/Resolver compliance. It never fetches a referenced URL.

| Feature                | Supported subset / diagnostic                                                                                                                   |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Format groups/types    | Nested groups, inherited `$type`, alias-inferred type; portable ASCII path segments                                                             |
| Color                  | sRGB numeric components and alpha (default 1); optional hex fallback checked/reported                                                           |
| Dimension              | Format import accepts px; native pt exports as equivalent px. `rem` needs external context and rejects                                          |
| Typography primitives  | fontFamily string/list and numeric fontWeight; unitless number for declared targets                                                             |
| Alias                  | Whole-token `{group.token}`; missing/cyclic/type-mismatched aliases reject                                                                      |
| Composites             | Typography, border, shadow, gradient, transition etc. reject with addressed unsupported-type diagnostics                                        |
| Advanced Format        | JSON Pointer `$ref`, `$extends`, `$root`, extensions and unsupported metadata reject                                                            |
| Resolver               | Version 2025.10, inline sets/local `#/sets/name` refs in explicit `resolutionOrder`; later token replaces earlier token before alias resolution |
| Resolver modes/sources | Modifiers, external/ref sources and unknown constructs reject; no network or guessed context                                                    |
| Native modes           | Export requires one explicit mode and reports that native switching was reduced to one Format document                                          |

`importDtcg` / `importDtcgResolver` return no token set if any error exists. Warnings
and explicit mode-selection reports remain visible. `exportDtcg` preserves supported
aliases and diagnostics; the exchange document is not a native lock closure.

Sources: [Format](https://www.designtokens.org/TR/2025.10/format/),
[Resolver](https://www.designtokens.org/TR/2025.10/resolver/).

## Ownership and planned integration

The existing template catalog, SaveTemplateDialog, atomic creation and portable-pack
flow remain the integration points. No second library store or Undo implementation
is introduced by the common package. React form/Library/Inspector components belong
in the UI layer; human and Host-agent callers share these pure validators.
Adopted payloads/assets must travel with the Artifact. Library archive/access expiry
cannot erase bytes already materialized in another Host.

## Native load boundaries

`validateReuseStateSync` verifies exact hashes, every retained token mode and alias,
style capabilities/types/units, declared dependencies, instance mode selection and
bounded native ownership/slot graphs. Only recursively frozen validated state is
cached; mutable or shallow-frozen input is rechecked. Design uses scoped paths;
slashes in other native IDs do not introduce component scopes.

Hosts exposing an untrusted native artifact must additionally await public
`validateNativeReusableDefinitions(domain, content)` from `templates` before storage
or activation, for both the draft and each retained version. It checks every native
recipe, variant and public input/asset against the existing materialization API.
This does not replace edited native content with a prototype or rewrite immutable
version hashes. Ordinary Data diagnostic cells remain editable; they are not new
template samples. The playground performs this check before importing an artifact.

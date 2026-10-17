# React UI portability and Host output — #38 / #35

Design revision 1, 2026-10-09. Extension of the existing React UI domain and
Artifact lifecycle; no new Editor, store, history or approval model. Uses the
developer proposal/acceptance templates and ADR010/011 boundaries.

Representative flows: optional-slot component keeps its default; edited composition
round-trips and exports identical bytes; a Host extracts typed registration candidates,
reviews changed contracts and explicitly adopts a new version; an immutable Artifact
version is handed off with a generator pin and verifiable output manifest.

Failure flows: unsupported union/nested ReactNode produces an addressed diagnostic,
bad Host policy/hash is rejected, changed output bytes or a stale source pin fails
verification. Original draft/old published versions stay intact.

## Model and operations

Native schema remains ReactUiDocument v1. Map-key order is not semantic; roots,
slot children, Provider order and breakpoints retain their declared order. TSX
uses a deterministic multiline encoder, no user-string interpolation as JSX.
Empty slots omit the corresponding prop in both preview and output. Required
slot minimum checks remain in existing preflight.

Read-only utilities return frozen registration candidates and stable-ID semantic
diffs. Extracting/comparing does not execute original code or change a catalog.
Original registrations/commands/revision adoption and existing authority remain
the only mutation path; differences are observations, not trusted operations.

TypeScript tooling is a separate optional Host/build package. It reads a checked
Program, extracts supported JSON props, string enums, normalized void callbacks
and top-level ReactNode slots. Unsupported unions, unknown/any, functions in
JSON and nested renderables diagnose the component/prop/reason/recovery. The Host
supplies exact source revision, import/ref/version/implementation hash and a
policy for exclusion, sample values, declared layout/wrapper and slot limits.
No product names or original implementations are imported into core/tooling.

## Host and output boundary (#35)

An optional artifact-output package binds output to an existing immutable version,
checks its content hash and hashes only output bytes. Manifest pins source ID/kind/
version/content hash, generator ID/version, safe file paths/media types/size/SHA256
and Host-supplied dependency version/hash metadata. It never fetches/hashes original
implementation bytes. Verification detects changed files/source pins; it does not
authenticate Host attestations. Manifest excludes itself from its file hash list.

Host owns filesystem placement, approval state, generation orchestration, screenshot
render/diff and trusted original-code resolution. No implicit version commit on export.
The independent export driver explicitly commits its reference input and uses the
same public output contract; ordinary UI keeps existing save/export lifecycles.

## Capability and acceptance matrix

| Scope                                             | Planned validation                                                                                    | Conditions               |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------ |
| Existing local UI/headless                        | optional-slot defaults, edit/Undo/native reload/export, readonly regression                           | N01–N14, C03             |
| Type extraction and candidate comparison          | real reference types + second independent fixture; unsupported shapes, policy changes, immutable pins | N03/N10/N12/N14, C06/C08 |
| Native and TSX portability                        | shuffled maps, first save/reload, separate-process bytes, escaped content                             | N03/N10, C07/C08         |
| Semantic differences                              | stable IDs, reorder/move, props/bindings/layout/version/schema changes, frozen inputs                 | N08/N12, C03/C06         |
| Host delivery                                     | saved version, generator/dependency pins, tamper/missing/duplicate/unsafe-path rejection              | N04/N10/N13, C07/C08     |
| React rendering/build                             | existing 5 reference components/4 independent apps, Chromium desktop/mobile and screenshots           | N06/N11, C08/C10         |
| Shared mutations                                  | no new operation; existing codecs and selective Undo unchanged; related regressions                   | C04/C06                  |
| Native IME/devices/other engines/production trust | NOT RUN; this work does not certify them                                                              | C01/C09/C10              |

Limits reuse existing core bounds (4MiB composition, 128 registrations/fields,
schema depth 16, 2,000 nodes); tooling reads only declared entrypoints and an
existing checked Program. Output has bounded files/bytes and safe relative paths.
No performance measurements/tuning, arbitrary npm execution, app reverse import,
product integration or new hosting/publication is included. Generated output/evidence
stays ignored; Actions stay manual-only. Actual product trials remain consuming-side.

# Fiction Map: local editing, saved versions and fixed images

Fiction Map edits an arbitrary bounded plane, separately from Geo/CRS84. `x=180, y=90` is an ordinary map position. It is not longitude/latitude. This guide describes the normal local Playground; consuming Hosts own persistence, permission and external World services.

## Create and edit

1. Open the library's creation menu and choose **Fiction Map**.
2. Open **Layers and inspector**, enter **New layer**, then **Add layer**. **Draw here** selects the destination layer; its checkbox changes local visibility.
3. Use **Add place** and click the canvas for a point. **Draw path** / **Draw region** collect vertices; **Finish shape** validates and commits one shape. **Cancel drawing** discards the draft. Invalid shapes remain uncommitted with a diagnostic.
4. **Select** selects painted shapes or labels; use the candidate list for overlaps. Dragging a marquee selects bounding boxes: an empty part of a concave polygon can be included. It is not precise polygon selection.
5. Select a feature in the feature list, edit its name, position or metadata and choose **Apply feature**. **Cancel edits** discards pending fields. **Edit vertices** edits path/region vertices; one completed drag is one command. Resize and rotation are disabled.
6. **Undo** / **Redo** use the current Artifact's Session history. Pan, zoom and selection do not create native commands. Another Artifact has its own history. A full browser reload starts a fresh history from persisted content; Undo history is not serialized.

Names/coordinates under composition, dirty Inspector/layer/view fields, unfinished shapes and active gestures block save/export/switch. Explicitly Apply/Finish or Cancel first. Uncommitted IME text is never silently saved. Synthetic composition guards are tested; OS Japanese IME is **NOT RUN**.

## Refine a rough layout

Start with approximate sea/mountain/river/town positions. Save that rough map, then use **地図を段階的に詳細化** to load a bounded Fiction Map **content** JSON candidate. This is native content, not an Artifact envelope or GeoJSON. The producer retains existing IDs for the same places, paths and regions. The preview shows counts/additions/deletions; absent IDs will be removed by replacement. **Apply map refinement** explicitly commits once to the current Artifact through the existing D1 prepared import. **Cancel map refinement** discards the candidate. Undo/Redo use the same history and old saved versions remain unchanged.

The candidate blocks save/export/switch while pending. Other dirty/composing inputs must be applied or cancelled first. A changed revision rejects the prepared candidate; load it again against the new map. Current Host permissions still decide commit. The Editor validates native geometry/resources, rather than interpreting a natural-language setting or simulating climate. The demo uses producer/Codex-assisted rough → terrain → detailed candidates and visible UI application, then hand-edits historical changes.

## Drafts and immutable versions

The Playground persists the mutable draft locally and reports save failures through its existing error/retry controls. Local browser storage is not a backup service. Use native export for a portable copy.

**Save version** creates an explicit immutable version; it is distinct from draft persistence and from Undo. **History and compare** shows saved versions and offers explicit restore into the current draft. Restore is one new command and never rewrites the old version's content/hash. Undo restores the prior draft. A later version does not move an old fixed reference.

Native Artifact JSON export includes the draft and retained versions. Import validates every native and every version hash before admitting the entire envelope; importing creates a new Artifact identity while preserving native feature IDs and their internal references. Unknown schema, corrupt old versions, duplicate decoded JSON keys and capacity violations reject the whole import. This JSON is not GeoJSON; no automatic CRS conversion exists.

## Saved views and image output

**Named document view** starts with document bounds and default layers. Enter explicit **View minX/minY/maxX/maxY** and choose **View layer …**, then **Save bounds as named view**. **Edit saved view …** edits that view while retaining its ID; **Update named view** is one Undoable command. Invalid or stale inputs reject atomically. Apply or **Cancel view input** before save/switch. These fields use native coordinates, not CSS pixels or an unsaved camera crop. Save a version to publish a view update; old saved versions keep their previous view.

Choose **Saved map version** and document/default or an existing named view, then use the explicit SVG/PNG image controls. Output uses saved native, ordered layers and features, labels, colors and strokes, with native y-up/y-down orientation. Width/height are integral 1–4096, subject to the renderer's output budgets. White or transparent background is explicit. Selection, handles, hover and unsaved camera/preview are excluded. Generic format capability remains unsupported; these are dedicated saved-image controls.

SVG is deterministic for a fixed admitted source and options. PNG uses the Host rasterizer/font environment. Tests cover the local Chromium environment, not identical PNG bytes across operating systems or browsers.

## Fixed references and World metadata

The Host reference picker offers saved Fiction Map versions as fixed-only document or named-view images. Public targets can also specify a unique feature ID subset. Exact Artifact/version/hash/view/feature IDs are validated; missing targets do not substitute the latest draft or a similarly named feature. Permission denial removes cached pixels. Offline fallback requires a verified snapshot and a warning.

In the Novel workspace, open the right pane **原稿と照合 → 参照：地図・画像**, choose **参照を埋め込む**, retrieve sources and insert a fixed saved image. The same ReferenceTools/Inspector as the normal Document editor show exact version/hash, status, explicit update and **元を編集**. Character/Setting's **参照：人物・場所** stays a separate Host-owned slot in the same pane; semantic Location links are not inferred from map metadata. Save the chapter, then **通読** displays saved chapters with images/captions in chapter order. Draft text is excluded. Read-through is readonly and reference access is checked again while displayed; missing/denied sources produce diagnostics without editing native/history. A follow-mode image or unconnected reference Host cannot be flattened into saved read-through. Printing, DOCX and EPUB retain their own capability checks; this is not publication-layout acceptance. See the [chapter-output contract](../authoring-contract.md).

For Comic, use **Designで詳細編集** and return with **漫画ワークスペース**. Select its target page in **Page reading order** before inserting, then use **Element width/height** in the Inspector to keep the image inside that page. The generic insertion defaults do not fit every paper size. Both workspaces use the existing reference resolver, exact saved sources and current Host permissions. The picker offers document/named views; an individual `featureIds` subset remains a public Host target tested through an independent mock Host. Real service authorization is not certified.

`worldEntityRef` remains opaque namespace/entity metadata. Renaming or moving a feature preserves its stable ID and reference. External existence, access, Canon and Workflow belong to the consuming Host. The Playground has no live World service; the independent Host tests only a mock.

## Limits and acceptance boundary

Native v1 supports Point, Polyline and one exterior Polygon ring; holes, MultiPolygon, curves and shared topology are unsupported. Resource guards include 64 polyline points, 64 non-closing polygon vertices, 10 layers, 200 features, 10 named views, 1,000 logical vertices and 65,536 native canonical UTF-8 bytes. These are functional guards, not latency guarantees. Units/precision are explicit document policy; no geographic epsilon or silent repair is applied.

**Avoid label overlap** defaults on and tries eight deterministic positions using conservative text boxes. Selected labels get priority; labels with no available position are omitted. Use the feature list, zoom or turn the toggle off to show every label. This is temporary display state, does not rename/move features or enter Undo, and does not change static SVG/PNG label policy. It avoids estimated label/label collisions, not every shape collision or actual font-layout edge case. Shared editing, template/reuse authoring and external format import are not declared. Real touch, native OS IME, screen reader and other browser/OS acceptance remain **NOT RUN**. Functional tests do not approve performance, deployment or release.

[Public model/Surface/Host API](../../packages/fiction-map/README.md) / D3 Host contract / D4 evidence and remaining acceptance conditions.

The setting-driven demo explains the authored geography/history brief, public native candidate and real production UI recording. Real OS IME is deferred by the user; it remains NOT RUN, independently of this scoped continuation.

# #181 capture/history/resource correction

Original #181 remains pinned at tested3ce6b9c2/docsb807de14. This correction is
separate. Lint-only commit **53f26444eccff638f3cadb0a29f743013f170144** removes the
unused directive; focused ESLint passes. Corrected code tested at
**6967ca81c592fbbcc2dc4a355f2460ebe4effff2**; later evidence-only docs do not change it.

## Reproduced and fixed

The regression runner can inject the exact b807de14 Storage implementation without
changing checkout. Against it all **5 FAIL**: A captures old History, another owner
B commits, and A then commits using B's latest head; normal and unknown-reconciled
A saves also delete post-capture B original/plan references in both current and
Undo-held cases. Before report `/tmp/video-capture-before/results.json` is retained,
SHA256 `58ebe4fdbf3a639ead0590ec4cee6485f0a8111520ba868b8cff288d0360cc67`.

- History now carries the journalHead corresponding to its versions. Synchronous
  retainCapture copies it; later dispatch CAS uses only that captured head. A
  separate registry/coordinator does not bypass the guard. Stale A gets a durable
  no-write rejection; B stays selected and A's old History is not relabelled.
- Verified restore derives head from the committed operation's parent+1. Import
  into an empty target starts at0; a historical restored branch has its historical
  head and cannot silently overwrite a newer one. No history merge is attempted.
- Saved History resources and Host-owned live/Undo resources are separate. The
  required LiveCatalog read port adapts the Host's existing OriginalStore. Capture
  borrows the needed union; adopting A cannot overwrite B's live/Undo ownership.
  A's immutable archive excludes post-capture B; the next real capture includes B
  when the current draft/Redo uses it. Host explicitly releases its live owner.
- A definitive pending result drops Project/History/Blob references and retains
  only bounded pin/evidence metadata. Unknown writes retain unresolved ownership.
  `forgetSettled` can remove final receipt metadata; journal fences persist.
  Resource diagnostics distinguish capture, unresolved write, saved original and
  external live owners. A zero captures-map count alone is not full release.

The private constructor now requires a LiveCatalog read port and History.journalHead.
Video must apply the updated interface in VIDEO-HANDOFF.md before ordinary wiring.
No Video-owned Host files, journal bytes, result pin mapping or shared API changed.

## Exact-source results

| Test | Result |
| --- | --- |
| Two registries A capture → B commit → A dispatch | PASS:stale A refused, B selection/head preserved |
| Normal A commit with B in current draft | PASS:B live original/plan preserved; A archive excludes B; next capture/save succeeds |
| Normal A commit with B Undo-held | PASS:Redo +next capture/save succeeds, same isolation |
| Unknown A →verified committed with B current | PASS:live B retained and final pending references released |
| Unknown A →verified committed with B Undo-held | PASS:Redo/next capture succeeds; explicit live release leaves saved-native ownership |
| Original real scoped integration I01–I06 | PASS:6, two real controlled Chromium processes, errors0 |
| Related unit | PASS:185 /9files |
| Root lint/typecheck/build/file policy | PASS; unused-directive warning removed |

All browser runs use actual Chromium151.0.7922.173 and clean tested source. Regression
report `/tmp/video-capture-final/results.json` SHA256
`97978ab0aa05e613dbef18c08afa15a2a3300751f1c56b14621377a2a5726a25`.
Logs: `/tmp/video-capture-final-{unit,lint,type,build,files}.log`. Commands follow
VERIFICATION.md, plus:

```sh
node packages/video-metadata/file-backed-storage/integration/capture-review-check.mjs /tmp/video-capture-final
```

Private original/retained closure and coordinator evidence are preserved. No claim
of GC/heap measurement, ordinary Host acceptance,146MB original acceptance, CI,
performance, main merge/release or OS-crash durability. Scratch interruption
recovery remains the next separate task and must use this corrected ownership base.
Independent review is still required; this correction does not clear #181 itself.

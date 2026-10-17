# Existing Sites Studio Host sources

These are the fictional SORA sample data and Host adapters used by the existing
Editor Platform v2.3 Studio. Domain editing is supplied by public packages through
the independent `@editor-platform/reference-artifact-host` application. This is
reference Host code, not an Editor domain or consuming-product integration.

The canonical source is here so the actual demo changes can be reviewed in the same
PR. `node scripts/sync-studio-source.mjs SITE_CHECKOUT [VERIFIED_COMMIT]` copies the
Host source and byte-identical public platform sources to the existing Sites Git
checkout. With a commit argument it refuses uncommitted/mismatched source bytes.
The tracked Site origin manifest records every Git blob SHA. It does not package,
publish, read credentials or change audience. The Site's own build/hosting manifest
is retained. Source credentials belong in process memory/stdin only.

Studio migration keeps old Slide/Whiteboard content and stable IDs, the TSX source,
and Kanban row IDs/values. Old Kanban arrays become one StructuredData dataset with
Kanban/Grid views and the existing command/history path. Old React prototype data
is a different model; keep its storage key and offer a JSON backup rather than claim
automatic conversion to native Design. Invalid old data remains unchanged and is
reported; new samples use a separate storage namespace.

The normal flow is artifact list → Editor → save/back → reopen. Return retains local
Sessions/Undo/Redo; explicit cancel/discard closes them. Reload restores saved native
content with new local history. Code is a Host-owned bounded single-file extension,
not Review/CodeDiff. Microphone execution stays opt-in and Host-owned. React/Design
uses a native semantic page through the merged #24/#29 public conversion/export APIs;
the old independent composition prototype is no longer the active React experience.

The static Site cannot query authenticated live Sites access policy. Its neutral
label is “共有設定はHostで確認”, independent from browser-local persistence. A consuming
Host may inject fresh access metadata and expiry/change notifications; source build
pins alone never attest to current audience. The existing public policy/revision
must remain unchanged during publication.

Builds, exported JSON/ZIP, images, logs, browser traces and screenshots are ignored.
Run the platform Host unit/browser checks and the Site-specific production flows in
the verification record. Actions and
all additional performance work remain paused; actual-material trials stay consuming-side.

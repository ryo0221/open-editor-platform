# v1 Host review corrections

Code `0689e1be82e17c6b3ce3b54a3e94aeac8c1dab25`, successor to #194.

The Host definition now validates native content plus the complete controlled
view/save envelopes before open and every canonical mutation, including non-UI
execute and history operations. It reserves the existing 4096-node, depth24 and
65536-byte limits with bounded scope/receipt/error fields; no shared limit changes.
Core-valid content can therefore be outside this private Host profile. The
short-ID boundary fixture admits181clips and refuses the next split while keeping
the open controller, exact content/revision and an already-pending Redo branch.
An oversized initial root releases its unopened persistence owner and is refused.
This Host bound does not relabel or change native data or portable validation.

Open captures full view, revision and tracked Inputs generation. Its busy gate
also applies to the exposed non-UI controller. Changed preparations are discarded
without losing the old draft. The unrestricted scoped handle is no longer exposed
by this private Host return object. Close uses shared disposal/close settlements
and a terminal replacement generation. Close during old-owner cleanup waits for
that cleanup and disposes the candidate; it cannot activate a new Host afterward.
Unactivated candidates are also disposed if old-owner cleanup fails.

UI and non-UI Save share the same guarded path. Indeterminate Save latches old
registry/SaveCoordinator ownership, blocks new Save/Open/disposal and retains
original maps. It does not fabricate no-write. Actual reconciliation/unblocking
is still pending the Storage owner's trusted same-coordinator receipt hook; the
current behavior explicitly refuses close rather than claiming safe cleanup.
An injected unknown-evidence adapter regression proves exactly one write/factory,
no persistence close and retained original ownership. These injected adapters test
Host ownership only: they are NOT portable-storage or durability acceptance.

Playback explicitly rejects presentation endpoints that are not integral at48000Hz
before creating an AudioContext. The real fixture T42251/600 maps to3380080points;
its prior exact-tail claim does not generalize to arbitrary rational endpoints.
Native rational editing/export contracts are unchanged. Reader cache remains up
to64frames per session and2sessions; this is not selected-frame-only storage or a
low-memory claim. No total decoded-pixel/byte reservation is claimed.

At the clean code pin: PASS root typecheck, lint, build, file policy,91focused
Core/v1 tests and the browser Host review harness. The additional Core case
preserves an already-existing Redo branch on each of the three admission failures.
Browser proof covers full-view boundary/initial-open refusal, close during pending
replacement cleanup, non-UI mutation and Inputs-generation stale Open, and unknown
Save retention. Browser errors0. Logs `/tmp/video-v1-review-*-pinned.log`, raw
results `/tmp/video-v1-review-pinned/results.json` (outside Git).

Normal actual-original UI/export verification is a separate successor. This layer
allows an explicitly unsaved Host with no Storage bound, disables save/open and
keeps that mode visible. It does not substitute fake persistence for the missing
v1 portable opener. Actual146MB save->emptyHost reopen remains NOT RUN. Earlier
#194 portable gate remains held until the owner port and independent review.
Performance NOT RUN; no CI dispatch/main merge/release/deploy/publication/license
change. Review fixes are private and reversible.

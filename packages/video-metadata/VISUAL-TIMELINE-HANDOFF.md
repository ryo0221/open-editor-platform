# Visual timeline: existing-operation slice

Base is accepted #127 HEAD `6896c1f35f7fc216ffc8b604b9587d70ccc75b87`.
#128 Host repairs have NOT been adopted or edited. The coordinator supplied limited-GO
HEAD `1e73010ec4a63b717b3267b95ac7eae7d0e5d1c7` as the installed integration target
under #76 ownership. This change does not produce another demo movie.

## Working interactions

The existing `videoTimelineExtension` / public `video-metadata/edit` entry now renders
ruler, time-proportional clip rectangles, playhead, selected clip, zoom and horizontal
scroll. DOM contains ticks for the viewport, not a node for every project frame.
Track order/kind and native clip identity are preserved. Exact source metadata is in
an expandable details section. No thumbnail/probe/media access is implied.

- Clip-body drag moves in sequence-frame increments; linked cohorts preview/move
  together. Edge drag trims the selected clip independently. Ghost geometry is
  private; pointer-up submits one prepared native command against the DOWN revision.
  Invalid overlap/source bounds and locked cohorts are refused by existing commands.
- Escape, pointercancel, lost capture, window blur or Cancel inputs discard the ghost.
  No-op submits null and preserves Redo. Scope disposal discards it without commit.
- Pending gesture is reported as dirty through the existing single aggregate Inputs
  group; preparation refuses with TimelineGestureInProgress, so Save/other commands
  cannot flush a half-finished drag. IME composition remains a separate flag.
  Dirty/composing numeric fields must be applied/cancelled before starting a gesture.
- Clip/edge focus + arrows moves/trims one frame via the same preparation helper;
  numeric trim uses that helper through aggregate Inputs. S splits at the playhead,
  Delete deletes the selected cohort, Ctrl/Cmd+Z (Shift for Redo) uses the controller.
  These shortcuts are scoped to the timeline, not global text/IME handlers.
- Ruler click and the existing sequence-frame numeric field update private playhead.
  Zoom, seek and selection do not write native content or history.
- Move earlier/later uses #127's exact all-clip permutation command, one history
  entry, preserving source windows and slot gaps. This remains restricted to #127's
  one visual track / <=2 sources / unit-rate / unlinked subset; no new import policy.
  Dragging a clip is non-ripple placement, not implicit reorder/overlap acceptance.

## #76 installed handoff

No new dependency/export/manifest/lock/shared API is required. Package the added
relative source module `src/visual-timeline.ts` with the existing edit entry. Keep
`test-host/` outside production packages. Existing factory and mounted(controller)
options remain compatible. Two OPTIONAL domain options are added:

- `onTimelineIntent(): void`: synchronously pause Host preview playback when editing
  starts. It is a notification, not authority to execute a command or a media grant.
- `onPlayhead(at: Time): void`: user seek intent on the sequence timeline; feed the
  current scoped snapshot and exact time to the accepted preview bridge. Host owns
  seek failure/display/cancellation and must observe scope after callbacks.

The Surface checks scope after optional callbacks. Host should retain its normal
controller subscription for accepted edit/Undo/Redo content updates. Private ghost
geometry is not a new document/snapshot and must not be saved or passed as canonical
preview. This slice supplies outward user-seek intent; automatic playhead animation
from a Host playback clock is not supplied or claimed.

Use the fixed/reviewed #128 integration pin, adopt ONLY these domain changes, wire
pause/seek callbacks and rebuild the offline kit. Run both installed consumer
public-import/type/build gates and E2E for drag/trim/numeric/keyboards/reorder/history,
stale/read-only/locks, scope loss, exact decoded windows and Save input exclusion.
Then independently review that installed result; domain fixture PASS is not that gate.

## Verification scope

Browser tests use actual pointer/keyboard events and synthetic native fixtures with
supplied TEST controller/save ports, not the production runtime. They cover linked
move, independent trim, numeric/keyboard equivalence, playhead/zoom revision invariance,
reorder/split/delete/Undo, one-commit drag, Save refusal during drag, Escape/no-op Redo,
pointercancel, invalid trim rollback-free refusal, stale commit, locked linked track,
read-only and scope disposal at1280/390px. Screenshots are inspected; no browser errors
or document-level horizontal overflow. Physical touch and OS IME are separate gates.

General source selection/import/probe/backend, new Resources/media permissions,
source-byte retention/persistence/reconnect, audio/export, native schema changes,
performance, full #75 completion and new recordings remain excluded. Historical #128 failures remain in its own checkpoint; this branch's subset does
not erase them or certify the newly combined installed result.

## Exact domain checkpoint

Tested code `96adab438be9e02a8751b47e19f70cb433d836cc`, clean tree. PASS151
focused tests/8 files (existing129 +22 visual interaction cases), root typecheck,
lint, ordinary Vite builds, file guard/diff check. Both screenshots inspected. Initial
lint prefer-const error in a test was fixed before this pin. Logs
`/tmp/video-visual-96adab-*.log`, screenshots `/tmp/video-visual-{1280,390}.png`.
Subsequent checkpoint commit is documentation only. Environment continuity was checked
after a disconnect notification and the committed branch pushed safely; no migration.
Installed #128 integration remains NOT RUN on this domain branch and must be owned
and reviewed by #76. CI/performance/main merge/publication remain held.

## Domain review corrections

Latest tested code `7d1c05cbf42041f36e6a07f9bc3b18693f7a09b0`; following checkpoint
commit is documentation only. PASS161 focused tests/8 files, root typecheck/lint/
build/file and diff checks. All10 new browser cases FAIL against `00ea86d6` and PASS
at this pin. Before log `/tmp/video-ui-review-before-final.log`; after logs
`/tmp/video-ui-review-final-*.log`. A preliminary low-fps test fixture accidentally
used ordinary fps; corrected before this pin. No acceptance claimed for that run.

Playhead validates exact frameTime conversion and inclusive sequence bounds BEFORE
committing field/marker state. Rejected numeric overflow/range/negative inputs restore
the last valid playhead and retain selection, revision, history and mounted Surface.
Marker rendering uses the validated rational coordinate. A valid extreme-low-fps
sequence starts at0 if the prior50f default is unrepresentable or outside the sequence.

Gesture-start transitions explicitly reject synchronous event reentry during Host
callbacks. After onTimelineIntent, the outer transition checks the guard before
creating/committing its gesture. Policy is BOTH attempts refused, not silently keeping
the outer gesture. Pointer/key/nested-cancel cases prove old-edit zero and a subsequent
fresh gesture exactly one commit. This does not add a second authority/session model.

The coordinator's minimal-DOM/source probes motivated these fixes; our regression
runs use Chromium with domain TEST ports. Actual installed #76 Host acceptance remains
NOT RUN here. Shared API/Core/native/Host files are unchanged; excluded media/import/
persistence/backend/export decisions remain excluded.

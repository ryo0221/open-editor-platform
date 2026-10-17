# Practical UI iteration 1: focused keyboard targets

Accepted baseline #134 `db6e7056b662c0b3744cebacafa7a359e720c90f`.
Tested fix and harness `d5c79f0e2f00b441297a9678bf73e7dee77e54c5`.
Following checkpoint commit is docs-only. Scope: domain keyboard target safety,
not new import/media/storage/backend capabilities or another demonstration movie.

## Actual installed operation and discovery

Both offline-installed Hosts,1280/390px: split the initial linked AV clip, focus its
left video body, Tab three times to the right video body, press Delete or S (right
interior playhead62). Before: Delete removed the OLD selected left cohort instead
of the focused right cohort; S targeted the left clip and refused instead of splitting
the focused right clip. All8 installed cases FAIL at the accepted baseline.

Fix: Delete/S selects the focused clip through the existing Surface selection guard
before dispatching its existing toolbar/controller command. Pending numeric/IME input
still refuses selection/commit. Reserved Ctrl/Cmd/Alt chords are not interpreted as
plain split/delete/arrows (existing Ctrl/Cmd+Z history remains). No second command,
history, Host or native/schema change.

After: all8 installed cases PASS through correct cohort edit, exactly one revision,
Undo/Redo, Save, visible Reopen saved, and actual page reload with matching content.
No browser errors or document horizontal overflow. Existing installed Video edit/
Save regression4 PASS. Focused domain171 tests/8 files PASS, including8 additional
focus/dirty-input/reserved-key cases. Root typecheck/lint/build/file/diff checks PASS.

## Reproduction and provenance

New harness: packages/video-metadata/test-host/installed-keyboard-check.mjs CONSUMERS.
Both kits built/verified/installed outside the checkout, with actual package builds,
strict types and public-import audits. No alias to workspace packages.

- Base kit /tmp/video-iteration1-base-kit; source db6e7056b662c0b3744cebacafa7a359e720c90f;
  provenance4cb314fa9274a263e94fa7dba0ac7b41e17e6c1ab98516402a9ff85059cc742e.
- Fixed kit /tmp/video-iteration1-fixed-kit; source d5c79f0e2f00b441297a9678bf73e7dee77e54c5;
  provenance27edcc60479319fc293cb9352036af72c1485c19cd0c74bc2753c771cb7c9e4d.
- Consumers /tmp/video-iteration1-{base,fixed}-consumers.
- /tmp/video-iteration1-before.log: FAIL8; after.log: PASS8.
- /tmp/video-iteration1-save-regression.log: PASS4; tests/types/lint/build/files logs
  with the same prefix. Source materials/logs remain outside Git.

## Remaining work / Host handoff

Actual H264 recordings were not available in this execution environment: real-media
playback was NOT RUN here, not substituted by a new synthetic movie. #76 must carry
this domain-only fix into its continuing installed actual-media verification. The
accepted real-media route still has no Save grant: saving/reopening actual-media
projects is not established by the native-fixture route used here. Source selection,
probe/backend, reconnect/retention policy, audio/export require the separate approved
scope/decisions. Fixed-known-file limitations remain; no practical/full Epic completion
claim. Full suite/legacy E2E/physical touch/OS IME/performance NOT RUN in this increment.
All Actions remain manual-only; no main merge, publication or license change.

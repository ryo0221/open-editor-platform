# Studio Host verification — Issues #33–#36

The acceptance record is maintained in the reviewed platform tree at
`docs/verification/issue-33-36/README.md`; the exact source pin and copied blob SHAs
are in `vendor/editor-platform/origin.json`. This Site is the actual trial subject.
The platform Playground is not substituted as evidence for Site behavior.

Verification uses the production esbuild bundle on Chromium desktop 1440×900 and
mobile viewport 390×844. It exercises all five samples, save/back/reopen/reload,
retained Undo/Redo, two same-kind artifacts, explicit discard, native canvas input
commit before switch, storage failure/retry, native envelope roundtrip with versions,
invalid JSON, readonly, generated Design React reuse and Code syntax/runtime recovery.
The final platform report records counts, screenshots inspected and first failures.
`npm test` retains archived prototype regression tests separately from the new Host
and validates native source provenance, lifecycle, native models, Kanban migration,
voice simulation/bridge and independent exported source compilation.

The static Site cannot read live authenticated sharing policy. Actual publishing
preserves the existing public policy/revision; private/link/restricted/unknown and
expiry/change behavior are tested through a trusted reference Host fixture without
changing actual Site policy. The app therefore shows a neutral sharing label.

NOT RUN: physical mobile device, native OS IME, Firefox/WebKit, screen reader,
real microphone/audio service and full upstream E2E. No cloud persistence/shared
editing or production authorization assurance is provided by local browser storage.
Functional verification does not release the #22 performance hold.

Build artifacts, exports, logs, screenshots and traces stay outside Git. No Actions
are dispatched. The source-only sync, Site Git commit and exact compiled archive
must agree before publication; no access-policy mutation is part of this change.

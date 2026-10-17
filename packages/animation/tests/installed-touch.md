# Installed Animation touch regression

This test-only harness runs ten scenarios (five per reference/independent Host)
against the prepared installed packages from runtime
`082c698740cf30f78ec4f9a293e663633ba86f0a`. It requires kit provenance SHA-256
`8ec2cef23877ac8e3810984fed598b2a0a2fa1b224501addf88926257cc10e66` and checks
both consumer source/package pins before opening a browser. Prepare and verify the
consumers with the existing packaging workflow first; the pin checks do not replace
package verification. Results include the executing harness hash, browser version and actual served
HTML/JS/CSS hashes. These hashes record the supplied consumer bytes; they do not
independently prove that those bytes were built from the declared source pin.

Run from the repository root with the already-installed Chromium at
`/usr/bin/chromium` (no browser download):

```sh
node packages/animation/tests/installed-touch.mjs \
  /tmp/issue76-delivery-082c-consumers \
  /tmp/animation-touch-unique-run \
  /tmp/issue76-delivery-082c-kit
```

All three arguments are required. The output parent must already exist; the output
itself must not exist and must be outside any Git checkout, including through
symlinks. Choose a fresh output name for each run. Screenshots, traces and JSON
remain outside Git; do not commit them. The harness does not modify consumers.

Each 390×844 context enables Chromium touch emulation. CDP
`Input.dispatchTouchEvent` sends touchStart/move/end/cancel; browser-generated
`pointerType=touch` and `isTrusted=true` are asserted. DOM-dispatched synthetic
pointer events are not used as touch evidence. The scenarios cover cancellation,
valid release outside the timeline, vertical swipe on a marker, horizontal swipe
on the scrollable background, and five repeated marker taps followed by editing.
Cancellation preserves native content/history, valid release makes one commit,
and Undo/Redo restores/reapplies it. Inputs are clean after every scenario.
An observer tracks active touch/pointer IDs and capture targets. Immediately after
every touchEnd/touchCancel (before auxiliary mouse actions) and at case completion,
active IDs, observed captures and actual `hasPointerCapture` states must be empty;
each check is recorded.

Marker `touch-action:none` suppresses scroll; that is **not** a successful scroll
interruption. Background swipe must produce actual horizontal scroll and a trusted
pointercancel. Scroll positions before touchStart, after touchStart and after move
are separated: focus/render scroll anchoring can occur at touchStart. Repeated taps
retain selection; the existing Apply inputs/Undo/Redo operations are then checked.
DOM scrolling is setup; `fill` and mouse button clicks are auxiliary operations.
This is not an entirely touch-only authoring flow or physical iPhone/Safari evidence.

Existing complementary mouse/keyboard regressions (separate output behavior):

```sh
node packages/animation/tests/installed-timeline.mjs /tmp/issue76-delivery-082c-consumers
PLAYWRIGHT_BROWSERS_PATH=/tmp/issue76-geo-recovery-playwright \
  node packages/animation/tests/installed-keyboard-authoring.mjs /tmp/issue76-delivery-082c-consumers
```

The latter uses an existing Playwright FFmpeg cache for its representative recording;
no installer/downloader is needed. These existing harnesses retain their own evidence
paths; preserve their reports before rerunning. No performance measurement, Actions,
API changes, publication or release acceptance is part of this check.

# Mount lifecycle review corrections

Tested code `8fcec2e37d004b05007e16812005869559e8795f`, successor to unchanged#219
codee3ff8cc8/docs3f1cf986. The independently reviewed duration fix#218 is retained.
Only the private mount slot and its verification harness change.

## Reproduction

Old #219 code with added test harness reproduces three FAILs in
`/tmp/video-mount-races-before2/results.json` and matching log:

- While close awaits a controlled leave guard, a pending candidate completes
  preparation and also enters commit. Both await old disposal; replacement fulfills,
  close clears the root, and the newly published candidate has closes=0.
- Close awaits a delayed candidate drain, but a second close settles early and
  receives a different promise.
- During an initial mount with no current owner, the second close refuses rather
  than sharing the first close/drain.

First attempt `/tmp/video-mount-races-before` reproduced the latter two only: the
real controller's applyInputs notification changed the pin and incidentally
prevented the first interleaving. The refined test replaces only that workspace's
pin/guard with a stable controlled predicate, isolating commit exclusivity. Actual
Host creation and its close path still run, with lightweight counted persistence
fixtures. This focused race harness does not claim actual Storage/media acceptance;
the separate existing mount browser gate supplies that coverage.

## Correction

Each commit has a unique token. Replacement rechecks availability after candidate
preparation, then validates token/current/generation after asynchronous guard and
old-owner disposal, including initial mount. Only that token can release commit
ownership. A close starts by invalidating existing preparers before any await;
preparers finishing during close can only dispose their candidates.

Close publishes its shared promise before invoking any guard/disposal callback and
retains ownership through pending preparation/cleanup drain. Every close caller
waits for the same promise, including after old ownership has closed but candidates
are still pending. Successful close clears current/root only after complete drain.
A guard refusal retains and resumes the old owner, clears the failed close attempt,
and allows reconciliation/retry; invalidated older preparers remain invalid.
Close during an already-owned replacement commit refuses and may retry afterward.

The four browser cases control deferred preparation, leave guard and old close:
close/prepare collision; shared close drain; initial mount/double close; replacement
already disposing the old owner. They assert no late publication, shared promise
identity, no premature completion, empty final root and exactly-once candidate
persistence disposal. Prototype PASS is not substituted for exact-pin results.

## Evidence and scope

Commands: root typecheck/lint/build/check:files; focused173-unit paths as in
PORTABLE-VERIFICATION.md with maxWorkers1; `mount-race-check.mjs <deps> <fresh-out>`
and existing `mount-check.mjs <deps> <fresh-out>` using fixed local codec deps.
Summary `/tmp/video-mount-races-checks.json`, logs `/tmp/video-mount-races-final-*.log`,
new race report `/tmp/video-mount-races-pinned`, actual Storage/JS playback baseline
`/tmp/video-mount-races-baseline`. Original failure logs remain outside Git.

No normal registry, v1 identity, Rust, Storage runtime, capacities, history deletion,
performance, automatic CI, main merge/release, consuming-product or license change.
Actual-output oracle work is preserved separately atd342eeec753c7be5a133e047b388601282725cba
with prototype results in `/tmp/video-actual-output-pre`; it is not certified by
these adapter tests. Combined full-two-original portable remains BLOCKED by256MiB.

At clean8fcec2e37d004b05007e16812005869559e8795f: type/lint/build/files PASS;
173units/15files PASS; controlled race4cases PASS; existing actual Storage/JS mount
baseline4groups×1280/390 PASS. Browser errors0, both reports record clean source.
Duration/portable standalone and actual-original output oracles NOT RUN on this
adapter-only correction; their earlier distinct evidence is unchanged.

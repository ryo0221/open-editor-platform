# #162 bounded review fixes

Exact code: **e450b45f27f7dcc4ad5c2307e493377328efc0f3**.
Base: #162 **2b38d26b1c996e4a0959e39b00db922da0d0c9f0**, preserved unchanged on
its original branch. This correction branch does not incorporate #163 or any other
lane. First quota-only code pin: **19443c404c1369d1d1203e42a4e05bfd17662c41**.

## Corrections

1. **Cumulative target quota before commit.** The single active stage reserves its
   bytes against immutable completed-target occupancy during `write`. A 64 MiB
   quota rejection therefore occurs before Storage marks a commit attempted;
   abort clears staging and existing no-write evidence settles the coordinator.
   Genuine attempted-commit unknowns still retain the shared claim and capture.
   No changes to the shared SaveCoordinator. Old completed bundles are preserved.

2. **Concurrent reconciliation.** Each operation shares one in-flight receipt
   read/validation promise, registered before calling the Host target, including
   synchronous reentry. Definitive receipts remain idempotent. A second check
   precedes publication. An older A cannot republish after a newer B because of
   a second delayed inspect of A; transient unknown receipts remain retryable.

3. **Complete controlled-view capacity.** `capacity.ts` applies pinned draft.2
   4,096-node/24-depth/65,536-byte limits to projected view wrappers before resource
   transfer or Core mutation, and reserves the existing save-request/outcome
   wrappers. The private scope/receipt profile is bounded to 256 code units; this
   does not raise shared limits or certify arbitrary Host envelopes. Preparation
   and commit both check capacity. Pattern follows existing accepted Host
   preflight; no other lane code is imported or edited.

   The regression starts from a valid short-ID 191-clip Host root. Its proposed
   native content still fits 4,096 nodes and 60,000 bytes, but the complete
   controller view exceeds 4,096 nodes. Refusal leaves snapshot/history/scope
   usable and does not retain the new original. This is **not** evidence of 191
   ordinary UUID-based UI imports; those can hit the byte limit earlier.

4. **Serialization headroom.** Original storage now reserves `9 * 65,536 + 8`
   bytes below the 32 MiB bundle ceiling for eight native envelopes, manifest and
   header. Interpretation JSON has a separate conservative 24 KiB aggregate
   quota. A second distinct 16 MiB original refuses before native mutation; the
   first import remains savable. These are prototype bounds, not approval of a
   practical iPhone-video size limit or ZIP64 feasibility.

5. **Actual presentation coverage.** The MP4 profile sorts and merges sample
   `[PTS, PTS + duration)` intervals and checks the selected edit span against
   their union using exact rational comparisons. Min/max envelope alone no
   longer suffices. Leading empty-edit presentation placement remains separate
   from selected source-media coverage; internal source gaps are unsupported and
   rejected, not silently filled.

## Exact-pin gates

| Check                                             | Result                   |
| ------------------------------------------------- | ------------------------ |
| Focused Host tests                                | PASS, 22                 |
| Video Core tests                                  | PASS, 54                 |
| Root typecheck / lint / build / file policy       | PASS                     |
| Chromium desktop and mobile focused E2E           | PASS, 2                  |
| Full repository regression / other browsers       | NOT RUN                  |
| Performance / Actions dispatch / iPhone / Windows | NOT RUN, holds unchanged |

Regression details:

- Actual 16 MiB original, three successful saves; fourth save exceeds cumulative
  quota and definitively aborts. Same target retry aborts without SaveBusy. A fresh
  Host-selected staging destination succeeds while the old bundle/hash remains
  intact. No operation exists to reconcile for the guaranteed never-write case.
- Deferred A1/A2 receipt reads → A1 settles → save B succeeds → A2 delivered late:
  selected B and both versions remain unchanged, only one inspect of A occurred.
- Existing lost-ack/unknown test still holds the coordinator lock through scope
  closure until correlated reconciliation; quota correction does not unlock it.
- Short-ID capacity rejection preserves native snapshot/revision, no ownership
  transfer, controller remains open, and subsequent edit/Undo works.
- Real generated AVC/AAC MP4 with an interior ctts run shifted outside its edit:
  min/max still enclose the edit but union has a gap. Both browser viewports reject
  before import mutation, then import the valid original and perform the existing
  two-context bundle-only restoration/tamper/Inputs tests without browser errors.

Prior failures retained outside Git: `/tmp/video-quota-before.log` and
`/tmp/video-reconcile-before.log`. Capacity/gap regressions were also run with only
the new guards disabled to reproduce the previous behavior; both failed as
expected (`/tmp/video-capacity-before.log`, `/tmp/video-gap-before/results.json`).
The guards were restored before the exact code commit and complete rerun.

Final raw evidence: `/tmp/video-review-fixes-{unit,typecheck,lint,build,files,browser}.log`
and `/tmp/video-review-fixes-browser-final/`. Generated binaries/media/screenshots
remain outside Git. Browser results record the exact code pin and clean tree.

#160 adoption remains HOLD pending review. No PCM renderer, shared API, root
manifest, dependency, license, merge, deployment or publication change is included.
#162's original review slice and #163's cancellation follow-up stay separate.

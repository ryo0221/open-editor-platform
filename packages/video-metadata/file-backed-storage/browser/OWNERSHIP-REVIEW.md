# Operation-wide no-write follow-up

Base #176: a86b2ef08db8caadbc17eefce904291e1751e41a (unchanged).
Tested correction: **be5123c9c9cc221ac1f3bfe6b1443c43fc12b7cc**.

Two owners sharing an origin/namespace could previously contradict a definitive
no-write receipt. A cancelled request returned not-written without remembering
its ID, then a queued live request with that same ID committed. Actual browser
reproduction returned `[not-written, saved]`. Failure evidence is retained:
`/tmp/video-browser-fence-before/results.json`, SHA-256
`30d59b94ccae27111eb39697b5260ef63ba34f9ef61bc0dd3f10933a3a99c21a`.

Pre-admission rejection now durably records an aborted operation under the same
Web Lock before returning not-written. Cancels, authority/stale/quota refusals all
use this fence. A reused ID cannot commit, including after a browser restart.
If the journal is unavailable/full or fencing fails, the result is unknown; it
cannot release a coordinator claim. Tombstones consume the existing64-operation
budget and are not garbage-collected. This is actual cross-owner protocol state,
not merely a caller single-dispatch promise.

Cancellation is also checked inside the IDB commit callback, before and after
fresh authorization. Before commit it can prove no-write; once a commit has been
attempted it remains conservatively unknown until reconciliation. Cancellation
after the committed transaction does not erase a genuine saved result.

The runner creates its output directory exclusively before any writing. A rerun
against the retained failure path rejected EEXIST and preserved its exact SHA.
`/tmp/video-browser-exclusive-directory.log` retains that check. Browser restarts
are controlled context.close/new-process launches, not OS crashes or power cuts.

Additional real browser checks:

- B13 PASS: two owners, same-ID cancel/authority/stale refusal and queued live
  retry, restart retains all fences, a fresh ID still saves, no rejected files.
- B14 PASS: cancellation at prepared, inside commit authorization and after
  committed returns not-written/unknown/saved respectively; selection reflects
  actual commit. Cancelled transaction remains prepared/ready, not committed.
- B01–B12 PASS unchanged. Final report `/tmp/video-browser-fence-final/results.json`
  is from the clean tested source; six actual Chromium process launches, zero
  browser console/page errors. Synthetic byte verifier limitations still apply.

This correction does not add a generic Video archive verifier, Host integration,
Windows/user-file overwrite, persistence or power-loss guarantees. #176 remains a
private candidate; independent adoption review is required. No dependency,
shared Host/API, CI, performance, merge or release change.

At this tested pin: browser14PASS, unit8PASS, root lint/typecheck/build/file policy
PASS. Commands are unchanged from README; logs `/tmp/video-browser-fence-{unit,
lint,type,build,files}.log`. Final browser report SHA-256:
`455302db1438b143d2fb8c1bbf1c598dd38e1cc2c0f17ab01c89d1c2737bbb4f`.

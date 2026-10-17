# Browser candidate evidence

Base: #170 **e7519245693d7da90c743ce9f59a1be88a6c7042**, unchanged.
Tested code: **94649ac022f4d55f274326b4231e60a2aa004295**, clean source tree at browser
runner start. Final documentation commit changes only this evidence record.
The #172 Node target correction is separate and is not implicitly integrated.

Cloud Linux, Node24.19.0, Chromium **151.0.7922.173**, headless1280×800.
The runner launched **five separate persistent Chromium processes** on the same
local origin/profile. No browser pageerror or console.error: **0**. The screenshot
was visually inspected and shows the controlled synthetic journal, not Video UI.

| Gate | Functional result |
| --- | --- |
| B01 bounded Reader staging | PASS:40MiB OPFS file, complete synthetic-byte verification, File/Blob/range lease |
| B02 cancellation/quota | PASS:mid-write cancel, configured cumulative quota rejection and reused operation preserve previous file |
| B03 prepared restart | PASS:real process restart, ready result, revoked resume refused, explicit authorized resume, stale expected head refused; old reconciliation cannot republish |
| B04 committed restart | PASS:lost acknowledgement after committed journal recovered as saved |
| B05 intent restart | PASS:missing candidate remains unknown, older current retained, new write blocked |
| B06 altered resources | PASS:missing and tampered completed file never yield successful receipt |
| B07 lost journal | PASS:missing journal cannot reinitialize over candidates; unavailable journal cannot issue false no-write evidence |
| B08 lease lifetime | PASS:old File/Blob bytes survive newer selection; release rejects pending asynchronous result |
| B09 browser write fault | PASS:injected QuotaExceededError during actual OPFS write cleans staging and preserves prior completed file |
| B10 interrupted writer | PASS:process exit while writer open, restart keeps unknown and retains older complete file |
| B11 explicit abandonment | PASS:revoked request refused, authorized staging removal permits retry, committed file never removed |
| B12 corrupt journal | PASS:future committed parent is refused, save remains unknown |
| Evidence bridge unit | PASS:6 cases for exact capture/pin mapping and conservative unknown results |
| Reader bridge unit | PASS:2 cases for bounded owned chunks, short read and cancellation refusal |

The synthetic40MiB file SHA-256 is
`f500b87f2235d8955d83d49aad55cf9087e32e1018496dfc98d018518670c3ab`.
Node independently computes full-file SHA; browser checks all chunks against the
known fixture. This proves these exact bytes, **not generic browser archive/native
closure validation**. All files are synthetic and local; no real user data used.

Commands are in README. Full browser report:
`/tmp/video-browser-journal-accepted/results.json`, SHA-256
`ed4d640f7c76b5d53b49a840d6bc64c3f08e5acca0fb9fcd4473b59d4daedb09`.
Bundle SHA-256:
`99a4209254ed51d03f54b9becd53cbbd9f6eac23c4662e300f4eef82a2f719de`.
Raw screenshot/profile/log remain outside Git.

## Earlier failure retained

At88d3a674 the added unavailable-journal test reached a harness-only failure after
six passing scenarios: its debug UI attempted snapshot() on a deliberately closed
DB. `/tmp/video-browser-journal-final/results.json` and `.log` preserve FAIL.
The targeted harness call now skips only debug repaint for this deliberately
closed case; adapter errors and browser console/page errors are not filtered.
Subsequent45a16 exploratory run passed11; the final exact-source run above passed12
including additional corrupt-sequence validation. Exploratory reports are not the
final tested pin.

## Remaining gates

**NOT RUN / NOT IMPLEMENTED:** normal Video SaveCoordinator integration and native
archive round-trip through a general browser verifier, Windows/user-selected-file
overwrite, disk exhaustion (B09 is fault injection), abrupt OS power loss, origin
eviction/persistence guarantees, mobile/accessibility/UI certification, full repo
regression suite, performance, CI, merge/release. No production adoption or storage
ownership acceptance is asserted. Budgets and retention policy remain proposals.

Next: independent review of this adapter and #172, supply the existing Video Host
with a bounded general archive/hash verifier, then separately wire and test the
coordinator/reader lease boundary. No shared Host or other lane files are modified.

At the tested pin, root **lint / typecheck / build / file policy PASS**; browser
unit8PASS /2files. Existing build size warnings do not constitute performance
acceptance. Logs (SHA-256):

| Log under `/tmp/` | SHA-256 |
| --- | --- |
| video-browser-accepted-unit.log | 257194d1686b495b120d64e8308db3d27dd35a84e427fa01d24b5c4eab045ba5 |
| video-browser-accepted-lint.log | 62b8b4e023399c59cc1e7331f5d2722fd33f4dab9be6f11e136f58b68e10b3d6 |
| video-browser-accepted-type.log | 94d442b9e5ee147a71623cadc9818f0e017d0cea0565b41435d4e461cbd58280 |
| video-browser-accepted-build.log | 5ff823bf2d035eefb41dfb89f7f39c6c642bffa3b6f16a52691a4de08bb5fa7f |
| video-browser-accepted-files.log | 94d616f724690bba2f1b746feebcfde32882d52f49dbc7193bcfd912278df0f1 |

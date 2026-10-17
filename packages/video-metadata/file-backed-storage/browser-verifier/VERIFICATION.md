# General browser archive evidence

Base: reviewed #172 **414514241ee0dff13159635826c7493f513c2865**.
Tested: **d768bdf6db6d6f363f3feff8b25bbaa1779e244a**, clean tree at browser runner start.
Later evidence-only documentation changes do not change implementation. #170,
#172, #176 and #178 remain unchanged by this branch.

Cloud Linux/Node24.19.0, actual Chromium151.0.7922.173. Controlled local File-input
Host, not normal Video UI. **14 functional groups PASS; console/page errors0**.

| Case | Result and evidence |
| --- | --- |
| V00 shared implementation | PASS:exact reviewed Node source bundled as oracle; identical bytes/SHA and malformed verdicts for all generated fixtures; independent Python ZIP STORE/CRC read |
| V01 incremental digest | PASS:9 inputs at SHA padding/block boundaries and65,537 bytes agree with WebCrypto |
| V02 actual large file | PASS:41,946,360-byte ZIP64 restores selected +parent native versions and41,943,040-byte original referenced only by parent; all original and archive SHA verified |
| V03 refusal/abort | PASS:cancellation after reads start, negative/outside/oversize ranges, wrong operation and whole-archive SHA reject |
| V04 portable download | PASS:actual browser download SHA checked in Node; file reopened in a new empty context after source original removal, with no OPFS or cache dependency |
| V05 malformed capture | PASS:comma-containing exact-field collision and session mismatch, with valid entry CRC/SHA |
| V05 closure/versions | PASS:missing original, missing parent, parent cycle, wrong native content hash, interpretation mismatch, unknown schema; exact Node/browser refusal reasons agree |
| V06 corruption | PASS:original payload tampering rejected by CRC/SHA |

Large portable file SHA-256:
`09a6cb0db84e33567b5a38424e845e1d398630ab201c8bdfe728a1b5ca40bb5c`.
Retained original SHA-256:
`f500b87f2235d8955d83d49aad55cf9087e32e1018496dfc98d018518670c3ab`.
Largest actual read **65,536 bytes**, maximum simultaneous read **1**. No whole
archive/original ArrayBuffer, heap/throughput benchmark or capacity guarantee.
Small malformed fixtures may be buffered by the Node test generator only.

Report `/tmp/video-general-verifier-checked/results.json` SHA-256:
`ba4fcc5945b9b2fcbd16b6fb2e8891adb4c309aff83ff7a277b4e526aeb8240f`.
Browser bundle SHA-256:
`d347c938e78635ed768fdeb9aa2b7628b864a9e91847a578e45c792256c9ab17`.
Metafile, screenshots, generated portable archives and logs stay outside Git.
Screenshot visually inspected: synthetic native/retained version and receipt data,
not product UI certification. Exclusive output-directory creation preserves failures.

## Preserved development failures

- `/tmp/video-portable-initial.log`:30FAIL/11PASS during initial Buffer-to-DataView
  extraction; two remaining conditional Buffer write calls caused failures. Fixed
  without changing the fixture or weakening validation; subsequent41PASS.
- `/tmp/video-general-type-initial.log`:missing imported Reader type after extraction.
  Added the type import; no runtime change or suppressed diagnostic.
- `/tmp/video-general-verifier-first/results.json`:first digest group PASS, then
  retained-version comparison FAIL because JSON object key order differed. Replaced
  JSON.stringify equality with Node deep structural equality. Native values remain
  checked; second/third exploratory runs pass and are not the final tested pin.
- `/tmp/video-general-final-lint.log`:fixture manifest binding prefer-const FAIL.
  Fixed at the final tested pin; the earlier browser14PASS/unit124PASS are preserved
  separately rather than treating that commit as passing all checks.

## Limits and adoption gates

No normal SaveCoordinator/journal wiring, complete Video UI flow, media codec
validation, Windows/user-selected-file overwrite, crash/power-loss durability,
full repository suite, performance, CI, merge or release was run or claimed.
This verifier does not touch OPFS/current outputs or settle unknown operations.
The synthetic original is binary fixture data, not playable certified media.

Private test Host injects already installed @noble/hashes1.8.0; the adapter itself
accepts a digest capability. Dependency/license/proposal details are in README.
No root lock/manifest or permanent dependency adoption. Shared public API and
other lanes untouched. Next gate: independent review of shared extraction and
browser binding; separately approve a production digest/notice declaration and
wire the reviewed journal/SaveCoordinator while preserving #178's ownership rules.

## Local gates at the final tested pin

**124 unit PASS /5files**:30 archive +11 storage review +29 Host +54 Core/media.
**Root lint/typecheck/build/file policy PASS**. Commands are in README. Existing
build chunk warnings are not performance acceptance. Logs under `/tmp/`:

| Log | SHA-256 |
| --- | --- |
| video-general-checked-unit.log | 9dc00267af80f0aeed13cdac78fbdb3e8a3e7a4fe82611c307a76b619ef2fbf3 |
| video-general-checked-lint.log | 62b8b4e023399c59cc1e7331f5d2722fd33f4dab9be6f11e136f58b68e10b3d6 |
| video-general-checked-type.log | 94d442b9e5ee147a71623cadc9818f0e017d0cea0565b41435d4e461cbd58280 |
| video-general-checked-build.log | b8c0df0162486bc5d49695dcd0a864752f01f0b9cac44a2d5bb27903cd13d84b |
| video-general-checked-files.log | aeea3f560718ed23fb9a59583bd14f2fcd796d2914ee29f652af197d72f4ea51 |

Final screenshot SHA-256 matches the visually inspected screenshot exactly:
`0546a40580d10768a5fcce59ed2a594ffd610f45110c0d30e8eff64b09cc7629`.

# v1 admission review corrections

Final code `5aeda99721692e07ac2b7218f628e87e5c7e4b60`: exact sample-point
membership and renderer-coordinate representability are validated at admission.
Positive raw duration with no discrete sample point is rejected; legitimate
fractional edges remain accepted. Origins/clip endpoints that exceed existing
Time bounds during the renderer mapping are rejected, without relaxing Time.

At this clean code SHA: PASS root typecheck, lint, build, file policy and88 focused
Core/renderer/v1 tests. Logs `/tmp/video-v1-validity-*-final.log`.
First membership-only code `f1126468cac68da0a0379c63dcdf590c37d32340` also passed
its checks; the second review finding added representability before final pin.

No v0 implementation or retained record conversion. Actual v1 Host/output acceptance
remains separate; this follow-up addresses #186 review. CI/performance/main/release
holds unchanged. Code Actions0; no new codec/dependency or shared-platform change.

## Additional rejection-atomicity proof (#190)

Exact test code `bdf6af1af49ca9f6f23e5511cf9d85195b2bfaa6`: PASS89 scoped
Core/renderer/v1 tests and root typecheck, lint, build, file policy. Logs
`/tmp/video-v1-atomic-*-pinned.log`. No runtime change. Includes the second
positive-origin denominator overflow case and asserts unchanged content/revision
plus preserved preexisting Undo/Redo history for every refused admission. Actions0.

## Sample-coordinate multiplication bound (#193)

Runtime `6e6670e18095889077b51c53a66b224c07be3522`, final test pin
`ef9a9fe39c19a33680d71f32366b61f299eb7ddc`: admission also checks both
original validity and clip endpoints after multiplication by the source sample
rate. This preserves existing Time bounds. The MAX_SAFE_INTEGER denominator
case is rejected even with a half-second clip and an ordinary 24000-point output
span, so the regression isolates source validity from output-span overflow.
Separate clip-endpoint coverage and existing Session content/revision/Undo/Redo
atomicity checks remain in place; valid fractional edges remain accepted.

At that exact clean test pin: PASS root typecheck, lint, build, file policy and
90 focused Core/renderer/v1 tests. Logs `/tmp/video-v1-sample-*-pinned.log`.
Browser E2E NOT RUN for this admission-only follow-up; real-original reader,
output and ongoing Host acceptance are tracked separately in #191/#192.
Actions remain manual-only, no dispatch. Performance NOT RUN (held).

# Open Editor Platform — rights, dependencies, patents and release test audit

**Status: BLOCKED / DRAFT.** Updated for GNU AGPLv3-only + alternative commercial/OEM licensing. This document records preliminary repository evidence; it is not proof of IP title, patent clearance, a production test pass or lawyer approval.

## Rights and human authorship
- GitHub history of the private canonical source branch was enumerated during the prior review: 165 commits with author names in two representations of the same developer; this is not a copyright chain-of-title opinion.
- Verify company/employee-created program rules, any commissioned work, earlier copied code, AI-assisted human expressive contributions, and signed assignment agreements.
- Dual licensing requires all relevant copyright owners (including future contributors) to grant adequate authority for **both AGPLv3 and optional proprietary/OEM licenses**.
- Earlier released MIT copies retain those permissions regardless of Git history changes.

## Third-party license inventory

Publication candidate package-lock had 541 package records. Licenses included MIT (371), ISC (53), Apache-2.0 (26), BSD variants, MPL-2.0 and dual licensed materials; 67 records lacked a license field, most of which were internal workspaces. A non-workspace package `khroma@2.1.0` requires direct upstream LICENSE verification.

Manual attention:
- `@resvg/resvg-wasm` — MPL-2.0.
- `dompurify` — (MPL-2.0 OR Apache-2.0).
- `jszip` — (MIT OR GPL-3.0-or-later).
- `pako` — (MIT AND Zlib).
- `caniuse-lite` — CC-BY-4.0.
- `argparse` — Python-2.0; `sax` — BlueOak-1.0.0.
- LibreOffice-derived Office test fixtures with MPL-2.0 provenance and source notices, task-authored CC0 fixtures, Noto CJK/OFL downloaded fonts.

**No assembled release SBOM or bundle-specific notice review has been certified.** Lockfile metadata does not establish which third-party code is actually included in browser bundles. Audit each source, modified third-party file, distribution build and corresponding source obligations.

## Patents
Standard AGPLv3 Section 11 includes contributor patent provisions. The old **custom Section 8 patent grant is no longer proposed**. Determine actual issued/pending patent rights and ownership (including employee invention assignments), which claims (if any) are necessarily practiced by each contribution and whether separate commercial patent licensing is possible. AGPLv3 may entail patent commitments that cannot simply be withdrawn on a future proprietary release for recipients of an earlier AGPL copy. Third-party patent freedom-to-operate is not proven.

## Testing / publication
- The canonical source's CI was reported disabled in October 2026 due to exhausted Actions usage. Do not silently re-enable or assert historic tests certify this release.
- Earlier **static overlay forbidden-pattern scans** and **manifest comparisons** were reported passing; this is not a full release candidate functional build.
- **NOT EXECUTED:** full `npm ci`, font verification, tooling tests, lint, typecheck, unit tests, build, Playwright E2E on an exact final exported release tree.
- **NOT OBTAINED:** signed Japan/US/EU/Mainland China counsel opinions and chain-of-title/patent signoff.
- **NOT ADOPTED:** proprietary Independent Editor additional-permission draft; it must be legally assessed before describing private extensions as categorically exempt.

## Decision
**DO NOT MERGE, RELEASE OR MAKE PUBLIC** until actual title, provenance, contributor rights, patent compatibility, AGPL notice/source obligations, codebase export and executable tests are verified. Release evidence and sensitive contracts belong in restricted storage.

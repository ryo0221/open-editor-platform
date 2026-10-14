# OSS Preview — owner-verifiable publication checklist

**Purpose:** publish a reviewed, reproducible Open Editor Platform snapshot under GNU AGPLv3-only, while deferring commercial/OEM licensing. This is a **release gate**, not a claim of legal clearance. Owner approval is for the exact commit and is recorded only after evidence exists.

## 1. Freeze the release boundary

- [ ] Select a candidate exact commit and proposed distinct Preview tag (e.g., `v0.2.0-preview.1`, subject to actual history/version check). Record the main/tree SHA, exported snapshot manifest, file counts and scope. Do not reuse an earlier MIT release tag.
- [ ] Generate from the canonical private source via the recorded public export policy, overlays and replacements. No private source Git history, hidden archives, internal URLs, private product data or unreviewed assets.
- [ ] Compare committed export with the intended public PR tree; stop for any unauthorized files/missing expected files or mismatched hashes. Inspect binary images/Office/embedded metadata by content, not only keyword scanning.
- [ ] Verify README/CONTRIBUTING/AGPL license notices, SPDX root metadata and third-party material notices; nothing describes the source license as MIT or private source-available for this new release.

## 2. Documented rights and prior publication

- [ ] Maintainer examines relevant copyright/employment/commissioning agreements and confirms actual publication authority for all release-owned source. Keep contracts private; write only a bounded sign-off record with any exclusions.
- [ ] Trace copied snippets, generated assets, contributors and AI-assisted code. Do not assert human authorship merely from a Git commit. If ownership cannot be resolved, exclude the code.
- [ ] Identify unpublished potentially patentable technology in the release; make a deliberate disclosure decision **before public release**. Document AGPLv3 §11 contributor patent consequences. Exclude or defer any uncertain/strategically sensitive feature.
- [ ] Preserve evidence of the old MIT release and do not claim new AGPL revokes valid MIT grants.

## 3. Dependency and security provenance

- [ ] Review actual release dependency tree and built bundles, not only `package-lock.json`. Preserve existing `docs/third-party/`, test/fixture provenance and Noto OFL notices. Resolve missing-license metadata (including `khroma`) and AGPL compatibility.
- [ ] Check whether any distributed third-party MPL/Apache/dual-license components require notices or corresponding source; include required license text and material attribution.
- [ ] Scan source, manifests, licenses, README, build artifacts and binary metadata for credentials, secrets, private names, private URLs, internal references and accidental dataset/customer code. Re-run after every export change.
- [ ] Verify no high-impact known vulnerability or obvious arbitrary code execution path is inadvertently exposed in a supposedly safe plugin demo. Explicitly mark untrusted extension loading as unsupported until secure isolation exists.

## 4. Reproducible verification on the exact exported tree

Use a fresh checkout or materialized **sanitized** source snapshot. Do not report historical test counts as release results.

```sh
node --version
npm ci
npm run fonts:fetch
npm run fonts:check
npm run test:tooling
npm run check:files
npm run lint
npm run typecheck
npm test
npm run build
# Install a matching browser only where supported:
npx playwright install chromium
npm run test:e2e -- --project=desktop --project=mobile
```

- [ ] Run supported commands and capture exact command, environment, exit code, target SHA, successful test counts and links to artifacts/logs.
- [ ] Use key independent-Host/editor flows: Document, Slide, Data, Design, Whiteboard, File/Review, React UI where present; verify representative save, reload, Undo, read-only, exports and error handling.
- [ ] Confirm the README's quickstart is reproducible by a new user without secrets or private infrastructure. Distinguish local-only demo from production collaboration, authentication and durability.
- [ ] Record unrun/failed browser or Office interoperability tests honestly, with limitations. Blocking security/data-loss/fatal-build failures must be fixed or affected feature excluded before launch.
- [ ] Existing additional performance testing and GitHub Actions remain stopped by owner decision. Previously unmeasured performance requirements are marked as **not verified**, not passed.

## 5. Public documentation and publication decision

- [ ] Provide AGPL license, full source, licensing overview, third-party notices, README quickstart, known limitations and security reporting process. The proprietary Editor extra permission remains unadopted; no assurance that all plugins are exempt.
- [ ] Public code contribution PRs require documented rights/CLA first if a future proprietary OEM relicensing path is intended; issues and patches kept out of main may still be discussed.
- [ ] Final owner go/no-go has a timestamp, exact release SHA/tag, selected scope, test record, exceptions and publication approval. The release manager does not decide for the owner.
- [ ] Only **after all mandatory evidence is satisfied**: merge the reviewed release PR and intentionally change visibility to public. No silent CI resumption or force-push of private history.

## Decision record template

```text
Release candidate: <commit SHA, manifest SHA, proposed tag>
Copyright and employer/contracting rights: VERIFIED / EXCLUDED / BLOCKED
Patent disclosure and AGPL §11: VERIFIED / EXCLUDED / BLOCKED
Dependencies, notices and source obligations: VERIFIED / EXCLUDED / BLOCKED
Secrets, product data, binaries: VERIFIED / EXCLUDED / BLOCKED
Reproducible install / tests / build / relevant E2E: PASS / FAIL / NOT RUN
Known non-blocking limitations: <documented>
Owner final decision: APPROVE / DEFER
Approval date and evidence reference: <private record ID>
```

**Never claim external legal counsel approved this release unless that actually occurred.** The absence of paid counsel is not a waiver of rights held by employers, contributors or dependency owners.

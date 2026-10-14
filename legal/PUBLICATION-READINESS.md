# Open Editor Platform — two-stage release gates

**Decision (2026-10-12):** Prepare a **GNU AGPLv3-only OSS Preview first**. Keep optional commercial/OEM licensing as a distinct future offer. A paid OEM contract is **not** a precondition to an AGPL-compliant open-source release.

The team cannot currently fund multi-jurisdiction counsel reviews. The release policy therefore requires **recorded owner-side verification of rights, provenance, security, patent disclosure, and runnable software**; no unsupported statement that legal risks have been professionally cleared. If material ownership, confidentiality, patent or third-party license uncertainty remains, **exclude that component or defer publication**. A Preview label or AGPL disclaimer does not cure a rights defect.

## Gate A — OSS Preview publication

See [OSS Preview Release Checklist](../docs/release/OSS-PREVIEW-GATE.md) for exact evidence, commands, owners and stop rules.

- [x] AGPL-3.0-only official license text prepared, with prior MIT releases preserved.
- [x] Draft docs explain that paid AGPL-compliant distribution/SaaS is allowed with no OEM royalty.
- [x] OEM terms and proposed independent Editor additional permission are identified as **not yet offered/effective**.
- [ ] Establish a fixed sanitized public source snapshot from the canonical private repository. Do not leak private repository history or product data.
- [ ] Verify independently owned source/contractor/employee rights, no unpublished invention inadvertently disclosed, and ownership/AGPLv3 §11 patent implications. Resolve questionable material by removal or formal authorization.
- [ ] Verify redistributed third-party licenses, fonts, test fixtures, retained notices and actual bundled dependencies.
- [ ] Run secrets/PII/private-name/residual scans, including binary/media review and generated output; verify LICENSE/SPDX and file manifest.
- [ ] Reproduce `npm ci`, fonts preflight, tooling tests, lint, typecheck, unit suite, build and defined smoke/E2E on the exact snapshot. Record SHA, environment, results and any limitations.
- [ ] Publish README, AGPL, third-party notices, known limitations, source access, and [SECURITY](../SECURITY.md) process.
- [ ] Record owner release approval for the **specific** tested commit, tag/version and intended visibility change. Do not equate preparing this draft with a publication instruction.

**Counsel is not a mandatory check-box for this limited OSS Preview.** If a substantive ownership, patent or third-party rights conflict cannot be resolved by direct evidence, pause publication or omit affected code; do not "accept the risk" as a substitute for rights.

## Gate B — optional commercial/OEM offering

See [Commercial OEM Launch Gate](../docs/release/COMMERCIAL-OEM-GATE.md).

Until that gate is complete: no signed paid proprietary licenses, fee representations, warranty/indemnity promise or unsupported assertion of patent sublicense authority. Customer use under AGPLv3 remains available if compliant.

## Community contribution policy until legal intake is ready

Discuss Issues and code suggestions freely, but **do not merge externally owned source contributions** into a codebase intended for proprietary relicensing until adequate documented AGPL + commercial relicensing permissions and provenance review are in place. PR approval alone is not an assignment or broad sublicense. The independent Editor linking exception is still **a draft**, not a presently effective exemption.

## Operational constraints

The private canonical-source CI was deliberately stopped because of usage limits. Do not restart GitHub Actions or scheduled performance measurement merely for licensing work. Use available independent Codex/local builds for functional proof; record `NOT RUN` if unavailable. Performance acceptances remain deferred, and must be stated as such.

The release manager may prepare GitHub issues, draft PRs, static validations and a candidate. **Merging, publishing repository visibility, or claiming tests/rights are complete requires explicit evidence and a final owner decision.**

Historical audit details: [rights/provenance report](RIGHTS-PROVENANCE-PATENT-TEST-AUDIT.md); these describe earlier findings and are not a signed legal opinion.

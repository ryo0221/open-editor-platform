# Open Editor Platform — dual licensing

**Proposed publication model:** GNU AGPLv3 **only** (`AGPL-3.0-only`) **OR** a separately negotiated commercial/OEM license from parties authorized to grant all necessary rights.

This is an **alternative licensing choice**, not a cumulative obligation. The complete, unmodified GNU AGPLv3 is in [LICENSE](LICENSE). The AGPL route permits commercial activity, including paid distribution and compliant commercial SaaS. It does **not** impose payment to the project. A business seeking rights beyond AGPL's conditions may negotiate a different proprietary commercial license; no commercial rights arise automatically.

## AGPL option

- Keep applicable copyright notices, provide a copy of AGPLv3, and satisfy the AGPL's obligations for conveying binaries, conveying modified works and making Corresponding Source available.
- Under AGPLv3 section 13, an operator of a modified version that supports remote network interaction must prominently offer Corresponding Source to users interacting with it over the network. The source scope depends on what is one covered program; it does not automatically include every separate service in an enterprise architecture.
- Purely internal modifications without external conveyance generally do not require publishing source to the world. Some network-use cases may require source offers to the actual interacting users; evaluate the exact architecture.
- The AGPL permits charging money for the software; publishing a GitHub repository is **not** the only possible compliance method.
- Output created with editors is not subjected to AGPL merely by being generated using the software.

## Commercial/OEM option

- Alternative written copyright and, if necessary, patent permissions may permit closed-source distribution, SaaS and integration that would otherwise be inconsistent with AGPL conditions.
- Commercial licensees are expected to handle their own integration, testing, security fixes, support, hosting, SLAs and end-customer warranties. The Licensor **does not promise** any such services through the AGPL route.
- Product-based fixed-term OEM licensing is a commercial-policy candidate, not a published price or an automatic fee.
- Commercial license offers depend on chain of title and contributor authority. Copyright ownership is not automatically transferred to the project by a PR.
- A company that fully satisfies AGPL is **not** required to buy the commercial license simply because it sells a product.

### Planned beta and GA terms
The intended alternative license is **free of license fees for a contractually authorized beta release** until the GA transition, with **no fixed beta deadline**. Newly granted commercial/OEM licenses for GA are **paid**. GA and the commercial transition must be announced **at least three calendar months and 90 days beforehand**. Signed beta-license rights, including the treatment of already distributed copies, require express contract terms; an announcement does not automatically revoke granted rights or impose retroactive fees. There is **no automatically granted proprietary beta license** while the commercial program remains unopened. See [Beta Commercial Policy](BETA-COMMERCIAL-POLICY.md) and [Commercial/OEM gate](docs/release/COMMERCIAL-OEM-GATE.md).

## Independent Editor extensions

The project intends to allow independently authored Editors to be kept proprietary and sold without forcing the extension author to open the extension source solely because it uses documented editor interfaces. **The legal boundaries of an AGPL-covered combined work must be assessed; interface use alone does not categorically resolve the issue.**

The proposed [Independent Editor additional permission](ADDITIONAL-PERMISSION-DRAFT.md) is **NOT yet adopted** and must be reviewed for compatibility, exact scope, and effect on the OEM licensing model. The project cannot promise that a proprietary Editor combined with AGPL-covered platform code is exempt unless a valid permission applies from all needed rights holders.

## Prior MIT grants, third-party code and release

Previously granted MIT rights remain valid for copies lawfully received under the old MIT release. GPL compatibility and the exact covered release must be checked; no history rewrite can revoke the old MIT permission.

AGPLv3 does not replace the licenses of npm dependencies, fonts, Office fixtures, third-party contributions or other separately licensed materials. [License Scope](LICENSE-SCOPE.md), [Third-party provenance audit](legal/RIGHTS-PROVENANCE-PATENT-TEST-AUDIT.md).

**Release gate:** This repository is public. New source contributions require rights/provenance and compatibility review. Stable releases and separate commercial agreements require their own technical evidence and authorized sign-off; public availability alone does not grant approval.

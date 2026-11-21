# Beta commercial licensing policy — Open Editor Platform

**Business policy adopted for drafting on 2026-11-21; NOT an operative license grant.**

This document records the planned commercial offering. It does **not** authorize proprietary use, replace the unmodified [AGPLv3](LICENSE), quote a binding price, or amend a signed contract. The separate commercial/OEM program has not launched. A customer obtains alternative rights **only** under a signed agreement issued by authorized rightsholders after the [commercial launch gate](docs/release/COMMERCIAL-OEM-GATE.md) is met.

## Summary

| Item | Policy |
| --- | --- |
| Beta commercial/OEM license fee | **JPY 0**, under an executed beta agreement |
| Beta offer end date | **No preset calendar date**; the beta offer runs until the declared general-availability (GA) release |
| Allowed commercial activities | Only those expressly authorized in the signed agreement, potentially including proprietary integration, distribution and SaaS |
| GA commercial/OEM offering | **Paid**, with per-product terms and pricing established before GA |
| GA advance notice | Public notice **at least three calendar months and at least 90 days** before the earliest GA date |
| Open-source alternative | AGPLv3-compliant commercial use remains available without an OEM fee before and after GA |
| Support | No integration, maintenance, security updates, warranties, hosting or SLA by default |

“Beta” means a release explicitly designated as beta by the project; “GA” means the first release explicitly designated as a generally available production product. A preview, release candidate, public main-branch commit, or beta feature acceptance is not automatically GA. Neither the beta offer nor a GA date is currently announced as launched/scheduled.

## Notice of GA and pricing

Before the earliest GA date, publish a dated, accessible announcement that identifies:

1. The earliest GA release date and affected product/version or source scope.
2. That newly issued proprietary commercial/OEM rights for GA are paid, the pricing approach and how participants obtain a concrete quote or terms.
3. Which beta-license activities continue, which require a paid agreement, and the cutover date.
4. The transition process for beta licensees, including their existing installations and downstream recipients.
5. Where questions and updated agreement terms are available.

The earliest GA date must be **no sooner than both (a) three calendar months and (b) 90 days after the initial complete announcement**. A later GA date can be announced without reducing this minimum notice; moving GA earlier requires satisfying the original minimum. A vague “GA soon” statement or announcement without transition terms does not start the notice clock. There is no automatic GA launch date or conversion to a paid contract.

## Candidate beta agreement design (requires legal and owner approval)

- **Per-product, written grant.** Identify the licensor and rights holders, named licensee, covered release/commit and its separately owned components, authorized proprietary product/Host, modifications, source access, distribution and SaaS topology, territory, recipients and agreement duration. Free of license fees during the beta grant; no payment or royalty accrues retroactively for activities validly covered by it.
- **Duration and prospective transition.** Grant covered beta rights through the defined GA cutover, unless a valid contractual termination ground applies. Explicitly disclose at signing that *new* distribution, commercial development, product expansion or upgrades after cutover may require a paid agreement (or an independently compliant AGPL route). Do not unilaterally change existing signed rights by updating this policy page.
- **Existing deployments.** Preserve continued operation by customers who lawfully received copies before cutover, as allowed by the operative agreement and their downstream licenses. Define any necessary bug-fix/security-fix redistribution, replacement builds and customer support rights expressly; do not silently promise unrestricted future redistribution or require existing customers to stop using validly distributed copies.
- **No automatic charges.** New paid rights require an affirmative signed agreement. If the customer declines, no automatic invoice arises. The operative contract must specify lawful wind-down, continued internal possession/use (if any), and treatment of end-customer rights.
- **No production assurances.** Beta is provided without guaranteed compatibility, uptime, support, security fixes or SLA; licensees remain responsible for their own production due diligence and customer obligations. Warranties or indemnities require separately approved express terms.
- **Third-party and contributor boundaries.** Do not relicense third-party code, fonts, fixtures or patents without authority. Verify chain of title, contributor permissions and patent scope for each commercial offer. Historical MIT grants for lawfully obtained copies remain unaffected.
- **No automatic extension exception.** A proprietary independent Editor or Host is not automatically exempted from AGPL based on an unadopted additional-permission draft.

## What this does not change

- The unchanged AGPLv3 license remains the public source license. Commercial products, redistribution and SaaS that comply with AGPLv3 do not owe the project a commercial/OEM fee merely because they earn revenue.
- Users of prior lawfully licensed MIT copies retain their earlier rights.
- Outputs created with the Editors are not made AGPL-covered solely because the tool generated them.
- A policy announcement is not itself a commercial license agreement.

## Launch prerequisites

**Before accepting even a zero-fee beta proprietary license**, complete the [commercial/OEM gate](docs/release/COMMERCIAL-OEM-GATE.md) for the covered scope: rights/provenance review, contributing-author authority, third-party and patent review, approved written beta terms, authorized signer and recorded customer acceptance. A paid-GA contract requires its own pricing and terms approval before the GA notice.

Until the gate and agreement are complete, use the AGPL route where applicable; do not represent this policy as a blanket free proprietary license.

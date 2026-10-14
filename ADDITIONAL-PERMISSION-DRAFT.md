# Independent Editor Additional Permission — Working Draft v0.2

**STATUS: NON-OPERATIVE PROPOSAL. This document does not grant any additional permission.** Only a future expressly adopted notice from every relevant copyright holder on a specified release can do that. Until adoption, the unmodified [GNU AGPLv3](LICENSE) governs the code to which it applies, alongside any separately licensed works. See [decision record](legal/EDITOR-EXTENSION-BOUNDARY-DECISIONS.md).

## Intent and fundamental boundary

Enable an independently authored Editor to be privately developed, used, distributed or sold as an Editor **without automatically obligating publication of the Editor's own source merely because it connects through a narrowly defined Editor Extension Contract**.

Keep the Open Editor Platform itself (and changes to covered platform code) subject to AGPLv3 and its corresponding-source/network obligations on the AGPL route. A proprietary Host/application or commercial OEM integration does **not** become exempt just because it installs or bundles an Editor extension.

A valid exception can apply only to copyright under the control of licensors who expressly adopt it. It cannot rewrite AGPLv3, remove another owner's AGPL conditions, modify third-party licenses, waive patents of others, or revoke earlier MIT grants.

## Proposed additional permission text for specialized AGPLv3 §7 review

> **Independent Editor Extension Permission, version 0.2 — PROPOSED, NOT GRANTED**
>
> Solely for Open Editor Platform covered material on which its authorized copyright holder has expressly placed this additional permission, the holder additionally permits combination and conveyance of that material with **Qualifying Independent Editor Modules** through the **Designated Editor Extension Interface**, while permitting the Qualifying Independent Editor Module's independently authored code to be licensed and conveyed under terms chosen by its copyright owner, including proprietary terms. The authorized combination may be made and conveyed without applying GNU AGPLv3 to the Module solely because of that combination through the Designated Interface.
>
> A **Qualifying Independent Editor Module** is code independently authored by the Module's owner that: (a) implements a distinct artifact editing domain or domain-specific editor projection with its own meaningful editing commands, validation and/or view; (b) does not incorporate copied or modified copyright-protected Open Editor Platform implementation code, except separate material with compatible independent permissions; (c) communicates with Open Editor Platform **exclusively through the Designated Editor Extension Interface** for purposes of this permission; (d) can be installed, updated and removed independently of changes to the Platform's core implementation; and (e) is not a replacement, redistribution or modification of the Platform core, its general-purpose application Host, workflow orchestration, authentication, collaboration authority, or license/commercial enablement functions. A Module may have its own proprietary internal libraries.
>
> The **Designated Editor Extension Interface** means **only the interfaces and exact major versions affirmatively identified by the rightsholders in a release-specific `EDITOR-EXTENSION-INTERFACE-SCOPE.md`**. The interface scope is intentionally narrow: Editor-domain content/model validation, declared view/surface mounting, scoped editor commands/transactions, selection/events, and bounded artifact references, as defined by that future document. It **does not** automatically include every `@editor-platform/*` package entrypoint, general Host embedding or orchestration APIs, arbitrary internal `src/` imports, executable code insertion into Platform internals, or modified private interfaces.
>
> This permission applies **only to the independently authored Module code** and the act of combining it through the Designated Interface. It does **not** relieve any party of AGPLv3 obligations for Open Editor Platform, covered modifications, or any other component for which no valid additional permission is held. In particular, it does not excuse required notices, Corresponding Source, or section 13 network source offers for the AGPL-covered program. Nor does it give a proprietary Host/application a blanket exemption.
>
> If the Designated Interface does not exist for the relevant release, or a purported module connects through an unlisted or changed interface, this **additional permission is inapplicable**; rights under AGPLv3, an independent-work analysis, or a separately negotiated commercial license must then be assessed. Mere packaging labels, a declaration of "plugin" or author-provided metadata do not establish eligibility. Distribution of a separately licensed Module does not sublicense the AGPL-covered Platform.
>
> Only copyright holders of the code bearing this notice grant this permission. Each holder remains free to omit it from later modifications, and downstream treatment is governed by AGPLv3 section 7 and applicable law. This text adds permissions; it does not add restrictions to rights otherwise available under AGPLv3.
>
> **END OF PROPOSED TEXT.**

**Drafting warning:** This is not yet a legally validated or effective AGPLv3 §7 additional-permission notice. Counsel must review the conditions, especially the degree to which "Qualifying" restrictions effectively define the extent of the extra permission rather than adding impermissible downstream restrictions. Do not place this notice in the live LICENSE until that review is complete.

## Proposed interface scope (not implemented)

This is a technical design boundary, **not** an assertion that all these APIs already exist.

| Boundary | Proposed eligibility | Why |
| --- | --- | --- |
| New domain's content model, commands, validation and editor Surface | Eligible via designated v1 extension facade only | Domain-local creative work |
| Host-provided scoped artifact IO, selection/events and read-only views | Eligible if mediated by that facade | Necessary integration without core imports |
| Independent adapter or renderer used only by a qualifying Editor | Eligible as part of the Module | Supports specialized domains |
| New Data projection over existing schema | Requires separate classification; not automatically a new independent Editor | Could simply be a core feature |
| Existing public `@editor-platform/*` APIs | **Not a blanket permitted interface** | May expose general-purpose platform/Host construction |
| Modifications to platform packages/core, shared authority, templates, runtime | **Not exempt** | Maintain AGPL / OEM boundary |
| Product Host with chat/workflows/auth, artifact library or AI orchestration | **Not exempt as a whole** | This is the consuming product, not an Editor module |
| Bundled binary including platform | Platform portion remains AGPL and its source obligations remain | Prevents permission laundering |
| Remote stand-alone program via a narrowly scoped protocol | May already be a separate work; AGPL obligations depend on facts | No unnecessary license promise |

### Current-state gap

The present public code exposes multiple domain-specific public entrypoints and independent Host/Surface embedding, but **does not** offer a single general editor extension registration facade. `docs/editor-development.md` explicitly notes that `registerEditor()` is not a universal installation interface and the reference Host uses domain-specific closed unions and integration changes.

Before an in-process linking exception is adopted, define and ship an editor-domain extension contract/facade and document exact supported versions, command types, schema/serialization, asset isolation, security, and the independent installation/update process. The exception must not imply these capabilities are already shipped.

## Publishing and commercial OEM tradeoff

This is not a license to hide copies or modifications of core platform code. A commercial vendor distributing an integrated proprietary product that incorporates AGPL-covered Platform code may still need to either satisfy AGPL for the non-exempt portions or obtain an OEM license. Equally, an AGPL-compliant commercial product does not owe an OEM fee merely for being commercial.

**Do not add a condition that all nonpaying users must submit or publish a GitHub PR.** AGPL source access is to the legally specified recipients/remote users under its terms, not automatically to the original project.

## Before this can become legally effective

1. Confirm the chain of copyright ownership and authority to grant a section 7 exception on every affected file. Obtain future contributor permission before accepting externally owned contributions intended for dual licensing.
2. Design, implement and test the exact Designated Editor Extension Interface; publish its **precise** API/major-version scope and an independent-module example.
3. Confirm the exception does not inadvertently exempt the entire proprietary commercial Host/application, modified platform packages or network operation.
4. Test private-source/published-source and browser/Node build topology; identify the AGPL Covered Work vs proprietary Editor Module source and license notices in actual assembled outputs.
5. Have qualified counsel review this exception in relevant jurisdictions and the commercial/OEM contract strategy.
6. Explicitly adopt the final notice (with copyright-holder authority and release designation) only after signoff. Until then this file must remain named `*-DRAFT.md` and be referred to as **non-operative**.

**References:** [GNU AGPLv3](https://www.gnu.org/licenses/agpl-3.0.en.html) section 7; [GNU GPL FAQ: controlled-interface linking exception and plugin boundaries](https://www.gnu.org/licenses/gpl-faq.en.html#LinkingOverControlledInterface); [Editor development guide](docs/editor-development.md).

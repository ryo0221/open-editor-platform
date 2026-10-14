# Independent Editor exception: implementation and licensing scenarios

**Proposal only, not an active exception.** The controlling license remains GNU AGPLv3. This review is paired with [additional permission draft](../ADDITIONAL-PERMISSION-DRAFT.md).

## Recommended boundary

Use a future versioned Editor Extension Contract to connect independently authored modules for new artifact domains. Do not exempt an entire consuming product or any changes to the platform's AGPL-covered core. Current development documentation explicitly says there is no universal registerEditor() API. Therefore the technical contract must be implemented before the exception can be adopted.

## Scenarios to validate

| Scenario | Draft disposition |
| --- | --- |
| User creates private Editor using the designated extension API | Proposed additional permission eligible |
| User sells separately authored Editor using that API | Proposed additional permission eligible |
| Developer maintains standalone external Editor communicating over a protocol | Evaluate separate-program status; exception may be unnecessary |
| Developer copies and modifies platform Slide implementation | Not eligible for the proposed exception |
| Vendor distributes modified core without meeting AGPL obligations | Not eligible |
| Vendor bundles a proprietary product Host containing platform implementation | Host is not exempt merely because it embeds an Editor |
| Vendor distributes an AGPL-compliant paid editor product | AGPL route available without OEM fee |
| User sells outputs from an Editor | Ordinary outputs not automatically AGPL |
| Contributor offers code for dual licensing | Rights clearance and contribution agreement required |

## Proposed technical checks

- Declare a narrow, versioned, public Editor Extension Contract for domain content, commands, selection/events, scoped artifact IO and renderer mounting.
- Keep extension implementation independently buildable, installable, updateable and removable.
- Validate interface version, model schema, asset constraints, change proposals, Undo, persistence and security boundaries.
- Disallow unlisted internal imports for the purposes of **this proposed permission**. General AGPL rights are unaffected.
- AGPL source and network obligations remain in force for platform code and its covered modifications.
- Separate module provenance and AGPL platform corresponding source in actual distributions.
- Do not claim the future exception is effective until copyright-owner and qualified legal review and release-specific adoption.

## Questions for counsel

Does the proposed exception cover only independently authored Editor modules without inadvertently giving blanket permission to proprietary consuming Hosts? What happens when a modified AGPL core no longer bears the additional permission? How should a separate module be identified when compiled into a single browser bundle? How does the exception coexist with AGPL sections 7 and 13?

References: [GNU GPL FAQ](https://www.gnu.org/licenses/gpl-faq.en.html#LinkingOverControlledInterface), [Editor development](../docs/editor-development.md), [embedding](../docs/embedding.md).

**Status: not granted, not merged, not published.**

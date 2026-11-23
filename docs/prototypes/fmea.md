# FMEA Structured Data prototype

Status: **experimental**, not an accepted FMEA analysis tool, certified safety assessment, or implementation of a proprietary rating or Action Priority table.

## Open the examples

1. Open the Playground Library and select **Structured Data**.
2. Choose **Process FMEA (prototype)** or **Design FMEA (prototype)** under **Data template**, then create the artifact.
3. The native Data editor opens with three example rows, stable row IDs and two grid views: `リスク分析` and `対策管理`.
4. Edit S, O and D (each an integer from 1 to 10), change prevention/detection controls, proposed actions, owner, due date and status. The existing Data formula recalculates RPN.
5. The banner reports incomplete/out-of-range ratings. Saving a retained version rejects invalid S/O/D ratings; the draft remains. AP starts as `未評価` and must be evaluated manually against an explicitly selected rating/AP method.

## Why this is Data, not a new Editor kind

FMEA starts as a table of failure modes, effects, causes, controls, ratings, action owners and decisions. OEP's Structured Data supports grid editing, formulas, multiple views, stable rows, native version storage and export. A dedicated FMEA model/Editor could later be justified by cross-row effects, hierarchical function-failure-cause structure, rating tables, AP rules, evidence references or specialized workflow UX; none is asserted here.

## Example fields

- Target/function, failure mode, effect, cause, existing prevention control and detection control.
- S/O/D numeric ratings, RPN reference formula `S * O * D`, and AP **manual review** select.
- Recommended action, owner, due date, status and evidence/reference memo.

## Important limits

- The 1–10 score values in the samples are **illustrative**, not calibrated to a standard-specific rating table.
- RPN is not a risk acceptability threshold or an Action Priority. High severity must not be masked by low RPN.
- No AIAG/VDA AP lookup, DFMEA/PFMEA process step hierarchy, post-action reassessment, multi-party approval, controlled rating-table version or review evidence closure in this prototype.
- Cross-artifact references to the related Fishbone/FTA remain ordinary notes and are **not verified live links**.
- The prototype detects out-of-range S/O/D at the Playground banner and retained-version save. It does not change the generic Structured Data schema.
- AP H/M/L values are unverified manual classifications; no approval is implied.

## Verification

Automated sample/unit tests: `apps/playground/src/app/fmea-templates.test.ts`. Relevant full checks: repo lint, typecheck, build, Data creation/editing/save/reload/import/desktop/mobile regressions. Until executed, report them as NOT RUN. Do not treat a structurally valid Data table as a certified FMEA.

Design decision: use a Host-owned Data template while validating UX. Reassess a dedicated FMEA Surface only if the Domain requires operations that the generic Data projections cannot safely express.

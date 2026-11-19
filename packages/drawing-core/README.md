# drawing-core（DW1、施工図・制作図の正本）

Private pure TypeScript model of the drawing domain for the construction and shop drawing plan and ADR 022. No React.

- `model.ts`: `DrawingDocument` (schema 1): the sources (exact CAD/BIM versions by content hash), the sheets (A0–A4, landscape/portrait, filing margin, title block, revisions), the views (DW1: `cad-projection` definitions only; what they show is derived, never saved) and the notes. Paper millimetres, y up.
- `validation.ts`: `validateDrawing` (plain JSON, exact keys, enums, IDs unique across the document, references resolved, revision marks unique per sheet, dates, limits), `assertDrawing`, `isDrawingDocument`.
- `operations.ts`: pure edits (sheets, revisions, sources reused per exact version, views, notes, move, delete with the sheet's views and unused sources), `drawingEditorCommand` (one EditorSession transaction that re-checks base and authority).
- `sheet.ts`: the sheet's fixed drawing: frame, zones, centring marks, the title block with the projection symbol, the revision table (JIS Z 8311 layout).
- `svg.ts`: one sheet as SVG with its views' derived graphics or placeholders and its notes; JIS line types (hidden dashed, centre chain).
- `fixtures.ts`: F136 `f136DrawingSheets` (two sheets, filled title block, two revisions, a note), written for this project.

Unit tests: TS-2400 (`drawing.test.ts`).

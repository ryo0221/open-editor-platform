# drawing（DW1、施工図・制作図のSurface）

The drawing Surface for the construction and shop drawing plan and ADR 022.

- `DrawingController`: state without React; each edit is one session command replacing the document (the Host saves and owns Undo/Redo). Views' derived graphics come from the Host's `derive` (DW2, DW5) and stay out of the content.
- `DrawingSurface`: the sheet list, the sheet on paper (zoom, fit, select, drag views and notes, place notes), the sheet's size/orientation/filing margin, the title block, revisions, the selected view's and note's properties, SVG export of the sheet.

The Playground binds it in `apps/playground/src/drawing/host.tsx`. Browser test: TS-2401 (`tests/e2e/drawing-playground.spec.ts`, suite `drawing.playground`, port 4232).

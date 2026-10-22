# cad (CAD-T3)

Private CAD Surface for the 3D CAD design. Not wired into a Host yet (CAD-T4).

- `CadController`: React-free state for the Surface. Owns the `CadCoordinator`, selection, diagnostics (Japanese messages) and meshes keyed by exact content hash. Every edit is prepare → apply; nothing writes the session directly. IDs are assigned once, before prepare.
- `CadSurface`: `EditorLayout` with tools (Undo, Redo, Box, Cylinder, Sphere, Plate), an element list (bodies, parameters, feature history), an Inspector (name, placement, dimensions, measurements, Combine, Delete) and a status line. A rejected edit restores the field.
- `CadViewport`: Three.js display only (Z-up, mm, orbit, fit, pick). Meshes from an earlier content are shown dimmed and are not pickable. WebGL loss keeps the lists and Inspector usable.

`test-host/` runs the Surface standalone with the development kernel from `CAD_OCCT_DIST` (outside Git):

```sh
CAD_OCCT_DIST=<opencascade.js dist> npx vite --config packages/cad/vite.config.ts
CAD_OCCT_DIST=<opencascade.js dist> E2E_SUITE=cad npx playwright test
```

Query options: `?fixture=plate`, `?readonly=1`, `?kernel=missing`. See verification.

# @editor-platform/fem-mesher

Volume meshing for the analysis (docs/cad/r3-analysis.md, R3b). It takes the analysis shape as a closed, outward-wound triangulation of its boundary, with every triangle tagged by its shape face and a chain of surface points along every shape edge. [Netgen](https://github.com/NGSolve/netgen) (LGPL-2.1, compiled to Wasm by `scripts/fem-mesher`) fills that surface with tetrahedra. The result is a checked FEM 1 mesh (`@editor-platform/geometry-fem`).

Netgen keeps every surface point and triangle, so face tags and edge chains carry over by index. Nothing is matched by nearness. The output is refused (`surface-changed`) when its surface differs from the input.

- `checkSurface(input)`: closed 2-manifold, each edge used once in each direction, positive enclosed volume, tags in range, edge chains running along triangle edges. Refusals are `MesherError`s.
- `meshSurface(module, input, settings)`: checks the settings and the surface, then meshes and assembles. tet10 mid-edge nodes sit on the straight edge, except on surface edges listed in `input.midpoints` (R3d-2a: points on the shape's curve or surface, from the kernel's analysis surface). Those go onto the given point; an element that would fold (det J ≤ 0 at a node or Gauss point, `jacobianRatio`) has its curved mid nodes put back on the straight edge. `meshSurfaceReport` also returns how many were placed (`curved`) and put back (`straightened`).
- `boxSurface(size, divisions)`: a box's boundary in this form. It stands in for the kernel's triangulation until R3c-2.
- `netgenGrading(g)`: converts the document's growth ratio between neighbours (≥ 1) to Netgen's grading (g − 1, clamped to [0.05, 1]).

The Wasm stays outside Git. Build it with `sh scripts/fem-mesher/build.sh work/fem-mesher` (see `scripts/fem-mesher/README.md`). The Wasm tests run when `work/fem-mesher` or `FEM_MESHER_DIST` holds the pinned build.

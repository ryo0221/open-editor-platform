# @editor-platform/simulation

Runs a static study of a simulation document (docs/cad/r3-analysis.md, R3e-3). The kernel, the mesher and the solver are passed in (`RunEnvironment`), so the same runner serves the browser Worker, the Host and the tests.

`runStudy(doc, cad, cadContentHash, studyId, table, env)`:

1. Checks the document, the study, the source version (content hash and body) and the material.
2. Resolves explicit removals and local face sizes on the body's topology table. Local edge sizes are refused because they are not applied yet.
3. For each convergence level (`convergenceLevelSettings`):
   - asks the kernel for the analysis surface, which must report the same body table;
   - refuses before meshing when even regular tetrahedra of the global size would exceed the browser limit (`simulationLimits.browserElements`);
   - meshes tet10 with Netgen, then applies the browser node and element limits.
4. Builds the mapping table, and refuses when any target is not resolved.
5. Distributes the loads (face force, edge force, pressure, gravity) and constraints (fixed, displacement, and a roller on an axis-aligned plane), then solves with `solveElastic`.
6. Records five checks per level, against the kernel's exact measures:
   - mapping;
   - load: the pressure resultant −p Σ∫n dA;
   - quality;
   - solver;
   - equilibrium.

   It also records three metrics per level: maximum displacement, maximum von Mises stress, and reaction force. It then decides the status with `studyStatus`.

Every refusal is a typed `RunFailure` (`code`, `detail`, `level`), and no input is repaired. The finest level's nodal fields (`RunFields`) are what R3e-4 displays and writes as VTU.

## Surface (`@editor-platform/simulation/surface`, R3e-4a/4b)

`SimulationSurface` edits what is analysed, the material (presets and values), the mesh settings, the loads and constraints and the study's convergence levels. Each user action is one `SimulationOperation`, or several applied in order, given to the Host's `apply`, which prepares one `simulationEditorCommand` (one Undo step) against the current content and owns saving and Undo/Redo; a refused edit shows its reason and changes nothing. Number fields apply on commit (blur or Enter); one being typed in registers its pending value through `registerInput`, so the Host's save, export and switch commit it first. Styles: `@editor-platform/simulation/style.css`.

R3e-4b: the Host passes the analysed body's evaluated display mesh as `shape` (`{ status: 'ok', mesh, featureId }`). `SimulationViewport` (`@editor-platform/simulation/viewport`, the CAD viewport) shows it with the selected faces, load faces and constraint faces in their colours (`simulationMarkColors`). A click toggles the face under it in the selection; "Add fixed support", "Add force" (0, 0, −100 N) and "Add pressure" (1 MPa) put an item on the selected faces, referenced by `topologyRefOf` on the body's result feature. The first study (`defaultStudy`: linear static, three mesh levels) is made once there is a load and a constraint, and later items join it; removing a study's last constraint removes that study in the same edit (`conditions.ts`). "Use selected faces" retargets an item. Targets that do not resolve on the shown shape are counted, not drawn. Running and results come in R3e-4c.

## Running in the browser (R3e-4c)

`./run-worker` is the study Worker: it loads the CAD kernel build and the Netgen build (`FemMesherBuild`), each verified by the SHA-256 of its Wasm, runs `runStudy` and posts `progress` (level and step), then `done` with the `StudyRun` or `error` (`run-protocol.ts`). One Worker runs one study; cancelling terminates it. The Surface's `runner` (`SimulationRunner`) is the Host's binding, with `unavailable` naming why a study cannot run (no kernel, no mesher in this build, the part not evaluated). The Playground serves Netgen in development from `FEM_MESHER_DIST` (`scripts/dev/fem-mesher.mjs`, `virtual:fem-mesher-build`); a static build has no mesher until the build is released.

A run is kept in memory beside the content it was made on and shown as out of date once the content changes; it is not stored yet. The Run panel shows the state (Verified, Reference only with its reasons, or Failed with the code), each level's size, nodes and metrics, and on the finest level the boundary coloured by von Mises stress or displacement magnitude over its range (`results.ts`: `resultMesh`, `resultColor`, legend `resultGradient`), moved by the deformation scale (auto: the largest movement is a tenth of the model's size). "Export VTU" writes the finest mesh with displacement, stress, von Mises and reaction (`resultVtu`, ParaView).

## Looking at a result (R3e-4d)

A result source (`ResultSource`) is a run's finest level (`runResult`) or a VTU opened for display (`vtuResult`: its boundary is every element face no other element shares; every scalar point field and every vector one by magnitude is offered; a vector named `Displacement…` moves the shape; `readVtu`'s checks refuse a malformed file as `result-invalid`). `resultDisplay` draws it with an optional axis section (`ResultSection`): the boundary is clipped to the side below the plane and each cut element adds its cut polygon, coloured by values interpolated along the cut edges. A click on the shown result reads the value at the nearest shown vertex (`readAt`, through the viewport's measure tool). An opened VTU is shown instead of the run until "Close VTU"; it is never stored and cannot be exported again.

A run is coloured by von Mises, the largest and smallest principal stress (R3e-5d: `principalStresses` in `geometry-fem`, the eigenvalues of each nodal stress) or the displacement; the VTU carries the principal stresses too.

## Preparing the shape and the mesh (R3e-5a)

The Preparation group removes cylindrical holes below a diameter and fillets below a radius from the analysed shape only (`setPreparation`; the CAD part is not changed, and a load or constraint on a removed face stops the run with the reason). "Finer size on selected faces" adds a local mesh size for each picked face not already sized, starting at half the element size and never below the smallest size (`addLocalSizesOp`, `setLocalSizeOp` in `conditions.ts`); the faces are marked in the view, and a size below the smallest is refused by the core as `mesh-size-order`.

## Switching the CAD version and resolving targets (R3e-5b)

"CAD version" lists the other saved versions of the analysed CAD Artifact that still have the analysed body. The Host keeps the chosen version with the record first (`stageSimulationSource`), then applies `setSource` as one Undo step; the export keeps only the versions the draft and versions analyse (`portableSimulationRecord`), and a stored record may keep one switched away from. Targets resolve again on the new version by their names, never by nearness. After a run stops at the mapping, `MappingIssues` lists each open target with its item and reason: one lost or split in the CAD version is picked again ("Use selection"), and one the preparation split or merged can be applied to all its candidates (`overrideAllOp`, a `setOverride` for this version, preparation and kernel build).

## Recording a run (R3e-5c)

"Record result" keeps the shown run with the analysis as one Undo step (`recordRunOp`, op `recordRun`): the input hash (`simulationInputHash`, the document without its records, retired IDs and name), the CAD version, the kernel, mesher and solver builds, each level's size, node and element counts and metrics, the finest level's checks, and the status with its reasons. A later record of the study replaces it, and removing the study removes it. A record whose inputs or kernel, mesher and solver builds no longer match the runner's is shown as out of date (`runRecordCurrent`), and one shows as verified only when its checks and levels make it so under its study (`recordedStatus`); validation refuses a verified record without every check passed over two levels. The mesh and the result fields are not kept yet.

## Compute Host (R3f-2)

A Host may give the editor an optional compute capability (`SimulationComputeDescriptor`: label, destination, solver build, limits, same-origin endpoint). Editing, saving and browser runs never need one. A job (`computeJobOf`) carries only numbers: nodes, elements, E and ν, the prescribed DOFs and the non-zero nodal forces that `prepareElastic` mapped. `checkComputeJob` checks a job as it arrives (keys, limits, finite numbers, indices, each DOF once, material) and `computeJobInp` writes the CalculiX `.inp` from those numbers only. `runComputeJob(host, job, { signal, onProgress })` posts the job, polls its state, cancels it on abort and returns the `.frd` text, or throws `ComputeHostError` with `unreachable`, `refused`, `failed` (CalculiX's `*ERROR` lines) or `cancelled`.

The reference Host is `scripts/dev/simulation-host.mjs`, a dev-server plugin: with `ccx` on PATH (and not `SIMULATION_HOST=off`) `virtual:simulation-compute-host` describes it, and `/__simulation-host/jobs` takes JSON jobs from its own origin, runs one `ccx` at a time in a temporary folder with a time limit, and removes the folder when the result is read, the job is cancelled or ten minutes after it ended. A static build has no compute Host (the module is null). CalculiX is installed on the server on its own and never bundled.

## Solving on the compute Host (R3f-3)

With a compute Host the Run group offers "Run on <Host>" next to "Run study" and says what that sends and where (mesh nodes and elements, E and ν, the held nodes and the nodal forces; no CAD document, names or sign-in) and the Host's limits. The Worker meshes and maps as usual and solves through `RunEnvironment.remote` (`solveOnHost`): the Host's limits replace the browser's, the progress names the Host, the solver check says "direct solve by <build>", and the equilibrium check allows `computeEquilibriumTolerance` (2e-5) for the `.frd`'s 6 significant digits. A Host failure or a bad result stops the run with `host`; cancelling asks the Worker to cancel the Host job before it is terminated. A run's solver build is the Host's, and a record of it is current while that Host is there (`runRecordCurrent` takes the builds of every place a run can go).

## Modal studies (R3g-2)

"Add modal study" in the Study group adds `defaultModalStudy`: every constraint, no loads, the six lowest modes, two levels compared on `first-frequency`. With more than one study a Study selector picks the one the panels show and run; a finished run belongs to its study. New constraints go into every study and new loads into the static ones. A modal run (`solveModal`, in the browser up to `browserModalNodes`/`browserModalElements`) checks mapping, mass (the mesh's against the shape's ρV), mesh quality, solver residuals and M-orthogonality; its fields are the modes (`ModalRunFields`). The Run group lists each mode's frequency and effective mass in x, y and z; each mode is a result field ("Mode 1 at 417.5 Hz") that moves the mesh by its own shape, scaled to a largest movement of 1, and the VTU carries the mass-normalised shapes as "Mode 1 (417.5 Hz)", which open again as modes.

R3j-5c: a modal study of a solid, a shell or bonded bodies can also run on the compute Host (`solveModalOnHost`, `solveShellModalOnHost`, `solveBondedModalOnHost`, wired as `RunEnvironment.remote.solveModal`, `solveShellModal`, `solveBondedModal`; a Host without the one a study needs refuses it with `host`). The job is `kind: 'modal'` with `modes` and each part's density (mm only, held at 0, no force); the run note says it sends the density and the number of modes instead of the forces. CalculiX's mass matrix does not come back, so the solver and orthogonality checks use the modes' internal forces K φ: the Rayleigh quotients |φᵀ K φ / λ − 1| and K-orthogonality within `computeModalTolerance` (1e-4, for the `.frd`'s 6 digits).

## Thermal studies (R3h-2)

"Add temperature", "Add heat flux" and "Add convection" put thermal conditions on the selected faces (a held temperature in K is a constraint; a flux in kW/m², numerically mW/mm², and a convection with h in kW/(m²·K) and an ambient temperature are loads). The material's conductivity is in W/(m·K). "Add thermal study" (`defaultThermalStudy`) takes every thermal item and needs a held temperature or a convection; thermal items go into thermal studies only and structural ones into the others, and a thermal study left with neither a temperature nor a convection is removed with the item. A thermal run (`solveThermal`, browser only) checks mapping, each condition's mesh area against the shape's (`load`), mesh quality, the solver and the heat balance within `thermalBalanceTolerance` of the largest condition's heat (`equilibrium`); its metrics are `max-temperature` and `max-heat-flux`. The result fields are the temperature (K) and the flux size (kW/m²), and the VTU carries "Temperature (K)" and the flux vector "Heat flux (kW per m²)" (VTU names take no "/").

## Shell studies (R3i-4)

A structural study with `idealisation: 'shell'` runs each level through `runShellLevel` (`run-shell.ts`): the kernel's midsurface (`analysisSurface.idealisation: 'shell'`, no graded refinement), `shellMeshFromSurface` with the wall's thickness and `shellMeshQuality` (a triangle past `shellQualityMin` stops the run, `mesh-quality`), the mapping through the midsurface history, then `solveShell` or `solveShellModal`. Fixed holds displacements and rotations, pinned and displacement constraints the displacements only; a force on a side becomes an edge force; a pressure on the far wall face pushes along the midsurface normal. A pressure on a side and a roller are refused (`shell-target`), a compute Host too (`host`). The checks are the solid run's, with the moment equilibrium and, for modes, the mass ρ t × the midsurface area. The fields (`shell-static`, `shell-modal`) show the midsurface triangles with no sections: von Mises on the larger surface, on the top and on the bottom, and the displacement; the VTU writes VTK triangles with `Thickness (mm)` per cell and the displacements, rotations, the three surfaces' stresses, both von Mises and the reactions.

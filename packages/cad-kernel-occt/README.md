# cad-kernel-occt (CAD-T2b)

Private OCCT kernel adapter for the 3D CAD design. Not an accepted distribution: the D0 gate is still open and development uses the npm OpenCascade.js build recorded in D0.

- No npm dependency on OpenCascade.js. The Host supplies a `CadKernelBuild` (module URL, Wasm URL, `sha256:` build hash); `loadVerifiedBuild` refuses Wasm bytes with another hash, and documents evaluate only on the build named by `kernelProfile.buildHash`.
- `evaluateCad`: full-graph evaluation in stable topological order. One valid solid per feature, result tolerance limit, decoded OCCT exceptions, per-body volume/area/bounds, model-space meshes with per-triangle face pick IDs, output limits. Every handle is deleted before returning.
- `createKernelHost` / `worker.ts`: Worker-side handler. One job at a time; cancel is checked at macrotask boundaries between features and acknowledged after handles are released.
- `WorkerKernelPort`: `CadKernelPort` for `CadCoordinator`. One running job and the latest waiting job; unacknowledged cancel (500 ms), job timeout (30 s) or a crash terminates the Worker and the next job starts on a fresh instance.

`kernel.test.ts` runs against the real build only when `CAD_OCCT_DIST` points to it; see verification.

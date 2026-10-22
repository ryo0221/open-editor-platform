# cad-core (CAD-T1, D1a pure model)

Private pure TypeScript model for the 3D CAD Editor design. Not a registered editor, a stable public API or an accepted storage format. No DOM, React, Worker or geometry kernel: solid validity, meshes and measurements belong to the kernel adapter (CAD-T2) and are not checked here.

- `model.ts`: schema 1 types (`CadDocument`, typed `Length`/`Angle`/`Position3`, unit quaternions, dedicated body placement) and the initial safety limits from model.md.
- `validateCad(unknown)`: strict plain-JSON and domain validation with path diagnostics: exact keys, ID uniqueness, parameter types, affine range, quaternion norm, profile simplicity/area, revolve axis side, feature arity/order/cycle/DAG depth, body/consumed/view invariants, limits. D1 rejects `imported` features and non-empty `assets`.
- `applyCadOperation`: pure, atomic operations (`insertFeatures`, `setParameter`, `updateFeature`, `updateProfile`, `transformBody`, `booleanBodies`, `deleteClosure`, `duplicateClosure`, `rename`, `saveNamedView`, `reorderFeatures`). The caller's trusted layer assigns every new ID before the operation is built.
- `cadEditorCommand`: one ordinary `EditorSession` transaction per operation. It re-checks the expected base `contentHash`, current edit authority and the result schema, and pins `reads.content = ['*']`. The kernel coordinator's prepare/ticket boundary (operations.md) is not in this package; geometry-producing operations must not reach a session without it.
- `compareCad`: semantic differences by stable ID. `fixtures.ts`: F01/F02/F03/F05 from the verification plan.

`fixtureKernel` is a placeholder evaluator identity. The real `kernelProfile.buildHash` is pinned by the D0 kernel gate (CAD-T0). See verification record for tested scope.

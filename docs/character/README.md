# Character: 3D editing and animation

Character is a separate domain for mesh assets, parts, skeletons, morphs and animation
actions. It shares geometry and time utilities with other editors, but keeps its own
document model. The Playground exposes the Character editor; the standalone Surface
also has a reference test Host.

The source includes glTF/GLB and VRM import, playback, mesh editing and subdivision,
UV editing, rigging and weights, pose/keyframe editing, morphs and GLB export.
Character was accepted as a regular editor on 2026-11-14. It is open source software used at
your own risk: shared editing, a stable public API, performance and every environment are
not guaranteed.
See the package-level contracts for exact operations and limits:

- [Character Surface](../../packages/character/README.md)
- [Character model and import](../../packages/character-core/README.md)
- [Shared mesh operations](../../packages/geometry-mesh/README.md)

Documents refer to immutable assets by ID, size and SHA-256. The Host owns their bytes,
storage and exact references to other artifacts. Imported VRM license metadata is
displayed; it does not grant rights or automatically enforce usage conditions.
External model rights must be checked by the user supplying those models.

Unknown document schemas, missing or mismatched assets and unsupported required glTF
extensions are rejected. Import reports losses; glTF output cannot preserve every
native editing feature. FBX, OBJ, Blend and VRM output are not supported.
Shared editing, automatic schema migration and production authorization are outside
this implementation. Performance and real-device acceptance remain separate work;
the existence of source and tests is not a performance or all-environment guarantee.

Character does not require the OCCT kernel. Optional CAD props retain the CAD domain's
own kernel and acceptance requirements. AI execution and identity remain Host-owned.

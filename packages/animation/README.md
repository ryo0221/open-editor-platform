# Animation local editing prototype

Standalone React sample using native Animation schema 1, Animation Core commands,
existing EditorSession local history and the real Rectangle Player. See
scope and verification.

Build: `npx vite build --config packages/animation/vite.config.ts`.
Run: `npx vite preview --config packages/animation/vite.config.ts --port 5195`.
Open `http://localhost:5195/`.

This branch does not modify the shared root lockfile. The integration owner must
review `docs/animation/editing-workspace-lock.patch` (combined Animation entries;
replaces rather than stacks on the earlier workspace-lock.patch). Existing root
workspaces already include packages/\*. Local dependency setup uses the existing
installed dependencies and a workspace symlink; this is not a clean-install claim.

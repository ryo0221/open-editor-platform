# Animation local Surface and retained Viewer

`@editor-platform/animation/local` exports `AnimationSurface`. Supply the Host's
existing EditorSession, EditorInputs, canonical content, command/history callbacks,
readOnly flag and error reporting. It does not create a second session or persistence
store. The ordinary Host owns version save/restore and native import/export.

`@editor-platform/animation/viewer` exports `AnimationViewer` for a validated exact
`AnimationEmbed`. No source catalog, Playground state or CSS is required. Rectangle/group
v1 only, contain fit, private playback; reduced motion disables autoplay. Native snapshots
and explicit version adoption are covered by the [connection contract](../../docs/animation/playground-slide-integration.md).

The independent production Host is built by `npm run build`; run
`npx vite preview --config vite.animation-host.config.ts` and open port 4189.

## Historical standalone sample

Standalone React sample using native Animation schema 1, Animation Core commands,
existing EditorSession local history and the real Rectangle Player. See
scope and verification.

Build: `npx vite build --config packages/animation/vite.config.ts`.
Run: `npx vite preview --config packages/animation/vite.config.ts --port 5195`.
Open `http://localhost:5195/`.

The old workspace-lock patches document the original sample handoff. The current
root lock includes the workspaces and ordinary Host dependencies; use `npm ci`.
The standalone sample creates its own local session and is separate from the
controlled public Surface used by the ordinary and independent Hosts.

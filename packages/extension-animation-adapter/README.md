# Controlled Animation adapter (local experiment)

Trusted local draft.2 adapter for the approved experimental controlled Surface and
Animation Playback ports. `controlledAnimationExtension(packageHash, { onError,
mounted })` receives the Host-verified adapter archive hash and mounts the real
Animation controlled Surface. `mounted` exposes the scoped controller and playback
port; `setAnimationLayerX` demonstrates deterministic non-UI use of that same history.

The Host must provide lifecycle; edit, inputs and save are optional capabilities.
The adapter owns Player preparation, animation frames and React-root teardown through
scope drain. A manifest is not a sandbox for untrusted executable code. No native schema,
resource or save protocol is generalized here.

See `docs/extension-76/animation-host-checkpoint.md` for exact checks and limitations.

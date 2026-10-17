# Animation Player — rectangle v1 and prototype preview

The root entrypoint keeps the scene-only controlled adapter:
`createControlledAnimationPlayer(prepared, compositionId).sceneAt(tick)`.

The new provisional `@editor-platform/animation-player/preview` subpath exports
`mountAnimationPreview(container, { source, compositionId, label, signal, ... })`.
It renders only asset-free rectangles/groups/nested compositions through the same
Core evaluator. Controls are read-only seek/play/pause/setRate/dispose; clock/playhead
never enter content/history. Hosts must dispose or abort on unmount/revocation.
Autoplay is opt-in, reduced-motion/hidden suppress it; explicit controls remain available.

`@editor-platform/animation-player/resources` is a separate PNG readiness spike, with
exact bytes/hash, predecode pixel bounds and cancellation/release. It does not enable
native image layers. Asset-bearing sources are rejected by the rectangle preview.
No font, mask, path, text, JPEG decode, media export or Slide/Video integration claim.

Milestone, pending decisions and #76 handoff.
The preview/resources subpaths remain experimental. The separate v1 subpath below
has a narrow rectangle/group contract; no shared registration or #75 runtime adoption
is included in this gate.

Local fixture commands from repository root (existing dependencies required):

```sh
npx vite build --config packages/animation-player/vite.config.ts
npx playwright test --config packages/animation-player/playwright.config.ts
```

Production output is `/tmp/animation-player-fixture-dist`. The fixture is a private local
functional demonstration, not a published site or production Editor.

`@editor-platform/animation-player/v1` is the explicit **rectangle/group v1** entrypoint.
It rejects prototype sources; use the explicit migration before adoption. The `/v1.html`
production fixture demonstrates this gate. See contract and limits.
This does not promote nested playback or PNG readiness into the v1 contract.

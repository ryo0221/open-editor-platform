# Canvas interaction contracts

`@editor-platform/canvas-ui` renders a Host-owned projection. The Host retains native
data, commands, permissions, revision preconditions and Undo/Redo. These UI controls
do not replace authorization or validation at command submission.

## Object resize capability

`CanvasTarget.resizable?: boolean` controls Canvas object resize only. Omission or
`true` preserves resize; `false` hides all eight resize handles and refuses resize
input. The selection frame remains. Move, Arrow nudge, selection, rotation and
`PathHandles` point editing keep their own rules. `rotatable`, `readOnly`, `locked`
and `inputOwner` retain their independent meanings.

Every explicitly selected ID must resolve to a visible, unlocked target. Resize
also requires every selected target to permit resize. Empty or partially unresolved
selections cannot resize; mixed selections never resize only the permitted subset.
Visibility and input use the same predicate. Capability is checked at gesture start,
before preview and immediately before command callback. A committed Host update
that removes permission or the target cancels an active object gesture without
waiting for another pointer event. Restoring permission requires a new pointerdown.

Transformation still uses the existing selected roots and domain preview callback.
Canvas does not infer constraints from unselected descendants: a domain must
aggregate such constraints into its parent target and validate the final command.
This flag is projection metadata; Canvas does not persist it into native/schema
data or apply it automatically to existing consumers.

Resize handles have the accessible names `Resize nw`, `Resize n`, `Resize ne`,
`Resize e`, `Resize se`, `Resize s`, `Resize sw`, `Resize w`. For a single target,
its label is an `aria-description`, independent of the direction name.

## Object gesture invalidation

`CanvasStageProps.objectRevision?: unknown` is an optional opaque token for
**move, resize and rotate** prerequisites. The Host supplies a stable identity for
the current operation context. Canvas snapshots it at pointerdown and compares
with `Object.is`; it interprets no sequence, session, numeric ordering or domain.
For example:

```tsx
<CanvasStage
  objectRevision={`${sessionId}:${sequence}`}
  // ...existing projection and command callbacks
/>
```

Include a session/context component when equal sequence numbers in different
sessions must invalidate each other. A stable primitive, Symbol or memoized object
is suitable. A freshly allocated object on every render will invalidate every
active object gesture. An object mutated in place keeps the same identity and
does not invalidate. Targets, callbacks, camera and unrelated render references
are not invalidation tokens.

On a token change, Canvas cancels the object gesture in the committed React update,
clears preview/guides and releases pointer capture. The next render projects the
current Host native state; Canvas never restores an old native snapshot. Input
checks before preview, after a preview callback and immediately before command
submission also protect against reentrant updates and stale event closures. The
same cleanup handles permission and token invalidation, including simultaneous
changes. Old pointerup events cannot commit; returning to an old token cannot
resume a canceled gesture.

When a pointerdown replaces an active gesture, old visual cleanup precedes capture
release. The new start re-reads Host prerequisites and token after release callbacks;
it also leaves a newer gesture started by such a callback intact.

Omission uses the stable value `undefined` and preserves revision-unaware behavior.
Changing from a defined token to omission also invalidates; reapplying the token
does not resume. Hosts opting in must keep permission, domain and revision checks
at their command boundary. Successful command callbacks run after the old gesture
is detached, so advancing revision during a normal commit does not cancel that
command or create a second command/history entry.

Host pointer preconditions must end with the matching pointer operation, including
`pointerup`/`pointercancel` outside the Canvas parent. Cleanup must follow the
synchronous command callback; capture release itself cannot end the precondition
because normal commit releases capture first. Independent keyboard commands after
pointer completion use current prerequisites. See the
[Host integration pattern](../../docs/host-integration.md) for propagation and cleanup.

Object invalidation preserves selection, camera, focus and text/IME state; it does
not remount Canvas. `PathHandles.revision` and `disabled` retain separate ownership
of point gestures. Pan, text, freehand and other modes do not adopt the object token.

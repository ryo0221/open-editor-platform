/**
 * CR7e: "Camera" in the Inspector. "Key camera" keys the action's camera at the playhead where the
 * view stands and looks now; the view looks through the keyed camera while "Look through the
 * action's camera" is on. A video of an action with camera keys is always filmed through them.
 */
export function CameraControls({
  keyed,
  follow,
  onFollow,
  canKey,
  reason,
  onKey,
}: {
  /** The action has camera tracks. */
  keyed: boolean;
  follow: boolean;
  onFollow(on: boolean): void;
  canKey: boolean;
  /** Why the camera cannot be keyed now. */
  reason: string;
  onKey(): void;
}) {
  return (
    <div role="group" aria-label="Action camera">
      <div className="character-mesh-row">
        <button type="button" disabled={!canKey} onClick={onKey}>
          Key camera
        </button>
      </div>
      {!canKey && <p className="character-hint">{reason}</p>}
      <label className="character-field character-name-field">
        <input
          type="checkbox"
          aria-label="Look through the action’s camera"
          checked={follow}
          disabled={!keyed}
          onChange={(e) => onFollow(e.target.checked)}
        />
        <span>Look through the action’s camera</span>
      </label>
      <p className="character-hint" data-testid="camera-keyed">
        {keyed
          ? 'The video is filmed through the action’s camera.'
          : 'No camera keys: playback and the video use the view’s camera.'}
      </p>
    </div>
  );
}

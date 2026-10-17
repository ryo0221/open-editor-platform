// A refused close must retain the same live owner and its reconciliation controls.
export async function disposeGuarded(owner: {
  guard(): Promise<void>;
  dispose(): Promise<void>;
  resume(): void;
}) {
  try {
    await owner.guard();
    await owner.dispose();
  } catch (error) {
    owner.resume();
    throw error;
  }
}

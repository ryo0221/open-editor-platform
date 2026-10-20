/** The registered React subset counts encoded bytes, independently of prop string length. */
export const ANIMATION_REACT_NATIVE_BYTES = 3 * 1024 * 1024;
export function assertAnimationReactNativeBytes(native: string) {
  if (new TextEncoder().encode(native).byteLength > ANIMATION_REACT_NATIVE_BYTES)
    throw Error(
      'Registered React Animation supports at most 3 MiB of retained native JSON; use the native Player for larger sources',
    );
}

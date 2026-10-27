/** The Embind module of a pinned build. It ships no types in this repository. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped Embind surface
export type OcModule = any;

/** Decodes an OCCT C++ exception thrown through Embind (a pointer number). */
export function decodeKernelException(
  oc: OcModule,
  error: unknown,
): { type: string; message: string } {
  if (typeof error !== 'number')
    return { type: 'js', message: String((error as Error)?.message ?? error) };
  const failure = oc.OCJS.getStandard_FailureData(error);
  const type = failure.DynamicType();
  const decoded = { type: type.get().Name(), message: failure.GetMessageString() };
  type.delete();
  // The exception object is never caught in C++. Builds that expose releaseException free it;
  // the npm development build cannot, and leaks it (docs/verification/cad-d0/leakcheck.md).
  oc.OCJS.releaseException?.(error);
  return decoded;
}

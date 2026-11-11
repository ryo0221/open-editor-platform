interface PinnedSource {
  url: string;
  tag: string;
  commit: string;
}
export const femMesherInputs: { netgen: PinnedSource; zlib: PinnedSource; image: string };
export const femMesherBuild: { js: string; wasm: string; jsSha256: string; wasmSha256: string };

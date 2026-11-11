// The pinned inputs of the fem-mesher Wasm (docs/cad/r3-analysis.md, R3b) and the hashes a build
// must reproduce. build.sh reads the commits and the image from here; the tests read the hashes.

/** Netgen (LGPL-2.1), zlib (zlib licence), and the Emscripten image the build runs in. */
export const femMesherInputs = Object.freeze({
  netgen: {
    url: 'https://github.com/NGSolve/netgen.git',
    tag: 'v6.2.2501',
    commit: 'd1a9f7ee3d85f5999181e8d0fe16d2a37330ce54',
  },
  zlib: {
    url: 'https://github.com/madler/zlib.git',
    tag: 'v1.3.1',
    commit: '51b7f2abdade71cd9bb0e7a373ef2610ec6f9daf',
  },
  image: 'emscripten/emsdk@sha256:af45409f3199d88db4b1b03af0098532c8fb33a375ac257463eeb0a622870d06',
});

/** The current build: file names and SHA-256 of what build.sh writes. */
export const femMesherBuild = Object.freeze({
  js: 'fem-mesher.mjs',
  wasm: 'fem-mesher.wasm',
  jsSha256: '87d3e9add1693c17c97411c5b1ca1f09c8e252af8456239e4dd86d1c39837438',
  wasmSha256: '4cad8e8476e3accd6fd06a5db4748554ebdbcd241b5dca22c3fff843fc7cc415',
});

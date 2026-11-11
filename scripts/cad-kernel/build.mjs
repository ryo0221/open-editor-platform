// The development CAD kernel: the custom OpenCascade.js build made by build.sh (README.md).
// Build it outside Git; scripts/dev/cad-kernel.mjs and the probes refuse a Wasm whose hash differs.
export const cadKernelBuild = {
  /** kernelProfile.id for documents created with this build. */
  id: 'opencascade.js-2.0.0-beta.b5ff984-cad-d1',
  config: 'opencascade.d0-leakcheck.yml',
  image:
    'donalffons/opencascade.js@sha256:3069f4c2e3ab62bb82d81843bad2c0f8552ee92373208f8f655ef9bf71c0524d',
  js: 'opencascade.d0-leakcheck.js',
  wasm: 'opencascade.d0-leakcheck.wasm',
  wasmSha256: '187d0db45ebdd7acd16482effc4067a0647613925acea1016164051b4b7e9186',
  /** The loader's SHA-256, checked by fetch.mjs (the development server checks the Wasm only). */
  jsSha256: '9dbe63d19996ee835b92999d5cadf3ecc2f3d78298c2ce8fb60ce12e8a6f96eb',
};
/**
 * Where built kernels are released (README.md, "Released builds"): one GitHub release per build,
 * tagged `cad-kernel-<first 12 hex digits of wasmSha256>`, made by release.sh, read by fetch.mjs.
 */
export const cadKernelRelease = { repository: 'ryo0221/open-editor-platform' };
/**
 * Earlier development builds (docs/cad/model.md, kernel update). A Host serves one for exact
 * evaluation when CAD_OCCT_RETAINED lists its directory. `substitute: true` approves the
 * current build as a read-only reference display for its documents; `revoked: true` stops it.
 * Entries: { id, js, wasm, wasmSha256, substitute?, revoked? }.
 */
export const cadKernelPrevious = [
  {
    // PMI-5a build (#881, released as cad-kernel-1d04a1e00c99). The CR1c build adds bindings only
    // (TColgp_Array2OfPnt, TColStd_Array2OfReal, TColgp_Array1OfPnt2d, GeomAPI_ExtremaCurveCurve;
    // docs/cad/car-design.md, "CR1の分け方"), so it may show these documents as a reference
    // display until they are migrated.
    id: 'opencascade.js-2.0.0-beta.b5ff984-cad-d1',
    js: 'opencascade.d0-leakcheck.js',
    wasm: 'opencascade.d0-leakcheck.wasm',
    wasmSha256: '1d04a1e00c99c50ed0aaf017cc775c6c9b54e9f6ead3df1a936bde798f8e8679',
    jsSha256: '3a4bea815b8faf4ced4e3df5b039795c6902696fcb279bd17e5a7dcbb44d798b',
    substitute: true,
  },
  {
    // PMI-4b build (#869, released as cad-kernel-4f4b53b3d0b2). The PMI-5a build adds one static
    // OCJS helper only (OCJS.pmiEntityShapes, the assembly paths' entities; docs/cad/pmi.md), so
    // it may show these documents as a reference display until they are migrated.
    id: 'opencascade.js-2.0.0-beta.b5ff984-cad-d1',
    js: 'opencascade.d0-leakcheck.js',
    wasm: 'opencascade.d0-leakcheck.wasm',
    wasmSha256: '4f4b53b3d0b276fb73f6c597e74d69d4a7072ec2a501d39cdffd3eedca614b93',
    jsSha256: '3a4bea815b8faf4ced4e3df5b039795c6902696fcb279bd17e5a7dcbb44d798b',
    substitute: true,
  },
  {
    // PMI-1 build (#837, released as cad-kernel-61599e050b73). The PMI-4b build adds one static
    // OCJS helper only (OCJS.addPmi, the PMI writer; docs/cad/pmi.md), so it may show these
    // documents as a reference display until they are migrated.
    id: 'opencascade.js-2.0.0-beta.b5ff984-cad-d1',
    js: 'opencascade.d0-leakcheck.js',
    wasm: 'opencascade.d0-leakcheck.wasm',
    wasmSha256: '61599e050b735d7924378082672205c8245820e4b5347bbbd468fcc5d6140740',
    jsSha256: '18cde01c7801e9d758d3766c71fdb96a5aa7115242e741b930bf4b5d7be9e7f0',
    substitute: true,
  },
  {
    // R3c build (#828, released as cad-kernel-9737cd1d6919). The PMI-1 build adds static OCJS
    // helpers only (OCJS.pmiJson, OCJS.labelEntry; docs/cad/pmi.md), so it may show these
    // documents as a reference display until they are migrated.
    id: 'opencascade.js-2.0.0-beta.b5ff984-cad-d1',
    js: 'opencascade.d0-leakcheck.js',
    wasm: 'opencascade.d0-leakcheck.wasm',
    wasmSha256: '9737cd1d6919916196fc5a24f5b22f2e1f7914d43190a4fcf9161081c6bc88eb',
    jsSha256: '698f498ac4761deba22878265c405a941198d44a64b7991d8d8813bdf06dde66',
    substitute: true,
  },
  {
    // R2c build (#463, released as cad-kernel-dfa4d5de076c). The R3c build adds one binding
    // (BRepAlgoAPI_Defeaturing; docs/cad/r3-analysis.md) and links in name order (README.md,
    // Reproducing the hash), so it may show these documents as a reference display until they are
    // migrated.
    id: 'opencascade.js-2.0.0-beta.b5ff984-cad-d1',
    js: 'opencascade.d0-leakcheck.js',
    wasm: 'opencascade.d0-leakcheck.wasm',
    wasmSha256: 'dfa4d5de076cbad21c3cbda1df5310dc567d4041ef47d5ef1b2021ab3072ae3d',
    jsSha256: '722be394001770e5f4eb0f566ac980d5b3a9f36298ab150e528935dbb097b17f',
    substitute: true,
  },
  {
    // R2b build (#449). The R2c build adds bindings only (plane sections, half-spaces and
    // polygonal hidden lines; docs/cad/r2c-architecture.md), so it may show these documents as
    // a reference display until they are migrated.
    id: 'opencascade.js-2.0.0-beta.b5ff984-cad-d1',
    js: 'opencascade.d0-leakcheck.js',
    wasm: 'opencascade.d0-leakcheck.wasm',
    wasmSha256: '034dd34a493e4586bcc479824b1a139b4164c4129ac015e5023983bded7f112a',
    substitute: true,
  },
  {
    // R2a build (#439). The R2b build adds bindings only (XDE documents, labels and names,
    // the STEPCAFControl writer and reader, Interface_Static integers, gp_Cylinder;
    // docs/cad/r2b-assembly.md), so it may show these documents as a reference display until
    // they are migrated.
    id: 'opencascade.js-2.0.0-beta.b5ff984-cad-d1',
    js: 'opencascade.d0-leakcheck.js',
    wasm: 'opencascade.d0-leakcheck.wasm',
    wasmSha256: '254002dc88a92e6c1edb881ef78cb83bc0f6bb0a8559105aa70f73c59137a98c',
    substitute: true,
  },
  {
    // R1c build (#425). The R2a build adds bindings only (B-spline curves and surfaces, filling,
    // sewing, splitting, projection, free bounds, surface properties; docs/cad/r2a-freeform.md),
    // so it may show these documents as a reference display until they are migrated.
    id: 'opencascade.js-2.0.0-beta.b5ff984-cad-d1',
    js: 'opencascade.d0-leakcheck.js',
    wasm: 'opencascade.d0-leakcheck.wasm',
    wasmSha256: '2051223fbc2466f770d6659ee9ac188bb8d79c89b9b4cde665c29110d774ad1b',
    substitute: true,
  },
  {
    // R1b build (#422). The R1c build adds one binding (ShapeFix_ShapeTolerance, for the shell's
    // edge tolerance), so it may show these documents as a reference display.
    id: 'opencascade.js-2.0.0-beta.b5ff984-cad-d1',
    js: 'opencascade.d0-leakcheck.js',
    wasm: 'opencascade.d0-leakcheck.wasm',
    wasmSha256: '36267973970e195ebc3b902d8d12dddad7450c24170545bfb49e42f8234a0c5b',
    substitute: true,
  },
  {
    // D2 STEP import build (#397). The R1 build adds bindings only (shape maps and history,
    // edge polygons, detail features, curves, loft and sweep), so it may show these documents as
    // a reference display until they are migrated.
    id: 'opencascade.js-2.0.0-beta.b5ff984-cad-d1',
    js: 'opencascade.d0-leakcheck.js',
    wasm: 'opencascade.d0-leakcheck.wasm',
    wasmSha256: '3329c0ce55f69b14aa3370aebb0322a2cc98c1f373a5ee00259dbea1fd261433',
    substitute: true,
  },
  {
    // R0 STEP export build (#395). The import build adds bindings only (BRepTools, the reader's
    // file units), so it may show these documents as a reference display until they are migrated.
    id: 'opencascade.js-2.0.0-beta.b5ff984-cad-d1',
    js: 'opencascade.d0-leakcheck.js',
    wasm: 'opencascade.d0-leakcheck.wasm',
    wasmSha256: '28a1035f58dcd0adc321f21a04290652167568efdaed199e388fdc37ffe40cb0',
    substitute: true,
  },
  {
    // R0 build without STEP bindings (#371). The STEP build adds bindings only, so it may show
    // these documents as a reference display until they are migrated.
    id: 'opencascade.js-2.0.0-beta.b5ff984-cad-d1',
    js: 'opencascade.d0-leakcheck.js',
    wasm: 'opencascade.d0-leakcheck.wasm',
    wasmSha256: 'abd9d7b52a1c51e13f06f703a2e003899ac793942d104ba4181a3658e615e4b8',
    substitute: true,
  },
];

# Draco decoder used by the optional PLATEAU Host

The Host bundles the glTF Draco decoder already distributed with pinned `three@0.186.1`. It does not fetch executable decoder code from a model URL.

Draco is copyright Google and contributors and licensed under Apache-2.0. [Full upstream license](LICENSE.txt) is copied into every Host build alongside the decoder. This notice does not change the repository license.

Upstream: https://github.com/google/draco / https://github.com/mrdoob/three/tree/dev/examples/jsm/libs/draco

| File in Three distribution   | SHA256                                                             |
| ---------------------------- | ------------------------------------------------------------------ |
| `gltf/draco_wasm_wrapper.js` | `8bb2952d2ba7d67e1414f8df819410cb0434a666be53f671fff75f68843d76f6` |
| `gltf/draco_decoder.wasm`    | `a680d927bed9cb864ddbd63521868891af2bfbe755092761b4837487618df8ac` |

The decoder binary is generated upstream. Keep it out of Git in this repository; the pinned dependency supplies the exact bytes during local build.

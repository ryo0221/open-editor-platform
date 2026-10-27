# Runtime notices for the source Preview

`RUNTIME-NOTICES.txt` retains actual license/notice files from the packages
observed in the playground, its workers, the React preview and the Node Office
export dependency graphs. Package names and versions separate upstream notices;
their copyright statements are not replaced with this project's authorship.
The verification archive records module paths, notice-file hashes and the wider
installed dependency inventory, including tooling and unused packages.

The published source does not contain `node_modules`, generated `dist`, fetched
font files or native decoder binaries. Installed libraries keep their upstream
licenses. This notice supplement does not relicense them under AGPL or certify
every possible downstream binary distribution.

The independent Artifact Host also bundles `typescript@5.9.2` for its declared
TSX compilation path. Its published Apache license and complete
`ThirdPartyNoticeText.txt` are retained. The supplement also records the
`jszip@3.10.1` version observed in the current graph; older version notices remain
as retained attribution rather than being silently removed.

## Material outside a package root license file

- `@pdf-lib/fontkit@1.1.1` publishes an MIT declaration and author/contributor
  information in its README, with no root license file. Its complete published
  README is retained, rather than inventing an upstream copyright statement.
  The distribution embeds helper libraries inside its compiled entry; a
  downstream distributor of generated bundles must review those embedded
  notices as well as the npm module graph.
- `isarray@1.0.0` and `fastdom@1.0.12` include the full MIT grant in their
  published READMEs; those texts are retained.
- `saxes@6.0.0` omits its license from the npm archive. `saxes-ISC.txt` is the
  upstream v6.0.0 license, including the retained sax and historical notice.
- The resvg Wasm package declares MPL-2.0 in its README. The existing full MPL
  text and upstream renderer source references remain applicable; retain
  upstream source access and notices when conveying its compiled renderer.

## Fonts, Rust and test fixtures

The font manifests/provenance and OFL text under the playground's font directory
define the pinned Noto downloads. Extraction does not add temporary work files
to the public assets. Keep the font notices if distributing downloaded fonts.
`rust-wasm.md` retains the Rust standard-library MIT notice for the optional
spatial asset. The original project crate follows the release's root license.
Office interoperability fixtures retain their adjacent CC0/MPL provenance and
MPL license files. Their licenses remain separate from original editor code.

Security dispositions are recorded in `security-dispositions.md`; an unused
dependency is not a claim that the entire installed package is vulnerability-free.

## CAD renderer source dependency

`three@0.186.1` is the CAD Surface renderer dependency. Its complete MIT license
is retained in `RUNTIME-NOTICES.txt`. The type-only `@types/three` dependency graph
also installs development helpers (including Rapier, tween.js and meshoptimizer);
these are not imports of the CAD renderer source. Installed packages retain their
own licenses. OCCT/OpenCascade.js is not an npm dependency or included kernel
binary. The kernel is built separately; its notice, license texts and
corresponding source are described in [cad-kernel](cad-kernel/README.md) and
travel with the kernel files, not with this supplement.

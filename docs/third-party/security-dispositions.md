# Dependency security scope for the source Preview

This record concerns the repository's declared integrations, not every API in
an installed dependency. Raw audit findings remain visible. A later dependency,
Host integration or viewer change requires a new assessment.

Mermaid is pinned to 11.17.2 in the root, Document and Office UI workspaces.
KaTeX is overridden to 0.18.2. These changes address the reported Mermaid and
transitive parser/lodash findings and the KaTeX inherited-option issue. Keep
normal diagram, math and Office rendering regression coverage.

The playground build uses Mermaid's core ESM entry. Its prebundled minified
entry embeds older KaTeX and DOMPurify implementations, so a lockfile override
alone does not patch that emitted code. Verify the actual module graph contains
`katex@0.18.2` and `dompurify@3.4.16`, and exercise a math label through the
ordinary Document editor after any entrypoint change.

## Remaining audit records

| Package / advisory | Repository disposition | Basis and boundary |
| --- | --- | --- |
| `pdfjs-dist@5.6.205` / GHSA-hq66-cqwq-w95j | Not affected through the custom core viewer | The File surface uses `getDocument`, page canvas and `TextLayer`, with `isEvalSupported: false`. It does not load the standard PDF viewer, `PDFScriptingManager`, QuickJS sandbox or a JavaScript-action executor. The upstream trigger requires scripting-enabled viewer integration. A scripted-PDF browser regression must render the page without executing its document action. |
| `image-size@1.2.1` / GHSA-5p2g-fcmc-qvqq, GHSA-w3rx-r6r6-pgpr | Not reachable through the pinned integration | `pptxgenjs@4.0.1` declares this dependency but its ESM/CJS runtime entrypoints do not import or require it. Repository image validation uses its byte-format inspection and isolated native codec, not `image-size`. Emitted main/worker and Node export dependency graphs must confirm its absence. Direct consumer imports of `image-size` are outside this disposition. |
| `pptxgenjs@4.0.1` / transitive `image-size` audit record | Same unreachable dependency disposition | This is a propagated audit record for the same unused parser, not a distinct cleared code path. Recheck if the upstream entrypoint changes. |

The PDF.js patched major line requires Node 22.13+ while this source Preview
retains its Node 20.19+ engine requirement. The absent scripting integration,
not that engine constraint or `isEvalSupported` alone, is the basis of the
PDF disposition. Do not add `enableScripting` as an unsupported core API option.

## References

- [PDF.js upstream advisory](https://github.com/mozilla/pdf.js/security/advisories/GHSA-hq66-cqwq-w95j)
- [KaTeX advisory and patched version](https://github.com/advisories/GHSA-238p-pmpm-9mq7)
- [Image-size advisory metadata / unpublished patch review](https://github.com/github/advisory-database/issues/9028)

These statements do not certify third-party freedom from all vulnerabilities,
patents or license obligations. Browser cases and emitted dependency inventory
are part of the candidate's recorded verification, not presumed completed by
this document.

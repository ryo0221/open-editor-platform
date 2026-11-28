# open-workflow-definitions fixture (446706b)

Test-only copy of [open-workflow-definitions](https://github.com/ryo0221/open-workflow-definitions)
at commit `446706b596999fa7444afee4484e2faa1a07f6f0` (MIT, see `LICENSE`):

- `schema/definition.schema.json` — the format 1 schema
- `src/check.mjs`, `src/check.d.ts` — the definition check (`check.d.mts` is the same declaration, added here so TypeScript reads the `.mjs` import)
- `src/schema-validator.mjs` — the generated (bundled Ajv) schema validator `check.mjs` uses
- `definitions/` — four published definitions, unchanged

`@editor-platform/workflow-definition` does not depend on OWD at run time: Hosts inject `check`
(design U2). The tests pin this copy so that changes in the OWD wording or format are seen as a
deliberate fixture update. To update, copy the same files from a newer commit and change the
directory name and this note.

import { defineKind } from '@editor-platform/artifact-kinds';
import { isCode, type CodeContent } from '../content';

/**
 * The Artifact Host's own TSX source kind (a Host extension). It has no Editor package, so its
 * definition lives with this Host; no other Host lists it.
 */
export const codeKind = defineKind<CodeContent>({
  kind: 'code',
  area: 'office',
  label: 'Code',
  icon: '</>',
  description: 'Edit a TSX source file and preview it in the Host',
  creatable: false,
  create: () => ({
    name: 'React source',
    content: {
      schemaVersion: 1,
      domain: 'host-code',
      fileId: 'main',
      filename: 'Example.tsx',
      source:
        "import React from 'react';\nexport default function Example(){return <h1>Hello from your app</h1>;}",
    },
  }),
  validate: isCode,
});

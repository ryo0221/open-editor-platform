// Which nodes are identified items: the same declaration as the `items@0-draft` add-on of the
// external mindmap-editor, so a Host lists items and links with its own reader
// (`readItems` of @editor-platform/extension-runtime) and its own ID forms. The id is the token at
// the head of a node's text (for example `OP-01 電池の行き先`), the title the rest, and `link.id`
// a link to another item. Side, folding and colour are only how the map looks.
export const mindmapItemsDeclaration = {
  version: 'items@0-draft',
  collections: [
    {
      at: 'nodes',
      id: { field: 'text', from: 'leading-token' },
      refs: ['link.id'],
      layout: ['side', 'collapsed', 'color'],
    },
  ],
} as const;

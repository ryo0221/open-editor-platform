import { useMemo, useRef } from 'react';
import type { SchematicDocument } from '@editor-platform/schematic-core';
import { SchematicController } from './controller';
import type { SchematicSimOverlay } from './simulate-panel';
import { SheetCanvas, useSchematicState } from './surface';

/**
 * SL8: a schematic drawn read only, with values from a calculation that ran elsewhere (the
 * co-simulation) over it. Pan, zoom and selecting work; nothing can be edited.
 */
export function SchematicSheetView({
  doc,
  overlay,
}: {
  doc: SchematicDocument;
  overlay?: SchematicSimOverlay;
}) {
  const controller = useMemo(
    () =>
      new SchematicController({
        session: {
          content: doc,
          execute: () => {
            throw new Error('permission-denied');
          },
        },
        canEdit: () => false,
      }),
    [doc],
  );
  const state = useSchematicState(controller);
  const names = useRef({ label: '', power: '' });
  return (
    <SheetCanvas
      controller={controller}
      state={state}
      tool="select"
      symbol=""
      names={names}
      fitKey={0}
      overlay={overlay}
      onCursor={() => {}}
      onToolDone={() => {}}
    />
  );
}

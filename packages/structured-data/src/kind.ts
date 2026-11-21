import { defineKind } from '@editor-platform/artifact-kinds';
import { createData, type StructuredData } from './model';
import { assertDataReadable } from './session';

function isReadableData(content: unknown): content is StructuredData {
  try {
    assertDataReadable(content);
    return true;
  } catch {
    return false;
  }
}
/** The Structured Data kind (docs/kind-registry-design.md). */
export const dataKind = defineKind<StructuredData>({
  kind: 'data',
  area: 'office',
  label: 'Structured Data',
  icon: '▦',
  description: 'One model, multiple views',
  creatable: true,
  create: (count) => ({ name: `Structured Data ${count}`, content: createData() }),
  validate: isReadableData,
});

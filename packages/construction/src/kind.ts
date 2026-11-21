import { defineKind } from '@editor-platform/artifact-kinds';
import { bimContentHash, type BimDocument } from '@editor-platform/bim-core';
import {
  isConstructionDocument,
  newConstruction,
  type ConstructionDocument,
} from '@editor-platform/construction-core';

/** The saved Building version a new schedule plans (the `create` option). */
export interface ConstructionSource {
  kind: 'construction';
  artifactId: string;
  versionId: string;
  content: BimDocument;
}

const today = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/** A new schedule of the choice: no tasks, starting today, Monday to Saturday worked. */
export function newConstructionSchedule(
  choice: Pick<ConstructionSource, 'artifactId' | 'versionId' | 'content'>,
  name: string,
  startDate = today(),
): { doc: ConstructionDocument; retained: { contentHash: string; content: BimDocument } } {
  const contentHash = bimContentHash(choice.content);
  const doc = newConstruction(
    name,
    { artifactId: choice.artifactId, versionId: choice.versionId, contentHash },
    startDate,
  );
  return { doc, retained: { contentHash, content: structuredClone(choice.content) } };
}

/** The Construction schedule kind. Options: the `ConstructionSource` to plan. */
export const constructionKind = defineKind<ConstructionDocument>({
  kind: 'construction',
  area: 'engineering',
  label: 'Construction schedule',
  icon: '⛏',
  description: 'Plan when each element of a saved building is built, day by day in 3D',
  creatable: true,
  create(count, options) {
    const choice = options as ConstructionSource | undefined;
    if (choice?.kind !== 'construction')
      throw new Error('Choose a saved Building version to schedule');
    const { doc, retained } = newConstructionSchedule(choice, `Construction schedule ${count}`);
    return { name: doc.name, content: doc, extras: { constructionSources: [retained] } };
  },
  validate: isConstructionDocument,
});

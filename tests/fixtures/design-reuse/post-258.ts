import { clone } from '@editor-platform/artifact-core';
import { createDesign, makeDesignVector, type DesignContent } from '@editor-platform/design/model';
import { definitionRef, lockClosure, sealReusableDefinition } from '@editor-platform/reuse-core';
import {
  authorReusableComponent,
  prepareComponentInsertion,
  applyLocalTemplate,
  localTemplateSnapshot,
  sealDefinition,
  previewComponentUpdate,
  retainedComponent,
  reusableParts,
  patchReusablePart,
} from '@editor-platform/templates';
import { checkVector, reuseIdentity as identity } from './content';

export async function vectorUpdateFixture() {
  const source = {
    ...createDesign(),
    elements: [
      {
        ...makeDesignVector(checkVector),
        id: 'icon',
        fill: 'none',
        stroke: '#336699',
        bounds: { x: 0, y: 0, width: 24, height: 24 },
      },
    ],
  };
  const value = await authorReusableComponent({
    domain: 'design',
    content: source,
    ids: [],
    name: 'Vector',
  });
  const empty = createDesign();
  const current = applyLocalTemplate(
    await prepareComponentInsertion({
      state: localTemplateSnapshot('artifact', 'design', empty),
      identity,
      ...value,
      reuse: 'linked',
      requestId: 'vector',
    }),
    empty,
  ) as DesignContent;
  const revised = clone(value.definition);
  revised.version++;
  const native = revised.payload.template.content as DesignContent;
  const part = revised.payload.contract.parts.find(
    (p) => reusableParts(native).get(p.nativeId)?.vector,
  )!;
  const vector = {
    ...checkVector,
    paths: ['M0 0L12 12'],
    viewBox: { x: 0, y: 0, width: 12, height: 12 },
    provenance: { ...checkVector.provenance, name: 'Updated', version: '2' },
  };
  patchReusablePart(native, part.nativeId, { vector });
  revised.payload.template = await sealDefinition(revised.payload.template);
  const definition = await sealReusableDefinition(revised);
  const closure = await lockClosure<unknown>([definitionRef(definition)], [definition]);
  const address = retainedComponent(current, 'reuse_vector').instance.parts[part.id];
  const preview = (content = current) =>
    previewComponentUpdate({
      state: localTemplateSnapshot('artifact', 'design', content),
      identity,
      definition,
      closure,
      selections: [{ instanceId: 'reuse_vector', choice: 'adopt' }],
    });
  return { current, vector, address, preview, definition, part, identity, closure };
}

import { clone } from '@editor-platform/artifact-core';
import { createDeck, makeSlideObject } from '@editor-platform/slide/model';
import { createWhiteboard, makeWhiteboardNode } from '@editor-platform/whiteboard/model';
import { definitionRef, lockClosure, sealReusableDefinition } from '@editor-platform/reuse-core';
import {
  authorReusableComponent,
  prepareComponentInsertion,
  applyLocalTemplate,
  localTemplateSnapshot,
  reusableParts,
  patchReusablePart,
  sealDefinition,
  previewComponentUpdate,
  templateCodec,
  validateNativeReusableDefinitions,
} from '@editor-platform/templates';
import { reuseIdentity as identity } from './content';

/** Opaque imported data: only Design may interpret this field as vector geometry. */
export const foreignVector = {
  paths: ['M0 0L1 1'],
  viewBox: { x: 0, y: 0, width: 1, height: 1 },
  provenance: { source: 'foreign-data', name: 'Preserve', version: '1', license: 'unknown' },
  opaque: { marker: 'native-only', values: [1, '二', null] },
};

export async function foreignVectorUpdateFixture(
  domain: 'slide' | 'whiteboard',
  change: 'change' | 'delete',
) {
  const source = domain === 'slide' ? createDeck() : createWhiteboard();
  if ('slides' in source)
    source.slides[0].objects = [
      { ...makeSlideObject('shape', 0), id: 'shape', shape: 'rectangle', text: '' },
    ];
  else source.nodes = [{ ...makeWhiteboardNode('rectangle', 0), id: 'shape', text: '' }];
  patchReusablePart(source, 'shape', { stroke: '#112233' });
  const authored = await authorReusableComponent({
    domain,
    content: source,
    ids: ['shape'],
    name: 'Opaque vector metadata',
    ...(domain === 'slide' ? { slide: 'objects' as const } : {}),
  });
  const empty = domain === 'slide' ? createDeck() : createWhiteboard();
  const inserted = applyLocalTemplate(
    await prepareComponentInsertion({
      state: localTemplateSnapshot('artifact', domain, empty),
      identity,
      ...authored,
      reuse: 'linked',
      requestId: 'foreign',
      ...(domain === 'slide'
        ? {
            target: {
              slidePageId: 'slides' in empty ? empty.slides[0].id : '',
            },
          }
        : {}),
    }),
    empty,
  );
  // Imported artifacts may retain opaque fields that ordinary insertion commands cannot add.
  // Build that validated native-load fixture without widening the insertion field allowlist.
  const baselineDraft = clone(authored.definition);
  const part = baselineDraft.payload.contract.parts.find(
    (p) => reusableParts(baselineDraft.payload.template.content!).get(p.nativeId)?.id === 'shape',
  )!;
  patchReusablePart(baselineDraft.payload.template.content!, part.nativeId, {
    vector: foreignVector,
  });
  baselineDraft.payload.template = await sealDefinition(baselineDraft.payload.template);
  const baseline = await sealReusableDefinition(baselineDraft);
  const baselineClosure = await lockClosure<unknown>([definitionRef(baseline)], [baseline]);
  const current = clone(inserted);
  if (!('reuse' in current) || !current.reuse) throw Error('Missing imported linked state');
  const instance = current.reuse.instances.find((item) => item.id === 'reuse_foreign')!;
  instance.ref = definitionRef(baseline);
  instance.closureHash = baselineClosure.hash;
  current.reuse.closures = [baselineClosure];
  const address = instance.parts[part.id];
  patchReusablePart(current, address, { vector: foreignVector });
  const definitionDraft = clone(baseline);
  definitionDraft.version++;
  const incomingVector = {
    ...foreignVector,
    paths: ['M2 2L3 3'],
    opaque: { marker: 'incoming', values: [3, '四', null] },
  };
  patchReusablePart(definitionDraft.payload.template.content!, part.nativeId, {
    vector: change === 'change' ? incomingVector : undefined,
    stroke: '#445566',
  });
  definitionDraft.payload.template = await sealDefinition(definitionDraft.payload.template);
  const definition = await sealReusableDefinition(definitionDraft);
  const closure = await lockClosure<unknown>([definitionRef(definition)], [definition]);
  if (!templateCodec(domain).validate(current)) throw Error('Invalid imported fixture');
  await validateNativeReusableDefinitions(domain, current);
  const preview = await previewComponentUpdate({
    state: localTemplateSnapshot('artifact', domain, current),
    identity,
    definition,
    closure,
    selections: [{ instanceId: 'reuse_foreign', choice: 'adopt' }],
  });
  return { domain, identity, current, definition, closure, address, preview, incomingVector };
}

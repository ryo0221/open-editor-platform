import { clone } from '@editor-platform/artifact-core';
import type { DocumentContent } from '@editor-platform/document/model';
import { definitionRef, lockClosure, sealReusableDefinition } from '@editor-platform/reuse-core';
import {
  authorReusableComponent,
  applyLocalTemplate,
  localTemplateSnapshot,
  prepareComponentInsertion,
  sealDefinition,
} from '@editor-platform/templates';

/** R14: matching hashes are necessary, but do not make an unsupported recipe valid. */
export async function nativeLoadFixture() {
  const content: DocumentContent = {
    schemaVersion: 2,
    blocks: [{ id: 'body', type: 'paragraph', text: '元の本文' }],
  };
  const source = await authorReusableComponent({
    domain: 'document',
    content,
    ids: [],
    name: '取り込み用の部品',
  });
  const valid = applyLocalTemplate(
    await prepareComponentInsertion({
      ...source,
      identity: { actorId: 'A', clientId: 'a', sessionId: 'a' },
      state: localTemplateSnapshot('artifact', 'document', content),
      reuse: 'linked',
      requestId: 'load',
    }),
    content,
  ) as DocumentContent;
  // Actual edited native text remains authoritative; importing must not rematerialize it.
  valid.blocks[1].text = '採用後に編集した案件本文';
  valid.blocks[1].rich = [{ text: valid.blocks[1].text }];
  const invalid = clone(valid),
    payload = clone(source.definition.payload);
  (payload.template.content as DocumentContent).schemaVersion = 99 as 2;
  payload.template = await sealDefinition(payload.template);
  const definition = await sealReusableDefinition({ ...source.definition, payload });
  const closure = await lockClosure([definitionRef(definition)], [definition]);
  invalid.reuse!.closures = [closure];
  invalid.reuse!.instances[0].ref = definitionRef(definition);
  invalid.reuse!.instances[0].closureHash = closure.hash;
  return { valid, invalid };
}

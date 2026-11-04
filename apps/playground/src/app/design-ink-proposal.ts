import { canonicalJson, clone, newId } from '@editor-platform/artifact-core';
import {
  sameLocalRevision,
  transaction,
  type EditorCommand,
  type LocalDraftRevision,
  type ProposedCommands,
} from '@editor-platform/editor-core';
import {
  insertDesignPath,
  replaceDesignPath,
  updateElement,
  editableDesignRaster,
  replaceDesignRaster,
  type RasterRegion,
  type DesignContent,
} from '@editor-platform/design/model';
import { compositeDesignRasterRegion } from '@editor-platform/design/raster-canvas';

export interface InkContext {
  artifactId: string;
  revision: LocalDraftRevision;
  content: DesignContent;
  selectedIds: string[];
  rasterSelection?: { elementId: string; src: string; region: RasterRegion };
}

const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const preparedCommands = new WeakSet<object>();
/** Local Host capability, never a caller-supplied string/property. */
export const isPreparedInkCommand = (command: object) => preparedCommands.has(command);

/** Data-only Host boundary. Native commands own geometry/style/permission validation. */
export function prepareInkProposal(
  current: InkContext,
  input: unknown,
  writable: () => boolean,
): ProposedCommands<DesignContent> {
  if (!writable()) throw Error('この原稿は編集できません。');
  if (
    !object(input) ||
    !text(input.id, 120) ||
    !text(input.summary, 400) ||
    input.artifactId !== current.artifactId ||
    !object(input.baseRevision) ||
    input.baseRevision.kind !== 'local-draft' ||
    typeof input.baseRevision.sessionId !== 'string' ||
    !Number.isSafeInteger(input.baseRevision.sequence) ||
    !sameLocalRevision(input.baseRevision as unknown as LocalDraftRevision, current.revision)
  )
    throw Error('提案の対象または元の原稿が変わりました。作画データを取得し直してください。');
  if (!Array.isArray(input.operations) || !input.operations.length || input.operations.length > 32)
    throw Error('作画提案には1〜32件の操作を指定してください。');
  const commands: EditorCommand<DesignContent>[] = [];
  let working = current.content;
  for (const raw of input.operations) {
    if (!object(raw)) throw Error('不正な作画操作です。');
    let command: EditorCommand<DesignContent>;
    if (raw.type === 'replace' && text(raw.id, 200)) {
      command = replaceDesignPath(
        working,
        raw.id,
        raw.path as Parameters<typeof replaceDesignPath>[2],
        writable,
      );
    } else if (raw.type === 'add' && text(raw.name, 160)) {
      if (raw.parentId !== undefined && !text(raw.parentId, 200))
        throw Error('描線を追加するレイヤーが不正です。');
      const insert = insertDesignPath(
        raw.path as Parameters<typeof insertDesignPath>[0],
        clone(raw.bounds as Parameters<typeof insertDesignPath>[1]),
        raw.parentId as string | undefined,
        writable,
      );
      command = transaction('描線を追加', [
        insert,
        updateElement(insert.elementId, {
          name: raw.name,
          fill: (raw.fill ?? 'none') as string,
          stroke: (raw.stroke ?? '#181818') as string,
          strokeWidth: (raw.strokeWidth ?? 2.5) as number,
        }),
      ]);
    } else throw Error('未対応の作画操作です。');
    working = command.apply(working);
    commands.push(command);
  }
  return preparedProposal(current, input.id, input.summary, commands);
}

function preparedProposal(
  current: InkContext,
  id: string,
  summary: string,
  commands: EditorCommand<DesignContent>[],
): ProposedCommands<DesignContent> {
  const commit = Object.freeze(
    transaction(summary, commands, {
      origin: 'proposal',
      transactionId: newId('transaction'),
      proposalId: id,
    }),
  );
  preparedCommands.add(commit);
  return {
    id,
    summary,
    source: 'Playgroundに読み込んだ作画提案',
    baseLocalRevision: clone(current.revision),
    commands: [commit],
  };
}

/** Decode a candidate outside the document, then propose only the explicitly selected pixels. */
export async function prepareRasterInkProposal(
  current: InkContext,
  input: unknown,
  writable: () => boolean,
): Promise<ProposedCommands<DesignContent>> {
  if (!writable()) throw Error('この原稿は編集できません。');
  if (
    !object(input) ||
    !text(input.id, 120) ||
    !text(input.summary, 400) ||
    input.artifactId !== current.artifactId ||
    !object(input.baseRevision) ||
    !sameLocalRevision(input.baseRevision as unknown as LocalDraftRevision, current.revision)
  )
    throw Error('提案の対象または元の原稿が変わりました。');
  if (!Array.isArray(input.operations) || input.operations.length !== 1)
    throw Error('画像修正は一つの選択範囲ずつ確認してください。');
  const op = input.operations[0],
    selected = current.rasterSelection;
  if (
    !object(op) ||
    op.type !== 'raster-region' ||
    !selected ||
    op.id !== selected.elementId ||
    !object(op.region) ||
    canonicalJson(op.region) !== canonicalJson(selected.region)
  )
    throw Error('Editorで選んだ画像と範囲を指定してください。');
  const target = editableDesignRaster(current.content, selected.elementId);
  if (target.src !== selected.src || typeof op.src !== 'string')
    throw Error('画像が変わりました。範囲を選び直してください。');
  const src = await compositeDesignRasterRegion(target.src!, op.src, selected.region);
  if (!writable()) throw Error('この原稿は編集できません。');
  const change = replaceDesignRaster(current.content, target.id, src, 'ai-region', writable);
  change.apply(current.content);
  return preparedProposal(current, input.id, input.summary, [change]);
}

/** Avoid containers whose hidden/locked descendants the ordinary native guard rejects. */
export function inkLayers(content: DesignContent) {
  const byId = new Map(content.elements.map((e) => [e.id, e]));
  const visible = (id: string) => {
    let element = byId.get(id);
    while (element) {
      if (element.hidden || element.locked) return false;
      element = byId.get(element.parentId ?? '');
    }
    return true;
  };
  return content.elements.filter(
    (e) =>
      (e.type === 'frame' || e.type === 'group') &&
      visible(e.id) &&
      content.elements.every((child) => {
        let parent = child;
        while (parent.parentId) {
          if (parent.parentId === e.id) return visible(child.id);
          parent = byId.get(parent.parentId)!;
        }
        return true;
      }),
  );
}

import {
  clone,
  commitVersion,
  createArtifact,
  type Artifact,
} from '@editor-platform/artifact-core';
import { createDocument } from '@editor-platform/document/model';
import { createDesign, insertElement, updateElement } from '@editor-platform/design/model';
import { insertDesignPage, insertDesignPanel } from '@editor-platform/design/pagination';
import { CreativeProject } from '../project';
import { characterMode } from '../character-mode';
import { settingMode } from '../setting-mode';
import {
  CreativeWorkspace,
  type CreativeWorkspaceStorage,
  type CreativeWorkspaceLinks,
} from './model';

/** Explicit, repeatable local fixture creation. No replacement of an existing source. */
export async function createHarborWorkspace(io: CreativeWorkspaceStorage, mayEdit = () => true) {
  if (await io.readLinks()) return CreativeWorkspace.open(io, mayEdit);
  if (!mayEdit()) throw Error('制作例の作成には編集権限が必要です。');
  async function retain(a: Artifact<unknown>) {
    const existing = await io.artifacts.get(a.id);
    if (existing) return existing;
    if (!mayEdit()) throw Error('作成権限が変わりました。');
    const committed = await commitVersion(a, null, 'Create harbor fixture');
    return io.artifacts.putIfAbsent
      ? io.artifacts.putIfAbsent(committed)
      : (await io.artifacts.put(committed), committed);
  }
  const charId = 'd3a:characters',
    settingId = 'd3a:world-notes';
  await retain({ ...createArtifact('data', '港町の人物表', characterMode.seed()), id: charId });
  const locations = settingMode.seed();
  const city = settingMode
    .create(locations, '潮見の街', '灯台と港を中心に暮らす、小さな港町。')
    .apply(locations);
  await retain({ ...createArtifact('document', '世界の覚え書き', city), id: settingId });
  const characters = await CreativeProject.open(
    characterMode,
    io.creative('character'),
    mayEdit,
    charId,
  );
  const settings = await CreativeProject.open(
    settingMode,
    io.creative('setting'),
    mayEdit,
    settingId,
  );
  for (const p of [characters, settings]) {
    for (const card of p.cards) await p.ensureDesign(card);
    if (p.mappingDirty) await p.save();
  }
  const novel = createDocument();
  novel.blocks = [
    { id: 'scene-port', type: 'heading', level: 2, text: '港の坂道' },
    {
      id: 'port-text',
      type: 'paragraph',
      text: '美緒は潮見の街を歩き、灯台守の手紙を握りしめた。',
    },
    { id: 'scene-house', type: 'heading', level: 2, text: '風見の家' },
    { id: 'house-text', type: 'paragraph', text: '風見の家で、美緒は灯台守と窓の外の港を眺めた。' },
  ];
  const n = await retain({ ...createArtifact('document', '灯台守の手紙', novel), id: 'd3a:novel' });
  let comic = insertDesignPage({ x: 0, y: 0, width: 600, height: 800 }, 'page-port').apply(
    createDesign(),
  );
  comic = insertDesignPanel(
    'page-port',
    { x: 20, y: 20, width: 560, height: 750 },
    'panel-port',
  ).apply(comic);
  comic = insertElement('text', {
    id: 'comic-dialogue',
    parentId: 'panel-port',
    bounds: { x: 50, y: 60, width: 480, height: 90 },
  }).apply(comic);
  comic = updateElement('comic-dialogue', {
    text: '美緒「灯台守さん、あの街に帰ろう」',
    fill: '#32303b',
  }).apply(comic);
  const c = await retain({ ...createArtifact('design', '港町の漫画', comic), id: 'd3a:comic' });
  const partial = new CreativeWorkspace(
    io,
    { schemaVersion: 1, scenes: [] },
    characters,
    settings,
    mayEdit,
  );
  const heroine = await partial.currentItem('character', 'CH-01'),
    keeper = await partial.currentItem('character', 'CH-02');
  const house = await partial.currentItem('setting', 'LO-01'),
    town = await partial.currentItem('setting', 'LO-02');
  const world = createDocument();
  world.blocks = [
    {
      id: 'world-facts',
      type: 'paragraph',
      text: '潮見の街の灯台と港。人物の年齢・家族と場所の同一性は画風で変更しない。',
    },
    { id: 'scene-state', type: 'paragraph', text: 'SC-01は夕方。雨に濡れた髪は場面だけの状態。' },
    { id: 'instructions', type: 'paragraph', text: '今回の編集は指定した部位だけ。' },
    {
      id: 'exception',
      type: 'paragraph',
      text: '作者の例外：回想では祭りの衣装。理由：過去の場面のため。',
    },
  ];
  const fact = await retain({
    ...createArtifact('document', '港町の作品設定', world),
    id: 'cw1:harbor:facts',
  });
  const guides = [];
  for (const [key, name, description] of [
    ['anime', '柔らかいアニメ調', '柔らかな輪郭、明るい色と控えめな陰影。'],
    ['gekiga', '1980年代劇画調', '強弱のある線、密度の高い陰影。'],
  ]) {
    const content = createDocument();
    content.blocks = [{ id: 'guide', type: 'paragraph', text: name + '：' + description }];
    guides.push(
      await retain({ ...createArtifact('document', name, content), id: `cw1:harbor:guide:${key}` }),
    );
  }
  let samples = createDesign();
  for (const [id, x] of [
    ['sample-anime', 0],
    ['sample-gekiga', 340],
  ] as const) {
    samples = insertElement('frame', { id, bounds: { x, y: 0, width: 300, height: 240 } }).apply(
      samples,
    );
    samples = insertElement('text', {
      id: `${id}-title`,
      parentId: id,
      bounds: { x: x + 20, y: 40, width: 250, height: 60 },
    }).apply(samples);
    samples = updateElement(`${id}-title`, {
      text: id === 'sample-anime' ? '柔らかいアニメ調' : '1980年代劇画調',
    }).apply(samples);
  }
  const sampleArtifact = await retain({
    ...createArtifact('design', '画作りの見本Frame（固定資料）', samples),
    id: 'cw1:harbor:samples',
  });
  const ref = (
    a: Artifact<unknown>,
    id: string,
    role: import('./world-context').WorldRole,
    blockId: string,
  ) => ({
    id,
    role,
    namespace: 'harbor',
    artifactId: a.id,
    versionId: a.draft.baseVersionId!,
    contentHash: a.versions.find((v) => v.versionId === a.draft.baseVersionId)!.contentHash,
    selector: { type: 'document-blocks' as const, blockIds: [blockId] },
    required: true,
  });
  const links: CreativeWorkspaceLinks = {
    schemaVersion: 1,
    world: {
      namespace: 'harbor',
      contexts: [
        {
          id: 'work',
          revision: 0,
          references: [
            ref(fact, 'facts', 'facts', 'world-facts'),
            ...guides.map((a, i) => ref(a, `style-${i}`, 'style', 'guide')),
            ...['sample-anime', 'sample-gekiga'].map((id) => ({
              id,
              role: 'sample' as const,
              namespace: 'harbor',
              artifactId: sampleArtifact.id,
              versionId: sampleArtifact.draft.baseVersionId!,
              contentHash: sampleArtifact.versions[0].contentHash,
              required: false,
              selector: { type: 'design-frame' as const, frameId: id },
            })),
          ],
        },
        {
          id: 'SC-01',
          revision: 0,
          references: [
            ref(fact, 'state', 'scene-state', 'scene-state'),
            ref(fact, 'instructions', 'instructions', 'instructions'),
            ref(fact, 'exception', 'exception', 'exception'),
          ],
        },
        { id: 'SC-02', revision: 0, references: [] },
        { id: 'SC-03', revision: 0, references: [] },
      ],
    },
    scenes: [
      {
        id: 'SC-01',
        kind: 'document',
        origin: { artifactId: n.id, versionId: n.draft.baseVersionId!, elementId: 'scene-port' },
        members: ['port-text'],
        items: [heroine, keeper, town],
      },
      {
        id: 'SC-02',
        kind: 'document',
        origin: { artifactId: n.id, versionId: n.draft.baseVersionId!, elementId: 'scene-house' },
        members: ['house-text'],
        items: [clone(heroine), clone(keeper), house, town],
      },
      {
        id: 'SC-03',
        kind: 'design',
        origin: { artifactId: c.id, versionId: c.draft.baseVersionId!, elementId: 'page-port' },
        members: ['panel-port', 'comic-dialogue'],
        items: [clone(heroine), clone(keeper), clone(house), clone(town)],
      },
    ],
  };
  if (!mayEdit()) throw Error('作成権限が変わりました。');
  await io.writeLinks(links);
  return CreativeWorkspace.open(io, mayEdit);
}

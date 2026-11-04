import {
  clone,
  createArtifact,
  commitVersion,
  newId,
  type Artifact,
} from '@editor-platform/artifact-core';
import { type EditorCommand, type LocalDraftRevision } from '@editor-platform/editor-core';
import {
  createDesign,
  designPngInfo,
  insertElement,
  updateElement,
  assertDesignContent,
  type DesignContent,
} from '@editor-platform/design/model';
import {
  insertDesignPage,
  insertDesignPanel,
  setDesignPagination,
} from '@editor-platform/design/pagination';
import { insertDesignSpeechBalloon } from '@editor-platform/design/page-artwork';

export const artLayers = Object.freeze([
  {
    id: 'sky',
    group: 'background',
    name: '空・雲',
    description: '空、雲、遠い山。人物・建物・地面は描かない。',
  },
  {
    id: 'buildings',
    group: 'background',
    name: '建物',
    description: '駅舎、屋根、柱、樹木。空・地面・人物は透過。',
  },
  {
    id: 'ground',
    group: 'background',
    name: '地面・線路',
    description: 'ホーム、地面、線路。建物・空・人物は透過。',
  },
  {
    id: 'skin',
    group: 'character',
    name: '輪郭・肌',
    description: '顔・耳・首・手の輪郭と白地。目鼻口、髪、服、背景は描かない。',
  },
  {
    id: 'shirt',
    group: 'character',
    name: 'シャツ',
    description: 'シャツだけ。人物の肌・髪・上着・背景は透過。',
  },
  {
    id: 'jacket',
    group: 'character',
    name: '上着・持ち物',
    description: '上着、鞄、服飾だけ。肌・髪・シャツ・背景は透過。',
  },
  {
    id: 'expression',
    group: 'character',
    name: '目鼻・表情',
    description: '目、眉、鼻、口の線だけ。肌の白地・輪郭・髪・服・背景は透過。',
  },
  {
    id: 'hair',
    group: 'character',
    name: '髪型',
    description: '髪の形・黒ベタ・ハイライトだけ。顔・服・背景は透過。',
  },
] as const);
export interface ArtSubject {
  id: string;
  name: string;
  kind: 'human' | 'animal';
}
export function subjectLayers(subjects: ArtSubject[]) {
  if (
    !subjects.length ||
    subjects.length > 5 ||
    new Set(subjects.map((s) => s.id)).size !== subjects.length ||
    subjects.some(
      (s) =>
        !/^[a-z][a-z0-9-]{0,39}$/.test(s.id) ||
        !s.name.trim() ||
        s.name.length > 40 ||
        !['human', 'animal'].includes(s.kind),
    )
  )
    throw Error('人物・動物は重複しないIDと名前で1〜5名を指定してください。');
  return [
    {
      ...artLayers[0],
      name: '空・窓外',
      description: '空と窓外の景色だけ。人物・建物・家具は透過。',
    },
    {
      ...artLayers[1],
      name: '建物・室内',
      description: '建物、室内の壁、窓、黒板など。人物・家具・小道具は透過。',
    },
    {
      ...artLayers[2],
      name: '家具・小道具・床',
      description: '机、椅子、教壇、小道具、床など。人物・建物は透過。',
    },
    ...subjects.flatMap((s) =>
      (s.kind === 'human'
        ? [
            ['skin', '輪郭・肌'],
            ['hair', '髪'],
            ['clothes', '衣服'],
            ['details', '表情・手・修正部品'],
          ]
        : [
            ['outline', '毛並み・輪郭'],
            ['details', '顔・足'],
            ['clothes', '衣服・首輪'],
          ]
      ).map(([part, name]) => ({
        id: `${s.id}-${part}`,
        group: `subject-${s.id}`,
        name,
        description: `${s.name}の${name}だけ。他の人物・動物・背景は透過。`,
      })),
    ),
    {
      id: 'effects-lines',
      group: 'effects',
      name: '効果線・効果音',
      description: '効果線と描き文字だけ。背景・人物・台詞は透過。',
    },
  ];
}
export function requestLayers(request: LayeredArtRequest) {
  const expected = request.schemaVersion === 2 ? subjectLayers(request.subjects ?? []) : artLayers;
  if (
    ![1, 2].includes(request.schemaVersion) ||
    JSON.stringify(request.layers) !== JSON.stringify(expected)
  )
    throw Error('依頼のレイヤー構成が不正です。');
  return expected;
}
export interface LayeredArtRequest {
  schemaVersion: 1 | 2;
  subjects?: ArtSubject[];
  id: string;
  artifactId: string;
  baseRevision: LocalDraftRevision;
  title: string;
  instructions: string;
  dialogue: string;
  referencePng: string;
  width: number;
  height: number;
  layers: { id: string; group: string; name: string; description: string }[];
}
export interface LayeredArtResult {
  requestId: string;
  layers: { id: string; src: string; source: string }[];
}
const obj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v.trim().length > 0 && v.length <= max;
export function makeLayeredArtRequest(input: {
  artifactId: string;
  revision: LocalDraftRevision;
  title: string;
  instructions: string;
  referencePng: string;
  dialogue?: string;
  subjects?: ArtSubject[];
}): LayeredArtRequest {
  if (!text(input.title, 160) || !text(input.instructions, 4000))
    throw Error('作品名と4000文字以内の作画指示を入力してください。');
  if (
    input.dialogue !== undefined &&
    (typeof input.dialogue !== 'string' || input.dialogue.length > 300)
  )
    throw Error('台詞は300文字までです。');
  const image = designPngInfo(input.referencePng);
  if (image.width > 800 || image.height > 1000) throw Error('試作は最大800×1000pxです。');
  return clone({
    schemaVersion: input.subjects ? 2 : 1,
    ...(input.subjects ? { subjects: input.subjects } : {}),
    id: newId('layered-art'),
    artifactId: input.artifactId,
    baseRevision: input.revision,
    title: input.title,
    instructions: input.instructions,
    dialogue: input.dialogue ?? '',
    referencePng: input.referencePng,
    width: image.width,
    height: image.height,
    layers: (input.subjects ? subjectLayers(input.subjects) : artLayers).map((l) => ({ ...l })),
  });
}
/** The model owns real separate PNGs, normal groups, attribution and a hidden rough. */
export function layeredArtContent(request: LayeredArtRequest, raw: unknown): DesignContent {
  const plans = requestLayers(request);
  if (
    !obj(raw) ||
    raw.requestId !== request.id ||
    !Array.isArray(raw.layers) ||
    raw.layers.length !== plans.length
  )
    throw Error('生成依頼とレイヤーを対応させてください。');
  const results = new Map<string, { src: string; source: string }>(),
    seen = new Set<string>();
  let bytes = designPngInfo(request.referencePng).bytes;
  for (const layer of raw.layers) {
    if (
      !obj(layer) ||
      !text(layer.id, 80) ||
      !text(layer.source, 400) ||
      typeof layer.src !== 'string' ||
      !plans.some((p) => p.id === layer.id) ||
      results.has(layer.id) ||
      seen.has(layer.src)
    )
      throw Error('レイヤーの不足・重複・出典を確認してください。');
    const png = designPngInfo(layer.src);
    if (png.width !== request.width || png.height !== request.height)
      throw Error('全レイヤーをラフと同じ画素サイズにしてください。');
    bytes += png.bytes;
    seen.add(layer.src);
    results.set(layer.id, { src: layer.src, source: layer.source });
  }
  if (bytes > 5_500_000) throw Error('ラフとレイヤーのPNG合計は5.5 MBまでです。');
  let content = createDesign();
  const apply = (c: EditorCommand<DesignContent>) => {
    content = c.apply(content);
  };
  const bounds = { x: 0, y: 0, width: request.width, height: request.height };
  apply(insertDesignPage(bounds, 'art-page'));
  apply(
    updateElement('art-page', {
      name: request.title,
      fill: '#ffffff',
      strokeWidth: 0,
      clipContent: true,
    }),
  );
  apply(insertDesignPanel('art-page', bounds, 'art-panel'));
  apply(
    updateElement('art-panel', {
      name: 'レイヤー作画',
      fill: 'none',
      strokeWidth: 0,
      clipContent: true,
    }),
  );
  const groups =
    request.schemaVersion === 2
      ? [
          ['background', '背景'],
          ...request.subjects!.map((s) => [`subject-${s.id}`, s.name]),
          ['effects', '効果線・効果音'],
          ['reference', 'ネーム・ラフ（資料）'],
        ]
      : [
          ['background', '背景'],
          ['character', '人物'],
          ['reference', 'ネーム・ラフ（資料）'],
        ];
  for (const [id, name] of groups) {
    apply(
      insertElement('group', {
        id: 'art-' + id,
        parentId: id === 'reference' ? 'art-page' : 'art-panel',
        bounds,
      }),
    );
    apply(
      updateElement('art-' + id, {
        name,
        fill: 'none',
        strokeWidth: 0,
      }),
    );
  }
  for (const plan of plans) {
    const layer = results.get(plan.id)!;
    apply(insertElement('image', { id: 'art-' + plan.id, parentId: 'art-' + plan.group, bounds }));
    apply(updateElement('art-' + plan.id, { name: plan.name, src: layer.src, strokeWidth: 0 }));
  }
  apply(insertElement('image', { id: 'art-rough', parentId: 'art-reference', bounds }));
  apply(
    updateElement('art-rough', {
      name: '入力したネーム・ラフ',
      src: request.referencePng,
      strokeWidth: 0,
    }),
  );
  apply(insertElement('text', { id: 'art-instructions', parentId: 'art-reference', bounds }));
  apply(updateElement('art-instructions', { name: '人の作画指示', text: request.instructions }));
  if (request.dialogue.trim()) {
    const bubble = insertDesignSpeechBalloon(
      'art-panel',
      {
        x: request.width * 0.65,
        y: request.height * 0.035,
        width: request.width * 0.31,
        height: request.height * 0.18,
      },
      request.dialogue,
    );
    apply(bubble);
    apply(updateElement(bubble.elementId, { name: '台詞・吹き出し（文字とパス）' }));
    apply(
      updateElement(bubble.textId, {
        typography: {
          fontSize: Math.max(12, request.width * 0.025),
          fontFamily: 'Noto Sans CJK JP',
        },
      }),
    );
  }
  apply(updateElement('art-reference', { hidden: true }));
  apply(
    setDesignPagination({
      ...content.pagination!,
      images: [
        ...plans.map((plan) => ({
          elementId: 'art-' + plan.id,
          source: results.get(plan.id)!.source,
          license: 'AI-generated; provider terms apply',
        })),
        {
          elementId: 'art-rough',
          source: 'User supplied rough / ' + request.title,
          license: 'User supplied reference',
        },
      ],
    }),
  );
  assertDesignContent(content);
  return content;
}
export async function layeredArtArtifact(
  request: LayeredArtRequest,
  raw: unknown,
): Promise<Artifact<DesignContent>> {
  const content = layeredArtContent(request, raw),
    artifact = await commitVersion(
      createArtifact('design', request.title, content),
      null,
      'ネームと作画指示からレイヤーを生成',
    );
  if (new TextEncoder().encode(JSON.stringify(artifact)).length > 16_000_000)
    throw Error('原稿JSONが16 MBを超えます。画像を小さくして生成し直してください。');
  return artifact;
}

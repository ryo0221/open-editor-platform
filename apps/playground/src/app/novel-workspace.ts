import {
  canonicalJson,
  commitVersion,
  createArtifact,
  createArtifactIfAbsent,
} from '@editor-platform/artifact-core';
import { contentToNode, nodeToContent } from '@editor-platform/document/engine';
import type { NotationRule } from '@editor-platform/document/manuscript';
import type { DocumentBlock, DocumentContent, InlineSpan } from '@editor-platform/document/model';
import type { StoredArtifact } from '../model';
import { storage } from './records';

/** The demo's notation dictionary. Real dictionaries belong to the consuming Host. */
export const novelNotationRules: NotationRule[] = [
  { id: 'dekiru', preferred: 'できる', avoid: ['出来る'] },
  { id: 'wakaru', preferred: 'わかる', avoid: ['分かる', '解る'] },
  { id: 'futo', preferred: 'ふと', avoid: ['不図'] },
];

type Run = string | InlineSpan;
const ruby = (base: string, text: string): InlineSpan => ({ text: base, ruby: { text, base } });
const dots = (text: string): InlineSpan => ({ text, emphasisDots: true });
function block(id: string, type: 'heading' | 'paragraph', runs: Run[], level?: number) {
  const rich = runs.map((r) => (typeof r === 'string' ? { text: r } : r));
  const value: DocumentBlock = { id, type, text: rich.map((r) => r.text).join(''), rich };
  return level ? { ...value, level } : value;
}
const h1 = (id: string, ...runs: Run[]) => block(id, 'heading', runs, 1);
const h2 = (id: string, ...runs: Run[]) => block(id, 'heading', runs, 2);
const p = (id: string, ...runs: Run[]) => block(id, 'paragraph', runs);

/** An original sample: three chapters that touch ruby, 傍点, 縦中横, notation and 通読. */
const chapters: { name: string; blocks: DocumentBlock[] }[] = [
  {
    name: '灯台守の手紙　第一章',
    blocks: [
      h1('c1-title', '第一章　', ruby('灯', 'ひ'), 'の消えた夜'),
      h2('c1-s1', '港の坂道'),
      p(
        'c1-p1',
        '十二月の港町は、日が落ちると急に静かになる。美緒は坂の途中で足を止め、岬の',
        ruby('灯台', 'とうだい'),
        'を見上げた。いつもなら22時を過ぎても回りつづけている光が、今夜はどこにもない。',
      ),
      p(
        'c1-p2',
        '不図、祖母の言葉を思い出した。「あの灯りが消えたら、誰かが手紙を待っている合図だよ」。子どもを寝かしつけるための作り話だと分かる年になっても、美緒は坂を下りる足を止められなかった。',
      ),
      h2('c1-s2', '消えた光'),
      p(
        'c1-p3',
        '岬へつづく道は、',
        ruby('潮騒', 'しおさい'),
        'にまぎれて自分の足音さえ聞こえない。扉の前に立つと、取っ手には古い封筒が一通、麻ひもで結わえてあった。宛名には、',
        dots('美緒'),
        'とだけ書かれていた。',
      ),
    ],
  },
  {
    name: '灯台守の手紙　第二章',
    blocks: [
      h1('c2-title', '第二章　', ruby('硝子', 'ガラス'), '瓶の便り'),
      h2('c2-s1', '最初の手紙'),
      p(
        'c2-p1',
        '封筒の中には、便せんが3枚。インクは色あせ、ところどころ',
        ruby('滲', 'にじ'),
        'んでいる。差出人の名前はなく、最後に「灯台守より」とだけあった。',
      ),
      p(
        'c2-p2',
        '「この手紙を読んでいるなら、あなたはもう灯りの消えた夜を一度見たのでしょう。わたしは',
        dots('ずっと'),
        '、その夜を待っていました」',
      ),
      h2('c2-s2', '返事の書き方'),
      p(
        'c2-p3',
        '手紙の終わりには、返事の出し方が書いてあった。硝子瓶に入れて、満ち潮の時刻に桟橋から流すこと。そんなことで届くはずがない。それでも美緒は、机の引き出しから便せんを取り出していた。返事を書くことなら、自分にも出来る。',
      ),
    ],
  },
  {
    name: '灯台守の手紙　第三章',
    blocks: [
      h1('c3-title', '第三章　', ruby('黎明', 'れいめい')),
      h2('c3-s1', '満ち潮の桟橋'),
      p(
        'c3-p1',
        '午前4時、空はまだ群青のままだった。美緒は瓶を両手で包み、桟橋の先にしゃがみこむ。波が瓶をさらっていくまで、ほんの',
        ruby('瞬', 'まばた'),
        'きほどの時間しかかからなかった。',
      ),
      h2('c3-s2', 'ふたたび灯る'),
      p(
        'c3-p2',
        '帰り道、背中のほうがふっと明るくなった。振り返ると、岬の灯台がゆっくりと回りはじめている。美緒には、それが返事なのだと',
        dots('わかった'),
        '。',
      ),
      p('c3-p3', '光は海をなで、まだ眠っている町の屋根を、ひとつずつ照らしていった。'),
    ],
  },
];

function chapterContent(blocks: DocumentBlock[], vertical = true): DocumentContent {
  const value: DocumentContent = {
    schemaVersion: 2,
    page: { size: 'A4', margin: 64, ...(vertical ? { writingMode: 'vertical-rl' as const } : {}) },
    blocks,
  };
  // Round-trip through the native engine so the seed matches what editing would produce.
  return nodeToContent(contentToNode(value), value);
}

/** A new novel: its title, writing direction and number of chapters (1 to `novelChapterLimit`). */
export interface NovelCreationOptions {
  title: string;
  writingMode: 'vertical-rl' | 'horizontal-tb';
  chapters: number;
}
export const novelChapterLimit = 50;
const kanjiNumber = (n: number) => {
  const digits = '〇一二三四五六七八九';
  if (n < 10) return digits[n];
  const tens = Math.floor(n / 10),
    ones = n % 10;
  return `${tens > 1 ? digits[tens] : ''}十${ones ? digits[ones] : ''}`;
};
/** Empty chapters (a 第N章 heading and an empty paragraph), each with a first saved version. */
export async function makeBlankNovelArtifacts(
  options: NovelCreationOptions,
): Promise<StoredArtifact[]> {
  const title = options.title.trim() || '無題の小説';
  if (!Number.isSafeInteger(options.chapters) || options.chapters < 1)
    throw new Error('章の数は1以上の整数にしてください');
  if (options.chapters > novelChapterLimit) throw new Error(`章の数は${novelChapterLimit}までです`);
  return Promise.all(
    Array.from({ length: options.chapters }, async (_, i) => {
      const n = i + 1,
        heading = `第${kanjiNumber(n)}章`;
      const content = chapterContent(
        [h1(`chapter-${n}-title`, heading), p(`chapter-${n}-p1`)],
        options.writingMode === 'vertical-rl',
      );
      const draft = createArtifact('document', `${title}\u3000${heading}`, content);
      const saved = await commitVersion(draft, null, '小説の作成');
      return { ...saved, annotations: [] };
    }),
  );
}
/** Saved chapters: 通読 composes committed versions only, so each chapter starts with one. */
export async function makeNovelArtifacts(): Promise<StoredArtifact[]> {
  return Promise.all(
    chapters.map(async ({ name, blocks }) => {
      const draft = createArtifact('document', name, chapterContent(blocks));
      const saved = await commitVersion(draft, null, '小説デモの初稿');
      return { ...saved, annotations: [] };
    }),
  );
}
export async function saveNewNovel(artifacts: StoredArtifact[]) {
  const saved = [];
  for (const artifact of artifacts)
    saved.push(
      await createArtifactIfAbsent(storage, artifact, canonicalJson(artifact), canonicalJson),
    );
  writeNovelChapters(saved.map((a) => a.id));
  for (const a of saved) writeNovelWorkspace(a.id, 'novel');
  return saved;
}

// View preferences and the chapter order are Host state; Documents store none of them.
const workspaceKey = (id: string) => `editor-platform.workspace.${id}`;
const chaptersKey = (id: string) => `editor-platform.novel-chapters.${id}`;
export function readNovelWorkspace(id: string): 'document' | 'novel' {
  try {
    return localStorage.getItem(workspaceKey(id)) === 'novel' ? 'novel' : 'document';
  } catch {
    return 'document';
  }
}
export function writeNovelWorkspace(id: string, value: 'document' | 'novel') {
  try {
    localStorage.setItem(workspaceKey(id), value);
  } catch {
    /* View preferences never prevent native editing. */
  }
}
/** The chapter order of the novel this Document belongs to; undefined for ordinary Documents. */
export function readNovelChapters(id: string): string[] | undefined {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(chaptersKey(id)) ?? 'null');
    return Array.isArray(value) && value.every((v) => typeof v === 'string') && value.includes(id)
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}
const goalKey = (id: string) => `editor-platform.novel-goal.${id}`;
/** The author's character goal for a chapter; undefined when none is set. */
export function readNovelGoal(id: string): number | undefined {
  try {
    const value = Number(localStorage.getItem(goalKey(id)) ?? NaN);
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}
export function writeNovelGoal(id: string, goal: number | undefined) {
  try {
    if (goal === undefined) localStorage.removeItem(goalKey(id));
    else localStorage.setItem(goalKey(id), String(goal));
  } catch {
    /* A goal is a view preference; it never prevents editing. */
  }
}
function writeNovelChapters(ids: string[]) {
  try {
    for (const id of ids) localStorage.setItem(chaptersKey(id), JSON.stringify(ids));
  } catch {
    /* Without the order the chapters stay ordinary Documents. */
  }
}

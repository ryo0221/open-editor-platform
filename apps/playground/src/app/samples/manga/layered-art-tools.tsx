import { useEffect, useRef, useState } from 'react';
import { clone, type Artifact } from '@editor-platform/artifact-core';
import { sameLocalRevision, rotatedBounds } from '@editor-platform/editor-core';
import { Dialog } from '@editor-platform/editor-ui';
import { exportDesignSvg, isDesignWithPaths, type DesignContent } from '@editor-platform/design';
import { decodeDesignPng } from '@editor-platform/design/raster-canvas';
import { createLocalSession, downloadText, type StoredArtifact } from '../../../model';
import type { SurfaceHost } from '../../editor-surfaces';
import {
  type ArtSubject,
  makeLayeredArtRequest,
  layeredArtArtifact,
  type LayeredArtRequest,
} from './layered-art';
import './layered-art-tools.css';
import { splitLayeredArtImage } from './layered-art-canvas';

export type LayeredArtGenerator = (
  request: LayeredArtRequest,
  signal: AbortSignal,
) => Promise<unknown>;
export interface PlaygroundArtTools {
  connect(generator: LayeredArtGenerator): () => void;
  request(): LayeredArtRequest;
  preview(result: unknown): Promise<void>;
}
declare global {
  interface Window {
    playgroundArt?: PlaygroundArtTools;
  }
}
function subjects(humans: string, animals: string): ArtSubject[] {
  return (
    [
      ['human', humans],
      ['animal', animals],
    ] as const
  ).flatMap(([kind, names]) =>
    names
      .split('\n')
      .map((n) => n.trim())
      .filter(Boolean)
      .map((name, i) => ({ id: `${kind}-${i + 1}`, name, kind })),
  );
}
export function LayeredArtTools({ host }: { host: SurfaceHost }) {
  const [open, setOpen] = useState(false),
    [title, setTitle] = useState('ネームからのレイヤー原稿'),
    [instructions, setInstructions] = useState(''),
    [dialogue, setDialogue] = useState(''),
    [humans, setHumans] = useState(''),
    [animals, setAnimals] = useState(''),
    [rough, setRough] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [connected, setConnected] = useState(false),
    [composing, setComposing] = useState(false),
    [previewLayer, setPreviewLayer] = useState(''),
    [preview, setPreview] = useState<Artifact<DesignContent>>();
  const live = useRef({ host, title, instructions, dialogue, rough, composing, humans, animals });
  live.current = { host, title, instructions, dialogue, rough, composing, humans, animals };
  const alive = useRef(false),
    pending = useRef<LayeredArtRequest | undefined>(undefined),
    generator = useRef<LayeredArtGenerator | undefined>(undefined),
    controller = useRef<AbortController | undefined>(undefined),
    processing = useRef(false),
    upload = useRef(0),
    adopting = useRef(false),
    generating = useRef(false),
    uploading = useRef(false),
    prepared = useRef<Artifact<DesignContent> | undefined>(undefined);
  function writable() {
    const h = live.current.host;
    return alive.current && !h.shared && !h.readOnly && !h.busy;
  }
  function current() {
    const h = live.current.host;
    if (!writable() || !h.flushInputs() || live.current.composing)
      throw Error('編集中の入力を確定してから、ローカル原稿で操作してください。');
    const s = h.sessions.current.get(h.active.id);
    if (!s || !isDesignWithPaths(s.content)) throw Error('Design原稿がありません。');
    return { artifactId: h.active.id, revision: clone(s.revision) };
  }
  function request() {
    if (
      processing.current ||
      adopting.current ||
      generating.current ||
      uploading.current ||
      prepared.current
    )
      throw Error('現在の生成案の処理を完了してください。');
    const c = current(),
      v = live.current;
    const r = makeLayeredArtRequest({
      artifactId: c.artifactId,
      revision: c.revision,
      title: v.title,
      instructions: v.instructions,
      dialogue: v.dialogue,
      referencePng: v.rough,
      ...(v.humans.trim() || v.animals.trim() ? { subjects: subjects(v.humans, v.animals) } : {}),
    });
    pending.current = r;
    return clone(r);
  }
  function unchanged(r: LayeredArtRequest) {
    const c = current(),
      v = live.current;
    if (
      c.artifactId !== r.artifactId ||
      !sameLocalRevision(c.revision, r.baseRevision) ||
      v.title !== r.title ||
      v.instructions !== r.instructions ||
      v.dialogue !== r.dialogue ||
      v.rough !== r.referencePng ||
      JSON.stringify(r.subjects ?? []) !== JSON.stringify(subjects(v.humans, v.animals))
    )
      throw Error('生成中に原稿・ラフ・指示が変わりました。取得し直してください。');
  }
  async function receive(raw: unknown) {
    if (
      uploading.current ||
      generating.current ||
      processing.current ||
      adopting.current ||
      prepared.current
    )
      throw Error('現在の生成案の処理を完了してください。');
    const r = pending.current;
    if (!r) throw Error('先に生成を依頼してください。');
    unchanged(r);
    processing.current = true;
    setBusy(true);
    try {
      const result =
        raw && typeof raw === 'object' && 'sourcePng' in raw
          ? await splitLayeredArtImage(r, raw)
          : raw;
      const artifact = await layeredArtArtifact(r, result);
      for (const e of artifact.draft.content.elements.filter(
        (e) => e.type === 'image' && e.id !== 'art-rough',
      )) {
        const bitmap = await decodeDesignPng(e.src!);
        if (e.id !== 'art-sky') {
          const c = document.createElement('canvas');
          c.width = bitmap.width;
          c.height = bitmap.height;
          const ctx = c.getContext('2d')!;
          ctx.drawImage(bitmap.image, 0, 0);
          const pixels = ctx.getImageData(0, 0, c.width, c.height).data;
          let transparent = 0,
            visible = 0;
          for (let i = 3; i < pixels.length; i += 4) {
            if (pixels[i] === 0) transparent++;
            if (pixels[i] > 0) visible++;
          }
          if (!transparent || !visible)
            throw Error(e.name + 'は、他の部分を透過した個別レイヤーにしてください。');
        }
      }
      unchanged(r);
      prepared.current = artifact;
      setPreviewLayer('');
      setPreview(artifact);
      setOpen(true);
      setError('');
    } finally {
      processing.current = false;
      if (alive.current) setBusy(false);
    }
  }
  useEffect(() => {
    alive.current = true;
    const api = {
      connect(fn: LayeredArtGenerator) {
        if (!alive.current) throw Error('作画画面を開いてください。');
        if (typeof fn !== 'function') throw Error('生成先が不正です。');
        controller.current?.abort();
        generator.current = fn;
        setConnected(true);
        return () => {
          if (generator.current === fn) {
            controller.current?.abort();
            generator.current = undefined;
            if (alive.current) setConnected(false);
          }
        };
      },
      request,
      preview: receive,
    };
    window.playgroundArt = api;
    return () => {
      alive.current = false;
      upload.current++;
      controller.current?.abort();
      if (window.playgroundArt === api) delete window.playgroundArt;
    };
  }, []);
  function discard() {
    if (adopting.current) return;
    controller.current?.abort();
    pending.current = undefined;
    prepared.current = undefined;
    setPreview(undefined);
    setError('');
  }
  const canEdit = !host.readOnly && !host.shared && !host.busy && !busy;
  return (
    <>
      <button disabled={!canEdit} onClick={() => setOpen(true)}>
        ネーム・ラフから作画
      </button>
      {open && (
        <Dialog
          title="ネーム・ラフからレイヤー作画"
          onClose={() => {
            if (busy || adopting.current) return;
            discard();
            setOpen(false);
          }}
        >
          <div
            className="layered-art-form"
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={() => setComposing(false)}
          >
            {!preview ? (
              <>
                <label>
                  作品名
                  <input
                    aria-label="レイヤー原稿の作品名"
                    value={title}
                    maxLength={160}
                    disabled={!canEdit}
                    onChange={(e) => setTitle(e.target.value)}
                  />
                </label>
                <button
                  disabled={!canEdit}
                  onClick={() => {
                    let start: ReturnType<typeof current>;
                    try {
                      start = current();
                    } catch (e) {
                      setError((e as Error).message);
                      return;
                    }
                    const h = live.current.host;
                    const content = h.sessions.current.get(start.artifactId)!
                      .content as DesignContent;
                    const ids = h.selection.addresses.map((a) => a.elementId);
                    if (
                      ids.length !== 1 ||
                      !content.pagination?.pages.some((p) => p.panelIds.includes(ids[0]))
                    ) {
                      setError('元の原稿でネイティブのコマを1つ選択してください。');
                      return;
                    }
                    uploading.current = true;
                    setBusy(true);
                    const token = ++upload.current;
                    void (async () => {
                      const panel = content.elements.find((e) => e.id === ids[0])!;
                      const viewport = rotatedBounds(panel.bounds, panel.rotation);
                      const svgDocument = new DOMParser().parseFromString(
                        exportDesignSvg(content, ids, { padding: 0, background: '#ffffff' }),
                        'image/svg+xml',
                      );
                      const svgRoot = svgDocument.documentElement;
                      svgRoot.setAttribute(
                        'viewBox',
                        `${viewport.x} ${viewport.y} ${viewport.width} ${viewport.height}`,
                      );
                      svgRoot.setAttribute('width', String(viewport.width));
                      svgRoot.setAttribute('height', String(viewport.height));
                      const svg = new XMLSerializer().serializeToString(svgRoot);
                      const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
                      try {
                        const image = new Image();
                        image.src = url;
                        await image.decode();
                        const c = document.createElement('canvas');
                        const scale = Math.min(800 / image.width, 1000 / image.height, 1);
                        c.width = Math.max(1, Math.round(image.width * scale));
                        c.height = Math.max(1, Math.round(image.height * scale));
                        c.getContext('2d')!.drawImage(image, 0, 0, c.width, c.height);
                        const end = current();
                        if (
                          start.artifactId !== end.artifactId ||
                          !sameLocalRevision(start.revision, end.revision)
                        )
                          throw Error('原稿が変わりました。コマを取得し直してください。');
                        if (alive.current && token === upload.current) {
                          setRough(c.toDataURL());
                          pending.current = undefined;
                          setError('');
                        }
                      } finally {
                        URL.revokeObjectURL(url);
                      }
                    })()
                      .catch((e) => {
                        if (alive.current) setError((e as Error).message);
                      })
                      .finally(() => {
                        if (token === upload.current) {
                          uploading.current = false;
                          if (alive.current) setBusy(false);
                        }
                      });
                  }}
                >
                  選択したコマをラフに使う
                </button>
                <label>
                  ネーム・ラフ画像
                  <input
                    type="file"
                    aria-label="ネーム・ラフ画像"
                    accept="image/png,image/jpeg"
                    disabled={!canEdit}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      e.target.value = '';
                      if (!file) return;
                      const token = ++upload.current;
                      uploading.current = true;
                      setBusy(true);
                      void (async () => {
                        if (
                          file.size > 4 * 1024 * 1024 ||
                          !['image/png', 'image/jpeg'].includes(file.type)
                        )
                          throw Error('4MiB以下のPNG/JPEGを選んでください。');
                        const url = URL.createObjectURL(file);
                        try {
                          const image = new Image();
                          image.src = url;
                          await image.decode();
                          if (
                            !image.width ||
                            !image.height ||
                            image.width > 4096 ||
                            image.height > 4096
                          )
                            throw Error('ラフは長辺4096pxまでです。');
                          const scale = Math.min(800 / image.width, 1000 / image.height, 1),
                            c = document.createElement('canvas');
                          c.width = Math.max(1, Math.round(image.width * scale));
                          c.height = Math.max(1, Math.round(image.height * scale));
                          c.getContext('2d')!.drawImage(image, 0, 0, c.width, c.height);
                          if (alive.current && token === upload.current) {
                            setRough(c.toDataURL());
                            pending.current = undefined;
                            setError('');
                          }
                        } finally {
                          URL.revokeObjectURL(url);
                        }
                      })()
                        .catch((ex) => {
                          if (alive.current && token === upload.current)
                            setError((ex as Error).message);
                        })
                        .finally(() => {
                          if (token === upload.current) {
                            uploading.current = false;
                            if (alive.current) setBusy(false);
                          }
                        });
                    }}
                  />
                </label>
                {rough && (
                  <img className="layered-art-rough" alt="入力したネーム・ラフ" src={rough} />
                )}
                <label>
                  人物名（1行に1人、動物と合わせて5名まで）
                  <textarea
                    aria-label="作画する人物名"
                    value={humans}
                    disabled={!canEdit}
                    onChange={(e) => setHumans(e.target.value)}
                    maxLength={200}
                  />
                </label>
                <label>
                  動物名（1行に1匹）
                  <textarea
                    aria-label="作画する動物名"
                    value={animals}
                    disabled={!canEdit}
                    onChange={(e) => setAnimals(e.target.value)}
                    maxLength={200}
                  />
                </label>
                <p>名前を指定すると人物・動物ごとの細部レイヤーを使います。空欄は従来の8層です。</p>
                <label>
                  作画指示
                  <textarea
                    aria-label="作画指示"
                    value={instructions}
                    maxLength={4000}
                    rows={4}
                    disabled={!canEdit}
                    onCompositionStart={() => setComposing(true)}
                    onCompositionEnd={() => setComposing(false)}
                    onChange={(e) => setInstructions(e.target.value)}
                    placeholder="人物の特徴、服装、表情、舞台、直したい点を指示してください。"
                  />
                </label>
                <label>
                  台詞（文字として残す）
                  <textarea
                    aria-label="台詞（文字として残す）"
                    value={dialogue}
                    maxLength={300}
                    rows={2}
                    disabled={!canEdit}
                    onCompositionStart={() => setComposing(true)}
                    onCompositionEnd={() => setComposing(false)}
                    onChange={(e) => setDialogue(e.target.value)}
                    placeholder="省略できます。吹き出しと文字は後から編集できます。"
                  />
                </label>
                <p>
                  人物5層＋背景3層。全レイヤーで同じ構図・サイズを使います。試作は最大800×1000pxです。
                </p>
                <ul>
                  {pending.current?.layers.map((l) => (
                    <li key={l.id}>
                      {l.group === 'character' ? '人物' : '背景'}：{l.name}
                    </li>
                  ))}
                </ul>
                <div className="layered-art-actions">
                  <button
                    disabled={!canEdit || !rough || !instructions.trim() || composing || !connected}
                    onClick={() => {
                      const fn = generator.current;
                      if (!fn) return;
                      void (async () => {
                        const r = request(),
                          abort = new AbortController();
                        controller.current = abort;
                        generating.current = true;
                        setBusy(true);
                        const interrupted = new Promise<never>((_, reject) => {
                          abort.signal.addEventListener(
                            'abort',
                            () => reject(Error('生成を中止しました。')),
                            { once: true },
                          );
                        });
                        const timer = window.setTimeout(() => abort.abort(), 300_000);
                        try {
                          const result = await Promise.race([
                            fn(clone(r), abort.signal),
                            interrupted,
                          ]);
                          if (abort.signal.aborted) throw Error('生成を中止しました。');
                          generating.current = false;
                          await receive(result);
                        } finally {
                          window.clearTimeout(timer);
                          generating.current = false;
                          if (controller.current === abort) controller.current = undefined;
                          if (alive.current) setBusy(false);
                        }
                      })().catch((e) => {
                        if (alive.current) setError((e as Error).message);
                      });
                    }}
                  >
                    レイヤーに分けて生成
                  </button>
                  <button
                    disabled={!canEdit || !rough || !instructions.trim() || composing}
                    onClick={() => {
                      try {
                        downloadText(
                          'layered-art-request.json',
                          JSON.stringify(request()),
                          'application/json',
                        );
                        setError('');
                      } catch (e) {
                        setError((e as Error).message);
                      }
                    }}
                  >
                    生成用データを保存
                  </button>
                  <label>
                    生成レイヤーを受け取る
                    <input
                      aria-label="生成レイヤーを受け取る"
                      type="file"
                      accept=".json,application/json"
                      disabled={!canEdit}
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        e.target.value = '';
                        if (file)
                          void (async () => {
                            if (file.size > 12 * 1024 * 1024)
                              throw Error('生成結果は12MiBまでです。');
                            await receive(JSON.parse(await file.text()));
                          })().catch((ex) => {
                            if (alive.current) setError((ex as Error).message);
                          });
                      }}
                    />
                  </label>
                </div>
                <p>
                  {connected
                    ? '生成先に接続済みです。'
                    : '生成先は未接続です。この会話で試す場合は生成用データを保存し、AIからのレイヤー原稿を受け取れます。'}
                </p>
              </>
            ) : (
              <>
                <p>
                  生成結果を確認してください。採用すると、元の原稿を保持して新しいレイヤー原稿をLibraryに保存します。
                </p>
                <label>
                  レイヤーを確認
                  <select
                    aria-label="生成案の表示レイヤー"
                    value={previewLayer}
                    onChange={(e) => setPreviewLayer(e.target.value)}
                  >
                    <option value="">すべて重ねる</option>
                    {pending.current?.layers.map((l) => (
                      <option key={l.id} value={'art-' + l.id}>
                        {pending.current?.subjects?.find((s) => 'subject-' + s.id === l.group)
                          ?.name ??
                          (l.group === 'background'
                            ? '背景'
                            : l.group === 'effects'
                              ? '効果'
                              : '人物')}{' '}
                        / {l.name}
                      </option>
                    ))}
                  </select>
                </label>
                <img
                  className="layered-art-preview"
                  alt={
                    previewLayer
                      ? '単独レイヤーの生成案'
                      : pending.current?.schemaVersion === 1
                        ? '8レイヤーを重ねた生成案'
                        : '人物別レイヤーを重ねた生成案'
                  }
                  src={
                    previewLayer
                      ? preview.draft.content.elements.find((e) => e.id === previewLayer)?.src
                      : 'data:image/svg+xml;charset=utf-8,' +
                        encodeURIComponent(exportDesignSvg(preview.draft.content))
                  }
                />
                <p>
                  単独表示で分離の境界も確認してください。大きく動かす場合は、隠れていた部分の描き足しが必要です。
                </p>
                <div className="layered-art-actions">
                  <button disabled={busy} onClick={discard}>
                    生成案を却下
                  </button>
                  <button
                    disabled={!canEdit}
                    onClick={() => {
                      if (adopting.current) return;
                      adopting.current = true;
                      setBusy(true);
                      void (async () => {
                        const r = pending.current;
                        if (!r) throw Error('生成依頼がありません。');
                        unchanged(r);
                        const h = live.current.host,
                          record: StoredArtifact = { ...preview, annotations: [] };
                        if ((await h.persist(record)) !== true)
                          throw Error('保存できませんでした。同じ生成案で再試行できます。');
                        h.sessions.current.set(record.id, createLocalSession(record.draft.content));
                        const sourceSession = live.current.host.sessions.current.get(r.artifactId);
                        if (
                          writable() &&
                          live.current.host.active.id === r.artifactId &&
                          sourceSession &&
                          sameLocalRevision(sourceSession.revision, r.baseRevision)
                        )
                          h.activate(record.id);
                        else h.setStatus('生成原稿をLibraryに保存しました。');
                        pending.current = undefined;
                        prepared.current = undefined;
                        setPreview(undefined);
                        setOpen(false);
                      })()
                        .catch((e) => {
                          if (alive.current) setError((e as Error).message);
                        })
                        .finally(() => {
                          adopting.current = false;
                          if (alive.current) setBusy(false);
                        });
                    }}
                  >
                    レイヤー原稿を採用
                  </button>
                </div>
              </>
            )}
            {busy && <p role="status">レイヤーを準備しています。</p>}
            {busy && generating.current && (
              <button onClick={() => controller.current?.abort()}>生成を中止</button>
            )}
            {error && <p role="alert">{error}</p>}
          </div>
        </Dialog>
      )}
    </>
  );
}

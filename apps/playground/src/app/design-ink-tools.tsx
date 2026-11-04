import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { Dialog } from '@editor-platform/editor-ui';
import { canonicalJson, clone } from '@editor-platform/artifact-core';
import {
  previewProposedCommands,
  sameLocalRevision,
  transaction,
  type ProposalPreview,
} from '@editor-platform/editor-core';
import {
  exportDesignSvg,
  isDesignWithPaths,
  updateElement,
  type DesignContent,
} from '@editor-platform/design';
import { insertDesignPage, insertDesignPanel } from '@editor-platform/design/pagination';
import type { SurfaceHost } from './editor-surfaces';
import { downloadText } from '../model';
import {
  inkLayers,
  prepareInkProposal,
  prepareRasterInkProposal,
  type InkContext,
} from './design-ink-proposal';
import './design-ink-tools.css';

export interface PlaygroundInkTools {
  read(): InkContext;
  propose(input: unknown): { proposalId: string; artifactId: string };
  proposeRaster(input: unknown): Promise<{ proposalId: string; artifactId: string }>;
}
export interface DesignInkToolsControl {
  open(trigger: HTMLButtonElement): void;
}
declare global {
  interface Window {
    playgroundInk?: PlaygroundInkTools;
  }
}

function image(content: DesignContent) {
  return (
    'data:image/svg+xml;charset=utf-8,' +
    encodeURIComponent(exportDesignSvg(content, undefined, { background: '#ffffff' }))
  );
}

/** Uses the active Playground session and ordinary command/history/save boundaries. */
export function DesignInkTools({
  control,
  host,
  onChoose,
  rasterSelection,
}: {
  control?: Ref<DesignInkToolsControl>;
  host: SurfaceHost;
  onChoose(id: string): void;
  rasterSelection?: InkContext['rasterSelection'] & { artifactId: string };
}) {
  const [compact, setCompact] = useState(() => window.matchMedia('(max-width: 1100px)').matches);
  const [toolsOpen, setToolsOpen] = useState(false);
  const returnFocus = useRef<{ trigger: HTMLElement; fallback: HTMLElement | null } | undefined>(
    undefined,
  );
  useEffect(() => {
    const media = window.matchMedia('(max-width: 1100px)');
    const changed = () => {
      setCompact(media.matches);
      setToolsOpen(false);
    };
    media.addEventListener('change', changed);
    return () => media.removeEventListener('change', changed);
  }, []);
  useImperativeHandle(
    control,
    () => ({
      open(trigger) {
        returnFocus.current = {
          trigger,
          fallback:
            trigger
              .closest('.ep-toolbar')
              ?.querySelector<HTMLElement>('button[aria-label="More editor tools"]') ?? null,
        };
        setToolsOpen(true);
      },
    }),
    [],
  );
  function closeTools() {
    setToolsOpen(false);
    requestAnimationFrame(() => {
      const target = returnFocus.current;
      (target?.trigger.isConnected && target.trigger.offsetParent !== null
        ? target.trigger
        : target?.fallback
      )?.focus();
    });
  }
  const latest = useRef(host);
  latest.current = host;
  const selectedRaster = useRef(rasterSelection);
  selectedRaster.current = rasterSelection;
  const preparing = useRef(false);
  const alive = useRef(false);
  const pending = useRef<ProposalPreview<DesignContent> | undefined>(undefined);
  const [proposal, setProposal] = useState<ProposalPreview<DesignContent>>();
  const dialog = useRef<HTMLDialogElement>(null);
  const [error, setError] = useState('');
  const writable = () =>
    alive.current && !latest.current.shared && !latest.current.readOnly && !latest.current.busy;
  function read(): InkContext {
    const h = latest.current;
    if (!alive.current || h.shared || h.busy)
      throw Error('ローカル原稿が使用できる状態で操作してください。');
    if (!h.flushInputs()) throw Error('編集中の入力を確定またはキャンセルしてください。');
    const session = h.sessions.current.get(h.active.id);
    if (!session || !isDesignWithPaths(session.content)) throw Error('Design原稿がありません。');
    return {
      artifactId: h.active.id,
      revision: clone(session.revision),
      content: clone(session.content),
      selectedIds: h.selection.addresses.map((a) => a.elementId),
      rasterSelection:
        selectedRaster.current?.artifactId === h.active.id &&
        session.content.elements.some(
          (e) =>
            e.id === selectedRaster.current?.elementId && e.src === selectedRaster.current?.src,
        )
          ? clone(selectedRaster.current)
          : undefined,
    };
  }
  function propose(input: unknown) {
    if (pending.current || preparing.current) throw Error('現在の作画案の処理を完了してください。');
    const current = read(),
      value = prepareInkProposal(current, input, writable);
    const preview = previewProposedCommands(current.content, value);
    if (canonicalJson(preview.content) === canonicalJson(current.content))
      throw Error('原稿を変更しない提案です。');
    pending.current = preview;
    setToolsOpen(false);
    setProposal(preview);
    setError('');
    return { proposalId: value.id, artifactId: current.artifactId };
  }
  async function proposeRaster(input: unknown) {
    if (pending.current || preparing.current) throw Error('現在の作画案の処理を完了してください。');
    preparing.current = true;
    try {
      const current = read(),
        value = await prepareRasterInkProposal(current, input, writable),
        after = read();
      if (
        after.artifactId !== current.artifactId ||
        !sameLocalRevision(after.revision, current.revision) ||
        canonicalJson(after.content) !== canonicalJson(current.content)
      )
        throw Error('画像の準備中に原稿が変わりました。取得し直してください。');
      const preview = previewProposedCommands(current.content, value);
      if (canonicalJson(preview.content) === canonicalJson(current.content))
        throw Error('原稿を変更しない提案です。');
      pending.current = preview;
      setToolsOpen(false);
      setProposal(preview);
      setError('');
      return { proposalId: value.id, artifactId: current.artifactId };
    } finally {
      preparing.current = false;
    }
  }
  useEffect(() => {
    alive.current = true;
    const tools = { read, propose, proposeRaster };
    window.playgroundInk = tools;
    return () => {
      alive.current = false;
      if (window.playgroundInk === tools) delete window.playgroundInk;
    };
  }, []);
  useEffect(() => {
    if (proposal) dialog.current?.showModal();
  }, [proposal]);
  function reject() {
    pending.current = undefined;
    setProposal(undefined);
    setError('');
  }
  function apply() {
    try {
      if (!proposal || !writable()) throw Error('この原稿は編集できません。');
      const current = read();
      if (
        !sameLocalRevision(current.revision, proposal.proposal.baseLocalRevision!) ||
        canonicalJson(current.content) !== canonicalJson(proposal.baseContent)
      )
        throw Error('提案の後に原稿が変わりました。却下して取得し直してください。');
      if (!latest.current.execute(proposal.proposal.commands[0]))
        throw Error('作画案を適用できませんでした。原稿を確認してください。');
      reject();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const content = host.active.draft.content as DesignContent;
  const layers = inkLayers(content);
  const selected = new Set(host.selection.addresses.map((a) => a.elementId));
  const currentLayer =
    layers.find((layer) => selected.has(layer.id))?.id ??
    layers.find((layer) =>
      content.elements.some((e) => selected.has(e.id) && e.parentId === layer.id),
    )?.id ??
    '';
  const canEdit = !host.readOnly && !host.busy && !host.shared;
  const tools = (
    <section className="design-ink-tools" aria-label="作画ツール">
      {!content.elements.length && (
        <button
          disabled={!canEdit}
          onClick={() => {
            try {
              if (!writable()) throw Error('この原稿は編集できません。');
              read();
              const bounds = { x: 0, y: 0, width: 800, height: 1000 },
                page = insertDesignPage(bounds);
              const panel = insertDesignPanel(page.elementId, bounds);
              if (
                host.execute(
                  transaction('白紙の作画ページを用意', [
                    page,
                    updateElement(page.elementId, {
                      name: '作画ページ',
                      fill: '#ffffff',
                      strokeWidth: 0,
                      clipContent: true,
                    }),
                    panel,
                    updateElement(panel.elementId, {
                      name: '作画コマ',
                      fill: 'none',
                      stroke: '#181818',
                      strokeWidth: 1,
                    }),
                  ]),
                )
              ) {
                onChoose(panel.elementId);
                if (compact) closeTools();
              }
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          白紙の作画ページを用意
        </button>
      )}
      <label>
        描くレイヤー
        <select
          aria-label="描くレイヤー"
          value={currentLayer}
          disabled={!canEdit}
          onChange={(e) => {
            const id = e.target.value;
            if (id && host.flushInputs()) {
              onChoose(id);
              if (compact) closeTools();
            }
          }}
        >
          <option value="">レイヤーを選択</option>
          {layers.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name || e.id}
            </option>
          ))}
        </select>
      </label>
      <details>
        <summary>線を描く・AIと編集する</summary>
        <p>
          Draw ink strokeで描き、Finish drawing strokesで終了します。線の点はInspectorのEdit path
          pointsで動かせます。画像はInspectorの「画像を直接描き直す」でブラシ・消しゴムを使えます。筆圧には未対応です。
        </p>
        <button
          disabled={host.busy}
          onClick={() => {
            try {
              downloadText(
                'playground-ink-context.json',
                JSON.stringify(read()),
                'application/json',
              );
              setError('');
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          AIに渡す作画データを保存
        </button>
        <label>
          作画提案を開く
          <input
            type="file"
            aria-label="作画提案を開く"
            accept=".json,application/json"
            disabled={!canEdit || !!proposal}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = '';
              if (file)
                void (async () => {
                  if (file.size > 8 * 1024 * 1024) throw Error('作画提案は8MiBまでです。');
                  const input = JSON.parse(await file.text());
                  if (input?.operations?.[0]?.type === 'raster-region') await proposeRaster(input);
                  else propose(input);
                })().catch((e) => setError((e as Error).message));
            }}
          />
        </label>
        <p>AIから受け取った案を確認して採用します。外部AIサービスへの自動送信はありません。</p>
        {rasterSelection && (
          <p>
            画像の選択範囲：{rasterSelection.region.width} × {rasterSelection.region.height} px
          </p>
        )}
      </details>
      {error && !proposal && <p role="alert">{error}</p>}
    </section>
  );
  return (
    <>
      {!compact
        ? tools
        : toolsOpen && (
            <Dialog title="作画ツール" onClose={closeTools}>
              {tools}
            </Dialog>
          )}
      {proposal && (
        <dialog
          ref={dialog}
          aria-label="作画案を確認"
          className="design-ink-dialog"
          onCancel={reject}
        >
          <h2>{proposal.proposal.summary}</h2>
          <p>原稿はまだ変わっていません。採用すると一度のUndoで戻せます。</p>
          <div className="design-ink-comparison">
            <figure>
              <figcaption>現在の原稿</figcaption>
              <img alt="現在の線画" src={image(proposal.baseContent)} />
            </figure>
            <figure>
              <figcaption>提案された原稿</figcaption>
              <img alt="提案された線画" src={image(proposal.content)} />
            </figure>
          </div>
          {error && <p role="alert">{error}</p>}
          <footer>
            <button onClick={reject}>作画案を却下</button>
            <button disabled={!canEdit} onClick={apply}>
              作画案を採用
            </button>
          </footer>
        </dialog>
      )}
    </>
  );
}

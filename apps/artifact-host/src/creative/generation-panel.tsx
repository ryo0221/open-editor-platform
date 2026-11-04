import { useEffect, useRef, useState } from 'react';
import { downloadBlob, readImage } from '@editor-platform/canvas-ui';
import { exportDesignSvg, type DesignElement } from '@editor-platform/design/model';
import {
  creativeDesignAddressKey,
  type CreativeDesignAddress,
} from '@editor-platform/design/creative-proposal-diff';
import {
  addCreativeGenerationLayer,
  generateCreativeLayer,
  importCreativeRough,
  prepareCreativeLayerGeneration,
  setCreativeRoughVisible,
  type CreativeLayerConnection,
  type CreativeLayerPreparation,
} from './generation';
import type { CreativeProject } from './project';
import type { CreativeSourceCard } from './types';
import { CreativeWorldRunPanel, CreativeWorldHistoryPanel } from './generation-world-panel';

/** Private editor UI state only. The consuming Host owns AI execution and workflow state. */
export function CreativeGenerationPanel<T>({
  project,
  card,
  frame,
  connection,
  editRough,
  changed,
  onError,
}: {
  project: CreativeProject<T>;
  card: CreativeSourceCard;
  frame: DesignElement;
  connection?: CreativeLayerConnection;
  editRough(): void;
  changed(): void;
  onError(e: unknown): void;
}) {
  const editor = project.editor(card)!;
  const world = connection?.context === 'world' ? connection.world : undefined;
  const readOnly = editor.readOnly || project.source.readOnly || project.saving;
  const [name, setName] = useState(project.mode.id === 'setting' ? '屋根の清書' : '前髪の清書');
  const [box, setBox] = useState({
    x: 0,
    y: 0,
    width: Math.min(256, frame.bounds.width),
    height: Math.min(256, frame.bounds.height),
  });
  const [target, setTarget] = useState('');
  const [instructions, setInstructions] = useState('');
  const [styleGuide, setStyleGuide] = useState(
    'ラフの形・配色・線の太さ・光源・視点を維持する。指定部位だけを描く。',
  );
  const [transparent, setTransparent] = useState(true);
  const [preparation, setPreparation] = useState<CreativeLayerPreparation>();
  const [proposalId, setProposalId] = useState('');
  const [upload, setUpload] = useState('');
  const [source, setSource] = useState('');
  const [license, setLicense] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const active = useRef<AbortController | undefined>(undefined);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      active.current?.abort();
    };
  }, []);
  const run = async (action: (signal: AbortSignal) => unknown | Promise<unknown>) => {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setNotice('');
    try {
      editor.flushInputs();
      await action(controller.signal);
      if (live.current && !controller.signal.aborted) changed();
    } catch (e) {
      if (live.current && !controller.signal.aborted) onError(e);
    } finally {
      if (active.current === controller) {
        active.current = undefined;
        if (live.current) setBusy(false);
      }
    }
  };
  const choices: { label: string; address: CreativeDesignAddress }[] = editor.content.elements
    .filter((e) => e.type === 'image' && e.parentId === frame.id)
    .map((e) => ({ label: e.name, address: { elementId: e.id } }));
  for (const owner of editor.content.elements.filter(
    (e) => e.type === 'instance' && e.parentId === frame.id,
  )) {
    const component = editor.content.components.find((c) => c.id === owner.componentId);
    for (const e of component?.elements ?? [])
      if (e.type === 'image') {
        choices.push({
          label: `${owner.name} / ${e.name}（この候補）`,
          address: { instanceId: owner.id, componentId: component!.id, elementId: e.id },
        });
        if (connection?.mayEditShared?.())
          choices.push({
            label: `${e.name}（共有・全候補）`,
            address: { componentId: component!.id, elementId: e.id },
          });
      }
  }
  const pin = project.binding(card)?.rough;
  const proposal = editor.proposals.find((p) => p.id === proposalId);
  const svg = (content: typeof editor.content) =>
    `data:image/svg+xml;charset=utf-8,${encodeURIComponent(exportDesignSvg(content, [frame.id], { padding: 0 }))}`;
  const resultFile = (
    <label>
      結果PNG
      <input
        aria-label="清書結果PNG"
        type="file"
        accept="image/png"
        disabled={readOnly || busy || !preparation}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          void run(async (signal) => {
            const image = await readImage(file);
            if (signal.aborted) return;
            setUpload(image);
            setSource('');
            setLicense('');
          });
        }}
      />
    </label>
  );
  if (connection?.context === 'world' && !world)
    return (
      <details className="creative-generation">
        <summary>世界設定を使う生成（未接続）</summary>
        <p>
          World対応Hostと認可・実行記録が未接続です。この入口では依頼・書出し・結果取込は利用できません。
        </p>
      </details>
    );
  return (
    <details className="creative-generation">
      <summary>{world ? '世界設定を使うレイヤー別清書' : 'ラフからレイヤー別に清書'}</summary>
      <p>人が直したラフを共通参照にし、指定した画像レイヤーだけに生成結果を取り込みます。</p>
      <fieldset disabled={readOnly || busy}>
        <legend>ラフの準備</legend>
        <label>
          ラフPNG
          <input
            aria-label="ラフPNG"
            type="file"
            accept="image/png"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              void run(async (signal) => {
                const image = await readImage(file);
                if (signal.aborted) return;
                setUpload(image);
                setSource('');
                setLicense('');
              });
            }}
          />
        </label>
        <p>配置すると、このFrameの既存レイヤーを非表示にします。元に戻す操作で復元できます。</p>
        <label>
          画像の出典
          <input
            aria-label="清書画像の出典"
            value={source}
            onChange={(e) => setSource(e.target.value)}
          />
        </label>
        <label>
          画像の利用条件
          <input
            aria-label="清書画像の利用条件"
            value={license}
            onChange={(e) => setLicense(e.target.value)}
          />
        </label>
        {upload && <img className="creative-upload" src={upload} alt="取り込むPNGの確認" />}
        <button
          disabled={!upload || !source.trim() || !license.trim()}
          onClick={() =>
            void run(() => {
              importCreativeRough(project, card, frame.id, upload, source, license);
              setUpload('');
            })
          }
        >
          ラフをこのFrameへ配置
        </button>
        <button onClick={() => void run(editRough)}>標準ツールでラフを修正</button>
        <button
          onClick={() =>
            void run(async (signal) => {
              await project.save({ rough: { itemId: card.id, frameId: frame.id } });
              if (!signal.aborted) {
                setPreparation(undefined);
                setNotice('ラフの基準版を保存しました');
              }
            })
          }
        >
          このFrameをラフの基準版に保存
        </button>
        {pin && (
          <>
            <p>
              共通ラフ：<code>{pin.versionId}</code> / {pin.frameId}
            </p>
            <button onClick={() => void run(() => setCreativeRoughVisible(project, card, false))}>
              基準ラフを隠す
            </button>
            <button onClick={() => void run(() => setCreativeRoughVisible(project, card, true))}>
              基準ラフを表示
            </button>
          </>
        )}
      </fieldset>
      <fieldset disabled={readOnly || busy || !!preparation}>
        <legend>清書する画像レイヤー</legend>
        <label>
          レイヤー名
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="creative-generation-bounds">
          {(['x', 'y', 'width', 'height'] as const).map((key) => (
            <label key={key}>
              {key}
              <input
                type="number"
                aria-label={`清書範囲 ${key}`}
                value={Number.isNaN(box[key]) ? '' : box[key]}
                onChange={(e) => setBox({ ...box, [key]: e.target.valueAsNumber })}
              />
            </label>
          ))}
        </div>
        <button
          onClick={() =>
            void run(() => {
              const id = addCreativeGenerationLayer(project, card, frame.id, name, box);
              setTarget(creativeDesignAddressKey({ elementId: id }));
            })
          }
        >
          清書レイヤーを追加
        </button>
        <label>
          生成対象
          <select
            aria-label="清書の生成対象"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          >
            <option value="">画像レイヤーを選択</option>
            {choices.map((c) => (
              <option
                key={creativeDesignAddressKey(c.address)}
                value={creativeDesignAddressKey(c.address)}
              >
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          共通の描画指示
          <textarea
            aria-label="共通の描画指示"
            value={styleGuide}
            onChange={(e) => setStyleGuide(e.target.value)}
            maxLength={4000}
          />
        </label>
        <label>
          この部位への指示
          <textarea
            aria-label="この部位への指示"
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            maxLength={4000}
          />
        </label>
        <label>
          <input
            type="checkbox"
            checked={transparent}
            onChange={(e) => setTransparent(e.target.checked)}
          />
          透過背景を必須にする
        </label>
        <button
          disabled={!pin || !target || !instructions.trim()}
          onClick={() =>
            void run(async (signal) => {
              const address = choices.find(
                (c) => creativeDesignAddressKey(c.address) === target,
              )?.address;
              if (!address) throw Error('生成対象を選択してください。');
              await project.save();
              if (signal.aborted) return;
              const next = await prepareCreativeLayerGeneration(project, card, frame.id, address, {
                context: world ? undefined : connection?.context,
                instructions,
                styleGuide,
                transparent,
                mayRead: connection?.mayRead,
                mayEditShared: connection?.mayEditShared,
              });
              if (!signal.aborted) {
                setPreparation(next);
                setProposalId('');
                setUpload('');
              }
            })
          }
        >
          保存して生成依頼を準備
        </button>
      </fieldset>
      {preparation && world && (
        <CreativeWorldRunPanel
          key={preparation.request.id}
          connection={world}
          native={preparation}
          editor={editor}
          readOnly={readOnly}
          sceneId={connection?.sceneId}
          changed={changed}
          onError={onError}
          restart={() => {
            setPreparation(undefined);
            setUpload('');
          }}
        />
      )}
      {preparation && !world && (
        <fieldset disabled={readOnly || busy}>
          <legend>共通参照と結果の確認</legend>
          <p>
            基準版：<code>{preparation.request.rough.versionId}</code> /{' '}
            {preparation.request.target.pixelWidth}×{preparation.request.target.pixelHeight}px
          </p>
          <img
            className="creative-upload"
            alt="生成に使う共通ラフ"
            src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(preparation.request.rough.svg)}`}
          />
          <button
            onClick={() =>
              void run(() => {
                preparation.assertCurrent();
                downloadBlob(
                  'creative-layer-request.json',
                  new Blob([JSON.stringify(preparation.request, null, 2)], {
                    type: 'application/json',
                  }),
                );
              })
            }
          >
            生成依頼JSONを書き出す
          </button>
          <button
            onClick={() =>
              void run(() => {
                preparation.assertCurrent();
                downloadBlob(
                  'creative-rough.svg',
                  new Blob([preparation.request.rough.svg], { type: 'image/svg+xml' }),
                );
              })
            }
          >
            共通ラフSVGを書き出す
          </button>
          {connection?.provider ? (
            <button
              onClick={() =>
                void run(async (signal) => {
                  const next = await generateCreativeLayer(
                    preparation,
                    connection.provider!,
                    signal,
                  );
                  if (!signal.aborted) setProposalId(next.id);
                })
              }
            >
              Hostへ生成を依頼
            </button>
          ) : (
            <p>生成Hostは未接続です。依頼と共通ラフを外部サービスへ渡し、結果PNGを読み込めます。</p>
          )}
          {resultFile}
          <p>出典・利用条件は上の画像欄へ新しく入力してください。</p>
          <button
            disabled={!upload || !source.trim() || !license.trim()}
            onClick={() =>
              void run(() => {
                const next = preparation.preview({
                  requestId: preparation.request.id,
                  src: upload,
                  source,
                  license,
                });
                setProposalId(next.id);
              })
            }
          >
            清書結果をプレビュー
          </button>
          <button
            onClick={() => {
              setPreparation(undefined);
              setUpload('');
            }}
          >
            生成依頼を作り直す
          </button>
        </fieldset>
      )}
      {busy && <button onClick={() => active.current?.abort()}>処理を中止</button>}
      {notice && <p role="status">{notice}</p>}
      {proposal && (
        <section aria-label="清書結果の比較">
          <p>
            {proposal.stale
              ? '古い変更案です。生成依頼を作り直してください。'
              : '未適用：重なりや絵柄を確認してください。共有部品の変更は全候補へ反映されます。'}
          </p>
          <div className="creative-proposal-images">
            <figure>
              <figcaption>変更前</figcaption>
              <img alt="清書の変更前" src={svg(proposal.preview.baseContent)} />
            </figure>
            <figure>
              <figcaption>変更後</figcaption>
              <img alt="清書の変更後" src={svg(proposal.preview.content)} />
            </figure>
          </div>
          <button
            disabled={readOnly || busy || proposal.stale}
            onClick={() =>
              void run(() => {
                editor.acceptProposal(proposal.id);
                setPreparation(undefined);
                setUpload('');
              })
            }
          >
            清書結果を適用
          </button>
          <button
            disabled={busy}
            onClick={() =>
              void run(() => {
                editor.rejectProposal(proposal.id);
                setProposalId('');
              })
            }
          >
            清書結果を却下
          </button>
        </section>
      )}
      {world && (
        <CreativeWorldHistoryPanel
          connection={world}
          artifactId={editor.id}
          frameId={frame.id}
          onError={onError}
        />
      )}
    </details>
  );
}

import { useState } from 'react';
import { Dialog } from '@editor-platform/editor-ui';
import type { ElementAddress } from '@editor-platform/editor-core';
import { isFile, isReview } from '@editor-platform/review-surfaces/model';
import {
  annotationSource,
  applySharedTemplate,
  authorReusableViewPreset,
  localTemplateSnapshot,
  prepareReusableAnnotation,
  previewSharedTemplate,
  retainedViewPreset,
  type PreparedReusableAnnotation,
  type PrivateViewSettings,
  type ReusableViewPayload,
} from '@editor-platform/templates';
import type { TemplateGalleryProps } from './gallery';

export function ReusableAnnotationDialog(props: {
  target: NonNullable<TemplateGalleryProps['target']>;
  settings: PrivateViewSettings;
  address: ElementAddress;
  readOnly: boolean;
  onClose(): void;
  onApply(prepared: PreparedReusableAnnotation): void | Promise<void>;
}) {
  const { target } = props;
  const defaults = props.settings.$annotation as ReusableViewPayload['annotation'] | undefined;
  const [body, setBody] = useState(defaults?.body ?? '');
  const [prepared, setPrepared] = useState<{ value: PreparedReusableAnnotation; token?: string }>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const sourceName = isFile(target.content)
    ? target.content.name
    : isReview(target.content)
      ? target.content.files.find((f) => f.id === props.address.elementId)?.name
      : '';
  return (
    <Dialog title="設定から注釈を作成" onClose={props.onClose}>
      <div className="tp-author">
        <p>対象: {sourceName}</p>
        {error && <p role="alert">{error}</p>}
        <label>
          注釈の本文
          <textarea
            maxLength={20000}
            value={body}
            onChange={(e) => {
              setBody(e.target.value);
              setPrepared(undefined);
            }}
          />
        </label>
        <button
          disabled={busy || props.readOnly || !body.trim()}
          onClick={() =>
            void run(async () => {
              if (target.domain !== 'review' && target.domain !== 'file')
                throw new Error('Review / Viewerで原本を選択してください。');
              await target.shared?.flush();
              if (target.shared?.pendingCount)
                throw new Error('同期完了後にプレビューしてください。');
              const state =
                target.shared?.confirmed ??
                localTemplateSnapshot(target.artifactId, target.domain, target.content);
              if (!isReview(state.content) && !isFile(state.content))
                throw new Error('原本が変更されました。');
              const retained = await retainedViewPreset(props.settings);
              const preset =
                retained ??
                (await authorReusableViewPreset({
                  domain: target.domain,
                  name: 'コピーした注釈設定',
                  settings: props.settings,
                  annotation: defaults,
                }));
              const value = await prepareReusableAnnotation({
                state,
                identity: target.shared?.adapter.identity ?? {
                  actorId: 'local-user',
                  clientId: 'local',
                  sessionId: 'local',
                },
                definition: preset.definition,
                closure: preset.closure,
                source: await annotationSource(target.artifactId, state.content, props.address),
                body,
                mode: retained?.adoption.mode,
              });
              const preview = target.shared
                ? await previewSharedTemplate(value.application, target.shared)
                : undefined;
              setPrepared({ value, token: preview?.token });
            })
          }
        >
          注釈をプレビュー
        </button>
        {prepared && (
          <section aria-label="注釈の適用プレビュー">
            <p
              style={{
                borderLeft: `4px solid ${prepared.value.annotation.color ?? '#336699'}`,
                paddingLeft: 8,
              }}
            >
              {prepared.value.annotation.comments[0].body}
            </p>
            <dl>
              <dt>原本の版</dt>
              <dd>{prepared.value.source.revisionId}</dd>
              <dt>選択範囲</dt>
              <dd>{regionLabel(prepared.value.source.address)}</dd>
            </dl>
            <details>
              <summary>原本の照合情報</summary>
              <p className="tp-source-hash">SHA-256: {prepared.value.source.hash}</p>
            </details>
            <p>この原本・版・範囲に、自分の新しい注釈を作成します。</p>
            <button
              disabled={busy || props.readOnly}
              onClick={() =>
                void run(async () => {
                  if (target.shared)
                    await applySharedTemplate(
                      prepared.value.application,
                      target.shared,
                      prepared.token!,
                    );
                  await props.onApply(prepared.value);
                  props.onClose();
                })
              }
            >
              この範囲に注釈を作成
            </button>
          </section>
        )}
      </div>
    </Dialog>
  );
}
function regionLabel(address: ElementAddress) {
  const region = address.region;
  if (region?.type === 'lines')
    return `${region.side === 'old' ? '旧版' : region.side === 'new' ? '新版' : '原本'} ${region.start}–${region.end}行`;
  if (region?.type === 'page')
    return `${region.page}ページ${region.bounds ? ` (${Math.round(region.bounds.x)}, ${Math.round(region.bounds.y)})` : ''}`;
  if (region?.type === 'canvas')
    return `画像 (${Math.round(region.x)}, ${Math.round(region.y)}) ${Math.round(region.width)} × ${Math.round(region.height)}`;
  return '原本上の範囲';
}

import { useState } from 'react';
import { exportSlideSvg, isDeck } from '@editor-platform/slide';
import { exportWhiteboardSvg, isWhiteboard } from '@editor-platform/whiteboard';
import { exportDesignSvg, isDesign } from '@editor-platform/design';
import { exportHtml, isDocument } from '@editor-platform/document';
import { DataSurface, isStructuredData } from '@editor-platform/structured-data';
import type { NativeContent, Domain, InputValue } from '@editor-platform/templates';
export function TemplatePreview({
  domain,
  content,
  compact = false,
  settings,
}: {
  domain: Domain;
  content?: NativeContent;
  compact?: boolean;
  settings?: Record<string, InputValue>;
}) {
  const [page, setPage] = useState(() => {
    if (domain !== 'slide' || !content || !isDeck(content) || content.slides[0]?.objects.length)
      return 0;
    return Math.max(
      0,
      content.slides.findIndex((s) => s.objects.length > 0),
    );
  });
  const [scope, setScope] = useState('');
  const [zoom, setZoom] = useState(100);
  if (!content)
    return (
      <div className="tp-preset-preview">
        <p>表示・style設定のみ。本文や原本は保持します。</p>
        {settings && (
          <dl>
            {Object.entries(settings).map(([key, value]) => (
              <div key={key}>
                <dt>{key}</dt>
                <dd>{String(value)}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    );
  const choices =
    domain === 'whiteboard' && isWhiteboard(content)
      ? (content.sections ?? []).map((s) => ({ id: s.id, label: s.title }))
      : domain === 'design' && isDesign(content)
        ? content.elements
            .filter((e) => e.type === 'frame' && !e.parentId)
            .map((e) => ({ id: e.id, label: e.name }))
        : [];
  const selected = choices.some((c) => c.id === scope) ? scope : '';
  const source =
    domain === 'slide' && isDeck(content)
      ? exportSlideSvg(
          content,
          content.slides[
            compact
              ? content.slides.reduce(
                  (best, p, i, all) =>
                    i > 0 && p.objects.length > all[best].objects.length ? i : best,
                  content.slides.length > 1 ? 1 : 0,
                )
              : Math.min(page, content.slides.length - 1)
          ],
        )
      : domain === 'whiteboard' && isWhiteboard(content)
        ? exportWhiteboardSvg(content, selected ? [selected] : undefined)
        : domain === 'design' && isDesign(content)
          ? exportDesignSvg(content, selected ? [selected] : undefined)
          : undefined;
  return (
    <div
      className={`tp-native-preview ${compact ? 'tp-compact' : ''}`}
      data-preview-domain={domain}
    >
      {!compact && choices.length > 0 && (
        <label>
          表示範囲
          <select
            aria-label="Preview scope"
            value={selected}
            onChange={(e) => setScope(e.target.value)}
          >
            <option value="">全体</option>
            {choices.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {!compact && source && (
        <label>
          拡大{' '}
          <select
            aria-label="Preview zoom"
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
          >
            {[100, 150, 200, 300].map((n) => (
              <option key={n} value={n}>
                {n}%
              </option>
            ))}
          </select>
        </label>
      )}
      <div className={compact ? '' : 'tp-preview-viewport'}>
        <div style={source && !compact ? { width: `${zoom}%` } : undefined}>
          {source ? (
            <img
              alt="テンプレートの実描画"
              src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`}
              style={!compact && zoom > 100 ? { maxHeight: 'none' } : undefined}
            />
          ) : domain === 'document' && isDocument(content) ? (
            <iframe title="文書テンプレートの実描画" sandbox="" srcDoc={exportHtml(content)} />
          ) : domain === 'data' && isStructuredData(content) ? (
            <div className="tp-data-preview">
              <DataSurface
                content={content}
                execute={() => {}}
                select={() => {}}
                readOnly
                layout={{ defaultPanels: { left: false, right: false } }}
              />
            </div>
          ) : null}
        </div>
      </div>
      {!compact && domain === 'slide' && isDeck(content) && content.slides.length > 1 && (
        <div className="tp-preview-navigation">
          <button type="button" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
            前のページ
          </button>
          <span>
            {page + 1} / {content.slides.length}
          </span>
          <button
            type="button"
            disabled={page >= content.slides.length - 1}
            onClick={() => setPage((p) => p + 1)}
          >
            次のページ
          </button>
        </div>
      )}
    </div>
  );
}

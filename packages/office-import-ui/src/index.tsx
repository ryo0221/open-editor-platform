import { useEffect, useMemo, useRef, useState } from 'react';
import { Dialog } from '@editor-platform/editor-ui';
import { clone, type Artifact } from '@editor-platform/artifact-core';
import { exportHtml, isDocument } from '@editor-platform/document/model';
import { exportSlideSvg, isDeck } from '@editor-platform/slide/model';
import {
  importLimits,
  sourceKey,
  type ImportDiagnostic,
  type OfficeImportReport,
} from '@editor-platform/office-import-core/contract';
import type {
  HostArtifactCreationAdapter,
  ReadonlyImport,
} from '@editor-platform/office-import-core/lifecycle';
import { OfficeImportJob } from './job';
import { installImportFonts } from './fonts';
import type { ImportContent, ImportOptions } from './protocol';
import './styles.css';
export type { ImportContent } from './protocol';
export function OfficeImportDialog({
  creation,
  onCreated,
  onClose,
  fontManifestUrl = '/office-fonts/manifest.json',
}: {
  creation: HostArtifactCreationAdapter<ImportContent>;
  onCreated(artifact: Artifact<ImportContent>): void | Promise<void>;
  onClose(): void;
  fontManifestUrl?: string;
}) {
  const [job] = useState(() => new OfficeImportJob());
  const [file, setFile] = useState<File>();
  const [name, setName] = useState('');
  const isWord = /\.docx$/i.test(file?.name ?? '');
  const [options, setOptions] = useState<ImportOptions>({
    unsupported: 'reject',
    fontProfileId: 'noto-cjk-jp-2.004',
    pages: 'all',
    includeHidden: false,
    notes: 'exclude',
  });
  const [pages, setPages] = useState('');
  const [preview, setPreview] = useState<ReadonlyImport<ImportContent>>();
  const [report, setReport] = useState<ReadonlyImport<OfficeImportReport>>();
  const [accepted, setAccepted] = useState(false);
  const [phase, setPhase] = useState<'options' | 'preparing' | 'ready' | 'creating' | 'uncertain'>(
    'options',
  );
  const [error, setError] = useState('');
  const [page, setPage] = useState(0),
    [diagnosticPage, setDiagnosticPage] = useState(0);
  const requestId = useRef(crypto.randomUUID()),
    generation = useRef(0),
    controller = useRef<AbortController | undefined>(undefined),
    removeFonts = useRef<(() => void) | undefined>(undefined),
    materialized = useRef<Artifact<ImportContent> | undefined>(undefined),
    receipt = useRef<Artifact<ImportContent> | undefined>(undefined);
  useEffect(
    () => () => {
      generation.current++;
      controller.current?.abort();
      job.cancel();
      removeFonts.current?.();
    },
    [job],
  );
  const saving = phase === 'creating' || phase === 'uncertain';
  function invalidate() {
    generation.current++;
    controller.current?.abort();
    job.cancel();
    setAccepted(false);
    setPhase('options');
    setError('');
    materialized.current = undefined;
    receipt.current = undefined;
  }
  function change(patch: Partial<ImportOptions>) {
    invalidate();
    setOptions({ ...options, ...patch });
  }
  function close() {
    if (saving && !receipt.current) {
      setError('作成結果を確認しています。同じ内容で再試行して結果を確認してください。');
      return;
    }
    invalidate();
    onClose();
  }
  function cancel() {
    invalidate();
    setReport(undefined);
    setPreview(undefined);
    setError('取り込みを取消しました。Artifactは作成されていません。');
  }
  async function prepare() {
    invalidate();
    const attempt = generation.current;
    setReport(undefined);
    setPreview(undefined);
    setDiagnosticPage(0);
    setPage(0);
    try {
      if (!file) throw Error('PPTXまたはDOCXファイルを選択してください。');
      if (file.size > importLimits.compressedBytes) throw Error('Office file exceeds 32 MiB');
      if (!/\.(pptx|docx)$/i.test(file.name)) throw Error('PPTXまたはDOCXを選択してください。');
      const selected = pages.trim() ? pages.split(',').map((v) => Number(v.trim())) : 'all';
      setPhase('preparing');
      const abort = new AbortController();
      controller.current = abort;
      removeFonts.current?.();
      removeFonts.current = undefined;
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (attempt !== generation.current) return;
      const shared = {
        unsupported: options.unsupported,
        fontProfileId: options.fontProfileId,
        ...(options.exclude?.length ? { exclude: options.exclude } : {}),
        name: name || file.name.replace(/\.(pptx|docx)$/i, ''),
      };
      const pending = job.run(
        isWord
          ? {
              action: 'prepare',
              bytes,
              format: 'docx',
              options: shared,
              requestId: requestId.current,
            }
          : {
              action: 'prepare',
              bytes,
              format: 'pptx',
              options: {
                ...shared,
                pages: selected,
                includeHidden: options.includeHidden,
                notes: options.notes,
              },
              requestId: requestId.current,
            },
      );
      const fonts = installImportFonts(
        new URL(fontManifestUrl, location.href).href,
        abort.signal,
      ).then((dispose) => {
        if (attempt !== generation.current) dispose();
        else removeFonts.current = dispose;
      });
      const [result] = await Promise.all([pending, fonts]);
      if (attempt !== generation.current) return;
      if (result.status !== 'prepared') throw Error('Unexpected import result');
      setPreview(result.preview);
      setReport(result.report);
      setPhase('ready');
    } catch (e) {
      if (attempt !== generation.current) return;
      controller.current?.abort();
      job.cancel();
      setError(e instanceof Error ? e.message : String(e));
      setPhase('options');
    }
  }
  async function create() {
    if (!report) return;
    setPhase('creating');
    setError('');
    try {
      if (!materialized.current) {
        const result = await job.run({
          action: 'materialize',
          consent: {
            planHash: report.planHash,
            acceptedDiagnosticIds: report.diagnostics
              .filter((d) => d.requiresConsent)
              .map((d) => d.id),
          },
        });
        if (result.status !== 'materialized') throw Error('Unexpected import result');
        materialized.current = result.artifact;
      }
      const artifact = materialized.current;
      receipt.current ??= await creation.createIfAbsent(clone(artifact));
      if (
        receipt.current.id !== artifact.id ||
        receipt.current.provenance.officeImport?.fingerprint !==
          artifact.provenance.officeImport?.fingerprint
      )
        throw Error('Creation request conflicts with another input');
      await onCreated(clone(receipt.current));
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      const knownNoCreation =
        e &&
        typeof e === 'object' &&
        'code' in e &&
        ['UNAUTHORIZED', 'request-conflict', 'storage-capability'].includes(String(e.code));
      if (knownNoCreation) materialized.current = undefined;
      setPhase(materialized.current ? 'uncertain' : 'ready');
    }
  }
  const errors = report?.diagnostics.filter((d) => d.disposition === 'blocked') ?? [],
    warnings = report?.diagnostics.filter((d) => d.requiresConsent) ?? [];
  const diagnostics = report?.diagnostics ?? [];
  const content = useMemo(
    () => (preview ? (clone(preview) as ImportContent) : undefined),
    [preview],
  );
  const svg = useMemo(
    () =>
      content && isDeck(content)
        ? exportSlideSvg(content, content.slides[Math.min(page, content.slides.length - 1)])
        : undefined,
    [content, page],
  );
  const documentHtml = useMemo(() => {
    if (!content || !isDocument(content)) return undefined;
    // Only our escaped native renderer output reaches the preview. Word HTML/XML
    // is never inserted or executed. Original Office bytes are not a render source.
    const html = exportHtml(content);
    return html.slice(html.indexOf('<body>') + 6, html.lastIndexOf('</body>'));
  }, [content]);
  function exclusion(d: ReadonlyImport<ImportDiagnostic>, checked: boolean) {
    const key = sourceKey(d.address);
    change({
      exclude: checked
        ? [...new Set([...(options.exclude ?? []), key])]
        : (options.exclude ?? []).filter((v) => v !== key),
    });
  }
  function downloadReport() {
    if (!report) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = 'office-import-report.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <Dialog title="Office import" onClose={close}>
      <div className="office-import">
        <p>Office資料を確認して、新しい編集可能なArtifactを作成します。</p>
        <fieldset disabled={saving || phase === 'preparing'}>
          <legend>取り込み範囲</legend>
          <label>
            Office file
            <input
              aria-label="Office file"
              type="file"
              accept=".pptx,.docx"
              onChange={(e) => {
                invalidate();
                setFile(e.target.files?.[0]);
                setName(e.target.files?.[0]?.name.replace(/\.(pptx|docx)$/i, '') ?? '');
                setReport(undefined);
                setPreview(undefined);
                setOptions({ ...options, exclude: [] });
                requestId.current = crypto.randomUUID();
              }}
            />
          </label>
          <label>
            Artifact name
            <input
              aria-label="Imported artifact name"
              value={name}
              onChange={(e) => {
                invalidate();
                setName(e.target.value);
              }}
            />
          </label>
          {!isWord && (
            <>
              <label>
                ページ番号（空欄は全ページ、カンマ区切り）
                <input
                  aria-label="Import pages"
                  value={pages}
                  onChange={(e) => {
                    invalidate();
                    setPages(e.target.value);
                  }}
                  placeholder="1,2,3"
                />
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={options.includeHidden}
                  onChange={(e) => change({ includeHidden: e.target.checked })}
                />
                Hidden slidesを含める
              </label>
              <label>
                Speaker notes
                <select
                  aria-label="Import notes"
                  value={options.notes}
                  onChange={(e) => change({ notes: e.target.value as 'include' | 'exclude' })}
                >
                  <option value="exclude">除外</option>
                  <option value="include">本文テキストを含める</option>
                </select>
              </label>
            </>
          )}
          {isWord && (
            <p>文書本文全体を取り込みます。段落や表は編集可能な内容として配置されます。</p>
          )}
          <label>
            書式の差
            <select
              aria-label="Import conversion policy"
              value={options.unsupported}
              onChange={(e) =>
                change({ unsupported: e.target.value as ImportOptions['unsupported'] })
              }
            >
              <option value="reject">近似が必要なら停止</option>
              <option value="review-conversions">変換結果を確認して承認</option>
            </select>
          </label>
          <p>
            固定フォント: Noto Sans CJK JP 2.004。原本のコメント・履歴・作成者情報は取り込みません。
          </p>
        </fieldset>
        {error && <p role="alert">{error}</p>}
        {phase === 'preparing' && <p role="status">取り込みを解析しています…</p>}
        {report && (
          <>
            <p role="status">
              {phase === 'options'
                ? '設定が変わりました。プレビューを再作成してください。'
                : `停止 ${errors.length} / 確認 ${warnings.length} / 対応付け ${report.mapping.length}`}
            </p>
            <details>
              <summary>原本と変換情報</summary>
              <dl>
                <dt>SHA-256</dt>
                <dd>{report.sourceHash}</dd>
                <dt>Profile</dt>
                <dd>{report.profile}</dd>
                <dt>Parser</dt>
                <dd>
                  {report.parser.name} {report.parser.version} / {report.parser.adapterVersion}
                </dd>
              </dl>
            </details>
            {svg && (
              <div
                className="office-import-preview"
                aria-label="Native import preview"
                dangerouslySetInnerHTML={{ __html: svg }}
              />
            )}
            {documentHtml !== undefined && (
              <div
                className="office-import-preview office-import-document"
                aria-label="Native import preview"
                onClick={(event) => {
                  if ((event.target as Element).closest('a')) event.preventDefault();
                }}
              >
                <article dangerouslySetInnerHTML={{ __html: documentHtml }} />
              </div>
            )}
            {content && isDeck(content) && content.slides.length > 1 && (
              <div className="office-import-actions">
                <button disabled={!page} onClick={() => setPage(page - 1)}>
                  前のページ
                </button>
                <span>
                  {page + 1}/{content.slides.length}
                </span>
                <button
                  disabled={page >= content.slides.length - 1}
                  onClick={() => setPage(page + 1)}
                >
                  次のページ
                </button>
              </div>
            )}
            <div className="office-import-diagnostics">
              <ul>
                {diagnostics.slice(diagnosticPage * 20, diagnosticPage * 20 + 20).map((d) => (
                  <li key={d.id} data-disposition={d.disposition}>
                    <strong>
                      {d.disposition}: {d.code}
                    </strong>
                    <p>{d.message}</p>
                    <small>
                      {d.address.part} {d.address.path}
                    </small>
                    {d.excludable && (
                      <label>
                        <input
                          aria-label={`Exclude ${d.code} ${d.address.path}`}
                          type="checkbox"
                          disabled={saving || phase === 'preparing'}
                          checked={options.exclude?.includes(sourceKey(d.address)) ?? false}
                          onChange={(e) => exclusion(d, e.target.checked)}
                        />
                        この対象を明示的に除外する
                      </label>
                    )}
                  </li>
                ))}
              </ul>
            </div>
            {diagnostics.length > 20 && (
              <div className="office-import-actions">
                <button
                  disabled={!diagnosticPage}
                  onClick={() => setDiagnosticPage(diagnosticPage - 1)}
                >
                  前の診断
                </button>
                <span>
                  {diagnosticPage + 1}/{Math.ceil(diagnostics.length / 20)}
                </span>
                <button
                  disabled={(diagnosticPage + 1) * 20 >= diagnostics.length}
                  onClick={() => setDiagnosticPage(diagnosticPage + 1)}
                >
                  次の診断
                </button>
              </div>
            )}
            <button onClick={downloadReport}>Download import report</button>
            <label>
              <input
                type="checkbox"
                aria-label="Accept import conversions"
                disabled={phase !== 'ready' || !!errors.length}
                checked={accepted}
                onChange={(e) => setAccepted(e.target.checked)}
              />
              このプレビューと、列挙された書式の差・除外内容を確認しました。
            </label>
          </>
        )}
        <div className="office-import-actions">
          {phase === 'preparing' ? (
            <button key="cancel" onClick={cancel}>
              Cancel import
            </button>
          ) : (
            <button key="prepare" disabled={!file || saving} onClick={() => void prepare()}>
              Prepare import preview
            </button>
          )}
          <button
            disabled={
              (phase !== 'ready' && phase !== 'uncertain') ||
              (phase === 'ready' && (!accepted || !!errors.length))
            }
            onClick={() => void create()}
          >
            {phase === 'uncertain' ? 'Retry artifact creation' : 'Create imported artifact'}
          </button>
          {phase === 'creating' && <span role="status">Artifactを作成しています…</span>}
        </div>
      </div>
    </Dialog>
  );
}

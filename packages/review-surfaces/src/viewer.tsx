import { useMemo, useRef, useState } from 'react';
import { FolderOpen, Download } from 'lucide-react';
import type { PageViewport } from 'pdfjs-dist';
import type {
  Annotation,
  Bounds,
  EditorCommand,
  ElementAddress,
  Region,
} from '@editor-platform/editor-core';
import { EditorLayout, IconButton, type EditorLayoutProps } from '@editor-platform/editor-ui';
import type { FileContent } from './model';
import { csvMatches, isCsv, parseCsv } from './csv';
import { CsvTableView } from './viewer-csv';
import { usePdfTextIndex } from './pdf-text';
import { usePdf } from './pdf';
import {
  annotationOverlays,
  downloadOriginal,
  fileLines,
  imageTransform,
  lineMatches,
  regionBounds,
  renderedBounds,
  shownFileSize,
  type FileTool,
  type FileViewSettings,
} from './viewer-utils';
import {
  useContentReset,
  useFocusAddress,
  usePdfSearch,
  useRegionDrag,
  useSelectionReset,
  useSettingsZoom,
  useZoomViewport,
} from './viewer-hooks';
import { FileInspector, PdfPageNavigator, TextFileNavigator } from './viewer-panels';
import {
  AssetToolbarControls,
  PdfToolbarControls,
  SampleFilesMenu,
  TextToolbarControls,
} from './viewer-toolbar';
import { ReplaceSourceDialog, useSourceReplacement } from './viewer-replace';
import {
  AssetScroller,
  ImagePageView,
  PdfPageView,
  PdfTextNotices,
  RegionOverlays,
  TextFileView,
} from './viewer-stage';
import './styles.css';
export { downloadOriginal } from './viewer-utils';
export function FileSurface({
  content,
  execute,
  select,
  readOnly = false,
  layout,
  annotations: suppliedAnnotations = [],
  focusAddress,
  viewSettings,
  onViewSettingsChange,
  onSelectionClear,
  onOpenAsNew,
  onRemapAnnotation,
}: {
  content: FileContent;
  onSelectionClear?(): void;
  onOpenAsNew?(source: FileContent): Promise<void> | void;
  onRemapAnnotation?(id: string, fileId: string, region: Region): void;

  viewSettings?: FileViewSettings;
  onViewSettingsChange?(patch: FileViewSettings): void;
  execute: (cmd: EditorCommand<FileContent>) => void | boolean;
  select: (id: string, region?: Region) => void;
  readOnly?: boolean;
  layout?: Partial<EditorLayoutProps>;
  annotations?: Annotation[];
  focusAddress?: ElementAddress;
}) {
  const [page, setPage] = useState(1),
    [rotation, setRotation] = useState(0),
    [tool, setTool] = useState<FileTool>('pan');
  const [error, setError] = useState(''),
    [imageSize, setImageSize] = useState({ width: 800, height: 600 });
  const [viewport, setViewport] = useState<PageViewport>(),
    [natural, setNatural] = useState({ width: 612, height: 792 });
  const [region, setRegion] = useState<Region>(),
    [drag, setDrag] = useState<Bounds>(),
    [wrap, setWrap] = useState(false),
    [csvLayout, setCsvLayout] = useState<'table' | 'text'>('table'),
    [targetLine, setTargetLine] = useState<number>();
  const replace = useSourceReplacement({ content, readOnly, execute, onOpenAsNew, setError });
  useSelectionReset(content, () => {
    setRegion(undefined);
    setDrag(undefined);
    setPage(1);
    onSelectionClear?.();
  });
  const annotations = viewSettings?.annotations === false ? [] : suppliedAnnotations;
  const { zoom, setZoom, fitMode, setFitMode } = useSettingsZoom(content, viewSettings);
  const scroller = useRef<HTMLDivElement>(null),
    upload = useRef<HTMLInputElement>(null),
    imageGroup = useRef<SVGGElement>(null);
  const isPdf = content.mime === 'application/pdf',
    isImage = content.mime.startsWith('image/'),
    csv = !isPdf && !isImage && isCsv(content.mime, content.name);
  const { pdf, error: pdfError } = usePdf(content);
  const textIndex = usePdfTextIndex(pdf);
  const search = usePdfSearch(textIndex.pages);
  const { query, setQuery, pdfSearch } = search;
  const lines = useMemo(() => fileLines(content, isPdf, isImage), [content.data, isPdf, isImage]);
  const table = useMemo(
    () => (csv && csvLayout === 'table' ? parseCsv(content.data) : undefined),
    [csv, csvLayout, content.data],
  );
  // The table searches the decoded cells it shows; the text view searches the source lines.
  const matches = useMemo(
    () => (table ? csvMatches(table.records, query) : lineMatches(lines, query)),
    [table, lines, query],
  );
  const shownSize = shownFileSize(isPdf, natural, imageSize, rotation);
  useContentReset(
    content,
    isImage,
    () => {
      setPage(1);
      setRegion(undefined);
      setRotation(0);
      setError('');
      search.reset();
    },
    { onSize: setImageSize, onError: setError },
  );
  const changeZoom = useZoomViewport({
    scroller,
    zoom,
    setZoom,
    fitMode,
    setFitMode,
    settingsFit: viewSettings?.fit,
    shownSize,
    isPdf,
    isImage,
    onViewSettingsChange,
  });
  useFocusAddress(focusAddress, content.id, pdf?.numPages, { setRegion, setPage, setTargetLine });
  function choose(r: Region) {
    setRegion(r);
    select(content.id, r);
  }
  const regionEvents = useRegionDrag({
    tool,
    isPdf,
    viewport,
    imageGroup,
    imageSize,
    page,
    setDrag,
    choose,
  });
  const rectangle = (r: Region | undefined) => regionBounds(r, { isImage, isPdf, imageSize, page });
  const renderedRect = (b: Bounds) => renderedBounds(b, isPdf, viewport);
  const regions = annotationOverlays(annotations, content.id, rectangle);
  const active = drag ?? rectangle(region);
  const overlays = <RegionOverlays regions={regions} active={active} renderedRect={renderedRect} />;
  function showPage(next: number) {
    setPage(next);
    setRegion(undefined);
  }
  function focusRegion(r: Region) {
    if (r.type === 'page') setPage(r.page);
    if (r.type === 'lines') setTargetLine(r.start - 1);
    choose(r);
  }
  function nextPdfMatch() {
    const next = search.advance();
    setPage(next.page);
    setTool('text');
  }
  function fit(mode: 'page' | 'width') {
    setFitMode(mode);
    onViewSettingsChange?.({ fit: mode });
  }
  const isAsset = isPdf || isImage;
  return (
    <EditorLayout
      viewKey="file"
      leftLabel="File navigator"
      inspectorLabel="File inspector"
      left={
        isPdf ? (
          <PdfPageNavigator pdf={pdf} page={page} onPage={showPage} />
        ) : (
          <TextFileNavigator
            name={content.name}
            isImage={isImage}
            lines={lines}
            matches={matches}
            onLine={setTargetLine}
          />
        )
      }
      inspector={
        <FileInspector
          content={content}
          isPdf={isPdf}
          isImage={isImage}
          pdf={pdf}
          imageSize={imageSize}
          region={region}
          active={active}
          annotations={annotations}
          readOnly={readOnly}
          onFocusAnnotation={focusRegion}
          onRemapAnnotation={onRemapAnnotation}
        />
      }
      toolbar={
        <>
          <IconButton
            icon={FolderOpen}
            label="Replace source"
            disabled={readOnly}
            onClick={replace.begin}
          />
          {isPdf && (
            <PdfToolbarControls
              query={query}
              onQueryChange={search.changeQuery}
              matchCount={pdfSearch.matches.length}
              truncated={pdfSearch.truncated}
              onNextMatch={nextPdfMatch}
              pdf={pdf}
              page={page}
              onPage={setPage}
              onCommitPage={(v) =>
                showPage(Math.max(1, Math.min(pdf?.numPages ?? 1, Number(v) || 1)))
              }
            />
          )}
          {isAsset ? (
            <AssetToolbarControls
              isPdf={isPdf}
              zoom={zoom}
              onZoom={(next) => changeZoom(next)}
              onFit={fit}
              onRotate={() => setRotation((rotation + 90) % 360)}
              tool={tool}
              onTool={setTool}
              onSelectPage={() => choose({ type: 'page', page })}
            />
          ) : (
            <TextToolbarControls
              query={query}
              onQueryChange={setQuery}
              hasMatches={matches.length > 0}
              onNextMatch={() =>
                setTargetLine(matches.find((n) => n > (targetLine ?? -1)) ?? matches[0])
              }
              wrap={wrap}
              onWrapChange={setWrap}
              csvLayout={csv ? csvLayout : undefined}
              onCsvLayoutChange={setCsvLayout}
            />
          )}
          <span className="ep-spacer" />
          <IconButton
            icon={Download}
            label="Download original file"
            onClick={() => downloadOriginal(content)}
          />
          <SampleFilesMenu readOnly={readOnly} execute={execute} />
        </>
      }
      {...layout}
    >
      <div className="ep-file-body">
        <input
          ref={upload}
          hidden
          type="file"
          aria-label="Open file"
          accept="image/*,text/*,.log,.md,.csv,.pdf"
          disabled={readOnly}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void replace.openFile(file);
            e.target.value = '';
          }}
        />
        {isPdf && <PdfTextNotices truncated={pdfSearch.truncated} textIndex={textIndex} />}
        {replace.open && (
          <ReplaceSourceDialog
            content={content}
            annotations={suppliedAnnotations}
            encoding={replace.encoding}
            replacement={replace.replacement}
            error={error}
            readOnly={readOnly}
            canOpenAsNew={Boolean(onOpenAsNew)}
            onEncodingChange={replace.changeEncoding}
            onChooseFile={() => upload.current?.click()}
            onConfirm={replace.confirm}
            onOpenAsNew={replace.openAsNew}
            onClose={replace.close}
          />
        )}
        {(error || pdfError) && (
          <p role="alert" className="ep-file-error">
            {error || pdfError}{' '}
            <button onClick={() => downloadOriginal(content)}>Download original</button>
          </p>
        )}
        {isAsset ? (
          <AssetScroller scrollerRef={scroller} tool={tool}>
            {isPdf ? (
              pdf ? (
                <PdfPageView
                  pdf={pdf}
                  page={page}
                  zoom={zoom}
                  rotation={rotation}
                  viewport={viewport}
                  tool={tool}
                  query={query}
                  selectedMatch={search.selectedMatch}
                  regionEvents={regionEvents}
                  overlays={overlays}
                  onViewport={(v, n) => {
                    setViewport(v);
                    setNatural(n);
                  }}
                  onError={setError}
                />
              ) : (
                !pdfError && <p>Rendering PDF…</p>
              )
            ) : (
              <ImagePageView
                src={content.data}
                shownSize={shownSize}
                imageSize={imageSize}
                zoom={zoom}
                transform={imageTransform(rotation, imageSize)}
                imageGroupRef={imageGroup}
                regionEvents={regionEvents}
                overlays={overlays}
              />
            )}
          </AssetScroller>
        ) : table ? (
          <CsvTableView
            records={table.records}
            columns={table.columns}
            query={query}
            targetLine={targetLine}
            region={region}
            onChoose={choose}
          />
        ) : (
          <TextFileView
            lines={lines}
            wrap={wrap}
            query={query}
            targetLine={targetLine}
            region={region}
            onChoose={choose}
          />
        )}
      </div>
    </EditorLayout>
  );
}

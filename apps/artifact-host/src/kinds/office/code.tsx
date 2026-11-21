import { useRef, useState } from 'react';
import type { ArtifactEditor } from '@editor-platform/editor-host';
import { domainExecute } from '../../model';
import { isCode, codeSource, type HostContent } from '../../content';
import { compileProject } from '../../compiler';
import { PreviewFrame } from '../../PreviewFrame';

/** The Host's own Code view, used when the Host supplies no `codeSurface`. */
export function CodeView({
  host,
  previewDocument,
}: {
  host: ArtifactEditor<HostContent>;
  previewDocument: string;
}) {
  const { content, readOnly } = host.snapshot;
  const [project, setProject] = useState<ReturnType<typeof compileProject>>(),
    [error, setError] = useState('');
  const caret = useRef<[number, number]>([0, 0]);
  if (!isCode(content)) return null;
  return (
    <div className="host-code">
      <label>
        React TSXソース
        <textarea
          aria-label="React TSXソース"
          readOnly={readOnly}
          value={content.source}
          maxLength={150000}
          onSelect={(e) => {
            const next: [number, number] = [
              e.currentTarget.selectionStart,
              e.currentTarget.selectionEnd,
            ];
            if (next.some((value, i) => value !== caret.current[i])) host.breakHistoryGroup();
            caret.current = next;
          }}
          onBlur={() => host.flushInputs()}
          onChange={(e) => {
            caret.current = [e.currentTarget.selectionStart, e.currentTarget.selectionEnd];
            try {
              domainExecute(host, isCode)(codeSource(e.target.value));
              setError('');
            } catch (e) {
              setError(String(e));
            }
          }}
        />
      </label>
      <button
        onClick={() => {
          try {
            host.flushInputs();
            setProject(compileProject({ [content.filename]: content.source }, content.filename));
            setError('');
          } catch (e) {
            setError(String(e));
          }
        }}
      >
        隔離プレビューを実行
      </button>
      {error && <p role="alert">{error}</p>}
      {project && (
        <PreviewFrame
          project={project}
          previewDocument={previewDocument}
          title="Code隔離プレビュー"
        />
      )}
    </div>
  );
}

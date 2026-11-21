import { useState } from 'react';
import { DesignSurface } from '@editor-platform/design';
import { designKind } from '@editor-platform/design/kind';
import {
  isDesign,
  isDesignWithPaths,
  updateElement,
  type DesignContent,
} from '@editor-platform/design/model';
import { exportDesignReact, acceptDesignConversion } from '@editor-platform/design-react-core';
import { domainExecute } from '../../model';
import { nativeResolution } from '../../content';
import { compileProject } from '../../compiler';
import { PreviewFrame } from '../../PreviewFrame';
import { artifactSurface, type ToolsProps } from '../surface-kind';

function compileDesignPreview(content: DesignContent, files: Record<string, string>) {
  const pages = content.web?.pages;
  const page = pages?.find((p) => p.path === '/') ?? pages?.[0];
  if (!page) throw Error('Designに宣言されたページがありません。');
  return compileProject(files, `${page.symbol}.tsx`, page.symbol);
}

function DesignTools({ host, previewDocument, onError }: ToolsProps) {
  const { content, readOnly } = host.snapshot;
  const [project, setProject] = useState<ReturnType<typeof compileProject>>();
  if (!isDesign(content)) return null;
  const title = content.elements.find((e) => e.id === 'product-heading');
  return (
    <div className="host-design-tools">
      {title && (
        <label>
          ページ見出し
          <input
            aria-label="ページ見出し"
            value={title.text}
            readOnly={readOnly}
            onChange={(e) =>
              domainExecute(
                host,
                isDesignWithPaths,
              )(updateElement(title.id, { text: e.target.value }))
            }
          />
        </label>
      )}
      <button
        disabled={readOnly}
        onClick={() => {
          try {
            host.flushInputs();
            const current = host.snapshot.content;
            if (!isDesign(current)) throw Error('Not native Design');
            const bundle = exportDesignReact(current, nativeResolution);
            const compiled = compileDesignPreview(current, bundle.files);
            domainExecute(host, isDesignWithPaths)(acceptDesignConversion(bundle));
            setProject(compiled);
          } catch (e) {
            onError(e);
          }
        }}
      >
        React生成を採用・プレビュー
      </button>
      {project && (
        <PreviewFrame
          project={project}
          previewDocument={previewDocument}
          title="Designから生成したReact"
        />
      )}
    </div>
  );
}

export const designSurface = artifactSurface(designKind, {
  Surface: ({ host, content, readOnly, env }) => (
    <DesignSurface
      content={content}
      readOnly={readOnly}
      execute={domainExecute(host, isDesignWithPaths)}
      select={env.select}
      layout={env.layout}
    />
  ),
  Tools: DesignTools,
  // A saved Design is reused as React: the Host shows what it compiles to.
  reusePreview(content) {
    if (!isDesign(content)) return undefined;
    const bundle = exportDesignReact(content, nativeResolution);
    return compileDesignPreview(content, bundle.files);
  },
});

import { SlideSurface } from '@editor-platform/slide';
import { exportSlideSvg, type SlideContent } from '@editor-platform/slide/model';
import { OfficeExportHost } from '@editor-platform/office-export-ui/host';
import type { Artifact } from '@editor-platform/artifact-core';
import { domainExecute } from '../../model';
import { isStaticSlide, type HostContent } from '../../content';
import type { ArtifactSurfaceProps } from '../surface-kind';

const officeRefusal = 'Office出力はこのHostの対象外です。SVGをご利用ください。';

export function SlideView({ host, content, readOnly, env }: ArtifactSurfaceProps<SlideContent>) {
  return (
    <OfficeExportHost
      formats={{ pptx: false, reason: officeRefusal }}
      capture={() => {
        throw Error(officeRefusal);
      }}
    >
      <SlideSurface
        content={content}
        readOnly={readOnly}
        execute={domainExecute(host, isStaticSlide)}
        select={(ids, region) => env.select(Array.isArray(ids) ? ids : [ids], region)}
        layout={env.layout}
      />
    </OfficeExportHost>
  );
}

/** The first page of a saved deck, in the Artifact list. */
export function SavedSlidePreview({
  artifact,
  content,
}: {
  artifact: Artifact<HostContent>;
  content: SlideContent;
}) {
  if (artifact.versions.length === 0 || content.slides.length === 0) return null;
  return (
    <figure className="host-saved-slide">
      <img
        alt={'保存した企画書 ' + artifact.id}
        src={
          'data:image/svg+xml;charset=utf-8,' +
          encodeURIComponent(exportSlideSvg(content, content.slides[0]))
        }
      />
      <figcaption>{content.slides.length} pages · 保存したnative内容のプレビュー</figcaption>
    </figure>
  );
}

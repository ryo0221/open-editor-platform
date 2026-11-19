import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { r2bParts } from '@editor-platform/cad-core';
import { PartFailure } from './assembly-panel';
import { describeCode } from './controller';

describe("a component's part failure (#847)", () => {
  it('shows the reason, the code and the feature of the part it stopped on', () => {
    // TS-2468
    const { plate } = r2bParts();
    const feature = plate.content.features[0]!;
    const html = renderToStaticMarkup(
      createElement(PartFailure, {
        code: 'result-tolerance',
        featureId: feature.id,
        doc: plate.content,
      }),
    );
    expect(html).toContain(describeCode('result-tolerance'));
    expect(html).toContain(`feature「${feature.name}」（${feature.type}）`);
    expect(html).toContain('<code>result-tolerance</code>');
    // A failure naming only a body (e.g. `output-limit`) names that body.
    const body = plate.content.bodies[0]!;
    const onBody = renderToStaticMarkup(
      createElement(PartFailure, { code: 'output-limit', featureId: body.id, doc: plate.content }),
    );
    expect(onBody).toContain(`部品のbody「${body.name}」で止まりました。`);
    // Without the part's document (not retained), the reason and the code still show.
    const bare = renderToStaticMarkup(
      createElement(PartFailure, { code: 'part-source-missing@x' }),
    );
    expect(bare).toContain('<code>part-source-missing</code>');
    expect(bare).not.toContain('feature「');
  });
});

import {
  createDesign,
  makeDesignElement,
  makeDesignVector,
  type DesignContent,
} from '@editor-platform/design/model';
import { definitionRef, type TokenSet } from '@editor-platform/reuse-core';
import {
  authorReusableComponent,
  authorReusableStyle,
  authorReusableTokens,
  reusablePrototype,
  reusableParts,
  prepareComponentInsertion,
  applyLocalTemplate,
  localTemplateSnapshot,
  previewArtifactMode,
  saveAsTemplate,
} from '@editor-platform/templates';

export const reuseIdentity = { actorId: 'host', clientId: 'host', sessionId: 'host' };

export const compactArcPaths = [
  ['M0 0A5 5 0 0110 10', 'M0 0A5 5 0 0 1 10 10'],
  ['M0 0a5 5 0 0110 10', 'M0 0a5 5 0 0 1 10 10'],
  ['M2 3A5 5 0 10.5-2', 'M2 3A5 5 0 1 0 .5 -2'],
  ['M0 0A5 5 0 01.5.5', 'M0 0A5 5 0 0 1 .5 .5'],
  ['M0 0A5 5 0 0010 10 5 5 0 1110-10', 'M0 0A5 5 0 0 0 10 10 5 5 0 1 1 10 -10'],
] as const;

export function textLayoutReviewContent(
  mode: 'base' | 'run' | 'padding' | 'fit' | 'siblings',
  nested = false,
): DesignContent {
  const template = { type: 'frame' as const, text: '', fill: 'none' };
  const label = {
    ...makeDesignElement('text'),
    id: 'first',
    text: mode === 'siblings' ? '一\n二\n三\n四' : '確認',
    bounds: { x: 0, y: 0, width: 100, height: 26 },
    typography: {
      fontSize: 12,
      ...(mode === 'base' || mode === 'fit' ? { lineHeight: 3 } : {}),
      ...(mode === 'padding' ? { padding: 10 } : {}),
      ...(mode === 'fit' ? { overflow: 'fit' as const } : {}),
    },
    ...(mode === 'run' ? { runs: [{ text: '確', style: { lineHeight: 3 } }, { text: '認' }] } : {}),
    ...(mode === 'siblings' ? { parentId: 'frame', sizing: 'fill' as const } : {}),
  };
  return {
    ...createDesign(),
    elements: [
      {
        ...makeDesignElement('instance'),
        id: 'instance',
        componentId: nested ? 'outer' : 'inner',
        bounds: { x: 0, y: 0, width: 100, height: 80 },
      },
    ],
    components: [
      {
        id: 'inner',
        name: 'Text layout',
        width: 100,
        height: 80,
        template,
        elements:
          mode === 'siblings'
            ? [
                {
                  ...makeDesignElement('frame'),
                  id: 'frame',
                  text: '',
                  bounds: { x: 0, y: 0, width: 100, height: 80 },
                  layout: {
                    direction: 'column',
                    gap: 0,
                    padding: 0,
                    align: 'start',
                    sizing: 'fixed',
                  },
                },
                label,
                { ...label, id: 'second', text: '確認' },
              ]
            : [label],
      },
      ...(nested
        ? [
            {
              id: 'outer',
              name: 'Outer',
              width: 100,
              height: 80,
              template,
              elements: [
                {
                  ...makeDesignElement('instance'),
                  id: 'nested',
                  componentId: 'inner',
                  bounds: { x: 0, y: 0, width: 100, height: 80 },
                },
              ],
            },
          ]
        : []),
    ],
  };
}

export async function textDiagnosticTemplate() {
  const template = { type: 'frame' as const, text: '', fill: 'none' };
  const content: DesignContent = {
    ...createDesign(),
    elements: [0, 1].map((index) => ({
      ...makeDesignElement('instance'),
      id: `instance-${index}`,
      componentId: `component-${index}`,
      bounds: { x: index * 200, y: 0, width: 100, height: 40 },
    })),
    components: [0, 1].map((index) => ({
      id: `component-${index}`,
      name: `Text ${index}`,
      width: 100,
      height: 40,
      template,
      elements: [
        {
          ...makeDesignElement('frame'),
          id: 'clip',
          text: '',
          clipContent: true,
          bounds: { x: 0, y: 0, width: 100, height: 40 },
        },
        {
          ...makeDesignElement('text'),
          id: 'label',
          text: '確認',
          parentId: 'clip',
          bounds: { x: 0, y: 0, width: 100, height: 26 },
          typography: { fontSize: 12 },
        },
      ],
    })),
  };
  return saveAsTemplate({
    domain: 'design',
    content,
    kind: 'whole',
    name: 'Input diagnostics',
    purpose: 'Review verification',
    category: 'test',
    slots: [0, 1].map((index) => ({
      path: ['components', index, 'elements', 1, 'text'],
      key: index ? 'second' : 'first',
      label: index ? 'Second caption' : 'First caption',
      type: 'text' as const,
    })),
    overflow: { policy: 'expand', minFontSize: 10 },
  });
}

/** Accepted native IDs that collide only after legacy component-ID concatenation. */
export function collidingVectors(): DesignContent {
  const path = 'M-100 -100H1000000V1000000H-100Z';
  const top = {
    ...makeDesignVector({
      ...checkVector,
      viewBox: { x: 10, y: 20, width: 24, height: 12 },
      paths: [path],
    }),
    id: 'a-b',
    fill: '#ff0000',
    stroke: 'none',
    bounds: { x: 0, y: 0, width: 48, height: 24 },
  };
  const part = {
    ...makeDesignVector({
      ...checkVector,
      viewBox: { x: 0, y: 0, width: 12, height: 24 },
      paths: [path],
    }),
    id: 'b',
    fill: '#00ff00',
    stroke: 'none',
    bounds: { x: 0, y: 0, width: 24, height: 24 },
  };
  return {
    ...createDesign(),
    elements: [
      top,
      {
        ...makeDesignElement('instance'),
        id: 'a',
        componentId: 'icons',
        bounds: { x: 80, y: 0, width: 24, height: 24 },
      },
    ],
    components: [
      {
        id: 'icons',
        name: 'Icons',
        width: 24,
        height: 24,
        template: { type: 'frame', text: '', fill: 'none' },
        elements: [part],
      },
    ],
  };
}
export const checkVector = {
  viewBox: { x: 0, y: 0, width: 24, height: 24 },
  paths: ['M20 6 9 17l-5-5'],
  provenance: { source: 'lucide', name: 'Check', version: '1.51.0', license: 'ISC' },
};
export function smallButton(fontSize = 12): DesignContent {
  const frame = {
    ...makeDesignElement('frame'),
    id: 'button',
    text: '',
    bounds: { x: 0, y: 0, width: 144, height: 40 },
  };
  const icon = {
    ...makeDesignVector(checkVector),
    id: 'check',
    parentId: frame.id,
    bounds: { x: 8, y: 8, width: 24, height: 24 },
  };
  const label = {
    ...makeDesignElement('text'),
    id: 'label',
    parentId: frame.id,
    text: '承認する',
    bounds: { x: 38, y: 7, width: 98, height: Math.max(26, fontSize * 1.3 + 8) },
    typography: { fontSize },
  };
  return { ...createDesign(), elements: [frame, icon, label] };
}
export async function styledSmallButton() {
  const tokens: TokenSet = {
    schemaVersion: 1,
    modes: ['light', 'dark'],
    defaultMode: 'light',
    tokens: {
      ink: {
        type: 'color',
        value: { colorSpace: 'srgb', components: [0.2, 0.4, 0.6], alpha: 1 },
        modes: { dark: { colorSpace: 'srgb', components: [1, 0.6, 0.2], alpha: 1 } },
      },
      surface: {
        type: 'color',
        value: { colorSpace: 'srgb', components: [1, 1, 1], alpha: 1 },
        modes: { dark: { colorSpace: 'srgb', components: [0.1, 0.1, 0.1], alpha: 1 } },
      },
    },
  };
  const brand = await authorReusableTokens({ name: 'Button colors', tokens });
  const styles = await Promise.all(
    [
      ['check', { stroke: { token: 'ink' } }],
      ['label', { 'typography.color': { token: 'ink' } }],
      ['button', { fill: { token: 'surface' } }],
    ].map(async ([nativeId, bindings]) => ({
      nativeId: nativeId as string,
      ...(await authorReusableStyle({
        name: String(nativeId),
        style: {
          schemaVersion: 1,
          domain: 'design',
          bindings: bindings as Record<string, { token: string }>,
        },
        tokens: definitionRef(brand.definition),
        dependencies: brand.closure.definitions,
      })),
    })),
  );
  const base = await authorReusableComponent({
    domain: 'design',
    name: 'Small button',
    content: smallButton(),
    ids: [],
    overflow: { minFontSize: 10, policy: 'error' },
  });
  const prototype = reusablePrototype(base.definition);
  const parts = reusableParts(prototype);
  const bindings = styles.map((style) => ({
    partId: base.definition.payload.contract.parts.find(
      (p) =>
        parts.get(p.nativeId)?.id === style.nativeId && parts.get(p.nativeId)?.type !== 'instance',
    )!.id,
    ref: definitionRef(style.definition),
  }));
  return authorReusableComponent({
    domain: 'design',
    name: 'Styled small button',
    content: prototype,
    ids: [],
    contract: base.definition.payload.contract,
    overflow: { minFontSize: 10, policy: 'error' },
    styles: bindings,
    dependencies: [brand.definition, ...styles.map((s) => s.definition)],
  });
}
export async function insertSmallButton() {
  const source = await styledSmallButton();
  const empty = createDesign();
  const prepared = await prepareComponentInsertion({
    ...source,
    state: localTemplateSnapshot('button-artifact', 'design', empty),
    identity: reuseIdentity,
    reuse: 'linked',
    requestId: 'button-insert',
  });
  return { ...source, content: applyLocalTemplate(prepared, empty) as DesignContent };
}
export async function buttonMode(content: DesignContent, mode: 'light' | 'dark') {
  const preview = await previewArtifactMode({
    state: localTemplateSnapshot('button-artifact', 'design', content),
    identity: reuseIdentity,
    mode,
    requestId: 'button-mode-' + mode,
  });
  if (!preview.prepared || preview.conflicts.length) throw new Error('Unexpected mode conflict');
  return applyLocalTemplate(preview.prepared, content) as DesignContent;
}

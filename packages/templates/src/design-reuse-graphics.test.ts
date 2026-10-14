import { expect, it } from 'vitest';
import { contentHash } from '@editor-platform/artifact-core';
import { createDesign, exportDesignSvg, isDesign } from '@editor-platform/design/model';
import { createDeck } from '@editor-platform/slide/model';
import {
  authorReusableComponent,
  prepareComponentInsertion,
  applyLocalTemplate,
  localTemplateSnapshot,
  saveAsTemplate,
  measureTemplateTextFit,
  layoutDiagnostics,
  validateComponentDefinition,
  reusablePrototype,
  builtinTemplates,
  validateDefinition,
  expandTemplate,
} from '@editor-platform/templates';
import {
  buttonMode,
  insertSmallButton,
  smallButton,
  reuseIdentity,
} from '../../../tests/fixtures/design-reuse/content';

it.each([10, 11, 12, 15])(
  'registers and inserts an explicitly configured %ipx Design component',
  async (fontSize) => {
    const content = smallButton(fontSize);
    const before = JSON.stringify(content);
    const source = await authorReusableComponent({
      domain: 'design',
      content,
      ids: [],
      name: 'Button',
      overflow: { minFontSize: 10, policy: 'error' },
    });
    const property = source.definition.payload.contract.properties.find((p) => p.type === 'text')!;
    const empty = createDesign();
    const prepared = await prepareComponentInsertion({
      ...source,
      state: localTemplateSnapshot('button', 'design', empty),
      identity: reuseIdentity,
      inputs: { [property.id]: '承認する' },
      reuse: 'linked',
      requestId: 'small',
    });
    const inserted = applyLocalTemplate(prepared, empty);
    expect(isDesign(inserted)).toBe(true);
    expect(exportDesignSvg(inserted as ReturnType<typeof createDesign>)).toContain(
      `font-size="${fontSize}"`,
    );
    expect(JSON.stringify(content)).toBe(before);
    const roundtrip = JSON.parse(JSON.stringify(source.definition));
    const bytes = JSON.stringify(roundtrip);
    expect((await validateComponentDefinition(roundtrip)).hash).toBe(source.definition.hash);
    expect(JSON.stringify(roundtrip)).toBe(bytes);
  },
);

it('keeps existing domain defaults and reader hashes while limiting opt-in small text to Design', async () => {
  await expect(
    authorReusableComponent({ domain: 'design', content: smallButton(), ids: [], name: 'Default' }),
  ).rejects.toThrow(/fit/);
  await expect(
    authorReusableComponent({
      domain: 'design',
      content: smallButton(10),
      ids: [],
      name: 'Too small',
      overflow: { minFontSize: 9 },
    }),
  ).rejects.toThrow(/layout/);
  const inputs = [
    {
      domain: 'document' as const,
      content: {
        schemaVersion: 2 as const,
        blocks: [{ id: 'paragraph', type: 'paragraph' as const, text: '本文' }],
      },
    },
    { domain: 'slide' as const, content: createDeck() },
  ];
  for (const input of inputs) {
    const template = await saveAsTemplate({
      ...input,
      name: 'Legacy default',
      purpose: 'test',
      category: 'test',
      kind: 'whole',
      slots: [],
    });
    expect(template.overflow.minFontSize).toBe(16);
    await expect(
      saveAsTemplate({
        ...input,
        name: 'Invalid',
        purpose: 'test',
        category: 'test',
        kind: 'whole',
        slots: [],
        overflow: { minFontSize: 10 },
      }),
    ).rejects.toThrow(/layout/);
  }
  const legacy = builtinTemplates.find((t) => t.domain === 'design')!;
  const bytes = JSON.stringify(legacy);
  await validateDefinition(JSON.parse(bytes));
  expandTemplate(legacy, legacy.sample);
  expect(JSON.stringify(legacy)).toBe(bytes);
});

it('shares Japanese/ASCII/newline and exact-height preflight with insertion diagnostics', async () => {
  expect(
    measureTemplateTextFit({
      text: '承認する',
      bounds: { width: 98, height: 26 },
      fontSize: 12,
      minFontSize: 10,
    }),
  ).toMatchObject({ lineCount: 1, requiredHeight: 23.6, fits: true });
  const input = {
    text: '承認する\nAccept',
    bounds: { width: 64, height: 39.2 },
    fontSize: 12,
    minFontSize: 10,
  };
  expect(measureTemplateTextFit(input)).toMatchObject({ columns: 4, lineCount: 2, fits: true });
  expect(measureTemplateTextFit({ ...input, bounds: { width: 64, height: 39.1 } }).fits).toBe(
    false,
  );
  expect(measureTemplateTextFit({ ...input, fontSize: 9 }).fits).toBe(false);
  expect(() => measureTemplateTextFit({ ...input, fontSize: NaN })).toThrow(/finite/);
  const source = await authorReusableComponent({
    domain: 'design',
    content: smallButton(),
    ids: [],
    name: 'Button',
    overflow: { minFontSize: 10, policy: 'error' },
  });
  const template = source.definition.payload.template;
  expect(layoutDiagnostics(template, reusablePrototype(source.definition))).toEqual([]);
  const empty = createDesign();
  const property = source.definition.payload.contract.properties.find((p) => p.type === 'text')!;
  await expect(
    prepareComponentInsertion({
      ...source,
      state: localTemplateSnapshot('small', 'design', empty),
      identity: reuseIdentity,
      inputs: { [property.id]: 'とても長い確認メッセージ'.repeat(10) },
      reuse: 'linked',
    }),
  ).rejects.toThrow(/fit/);
  expect(empty).toEqual(createDesign());
});

it('resolves icon, label and background together without modifying retained definitions or light content', async () => {
  const source = await insertSmallButton();
  const before = JSON.stringify(source.content);
  const definitionHash = await contentHash(source.content.reuse!.closures);
  const light = exportDesignSvg(source.content);
  const darkContent = await buttonMode(source.content, 'dark');
  const dark = exportDesignSvg(darkContent);
  expect(light).toContain('stroke="#336699"');
  expect(dark).toContain('stroke="#ff9933"');
  expect(dark).toContain('fill="#ff9933"');
  expect(dark).toContain('fill="#1a1a1a"');
  expect(dark).toContain('data-vector-source="lucide"');
  expect(dark).toContain('data-vector-license="ISC"');
  expect(dark).not.toContain('Arial');
  expect(dark).toContain('Noto Sans CJK JP');
  expect(await contentHash(darkContent.reuse!.closures)).toBe(definitionHash);
  expect(JSON.stringify(source.content)).toBe(before);
  expect(isDesign(JSON.parse(JSON.stringify(darkContent)))).toBe(true);
});

it('expands changed instance text only when requested, preserving the immutable component geometry', async () => {
  const source = await authorReusableComponent({
    domain: 'design',
    content: smallButton(),
    ids: [],
    name: 'Expanding button',
    overflow: { minFontSize: 10, policy: 'expand' },
  });
  const before = JSON.stringify(source.definition);
  const property = source.definition.payload.contract.properties.find((p) => p.type === 'text')!;
  const empty = createDesign();
  const prepared = await prepareComponentInsertion({
    ...source,
    state: localTemplateSnapshot('grow', 'design', empty),
    identity: reuseIdentity,
    inputs: { [property.id]: '確認用の長いメッセージ'.repeat(10) },
    reuse: 'linked',
    requestId: 'grow',
  });
  const inserted = applyLocalTemplate(prepared, empty) as ReturnType<typeof createDesign>;
  expect(layoutDiagnostics(source.definition.payload.template, inserted)).toEqual([]);
  expect(inserted.components[0].elements!.find((e) => e.type === 'text')!.bounds.height).toBe(26);
  expect(JSON.stringify(source.definition)).toBe(before);
});

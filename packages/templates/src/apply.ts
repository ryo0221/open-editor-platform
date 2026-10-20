import {
  clone,
  isDeepFrozen,
  canonicalJson,
  contentHash,
  createArtifact,
  createArtifactIfAbsent,
  type Artifact,
  type StorageAdapter,
} from '@editor-platform/artifact-core';
import {
  command,
  immutableCommand,
  withCommandReads,
  type EditorCommand,
} from '@editor-platform/editor-core';
import {
  initial,
  prepareOperation,
  evaluate,
  condition,
  conditions,
  type DomainCodec,
  type Snapshot,
  type Identity,
  type Proposal,
  type Operation,
  type Action,
  type PreparedOperation,
} from '@editor-platform/collaboration-core';
import {
  slideEditorCodec,
  whiteboardEditorCodec,
  designEditorCodec,
  dataEditorCodec,
  documentEditorCodec,
  reviewCodec,
  fileCodec,
  prepareEditorProjection,
  encodeEditorOperation,
  type SharedEditorSession,
  type AssetEditorCodec,
} from '@editor-platform/collaboration-adapters';
import { isDeck } from '@editor-platform/slide/model';
import { isWhiteboard } from '@editor-platform/whiteboard/model';
import { isDesign } from '@editor-platform/design/model';
import { isDocument, type DocumentContent } from '@editor-platform/document/model';
import { contentToNode, nodeToContent, documentSchema } from '@editor-platform/document/engine';
import { Transform } from 'prosemirror-transform';
import { isStructuredData, type StructuredData } from '@editor-platform/structured-data/model';
import { expandTemplate, validateDefinition } from './engine';
import { assertNative, nativeIds, remapNative } from './native';
import { previewArtifactMode } from './reuse-update';
import { dataRowReferences } from './reuse-data';
import {
  exposeApplicationContent,
  retainedApplicationContent,
  retainApplicationPreparation,
} from './reuse-preparation';
import { ownReuseOptions } from './reuse-owned';
import {
  problem,
  type Domain,
  type TemplateDefinition,
  type NativeContent,
  type InputValue,
} from './types';
export interface TemplateTarget {
  afterId?: string;
  /** Explicit same-page insertion. Omitting this retains legacy whole-page fragments. */
  slidePageId?: string;
  ids?: string[];
  scope?: 'selection' | 'artifact';
  position?: { x: number; y: number };
  fieldMapping?: Record<string, string | { newName: string }>;
  /** Explicit source record reference → existing target record, never copies records. */
  rowMapping?: Record<string, string>;
  /** Components retain an empty image part so its stable slot/override address remains valid. */
  preserveEmptyAssets?: boolean;
}
export interface PreparedCreation {
  requestId: string;
  fingerprint: string;
  artifact: Artifact<NativeContent>;
  state: 'prepared' | 'cancelled' | 'applied';
}
const requestPattern = /^[A-Za-z0-9_-]{1,100}$/;
export async function prepareInstantiation(
  d: TemplateDefinition,
  inputs: unknown,
  requestId: string,
  options: { includeSampleRows?: boolean; name?: string } = {},
): Promise<PreparedCreation> {
  [d, inputs, options] = clone([d, inputs, options]);
  await validateDefinition(d);
  if (d.kind !== 'whole') problem('template-kind', 'Choose a whole-artifact template');
  if (!requestPattern.test(requestId)) problem('request-id', 'Invalid creation request ID');
  const result = expandTemplate(d, inputs, options);
  const content = remapNative(result.content!, new Map(), `t_${requestId}`).content;
  const digest = await contentHash({
    hash: d.hash,
    inputs: result.inputs,
    includeSampleRows: options.includeSampleRows ?? true,
    name: options.name ?? d.name,
  });
  const artifact = createArtifact(d.domain, options.name ?? d.name, content, {
    source: 'created',
    template: {
      id: d.templateId,
      version: d.templateVersion,
      hash: d.hash,
      requestId,
      fingerprint: digest,
    },
  });
  artifact.id = `template_${requestId}`;
  return { requestId, fingerprint: digest, artifact, state: 'prepared' };
}
export async function applyInstantiation(
  prepared: PreparedCreation,
  storage: StorageAdapter<Artifact<NativeContent>>,
  writable = true,
) {
  if (!writable) problem('unauthorized', 'Host does not permit creation');
  if (prepared.state === 'cancelled') problem('cancelled', 'Creation was cancelled');
  const artifact = await createArtifactIfAbsent(
    storage,
    prepared.artifact,
    prepared.fingerprint,
    (stored) => stored.provenance.template?.fingerprint,
    problem,
  );
  prepared.state = 'applied';
  return artifact;
}
export function cancelInstantiation(prepared: PreparedCreation) {
  if (prepared.state === 'applied')
    problem('already-applied', 'Delete an existing artifact through its Host lifecycle');
  prepared.state = 'cancelled';
}
export function templateCodec(domain: Domain): DomainCodec<NativeContent> {
  const codecs = {
    slide: slideEditorCodec,
    whiteboard: whiteboardEditorCodec,
    design: designEditorCodec,
    document: documentEditorCodec,
    data: dataEditorCodec,
    review: reviewCodec,
    file: fileCodec,
  };
  return codecs[domain] as unknown as DomainCodec<NativeContent>;
}
function insertAfter<T extends { id: string }>(items: T[], values: T[], after?: string) {
  if (!after) return [...items, ...clone(values)];
  const i = items.findIndex((v) => v.id === after);
  if (i < 0) problem('target-deleted', 'Insertion anchor no longer exists');
  return [...items.slice(0, i + 1), ...clone(values), ...items.slice(i + 1)];
}
function offset(value: NativeContent, x: number, y: number) {
  // Canvas elements use world coordinates; component definitions and overrides
  // use local coordinates and must not receive the canvas translation.
  const elements = isDesign(value)
    ? value.elements
    : isWhiteboard(value)
      ? [...value.nodes, ...(value.sections ?? [])]
      : [];
  for (const element of elements) {
    element.bounds.x += x;
    element.bounds.y += y;
  }
}
export interface FieldMappingPreview {
  sourceId: string;
  sourceName: string;
  sourceType: string;
  targetId?: string;
  targetName: string;
  action: 'reuse' | 'add';
}
export function mapDataFragment(
  source: StructuredData,
  target: StructuredData,
  mapping: TemplateTarget['fieldMapping'] = {},
  viewOnly = false,
  seed?: string,
  rowMapping: Record<string, string> = {},
) {
  const ids = new Map<string, string>(Object.entries(rowMapping)),
    preview: FieldMappingPreview[] = [];
  const renamed = clone(source);
  const reused = new Set<string>();
  for (const c of renamed.columns) {
    const m = mapping[c.id];
    if (
      m !== undefined &&
      typeof m !== 'string' &&
      (!m ||
        typeof m !== 'object' ||
        Array.isArray(m) ||
        typeof m.newName !== 'string' ||
        Object.keys(m).some((key) => key !== 'newName'))
    )
      problem('field-mapping', 'Expected an existing field ID or a new field name', c.id);
    if (typeof m === 'string') {
      const targetField = target.columns.find((t) => t.id === m);
      if (!targetField || targetField.type !== c.type)
        problem('field-mapping', `Select a compatible ${c.type} field for ${c.name}`, c.id);
      ids.set(c.id, m);
      if (reused.has(m))
        problem('field-mapping', 'Each source field needs a distinct target', c.id);
      reused.add(m);
      preview.push({
        sourceId: c.id,
        sourceName: c.name,
        sourceType: c.type,
        targetId: m,
        targetName: targetField.name,
        action: 'reuse',
      });
    } else {
      if (viewOnly) problem('field-mapping', `Choose the target field for ${c.name}`, c.id);
      const name = m?.newName ?? c.name;
      if (
        !name.trim() ||
        target.columns.some((t) => t.name.toLowerCase() === name.toLowerCase()) ||
        renamed.columns.some((t) => t.id !== c.id && t.name === name)
      )
        problem('field-mapping', `Explicitly map or rename duplicate field ${name}`, c.id);
      preview.push({
        sourceId: c.id,
        sourceName: c.name,
        sourceType: c.type,
        targetName: name,
        action: 'add',
      });
      c.name = name;
    }
  }
  // Bind formulas against the original schema, then apply the destination names.
  const mapped = remapNative(source, ids, seed).content;
  for (const field of preview) {
    const column = mapped.columns.find((c) => c.id === ids.get(field.sourceId));
    if (column) column.name = field.targetName;
  }
  mapped.columns = mapped.columns.filter((c) => !target.columns.some((t) => t.id === c.id));
  return { content: mapped, preview, ids };
}
function fragmentCommand(
  d: TemplateDefinition,
  payload: NativeContent,
  target: TemplateTarget,
): EditorCommand<NativeContent> {
  if (d.domain === 'slide')
    return immutableCommand(
      'template.insert',
      `Insert ${d.name}`,
      (current) => {
        const basis = isDeepFrozen(current) ? current : clone(current),
          source = clone(payload);
        if (!isDeck(basis) || !isDeck(source))
          problem('domain-mismatch', 'Template does not match the target domain');
        if (basis.width !== source.width || basis.height !== source.height)
          problem('target-layout', 'Slide dimensions differ; choose matching page dimensions');
        let slides;
        if (target.slidePageId) {
          if (!basis.slides.some((page) => page.id === target.slidePageId))
            problem('target-deleted', 'Slide insertion page is missing');
          if (source.slides.length !== 1)
            problem('target-layout', 'In-page parts must belong to exactly one source page');
          slides = basis.slides.map((page) =>
            page.id === target.slidePageId
              ? { ...page, objects: [...page.objects, ...source.slides[0].objects] }
              : page,
          );
        } else slides = insertAfter(basis.slides, source.slides, target.afterId);
        const next = { ...basis, slides };
        assertNative(d.domain, next);
        return next;
      },
      { origin: 'proposal', transactionId: `template_${crypto.randomUUID()}` },
    );
  return command(
    'template.insert',
    `Insert ${d.name}`,
    (current) => {
      const next = clone(current),
        source = clone(payload);
      if (d.domain === 'whiteboard' && isWhiteboard(next) && isWhiteboard(source)) {
        next.nodes.push(...source.nodes);
        next.connectors.push(...source.connectors);
        next.sections = [...(next.sections ?? []), ...(source.sections ?? [])];
      } else if (d.domain === 'design' && isDesign(next) && isDesign(source)) {
        next.elements.push(...source.elements);
        next.components.push(...source.components);
        next.styles = [...(next.styles ?? []), ...(source.styles ?? [])];
      } else if (d.domain === 'document' && isDocument(next) && isDocument(source))
        next.blocks = insertAfter(next.blocks, source.blocks, target.afterId);
      else if (d.domain === 'data' && isStructuredData(next) && isStructuredData(source)) {
        for (const c of source.columns) {
          if (
            next.columns.some((n) => n.id === c.id || n.name.toLowerCase() === c.name.toLowerCase())
          )
            problem('field-mapping', 'A prepared field now conflicts with the schema');
        }
        next.columns.push(...source.columns);
        next.rows = next.rows.map((r) => ({
          ...r,
          values: {
            ...r.values,
            ...Object.fromEntries(
              source.columns
                .filter((c) => c.type !== 'formula')
                .map((c) => [c.id, c.defaultValue ?? (c.type === 'boolean' ? false : null)]),
            ),
          },
        }));
        next.rows.push(
          ...source.rows.map((r) => ({
            ...r,
            values: {
              ...Object.fromEntries(
                next.columns
                  .filter((c) => c.type !== 'formula')
                  .map((c) => [c.id, c.defaultValue ?? null]),
              ),
              ...r.values,
            },
          })),
        );
        next.views = [...(next.views ?? []), ...(source.views ?? [])];
      } else problem('domain-mismatch', 'Template does not match the target domain');
      assertNative(d.domain, next);
      return next;
    },
    { origin: 'proposal', transactionId: `template_${crypto.randomUUID()}` },
  );
}
function presetCommand(
  d: TemplateDefinition,
  fields: Record<string, InputValue>,
  target: TemplateTarget,
): EditorCommand<NativeContent> {
  const allowed: Record<string, string[]> = {
    slide: ['fill', 'fontSize'],
    design: ['fill', 'fontSize'],
    whiteboard: ['color', 'stroke'],
    document: ['color', 'margin'],
    data: ['format', 'decimals', 'chartType'],
  };
  if (Object.keys(fields).some((k) => !allowed[d.domain]?.includes(k)))
    problem('unsupported-preset', 'Preset contains unsupported style fields');
  const ids = new Set(target.ids ?? []);
  if (target.scope !== 'artifact' && !ids.size)
    problem('selection-required', 'Select a target or explicitly choose the whole artifact');
  const selected = (id: string) => target.scope === 'artifact' || ids.has(id);
  return command(
    'template.preset',
    `Apply ${d.name}`,
    (current) => {
      const next = clone(current);
      if (isDeck(next) && d.domain === 'slide') {
        for (const p of next.slides)
          for (const o of p.objects)
            if (selected(o.id) || ids.has(p.id)) {
              if (fields.fill !== undefined) o.fill = String(fields.fill);
              if (fields.fontSize !== undefined)
                o.typography = { ...o.typography, fontSize: Number(fields.fontSize) };
            }
      } else if (isDesign(next) && d.domain === 'design') {
        for (const e of next.elements)
          if (selected(e.id)) {
            if (fields.fill !== undefined) e.fill = String(fields.fill);
            if (fields.fontSize !== undefined)
              e.typography = { ...e.typography, fontSize: Number(fields.fontSize) };
          }
      } else if (isWhiteboard(next) && d.domain === 'whiteboard') {
        for (const n of next.nodes)
          if (selected(n.id) && fields.color !== undefined) n.color = String(fields.color);
        for (const c of next.connectors)
          if (selected(c.id) && fields.stroke !== undefined) c.stroke = String(fields.stroke);
      } else if (isDocument(next) && d.domain === 'document') {
        next.blocks = nodeToContent(documentPresetTransform(next, fields, target).doc, next).blocks;
        if (target.scope === 'artifact' && fields.margin !== undefined)
          next.page = {
            ...next.page,
            size: next.page?.size ?? 'A4',
            margin: Number(fields.margin),
          };
      } else if (isStructuredData(next) && d.domain === 'data') {
        for (const c of next.columns)
          if (selected(c.id) && ['number', 'formula'].includes(c.type)) {
            if (fields.format !== undefined) c.format = String(fields.format) as 'decimal';
            if (fields.decimals !== undefined) c.decimals = Number(fields.decimals);
          }
        for (const v of next.views ?? [])
          if (selected(v.id) && fields.chartType !== undefined)
            v.chart.type = String(fields.chartType) as 'bar';
      } else problem('domain-mismatch', 'Preset domain mismatch');
      assertNative(d.domain, next);
      return next;
    },
    { origin: 'proposal', transactionId: `template_${crypto.randomUUID()}` },
  );
}
function documentPresetTransform(
  content: DocumentContent,
  fields: Record<string, InputValue>,
  target: TemplateTarget,
) {
  const before = contentToNode(content),
    tr = new Transform(before);
  if (fields.color !== undefined) {
    const mark = documentSchema.marks.color.create({ value: String(fields.color) });
    before.forEach((node, offset) => {
      if (target.scope === 'artifact' || target.ids?.includes(node.attrs.id))
        tr.addMark(offset, offset + node.nodeSize, mark);
    });
  }
  return tr;
}
export interface PreparedApplication {
  id: string;
  domain: Domain;
  definition: Pick<TemplateDefinition, 'templateId' | 'templateVersion' | 'hash'>;
  inputs: Record<string, InputValue>;
  command: EditorCommand<NativeContent>;
  operation: Operation;
  proposal: Proposal;
  preview: NativeContent;
  insertedIds: string[];
  mapping: FieldMappingPreview[];
  nativeMapping?: Record<string, string>;
  notices: string[];
  base: NativeContent;
}
type NativeApplicationOptions = {
  state: Snapshot<NativeContent>;
  identity: Identity;
  id: string;
  summary: string;
  definition: PreparedApplication['definition'];
  actions: Action[];
  insertedIds?: string[];
  notices?: string[];
  inputs?: Record<string, InputValue>;
  reads?: string[];
};
/** Shared finalization for native templates and linked components; one proposal/apply/history path. */
export function prepareNativeApplication(options: NativeApplicationOptions): PreparedApplication {
  return exposeApplicationContent(stageNativeApplication(options));
}
/** Internal recursive staging; not exported from the package's public entry point. */
export function stageNativeApplication(options: NativeApplicationOptions): PreparedApplication {
  const { state, identity, id } = options;
  if (!requestPattern.test(id)) problem('request-id', 'Invalid prepared request ID');
  const codec = templateCodec(state.domain as Domain);
  const handle = prepareOperation(codec, state, identity, options.actions, 'proposal');
  let op = clone(handle.operation);
  op.operationId = `template_${id}`;
  op.transactionId = `template_${id}`;
  const existing = new Set(op.conditions.map((c) => c.key));
  op.conditions.push(
    ...conditions(
      codec,
      state,
      [...new Set(options.reads ?? [])].filter((key) => !existing.has(key)),
    ),
  );
  op = encodeEditorOperation(codec, op);
  const prepared: PreparedApplication = {
    id,
    domain: state.domain as Domain,
    definition: options.definition,
    inputs: options.inputs ?? {},
    command: command('reuse.apply', options.summary, (value) =>
      applyLocalTemplate(prepared, value),
    ),
    operation: op,
    proposal: {
      schema: 1,
      id,
      artifactId: state.artifactId,
      sourceActorId: identity.actorId,
      baseRevision: state.revision,
      summary: options.summary,
      actions: op.actions,
      reads: clone(op.conditions),
      writes: clone(op.conditions),
      external: [],
    },
    ...retainedApplicationContent(handle, state.content),
    insertedIds: options.insertedIds ?? [],
    mapping: [],
    notices: options.notices ?? [],
  };
  retainApplicationPreparation(prepared, handle);
  return prepared;
}
export async function prepareInsertion(
  d: TemplateDefinition,
  inputs: unknown,
  state: Snapshot<NativeContent>,
  identity: Identity,
  target: TemplateTarget = {},
  requestId: string = crypto.randomUUID(),
): Promise<PreparedApplication> {
  return exposeApplicationContent(
    await stageInsertion(d, inputs, state, identity, target, requestId),
  );
}
/** Internal recursive staging; public insertion still returns owned editable content. */
export async function stageInsertion(
  d: TemplateDefinition,
  inputs: unknown,
  state: Snapshot<NativeContent>,
  identity: Identity,
  target: TemplateTarget,
  requestId: string,
): Promise<PreparedApplication> {
  return prepareApplication(d, inputs, state, identity, target, requestId, 'fragment');
}
export async function preparePreset(
  d: TemplateDefinition,
  inputs: unknown,
  state: Snapshot<NativeContent>,
  identity: Identity,
  target: TemplateTarget = {},
  requestId: string = crypto.randomUUID(),
): Promise<PreparedApplication> {
  return exposeApplicationContent(
    await prepareApplication(d, inputs, state, identity, target, requestId, 'preset'),
  );
}
/** One owned template application: its options, expansion and destination codec. */
interface Application {
  d: TemplateDefinition;
  state: Snapshot<NativeContent>;
  identity: Identity;
  target: TemplateTarget;
  id: string;
  kind: 'fragment' | 'preset';
  codec: DomainCodec<NativeContent>;
  expanded: ReturnType<typeof expandTemplate>;
}
/** Expanded payload after id remapping or Data field mapping and canvas placement. */
interface Placement {
  payload?: NativeContent;
  mapping: FieldMappingPreview[];
  nativeMapping?: Record<string, string>;
}
type Adopted = NonNullable<StructuredData['reuse']>;
async function prepareApplication(
  d: TemplateDefinition,
  input: unknown,
  state: Snapshot<NativeContent>,
  identity: Identity,
  target: TemplateTarget,
  id: string,
  kind: 'fragment' | 'preset',
): Promise<PreparedApplication> {
  ({
    definition: d,
    input,
    state,
    identity,
    target,
  } = ownReuseOptions({
    definition: d,
    input,
    state,
    identity,
    target,
  }));
  await validateDefinition(d);
  if (d.kind !== kind) problem('template-kind', `Expected a ${kind}`);
  if (d.domain !== state.domain) problem('domain-mismatch', 'Target domain differs');
  const codec = templateCodec(d.domain);
  const expanded = expandTemplate(d, input, {
    remap: false,
    preserveEmptyAssets: target.preserveEmptyAssets,
  });
  const app: Application = { d, state, identity, target, id, kind, codec, expanded };
  const { sourceMode, targetMode } = artifactModes(expanded.content, state.content);
  const { payload, mapping, nativeMapping } = placePayload(
    app,
    await alignPayloadMode(app, sourceMode, targetMode),
  );
  const cmd = withCommandReads(
    kind === 'fragment'
      ? fragmentCommand(d, payload!, target)
      : presetCommand(d, expanded.settings!.fields, target),
    { content: mapping.flatMap((m) => (m.targetId ? [m.targetId] : [])) },
  );
  const { handle, op, adopted } = prepareApplicationOperation(app, cmd, payload);
  const proposal: Proposal = {
    schema: 1,
    id,
    artifactId: state.artifactId,
    sourceActorId: identity.actorId,
    baseRevision: state.revision,
    summary: `${d.name} v${d.templateVersion}`,
    actions: op.actions,
    reads: clone(op.conditions),
    writes: clone(op.conditions),
    external: [],
  };
  const prepared: PreparedApplication = {
    id,
    domain: d.domain,
    definition: { templateId: d.templateId, templateVersion: d.templateVersion, hash: d.hash },
    inputs: expanded.inputs,
    command: cmd,
    operation: op,
    proposal,
    ...retainedApplicationContent(handle, state.content),
    insertedIds: insertedIdsFor(payload, target),
    mapping,
    ...(nativeMapping ? { nativeMapping } : {}),
    notices: applicationNotices(app, sourceMode !== targetMode && !!adopted?.instances.length),
  };
  if (adopted?.instances.length)
    prepared.command = { ...cmd, apply: (current) => applyLocalTemplate(prepared, current) };
  retainApplicationPreparation(prepared, handle);
  return prepared;
}
function artifactModes(payload: NativeContent | undefined, content: NativeContent) {
  const sourceMode = payload && 'reuse' in payload ? payload.reuse?.artifactMode : undefined;
  const targetMode = 'reuse' in content ? content.reuse?.artifactMode : undefined;
  return { sourceMode, targetMode };
}
/** Moves linked members to the destination's artifact mode before they are placed. */
async function alignPayloadMode(
  app: Application,
  sourceMode: string | undefined,
  targetMode: string | undefined,
) {
  let payload = app.expanded.content;
  if (
    payload &&
    'reuse' in payload &&
    payload.reuse?.instances.length &&
    sourceMode !== targetMode
  ) {
    const aligned = await previewArtifactMode({
      state: localTemplateSnapshot(`composition_${app.id}`, app.d.domain, payload),
      identity: app.identity,
      mode: targetMode ?? null,
      requestId: `mode_${app.id}`,
    });
    if (aligned.conflicts.length)
      problem('composition-mode', 'The destination mode needs an explicit member migration');
    if (aligned.prepared) payload = applyLocalTemplate(aligned.prepared, payload);
  }
  return payload;
}
function placePayload(app: Application, payload: NativeContent | undefined): Placement {
  if (!payload) return { payload, mapping: [] };
  const { d, state, target } = app;
  const placed =
    d.domain === 'data' && isStructuredData(payload) && isStructuredData(state.content)
      ? placeDataPayload(app, payload, state.content)
      : remapPayload(app, payload);
  const next = placed.payload!;
  if (d.domain === 'whiteboard' || d.domain === 'design')
    offset(next, target.position?.x ?? 0, target.position?.y ?? 0);
  if (target.slidePageId && isDeck(next)) {
    const pages = new Set(next.slides.map((page) => page.id));
    if (
      next.reuse?.instances.some((instance) =>
        Object.values(instance.parts).some((id) => pages.has(id)),
      )
    )
      problem('composition-target', 'Insert page-layout members as pages, not as in-page objects');
  }
  return placed;
}
/** Maps Data fields and relation rows onto the destination's existing schema. */
function placeDataPayload(
  app: Application,
  payload: StructuredData,
  content: StructuredData,
): Placement {
  const { d, target, id } = app;
  if (d.composition)
    for (const rowId of dataRowReferences(payload))
      if (!content.rows.some((row) => row.id === target.rowMapping?.[rowId]))
        problem(
          'row-mapping',
          'Select an existing target record for each relation reference',
          rowId,
        );
  const m = mapDataFragment(
    payload,
    content,
    target.fieldMapping,
    d.targets.includes('field-mapping'),
    `t_${id}`,
    target.rowMapping,
  );
  const mapping = m.preview;
  // Existing fields are externally owned schema. Keep the same explicit
  // schema ownership marker used by individual native Data components.
  for (const instance of m.content.reuse?.instances ?? [])
    for (const [partId, nativeId] of Object.entries(instance.parts))
      if (mapping.some((field) => field.action === 'reuse' && field.targetId === nativeId))
        instance.overrides[partId] = { ...instance.overrides[partId], schema: true };
  return { payload: m.content, mapping, nativeMapping: Object.fromEntries(m.ids) };
}
function remapPayload(app: Application, payload: NativeContent): Placement {
  const { target, id } = app;
  const ids = new Map<string, string>();
  if (target.slidePageId && isDeck(payload) && payload.slides.length === 1)
    ids.set(payload.slides[0].id, target.slidePageId);
  const remapped = remapNative(payload, ids, `t_${id}`);
  return {
    payload: remapped.content,
    mapping: [],
    nativeMapping: Object.fromEntries(remapped.ids),
  };
}
/** Native operation plus linked-instance actions, with merged and finalized preconditions. */
function prepareApplicationOperation(
  app: Application,
  cmd: EditorCommand<NativeContent>,
  payload: NativeContent | undefined,
) {
  let handle = nativeHandle(app, cmd, payload);
  let op = handle && clone(handle.operation);
  const adopted = payload && 'reuse' in payload ? payload.reuse : undefined;
  if (adopted?.instances.length) ({ handle, op } = adoptInstances(app, op, adopted));
  if (!op || !handle) problem('no-changes', 'Preset does not affect the selected scope');
  return { handle, op: finalizeOperation(app, op), adopted };
}
function nativeHandle(
  app: Application,
  cmd: EditorCommand<NativeContent>,
  payload: NativeContent | undefined,
): PreparedOperation<NativeContent> | undefined {
  const { d, state } = app;
  if (d.domain === 'document' && isDocument(state.content))
    return documentHandle(app, state.content, cmd, payload);
  return prepareEditorProjection(app.codec, state, app.identity, cmd);
}
/** Document changes stay native text-engine steps plus an explicit page action. */
function documentHandle(
  app: Application,
  content: DocumentContent,
  cmd: EditorCommand<NativeContent>,
  payload: NativeContent | undefined,
) {
  const { kind, target, state } = app;
  const before = contentToNode(content);
  const tr =
    kind === 'preset'
      ? documentPresetTransform(content, app.expanded.settings!.fields, target)
      : new Transform(before);
  if (kind === 'fragment' && isDocument(payload))
    tr.insert(documentInsertPosition(before, target.afterId), contentToNode(payload).content);
  const result = cmd.apply(content) as DocumentContent;
  const actions = [
    ...(tr.steps.length
      ? [
          {
            type: 'document.steps',
            target: 'text',
            payload: { version: state.engineVersion, steps: tr.steps.map((s) => s.toJSON()) },
          },
        ]
      : []),
    ...(canonicalJson(result.page) !== canonicalJson(content.page)
      ? [{ type: 'document.page', target: '*', payload: { value: result.page ?? null } }]
      : []),
  ];
  return actions.length
    ? prepareOperation(app.codec, state, app.identity, actions, 'proposal')
    : undefined;
}
function documentInsertPosition(before: ReturnType<typeof contentToNode>, afterId?: string) {
  let pos = before.content.size;
  if (afterId) {
    let found = false;
    before.forEach((node, offset) => {
      if (node.attrs.id === afterId) {
        pos = offset + node.nodeSize;
        found = true;
      }
    });
    if (!found) problem('target-deleted', 'Document insertion anchor is missing');
  }
  return pos;
}
/** Re-prepares with linked-instance actions and keeps native, instance and mode preconditions. */
function adoptInstances(app: Application, op: Operation | undefined, adopted: Adopted) {
  const { codec, state, identity } = app;
  const nativeConditions = op?.conditions ?? [];
  const handle = prepareOperation(
    codec,
    state,
    identity,
    [
      ...(op?.actions ?? []),
      ...adopted.instances.map((instance) => ({
        type: 'reuse.instance',
        target: instance.id,
        payload: {
          value: instance,
          closure: adopted.closures.find((c) => c.hash === instance.closureHash)!,
        },
      })),
    ],
    'proposal',
  );
  const next = clone(handle.operation);
  next.conditions = [
    ...new Map(
      [...nativeConditions, ...next.conditions, condition(codec, state, 'reuse/mode')].map((c) => [
        c.key,
        c,
      ]),
    ).values(),
  ];
  return { handle, op: next };
}
function finalizeOperation(app: Application, op: Operation) {
  const { d, kind, codec, state, id } = app;
  if (d.domain === 'slide' && kind === 'fragment') {
    for (const key of ['root/width', 'root/height'])
      op.conditions.push(condition(codec, state, key));
  }
  op.operationId = `template_${id}`;
  op.transactionId = `template_${id}`;
  return encodeEditorOperation(codec, op);
}
function insertedIdsFor(payload: NativeContent | undefined, target: TemplateTarget) {
  return payload
    ? target.slidePageId && isDeck(payload)
      ? payload.slides.flatMap((p) => p.objects.map((o) => o.id))
      : nativeIds(payload)
    : [];
}
function applicationNotices(app: Application, relinked: boolean) {
  return app.kind === 'preset'
    ? presetNotices(app.d.domain, app.state.content, app.target, app.expanded.settings!.fields)
    : relinked
      ? ['リンク部品の外観は、本文と上書きを保って挿入先のモードへ合わせます。']
      : [];
}
export function localTemplateSnapshot(artifactId: string, domain: Domain, content: NativeContent) {
  return initial(artifactId, templateCodec(domain), content);
}
export function applyLocalTemplate(
  prepared: PreparedApplication,
  current: NativeContent,
  writable = true,
) {
  if (!writable) problem('unauthorized', 'Read only');
  const codec = templateCodec(prepared.domain);
  const state = initial(prepared.proposal.artifactId, codec, current);
  const actual = conditions(
    codec,
    state,
    prepared.operation.conditions.map((c) => c.key),
  );
  if (prepared.operation.conditions.some((c, index) => actual[index].fingerprint !== c.fingerprint))
    problem('stale-precondition', 'Target changed. Preview again.');
  return evaluate(codec, state, prepared.operation.actions, prepared.proposal.sourceActorId).state
    .content;
}
export async function previewSharedTemplate(
  prepared: PreparedApplication,
  session: SharedEditorSession<NativeContent>,
) {
  if (session.pendingCount)
    problem('pending-input', 'Confirm pending edits before preparing a template');
  if (session.readOnly) problem('unauthorized', 'Read only');
  const assets = (session.codec as AssetEditorCodec<NativeContent>).assets;
  for (const ref of assets?.references(prepared.proposal.actions) ?? [])
    await session.adapter.registerAsset?.(ref, assets.resolve(ref));
  await session.adapter.registerProposal(prepared.proposal);
  return session.adapter.previewProposal(prepared.id);
}
export async function applySharedTemplate(
  prepared: PreparedApplication,
  session: SharedEditorSession<NativeContent>,
  token: string,
) {
  return session.applyProposal(prepared.id, token);
}
export async function prepareViewPreset(d: TemplateDefinition, inputs: unknown) {
  await validateDefinition(d);
  if (!['review', 'file'].includes(d.domain) || d.kind !== 'preset' || d.preset?.scope !== 'view')
    problem('template-kind', 'Expected a Review/Viewer setting preset');
  const settings = expandTemplate(d, inputs).settings!;
  const allowed =
    d.domain === 'review' ? ['split', 'wrap', 'annotations'] : ['fit', 'zoom', 'annotations'];
  if (Object.keys(settings.fields).some((k) => !allowed.includes(k)))
    problem('unsupported-preset', 'Unsupported view setting');
  return clone(settings.fields);
}
function presetNotices(
  domain: Domain,
  content: NativeContent,
  target: TemplateTarget,
  fields: Record<string, InputValue>,
): string[] {
  const notices: string[] = [];
  if (domain === 'document' && target.scope !== 'artifact' && fields.margin !== undefined)
    notices.push(
      'ページ余白は成果物全体を選んだ場合のみ変更します。選択した本文には文字色を適用します。',
    );
  if (domain === 'data' && isStructuredData(content)) {
    const selected = (id: string) => target.scope === 'artifact' || target.ids?.includes(id);
    const skipped = content.columns.filter(
      (c) => selected(c.id) && !['number', 'formula'].includes(c.type),
    );
    if (skipped.length && (fields.format !== undefined || fields.decimals !== undefined))
      notices.push(
        `数値表示の対象外: ${skipped.map((c) => c.name).join('、')}。値・型は保持します。`,
      );
    if (fields.chartType !== undefined && !(content.views ?? []).some((v) => selected(v.id)))
      notices.push('選択範囲にviewがないためchart設定は変更しません。');
  }
  return notices;
}

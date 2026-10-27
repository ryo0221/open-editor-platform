import { canonicalJson, clone } from '@editor-platform/artifact-core';
import { command, type EditorCommand } from '@editor-platform/editor-core';
import { type GraphDocument, type GraphDiagnostic, type JsonValue } from './model';
import {
  assertGraphProfile,
  validateGraph,
  type GraphProfile,
  type GraphType,
  type AttributeSchema,
} from './profile';
/** Host-owned source envelope, distinct from a native GraphDocument. */
export interface GraphDefinitionSource {
  graph: GraphDocument;
  profile: GraphProfile;
}
export interface GraphDefinitionChange {
  scope: 'graph' | 'node' | 'edge' | 'section';
  type?: string;
  definition: GraphType | GraphProfile['edges'][string];
}
export interface GraphDefinitionPreview extends GraphDefinitionSource {
  diagnostics: GraphDiagnostic[];
  changedIds: string[];
  convertedValues: number;
}
export interface GraphDefinitionRequest {
  /** Host must verify this source fingerprint and recompute the preview before committing. */
  base: string;
  change: GraphDefinitionChange;
  preview: GraphDefinitionPreview;
}
export interface GraphSourceActions {
  owner: string;
  readOnlyReason?: string;
  onOpenSource?: (elementId: string) => void;
  onOpenDefinition?: (elementId: string) => void;
  onEditDefinition?: (request: GraphDefinitionRequest) => void | boolean;
}
/** The Profile map that holds the types of a non-graph scope. */
const typeMap = (scope: 'node' | 'edge' | 'section') =>
  scope === 'node' ? 'nodes' : scope === 'edge' ? 'edges' : 'sections';
function convert(value: JsonValue, field: AttributeSchema): JsonValue {
  if (value === null) return null;
  if (field.type === 'string' && ['number', 'boolean'].includes(typeof value)) return String(value);
  if (
    field.type === 'number' &&
    typeof value === 'string' &&
    value.trim() &&
    Number.isFinite(Number(value))
  )
    return Number(value);
  if (field.type === 'boolean' && (value === 'true' || value === 'false')) return value === 'true';
  return value;
}
export function previewGraphDefinition(
  source: GraphDefinitionSource,
  change: GraphDefinitionChange,
): GraphDefinitionPreview {
  assertGraphProfile(source.profile);
  if (
    source.graph.profile.id !== source.profile.id ||
    source.graph.profile.version !== source.profile.version
  )
    throw new Error('Graphと所有元の定義版が一致しません。現在の元データを開き直してください。');
  const profile = clone(source.profile);
  if (
    change.scope !== 'graph' &&
    (!change.type || !Object.hasOwn(profile[typeMap(change.scope)], change.type))
  )
    throw new Error('Choose an existing Graph type');
  const original =
    change.scope === 'graph' ? profile.graph : profile[typeMap(change.scope)][change.type!];
  if (Object.keys(original.schema).some((field) => !Object.hasOwn(change.definition.schema, field)))
    throw new Error('既存の属性は削除できません。値と参照を保持したまま定義を変更してください。');
  if (change.scope === 'graph') profile.graph = clone(change.definition);
  else profile[typeMap(change.scope)][change.type!] = clone(change.definition);
  profile.version++;
  assertGraphProfile(profile);
  const graph = clone(source.graph);
  graph.profile = { id: profile.id, version: profile.version };
  const changedIds: string[] = [];
  let convertedValues = 0;
  const targets =
    change.scope === 'graph'
      ? [graph]
      : (change.scope === 'node'
          ? graph.nodes
          : change.scope === 'edge'
            ? graph.edges
            : graph.sections
        ).filter((element) => element.type === change.type);
  for (const target of targets) {
    changedIds.push(target.id);
    for (const [key, field] of Object.entries(change.definition.schema)) {
      if (!Object.hasOwn(target.attributes, key)) continue;
      const before = target.attributes[key],
        next = convert(before, field);
      if (canonicalJson(before) !== canonicalJson(next)) {
        if (original.schema[key]?.readOnly || original.readOnly || source.profile.graph.readOnly)
          throw new Error('読み取り専用の既存値は移行できません。所有元へ変更を依頼してください。');
        target.attributes[key] = next;
        convertedValues++;
      }
    }
  }
  return {
    graph,
    profile,
    diagnostics: validateGraph(graph, profile),
    changedIds,
    convertedValues,
  };
}
export function prepareGraphDefinition(
  source: GraphDefinitionSource,
  change: GraphDefinitionChange,
  writable: () => boolean = () => true,
): EditorCommand<GraphDefinitionSource> {
  const base = canonicalJson(source),
    fixed = clone(change);
  const preview = previewGraphDefinition(source, fixed);
  if (preview.diagnostics.some((diagnostic) => diagnostic.blocking))
    throw new Error('定義の移行に無効な値または関係があります。プレビューを確認してください。');
  return command('graph.definition', 'Update Graph definition and migrate values', (current) => {
    if (!writable() || current.profile.graph.readOnly)
      throw new Error('Graph definition is read only');
    if (canonicalJson(current) !== base)
      throw new Error('Graph source or definition changed before migration');
    return { graph: clone(preview.graph), profile: clone(preview.profile) };
  });
}

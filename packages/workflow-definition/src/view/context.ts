import { createContext, useContext } from 'react';
import {
  owdElements,
  type OwdDefinition,
  type OwdElementKind,
  type OwdElementRef,
  type WorkflowDefinitionDiagnostic,
  type WorkflowDefinitionIntent,
} from '../model';
import { type Choice } from './fields';

export const kindLabels: Record<OwdElementKind, string> = {
  phase: '工程',
  section: 'まとまり',
  deliverable: '成果物',
  acceptance: '達成条件',
  role: '役割',
  item: '項目',
  rule: '規則',
};
export interface WorkflowViewContext {
  definition: OwdDefinition;
  readOnly: boolean;
  /** Applies a batch as one Host command; returns the reason when it is refused. */
  edit: (intents: WorkflowDefinitionIntent[]) => string | undefined;
  selected?: OwdElementRef;
  select: (ref: OwdElementRef | undefined) => void;
  diagnostics: WorkflowDefinitionDiagnostic[];
}
export const WorkflowContext = createContext<WorkflowViewContext | undefined>(undefined);
export function useWorkflow() {
  const value = useContext(WorkflowContext);
  if (!value) throw new Error('Workflow definition views need WorkflowDefinitionSurface');
  return value;
}
/** Candidates for a reference field: `id — name`. */
export function choicesOf(definition: OwdDefinition, kind: OwdElementKind): Choice[] {
  return owdElements(definition, kind).map((e) => {
    const name = typeof e.name === 'string' ? e.name : typeof e.text === 'string' ? e.text : '';
    return {
      value: e.id as string,
      label: name ? `${e.id as string} — ${name.slice(0, 40)}` : (e.id as string),
    };
  });
}
export const sameRef = (a: OwdElementRef | undefined, b: OwdElementRef | undefined) =>
  !!a && !!b && a.kind === b.kind && a.id === b.id;
export const diagnosticsOf = (all: WorkflowDefinitionDiagnostic[], ref: OwdElementRef) =>
  all.filter((d) => sameRef(d.target, ref));

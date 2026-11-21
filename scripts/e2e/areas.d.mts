export interface SpecRule {
  match: RegExp;
  area: 'office' | 'engineering';
  heavy?: boolean;
  broad?: boolean;
  owners?: string[];
  suite?: string;
  needs?: number[];
}
export interface Spec {
  file: string;
  name: string;
  area: 'office' | 'engineering';
  heavy: boolean;
  broad: boolean;
  owners: string[];
  suite?: string;
  helpers: string[];
  paths: string[];
  needs: number[];
}
export interface WorkspaceGraph {
  users: Map<string, Set<string>>;
}
export const corePackages: string[];
export const engineeringPackages: string[];
export const specRules: SpecRule[];
export const defaultPorts: number[];
export function packageArea(name: string): 'core' | 'engineering' | 'office';
export function classifySpecs(root: string): Spec[];
export function developmentSpecs(specs: Spec[]): Spec[];
export function workspaceGraph(root: string): WorkspaceGraph;
export function dependents(graph: WorkspaceGraph, names: string[]): Set<string>;

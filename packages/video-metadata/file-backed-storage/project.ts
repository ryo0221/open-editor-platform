/** Node bindings for the shared private project/native closure validator. */
import { scan } from './io';
import { createProject } from './portable/project';
export type { Project } from './portable/project';
export const { validateProject, prepareProject, openProject } = createProject(scan);

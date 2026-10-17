import { clone, deepFreeze, isDeepFrozen } from '@editor-platform/artifact-core';
import type { Bounds, Drawing } from '@editor-platform/editor-core';
import {
  designDrawingProjector,
  designDrawings,
  type DesignContent,
  type DesignElement,
} from './model';

interface RenderedElement {
  components: DesignContent['components'];
  styles: DesignContent['styles'];
  parents: DesignElement[];
  bounds: Bounds;
  rotation: number | undefined;
  drawings: Drawing[];
}

/** One owned drawing snapshot per React render, including mutable Host inputs.
 * Recreate this scope on every mutable Host render; identity is not a revision.
 * The Host's records remain mutable and are never frozen by the view.
 */
export function designRenderSnapshot(
  source: DesignContent,
  cache: ReturnType<typeof createDesignRenderCache>,
) {
  const content = isDeepFrozen(source) ? source : deepFreeze(clone(source));
  const elements = new Map(content.elements.map((element) => [element.id, element]));
  const draw = cache(content);
  return (raw: DesignElement, bounds = raw.bounds, rotation = raw.rotation) =>
    draw(elements.get(raw.id)!, bounds, rotation);
}

/** Private view projections; public model/export APIs still produce fresh values. */
export function createDesignRenderCache() {
  const rendered = new WeakMap<DesignElement, RenderedElement>();
  return (content: DesignContent) => {
    const owned = isDeepFrozen(content);
    const index = new Map(content.elements.map((element) => [element.id, element]));
    const project = designDrawingProjector(content);
    return (raw: DesignElement, bounds = raw.bounds, rotation = raw.rotation): Drawing[] => {
      // Mutable and shallow-frozen Host trees must observe in-place edits,
      // including replaced definitions and parent records.
      if (!owned || !isDeepFrozen(raw))
        return designDrawings(content, { ...raw, bounds, rotation });
      const parents: DesignElement[] = [];
      const seen = new Set<string>();
      let parent = raw.parentId ? index.get(raw.parentId) : undefined;
      while (parent && !seen.has(parent.id)) {
        parents.push(parent);
        seen.add(parent.id);
        parent = parent.parentId ? index.get(parent.parentId) : undefined;
      }
      const previous = rendered.get(raw);
      if (
        previous &&
        previous.components === content.components &&
        previous.styles === content.styles &&
        previous.parents.length === parents.length &&
        previous.parents.every((value, i) => value === parents[i]) &&
        previous.bounds.x === bounds.x &&
        previous.bounds.y === bounds.y &&
        previous.bounds.width === bounds.width &&
        previous.bounds.height === bounds.height &&
        previous.rotation === rotation
      )
        return previous.drawings;
      // The preview geometry belongs to CanvasStage. Own it before freezing the
      // private drawing; all other borrowed branches are certified immutable.
      const geometry = { ...bounds };
      const drawings = deepFreeze(project({ ...raw, bounds: geometry, rotation }));
      rendered.set(raw, {
        components: content.components,
        styles: content.styles,
        parents,
        bounds: geometry,
        rotation,
        drawings,
      });
      return drawings;
    };
  };
}

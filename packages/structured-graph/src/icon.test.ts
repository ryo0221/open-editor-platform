import { describe, expect, it } from 'vitest';
import { clone } from '@editor-platform/artifact-core';
import {
  createRelationGraph,
  graphNodeIconPath,
  graphNodeIcons,
  isGraphProfile,
  relationProfile,
  resolveGraphNodeIcon,
  type GraphProfile,
} from './headless';

describe('node icons', () => {
  it('names only built-in paths that are plain SVG path data', () => {
    expect(graphNodeIcons.length).toBeGreaterThan(10);
    for (const icon of graphNodeIcons)
      expect(graphNodeIconPath(icon)).toMatch(/^[MmLlHhVvAaZz\d .-]+$/);
  });

  it('resolves the value icon, then the type default, then none', () => {
    const graph = createRelationGraph(),
      [resource, topic] = graph.nodes;
    expect(resolveGraphNodeIcon(relationProfile, resource)).toBe('cube');
    expect(resolveGraphNodeIcon(relationProfile, topic)).toBe('list');
    const profile = clone(relationProfile);
    profile.nodes.entity.ui!.icon = 'document';
    // An unmapped or missing value falls back to the type default.
    expect(resolveGraphNodeIcon(profile, { ...resource, attributes: { name: 'x' } })).toBe(
      'document',
    );
    expect(resolveGraphNodeIcon(profile, { ...resource, attributes: { category: 'Other' } })).toBe(
      'document',
    );
    expect(resolveGraphNodeIcon(relationProfile, { ...resource, type: 'company' })).toBeUndefined();
    expect(resolveGraphNodeIcon(relationProfile, { ...resource, type: 'person' })).toBe('person');
    // Values named like Object.prototype members are unmapped, not inherited.
    for (const category of ['constructor', 'toString', '__proto__'])
      expect(resolveGraphNodeIcon(profile, { ...resource, attributes: { category } })).toBe(
        'document',
      );
    // An empty string is a value of its own and can be mapped.
    profile.nodes.entity.ui!.icons = { '': 'flag' };
    expect(resolveGraphNodeIcon(profile, { ...resource, attributes: { category: '' } })).toBe(
      'flag',
    );
    // Number and boolean values compare as strings.
    profile.nodes.entity.ui!.iconBy = 'active';
    profile.nodes.entity.ui!.icons = { true: 'check' };
    expect(resolveGraphNodeIcon(profile, resource)).toBe('check');
  });

  it('accepts declared icons and rejects unknown names, path data and unkeyed maps', () => {
    expect(isGraphProfile(relationProfile)).toBe(true);
    const with_ = (ui: Record<string, unknown>, scope: 'nodes' | 'sections' = 'nodes') => {
      const profile = clone(relationProfile) as GraphProfile;
      const type = scope === 'nodes' ? profile.nodes.entity : profile.sections.group;
      type.ui = { ...type.ui, ...ui } as never;
      for (const [key, value] of Object.entries(ui))
        if (value === undefined) delete (type.ui as Record<string, unknown>)[key];
      return isGraphProfile(profile);
    };
    expect(with_({ icon: 'table' })).toBe(true);
    expect(with_({ icon: 'rocket' })).toBe(false);
    expect(with_({ icon: 'M0 0L10 10' })).toBe(false);
    expect(with_({ icons: { Resource: 'unknown' } })).toBe(false);
    // `icons` needs `iconBy`, and `iconBy` must be a field of the type.
    expect(with_({ iconBy: undefined, icons: { Resource: 'cube' } })).toBe(false);
    expect(with_({ iconBy: 'missing' })).toBe(false);
    expect(with_({ iconBy: 'name' })).toBe(true);
    // Sections draw no node badge, so they do not take icons.
    expect(with_({ icon: 'folder' }, 'sections')).toBe(false);
  });
});

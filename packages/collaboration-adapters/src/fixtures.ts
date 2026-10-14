import type { DocumentContent } from '@editor-platform/document/model';
import type { SlideContent } from '@editor-platform/slide/model';
import type { StructuredData } from '@editor-platform/structured-data/model';
import type { DesignContent } from '@editor-platform/design/model';
import type { WhiteboardContent } from '@editor-platform/whiteboard/model';
import type { Principal } from '@editor-platform/collaboration-core';
export const person = (name: string, sessionId = `session-${name}`): Principal => ({
  actorId: name,
  clientId: `client-${name}`,
  sessionId,
  writable: true,
  scopes: ['*'],
});
export const documentFixture = (): DocumentContent => ({
  schemaVersion: 2,
  blocks: [
    { id: 'p1', type: 'paragraph', text: 'Hello world' },
    { id: 'p2', type: 'paragraph', text: 'Second paragraph' },
  ],
});
export const slideFixture = (): SlideContent => ({
  schemaVersion: 2,
  width: 960,
  height: 540,
  slides: [
    {
      id: 'page1',
      title: 'Collaboration',
      background: '#ffffff',
      objects: [
        {
          id: 'shape1',
          type: 'shape',
          text: '',
          fill: '#4f7a5d',
          bounds: { x: 80, y: 100, width: 220, height: 150 },
        },
        {
          id: 'shape2',
          type: 'shape',
          text: '',
          fill: '#c2a172',
          bounds: { x: 380, y: 100, width: 220, height: 150 },
        },
      ],
    },
    { id: 'page2', title: 'Second page', background: '#ffffff', objects: [] },
  ],
});
export const dataFixture = (): StructuredData => ({
  schemaVersion: 2,
  columns: [
    { id: 'name', name: 'Name', type: 'text' },
    { id: 'value', name: 'Value', type: 'number' },
  ],
  rows: [
    { id: 'row1', values: { name: 'Alpha', value: 10 } },
    { id: 'row2', values: { name: 'Beta', value: 20 } },
  ],
});
export const designFixture = (): DesignContent => ({
  schemaVersion: 2,
  elements: [
    {
      id: 'group',
      type: 'group',
      name: 'Group',
      text: '',
      fill: '#ffffff',
      bounds: { x: 0, y: 0, width: 400, height: 300 },
    },
    {
      id: 'child',
      parentId: 'group',
      type: 'rectangle',
      name: 'Child',
      text: '',
      fill: '#abcdef',
      bounds: { x: 10, y: 10, width: 40, height: 40 },
    },
    {
      id: 'instance',
      type: 'instance',
      name: 'Instance',
      componentId: 'component',
      text: '',
      fill: '#ffffff',
      bounds: { x: 500, y: 0, width: 100, height: 100 },
    },
  ],
  components: [
    {
      id: 'component',
      name: 'Button',
      width: 100,
      height: 100,
      template: { type: 'rectangle', text: '', fill: '#333333' },
      elements: [
        {
          id: 'part',
          type: 'rectangle',
          name: 'Part',
          text: '',
          fill: '#333333',
          bounds: { x: 0, y: 0, width: 100, height: 100 },
        },
      ],
    },
  ],
});
export const boardFixture = (): WhiteboardContent => ({
  schemaVersion: 3,
  nodes: [
    {
      id: 'one',
      kind: 'rectangle',
      text: '',
      color: '#123456',
      bounds: { x: 0, y: 0, width: 100, height: 100 },
    },
    {
      id: 'two',
      kind: 'rectangle',
      text: '',
      color: '#abcdef',
      bounds: { x: 200, y: 0, width: 100, height: 100 },
    },
  ],
  connectors: [{ id: 'edge', from: 'one', to: 'two', label: 'Link' }],
});

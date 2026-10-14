import { Fragment, Mark, Node, type Schema } from 'prosemirror-model';
import { canonicalJson } from '@editor-platform/artifact-core';

function hasAttributes(attributes: Record<string, unknown>) {
  // Match ProseMirror's toJSON test, including inherited enumerable attributes.
  for (const _key in attributes) return true;
  return false;
}

/** The standard engine JSON has a fixed field order. Write those fields directly
 * in canonical order without allocating/sorting a second complete node tree.
 * Attributes keep the general canonical codec. No mutable node is memoized. */
export function createEngineJsonWriter(schema: Schema) {
  const nodeJson = Node.prototype.toJSON,
    textJson = schema.text('x').toJSON,
    fragmentJson = Fragment.prototype.toJSON,
    markJson = Mark.prototype.toJSON;
  const mark = (value: Mark): string =>
    value.toJSON !== markJson
      ? canonicalJson(value.toJSON())
      : `{${hasAttributes(value.attrs) ? `"attrs":${canonicalJson(value.attrs)},` : ''}"type":${JSON.stringify(value.type.name)}}`;
  const write = (value: Node): string => {
    if (
      Node.prototype.toJSON !== nodeJson ||
      value.toJSON !== (value.isText ? textJson : nodeJson) ||
      value.content.toJSON !== fragmentJson
    )
      return canonicalJson(value.toJSON());
    let result = '{';
    if (hasAttributes(value.attrs)) result += `"attrs":${canonicalJson(value.attrs)},`;
    if (value.content.size) {
      let separator = '';
      result += '"content":[';
      value.forEach((child) => {
        result += separator + write(child);
        separator = ',';
      });
      result += '],';
    }
    if (value.marks.length) result += `"marks":[${value.marks.map(mark).join(',')}],`;
    if (value.isText) result += `"text":${JSON.stringify(value.text)},`;
    return result + `"type":${JSON.stringify(value.type.name)}}`;
  };
  return write;
}

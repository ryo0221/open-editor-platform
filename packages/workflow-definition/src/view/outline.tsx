import { clone } from '@editor-platform/artifact-core';
import { type OwdJson, type OwdRecord } from '../model';
import { choicesOf, useWorkflow } from './context';
import { SelectField, TextField } from './fields';

type Entry = OwdRecord & { children?: Entry[] };
const isEntry = (v: unknown): v is Entry => !!v && typeof v === 'object' && !Array.isArray(v);
/** The list at `path` (indexes of parents) inside a copy of the outline. */
function at(outline: Entry[], path: number[]): Entry[] {
  let list = outline;
  for (const i of path) {
    const entry = list[i];
    entry.children ??= [];
    list = entry.children;
  }
  return list;
}
/** The chapter tree of a deliverable (design §5): heading, describe, item, repeat, 4 levels. */
export function OutlineEditor({ deliverable }: { deliverable: OwdRecord }) {
  const { definition, readOnly, edit } = useWorkflow();
  const id = deliverable.id as string;
  const outline = (Array.isArray(deliverable.outline) ? deliverable.outline : []) as Entry[];
  const change = (update: (copy: Entry[]) => void) => {
    const copy = clone(outline);
    update(copy);
    // An emptied children list is removed: OWD needs at least one child when the field is there.
    const prune = (list: Entry[]) =>
      list.forEach((e) => {
        if (isEntry(e) && Array.isArray(e.children)) {
          prune(e.children);
          if (!e.children.length) delete e.children;
        }
      });
    prune(copy);
    return edit([
      { type: 'set-fields', kind: 'deliverable', id, fields: { outline: copy as OwdJson } },
    ]);
  };
  const items = choicesOf(definition, 'item');
  const render = (list: Entry[], path: number[]): React.ReactNode => (
    <ol className="ep-wd-outline">
      {list.map((entry, i) => {
        const here = [...path, i],
          name = `heading ${here.map((n) => n + 1).join('.')}`;
        // A malformed entry (an imported draft) is shown and can be removed, never read as fields.
        if (!isEntry(entry))
          return (
            <li key={i} className="ep-wd-blocking">
              <span>壊れた見出し：{JSON.stringify(entry)?.slice(0, 80) ?? String(entry)}</span>
              {!readOnly && (
                <button
                  type="button"
                  aria-label={`Delete ${name}`}
                  onClick={() => change((c) => void at(c, path).splice(i, 1))}
                >
                  削除
                </button>
              )}
            </li>
          );
        const field = (key: string, label: string, multiline = false) => (
          <TextField
            label={`${label} of ${name}`}
            value={typeof entry[key] === 'string' ? (entry[key] as string) : ''}
            readOnly={readOnly}
            required
            multiline={multiline}
            onCommit={(v) => change((c) => void (at(c, path)[i][key] = v))}
          />
        );
        return (
          <li key={i}>
            <div className="ep-wd-outline-entry">
              {field('heading', 'Heading')}
              {field('describe', 'Describe', true)}
              <SelectField
                label={`Item of ${name}`}
                value={typeof entry.item === 'string' ? entry.item : ''}
                choices={items}
                readOnly={readOnly}
                onChange={(v) =>
                  change((c) => {
                    if (v) at(c, path)[i].item = v;
                    else delete at(c, path)[i].item;
                  })
                }
              />
              <label>
                <input
                  type="checkbox"
                  aria-label={`Repeat ${name}`}
                  checked={entry.repeat === true}
                  disabled={readOnly}
                  onChange={(e) =>
                    change((c) => {
                      if (e.target.checked) at(c, path)[i].repeat = true;
                      else delete at(c, path)[i].repeat;
                    })
                  }
                />
                項目ごとに繰り返す
              </label>
              {!readOnly && (
                <span className="ep-wd-actions">
                  <button
                    type="button"
                    aria-label={`Move ${name} up`}
                    disabled={i === 0}
                    onClick={() =>
                      change((c) => {
                        const l = at(c, path);
                        [l[i - 1], l[i]] = [l[i], l[i - 1]];
                      })
                    }
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    aria-label={`Move ${name} down`}
                    disabled={i === list.length - 1}
                    onClick={() =>
                      change((c) => {
                        const l = at(c, path);
                        [l[i + 1], l[i]] = [l[i], l[i + 1]];
                      })
                    }
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    aria-label={`Add a heading inside ${name}`}
                    disabled={here.length >= 4}
                    onClick={() =>
                      change(
                        (c) =>
                          void at(c, here).push({ heading: '新しい見出し', describe: '書くこと' }),
                      )
                    }
                  >
                    中に見出し
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete ${name}`}
                    onClick={() => change((c) => void at(c, path).splice(i, 1))}
                  >
                    削除
                  </button>
                </span>
              )}
            </div>
            {Array.isArray(entry.children) &&
              entry.children.length > 0 &&
              render(entry.children, here)}
          </li>
        );
      })}
    </ol>
  );
  return (
    <section className="ep-wd-outline-editor" aria-label={`Outline of ${id}`}>
      <h4>章立て：{id}</h4>
      {render(outline, [])}
      {!readOnly && (
        <button
          type="button"
          onClick={() =>
            change((c) => void c.push({ heading: '新しい見出し', describe: '書くこと' }))
          }
        >
          見出しを足す
        </button>
      )}
    </section>
  );
}

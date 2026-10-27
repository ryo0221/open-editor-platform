export const geoWorkspaceCss = `.geo-workspace{font:15px/1.5 system-ui;color:#173247;background:white;padding:16px;border:1px solid #a9bdc9;border-radius:8px}.geo-workspace *{box-sizing:border-box;min-width:0;max-width:100%}.geo-workspace button,.geo-workspace input,.geo-workspace select,.geo-workspace textarea{font:inherit;padding:8px;margin:4px 0}.geo-workspace input[type=color]{width:64px;height:36px;padding:3px;vertical-align:middle}.geo-workspace label{display:block}.geo-workspace textarea{display:block;width:100%;min-height:80px}.geo-workspace .geo-layout{display:grid;grid-template-columns:minmax(130px,.7fr) minmax(0,2fr) minmax(220px,1fr);gap:16px}.geo-workspace .geo-layout[data-panel]{display:block}.geo-workspace .geo-layout[data-panel=map] svg{display:block;margin:0 auto;width:auto;max-height:70vh}.geo-workspace .geo-layout>section>details{margin:8px 0}.geo-workspace summary{cursor:pointer;font-weight:600}.geo-workspace svg{width:100%;height:auto}.geo-workspace svg [role=button]{cursor:pointer}.geo-workspace :focus-visible{outline:3px solid #005fcc;outline-offset:2px}.geo-workspace [aria-selected=true],.geo-workspace [aria-pressed=true]{background:#ffe6bb}.geo-workspace .geo-table{overflow:auto;max-height:360px}.geo-workspace table{border-collapse:collapse;width:100%}.geo-workspace th,.geo-workspace td{padding:6px;border:1px solid #bccbd4;text-align:left}.geo-workspace fieldset{margin:12px 0}.geo-workspace .geo-status{padding:8px;background:#eef4f8}.geo-workspace button:disabled{opacity:.5}@media(max-width:700px){.geo-workspace .geo-layout{display:block}.geo-workspace [hidden]{display:none}}`;

export interface GeoChoice {
  value: string;
  label: string;
}

export type GeoNode = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
) => HTMLElementTagNameMap[K];

export interface GeoDomKit {
  node: GeoNode;
  input(parent: HTMLElement, name: string, value?: string, type?: string): HTMLInputElement;
  select(parent: HTMLElement, name: string, values: GeoChoice[], value?: string): HTMLSelectElement;
  textArea(parent: HTMLElement, name: string, value?: string): HTMLTextAreaElement;
  fillSelect(target: HTMLSelectElement, values: GeoChoice[]): void;
}

export function createGeoDomKit(doc: Document): GeoDomKit {
  const node: GeoNode = (tag, text) => {
    const value = doc.createElement(tag);
    if (text !== undefined) value.textContent = text;
    return value;
  };
  const input = (parent: HTMLElement, name: string, value = '', type = 'text') => {
    const label = node('label', name),
      field = node('input');
    field.type = type;
    field.value = value;
    label.append(field);
    parent.append(label);
    return field;
  };
  const select = (parent: HTMLElement, name: string, values: GeoChoice[], value = '') => {
    const label = node('label', name),
      field = node('select');
    field.setAttribute('aria-label', name);
    for (const v of values) {
      const o = node('option', v.label);
      o.value = v.value;
      field.append(o);
    }
    field.value = value;
    label.append(field);
    parent.append(label);
    return field;
  };
  const textArea = (parent: HTMLElement, name: string, value = '') => {
    const label = node('label', name),
      field = node('textarea');
    field.value = value;
    label.append(field);
    parent.append(label);
    return field;
  };
  const fillSelect = (target: HTMLSelectElement, values: GeoChoice[]) => {
    const prior = target.value;
    target.replaceChildren(
      ...values.map((v) => {
        const o = node('option', v.label);
        o.value = v.value;
        return o;
      }),
    );
    if (values.some((v) => v.value === prior)) target.value = prior;
  };
  return { node, input, select, textArea, fillSelect };
}

export const geoChoices = (values: readonly string[]): GeoChoice[] =>
  values.map((x) => ({ value: x, label: x }));

export function parseGeoNumber(text: string) {
  if (
    !text.trim() ||
    !/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?$/i.test(text) ||
    !Number.isFinite(Number(text))
  )
    throw Error('Invalid finite number; input retained');
  return Number(text);
}

export const splitGeoList = (text: string) =>
  text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

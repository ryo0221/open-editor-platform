import { createElement, type HTMLAttributes, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { StatusRoleContext, useStatusProps } from './status-role';

function Notice() {
  const props: HTMLAttributes<HTMLElement> = useStatusProps();
  return createElement('p', props, '計算中…');
}
const render = (node: ReactNode) => renderToStaticMarkup(node);

describe('Surface notices beside a Host status (#563)', () => {
  it('names its role=status by default', () => {
    expect(render(createElement(Notice))).toBe(
      '<p role="status" aria-label="見積の状態">計算中…</p>',
    );
  });
  it('keeps a polite live region without the role when the Host owns status', () => {
    expect(
      render(createElement(StatusRoleContext.Provider, { value: 'none' }, createElement(Notice))),
    ).toBe('<p aria-live="polite">計算中…</p>');
  });
});

import { createElement, type HTMLAttributes, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Output, StatusRoleContext, useStatusProps, type CadStatusRole } from './status-role';

function Notice() {
  const props: HTMLAttributes<HTMLElement> = useStatusProps();
  return createElement('p', props, 'Preparing the 3D shape…');
}
const render = (role: CadStatusRole | undefined, node: ReactNode) =>
  renderToStaticMarkup(
    role ? createElement(StatusRoleContext.Provider, { value: role }, node) : node,
  );

describe('Surface notices beside a Host status (#563)', () => {
  it('names its role=status by default', () => {
    expect(render(undefined, createElement(Notice))).toBe(
      '<p role="status" aria-label="CAD の状態">Preparing the 3D shape…</p>',
    );
    expect(render(undefined, createElement(Output, null, '12 mm'))).toBe('<output>12 mm</output>');
  });
  it('keeps a polite live region without the role when the Host owns status', () => {
    expect(render('none', createElement(Notice))).toBe(
      '<p aria-live="polite">Preparing the 3D shape…</p>',
    );
    expect(render('none', createElement(Output, { id: 'd' }, '12 mm'))).toBe(
      '<output id="d" role="none"><span aria-live="polite">12 mm</span></output>',
    );
  });
});

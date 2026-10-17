import { createRoot } from 'react-dom/client';
import { AnimationControlledSurface } from '../../src/controlled';
import { testHost } from './host';
const host = testHost(
  new URLSearchParams(location.search).has('readonly'),
  new URLSearchParams(location.search).has('multi'),
);
const root = createRoot(document.getElementById('root')!);
root.render(<AnimationControlledSurface editor={host.editor} playback={host.playback} />);
const api = { ...host, unmount: () => root.unmount() };
declare global {
  interface Window {
    controlledTest: typeof api;
  }
}
window.controlledTest = api;

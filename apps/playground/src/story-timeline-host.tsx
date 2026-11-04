import { mountStoryTimeline } from '@editor-platform/reference-artifact-host/creative/workspace';
void mountStoryTimeline().catch((error) => {
  const p = document.createElement('p');
  p.setAttribute('role', 'alert');
  p.textContent = String(error);
  document.getElementById('root')!.append(p);
});

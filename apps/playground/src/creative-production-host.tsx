import { mountCreativeProduction } from '@editor-platform/reference-artifact-host/creative/workspace';
void mountCreativeProduction().catch((error) => {
  const p = document.createElement('p');
  p.setAttribute('role', 'alert');
  p.textContent = String(error);
  document.getElementById('root')!.append(p);
});

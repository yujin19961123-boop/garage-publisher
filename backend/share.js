// A single delegated listener paints light on the cards without layout or network work.
const fine = matchMedia('(hover: hover) and (pointer: fine)');
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const properties = ['--light-x', '--light-y', '--rotate-x', '--rotate-y', '--move-x', '--move-y'];
let frame = 0, position = null, active = null;
function clear() {
  if (!active) return;
  delete active.dataset.active;
  for (const name of properties) active.style.removeProperty(name);
  active = null;
}
function reset() {
  cancelAnimationFrame(frame); frame = 0; position = null; clear();
}
function paint() {
  frame = 0;
  if (!position || !fine.matches || reduced.matches) return reset();
  const surface = position.target.closest('[data-light]');
  if (surface !== active) clear();
  if (!surface) return;
  const rect = surface.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const x = Math.max(0, Math.min(1, (position.x - rect.left) / rect.width));
  const y = Math.max(0, Math.min(1, (position.y - rect.top) / rect.height));
  active = surface;
  surface.style.setProperty('--light-x', (x * 100).toFixed(2) + '%');
  surface.style.setProperty('--light-y', (y * 100).toFixed(2) + '%');
  surface.style.setProperty('--rotate-x', ((.5 - y) * 3).toFixed(2) + 'deg');
  surface.style.setProperty('--rotate-y', ((x - .5) * 3).toFixed(2) + 'deg');
  surface.style.setProperty('--move-x', ((x - .5) * 12).toFixed(2) + 'px');
  surface.style.setProperty('--move-y', ((y - .5) * 10).toFixed(2) + 'px');
  surface.dataset.active = 'true';
}
document.addEventListener('pointermove', event => {
  if (event.pointerType !== 'mouse' || !fine.matches || reduced.matches) return reset();
  if (!(event.target instanceof Element)) return;
  position = {x: event.clientX, y: event.clientY, target: event.target};
  if (!frame) frame = requestAnimationFrame(paint);
}, {passive: true});
document.addEventListener('pointerout', event => { if (!event.relatedTarget) reset(); }, {passive: true});
window.addEventListener('blur', reset);
fine.addEventListener('change', reset);
reduced.addEventListener('change', reset);

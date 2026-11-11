import {useEffect, useRef, useState} from 'react';
import {SignalMark} from './Identity';
import {ActionIcon} from './ActionIcon';
import './project-welcome.css';

const seen = new Set<string>();
const key = (id: string) => `garage:welcome:${id}`;
export function resetProjectWelcome(id: string) {
  seen.delete(id);
  try { sessionStorage.removeItem(key(id)); } catch { /* Storage may be disabled. */ }
}
function alreadySeen(id: string) {
  try { return seen.has(id) || sessionStorage.getItem(key(id)) === 'seen'; } catch { return seen.has(id); }
}

export function ProjectWelcome({userId, count, published, blocked, openingShare, onOpenShare, onShare, onCreate}: {
  userId: string; count: number; published: number; blocked: boolean; openingShare: boolean;
  onOpenShare: () => void; onShare: () => void; onCreate: () => void;
}) {
  const [phase, setPhase] = useState(() => alreadySeen(userId) || matchMedia('(prefers-reduced-motion: reduce)').matches ? 'compact' : 'expanded');
  const fold = useRef<HTMLDivElement>(null), busy = useRef(blocked), reconcile = useRef<() => void>(() => {});
  busy.current = blocked;
  useEffect(() => { reconcile.current(); }, [blocked]);
  useEffect(() => {
    seen.add(userId);
    try { sessionStorage.setItem(key(userId), 'seen'); } catch { /* In-memory fallback. */ }
    if (!fold.current) return;
    const node = fold.current;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    const protectedSelector = '.project-grid,.empty,.header-actions,.share-orb';
    let animations: Animation[] = [], timer: ReturnType<typeof setTimeout> | undefined;
    let done = false, disposed = false, quietUntil = 0, wasProtected = false, unfocused = false, keyboard = false, pressed = false;
    let started = false, lastUserScroll = 0;
    const originalStyle = node.getAttribute('style'), originalInert = node.inert;
    const promotions = new Map<HTMLElement, string>();
    let pointer: {x: number; y: number} | null = null;
    const deadline = Date.now() + 3000;
    function protectedArea() {
      const hovered = pointer && document.elementFromPoint(pointer.x, pointer.y);
      const focused = document.activeElement;
      // Defer BEFORE starting for hover. Once moving, a card passing under a
      // stationary mouse is not user input and must not stall the animation.
      return !!((!started && hovered?.closest(protectedSelector)) || pressed || node.contains(focused) || (keyboard && focused?.closest(protectedSelector)));
    }
    function finish() {
      if (done || disposed) return;
      done = true; clearTimeout(timer);
      node.style.visibility = 'hidden';
      setPhase('compact');
    }
    function start() {
      started = true;
      const root = node.parentElement!, workspace = root.parentElement!;
      const toolbar = root.querySelector<HTMLElement>('.project-toolbar')!;
      const following = [...workspace.children].filter((element): element is HTMLElement => element instanceof HTMLElement && element !== root && !element.classList.contains('toast'));
      const targets = [toolbar, ...following];
      const before = targets.map(element => element.getBoundingClientRect().top);
      const height = node.getBoundingClientRect().height;
      // FLIP: compact the layout ONCE, then preserve the old visual positions
      // with compositor transforms. No animated height or per-frame hit tests.
      Object.assign(node.style, {position: 'absolute', inset: '0 0 auto', width: '100%', height: `${height}px`, pointerEvents: 'none', willChange: 'transform, opacity'});
      node.inert = true;
      const after = targets.map(element => element.getBoundingClientRect().top);
      animations = [node.animate([{opacity: 1, transform: 'translate3d(0,0,0)'}, {opacity: 0, transform: 'translate3d(0,-18px,0)'}], {duration: 180, easing: 'ease-out', fill: 'forwards'})];
      targets.forEach((element, index) => {
        promotions.set(element, element.style.willChange);
        element.style.willChange = 'transform';
        animations.push(element.animate([{transform: `translate3d(0,${before[index]-after[index]}px,0)`}, {transform: 'translate3d(0,0,0)'}], {delay: 80, duration: 520, easing: 'cubic-bezier(.22,.68,.1,1)', fill: 'both'}));
      });
      Promise.all(animations.map(animation => animation.finished)).then(finish).catch(() => { /* Unmount/reduced motion cancels the group. */ });
    }
    function sync() {
      clearTimeout(timer);
      if (disposed || done) return;
      if (reduced.matches) { animations.forEach(animation => animation.cancel()); finish(); return; }
      const guarded = protectedArea();
      if (wasProtected && !guarded) quietUntil = Math.max(quietUntil, Date.now() + 800);
      wasProtected = guarded;
      const wait = Math.max(deadline, quietUntil) - Date.now();
      if (document.hidden || unfocused || busy.current || window.scrollY > 8 || guarded || wait > 0) {
        if (started) {
          animations.forEach(animation => {
            if (animation.playState === 'running') {
              const time = animation.currentTime;
              animation.pause();
              // Resolve the hold time immediately, before pointerup/click.
              if (time !== null) animation.currentTime = time;
            }
          });
          setPhase('paused');
        }
        if (wait > 0) timer = setTimeout(sync, wait);
        return;
      }
      if (!started) start();
      else animations.forEach(animation => { if (animation.playState === 'paused') animation.play(); });
      setPhase('collapsing');
    }
    function move(event: PointerEvent) { pointer = event.pointerType === 'mouse' ? {x: event.clientX, y: event.clientY} : null; sync(); }
    function press(event: PointerEvent) { keyboard = false; pressed = event.target instanceof Element && !!event.target.closest(protectedSelector); if (pressed) quietUntil = Date.now() + 800; sync(); }
    function release() { if (pressed) { pressed = false; quietUntil = Date.now() + 800; sync(); } }
    function keydown(event: KeyboardEvent) {
      if (['Tab', 'Enter', ' ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End'].includes(event.key)) {
        keyboard = true;
        if (event.key !== 'Tab' && event.key !== 'Enter') userScroll();
        sync();
      }
    }
    function out(event: PointerEvent) { if (!event.relatedTarget) { pointer = null; sync(); } }
    function userScroll() { lastUserScroll = Date.now(); quietUntil = lastUserScroll + 1200; sync(); }
    function scroll() { if (!started || Date.now() - lastUserScroll < 1500) { quietUntil = Date.now() + 1200; sync(); } }
    function focus() { quietUntil = Date.now() + 800; sync(); }
    function blur() { unfocused = true; pointer = null; sync(); }
    function windowFocus() { unfocused = false; quietUntil = Date.now() + 800; sync(); }
    function resize() { if (started) finish(); else sync(); }
    reconcile.current = sync;
    document.addEventListener('pointermove', move, {passive: true});
    document.addEventListener('pointerdown', press, {passive: true, capture: true}); document.addEventListener('pointerup', release, {passive: true, capture: true}); document.addEventListener('pointercancel', release, {passive: true, capture: true}); document.addEventListener('keydown', keydown, true);
    document.addEventListener('wheel', userScroll, {passive: true}); document.addEventListener('touchmove', userScroll, {passive: true});
    document.addEventListener('pointerout', out, {passive: true});
    document.addEventListener('focusin', focus); document.addEventListener('focusout', focus);
    document.addEventListener('visibilitychange', sync);
    window.addEventListener('scroll', scroll, {passive: true}); window.addEventListener('blur', blur); window.addEventListener('focus', windowFocus);
    window.addEventListener('resize', resize);
    reduced.addEventListener('change', sync);
    sync();
    return () => {
      disposed = true; clearTimeout(timer); animations.forEach(animation => animation.cancel()); reconcile.current = () => {};
      promotions.forEach((value, element) => { if (value) element.style.willChange = value; else element.style.removeProperty('will-change'); });
      if (originalStyle === null) node.removeAttribute('style'); else node.setAttribute('style', originalStyle);
      node.inert = originalInert;
      document.removeEventListener('pointermove', move); document.removeEventListener('pointerout', out);
      document.removeEventListener('pointerdown', press, true); document.removeEventListener('pointerup', release, true); document.removeEventListener('pointercancel', release, true); document.removeEventListener('keydown', keydown, true);
      document.removeEventListener('wheel', userScroll); document.removeEventListener('touchmove', userScroll);
      document.removeEventListener('focusin', focus); document.removeEventListener('focusout', focus);
      document.removeEventListener('visibilitychange', sync); window.removeEventListener('scroll', scroll); window.removeEventListener('blur', blur); window.removeEventListener('focus', windowFocus);
      window.removeEventListener('resize', resize);
      reduced.removeEventListener('change', sync);
    };
  }, [userId, phase === 'compact']);

  return <header className="masthead project-masthead" data-welcome-state={phase}>
    {phase !== 'compact' && <div className="welcome-fold" ref={fold}>
      <div className="welcome-art" data-pointer-surface="hero">
        <div className="headline-block"><h2 className="welcome-title" aria-hidden="true"><span>原型</span><em>易分享<span className="title-dot">。</span></em></h2></div>
        <button type="button" className="hero-mark share-orb" data-pointer-surface="orb" onClick={onOpenShare} disabled={openingShare || blocked} aria-label="查看我的全部原型" aria-busy={openingShare} title="查看我的全部原型"><SignalMark/></button>
      </div>
    </div>}
    <div className="project-toolbar">
      <div className="project-toolbar-label"><h1 aria-label="项目列表">项目</h1><div className="summary"><span><strong>{count}</strong><span>个原型</span></span><span><strong>{published}</strong><span>已发布</span></span></div></div>
      <div className="header-actions"><button className="share-all-button" onClick={onShare}><ActionIcon name="share"/>分享全部原型</button><button data-pointer-surface="button" className="primary create-button" onClick={onCreate}><span aria-hidden="true">＋</span> 创建项目</button></div>
    </div>
  </header>;
}

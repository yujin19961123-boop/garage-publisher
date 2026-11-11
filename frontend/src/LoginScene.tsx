import {useEffect, useRef} from 'react';
import {Brand, SignalMark} from './Identity';
import './login-scene.css';

type Body = {node: HTMLElement; x: number; y: number; vx: number; vy: number; cx: number; cy: number};
const clamp = (n: number, limit: number) => Math.max(-limit, Math.min(limit, n));

export function LoginScene() {
  const scene = useRef<HTMLElement>(null);
  useEffect(() => {
    const root = scene.current!;
    const fine = matchMedia('(hover: hover) and (pointer: fine)'), reduced = matchMedia('(prefers-reduced-motion: reduce)');
    const letters: Body[] = [...root.querySelectorAll<HTMLElement>('.scene-letter')].map(node => ({node, x: 0, y: 0, vx: 0, vy: 0, cx: 0, cy: 0}));
    const orb = root.querySelector<HTMLElement>('.scene-orbit-motion')!;
    const anchor = root.querySelector<HTMLElement>('.intro-orbit')!;
    const halo = root.querySelector<HTMLElement>('.scene-cursor')!;
    const ripple = root.querySelector<HTMLElement>('.scene-ripple')!;
    const sparks = [...root.querySelectorAll<HTMLElement>('.scene-spark')];
    const ball: Body = {node: orb, x: 0, y: 0, vx: 0, vy: 0, cx: 0, cy: 0};
    let frame = 0, last = 0, inside = false, px = 0, py = 0, bounds = root.getBoundingClientRect();
    let animations: Animation[] = [];
    const enabled = () => fine.matches && !reduced.matches;
    function measure() {
      bounds = root.getBoundingClientRect();
      for (const body of letters) {
        const rect = body.node.parentElement!.getBoundingClientRect();
        body.cx = rect.left - bounds.left + rect.width / 2;
        body.cy = rect.top - bounds.top + rect.height / 2;
      }
      const rect = anchor.getBoundingClientRect();
      ball.cx = rect.left - bounds.left + rect.width / 2;
      ball.cy = rect.top - bounds.top + rect.height / 2;
    }
    function spring(body: Body, tx: number, ty: number, dt: number, stiffness: number, damping: number) {
      body.vx = (body.vx + (tx - body.x) * stiffness * dt) * Math.exp(-damping * dt);
      body.vy = (body.vy + (ty - body.y) * stiffness * dt) * Math.exp(-damping * dt);
      body.x += body.vx * dt; body.y += body.vy * dt;
      return Math.abs(tx - body.x) + Math.abs(ty - body.y) + Math.abs(body.vx) + Math.abs(body.vy);
    }
    function paint(timestamp: number) {
      frame = 0;
      const dt = Math.min((timestamp - (last || timestamp - 16)) / 1000, .032); last = timestamp;
      let energy = 0;
      for (const body of letters) {
        const dx = body.cx - px, dy = body.cy - py, distance = Math.hypot(dx, dy);
        const force = inside ? Math.pow(Math.max(0, 1 - distance / 185), 2) : 0;
        energy += spring(body, dx / Math.max(distance, 25) * force * 35, dy / Math.max(distance, 25) * force * 25 - force * 9, dt, 230, 13);
        body.node.style.transform = `translate3d(${body.x.toFixed(2)}px,${body.y.toFixed(2)}px,0) rotate(${clamp(body.x * .24, 9).toFixed(2)}deg) scale(${(1 + force * .07).toFixed(3)})`;
        body.node.style.setProperty('--letter-charge', force.toFixed(3));
      }
      const dx = inside ? px - ball.cx : 0, dy = inside ? py - ball.cy : 0;
      energy += spring(ball, clamp(dx * .24, 82), clamp(dy * .20, 64), dt, 85, 10);
      orb.style.transform = `perspective(700px) translate3d(${ball.x.toFixed(2)}px,${ball.y.toFixed(2)}px,0) rotateX(${(-ball.y * .16).toFixed(2)}deg) rotateY(${(ball.x * .18).toFixed(2)}deg) rotate(${clamp(ball.vx * .025, 8).toFixed(2)}deg)`;
      orb.style.setProperty('--orbit-turn', `${(ball.x * .45).toFixed(2)}deg`);
      orb.style.setProperty('--orb-light-x', `${(50 + ball.x * .4).toFixed(2)}%`);
      if (energy > .12) frame = requestAnimationFrame(paint);
      else {
        last = 0;
        if (!inside) {
          for (const body of [...letters, ball]) { body.x = body.y = body.vx = body.vy = 0; body.node.style.removeProperty('transform'); }
          orb.style.removeProperty('--orbit-turn'); orb.style.removeProperty('--orb-light-x');
        }
      }
    }
    function wake() { if (!frame) { last = 0; frame = requestAnimationFrame(paint); } }
    function move(event: PointerEvent) {
      if (event.pointerType !== 'mouse' || !enabled()) return;
      if (!inside) measure();
      inside = true; root.dataset.sceneActive = 'true';
      px = event.clientX - bounds.left; py = event.clientY - bounds.top;
      root.style.setProperty('--scene-x', `${px}px`); root.style.setProperty('--scene-y', `${py}px`);
      halo.style.transform = `translate3d(${px}px,${py}px,0)`;
      wake();
    }
    function stopBursts() { animations.forEach(animation => animation.cancel()); animations = []; }
    function leave() {
      inside = false; delete root.dataset.sceneActive; stopBursts(); wake();
    }
    function reset() {
      inside = false; delete root.dataset.sceneActive; stopBursts(); cancelAnimationFrame(frame); frame = last = 0;
      for (const body of [...letters, ball]) { body.x = body.y = body.vx = body.vy = 0; body.node.removeAttribute('style'); }
      root.style.removeProperty('--scene-x'); root.style.removeProperty('--scene-y'); halo.style.removeProperty('transform');
    }
    function burst(event: PointerEvent) {
      if (event.button !== 0 || event.pointerType !== 'mouse' || !enabled() || (event.target instanceof Element && event.target.closest('.login-wordmark'))) return;
      move(event); stopBursts();
      ripple.style.left = `${px}px`; ripple.style.top = `${py}px`;
      animations.push(ripple.animate([{transform: 'translate(-50%,-50%) scale(.12)', opacity: .8}, {transform: 'translate(-50%,-50%) scale(1.8)', opacity: 0}], {duration: 850, easing: 'cubic-bezier(.1,.6,.25,1)'}));
      sparks.forEach((spark, i) => {
        const angle = i / sparks.length * Math.PI * 2, distance = 48 + (i % 3) * 17;
        spark.style.left = `${px}px`; spark.style.top = `${py}px`;
        animations.push(spark.animate([{transform: 'translate(-50%,-50%) scale(.4)', opacity: 0}, {opacity: .8, offset: .15}, {transform: `translate(${Math.cos(angle) * distance}px,${Math.sin(angle) * distance}px) rotate(90deg) scale(.2)`, opacity: 0}], {duration: 650 + i * 22, easing: 'cubic-bezier(.15,.6,.3,1)'}));
      });
      for (const body of [...letters, ball]) {
        const dx = body.cx + body.x - px, dy = body.cy + body.y - py, distance = Math.hypot(dx, dy);
        const force = Math.max(0, 1 - distance / 420) * (body === ball ? 450 : 240);
        body.vx += (dx / Math.max(distance, 30) || .4) * force; body.vy += (dy / Math.max(distance, 30) || -.6) * force;
      }
      wake();
    }
    const observer = new ResizeObserver(() => { reset(); measure(); }); observer.observe(root);
    root.addEventListener('pointermove', move, {passive: true}); root.addEventListener('pointerleave', leave); root.addEventListener('pointerdown', burst);
    window.addEventListener('blur', reset); window.addEventListener('scroll', reset, {passive: true});
    document.addEventListener('visibilitychange', reset); fine.addEventListener('change', reset); reduced.addEventListener('change', reset);
    return () => {
      reset(); observer.disconnect(); root.removeEventListener('pointermove', move); root.removeEventListener('pointerleave', leave); root.removeEventListener('pointerdown', burst);
      window.removeEventListener('blur', reset); window.removeEventListener('scroll', reset); document.removeEventListener('visibilitychange', reset);
      fine.removeEventListener('change', reset); reduced.removeEventListener('change', reset);
    };
  }, []);

  const line = (text: string) => <span>{[...text].map((character, index) => <span className={'scene-letter-anchor' + (character === '。' ? ' title-dot' : '')} key={index}><span className="scene-letter">{character}</span></span>)}</span>;
  return <section className="intro login-scene" ref={scene}>
    <div className="scene-light" aria-hidden="true"/>
    <div className="login-wordmark"><Brand/></div>
    <div className="login-display"><span className="eyebrow">FROM YOUR DESK TO EVERYWHERE</span><h1 aria-label="有想法？放出来。"><span aria-hidden="true">{line('有想法？')}{line('放出来。')}</span></h1></div>
    <div className="intro-orbit" aria-hidden="true"><div className="scene-orbit-motion"><div className="orbit-ring"/><div className="orbit-core"><SignalMark/></div></div></div>
    <div className="scene-effects" aria-hidden="true"><span className="scene-cursor"><i/></span><span className="scene-ripple"/>{Array.from({length: 8}, (_, index) => <span className="scene-spark" key={index}/>)}</div>
  </section>;
}

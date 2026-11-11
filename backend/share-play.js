// Decorative, local-only playground. No requests, storage, timers at rest or app actions.
(() => {
  const hero = document.querySelector('.hero'), title = hero?.querySelector('.hero-title'), field = hero?.querySelector('.glass-installation');
  if (!hero || !title || !field) return;
  const enabled = () => fine.matches && !reduced.matches;
  const clamp = (value, limit) => Math.max(-limit, Math.min(limit, value));
  const animations = new Map();
  function animate(node, frames, options) {
    animations.get(node)?.cancel();
    const animation = node.animate(frames, options); animations.set(node, animation);
    void animation.finished.then(() => { if (animations.get(node) === animation) animations.delete(node); }, () => {});
    return animation;
  }
  function stopAnimations(root) {
    for (const [node, animation] of animations) if (root.contains(node)) { animation.cancel(); animations.delete(node); }
  }
  function body(node) { return {node, x: 0, y: 0, vx: 0, vy: 0, cx: 0, cy: 0}; }
  function spring(b, tx, ty, dt, stiffness = 210, damping = 13) {
    b.vx = (b.vx + (tx - b.x) * stiffness * dt) * Math.exp(-damping * dt);
    b.vy = (b.vy + (ty - b.y) * stiffness * dt) * Math.exp(-damping * dt);
    b.x += b.vx * dt; b.y += b.vy * dt;
    return Math.abs(tx - b.x) + Math.abs(ty - b.y) + Math.abs(b.vx) + Math.abs(b.vy);
  }

  // The login page's per-letter repulsion, bounded to this decorative title.
  const letters = [...title.querySelectorAll('.collection-glyph')].map(body);
  const textCursor = title.querySelector('.text-cursor'), textRipple = title.querySelector('.text-ripple');
  let textFrame = 0, textLast = 0, textInside = false, textX = 0, textY = 0, textBounds;
  function measureText() {
    textBounds = title.getBoundingClientRect();
    for (const b of letters) { const r = b.node.parentElement.getBoundingClientRect(); b.cx = r.left - textBounds.left + r.width / 2; b.cy = r.top - textBounds.top + r.height / 2; }
  }
  function paintText(now) {
    textFrame = 0;
    const dt = Math.min((now - (textLast || now - 16)) / 1000, .032); textLast = now;
    let energy = 0;
    for (const b of letters) {
      const dx = b.cx - textX, dy = b.cy - textY, distance = Math.hypot(dx, dy), force = textInside ? Math.pow(Math.max(0, 1 - distance / 180), 2) : 0;
      const strength = Math.min(1, textBounds.width / 360);
      energy += spring(b, dx / Math.max(distance, 25) * force * 34 * strength, (dy / Math.max(distance, 25) * force * 24 - force * 9) * strength, dt);
      b.node.style.transform = `translate3d(${b.x.toFixed(2)}px,${b.y.toFixed(2)}px,0) rotate(${clamp(b.x * .24, 9).toFixed(2)}deg) scale(${(1 + force * .06).toFixed(3)})`;
      b.node.style.setProperty('--glyph-charge', force.toFixed(3));
    }
    if (energy > .12) textFrame = requestAnimationFrame(paintText);
    else { textLast = 0; if (!textInside) resetText(); }
  }
  function wakeText() { if (!textFrame) { textLast = 0; textFrame = requestAnimationFrame(paintText); } }
  function moveText(event) {
    if (event.pointerType !== 'mouse' || !enabled()) return;
    if (!textInside) measureText();
    textInside = true; title.dataset.textActive = 'true'; textX = event.clientX - textBounds.left; textY = event.clientY - textBounds.top;
    textCursor.style.transform = `translate3d(${textX}px,${textY}px,0)`; wakeText();
  }
  function resetText() {
    if (!textInside && !textFrame && !title.hasAttribute('data-text-active') && !letters.some(b => b.node.hasAttribute('style')) && !textRipple.hasAttribute('style')) return;
    cancelAnimationFrame(textFrame); textFrame = textLast = 0; textInside = false; delete title.dataset.textActive; stopAnimations(title);
    for (const b of letters) { b.x = b.y = b.vx = b.vy = 0; b.node.removeAttribute('style'); }
    textCursor.removeAttribute('style'); textRipple.removeAttribute('style');
  }
  title.addEventListener('pointermove', moveText, {passive: true});
  title.addEventListener('pointerleave', () => { if (!textInside) return; textInside = false; delete title.dataset.textActive; stopAnimations(title); wakeText(); });
  title.addEventListener('pointerdown', event => {
    if (event.button !== 0 || event.pointerType !== 'mouse' || !enabled()) return;
    moveText(event); textRipple.style.left = `${textX}px`; textRipple.style.top = `${textY}px`;
    animate(textRipple, [{transform: 'translate(-50%,-50%) scale(.1)', opacity: .8}, {transform: 'translate(-50%,-50%) scale(1.6)', opacity: 0}], {duration: 700, easing: 'ease-out'});
    for (const b of letters) { const dx = b.cx - textX, dy = b.cy - textY, d = Math.hypot(dx, dy), f = Math.max(0, 1 - d / 320) * 240; b.vx += (dx / Math.max(d, 25) || .4) * f; b.vy += (dy / Math.max(d, 25) || -.6) * f; } wakeText();
  });

  // Thirty-second orbital collection: a spring-following probe attracts seeds;
  // clicking releases a short-range pull. All nodes are a fixed, reused pool.
  const effects = field.querySelector('.orbit-game-effects'), scoreNode = field.querySelector('[data-game-score]'), timeNode = field.querySelector('[data-game-time]'), comboNode = field.querySelector('[data-game-combo]'), hintNode = field.querySelector('[data-game-hint]');
  const orb = body(field.querySelector('.glass-orb')), core = field.querySelector('.orb-core'), orbitOne = field.querySelector('.orbit-one'), orbitTwo = field.querySelector('.orbit-two'), tiles = [...field.querySelectorAll('.glass-tile')];
  let probe, pulse, seeds = [], trails = [], bursts = [], frame = 0, last = 0, bounds, inside = false, phase = 'idle', end = 0, score = 0, combo = 0, lastCatch = -Infinity, lastPulse = -Infinity, burstIndex = 0, tx = 0, ty = 0, pointerX = 0, pointerY = 0;
  const player = {x: 0, y: 0, vx: 0, vy: 0};
  function make(className) { const node = document.createElement('span'); node.className = className; effects.append(node); return node; }
  function initializePool() {
    if (probe) return;
    trails = Array.from({length: 7}, () => ({node: make('orbit-probe-trail'), x: 0, y: 0}));
    probe = make('orbit-probe'); pulse = make('orbit-pulse');
    seeds = Array.from({length: 6}, (_, index) => ({node: make('orbit-seed is-dormant'), index, x: 0, y: 0, vx: 0, vy: 0, angle: 0, rx: 0, ry: 0, due: 0}));
    bursts = Array.from({length: 6}, () => make('orbit-catch'));
  }
  function spawn(seed, now, first = false) {
    seed.angle = seed.index / 6 * Math.PI * 2 + (first ? .35 : Math.random() * 1.5);
    seed.rx = bounds.width * (.23 + Math.random() * .13); seed.ry = bounds.height * (.23 + Math.random() * .11);
    seed.x = bounds.width / 2 + Math.cos(seed.angle) * seed.rx; seed.y = bounds.height / 2 + Math.sin(seed.angle) * seed.ry;
    seed.vx = seed.vy = 0; seed.due = now + (first ? 0 : 450 + Math.random() * 300); seed.node.classList.add('is-dormant');
  }
  function start(now) {
    initializePool(); stopAnimations(field); bounds = field.getBoundingClientRect(); phase = 'playing'; field.dataset.gameState = phase;
    end = now + 30000; score = combo = 0; lastCatch = lastPulse = -Infinity; scoreNode.textContent = '00'; timeNode.textContent = '00:30'; comboNode.textContent = ''; hintNode.textContent = '';
    player.x = pointerX; player.y = pointerY; player.vx = player.vy = 0;
    trails.forEach(t => { t.x = player.x; t.y = player.y; }); seeds.forEach(s => spawn(s, now, true)); wake();
  }
  function catchSeed(seed, now) {
    combo = now - lastCatch < 1700 ? combo + 1 : 1; lastCatch = now;
    const points = Math.min(3, 1 + Math.floor(combo / 4)); score += points; scoreNode.textContent = String(score).padStart(2, '0'); comboNode.textContent = combo > 1 ? `连击 ×${combo}` : '';
    const flash = bursts[burstIndex++ % bursts.length]; flash.textContent = `+${points}`; flash.style.left = `${seed.x}px`; flash.style.top = `${seed.y}px`;
    animate(flash, [{opacity: 0, transform: 'translate(-50%,-20%) scale(.6)'}, {opacity: 1, offset: .18}, {opacity: 0, transform: 'translate(-50%,-170%) scale(1.1)'}], {duration: 650, easing: 'ease-out'});
    animate(core, [{scale: '1'}, {scale: '1.14', offset: .25}, {scale: '1'}], {duration: 380, easing: 'ease-out'});
    orb.vx += (Math.random() - .5) * 50; orb.vy -= 30; spawn(seed, now);
  }
  function finishRound() {
    phase = 'finished'; field.dataset.gameState = phase; timeNode.textContent = '00:00'; comboNode.textContent = ''; hintNode.textContent = '点击再玩一轮';
    seeds.forEach(s => s.node.classList.add('is-dormant')); stopAnimations(field);
    for (const node of bursts) node.removeAttribute('style');
  }
  function paint(now) {
    frame = 0; const dt = Math.min((now - (last || now - 16)) / 1000, .032); last = now;
    let energy = spring(orb, inside ? tx : 0, inside ? ty : 0, dt, 85, 10);
    orb.node.style.transform = `translate3d(${orb.x.toFixed(2)}px,${orb.y.toFixed(2)}px,0) rotate(${(orb.x * .05).toFixed(2)}deg)`;
    orbitOne.style.transform = `rotate(${-28 + orb.x * .13}deg)`; orbitTwo.style.transform = `rotate(${29 - orb.y * .15}deg)`;
    tiles[0].style.transform = `translate3d(${(-orb.y * .6).toFixed(2)}px,${(orb.x * .5).toFixed(2)}px,0) rotate(${22 + orb.x * .2}deg)`;
    tiles[1].style.transform = `translate3d(${(orb.y * .8).toFixed(2)}px,${(-orb.x * .6).toFixed(2)}px,0) rotate(${-19 - orb.y * .3}deg)`;
    if (inside) {
      energy += spring(player, pointerX, pointerY, dt, 260, 17);
      probe.style.transform = `translate3d(${player.x.toFixed(2)}px,${player.y.toFixed(2)}px,0) rotate(${clamp(player.vx * .03, 18)}deg)`;
      let previous = player;
      trails.forEach((t, index) => { const follow = 1 - Math.exp(-(18 - index) * dt); t.x += (previous.x - t.x) * follow; t.y += (previous.y - t.y) * follow; t.node.style.transform = `translate3d(${t.x.toFixed(2)}px,${t.y.toFixed(2)}px,0) scale(${1 - index * .09})`; t.node.style.opacity = String(.35 - index * .04); previous = t; });
    }
    if (phase === 'playing') {
      if (combo && now - lastCatch > 1700) { combo = 0; comboNode.textContent = ''; }
      const remaining = Math.max(0, Math.ceil((end - now) / 1000)), text = `00:${String(remaining).padStart(2, '0')}`;
      if (timeNode.textContent !== text) timeNode.textContent = text;
      if (now >= end) finishRound();
      else for (const seed of seeds) {
        if (now < seed.due) continue;
        seed.node.classList.remove('is-dormant'); seed.angle += dt * (.2 + seed.index * .025) * (seed.index % 2 ? -1 : 1);
        const ax = bounds.width / 2 + Math.cos(seed.angle) * seed.rx, ay = bounds.height / 2 + Math.sin(seed.angle) * seed.ry;
        const dx = player.x - seed.x, dy = player.y - seed.y, distance = Math.hypot(dx, dy), pull = Math.pow(Math.max(0, 1 - distance / 105), 2) * 460;
        seed.vx = (seed.vx + ((ax - seed.x) * 7 + dx / Math.max(distance, 1) * pull) * dt) * Math.exp(-3 * dt);
        seed.vy = (seed.vy + ((ay - seed.y) * 7 + dy / Math.max(distance, 1) * pull) * dt) * Math.exp(-3 * dt);
        seed.x = Math.max(12, Math.min(bounds.width - 12, seed.x + seed.vx * dt)); seed.y = Math.max(38, Math.min(bounds.height - 32, seed.y + seed.vy * dt));
        seed.node.style.transform = `translate3d(${seed.x.toFixed(2)}px,${seed.y.toFixed(2)}px,0) rotate(${seed.angle * 35}deg)`;
        if (Math.hypot(player.x - seed.x, player.y - seed.y) < 23) catchSeed(seed, now);
      }
    }
    if (phase === 'playing' || energy > .12) frame = requestAnimationFrame(paint);
    else { last = 0; if (!inside) resetGame(); }
  }
  function wake() { if (!frame) { last = 0; frame = requestAnimationFrame(paint); } }
  function moveGame(event) {
    if (event.pointerType !== 'mouse' || !enabled() || field.clientWidth < 220) return;
    if (!inside) bounds = field.getBoundingClientRect();
    pointerX = Math.max(12, Math.min(bounds.width - 12, event.clientX - bounds.left)); pointerY = Math.max(30, Math.min(bounds.height - 25, event.clientY - bounds.top));
    tx = clamp((pointerX - bounds.width / 2) * .2, Math.min(27, bounds.width * .065)); ty = clamp((pointerY - bounds.height / 2) * .16, Math.min(20, bounds.height * .06));
    inside = true; if (phase === 'idle' || phase === 'returning') start(performance.now()); wake();
  }
  function resetGame() {
    if (phase === 'idle' && !frame && !inside) return;
    cancelAnimationFrame(frame); frame = last = 0; inside = false; phase = 'idle'; delete field.dataset.gameState; stopAnimations(field);
    orb.x = orb.y = orb.vx = orb.vy = 0; [orb.node, orbitOne, orbitTwo, ...tiles, core].forEach(node => node.removeAttribute('style'));
    effects.querySelectorAll('span').forEach(node => node.removeAttribute('style')); seeds.forEach(s => s.node.classList.add('is-dormant'));
    scoreNode.textContent = '00'; timeNode.textContent = '00:30'; comboNode.textContent = ''; hintNode.textContent = '';
  }
  field.addEventListener('pointermove', moveGame, {passive: true});
  field.addEventListener('pointerleave', () => {
    if (!inside) return; inside = false; phase = 'returning'; field.dataset.gameState = phase; stopAnimations(field); seeds.forEach(s => s.node.classList.add('is-dormant')); wake();
  });
  field.addEventListener('pointerdown', event => {
    if (event.button !== 0 || event.pointerType !== 'mouse' || !enabled() || field.clientWidth < 220) return;
    moveGame(event); const now = performance.now(); if (phase === 'finished') { start(now); return; }
    if (now - lastPulse < 500) return; lastPulse = now;
    pulse.style.left = `${player.x}px`; pulse.style.top = `${player.y}px`;
    animate(pulse, [{transform: 'translate(-50%,-50%) scale(.1)', opacity: .9}, {transform: 'translate(-50%,-50%) scale(1.4)', opacity: 0}], {duration: 650, easing: 'ease-out'});
    for (const seed of seeds) { if (now < seed.due) continue; const dx = player.x - seed.x, dy = player.y - seed.y, d = Math.hypot(dx, dy), force = Math.max(0, 1 - d / 170) * 750; seed.vx += dx / Math.max(d, 1) * force; seed.vy += dy / Math.max(d, 1) * force; }
    orb.vx += (pointerX - bounds.width / 2) * .7; orb.vy += (pointerY - bounds.height / 2) * .7; wake();
  });
  const resetAll = () => { resetText(); resetGame(); };
  window.addEventListener('blur', resetAll); window.addEventListener('scroll', resetAll, {passive: true});
  document.addEventListener('visibilitychange', resetAll); fine.addEventListener('change', resetAll); reduced.addEventListener('change', resetAll);
  new ResizeObserver(resetAll).observe(hero);
})();

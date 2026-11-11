// Real mouse physics on the local login page; all APIs intercepted, no data writes.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const require = createRequire(new URL('../frontend/package.json', import.meta.url));
const {chromium} = require('playwright');
const origin = 'http://console.localhost:8080';
const output = new URL('../.local/', import.meta.url); mkdirSync(output, {recursive: true});
const browser = await chromium.launch({channel: 'chrome', headless: true});
try {
  async function setup(options = {}) {
    const context = await browser.newContext({viewport: {width: 1156, height: 1004}, reducedMotion: 'no-preference', ...options});
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      if (url.pathname.startsWith('/api/')) {
        assert.equal(url.pathname, '/api/v1/me'); assert.equal(route.request().method(), 'GET');
        return route.fulfill({status: 401, contentType: 'application/json', body: '{"message":"请登录"}'});
      }
      return route.continue();
    });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      window.sceneFrames = 0;
      const original = window.requestAnimationFrame;
      window.requestAnimationFrame = callback => original.call(window, time => {window.sceneFrames++; callback(time);});
    });
    await page.goto(origin); await page.locator('.login-scene').waitFor();
    return {context, page, errors};
  }
  const {context, page, errors} = await setup();
  const scene = page.locator('.login-scene'), glyph = page.locator('.scene-letter').first(), ball = page.locator('.scene-orbit-motion');
  await page.mouse.move(1145, 20); await page.waitForTimeout(800);
  assert.equal(await scene.getAttribute('data-scene-active'), null);
  assert.equal(await glyph.evaluate(node => getComputedStyle(node).transform), 'none');
  assert.equal(await ball.evaluate(node => getComputedStyle(node).transform), 'none');
  const resting = await scene.screenshot({path: fileURLToPath(new URL('login-scene-rest.png', output))});
  const box = await glyph.boundingBox();
  await page.mouse.move(box.x + box.width * .85, box.y + box.height * .35);
  await page.waitForFunction(() => Math.abs(new DOMMatrixReadOnly(getComputedStyle(document.querySelector('.scene-letter')).transform).m41) > 3);
  assert.equal(await scene.getAttribute('data-scene-active'), 'true');
  const shifts = await page.locator('.scene-letter').evaluateAll(nodes => nodes.map(node => new DOMMatrixReadOnly(getComputedStyle(node).transform).m41));
  assert.ok(new Set(shifts.map(x => x.toFixed(1))).size > 2, 'Glyphs must respond individually, not move as a single heading.');
  await page.screenshot({path: fileURLToPath(new URL('login-scene-text-hover.png', output))});
  const left = await ball.evaluate(node => getComputedStyle(node).transform);
  await page.mouse.move(480, 490); await page.waitForTimeout(600);
  const right = await ball.evaluate(node => getComputedStyle(node).transform);
  assert.notEqual(left, right, 'Orb must follow the cursor across the whole scene.');
  await page.mouse.click(430, 510);
  assert.equal(await page.locator('.scene-ripple').evaluate(node => node.getAnimations().some(a => a.playState === 'running')), true);
  assert.equal(await page.locator('.scene-spark').evaluateAll(nodes => nodes.filter(node => node.getAnimations().some(a => a.playState === 'running')).length), 8);
  await page.waitForTimeout(100);
  await page.screenshot({path: fileURLToPath(new URL('login-scene-click.png', output))});
  console.log('PASS: default composition, independent glyph repulsion, spring-following orb and click ripple/sparks.');

  await page.mouse.move(900, 490);
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.scene-orbit-motion')).transform === 'none');
  assert.equal(await scene.getAttribute('data-scene-active'), null);
  assert.equal(await glyph.evaluate(node => getComputedStyle(node).transform), 'none');
  const count = await page.evaluate(() => window.sceneFrames);
  await page.waitForTimeout(350);
  assert.equal(await page.evaluate(() => window.sceneFrames), count, 'Physics RAF must stop when settled.');
  assert.equal(await page.locator('.scene-effects').evaluate(node => node.getAnimations({subtree: true}).length), 0);
  await page.waitForTimeout(500);
  const returned = await scene.screenshot({path: fileURLToPath(new URL('login-scene-returned.png', output))});
  const diff = await page.evaluate(async ([before, after]) => {
    async function pixels(source) { const image = new Image(); image.src = 'data:image/png;base64,' + source; await image.decode(); const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height; const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0); return {data: ctx.getImageData(0, 0, canvas.width, canvas.height).data, width: canvas.width, height: canvas.height}; }
    const a = await pixels(before), b = await pixels(after); let changed = 0, total = 0, max = 0;
    for (let i = 0; i < a.data.length; i += 4) { let delta = 0; for (let c = 0; c < 3; c++) { const d = Math.abs(a.data[i+c] - b.data[i+c]); total += d; delta = Math.max(delta, d); } if (delta) changed++; max = Math.max(max, delta); }
    return {changed, max, mean: total / (a.width * a.height * 3), fraction: changed / (a.width * a.height)};
  }, [resting.toString('base64'), returned.toString('base64')]);
  console.log('Resting pixel comparison:', JSON.stringify(diff));
  assert.ok(diff.mean < .1 && diff.fraction < .01, 'Scene must return to the resting composition (allow subpixel compositor antialiasing).');
  await page.getByRole('textbox', {name: '账号', exact: true}).fill('scene-demo');
  assert.equal(await page.locator('[name="username"]').inputValue(), 'scene-demo');
  assert.equal(await scene.getAttribute('data-scene-active'), null);
  console.log('PASS: leave restores the resting composition, stops physics/particles and preserves normal login input.');

  await page.mouse.move(180, 290); await page.waitForTimeout(150);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  assert.equal(await ball.evaluate(node => getComputedStyle(node).transform), 'none');
  await page.mouse.move(190, 295); await page.waitForTimeout(150);
  await page.emulateMedia({reducedMotion: 'reduce'});
  // Media-query change listeners run asynchronously after emulation updates.
  await page.waitForFunction(() => matchMedia('(prefers-reduced-motion: reduce)').matches && !document.querySelector('.login-scene').hasAttribute('data-scene-active') && getComputedStyle(document.querySelector('.scene-letter')).transform === 'none' && getComputedStyle(document.querySelector('.scene-orbit-motion')).transform === 'none');
  assert.equal(await scene.getAttribute('data-scene-active'), null);
  assert.equal(await glyph.evaluate(node => getComputedStyle(node).transform), 'none');
  await page.mouse.click(200, 300);
  assert.equal(await scene.getAttribute('data-scene-active'), null);
  assert.equal(await page.locator('.scene-effects').evaluate(node => getComputedStyle(node).display), 'none');
  assert.deepEqual(errors, []); await context.close();
  console.log('PASS: window blur and reduced-motion immediately stop/reset effects.');

  const mobile = await setup({viewport: {width: 390, height: 844}, isMobile: true, hasTouch: true});
  await mobile.page.locator('.login-scene').tap({position: {x: 160, y: 200}});
  assert.equal(await mobile.page.locator('.login-scene').getAttribute('data-scene-active'), null);
  assert.equal(await mobile.page.locator('.scene-effects').evaluate(node => getComputedStyle(node).display), 'none');
  assert.equal(await mobile.page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(mobile.errors, []); await mobile.context.close();
  console.log('PASS: touch stays static with no horizontal overflow; all checks local, no forwarded APIs.');
} finally { await browser.close(); }

// Local UI only. Every API including login/logout is mocked; no database writes.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const require = createRequire(new URL('../frontend/package.json', import.meta.url));
const {chromium} = require('playwright');
const origin = 'http://console.localhost:8080', output = new URL('../.local/', import.meta.url);
mkdirSync(output, {recursive: true});
const browser = await chromium.launch({channel: 'chrome', headless: true});
try {
  async function setup(options = {}) {
    const {deferProjects = false, ...contextOptions} = options;
    const context = await browser.newContext({viewport: {width: 1156, height: 1004}, reducedMotion: 'no-preference', ...contextOptions});
    let releaseProjects = () => {};
    let signedIn = true;
    const user = {id: 'welcome-mock', username: '演示账号', role: 'member', status: 'active'};
    const projects = Array.from({length: 7}, (_, i) => ({id: `welcome-${i}`, name: `原型 ${i+1}`, ownerId: user.id, status: 'published', currentReleaseId: `r-${i}`, currentVersionNumber: 1, lastPublishedAt: new Date().toISOString(), url: `http://localhost:8080/welcome-${i}/`}));
    await context.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url());
      if (url.origin !== origin) return route.abort();
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const respond = (body, status = 200) => route.fulfill({status, contentType: 'application/json', body: JSON.stringify(body)});
      if (url.pathname === '/api/v1/me') return respond(signedIn ? {user} : {message: '请登录'}, signedIn ? 200 : 401);
      if (url.pathname === '/api/v1/auth/logout' && req.method() === 'POST') { signedIn = false; return respond({ok: true}); }
      if (url.pathname === '/api/v1/auth/login' && req.method() === 'POST') { signedIn = true; return respond({user}); }
      if (url.pathname === '/api/v1/share-page') return respond({url: 'http://localhost:8080/_share/welcome-mock/', publishedCount: 7});
      assert.equal(req.method(), 'GET', 'No project mutations are permitted.');
      if (url.pathname === '/api/v1/projects') {
        if (deferProjects) await new Promise(resolve => { releaseProjects = resolve; });
        return respond({items: projects});
      }
      if (url.pathname === '/api/v1/platform-config') return respond({maxUploadBytes: 104857600, maxExpandedBytes: 524288000, maxFiles: 10000});
      throw new Error(`Unexpected API mock: ${url.pathname}`);
    });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin);
    if (!deferProjects) await page.locator('.project').last().waitFor();
    else await page.locator('.project-masthead').waitFor();
    const header = page.locator('.project-masthead');
    const compact = () => page.waitForFunction(() => document.querySelector('.project-masthead')?.dataset.welcomeState === 'compact');
    return {context, page, header, compact, errors, releaseProjects: () => releaseProjects()};
  }
  {
    const {context, page, header, compact, errors} = await setup();
    assert.equal(await header.getAttribute('data-welcome-state'), 'expanded');
    await page.waitForTimeout(800);
    await page.screenshot({path: fileURLToPath(new URL('project-welcome-expanded.png', output))});
    await page.waitForTimeout(1200);
    assert.equal(await header.getAttribute('data-welcome-state'), 'expanded', 'Opening should not disappear early.');
    await page.waitForFunction(() => document.querySelector('.project-masthead')?.dataset.welcomeState === 'collapsing');
    await page.waitForTimeout(100);
    await page.screenshot({path: fileURLToPath(new URL('project-welcome-exit.png', output))});
    await compact();
    assert.equal(await page.locator('.welcome-fold').count(), 0);
    assert.ok((await page.locator('.project').first().boundingBox()).y < 300);
    await page.screenshot({path: fileURLToPath(new URL('project-welcome-compact.png', output))});
    await page.reload(); await header.waitFor();
    assert.equal(await header.getAttribute('data-welcome-state'), 'compact', 'Refresh must not replay this login’s intro.');
    await page.getByRole('button', {name: /分享全部原型/}).click();
    await page.getByRole('link', {name: /打开分享页/}).waitFor(); await page.keyboard.press('Escape');
    await page.getByRole('button', {name: /创建项目/}).first().click();
    await page.getByRole('dialog').waitFor(); await page.keyboard.press('Escape');
    assert.equal(await header.getAttribute('data-welcome-state'), 'compact');
    await page.getByRole('button', {name: '退出登录', exact: true}).click();
    await page.getByRole('textbox', {name: '账号', exact: true}).fill('demo');
    await page.locator('[name="password"]').fill('123456'); await page.getByRole('button', {name: '登录', exact: true}).click();
    await header.waitFor(); assert.equal(await header.getAttribute('data-welcome-state'), 'expanded', 'A new login gets a fresh opening.');
    assert.deepEqual(errors, []); await context.close();
    console.log('PASS: three-second opening, compact toolbar/card position, refresh/modal no replay and new login resets.');
  }
  {
    const {context, page, header, compact, errors} = await setup();
    await page.locator('.project').first().hover();
    await page.waitForTimeout(3600);
    assert.equal(await header.getAttribute('data-welcome-state'), 'expanded', 'Hovering a project must protect its position.');
    await page.getByRole('button', {name: /创建项目/}).first().click(); await page.getByRole('dialog').waitFor();
    await page.mouse.move(20, 110); await page.waitForTimeout(900);
    assert.equal(await header.getAttribute('data-welcome-state'), 'expanded', 'Open dialog blocks collapse.');
    await page.getByRole('dialog').getByRole('button', {name: /关闭/}).first().click();
    await page.mouse.move(20, 115);
    await compact(); assert.deepEqual(errors, []); await context.close();
    console.log('PASS: card hover and open dialog defer collapse; operation end resumes safely.');
  }
  {
    const {context, page, header, compact, errors} = await setup();
    await page.waitForTimeout(800); // Let the cards' initial entrance finish before measuring the gap.
    const first = await page.locator('.project').first().boundingBox();
    await page.mouse.move(first.x + 20, first.y - 15); // Blank gap; a rising card will approach it.
    await compact();
    assert.deepEqual(errors, []); await context.close();
    console.log('PASS: cards passing under a stationary mouse do not interrupt the exit animation.');
  }
  {
    const {context, page, header, compact, errors} = await setup();
    await page.waitForFunction(() => document.querySelector('.project-masthead')?.dataset.welcomeState === 'collapsing', {timeout: 10000});
    const first = await page.locator('.project').first().boundingBox();
    await page.mouse.move(first.x + 20, first.y + 20); await page.mouse.down();
    await page.waitForFunction(() => document.querySelector('.project-masthead')?.dataset.welcomeState === 'paused');
    const top = (await page.locator('.project-grid').boundingBox()).y;
    await page.waitForTimeout(500);
    assert.ok(Math.abs((await page.locator('.project-grid').boundingBox()).y - top) < 1, 'A real press freezes the moving list before the click completes.');
    await page.mouse.up(); await page.mouse.move(20, 115);
    await page.keyboard.press('Tab'); await page.locator('.project-manage').first().focus();
    await page.waitForTimeout(900);
    assert.equal(await header.getAttribute('data-welcome-state'), 'paused', 'Keyboard focus must protect controls.');
    await page.evaluate(() => document.activeElement?.blur()); await compact();
    assert.equal(await page.locator('.project-content').evaluate(element => element.style.willChange), '', 'Temporary compositor hints must be cleaned up.');
    assert.deepEqual(errors, []); await context.close();
    console.log('PASS: real mouse press and keyboard focus pause/resume together without moving the clicked target.');
  }
  {
    const {context, page, compact, errors, releaseProjects} = await setup({deferProjects: true});
    await page.locator('.empty').waitFor();
    await page.waitForFunction(() => document.querySelector('.project-masthead')?.dataset.welcomeState === 'collapsing');
    releaseProjects(); await page.locator('.project').last().waitFor(); await compact();
    assert.ok((await page.locator('.project').first().boundingBox()).y < 300);
    assert.deepEqual(errors, []); await context.close();
    console.log('PASS: project data arriving during the exit replaces the empty state without losing the animated container.');
  }
  {
    const {context, page, header, compact, errors} = await setup();
    await page.evaluate(() => scrollTo(0, 450)); await page.waitForTimeout(3600);
    assert.equal(await header.getAttribute('data-welcome-state'), 'expanded');
    await page.evaluate(() => scrollTo({top: 0, behavior: 'instant'})); await compact();
    assert.deepEqual(errors, []); await context.close();
    console.log('PASS: browsing below the fold defers layout changes until returning to the top and resting.');
  }
  for (const width of [390, 320]) {
    const {context, page, compact, errors} = await setup({viewport: {width, height: 844}, isMobile: true, hasTouch: true});
    await compact(); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.ok((await page.locator('.project').first().boundingBox()).y < 330);
    if (width === 390) await page.screenshot({path: fileURLToPath(new URL('project-welcome-mobile.png', output)), fullPage: true});
    assert.deepEqual(errors, []); await context.close();
  }
  {
    const {context, header, errors} = await setup({reducedMotion: 'reduce'});
    assert.equal(await header.getAttribute('data-welcome-state'), 'compact'); assert.deepEqual(errors, []); await context.close();
  }
  console.log('PASS: compact mobile at 390/320px and reduced-motion direct workspace; zero project writes.');
} finally { await browser.close(); }

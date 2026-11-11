// Local UI only: every API is mocked; no credentials or database writes.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdirSync} from 'node:fs';
const require = createRequire(new URL('../frontend/package.json', import.meta.url));
const {chromium} = require('playwright');
const origin = 'http://console.localhost:8080';
const output = new URL('../.local/', import.meta.url);
mkdirSync(output, {recursive: true});
const browser = await chromium.launch({channel: 'chrome', headless: true});
let release;
try {
  const context = await browser.newContext({viewport: {width: 1156, height: 1004}, reducedMotion: 'reduce'});
  let loggedIn = false, attempts = 0;
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin !== origin) return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const respond = (body, status = 200) => route.fulfill({status, contentType: 'application/json', body: JSON.stringify(body)});
    if (url.pathname === '/api/v1/me' && req.method() === 'GET') return respond({message: '请登录'}, 401);
    if (url.pathname === '/api/v1/auth/login' && req.method() === 'POST') {
      attempts++;
      assert.deepEqual(req.postDataJSON(), {username: 'demo', password: '123456'});
      await new Promise(resolve => {release = resolve;});
      if (attempts === 1) return respond({message: '账号或密码不正确'}, 401);
      loggedIn = true;
      return respond({user: {id: 'login-ui-mock', username: 'demo', role: 'member', status: 'active'}});
    }
    if (loggedIn && url.pathname === '/api/v1/projects' && req.method() === 'GET') return respond({items: []});
    if (loggedIn && url.pathname === '/api/v1/platform-config' && req.method() === 'GET') return respond({maxUploadBytes: 104857600, maxExpandedBytes: 524288000, maxFiles: 10000});
    throw new Error(`Unexpected mock request: ${req.method()} ${url.pathname}`);
  });
  await page.goto(origin);
  const username = page.getByRole('textbox', {name: '账号', exact: true});
  const password = page.locator('input[name="password"]');
  await username.waitFor(); await username.focus();
  await username.fill('demo');
  assert.equal(await username.getAttribute('autocomplete'), 'username');
  assert.equal(await password.getAttribute('autocomplete'), 'current-password');
  await page.keyboard.press('Tab'); await password.fill('123456');
  assert.equal(await password.getAttribute('type'), 'password');
  await password.evaluate(input => input.setSelectionRange(2, 4));
  await page.getByRole('button', {name: '显示密码', exact: true}).click();
  assert.equal(await password.getAttribute('type'), 'text');
  assert.equal(await password.evaluate(input => input === document.activeElement), true, 'Mouse reveal preserves typing focus.');
  assert.deepEqual(await password.evaluate(input => [input.selectionStart, input.selectionEnd]), [2, 4]);
  await page.keyboard.press('Tab');
  assert.equal(await page.getByRole('button', {name: '隐藏密码', exact: true}).evaluate(button => button === document.activeElement), true);
  await page.keyboard.press('Space');
  assert.equal(await password.getAttribute('type'), 'password');
  await password.focus();
  await password.dispatchEvent('keydown', {key: 'A', modifierCapsLock: true});
  await page.getByText('大写锁定已开启', {exact: true}).waitFor();
  await username.focus();
  assert.equal(await page.getByText('大写锁定已开启', {exact: true}).count(), 0);
  console.log('PASS: associated labels, autocomplete, mouse/keyboard password reveal, caret preservation and Caps Lock hint.');

  // Exercise the real browser autofill rendering, without any saved credentials.
  const cdp = await context.newCDPSession(page);
  await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
  const root = await cdp.send('DOM.getDocument');
  for (const selector of ['#login-username', '#login-password']) {
    const {nodeId} = await cdp.send('DOM.querySelector', {nodeId: root.root.nodeId, selector});
    await cdp.send('CSS.forcePseudoState', {nodeId, forcedPseudoClasses: ['autofill']});
  }
  assert.equal(await username.evaluate(input => input.matches(':-webkit-autofill')), true);
  assert.equal(await username.evaluate(input => getComputedStyle(input).webkitTextFillColor), 'rgb(63, 81, 69)');
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#login-username')).boxShadow.includes('1000px'));
  await page.screenshot({path: new URL('login-inputs-desktop.png', output).pathname.replace(/^\/(\w:)/, '$1'), fullPage: true});
  console.log('PASS: Chrome autofill uses the Morandi field colors.');

  for (const width of [390, 320]) {
    await page.setViewportSize({width, height: 844});
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.equal(await password.evaluate(input => getComputedStyle(input).fontSize), '16px');
    const target = await page.getByRole('button', {name: '显示密码', exact: true}).boundingBox();
    assert.ok(target.width >= 44 && target.height >= 44);
  }
  await page.setViewportSize({width: 390, height: 844});
  await password.scrollIntoViewIfNeeded();
  await page.screenshot({path: new URL('login-inputs-mobile.png', output).pathname.replace(/^\/(\w:)/, '$1'), fullPage: true});
  console.log('PASS: 390px/320px layouts, 16px input text and 44px password toggle.');

  await password.focus(); await page.keyboard.press('Enter');
  const submit = page.getByRole('button', {name: '登录', exact: true});
  await page.getByText('正在登录…', {exact: true}).waitFor();
  assert.equal(await submit.isDisabled(), true);
  assert.equal(await password.getAttribute('readonly'), '');
  await page.locator('.login-form').evaluate(form => {form.requestSubmit(); form.requestSubmit();});
  assert.equal(attempts, 1, 'Pending requests must not be submitted twice.');
  release();
  await page.getByRole('alert').filter({hasText: '账号或密码不正确'}).waitFor();
  assert.equal(await username.inputValue(), 'demo'); assert.equal(await password.inputValue(), '123456');
  assert.equal(await submit.isEnabled(), true);
  await username.fill('demo ');
  assert.equal(await page.getByRole('alert').count(), 0, 'Editing clears stale feedback.');
  await submit.click(); await page.getByText('正在登录…', {exact: true}).waitFor();
  release();
  await page.getByRole('button', {name: '退出登录', exact: true}).waitFor();
  assert.equal(attempts, 2); assert.deepEqual(errors, []);
  console.log('PASS: Enter submits, duplicate lock, inline errors preserve values, retry succeeds and reaches dashboard; zero API requests forwarded.');
} finally { release?.(); await browser.close(); }

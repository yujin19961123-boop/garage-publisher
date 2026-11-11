// Pure date boundaries plus optional browser-only API mocks; never writes project data.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {relativeTime, exactTime} from '../frontend/src/relative-time.ts';

process.env.TZ = 'Asia/Singapore';
const now = Date.parse('2026-11-10T20:00:00+08:00'); // Tuesday
const ago = ms => new Date(now - ms).toISOString();
const cases = [
  [ago(0), '刚刚'], [ago(59999), '刚刚'], [ago(60000), '1分钟前'],
  [ago(120000), '2分钟前'], [ago(3599999), '59分钟前'], [ago(3600000), '1小时前'],
  [ago(19 * 3600000), '19小时前'], ['2026-11-09T23:59:00+08:00', '1天前'],
  ['2026-11-07T12:00:00+08:00', '3天前'], ['2026-11-04T12:00:00+08:00', '6天前'],
  ['2026-11-03T20:00:00+08:00', '上周二'], ['2026-11-02T12:00:00+08:00', '上周一'],
  ['2026-11-01T12:00:00+08:00', '11-01'], ['2026-01-01T00:00:00+08:00', '01-01'],
  ['2025-12-31T23:59:00+08:00', '2025年12月31日'],
  [ago(-30000), '刚刚'], [ago(-3600000), '11-10'], ['invalid', '时间未知'],
];
for (const [value, expected] of cases) assert.equal(relativeTime(value, now), expected, value);
assert.equal(relativeTime('2026-11-01T12:00:00+08:00', Date.parse('2026-11-08T12:00:00+08:00')), '上周日');
assert.equal(relativeTime('2026-12-28T12:00:00+08:00', Date.parse('2027-01-04T12:00:00+08:00')), '上周一');
assert.equal(relativeTime('2024-02-29T23:59:00+08:00', Date.parse('2024-03-01T01:00:00+08:00')), '1天前');
assert.equal(relativeTime('2026-11-10T00:00:00Z', NaN), '时间未知');
assert.equal(exactTime('2026-11-10T12:00:03Z'), '2026-11-10 20:00:03');
assert.equal(exactTime('invalid'), '时间未知');
process.env.TZ = 'America/New_York';
assert.equal(relativeTime('2026-03-07T23:30:00-05:00', Date.parse('2026-03-08T23:00:00-04:00')), '1天前');
assert.equal(relativeTime('2026-11-01T00:30:00-04:00', Date.parse('2026-11-02T00:00:00-05:00')), '1天前');
process.env.TZ = 'Asia/Singapore';
console.log('PASS: 26 relative/exact time boundary checks, including calendar weeks, years and DST.');

if (process.argv.includes('--browser')) {
  const require = createRequire(new URL('../frontend/package.json', import.meta.url));
  const {chromium} = require('playwright');
  const origin = 'http://console.localhost:8080';
  const browser = await chromium.launch({channel: 'chrome', headless: true});
  try {
    const context = await browser.newContext({timezoneId: 'Asia/Singapore'});
    const errors = [];
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.clock.install({time: new Date(now)});
    await page.clock.pauseAt(new Date(now));
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      if (!url.pathname.startsWith('/api/')) return route.continue();
      assert.equal(route.request().method(), 'GET', 'This test allows only mocked GET requests.');
      let body;
      if (url.pathname === '/api/v1/me') body = {user: {id: 'clock-owner', username: '日期测试', role: 'member', status: 'active'}};
      else if (url.pathname === '/api/v1/platform-config') body = {maxUploadBytes: 104857600, maxExpandedBytes: 524288000, maxFiles: 10000};
      else if (url.pathname === '/api/v1/projects') body = {items: cases.slice(0, 15).map(([date], i) => ({id: `clock-${i}`, name: `日期 ${i}`, ownerId: 'clock-owner', status: 'published', url: `http://localhost:8080/clock-${i}/`, lastPublishedAt: date, currentReleaseId: `release-${i}`, currentVersionNumber: 1}))};
      else if (url.pathname === '/api/v1/share-page') body = {url: '', publishedCount: 15};
      else throw new Error(`Unexpected mocked API: ${url.pathname}`);
      return route.fulfill({contentType: 'application/json', body: JSON.stringify(body)});
    });
    await page.goto(origin);
    const times = page.locator('.timestamp time');
    await times.last().waitFor();
    assert.deepEqual(await times.allTextContents(), cases.slice(0, 15).map(([, label]) => label));
    const first = times.first();
    assert.equal(await first.getAttribute('title'), '2026-11-10 20:00:00');
    assert.equal(await first.getAttribute('aria-label'), '2026-11-10 20:00:00');
    assert.equal(await first.getAttribute('datetime'), ago(0));
    await first.hover();
    await page.clock.runFor(60000);
    assert.equal(await first.textContent(), '1分钟前', 'Mounted timestamps must update without reloading.');
    assert.equal(await first.getAttribute('title'), '2026-11-10 20:00:00', 'Exact time stays unchanged.');
    await page.setViewportSize({width: 390, height: 844});
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'No mobile horizontal overflow.');
    assert.deepEqual(errors, []);
    console.log('PASS: Chrome card labels, hover title, exact accessible time, automatic minute update and mobile layout; zero data writes.');
  } finally {
    await browser.close();
  }
}

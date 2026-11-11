// Local browser UI only. Every API is mocked; no account/project mutations.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const require=createRequire(new URL('../frontend/package.json',import.meta.url));
const {chromium}=require('playwright');
const origin='http://console.localhost:8080', output=new URL('../.local/',import.meta.url);
mkdirSync(output,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
try {
  const context=await browser.newContext({viewport:{width:1156,height:1004},timezoneId:'Asia/Singapore',reducedMotion:'reduce'});
  const admin={id:'stats-admin',username:'admin',role:'admin',status:'active'};
  const since='2026-11-10T12:00:00Z';
  let failNext=false,reads=0;
  const items=()=>[
    {...admin,storageBytes:0,loginCount:1,lastLoginAt:since,loginStatsSince:since},
    {id:'stats-member',username:'member-a',role:'member',status:'active',storageBytes:reads>2?28000000:13900000,loginCount:9,lastLoginAt:since,loginStatsSince:since},
    {id:'stats-big',username:'long_member_'+('abcdef'.repeat(18)),role:'member',status:'active',storageBytes:1500000000,loginCount:1024,lastLoginAt:'2025-01-01T00:00:00Z',loginStatsSince:since},
    {id:'stats-unknown',username:'member-no-history',role:'member',status:'disabled',storageBytes:null,loginCount:0,lastLoginAt:null,loginStatsSince:since},
  ];
  await context.route('**/*',async route=>{
    const req=route.request(),url=new URL(req.url());
    if(url.origin!==origin)return route.abort();
    if(!url.pathname.startsWith('/api/'))return route.continue();
    assert.equal(req.method(),'GET','Only simulated reads are allowed.');
    const respond=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
    if(url.pathname==='/api/v1/me')return respond({user:admin});
    if(url.pathname==='/api/v1/projects')return respond({items:[]});
    if(url.pathname==='/api/v1/platform-config')return respond({maxUploadBytes:104857600,maxExpandedBytes:524288000,maxFiles:10000});
    if(url.pathname==='/api/v1/admin/users'){
      reads++;if(failNext){failNext=false;return respond({message:'模拟统计暂不可用'},503);}return respond({items:items(),storageMeasuredAt:since});
    }
    throw new Error('Unexpected mocked API: '+url.pathname);
  });
  const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(origin);await page.getByRole('button',{name:'成员管理',exact:true}).click();
  const table=page.locator('.members-table');await table.locator('tbody tr').last().waitFor();
  for(const name of ['占用空间','登录次数','最近登录'])assert.equal(await table.getByRole('columnheader',{name,exact:true}).count(),1);
  assert.equal(await table.getByText('0 B',{exact:true}).count(),1);
  assert.equal(await table.getByText('13.9 MB',{exact:true}).count(),1);
  assert.equal(await table.getByText('1.5 GB',{exact:true}).count(),1);
  assert.equal(await table.getByText('1,024 次',{exact:true}).count(),1);
  assert.equal(await table.getByText('暂不可用',{exact:true}).count(),1);
  assert.equal(await table.getByText('暂无记录',{exact:true}).count(),1);
  assert.match(await table.locator('.member-number').first().getAttribute('title'),/字节/);
  assert.equal(await table.locator('time').first().getAttribute('title'),'2026-11-10 20:00:00');
  assert.match(await table.locator('tbody tr').first().locator('[data-label="登录次数"]').getAttribute('title'),/2026-11-10 20:00:00/);
  assert.equal(await table.locator('tbody tr').first().getByRole('button').count(),0,'Self/admin operation policy unchanged.');
  assert.equal(await table.locator('tbody tr').last().getByRole('button',{name:'启用',exact:true}).count(),1);
  await page.locator('.member-list').scrollIntoViewIfNeeded();
  await page.screenshot({path:fileURLToPath(new URL('member-stats-desktop.png',output)),fullPage:true});
  console.log('PASS: three metrics, byte units, missing data, precise time tooltip, explicit tracking baseline and unchanged actions.');

  const refresh=page.getByRole('button',{name:'刷新成员统计',exact:true});
  failNext=true;await refresh.click();await page.getByRole('alert').filter({hasText:'模拟统计暂不可用'}).waitFor();
  assert.equal(await table.getByText('13.9 MB',{exact:true}).count(),1,'Failed refresh must retain existing rows.');
  await refresh.click();await table.getByText('28 MB',{exact:true}).waitFor();
  assert.equal(await page.getByRole('alert').count(),0);
  await refresh.focus();assert.equal(await refresh.evaluate(node=>node===document.activeElement),true);
  console.log('PASS: refresh failure preserves rows, retry updates statistics and refresh supports keyboard focus.');
  for(const width of [943,390,320]){
    await page.setViewportSize({width,height:844});await page.locator('.member-list').scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'Page overflow at '+width);
    if(width<=390){
      assert.equal(await table.evaluate(node=>node.scrollWidth>node.clientWidth),false,'Member cards must not scroll horizontally at '+width);
      assert.equal(await table.locator('tbody tr').last().getByRole('button',{name:'启用',exact:true}).isVisible(),true);
    }
    if(width===390)await page.screenshot({path:fileURLToPath(new URL('member-stats-mobile.png',output)),fullPage:true});
  }
  assert.deepEqual(errors,[]);console.log('PASS: desktop/tablet and 390/320px member cards, no horizontal page overflow; all APIs mocked.');
}finally{await browser.close();}

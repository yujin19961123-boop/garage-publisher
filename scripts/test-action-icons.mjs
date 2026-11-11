// Local UI only: all APIs and prototype pages are mocked; no project/account writes.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const require=createRequire(new URL('../frontend/package.json',import.meta.url));
const {chromium}=require('playwright');
const origin='http://console.localhost:8080',output=new URL('../.local/',import.meta.url);mkdirSync(output,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
 const context=await browser.newContext({viewport:{width:1156,height:1004},reducedMotion:'reduce'});
 let loggedOut=false;const mutations=[];
 const user={id:'icons-admin',username:'admin',role:'admin',status:'active'};
 const projects=[{id:'own-icons',name:'我的原型',ownerId:user.id,status:'published',url:'http://localhost:8080/icons-own/',currentReleaseId:'r1',currentVersionNumber:1,lastPublishedAt:new Date().toISOString()},{id:'other-icons',name:'同事原型',ownerId:'another-member',status:'published',url:'http://localhost:8080/icons-other/',currentReleaseId:'r2',currentVersionNumber:1,lastPublishedAt:new Date().toISOString()}];
 await context.route('**/*',route=>{
  const req=route.request(),url=new URL(req.url());
  if(url.origin==='http://localhost:8080')return route.fulfill({contentType:'text/html',body:'<!doctype html><title>Prototype fixture</title><h1>Prototype viewer</h1>'});
  if(url.origin!==origin)return route.abort();if(!url.pathname.startsWith('/api/'))return route.continue();
  const respond=body=>route.fulfill({contentType:'application/json',body:JSON.stringify(body)});
  if(req.method()!=='GET')mutations.push(url.pathname);
  if(url.pathname==='/api/v1/me')return loggedOut?route.fulfill({status:401,contentType:'application/json',body:'{"message":"请登录"}'}):respond({user});
  if(url.pathname==='/api/v1/projects')return respond({items:projects});
  if(url.pathname==='/api/v1/platform-config')return respond({maxUploadBytes:104857600,maxExpandedBytes:524288000,maxFiles:10000});
  if(url.pathname==='/api/v1/share-page')return respond({url:'http://localhost:8080/_share/icons/',publishedCount:1});
  if(url.pathname==='/api/v1/auth/logout'&&req.method()==='POST'){loggedOut=true;return respond({ok:true});}
  throw Error('Unexpected mocked API: '+url.pathname);
 });
 const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
 let popups=0;page.on('popup',()=>popups++);
 await page.goto(origin);await page.locator('article.project').last().waitFor();
 const logout=page.getByRole('button',{name:'退出登录',exact:true}),share=page.getByRole('button',{name:'分享全部原型',exact:true});
 assert.equal(await logout.locator('[data-icon="logout"]').count(),1);
 assert.equal(await share.locator('[data-icon="share"]').count(),1);
 assert.equal(await page.locator('.project-open [data-icon="external"]').count(),2);
 assert.equal(await page.locator('.project-manage svg').count(),0);
 assert.equal((await page.locator('body').innerText()).includes('↗'),false);
 await page.screenshot({path:fileURLToPath(new URL('action-icons-desktop.png',output)),fullPage:true});
 await share.click();const dialog=page.getByRole('dialog');await dialog.waitFor();
 const shareLink=dialog.getByRole('link',{name:'打开分享页',exact:true});await shareLink.waitFor();
 assert.equal(await shareLink.locator('[data-icon="external"]').count(),1);
 assert.equal(await dialog.getByRole('button',{name:'复制链接',exact:true}).locator('svg').count(),0);
 assert.equal(popups,0,'Sharing opens the in-page share dialog, not an external page.');
 await page.keyboard.press('Escape');
 const own=page.locator('article.project').filter({has:page.getByRole('heading',{name:'我的原型',exact:true})});
 await own.getByRole('button',{name:'发布更新',exact:true}).click();await page.getByRole('dialog').waitFor();
 assert.equal(await page.getByRole('dialog').locator('button.primary.full [data-icon="upload"]').count(),1);
 assert.equal(popups,0);await page.keyboard.press('Escape');
 const other=page.locator('article.project').filter({has:page.getByRole('heading',{name:'同事原型',exact:true})});
 await other.getByRole('button',{name:'查看详情',exact:true}).click();await page.getByRole('dialog').waitFor();
 assert.equal(await page.getByRole('dialog').locator('input[type="file"]').count(),0);
 assert.equal(popups,0);await page.keyboard.press('Escape');
 console.log('PASS: distinct logout/share/external icons, upload semantic icon, no decorative arrows and in-page actions stay in dialogs.');
 const popup=page.waitForEvent('popup');await own.getByRole('link',{name:'打开原型：我的原型',exact:true}).click();
 const preview=await popup;await preview.getByRole('heading',{name:'Prototype viewer',exact:true}).waitFor();
 assert.equal(preview.url(),projects[0].url);assert.equal(await preview.evaluate(()=>window.opener===null),true);await preview.close();await page.bringToFront();
 for(const width of [390,320]){
  await page.setViewportSize({width,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  const button=await share.boundingBox();assert.ok(button.height>=44&&button.width>=44);
  if(width===390)await page.screenshot({path:fileURLToPath(new URL('action-icons-mobile.png',output)),fullPage:true});
 }
 await logout.click();await page.getByRole('button',{name:'登录',exact:true}).waitFor();
 assert.equal(popups,1,'Logout must not navigate to a popup.');
 assert.equal(await page.locator('.login-form [data-icon="next"]').count(),1);
 assert.deepEqual(mutations,['/api/v1/share-page','/api/v1/auth/logout']);assert.deepEqual(errors,[]);
 console.log('PASS: only the external icon opens a protected new tab; logout returns to login; 390/320px layout and touch targets pass.');
}finally{await browser.close();}

// Read-only local browser checks. No accounts, projects, or published files are changed.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdirSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const require=createRequire(new URL('../frontend/package.json',import.meta.url));
const {chromium}=require('playwright');
const origin='http://localhost:8080';
const paths=process.argv.slice(2);
assert.ok(paths.length,'Pass at least one existing local collection path');
for(const path of paths)assert.match(path,/^\/_share\/[a-z0-9-]+\/$/);
const directory=fileURLToPath(new URL('../.local/',import.meta.url));mkdirSync(directory,{recursive:true});
const report={localOnly:true,databaseWrites:false,checks:[],layouts:[],errors:[],screenshots:[]};
let browser;
try{
 browser=await chromium.launch({channel:'chrome',headless:true});
 const context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'});
 await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
 const page=await context.newPage();
 page.on('pageerror',error=>report.errors.push(error.message));
 page.on('console',message=>{if(message.type()==='error'&&/Content Security Policy|Refused to execute/i.test(message.text()))report.errors.push(message.text());});
 async function shot(label){await page.screenshot({path:directory+'share-design-'+label+'.png',fullPage:true,animations:'disabled'});report.screenshots.push('share-design-'+label+'.png');}
 async function layout(label){const metrics=await page.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,links:[...document.querySelectorAll('.project-link')].map(e=>({width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height}))}));assert.ok(metrics.scrollWidth<=metrics.width+1,label+' overflows horizontally');assert.ok(metrics.links.every(e=>e.width>=44&&e.height>=44));report.layouts.push({label,...metrics});}
 async function move(locator,x,y){await locator.scrollIntoViewIfNeeded();const b=await locator.boundingBox();await page.mouse.move(b.x+b.width*x,b.y+b.height*y);await page.waitForFunction(()=>!!document.querySelector('[data-active]'));return locator.evaluate(e=>e.style.getPropertyValue('--light-x'));}
 let source,headers;
 for(let index=0;index<paths.length;index++){
  await page.setViewportSize({width:1440,height:1000});
  const response=await page.goto(origin+paths[index]);assert.equal(response.status(),200);
  const html=await response.text();if(!source&&await page.locator('article').count()){source=html;headers=await response.allHeaders();}
  await page.getByRole('heading',{name:'原型合集',exact:true}).waitFor();
  assert.ok((await response.headerValue('content-security-policy')).includes("script-src 'sha256-"));
  const count=await page.locator('article').count();assert.equal(Number(await page.locator('.collection-count strong').textContent()),count);
  if(count===1)assert.ok(await page.locator('.project-grid.single').count());
  assert.ok(await page.locator('.collection').evaluate(e=>!!(e.compareDocumentPosition(document.querySelector('.hero'))&Node.DOCUMENT_POSITION_FOLLOWING)),'Collection must precede the decorative cover');
  assert.equal(await page.getByRole('link',{name:'浏览全部原型',exact:true}).count(),0,'Redundant browse link remains');
  if(count)assert.ok(await page.locator('article').first().evaluate(e=>e.getBoundingClientRect().top<innerHeight/2),'Projects must be prominent on the first screen');
  await layout('desktop-'+index);await shot('desktop-'+index);
  const hero=page.locator('.hero');const first=await move(hero,.2,.3),second=await move(hero,.8,.7);assert.notEqual(first,second,'Glass light does not track the mouse');
  await page.emulateMedia({reducedMotion:'reduce'});await page.waitForFunction(()=>!document.querySelector('[data-active]'));
  for(const width of [390,320]){await page.setViewportSize({width,height:844});await page.evaluate(()=>window.scrollTo({top:0,behavior:'instant'}));await layout('mobile-'+width+'-'+index);if(count)assert.ok(await page.locator('article').first().evaluate(e=>e.getBoundingClientRect().top<innerHeight/2),'Mobile first screen must show projects');if(width===390)await shot('mobile-'+index);}
  await page.setViewportSize({width:1440,height:1000});await page.emulateMedia({reducedMotion:'no-preference'});
  if(count){
   const link=page.locator('article a').first();await link.scrollIntoViewIfNeeded();await link.focus();
   assert.equal(await link.evaluate(e=>e===document.activeElement),true);
   const expected=await link.getAttribute('href');assert.equal(new URL(expected).origin,origin);
   assert.equal((await fetch(expected)).status,200,'Published prototype URL is unavailable');
   // Verify keyboard navigation independently from uploaded applications' own redirects.
   await context.route(expected,route=>route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><title>Local link check</title>'}),{times:1});
   const opened=page.waitForEvent('popup');await page.keyboard.press('Enter');const preview=await opened;
   await preview.waitForURL(expected);assert.equal(await preview.evaluate(()=>window.opener===null),true);await preview.close();
   report.checks.push('collection '+index+': count, full-card keyboard link, opener isolation, desktop/mobile, pointer and reduced motion');
  }
 }
 // Only the document response is changed for edge-case visual checks; no API mutation.
 if(source){
  const longName='很长的项目名称'.repeat(12)+'SuperLongUnbrokenProjectName'.repeat(10);
  const fixture=source.replace(/<h2 id="project-0">[\s\S]*?<\/h2>/,'<h2 id="project-0">'+longName+'</h2>');
  const fixturePath=origin+'/_share/design-layout-fixture/';
  const fixtureHeaders={'content-type':'text/html; charset=utf-8','content-security-policy':headers['content-security-policy']};
  await page.route(fixturePath,route=>route.fulfill({status:200,headers:fixtureHeaders,body:fixture}));
  await page.goto(fixturePath);await page.emulateMedia({reducedMotion:'reduce'});
  for(const width of [1440,390,320]){await page.setViewportSize({width,height:900});await layout('long-name-'+width);}
  report.checks.push('synthetic long name: wraps at 1440/390/320 without horizontal overflow; no database writes');
 }
 assert.deepEqual(report.errors,[],'Browser or CSP errors');report.success=true;
 console.log('PASS: local collection design, keyboard navigation, mouse interaction, reduced motion and narrow layouts');
}catch(error){report.success=false;report.error=String(error.stack||error);process.exitCode=1;console.error(report.error);}
finally{await browser?.close();writeFileSync(directory+'share-design-report.json',JSON.stringify(report,null,2));}

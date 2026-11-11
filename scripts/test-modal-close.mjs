// Local UI only. Every API is mocked; no project or account writes.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const require=createRequire(new URL('../frontend/package.json',import.meta.url));
const {chromium}=require('playwright');
const origin='http://console.localhost:8080',output=new URL('../.local/',import.meta.url);
mkdirSync(output,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
 const context=await browser.newContext({viewport:{width:1156,height:1004},reducedMotion:'no-preference'});
 await context.route('**/*',route=>{
  const req=route.request(),url=new URL(req.url());if(url.origin!==origin)return route.abort();
  if(!url.pathname.startsWith('/api/'))return route.continue();assert.equal(req.method(),'GET');
  let body;
  if(url.pathname==='/api/v1/me')body={user:{id:'close-mock',username:'界面检查',role:'member',status:'active'}};
  else if(url.pathname==='/api/v1/projects')body={items:[]};
  else if(url.pathname==='/api/v1/platform-config')body={maxUploadBytes:104857600,maxExpandedBytes:524288000,maxFiles:10000};
  else throw Error('Unexpected mocked API');
  return route.fulfill({contentType:'application/json',body:JSON.stringify(body)});
 });
 const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto(origin);await page.getByRole('heading',{name:'项目列表',exact:true}).waitFor();
 const trigger=page.locator('.create-button');
 async function open(){await trigger.click();const dialog=page.getByRole('dialog');await dialog.waitFor();await dialog.evaluate(node=>Promise.all(node.getAnimations().map(animation=>animation.finished.catch(()=>{}))));return dialog;}
 const dialog=await open(),close=page.getByRole('button',{name:'关闭创建项目弹窗',exact:true});
 assert.equal(await close.locator('svg path').count(),1);assert.equal((await close.innerText()).trim(),'');
 const rect=await close.boundingBox();assert.equal(rect.width,48);assert.equal(rect.height,48);
 await dialog.screenshot({path:fileURLToPath(new URL('modal-close-rest.png',output))});
 await close.hover({position:{x:35,y:15}});await page.waitForTimeout(550);
 const hovered=await close.boundingBox();
 assert.deepEqual(hovered,rect,'Mouse hit target must stay fixed while its inner glass surface moves.');
 // Return scalar values rather than relying on platform serialization of DOMMatrix.
 const angle=await close.locator('svg').evaluate(node=>{const m=new DOMMatrixReadOnly(getComputedStyle(node).transform);return Math.atan2(m.b,m.a)*180/Math.PI;});
 assert.ok(Math.abs(angle-90)<1,'Cross should make a quarter turn on hover.');
 await close.screenshot({path:fileURLToPath(new URL('modal-close-hover.png',output))});
 await page.mouse.down();await page.waitForTimeout(200);
 const scale=await close.locator('.close-surface').evaluate(node=>new DOMMatrixReadOnly(getComputedStyle(node).transform).a);
 assert.ok(scale<1,'Press should compress the inner surface.');
 await page.mouse.up();await dialog.waitFor({state:'hidden'});
 assert.equal(await trigger.evaluate(node=>node===document.activeElement),true);
 console.log('PASS: SVG icon, fixed 48px hit target, glass hover/quarter turn, pressed feedback and close restores focus.');
 await open();await page.getByRole('textbox',{name:'项目名称',exact:true}).focus();await page.keyboard.press('Shift+Tab');
 assert.equal(await close.evaluate(node=>node===document.activeElement),true);
 assert.notEqual(await close.evaluate(node=>getComputedStyle(node).outlineStyle),'none');
 await page.keyboard.press('Enter');await page.getByRole('dialog').waitFor({state:'hidden'});
 await open();await page.keyboard.press('Escape');await page.getByRole('dialog').waitFor({state:'hidden'});
 console.log('PASS: visible keyboard focus, Enter and Escape retain expected close behavior.');
 await page.emulateMedia({reducedMotion:'reduce'});await open();await close.hover();
 assert.equal(await close.locator('svg').evaluate(node=>getComputedStyle(node).transform),'none');
 await page.keyboard.press('Escape');
 for(const width of [390,320]){
  await page.setViewportSize({width,height:844});const modal=await open();
  const box=await close.boundingBox();assert.equal(box.width,48);assert.equal(box.height,48);
  assert.equal(await modal.evaluate(node=>node.scrollWidth>node.clientWidth),false);
  const overlap=await modal.evaluate(node=>{const a=node.querySelector('.close').getBoundingClientRect(),b=node.querySelector('h2').getBoundingClientRect();return a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top;});
  if(overlap)await modal.screenshot({path:fileURLToPath(new URL('modal-close-spacing-debug.png',output))});
  assert.equal(overlap,false,'Close button must not overlap the title.');
  if(width===390)await modal.screenshot({path:fileURLToPath(new URL('modal-close-mobile.png',output))});
  await close.click();await modal.waitFor({state:'hidden'});
 }
 assert.deepEqual(errors,[]);console.log('PASS: reduced-motion opt-out and mobile 390/320px target/title spacing; all APIs mocked.');
}finally{await browser.close();}

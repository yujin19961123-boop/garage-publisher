// Local-only visual and functional acceptance. Never runs against production.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const require=createRequire(new URL('../frontend/package.json',import.meta.url));
const {chromium}=require('playwright');
const {zipSync,strToU8}=require('fflate');
const ADMIN='http://console.localhost:8080',PUBLIC='http://localhost:8080';
const allowed=new Set([ADMIN,PUBLIC]);
function localURL(value){const u=new URL(value);assert.ok(allowed.has(u.origin),'Refusing any non-local URL');return u;}
for(const key of ['TEST_BASE_URL','UI_BASE_URL','BASE_URL'])if(process.env[key])assert.equal(localURL(process.env[key]).origin,ADMIN,'This script has a fixed local console URL');
const env=Object.fromEntries(readFileSync(new URL('../.env',import.meta.url),'utf8').split(/\r?\n/).filter(l=>l&&!l.trim().startsWith('#')).map(l=>{const n=l.indexOf('=');return [l.slice(0,n),l.slice(n+1)];}));
assert.ok(env.INIT_ADMIN_USERNAME&&env.INIT_ADMIN_PASSWORD,'Local initial administrator credentials are required in .env');
const secrets=[env.INIT_ADMIN_PASSWORD];
function sanitized(e){let s=String(e?.stack||e);for(const secret of secrets)if(secret)s=s.split(secret).join('[REDACTED]');return s.replace(/(csrfToken|token|password)\s*[:=]\s*["']?[^\s,"'}]+/gi,'$1=[REDACTED]');}
const output=fileURLToPath(new URL('../.local/',import.meta.url));mkdirSync(output,{recursive:true});
const name='UI local regression '+Date.now().toString(36)+' '+randomBytes(5).toString('hex');
const report={localOnly:true,name,steps:[],screenshots:[],blockedRequests:[],success:false,cleanup:false};
let browser,context,page,project,identity,csrf='',publicURL='';
const step=s=>{report.steps.push(s);console.log('PASS: '+s);};
async function api(path,method='GET',body){assert.ok(path.startsWith('/api/v1/')&&!path.includes('://'),'Invalid local API path');return page.evaluate(async({path,method,body,csrf})=>{const r=await fetch(path,{method,credentials:'same-origin',headers:{'Content-Type':'application/json',...(csrf?{'X-CSRF-Token':csrf}:{})},body:body===undefined?undefined:JSON.stringify(body)});let data;try{data=await r.json();}catch{}return {status:r.status,data};},{path,method,body,csrf});}
async function shot(filename){await page.screenshot({path:output+filename,fullPage:!['ui-create.png','ui-selected.png','ui-mobile.png','ui-modal-mobile.png'].includes(filename)});report.screenshots.push(filename);}
async function noOverflow(label){const metrics=await page.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,height:innerHeight,documentHeight:document.documentElement.scrollHeight,footerBottom:document.querySelector('.app-footer')?.getBoundingClientRect().bottom+scrollY}));report.layouts||={};report.layouts[label]=metrics;assert.ok(metrics.scrollWidth<=metrics.width+1,'Horizontal overflow: '+label);}
function archive(version){return {name:`ui-${version}.zip`,mimeType:'application/zip',buffer:Buffer.from(zipSync({'index.html':strToU8(`<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="./assets/style.css"></head><body><h1>Local UI ${version}</h1><p id="version">${version}</p></body></html>`),'assets/style.css':strToU8('body{font:24px system-ui;padding:30px;color:#123}')}))};}
async function trap(dialog){await dialog.locator('button:not(:disabled),input:not(:disabled),a[href]').first().focus();await page.keyboard.press('Shift+Tab');assert.ok(await dialog.evaluate(el=>el.contains(document.activeElement)),'Shift+Tab escaped dialog');for(let i=0;i<18;i++){await page.keyboard.press('Tab');assert.ok(await dialog.evaluate(el=>el.contains(document.activeElement)),'Tab escaped dialog');}}
async function waitNoDialog(){await page.getByRole('dialog').waitFor({state:'hidden'});}
async function openCreate(){await page.getByRole('button',{name:/创建项目/}).first().click();const dialog=page.getByRole('dialog');await dialog.waitFor();assert.equal(await page.getByRole('dialog').count(),1,'Multiple create dialogs');return dialog;}
async function publicVersion(version){const u=localURL(publicURL);assert.equal(u.origin,PUBLIC,'Project must be served on local public host');const p=await context.newPage();try{const response=await p.goto(u.href);assert.equal(response.status(),200);await p.getByRole('heading',{name:'Local UI '+version,exact:true}).waitFor();assert.equal(await p.locator('#version').textContent(),version);}finally{await p.close();}}
async function orbSharePreview(keyboard=false){
 const orb=page.getByRole('button',{name:'查看我的全部原型',exact:true});
 await until(()=>orb.isEnabled(),'Share orb did not become ready');
 const popup=page.waitForEvent('popup');
 if(keyboard){await page.bringToFront();await orb.focus();await page.keyboard.press('Enter');}else await orb.click();
 const preview=await popup;
 try{
  await preview.waitForURL(u=>u.origin===PUBLIC&&u.pathname.startsWith('/_share/'));
  await preview.getByRole('heading',{name:'原型合集',exact:true}).waitFor();
  assert.equal(await preview.evaluate(()=>window.opener===null),true,'Public preview must not retain the dashboard opener');
  const sharing=await api('/api/v1/share-page'),projects=await api('/api/v1/projects');
  assert.equal(preview.url(),sharing.data.url,'Orb did not open this account’s fixed share page');
  const expected=projects.data.items.filter(p=>p.ownerId===identity.id&&p.lastPublishedAt).map(p=>new URL(p.url).href).sort();
  const actual=await preview.locator('article a').evaluateAll(nodes=>nodes.map(a=>a.href).sort());
  assert.deepEqual(actual,expected,'Share orb must include only this account’s published projects');
 }finally{await preview.close();}
 await page.bringToFront();step(keyboard?'share orb keyboard opens own collection in a new tab':'share orb click directly opens own collection, excludes drafts and other owners');
}
async function orbShareFailure(){
 await page.route(ADMIN+'/api/v1/share-page',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({message:'暂时无法打开分享页，请重试'})}),{times:1});
 const popup=page.waitForEvent('popup');await page.getByRole('button',{name:'查看我的全部原型',exact:true}).click();const preview=await popup;
 await page.getByRole('alert').filter({hasText:'暂时无法打开分享页，请重试'}).waitFor();
 if(!preview.isClosed())await preview.waitForEvent('close');
 assert.equal(page.url(),ADMIN+'/','Failed share request must preserve the dashboard');
 await until(()=>page.getByRole('button',{name:'查看我的全部原型',exact:true}).isEnabled(),'Share orb remained locked after an error');
 await page.getByRole('button',{name:'关闭错误',exact:true}).click();step('share orb failure closes its blank tab, shows feedback and allows retry');
}
async function until(predicate,message){for(let n=0;n<50;n++){if(await predicate())return;await page.waitForTimeout(40);}assert.fail(message);}
async function pointerState(locator){return locator.evaluate(el=>{const s=getComputedStyle(el);return {active:el.getAttribute('data-pointer-active'),x:el.style.getPropertyValue('--pointer-x'),y:el.style.getPropertyValue('--pointer-y'),tiltX:el.style.getPropertyValue('--tilt-x'),tiltY:el.style.getPropertyValue('--tilt-y'),driftX:el.style.getPropertyValue('--drift-x'),driftY:el.style.getPropertyValue('--drift-y'),transform:s.transform,translate:s.translate};});}
async function pointAt(locator,x,y){await locator.scrollIntoViewIfNeeded();const b=await locator.boundingBox();assert.ok(b&&b.width&&b.height,'Pointer surface has no visible bounds');await page.mouse.move(b.x+b.width*x,b.y+b.height*y);await page.waitForTimeout(100);return pointerState(locator);}
async function blankPointer(){// A viewport corner outside the cards/header buttons.
 await page.mouse.move(1,1);await page.waitForTimeout(120);
}
async function pointerReset(locator,label){await until(async()=>{const s=await pointerState(locator);return s.active!=='true'&&[s.tiltX,s.tiltY,s.driftX,s.driftY].every(v=>!v||Number.parseFloat(v)===0);},label+' did not reset pointer motion');}
async function pointerInteractions(article){
 await page.emulateMedia({reducedMotion:'no-preference'});assert.ok(await page.evaluate(()=>matchMedia('(pointer: fine) and (hover: hover)').matches),'Desktop mouse media unavailable');
 assert.ok(await page.locator('[data-pointer-surface],.hero-mark svg,.intro-orbit svg').evaluateAll(nodes=>nodes.every(el=>!getComputedStyle(el).animationIterationCount.split(',').some(v=>v.trim()==='infinite'))),'Pointer surfaces must not keep rotating without user input');
 const card=article; // The article itself is the pointer surface.
 assert.ok(await card.evaluate(el=>el.hasAttribute('data-pointer-surface')),'Card pointer marker missing');
 const first=await pointAt(card,.22,.26);await until(async()=>(await pointerState(card)).active==='true','Card never activated from real mouse movement');const second=await pointAt(card,.76,.68);assert.ok(first.x!==second.x||first.y!==second.y,'Pointer coordinates did not react to mouse position');assert.ok(first.tiltX!==second.tiltX||first.tiltY!==second.tiltY||first.transform!==second.transform,'Card tilt did not react to mouse position');await blankPointer();await pointerReset(card,'Card leave');
 const orb=page.locator('.hero-mark');const orbLeft=await pointAt(orb,.24,.28),orbRight=await pointAt(orb,.72,.65);assert.ok(orbLeft.x!==orbRight.x&&orbLeft.tiltY!==orbRight.tiltY,'Glass orb did not respond to real pointer movement');await blankPointer();await pointerReset(orb,'Glass orb leave');
 const primary=page.locator('.header-actions .primary').first();assert.ok(await primary.evaluate(el=>el.hasAttribute('data-pointer-surface')),'Primary pointer marker missing');const left=await pointAt(primary,.2,.3),right=await pointAt(primary,.8,.7);assert.ok(left.driftX!==right.driftX||left.driftY!==right.driftY,'Primary magnetic movement did not react');await blankPointer();await pointerReset(primary,'Primary leave');
 await pointAt(primary,.8,.7);await page.evaluate(()=>window.dispatchEvent(new Event('blur')));await pointerReset(primary,'Window blur');await pointAt(card,.7,.6);await page.emulateMedia({reducedMotion:'reduce'});await pointerReset(card,'Reduced-motion change');await pointAt(card,.2,.3);assert.notEqual((await pointerState(card)).active,'true','Reduced-motion activated mouse animation');
 report.pointer={cardFirst:first,cardSecond:second,orbLeft,orbRight,primaryLeft:left,primaryRight:right};step('real mouse card tilt, glass orb, primary magnetic movement, leave/blur resets and reduced-motion opt-out');
}
async function memberSingleTabMock(){
 const isolated=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true,reducedMotion:'reduce',serviceWorkers:'block'});
 const mockErrors=[];
 try{await isolated.route('**/*',async route=>{const req=route.request(),u=new URL(req.url());if(!allowed.has(u.origin)){report.blockedRequests.push(u.origin);return route.abort('blockedbyclient');}if(u.origin===ADMIN&&u.pathname.startsWith('/api/v1/')){if(req.method()!=='GET'){mockErrors.push('Role mock attempted mutation');return route.abort('blockedbyclient');}let value;if(u.pathname==='/api/v1/me')value={user:{id:'ui-role-mock-member',username:'界面角色示例',role:'member',status:'active'},csrfToken:'ui-only-not-a-real-session'};else if(u.pathname==='/api/v1/projects')value={items:[]};else if(u.pathname==='/api/v1/platform-config')value={maxUploadBytes:104857600,maxExpandedBytes:524288000,maxFiles:10000};else{mockErrors.push('Unexpected API in isolated role mock');return route.abort('blockedbyclient');}return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(value)});}await route.continue();});
 const member=await isolated.newPage();await member.goto(ADMIN);await member.getByRole('heading',{name:'项目列表',exact:true}).waitFor();assert.equal(await member.getByRole('navigation',{name:'主导航'}).count(),0,'Single-tab member still sees navigation');assert.equal(await member.getByRole('button',{name:'成员管理',exact:true}).count(),0);assert.equal(await member.getByRole('heading',{name:'开通成员'}).count(),0);assert.ok(await member.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await member.screenshot({path:output+'ui-member-single-tab.png',fullPage:true});report.screenshots.push('ui-member-single-tab.png');
 await member.getByRole('button',{name:/创建项目/}).first().tap();const modal=member.getByRole('dialog');await modal.waitFor();await modal.getByLabel('项目名称',{exact:true}).fill('触屏界面检查（不提交）');await modal.getByRole('button',{name:'关闭创建项目弹窗',exact:true}).tap();await modal.waitFor({state:'hidden'});assert.equal(mockErrors.length,0,mockErrors.join('; '));report.memberSingleTab={mode:'isolated frontend role mock',databaseWrites:false,hasTouch:true};step('isolated UI role mock: member has no single-tab navigation; touch create/close works without account creation');
 }finally{await isolated.close();}
}

try{
 browser=await chromium.launch({channel:'chrome',headless:true});
 context=await browser.newContext({viewport:{width:1440,height:1000},permissions:['clipboard-read','clipboard-write'],reducedMotion:'reduce',serviceWorkers:'block'});
 await context.route('**/*',async route=>{const u=new URL(route.request().url());if(!allowed.has(u.origin)){report.blockedRequests.push(u.origin);await route.abort('blockedbyclient');return;}await route.continue();});
 page=await context.newPage();page.setDefaultTimeout(15000);
 await page.goto(ADMIN);await page.getByRole('button',{name:'登录',exact:true}).waitFor();await shot('ui-login.png');
 await page.getByLabel('账号',{exact:true}).fill(env.INIT_ADMIN_USERNAME);await page.getByLabel('密码',{exact:true}).fill(env.INIT_ADMIN_PASSWORD);await page.getByRole('button',{name:'登录',exact:true}).click();
 await page.getByRole('heading',{name:'项目列表',exact:true}).waitFor();const me=await api('/api/v1/me');assert.equal(me.status,200);identity=me.data.user;csrf=me.data.csrfToken;secrets.push(csrf);assert.equal(identity.role,'admin','This acceptance requires the local administrator');step('real local administrator login');
 await page.locator('.summary').waitFor();await shot('ui-desktop.png');await noOverflow('desktop');
 for(const width of [390,320]){await page.setViewportSize({width,height:844});await noOverflow('mobile '+width);if(width===390)await shot('ui-mobile.png');}await page.setViewportSize({width:1440,height:1000});step('desktop and 390/320 mobile layout');
 assert.ok(await page.evaluate(()=>matchMedia('(prefers-reduced-motion: reduce)').matches));await page.mouse.move(100,100);assert.equal(await page.locator('[data-pointer-active="true"]').count(),0,'Reduced-motion should not activate pointer surfaces');step('reduced-motion preference keeps pointer interaction inactive');
 assert.equal(await page.getByRole('navigation',{name:'主导航'}).count(),1,'Admin must retain two-item navigation');assert.equal(await page.getByRole('navigation',{name:'主导航'}).getByRole('button').count(),2);await memberSingleTabMock();
 await page.getByRole('button',{name:'成员管理',exact:true}).click();await page.getByRole('heading',{name:'成员管理',exact:true}).waitFor();await page.getByRole('heading',{name:'开通成员'}).waitFor();await page.getByRole('table').waitFor();await shot('ui-member.png');step('member management displayed without changing accounts');await page.getByRole('button',{name:'项目列表',exact:true}).click();
 // A reset dialog is inspected only when a member is present; no password is changed.
 await page.getByRole('button',{name:'成员管理',exact:true}).click();
 const resetButton=page.getByRole('button',{name:'重置密码',exact:true}).first();
 if(await resetButton.count()){await resetButton.click();const resetDialog=page.getByRole('dialog');await resetDialog.getByRole('heading',{name:'重置密码',exact:true}).waitFor();assert.equal(await resetDialog.getByLabel('新密码').getAttribute('type'),'password');await page.keyboard.press('Escape');await waitNoDialog();step('styled password reset dialog opens without changing accounts');}
 await page.getByRole('button',{name:'项目列表',exact:true}).click();
 let dialog=await openCreate();await trap(dialog);await page.keyboard.press('Escape');await waitNoDialog();assert.ok(await page.evaluate(()=>document.activeElement?.textContent?.includes('创建项目')),'Create trigger focus was not restored');step('single modal, Tab containment, Escape and trigger focus restore');
 dialog=await openCreate();await page.setViewportSize({width:390,height:844});await noOverflow('mobile modal 390');await shot('ui-modal-mobile.png');await page.setViewportSize({width:320,height:844});await noOverflow('mobile modal 320');await page.setViewportSize({width:1440,height:1000});await shot('ui-create.png');await dialog.getByLabel('项目名称',{exact:true}).fill(name);await dialog.getByLabel('选择原型文件或 ZIP',{exact:true}).setInputFiles(archive('v1'));await dialog.locator('strong').filter({hasText:/^文件已选好$/}).waitFor();await shot('ui-selected.png');step('mobile modal fits and selected ZIP has explicit selected state');
 await page.route(ADMIN+'/api/v1/deployments/*/archive',async route=>{await new Promise(r=>setTimeout(r,700));await route.continue();});
 const created=page.waitForResponse(r=>r.url()===ADMIN+'/api/v1/projects'&&r.request().method()==='POST'&&r.status()===200);
 await dialog.getByRole('button',{name:/创建并发布/}).click();project=await(await created).json();assert.equal(project.name,name);assert.equal(project.ownerId,identity.id);assert.match(project.id,/^[a-f0-9]{48}$/);
 await page.keyboard.press('Escape');assert.ok(await dialog.isVisible(),'Busy publication modal closed');step('Escape cannot interrupt an active publication');
 await dialog.getByRole('heading',{name:/发布成功/}).waitFor({timeout:90000});publicURL=await dialog.getByLabel('分享链接',{exact:true}).inputValue();localURL(publicURL);await dialog.getByRole('button',{name:/复制链接/}).click();await dialog.getByRole('status').filter({hasText:'链接已复制'}).waitFor();assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),publicURL);await publicVersion('v1');await dialog.getByRole('button',{name:'完成',exact:true}).click();await waitNoDialog();step('create, publish, copy and anonymous v1 access');
 await orbSharePreview();await orbSharePreview(true);await orbShareFailure();
 let article=page.locator('article').filter({has:page.getByRole('heading',{name,exact:true})});assert.equal(await article.count(),1);await pointerInteractions(article);await article.getByRole('button',{name:/发布更新/}).click();dialog=page.getByRole('dialog');
 await dialog.getByLabel('选择原型文件或 ZIP',{exact:true}).setInputFiles({name:'invalid-update.zip',mimeType:'application/zip',buffer:Buffer.from(zipSync({'readme.txt':strToU8('no home page')}))});
 await dialog.getByRole('button',{name:/发布更新/}).click();await dialog.getByRole('status').filter({hasText:'上次上传失败'}).waitFor({timeout:90000});
 assert.ok(await dialog.locator('strong').filter({hasText:/^文件已选好$/}).isVisible(),'Failure discarded the selected files');assert.equal(await dialog.getByRole('heading',{name:'更新成功',exact:true}).count(),0);await publicVersion('v1');step('failed update retains file selection for retry and keeps the original published version');
 await dialog.getByLabel('选择原型文件或 ZIP',{exact:true}).setInputFiles(archive('v2'));await dialog.locator('strong').filter({hasText:/^文件已选好$/}).waitFor();await dialog.getByRole('button',{name:/发布更新/}).click();
 await dialog.getByRole('heading',{name:'更新成功',exact:true}).waitFor({timeout:90000});assert.equal(await dialog.locator('form,input[type="file"]').count(),0,'Success page retained upload inputs');assert.equal(await dialog.getByRole('button',{name:/发布更新/}).count(),0,'Success page still permits duplicate publication');assert.equal(await dialog.getByRole('link',{name:/查看原型/}).getAttribute('href'),publicURL);
 await dialog.getByRole('button',{name:'复制链接',exact:true}).click();await dialog.getByRole('status').filter({hasText:'链接已复制'}).waitFor();assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),publicURL);await page.waitForTimeout(4200);assert.ok(await dialog.getByRole('heading',{name:'更新成功',exact:true}).isVisible(),'Success page disappeared before acknowledgement');
 await page.screenshot({path:output+'ui-update-success.png',animations:'disabled'});await page.setViewportSize({width:390,height:844});assert.ok(await dialog.evaluate(e=>e.scrollWidth<=e.clientWidth));await page.screenshot({path:output+'ui-update-success-mobile.png',animations:'disabled'});await page.setViewportSize({width:1440,height:1000});
 const updated=await api('/api/v1/projects/'+project.id);assert.equal(updated.status,200);assert.equal(updated.data.url,publicURL);assert.equal(updated.data.currentVersionNumber,2,'Retry created an unexpected successful version');await publicVersion('v2');await dialog.getByRole('button',{name:'完成',exact:true}).click();await waitNoDialog();step('update switches to a persistent success page with view/copy/done, no retained files or repeat-publish button; original URL serves v2');
 await page.getByRole('button',{name:/分享全部原型/}).click();dialog=page.getByRole('dialog');const share=dialog.getByLabel('全部原型分享链接',{exact:true});await share.waitFor();const shareURL=localURL(await share.inputValue());assert.equal(shareURL.origin,PUBLIC);assert.ok(shareURL.pathname.startsWith('/_share/'));await page.keyboard.press('Escape');await waitNoDialog();step('all-prototype share modal shows local fixed URL');
 article=page.locator('article').filter({has:page.getByRole('heading',{name,exact:true})});await article.getByRole('button',{name:/发布更新/}).click();dialog=page.getByRole('dialog');assert.equal(await dialog.getByRole('heading',{name:'更新成功',exact:true}).count(),0,'Reopening must start a new upload form');assert.equal(await dialog.locator('strong').filter({hasText:/^文件已选好$/}).count(),0,'Reopening retained previously published files');assert.equal(await dialog.locator('form .task-state').count(),0,'Reopening must not show a past success');await dialog.getByRole('button',{name:'删除项目',exact:true}).click();await dialog.getByRole('group',{name:'确认删除项目'}).getByRole('button',{name:'确认删除',exact:true}).click();await waitNoDialog();await article.waitFor({state:'hidden'});const deleted=await context.newPage();try{const response=await deleted.goto(localURL(publicURL).href);assert.equal(response.status(),404);}finally{await deleted.close();}step('reopening resets the upload form; own temporary project deleted and public URL returns 404');
 const copy=page.locator('article').getByRole('button',{name:'复制链接',exact:true}).first();if(await copy.count()){await copy.click();const toast=page.locator('.toast');await toast.waitFor();const bounds=await toast.boundingBox();assert.ok(bounds&&bounds.y>=0&&bounds.y+bounds.height<=1000,'Copy feedback is outside the viewport');await toast.getByRole('button',{name:'关闭提示'}).click();step('copy confirmation stays visible in the viewport');}
 assert.equal(report.blockedRequests.length,0,'UI requested a non-local resource');report.success=true;
}catch(e){report.error=sanitized(e);console.error(report.error);process.exitCode=1;}
finally{
 try{
  if(page&&identity){const listing=await api('/api/v1/projects');assert.equal(listing.status,200,'Cannot verify local cleanup');const own=listing.data.items.filter(p=>p.name===name&&p.ownerId===identity.id);assert.ok(own.length<=1,'Ambiguous temporary project; cleanup refused');if(own.length){const p=own[0];assert.match(p.id,/^[a-f0-9]{48}$/);if(project)assert.equal(p.id,project.id,'Temporary ID changed; cleanup refused');for(let n=0;n<90;n++){const current=await api('/api/v1/projects/'+p.id);if(current.status===404)break;assert.equal(current.status,200);assert.equal(current.data.name,name);assert.equal(current.data.ownerId,identity.id);const task=current.data.latestDeployment;if(!task||['SUCCEEDED','FAILED'].includes(task.status)){const result=await api('/api/v1/projects/'+p.id,'DELETE');assert.equal(result.status,200,'Temporary project cleanup failed');break;}await new Promise(resolve=>setTimeout(resolve,1000));}const remains=await api('/api/v1/projects');assert.ok(!remains.data.items.some(x=>x.id===p.id),'Temporary task remains busy; cleanup incomplete');}report.cleanup=true;
  }else report.cleanup=true;
 }catch(e){report.cleanup=false;report.cleanupError=sanitized(e);console.error(report.cleanupError);process.exitCode=1;}
 writeFileSync(output+'ui-local-report.json',JSON.stringify(report,null,2));await browser?.close();
}
if(report.success&&report.cleanup)console.log('PASS: local UI acceptance complete; only the uniquely named temporary project was removed.');

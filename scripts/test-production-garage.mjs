// Explicit opt-in production smoke test: node scripts/test-production-garage.mjs
// Credentials: ignored .local/garage-admin.txt containing {url,username,password}.
// This module does not use the local HTTP-only test helpers: production checks
// deliberately use verified HTTPS and never disable TLS certificate validation.
import assert from 'node:assert/strict';
import {readFileSync,mkdirSync} from 'node:fs';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {randomBytes} from 'node:crypto';

const workspace=fileURLToPath(new URL('../',import.meta.url));
const require=createRequire(new URL('../frontend/package.json',import.meta.url));
const {zipSync,strToU8}=require('fflate');
const {chromium}=require('playwright');
let credentials;
try{credentials=JSON.parse(readFileSync(path.join(workspace,'.local/garage-admin.txt'),'utf8'));}
catch{throw new Error('Prepare ignored .local/garage-admin.txt as JSON {url,username,password} before running.');}
const target=new URL(credentials.url);
assert.equal(target.origin,'https://garage.byjin.cn','This script only targets https://garage.byjin.cn.');
assert.equal(target.pathname,'/','Credential URL must be the site root.');
assert.ok(!target.username&&!target.password&&!target.search&&!target.hash,'Use a plain HTTPS root URL.');
assert.ok(typeof credentials.username==='string'&&credentials.username&&typeof credentials.password==='string'&&credentials.password,'Credential fields missing.');
const origin=target.origin;
const pass=message=>console.log('PASS: '+message);
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let cookie='',csrf='',ownerId='',browser,context,project=null,deleted=false,initialProjects=null,initialUsers=null;
const testName='Garage smoke '+Date.now().toString(36)+' '+randomBytes(4).toString('hex');
const activeTasks=new Set();

async function api(route,method='GET',body,expected=200){
 const binary=body instanceof Uint8Array;
 const response=await fetch(origin+'/api/v1'+route,{
  method,redirect:'error',signal:AbortSignal.timeout(30000),
  headers:{Origin:origin,...(cookie?{Cookie:cookie,'X-CSRF-Token':csrf}:{}),...(body===undefined?{}:{'Content-Type':binary?'application/zip':'application/json'})},
  body:body===undefined?undefined:binary?body:JSON.stringify(body),
 });
 assert.equal(response.status,expected,`${method} ${route}: unexpected HTTP ${response.status}`);
 return {response,data:await response.json()};
}
function archive(version){
 return zipSync({
  'dist/index.html':strToU8('<!doctype html><html><head><meta charset="UTF-8"><link rel="stylesheet" href="/assets/site.css"></head><body><h1 id="version">loading</h1><button id="app">App</button><p id="route"></p><img id="app-icon" alt="Apps icon"><script src="/assets/site.js"></script></body></html>'),
  'dist/assets/site.css':strToU8('h1 { color: rgb(18, 103, 124); }'),
  'dist/assets/site.js':strToU8('document.getElementById("version").textContent="Garage '+version+'";'+String.raw`
const routes=['/mobile/im/chats','/mobile/im/apps'];
function link(path){if(!routes.includes(path))throw Error('Unknown mobile route');return '#'+path.replace(/^\/mobile\//,'');}
function show(){const name=location.hash.replace(/^#/,'')||'im/chats';const route=name.startsWith('mobile/')?'/'+name:\`/mobile/\${name}\`;if(!routes.includes(route))throw Error('Unknown mobile route');document.getElementById('route').textContent=route==='/mobile/im/apps'?'Apps ready':'Chats ready';}
document.getElementById('app').onclick=()=>{location.hash=link('/mobile/im/apps');};
document.getElementById('app-icon').src='/mobile/im/apps.svg';
window.addEventListener('hashchange',show);show();
`.replaceAll('\\`','`').replaceAll('\\${','${')),
  'dist/mobile/im/apps.svg':strToU8('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#607c6c"/></svg>'),
 },{level:6});
}
async function taskResult(id,timeout=180000){
 const end=Date.now()+timeout;
 while(Date.now()<end){
  const {data}=await api('/deployments/'+id);
  if(['SUCCEEDED','FAILED'].includes(data.status)){activeTasks.delete(id);return data;}
  await sleep(700);
 }
 throw new Error('Deployment did not finish within the production smoke timeout.');
}
async function publish(bytes,expected){
 await readyForUpload();
 const {data:deployment}=await api('/projects/'+project.id+'/deployments','POST',{});
 activeTasks.add(deployment.id);
 await api('/deployments/'+deployment.id+'/archive','PUT',bytes,202);
 const result=await taskResult(deployment.id);
 assert.equal(result.status,expected,'Unexpected deployment result.');
 return result;
}
function projectSnapshot(items){return items.map(p=>({id:p.id,name:p.name,url:p.url,ownerId:p.ownerId,currentReleaseId:p.currentReleaseId??null})).sort((a,b)=>a.id.localeCompare(b.id));}
function userSnapshot(items){return items.map(u=>({id:u.id,username:u.username,role:u.role,status:u.status})).sort((a,b)=>a.id.localeCompare(b.id));}
async function existingUnchanged(){
 if(!initialProjects)return;
 const {data:projects}=await api('/projects'),{data:users}=await api('/admin/users');
 assert.ok(JSON.stringify(projectSnapshot(projects.items))===JSON.stringify(initialProjects),'Existing projects changed or temporary project was not removed.');
 assert.ok(JSON.stringify(userSnapshot(users.items))===JSON.stringify(initialUsers),'Existing account set or state changed.');
}
async function readyForUpload(){
 for(let attempt=0;attempt<120;attempt++){
  const {data}=await api('/projects/'+project.id+'/versions');
  if(!data.busy&&!data.cleanupPending)return;
  await sleep(500);
 }
 throw Error('Temporary project is still publishing or cleaning files.');
}
function checkedPublicURL(value){
 const result=new URL(value);
 assert.equal(result.origin,origin,'Public links must use this production site.');
 assert.ok(!result.username&&!result.password&&!result.search&&!result.hash);
 return result.href;
}
async function removeOwnTestProject(){
 if(!project||deleted)return;
 // Only the exact project ID, owner and random test name created by this run
 // are eligible for cleanup. No enumeration-based deletion is performed.
 for(const id of [...activeTasks])await taskResult(id,300000);
 const {data:current}=await api('/projects/'+project.id);
 assert.equal(current.id,project.id);assert.equal(current.ownerId,ownerId);assert.equal(current.name,testName);
 for(let attempt=0;attempt<20;attempt++){
  const response=await fetch(origin+'/api/v1/projects/'+project.id,{method:'DELETE',redirect:'error',signal:AbortSignal.timeout(30000),headers:{Origin:origin,Cookie:cookie,'X-CSRF-Token':csrf}});
  if(response.status===200||response.status===404){deleted=true;return;}
  if(response.status!==409)throw new Error('Could not remove this run’s temporary project: HTTP '+response.status);
  await sleep(1000);
 }
 throw new Error('Temporary project is still processing; cleanup could not complete.');
}
async function renderVersion(page,url,version){
 const failures=[],errors=[];
 const onError=error=>errors.push(error.message);
 const onResponse=response=>{if(response.status()>=400&&/\.(?:css|js)(?:[?#]|$)/.test(response.url()))failures.push(response.status());};
 page.on('pageerror',onError);page.on('response',onResponse);
 try{
  const response=await page.goto(url,{waitUntil:'networkidle',timeout:45000});
  assert.equal(response.status(),200);
  await page.getByRole('heading',{name:'Garage '+version,exact:true}).waitFor();
  assert.equal(await page.locator('#version').evaluate(element=>getComputedStyle(element).color),'rgb(18, 103, 124)');
  assert.equal(failures.length,0,'Published JS/CSS request failed.');
  assert.equal(errors.length,0,'Published page raised a JavaScript error.');
  await page.getByRole('button',{name:'App',exact:true}).click();
  await page.getByText('Apps ready',{exact:true}).waitFor();
  assert.equal(new URL(page.url()).hash,'#im/apps');
  await page.reload({waitUntil:'networkidle'});await page.getByText('Apps ready',{exact:true}).waitFor();
  assert.equal(await page.locator('#app-icon').evaluate(img=>img.complete&&img.naturalWidth===32),true);
  assert.equal(errors.length,0,'Internal Hash route or resource adaptation failed.');
  const icon=await page.locator('link[rel="icon"]').getAttribute('href');
  assert.ok(icon,'Static prototype without its own icon must receive the platform icon.');
  const iconURL=new URL(icon,url);assert.equal(iconURL.origin,origin);
  const iconResponse=await fetch(iconURL,{signal:AbortSignal.timeout(15000)});
  assert.equal(iconResponse.status,200);assert.match(iconResponse.headers.get('content-type'),/image\/svg\+xml/);
 }finally{page.off('pageerror',onError);page.off('response',onResponse);}
}

let failure;
try{
 const {response:loginResponse,data:session}=await api('/auth/login','POST',{username:credentials.username,password:credentials.password});
 const setCookie=loginResponse.headers.getSetCookie().find(value=>value.startsWith('__Host-'));
 assert.ok(setCookie,'HTTPS login must issue a __Host- session cookie.');
 assert.match(setCookie,/;\s*Secure(?:;|$)/i);assert.match(setCookie,/;\s*HttpOnly(?:;|$)/i);
 assert.match(setCookie,/;\s*Path=\/(?:;|$)/i);assert.doesNotMatch(setCookie,/;\s*Domain=/i);
 cookie=setCookie.split(';')[0];csrf=session.csrfToken;ownerId=session.user.id;
 assert.ok(csrf&&ownerId);assert.equal(session.user.role,'admin');
 credentials.password=''; // Keep credentials out of output and later error objects.
 pass('HTTPS login and __Host- Secure HttpOnly host-only cookie');
 const {data:initial}=await api('/projects');
 initialProjects=projectSnapshot(initial.items);
 const {data:initialAccounts}=await api('/admin/users');initialUsers=userSnapshot(initialAccounts.items);
 const initialMetrics=initialAccounts.items.find(user=>user.id===ownerId);
 assert.ok(initialAccounts.storageMeasuredAt&&initialMetrics&&typeof initialMetrics.storageBytes==='number');
 assert.ok(initialMetrics.loginCount>=1&&initialMetrics.lastLoginAt&&initialMetrics.loginStatsSince);
 const ownPublishedCount=initial.items.filter(p=>p.ownerId===ownerId&&p.currentReleaseId).length;
 pass('existing accounts and project identity/current-release fields snapshotted without modification');

 browser=await chromium.launch({channel:'chrome',headless:true});
 context=await browser.newContext({viewport:{width:1440,height:1000},ignoreHTTPSErrors:false});
 const loginContext=await browser.newContext({viewport:{width:1156,height:1004},ignoreHTTPSErrors:false});
 try{
  const loginPage=await loginContext.newPage();await loginPage.goto(origin+'/',{waitUntil:'networkidle'});
  await loginPage.getByRole('button',{name:'显示密码',exact:true}).waitFor();
  assert.equal(await loginPage.locator('.scene-letter').count(),8);
  const password=loginPage.locator('[name="password"]');await password.fill('visual-check');
  await loginPage.getByRole('button',{name:'显示密码',exact:true}).click();assert.equal(await password.getAttribute('type'),'text');
  await loginPage.getByRole('button',{name:'隐藏密码',exact:true}).click();assert.equal(await password.getAttribute('type'),'password');
 }finally{await loginContext.close();}
 pass('HTTPS login form includes refined fields, password reveal and interactive scene');
 const delimiter=cookie.indexOf('=');
 await context.addCookies([{name:cookie.slice(0,delimiter),value:cookie.slice(delimiter+1),url:origin,httpOnly:true,secure:true,sameSite:'Lax'}]);
 const preview=await context.newPage();
 ({data:project}=await api('/projects','POST',{name:testName}));
 assert.equal(project.ownerId,ownerId,'Temporary project ownership mismatch.');
 const fixedURL=checkedPublicURL(project.url);
 await publish(archive('v1'),'SUCCEEDED');await renderVersion(preview,fixedURL,'v1');
 const firstUsage=(await api('/admin/users')).data.items.find(user=>user.id===ownerId);
 assert.ok(firstUsage.storageBytes>initialMetrics.storageBytes,'Published files must contribute to owner usage.');
 const {data:first}=await api('/projects/'+project.id);assert.equal(first.currentVersionNumber,1);assert.ok(first.currentReleaseId);
 pass('real ZIP published, HTML/JS rendered v1 and CSS applied in Chrome');
 pass('internal Hash router App navigation, route refresh and mobile-directory assets survive path adaptation');
 await publish(archive('v2'),'SUCCEEDED');
 const {data:updated}=await api('/projects/'+project.id);
 assert.equal(updated.url,fixedURL,'Updating must preserve the public URL.');
 assert.equal(updated.currentVersionNumber,2);assert.ok(updated.currentReleaseId&&updated.currentReleaseId!==first.currentReleaseId);
 await renderVersion(preview,fixedURL,'v2');
 const secondUsage=(await api('/admin/users')).data.items.find(user=>user.id===ownerId);
 assert.ok(secondUsage.storageBytes>firstUsage.storageBytes,'Retained v1 and v2 must both contribute to owner usage.');
 assert.equal(secondUsage.loginCount,initialMetrics.loginCount,'Publishing/session reads are not new logins.');
 pass('same public URL renders v2 after update');
 const {data:versions}=await api('/projects/'+project.id+'/versions');
 assert.equal(versions.retentionLimit,5);assert.deepEqual(versions.items.map(v=>v.versionNumber),[2,1]);
 assert.ok(versions.items.every(v=>v.filesState==='available'));
 const {data:logs}=await api('/projects/'+project.id+'/deployments');assert.equal(logs.items.length,2);
 const {data:rolled}=await api('/projects/'+project.id+'/versions/'+first.currentReleaseId+'/activate','POST',{expectedCurrentReleaseId:updated.currentReleaseId});
 assert.equal(rolled.currentReleaseId,first.currentReleaseId);await renderVersion(preview,fixedURL,'v1');
 const {data:restored}=await api('/projects/'+project.id+'/versions/'+updated.currentReleaseId+'/activate','POST',{expectedCurrentReleaseId:first.currentReleaseId});
 assert.equal(restored.currentReleaseId,updated.currentReleaseId);await renderVersion(preview,fixedURL,'v2');
 const {data:afterSwitch}=await api('/projects/'+project.id);assert.equal(afterSwitch.url,fixedURL);
 assert.equal((await api('/projects/'+project.id+'/deployments')).data.items.length,2,'Switching must not create upload records.');
 pass('independent version APIs retain two versions; rollback v1 and return v2 preserve URL and upload history');
 const versionPage=await context.newPage();await versionPage.goto(origin+'/',{waitUntil:'networkidle'});
 await versionPage.getByRole('heading',{name:'项目列表',exact:true}).waitFor();
 assert.equal(await versionPage.locator('.logout [data-icon="logout"]').count(),1);
 assert.equal(await versionPage.locator('.share-all-button [data-icon="share"]').count(),1);
 assert.equal(await versionPage.locator('.project-content').count(),1);
 await versionPage.waitForFunction(()=>['collapsing','compact'].includes(document.querySelector('.project-masthead')?.getAttribute('data-welcome-state')));
 const animatedHeights=await versionPage.evaluate(()=>document.getAnimations().filter(animation=>animation.effect?.getKeyframes().some(frame=>Object.hasOwn(frame,'height'))).length);
 assert.equal(animatedHeights,0,'Exit must not animate height and re-layout the list each frame.');
 await versionPage.waitForFunction(()=>document.querySelector('.project-masthead')?.getAttribute('data-welcome-state')==='compact');
 await versionPage.reload({waitUntil:'networkidle'});
 assert.equal(await versionPage.locator('.project-masthead').getAttribute('data-welcome-state'),'compact','Refresh must not replay the opening.');
 const tempCard=versionPage.locator('article.project').filter({has:versionPage.getByRole('heading',{name:testName,exact:true})});
 assert.equal(await tempCard.locator('.project-open [data-icon="external"]').count(),1);
 assert.match(await tempCard.locator('.timestamp time').getAttribute('title'),/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
 await tempCard.getByRole('button',{name:'版本管理',exact:true}).click();
 const versionDialog=versionPage.getByRole('dialog',{name:'版本管理',exact:true});await versionDialog.waitFor();
 await versionDialog.getByTestId('version-history').waitFor();
 await versionDialog.getByRole('heading',{name:'可切换版本',exact:true}).waitFor();
 await versionDialog.getByText('当前版本 v2',{exact:true}).waitFor();
 await versionDialog.getByRole('button',{name:'切换到 v1',exact:true}).waitFor();
 assert.equal(await versionDialog.locator('input[type="file"]').count(),0,'Version management must be separate from uploading.');
 const close=versionDialog.locator('button.close');assert.equal(await close.locator('svg path').count(),1);
 assert.equal(await close.evaluate(element=>getComputedStyle(element).width),'48px');
 await close.click();await versionDialog.waitFor({state:'hidden'});
 await tempCard.getByRole('button',{name:'发布更新',exact:true}).click();
 const uploadDialog=versionPage.getByRole('dialog');await uploadDialog.waitFor();
 assert.equal(await uploadDialog.locator('button.primary.full [data-icon="upload"]').count(),1);
 await uploadDialog.locator('button.close').click();await uploadDialog.waitFor({state:'hidden'});
 await versionPage.close();
 pass('new project-list UI opens independent version management with current version and switch target');
 pass('semantic operation icons, SVG close control and compositor-only exit animation verified on HTTPS');
 await publish(strToU8('invalid zip production smoke'),'FAILED');
 await renderVersion(preview,fixedURL,'v2');
 assert.equal((await api('/projects/'+project.id)).data.currentReleaseId,updated.currentReleaseId);
 assert.deepEqual((await api('/projects/'+project.id+'/versions')).data.items.map(v=>v.id),versions.items.map(v=>v.id));
 pass('invalid ZIP failed while v2 remains available');
 const {data:share}=await api('/share-page','POST',{});
 assert.equal(share.publishedCount,ownPublishedCount+1);
 const shareURL=checkedPublicURL(share.url);
 await preview.goto(shareURL,{waitUntil:'domcontentloaded'});
 assert.match(await preview.locator('link[rel="icon"]').getAttribute('href'),/^data:image\/svg\+xml;base64,/);
 await preview.getByRole('heading',{name:testName,exact:true}).waitFor();
 const sharedLink=preview.locator('article').filter({has:preview.getByRole('heading',{name:testName,exact:true})}).getByRole('link');
 assert.equal(await sharedLink.getAttribute('href'),fixedURL);
 assert.equal(await sharedLink.locator('.open-arrow svg').count(),1);
 assert.equal(await sharedLink.locator('.open-label').innerText(),'打开原型');
 pass('public share page includes the published project');
 await removeOwnTestProject();
 const gone=await fetch(fixedURL,{redirect:'error',signal:AbortSignal.timeout(30000)});
 assert.equal(gone.status,404);
 await preview.goto(shareURL,{waitUntil:'domcontentloaded'});
 assert.equal(await preview.getByRole('heading',{name:testName,exact:true}).count(),0);
 pass('only the temporary project deleted; old link is 404 and share entry removed');

 await existingUnchanged();
 const {data:final}=await api('/projects');assert.equal(final.items.length,initialProjects.length);
 const consolePage=await context.newPage();await consolePage.goto(origin+'/',{waitUntil:'networkidle'});
 await consolePage.getByRole('heading',{name:'项目列表',exact:true}).waitFor();
 assert.equal(await consolePage.locator('article.project').count(),initialProjects.length);
 await consolePage.getByRole('button',{name:'成员管理',exact:true}).click();
 await consolePage.locator('.members-table tbody tr').last().waitFor();
 for(const name of ['占用空间','登录次数','最近登录'])assert.equal(await consolePage.getByRole('columnheader',{name,exact:true}).count(),1);
 await consolePage.screenshot({path:path.join(workspace,'.local/garage-members-online.png'),fullPage:true});
 await consolePage.getByRole('button',{name:'项目列表',exact:true}).click();
 mkdirSync(path.join(workspace,'.local'),{recursive:true});
 await consolePage.screenshot({path:path.join(workspace,'.local/garage-online.png'),fullPage:true});
 pass('existing account/project snapshots unchanged; final HTTPS project list screenshot saved');
 pass('member storage/login statistics, relative-time tooltip, one-time opening and prototype/collection icons verified online');
}catch(error){failure=error;}
finally{
 try{await removeOwnTestProject();}catch{console.error('Cleanup could not be confirmed for this run’s temporary project only. No existing project was deleted.');failure ||= new Error('Temporary project cleanup requires inspection.');}
 try{await existingUnchanged();}catch(error){failure ||= error;}
 if(browser)await browser.close();
 if(cookie&&csrf){try{await api('/auth/logout','POST');}catch{console.error('Test session logout could not be confirmed.');}}
}
if(failure){console.error('FAIL: '+failure.message);process.exitCode=1;}

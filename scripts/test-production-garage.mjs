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
  'dist/index.html':strToU8('<!doctype html><html><head><meta charset="UTF-8"><link rel="stylesheet" href="/assets/site.css"></head><body><h1 id="version">loading</h1><script src="/assets/site.js"></script></body></html>'),
  'dist/assets/site.css':strToU8('h1 { color: rgb(18, 103, 124); }'),
  'dist/assets/site.js':strToU8('document.getElementById("version").textContent="Garage '+version+'";'),
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
 const ownPublishedCount=initial.items.filter(p=>p.ownerId===ownerId&&p.currentReleaseId).length;
 pass('existing accounts and project identity/current-release fields snapshotted without modification');

 browser=await chromium.launch({channel:'chrome',headless:true});
 context=await browser.newContext({viewport:{width:1440,height:1000},ignoreHTTPSErrors:false});
 const delimiter=cookie.indexOf('=');
 await context.addCookies([{name:cookie.slice(0,delimiter),value:cookie.slice(delimiter+1),url:origin,httpOnly:true,secure:true,sameSite:'Lax'}]);
 const preview=await context.newPage();
 ({data:project}=await api('/projects','POST',{name:testName}));
 assert.equal(project.ownerId,ownerId,'Temporary project ownership mismatch.');
 const fixedURL=checkedPublicURL(project.url);
 await publish(archive('v1'),'SUCCEEDED');await renderVersion(preview,fixedURL,'v1');
 const {data:first}=await api('/projects/'+project.id);assert.equal(first.currentVersionNumber,1);assert.ok(first.currentReleaseId);
 pass('real ZIP published, HTML/JS rendered v1 and CSS applied in Chrome');
 await publish(archive('v2'),'SUCCEEDED');
 const {data:updated}=await api('/projects/'+project.id);
 assert.equal(updated.url,fixedURL,'Updating must preserve the public URL.');
 assert.equal(updated.currentVersionNumber,2);assert.ok(updated.currentReleaseId&&updated.currentReleaseId!==first.currentReleaseId);
 await renderVersion(preview,fixedURL,'v2');
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
 const tempCard=versionPage.locator('article.project').filter({has:versionPage.getByRole('heading',{name:testName,exact:true})});
 await tempCard.getByRole('button',{name:'版本管理',exact:true}).click();
 const versionDialog=versionPage.getByRole('dialog',{name:'版本管理',exact:true});await versionDialog.waitFor();
 await versionDialog.getByTestId('version-history').waitFor();
 await versionDialog.getByRole('heading',{name:'可切换版本',exact:true}).waitFor();
 await versionDialog.getByText('当前版本 v2',{exact:true}).waitFor();
 await versionDialog.getByRole('button',{name:'切换到 v1',exact:true}).waitFor();
 assert.equal(await versionDialog.locator('input[type="file"]').count(),0,'Version management must be separate from uploading.');
 await versionPage.close();
 pass('new project-list UI opens independent version management with current version and switch target');
 await publish(strToU8('invalid zip production smoke'),'FAILED');
 await renderVersion(preview,fixedURL,'v2');
 assert.equal((await api('/projects/'+project.id)).data.currentReleaseId,updated.currentReleaseId);
 assert.deepEqual((await api('/projects/'+project.id+'/versions')).data.items.map(v=>v.id),versions.items.map(v=>v.id));
 pass('invalid ZIP failed while v2 remains available');
 const {data:share}=await api('/share-page','POST',{});
 assert.equal(share.publishedCount,ownPublishedCount+1);
 const shareURL=checkedPublicURL(share.url);
 await preview.goto(shareURL,{waitUntil:'domcontentloaded'});
 await preview.getByRole('heading',{name:testName,exact:true}).waitFor();
 const sharedLink=preview.locator('article').filter({has:preview.getByRole('heading',{name:testName,exact:true})}).getByRole('link');
 assert.equal(await sharedLink.getAttribute('href'),fixedURL);
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
 mkdirSync(path.join(workspace,'.local'),{recursive:true});
 await consolePage.screenshot({path:path.join(workspace,'.local/garage-online.png'),fullPage:true});
 pass('existing account/project snapshots unchanged; final HTTPS project list screenshot saved');
}catch(error){failure=error;}
finally{
 try{await removeOwnTestProject();}catch{console.error('Cleanup could not be confirmed for this run’s temporary project only. No existing project was deleted.');failure ||= new Error('Temporary project cleanup requires inspection.');}
 try{await existingUnchanged();}catch(error){failure ||= error;}
 if(browser)await browser.close();
 if(cookie&&csrf){try{await api('/auth/logout','POST');}catch{console.error('Test session logout could not be confirmed.');}}
}
if(failure){console.error('FAIL: '+failure.message);process.exitCode=1;}

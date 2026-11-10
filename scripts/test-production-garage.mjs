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
let cookie='',csrf='',ownerId='',browser,context,project=null,deleted=false;
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
 const {data:deployment}=await api('/projects/'+project.id+'/deployments','POST',{});
 activeTasks.add(deployment.id);
 await api('/deployments/'+deployment.id+'/archive','PUT',bytes,202);
 const result=await taskResult(deployment.id);
 assert.equal(result.status,expected,'Unexpected deployment result.');
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
 assert.equal(initial.items.length,0,'Expected an empty production platform; existing projects are never removed.');
 pass('initial project list is empty');

 browser=await chromium.launch({channel:'chrome',headless:true});
 context=await browser.newContext({viewport:{width:1440,height:1000},ignoreHTTPSErrors:false});
 const delimiter=cookie.indexOf('=');
 await context.addCookies([{name:cookie.slice(0,delimiter),value:cookie.slice(delimiter+1),url:origin,httpOnly:true,secure:true,sameSite:'Lax'}]);
 const preview=await context.newPage();
 ({data:project}=await api('/projects','POST',{name:testName}));
 assert.equal(project.ownerId,ownerId,'Temporary project ownership mismatch.');
 const fixedURL=checkedPublicURL(project.url);
 await publish(archive('v1'),'SUCCEEDED');await renderVersion(preview,fixedURL,'v1');
 pass('real ZIP published, HTML/JS rendered v1 and CSS applied in Chrome');
 await publish(archive('v2'),'SUCCEEDED');
 const {data:updated}=await api('/projects/'+project.id);
 assert.equal(updated.url,fixedURL,'Updating must preserve the public URL.');
 await renderVersion(preview,fixedURL,'v2');
 pass('same public URL renders v2 after update');
 await publish(strToU8('invalid zip production smoke'),'FAILED');
 await renderVersion(preview,fixedURL,'v2');
 pass('invalid ZIP failed while v2 remains available');
 const {data:share}=await api('/share-page','POST',{});
 assert.equal(share.publishedCount,1);
 const shareURL=checkedPublicURL(share.url);
 await preview.goto(shareURL,{waitUntil:'domcontentloaded'});
 await preview.getByRole('heading',{name:testName,exact:true}).waitFor();
 const sharedLink=preview.getByRole('link',{name:'打开原型 ↗'});
 assert.equal(await sharedLink.getAttribute('href'),fixedURL);
 pass('public share page includes the published project');
 await removeOwnTestProject();
 const gone=await fetch(fixedURL,{redirect:'error',signal:AbortSignal.timeout(30000)});
 assert.equal(gone.status,404);
 await preview.goto(shareURL,{waitUntil:'domcontentloaded'});
 assert.equal(await preview.getByRole('heading',{name:testName,exact:true}).count(),0);
 pass('only the temporary project deleted; old link is 404 and share entry removed');

 const {data:final}=await api('/projects');assert.equal(final.items.length,0,'Platform must finish with zero projects.');
 const consolePage=await context.newPage();await consolePage.goto(origin+'/',{waitUntil:'networkidle'});
 await consolePage.getByRole('heading',{name:'项目列表',exact:true}).waitFor();
 await consolePage.getByRole('heading',{name:'发布你的第一个原型',exact:true}).waitFor();
 assert.equal(await consolePage.locator('.project').count(),0);
 mkdirSync(path.join(workspace,'.local'),{recursive:true});
 await consolePage.screenshot({path:path.join(workspace,'.local/garage-online.png'),fullPage:true});
 pass('final zero-project HTTPS dashboard and empty-state screenshot saved to .local/garage-online.png');
}catch(error){failure=error;}
finally{
 try{await removeOwnTestProject();}catch{console.error('Cleanup could not be confirmed for this run’s temporary project only. No existing project was deleted.');failure ||= new Error('Temporary project cleanup requires inspection.');}
 if(browser)await browser.close();
 if(cookie&&csrf){try{await api('/auth/logout','POST');}catch{console.error('Test session logout could not be confirmed.');}}
}
if(failure){console.error('FAIL: '+failure.message);process.exitCode=1;}

// Local-only acceptance. Creates one temporary project, no accounts; always cleans it.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
const require=createRequire(new URL('../frontend/package.json',import.meta.url));
const {chromium}=require('playwright'),{zipSync,strToU8}=require('fflate');
const workspace=fileURLToPath(new URL('../',import.meta.url));
const origin='http://console.localhost:8080';
assert.ok(!process.env.VERSION_TEST_ORIGIN||process.env.VERSION_TEST_ORIGIN===origin,'Only local console.localhost:8080 is permitted.');
const env=Object.fromEntries(readFileSync(path.join(workspace,'.env'),'utf8').split(/\r?\n/).filter(l=>/^[A-Z_]+=/.test(l)).map(l=>{const n=l.indexOf('=');return[l.slice(0,n),l.slice(n+1).replace(/^(['"])(.*)\1$/,'$2')];}));
assert.ok(env.INIT_ADMIN_USERNAME&&env.INIT_ADMIN_PASSWORD,'Local admin environment missing.');
const output=path.join(workspace,'.local');mkdirSync(output,{recursive:true});
const report={success:false,steps:[],cleanup:false};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const name='Version acceptance '+Date.now().toString(36)+' '+randomBytes(4).toString('hex');
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--host-resolver-rules=MAP *.localhost 127.0.0.1']});
const context=await browser.newContext({viewport:{width:1440,height:1000}});
await context.route('**/*',route=>{const u=new URL(route.request().url());return ['localhost','console.localhost','127.0.0.1'].includes(u.hostname)?route.continue():route.abort('blockedbyclient');});
const page=await context.newPage(),preview=await context.newPage();
let csrf='',ownerId='',project,deleted=false,failure;
const tasks=new Set();
function pass(step){report.steps.push(step);console.log('PASS: '+step);}
async function api(route,method='GET',body,expected=200){
 const binary=body instanceof Uint8Array;
 const result=await page.evaluate(async({route,method,body,binary,csrf})=>{
  const r=await fetch('/api/v1'+route,{method,redirect:'error',headers:{...(csrf?{'X-CSRF-Token':csrf}:{}),...(body===undefined?{}:{'Content-Type':binary?'application/zip':'application/json'})},body:body===undefined?undefined:binary?new Uint8Array(body):JSON.stringify(body)});
  const text=await r.text();let data;try{data=JSON.parse(text);}catch{}
  return {status:r.status,data};
 },{route,method,body:binary?Array.from(body):body,binary,csrf});
 assert.equal(result.status,expected,`${method} ${route}: HTTP ${result.status}, expected ${expected}`);
 return result.data;
}
const projectPath=()=>'/projects/'+project.id;
const versions=()=>api(projectPath()+'/versions');
const details=()=>api(projectPath());
async function waitTask(id){
 for(let i=0;i<180;i++){
  const d=await api('/deployments/'+id);
  if(['SUCCEEDED','FAILED'].includes(d.status)){tasks.delete(id);return d;}
  await sleep(300);
 }
 throw Error('Local publishing timeout; task '+id);
}
function archive(n){return zipSync({
 'index.html':strToU8('<!doctype html><html><head><link rel="icon" href="data:,"><link rel="stylesheet" href="./assets/style.css"></head><body><h1 id="v"></h1><a href="./detail/">detail</a><script src="./assets/main.js"></script></body></html>'),
 'assets/main.js':strToU8('document.getElementById("v").textContent="Version '+n+'";'),
 'assets/style.css':strToU8('h1 {color:rgb('+(20+n)+', 80, 120)}'),
 'detail/index.html':strToU8('<!doctype html><title>Detail</title><h1>Detail '+n+'</h1>'),
 ['assets/only-v'+n+'.txt']:strToU8('Only version '+n),
},{level:1});}
async function publish(bytes,expected='SUCCEEDED',existing){
 const d=existing||await api(projectPath()+'/deployments','POST',{});tasks.add(d.id);
 await api('/deployments/'+d.id+'/archive','PUT',bytes,202);
 const result=await waitTask(d.id);assert.equal(result.status,expected);return result;
}
async function activate(id,expectedCurrentReleaseId,expected=200){return api(projectPath()+'/versions/'+id+'/activate','POST',{expectedCurrentReleaseId},expected);}
function publicURL(){const u=new URL(project.url);assert.equal(u.origin,'http://localhost:8080');assert.ok(u.pathname.length>2&&u.pathname.endsWith('/'));return u.href;}
async function render(n){
 const response=await preview.goto(publicURL(),{waitUntil:'networkidle'});assert.equal(response.status(),200);
 await preview.getByRole('heading',{name:'Version '+n,exact:true}).waitFor();
 assert.equal(await preview.locator('h1').evaluate(e=>getComputedStyle(e).color),`rgb(${20+n}, 80, 120)`);
 const resourceStatus=await preview.evaluate(async({base,current,other})=>{
  const a=await fetch(base+'assets/only-v'+current+'.txt'),b=await fetch(base+'assets/only-v'+other+'.txt');
  return [a.status,b.status];
 },{base:publicURL(),current:n,other:n===2?6:2});
 assert.deepEqual(resourceStatus,[200,404],'Current version must not fall back to another release resource');
 const detail=await preview.goto(new URL('detail/',publicURL()).href,{waitUntil:'domcontentloaded'});assert.equal(detail.status(),200);
 await preview.getByRole('heading',{name:'Detail '+n,exact:true}).waitFor();
 await preview.reload();await preview.getByRole('heading',{name:'Detail '+n,exact:true}).waitFor();
}
async function gone(release){
 assert.match(project.id,/^[a-f0-9]+$/);assert.match(release,/^[a-f0-9]+$/);
 const dir=path.join(workspace,'.local/data/releases',project.id,release);
 for(let i=0;i<180;i++){if(!existsSync(dir))return;await sleep(300);}
 throw Error('Expired release directory was not cleaned');
}
async function logPages(){
 const seen=new Set(),items=[];let cursor;
 for(let i=0;i<10;i++){
  const data=await api(projectPath()+'/deployments'+(cursor?'?cursor='+encodeURIComponent(cursor):''));
  assert.ok(Array.isArray(data.items));assert.ok(data.items.length<=20);
  for(const item of data.items){assert.ok(!seen.has(item.id),'Duplicate paginated deployment');seen.add(item.id);items.push(item);}
  if(!data.nextCursor)return {items,pages:i+1};
  assert.notEqual(cursor,data.nextCursor);cursor=data.nextCursor;
 }
 throw Error('Unexpected deployment pagination loop');
}
try{
 await page.goto(origin,{waitUntil:'domcontentloaded'});
 const session=await api('/auth/login','POST',{username:env.INIT_ADMIN_USERNAME,password:env.INIT_ADMIN_PASSWORD});
 csrf=session.csrfToken;ownerId=session.user.id;env.INIT_ADMIN_PASSWORD='';
 project=await api('/projects','POST',{name});assert.equal(project.ownerId,ownerId);
 const initial=await versions();assert.deepEqual(initial.items,[]);assert.equal(initial.retentionLimit,5);
 pass('unpublished project has empty version history and retention limit five');
 const released=[];
 for(let n=1;n<=6;n++){
  await publish(archive(n));const p=await details();assert.equal(p.currentVersionNumber,n);released.push(p.currentReleaseId);
 }
 let history=await versions();assert.deepEqual(history.items.map(v=>v.versionNumber),[6,5,4,3,2]);
 assert.equal(history.items.filter(v=>v.isCurrent).length,1);
 await gone(released[0]);let logs=await logPages();
 const expired=logs.items.find(d=>d.releaseId===released[0]);assert.ok(expired);assert.equal(expired.versionNumber,1);
 assert.ok(['cleanup_pending','cleaned'].includes(expired.filesState));
 pass('six ZIP publications retain latest five; expired version one log remains and files are removed');
 const originalURL=project.url;
 await activate(released[1],released[5]);await render(2);
 await activate(released[5],released[1]);await render(6);
 assert.equal((await details()).url,originalURL);
 assert.equal((await logPages()).items.length,6,'Switching must not create publication records');
 pass('switch to old version and back serves correct JS/CSS/routes at the same URL without extra publication logs');
 await activate(released[2],released[5]);await publish(archive(7));
 const current=await details();assert.equal(current.currentVersionNumber,7);
 history=await versions();assert.deepEqual(history.items.map(v=>v.versionNumber),[7,6,5,4,3]);await gone(released[1]);
 pass('switching does not reorder retention; upload seven evicts upload two');
 const before=await details();await publish(zipSync({'readme.txt':strToU8('missing entry')}),'FAILED');
 assert.equal((await details()).currentReleaseId,before.currentReleaseId);
 assert.deepEqual((await versions()).items.map(v=>v.id),history.items.map(v=>v.id));await render(7);
 pass('invalid ZIP does not evict versions or change current content');
 await activate(released[2],released[5],409);
 const noopBefore=await details();await activate(noopBefore.currentReleaseId,noopBefore.currentReleaseId);
 const noopAfter=await details();assert.equal(noopAfter.lastPublishedAt,noopBefore.lastPublishedAt);
 pass('stale expected current returns conflict; activating current is a timestamp-preserving no-op');
 const busy=await api(projectPath()+'/deployments','POST',{});tasks.add(busy.id);
 assert.equal((await versions()).busy,true);await activate(released[2],noopAfter.currentReleaseId,409);
 await publish(zipSync({'bad.txt':strToU8('invalid')}),'FAILED',busy);
 pass('in-progress upload blocks activation and reports busy');
 // Small failed uploads exercise cursor pagination without creating accounts or evicting versions.
 for(let i=0;i<14;i++)await publish(zipSync({'invalid.txt':strToU8('no entry '+i)}),'FAILED');
 logs=await logPages();assert.ok(logs.pages>=2);assert.equal(logs.items.length,23);
 assert.equal(logs.items.filter(d=>d.status==='SUCCEEDED').length,7);
 assert.equal(logs.items.filter(d=>d.status==='FAILED').length,16);
 pass('publication logs paginate past twenty without duplicates or lost failures');
 await page.reload({waitUntil:'networkidle'});
 const card=page.locator('article').filter({hasText:name});await card.getByRole('button',{name:/发布更新/}).click();
 const publication=page.getByRole('dialog',{name:'项目详情'});await publication.waitFor();
 assert.equal(await publication.getByTestId('version-history').count(),0,'Publication dialog must not contain history.');
 assert.equal(await publication.getByTestId('version-history-toggle').count(),0);
 assert.equal(await publication.getByRole('button',{name:/切换到 v/}).count(),0);
 await publication.locator('button.close').click();
 await card.getByRole('button',{name:'版本管理',exact:true}).click();
 const modal=page.getByRole('dialog',{name:'版本管理',exact:true});await modal.waitFor();
 assert.equal(await modal.getByTestId('version-history-toggle').count(),0,'Version modal loads automatically.');
 assert.equal(await modal.locator('.file-selection,input[type="file"]').count(),0);
 assert.equal(await modal.getByRole('button',{name:'删除项目',exact:true}).count(),0);
 await page.getByTestId('version-history').waitFor();
 await page.getByRole('heading',{name:'可切换版本',exact:true}).waitFor();
 await page.getByRole('button',{name:'切换到 v6',exact:true}).click();
 const confirmation=page.getByRole('group',{name:'确认切换版本'});await confirmation.waitFor();
 await page.keyboard.press('Escape');await confirmation.waitFor({state:'hidden'});
 assert.equal((await details()).currentVersionNumber,7);
 for(const n of [6,7]){
  await page.getByRole('button',{name:'切换到 v'+n,exact:true}).click();
  const confirm=page.getByRole('button',{name:'确认切换',exact:true});await confirm.focus();await confirm.press('Enter');
  let switched=false;for(let i=0;i<60;i++){if((await details()).currentVersionNumber===n){switched=true;break;}await sleep(200);}
  assert.ok(switched,'Keyboard confirmation did not activate v'+n);await render(n);
  await confirmation.waitFor({state:'hidden'});
 }
 await page.getByRole('heading',{name:'可切换版本',exact:true}).scrollIntoViewIfNeeded();
 await page.screenshot({path:path.join(output,'versions-desktop.png'),animations:'disabled'});
 await page.setViewportSize({width:390,height:844});
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Mobile page overflows');
 assert.ok(await modal.evaluate(e=>e.scrollWidth<=e.clientWidth),'Mobile modal overflows');
 await page.getByRole('heading',{name:'可切换版本',exact:true}).scrollIntoViewIfNeeded();
 await page.screenshot({path:path.join(output,'versions-mobile.png'),animations:'disabled'});
 pass('separate owner version modal auto-loads, excludes upload/delete, fits desktop/mobile; Escape cancels and Enter confirms');
 report.success=true;
}catch(error){failure=error;report.failure=error.message;try{await page.screenshot({path:path.join(output,'versions-failed.png'),fullPage:true});}catch{}}
finally{
 try{
  for(const task of tasks){try{await publish(zipSync({'cancel.txt':strToU8('test cleanup')}),'FAILED',{id:task});}catch{await waitTask(task);}}
  if(project){
   const p=await details();assert.equal(p.id,project.id);assert.equal(p.ownerId,ownerId);assert.equal(p.name,name);
   await api(projectPath(),'DELETE');deleted=true;
   for(let i=0;i<120;i++){if(!existsSync(path.join(workspace,'.local/data/releases',project.id)))break;await sleep(250);}
   report.cleanup=true;
  }
  if(csrf)await api('/auth/logout','POST',{});
 }catch(error){report.cleanupError=error.message;failure ||= error;report.success=false;}
 writeFileSync(path.join(output,'versions-result.json'),JSON.stringify(report,null,2));await browser.close();
}
if(failure){console.error('FAIL: '+failure.message);console.error('See .local/versions-result.json');process.exitCode=1;}
else{assert.ok(deleted);pass('exact temporary project removed and test session logged out');}

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
 const card=page.locator('article').filter({hasText:name});
 const publication=page.getByRole('dialog',{name:'项目详情'});
 const chooseUploadMode=async (n, publishNow)=>{
  const mode=publishNow?'上传并发布':'仅保存版本';
  await publication.getByText(mode,{exact:true}).click();
  assert.ok(await publication.getByRole('radio',{name:mode,exact:true}).isChecked());
  await publication.getByLabel('选择原型文件或 ZIP',{exact:true}).setInputFiles({
   name:'version-'+n+'.zip',mimeType:'application/zip',buffer:Buffer.from(archive(n)),
  });
  await publication.getByRole('button',{name:publishNow?'发布更新':'保存新版本',exact:true}).click();
  const result=page.getByRole('dialog',{name:publishNow?'更新成功':'版本已保存',exact:true});
  await result.waitFor();
  await result.getByRole('button',{name:'完成',exact:true}).click();
 };
 const firstTask=await api(projectPath()+'/deployments','POST',{publishNow:false});
 const first=await publish(archive(1),'SUCCEEDED',firstTask);
 assert.equal(first.savedOnly,true);
 assert.equal(first.projectPublished,false);
 const firstDraft=await details();
 assert.equal(firstDraft.currentVersionNumber,1);
 assert.equal(firstDraft.lastPublishedAt,null);
 assert.equal((await preview.goto(publicURL())).status(),404);
 released.push(firstDraft.currentReleaseId);
 await api(projectPath()+'/versions/'+released[0]+'/publication','PUT',{published:true});

 await page.setViewportSize({width:930,height:1025});
 await page.reload({waitUntil:'networkidle'});
 await card.getByRole('button',{name:'发布更新',exact:true}).click();
 await publication.getByRole('radiogroup',{name:'上传后'}).or(publication.getByRole('group',{name:'上传后'})).waitFor();
 await page.screenshot({path:path.join(output,'version-publish-mode.png'),animations:'disabled'});
 await chooseUploadMode(2,false);
 assert.equal((await details()).currentReleaseId,released[0]);
 const saved=(await versions()).items.find(v=>v.versionNumber===2);
 assert.ok(saved&&!saved.isCurrent);
 assert.equal((await logPages()).items.find(item=>item.releaseId===saved.id).savedOnly,true);
 released.push(saved.id);
 await render(1);

 await api(projectPath()+'/versions/'+released[0]+'/publication','PUT',{published:false});
 await page.reload({waitUntil:'networkidle'});
 await card.getByRole('button',{name:'上传更新',exact:true}).click();
 assert.ok(await publication.getByRole('radio',{name:'仅保存版本',exact:true}).isChecked());
 await chooseUploadMode(3,true);
 const immediate=await details();
 assert.equal(immediate.status,'published');
 assert.equal(immediate.currentVersionNumber,3);
 released.push(immediate.currentReleaseId);
 await render(3);
 pass('saving the first version keeps it private; saving on a live project preserves its current version; explicit publish restores the link with the new version');

 for(let n=4;n<=5;n++){
  await publish(archive(n));const p=await details();assert.equal(p.currentVersionNumber,n);released.push(p.currentReleaseId);
 }
 const history=await versions();assert.deepEqual(history.items.map(v=>v.versionNumber),[5,4,3,2,1]);
 assert.equal(history.items.filter(v=>v.isCurrent).length,1);
 const atLimit=await api(projectPath()+'/deployments','POST',{},409);
 assert.equal(atLimit.code,'VERSION_LIMIT_REACHED');
 assert.deepEqual((await versions()).items.map(v=>v.id),history.items.map(v=>v.id));
 assert.equal((await logPages()).items.length,5,'Rejected sixth version must not create a task');
 pass('five ZIP publications are retained and a sixth is rejected without evicting any version');
 const originalURL=project.url;
 await activate(released[1],released[4]);await render(2);
 assert.equal((await api(projectPath()+'/deployments','POST',{},409)).code,'VERSION_LIMIT_REACHED');
 await activate(released[4],released[1]);await render(5);
 assert.equal((await details()).url,originalURL);
 assert.equal((await logPages()).items.length,5,'Switching must not create publication records');
 pass('switch to old version and back serves correct JS/CSS/routes at the same URL without extra publication logs');
 const failedCover=async bytes=>publish(bytes,'FAILED',await api(projectPath()+'/deployments','POST',{replaceReleaseId:released[4]}));
 const before=await details();await failedCover(zipSync({'readme.txt':strToU8('missing entry')}));
 assert.equal((await details()).currentReleaseId,before.currentReleaseId);
 assert.deepEqual((await versions()).items.map(v=>v.id),history.items.map(v=>v.id));await render(5);
 pass('invalid ZIP does not evict versions or change current content');
 await activate(released[2],released[3],409);
 const noopBefore=await details();await activate(noopBefore.currentReleaseId,noopBefore.currentReleaseId);
 const noopAfter=await details();assert.equal(noopAfter.lastPublishedAt,noopBefore.lastPublishedAt);
 pass('stale expected current returns conflict; activating current is a timestamp-preserving no-op');
 const busy=await api(projectPath()+'/deployments','POST',{replaceReleaseId:released[4]});tasks.add(busy.id);
 assert.equal((await versions()).busy,true);await activate(released[2],noopAfter.currentReleaseId,409);
 await publish(zipSync({'bad.txt':strToU8('invalid')}),'FAILED',busy);
 pass('in-progress upload blocks activation and reports busy');
 // Small failed uploads exercise cursor pagination without creating accounts or evicting versions.
 for(let i=0;i<14;i++)await failedCover(zipSync({'invalid.txt':strToU8('no entry '+i)}));
 const logs=await logPages();assert.ok(logs.pages>=2);assert.equal(logs.items.length,21);
 assert.equal(logs.items.filter(d=>d.status==='SUCCEEDED').length,5);
 assert.equal(logs.items.filter(d=>d.status==='FAILED').length,16);
 pass('publication logs paginate past twenty without duplicates or lost failures');
 await page.reload({waitUntil:'networkidle'});
 await card.getByRole('button',{name:/发布更新/}).click();await publication.waitFor();
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
 await page.getByRole('button',{name:'切换到 v4',exact:true}).click();
 const confirmation=page.getByRole('group',{name:'确认切换版本'});await confirmation.waitFor();
 await page.keyboard.press('Escape');await confirmation.waitFor({state:'hidden'});
 assert.equal((await details()).currentVersionNumber,5);
 for(const n of [4,5]){
  await page.getByRole('button',{name:'切换到 v'+n,exact:true}).click();
  const confirm=page.getByRole('button',{name:'确认切换',exact:true});await confirm.focus();await confirm.press('Enter');
  let switched=false;for(let i=0;i<60;i++){if((await details()).currentVersionNumber===n){switched=true;break;}await sleep(200);}
  assert.ok(switched,'Keyboard confirmation did not activate v'+n);await render(n);
  await confirmation.waitFor({state:'hidden'});
 }
 await page.setViewportSize({width:930,height:1025});
 for(const [row,label] of [[modal.locator('.version-item').first(),'创建时间'],[modal.locator('.version-log > li').filter({hasText:'发布成功'}).first(),'更新时间']]){
  const dates=await row.locator('time').allTextContents();
  assert.equal(dates.length,1);
  assert.match(dates[0],/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal(await row.locator('.version-timestamp').textContent(),label+'：'+dates[0]);
 }
 const aligned=await modal.locator('.version-item').first().evaluate(row=>{
  const meta=row.querySelector('.version-meta').getBoundingClientRect();
  const dates=row.querySelector('.version-timestamp').getBoundingClientRect();
  const actions=row.querySelector('.version-actions').getBoundingClientRect();
  return dates.left>=meta.right&&actions.left>=dates.right&&Math.abs(meta.top+meta.height/2-actions.top-actions.height/2)<2;
 });
 assert.ok(aligned,'Desktop dates and action icons must use the space to the right of the version label');
 await page.getByRole('heading',{name:'可切换版本',exact:true}).scrollIntoViewIfNeeded();
 await page.screenshot({path:path.join(output,'versions-desktop.png'),animations:'disabled'});
 await page.setViewportSize({width:390,height:844});
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Mobile page overflows');
 assert.ok(await modal.evaluate(e=>e.scrollWidth<=e.clientWidth),'Mobile modal overflows');
 await page.getByRole('heading',{name:'可切换版本',exact:true}).scrollIntoViewIfNeeded();
 await page.screenshot({path:path.join(output,'versions-mobile.png'),animations:'disabled'});
 pass('separate owner version modal auto-loads, excludes upload/delete, fits desktop/mobile; Escape cancels and Enter confirms');

 const edit=page.getByRole('dialog',{name:'编辑版本',exact:true});
 const v4=(await versions()).items.find(item=>item.versionNumber===4);
 const oldCurrent=(await details()).currentReleaseId;
 const editIcon=modal.getByRole('button',{name:'编辑 v4',exact:true});
 assert.equal(await editIcon.getAttribute('title'),'编辑 v4');
 await editIcon.click();
 await edit.getByRole('textbox',{name:/版本备注/}).fill('历史版本备注');
 assert.ok(await edit.evaluate(e=>e.scrollWidth<=e.clientWidth),'Mobile editor overflows');
 await edit.getByRole('button',{name:'保存备注',exact:true}).click();
 await modal.getByText('历史版本备注',{exact:true}).first().waitFor();
 assert.equal((await versions()).items.find(item=>item.id===v4.id).filesUpdatedAt,v4.filesUpdatedAt);
 await modal.getByRole('button',{name:'编辑 v4',exact:true}).click();
 await edit.getByLabel('选择原型文件或 ZIP',{exact:true}).setInputFiles({
  name:'replacement.html',mimeType:'text/html',buffer:Buffer.from('<!doctype html><h1>Replaced v4</h1>'),
 });
 await edit.getByRole('button',{name:'覆盖 v4',exact:true}).click();
 const done=page.getByRole('dialog',{name:'更新成功',exact:true});
 await done.getByText('v4 的文件已覆盖，切换到该版本后生效。',{exact:true}).waitFor();
 assert.equal((await details()).currentReleaseId,oldCurrent);
 await render(5);
 const overwritten=await versions();
 assert.equal(overwritten.items.length,5);
 const newV4=overwritten.items.find(item=>item.versionNumber===4);
 assert.notEqual(newV4.id,v4.id);
 assert.equal(newV4.note,'历史版本备注');
 assert.equal(newV4.createdAt,v4.createdAt);
 assert.ok(Date.parse(newV4.filesUpdatedAt)>Date.parse(v4.filesUpdatedAt));
 const replacedRecord=(await logPages()).items.find(item=>item.releaseId===newV4.id);
 assert.equal(replacedRecord.note,'历史版本备注');
 assert.equal(replacedRecord.replacement,true);
 assert.equal((await logPages()).items.find(item=>item.releaseId===v4.id).superseded,true);
 await gone(v4.id);
 await api(projectPath()+'/deployments','POST',{replaceReleaseId:v4.id},409);
 await activate(newV4.id,oldCurrent);
 await preview.goto(publicURL());
 await preview.getByRole('heading',{name:'Replaced v4',exact:true}).waitFor();
 pass('version editor saves notes and replaces historical files at the same version number, with history, cleanup and stale-target protection');

 await done.getByRole('button',{name:'完成',exact:true}).click();
 await modal.locator('button.close').click();
 await card.getByRole('button',{name:/发布更新/}).click();
 const target=publication.getByRole('combobox',{name:'发布到'});
 const targetOptions=publication.getByRole('listbox',{name:'发布到'});
 await page.setViewportSize({width:930,height:1025});
 await target.click();
 await targetOptions.getByRole('option',{name:/覆盖 v4.*当前版本.*更新/}).waitFor();
 assert.equal(await targetOptions.getByRole('option',{name:'创建新版本',exact:true}).count(),0);
 await page.screenshot({path:path.join(output,'version-target-desktop.png'),animations:'disabled'});
 await page.setViewportSize({width:390,height:844});
 assert.ok(await targetOptions.evaluate(e=>e.scrollWidth<=e.clientWidth),'Mobile version menu overflows');
 await target.press('Escape');
 await targetOptions.waitFor({state:'hidden'});
 assert.ok(await publication.isVisible());
 assert.match(await target.innerText(),/选择要覆盖的版本/);
 await publication.getByText('已保存 5 个版本，请选择一个版本覆盖。',{exact:true}).waitFor();
 await publication.getByLabel('选择原型文件或 ZIP',{exact:true}).setInputFiles({
  name:'current.html',mimeType:'text/html',buffer:Buffer.from('<!doctype html><h1>Replaced current</h1>'),
 });
 await publication.getByText('文件已选好',{exact:true}).waitFor();
 assert.ok(await publication.getByRole('button',{name:'发布更新',exact:true}).isDisabled());
 await target.click();
 await targetOptions.getByRole('option',{name:/覆盖 v5.*更新/}).click();
 assert.match(await target.innerText(),/覆盖 v5/);
 await target.press('ArrowDown');
 await target.press('ArrowDown');
 await target.press('Enter');
 assert.match(await target.innerText(),/覆盖 v4/);
 await publication.getByRole('textbox',{name:/版本备注/}).fill('当前版本备注');
 assert.ok(await publication.evaluate(e=>e.scrollWidth<=e.clientWidth),'Mobile upload form overflows');
 await publication.getByRole('button',{name:'覆盖 v4',exact:true}).click();
 await done.getByText('v4 的文件已覆盖，原分享链接可查看更新。',{exact:true}).waitFor();
 const activeReplacement=await details();
 assert.equal(activeReplacement.currentVersionNumber,4);
 assert.equal(activeReplacement.url,originalURL);
 await preview.goto(publicURL());
 await preview.getByRole('heading',{name:'Replaced current',exact:true}).waitFor();
 await gone(newV4.id);
 const invalidReplacement=await api(projectPath()+'/deployments','POST',{replaceReleaseId:activeReplacement.currentReleaseId,note:'失败覆盖备注'});
 await publish(zipSync({'bad.txt':strToU8('invalid')}),'FAILED',invalidReplacement);
 assert.equal((await details()).currentReleaseId,activeReplacement.currentReleaseId);
 assert.equal((await versions()).items.find(item=>item.isCurrent).note,'当前版本备注');
 assert.equal((await versions()).items.length,5);
 pass('full project requires an explicit overwrite target in the UI; successful and failed overwrites keep the limit');

 await done.getByRole('button',{name:'完成',exact:true}).click();
 await card.getByRole('button',{name:'版本管理',exact:true}).click();
 const shareBefore=await api('/share-page');
 const historicalPublish=await api(projectPath()+'/versions/'+released[4]+'/publication','PUT',{published:false},409);
 assert.equal(historicalPublish.code,'VERSION_CHANGED');
 await modal.getByRole('button',{name:'取消发布 v4',exact:true}).click();
 await modal.getByRole('button',{name:'发布 v4',exact:true}).waitFor();
 const offline=await details();
 assert.equal(offline.status,'unpublished');
 assert.equal(offline.currentReleaseId,activeReplacement.currentReleaseId);
 assert.equal(offline.lastPublishedAt,activeReplacement.lastPublishedAt);
 assert.equal((await preview.goto(publicURL())).status(),404);
 assert.equal((await api('/share-page')).publishedCount,shareBefore.publishedCount-1);
 if(shareBefore.url){
  await preview.goto(shareBefore.url);
  assert.equal(await preview.getByRole('link',{name,exact:true}).count(),0);
 }
 await activate(released[4],offline.currentReleaseId);
 assert.equal((await preview.goto(publicURL())).status(),404);
 await activate(offline.currentReleaseId,released[4]);
 await modal.getByRole('button',{name:'刷新版本记录',exact:true}).click();
 await modal.getByRole('button',{name:'发布 v4',exact:true}).click();
 await modal.getByRole('button',{name:'取消发布 v4',exact:true}).waitFor();
 assert.equal((await details()).status,'published');
 assert.equal((await details()).url,originalURL);
 assert.equal((await preview.goto(publicURL())).status(),200);
 await preview.getByRole('heading',{name:'Replaced current',exact:true}).waitFor();
 assert.equal((await api('/share-page')).publishedCount,shareBefore.publishedCount);
 pass('current version can be taken offline and republished at the original URL, and switching does not bypass the offline state');
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

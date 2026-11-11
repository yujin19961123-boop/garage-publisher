// Local real ZIP acceptance. Creates/deletes one uniquely named project only.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync,writeFileSync,mkdirSync,readdirSync,statSync,existsSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const require=createRequire(new URL('../frontend/package.json',import.meta.url));
const {chromium}=require('playwright'),{zipSync,strToU8}=require('fflate');
const workspace=fileURLToPath(new URL('../',import.meta.url)),origin='http://console.localhost:8080';
const env=Object.fromEntries(readFileSync(path.join(workspace,'.env'),'utf8').split(/\r?\n/).filter(line=>/^[A-Z_]+=/.test(line)).map(line=>{const i=line.indexOf('=');return[line.slice(0,i),line.slice(i+1).replace(/^(['"])(.*)\1$/,'$2')];}));
assert.ok(env.INIT_ADMIN_USERNAME&&env.INIT_ADMIN_PASSWORD,'Local credentials missing.');
const report={success:false,cleanup:false,steps:[],localOnly:true},output=path.join(workspace,'.local');mkdirSync(output,{recursive:true});
const name='统计验收 '+Date.now().toString(36)+' '+randomBytes(4).toString('hex');
const browser=await chromium.launch({channel:'chrome',headless:true});
const context=await browser.newContext({viewport:{width:1156,height:1004},reducedMotion:'reduce'});
await context.route('**/*',route=>['http://console.localhost:8080','http://localhost:8080'].includes(new URL(route.request().url()).origin)?route.continue():route.abort());
const page=await context.newPage();let csrf='',owner='',project;
const secret=[env.INIT_ADMIN_PASSWORD];
function pass(step){report.steps.push(step);console.log('PASS: '+step);}
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function api(route,method='GET',body,expected=200){
 const binary=body instanceof Uint8Array;
 const result=await page.evaluate(async({route,method,body,binary,csrf})=>{
  const response=await fetch('/api/v1'+route,{method,headers:{...(csrf?{'X-CSRF-Token':csrf}:{}),...(body===undefined?{}:{'Content-Type':binary?'application/zip':'application/json'})},body:body===undefined?undefined:binary?new Uint8Array(body):JSON.stringify(body)});
  return {status:response.status,data:await response.json().catch(()=>({}))};
 },{route,method,body:binary?Array.from(body):body,binary,csrf});
 assert.equal(result.status,expected,`${method} ${route}: unexpected HTTP status`);return result.data;
}
async function metric(){const list=await api('/admin/users');assert.ok(list.storageMeasuredAt,'Storage must be available');const item=list.items.find(user=>user.id===owner);assert.ok(item&&typeof item.storageBytes==='number');return item;}
async function publish(version){
 const task=await api('/projects/'+project.id+'/deployments','POST',{});
 const bytes=zipSync({'index.html':strToU8(`<!doctype html><html><head><title>Stats fixture</title></head><body><h1>Stats ${version}</h1></body></html>`),['assets/v'+version+'.txt']:strToU8('fixture '.repeat(version*5000))});
 await api('/deployments/'+task.id+'/archive','PUT',bytes,202);
 for(let i=0;i<150;i++){
  const status=await api('/deployments/'+task.id);
  if(status.status==='FAILED')throw Error('Temporary ZIP failed to publish');
  if(status.status==='SUCCEEDED')return;
  await sleep(200);
 }
 throw Error('Temporary ZIP publication timed out');
}
function filesSize(dir){if(!existsSync(dir))return 0;return readdirSync(dir,{withFileTypes:true}).reduce((total,entry)=>total+(entry.isDirectory()?filesSize(path.join(dir,entry.name)):statSync(path.join(dir,entry.name)).size),0);}
async function stableBytes(expected){for(let i=0;i<80;i++){const value=await metric();if(value.storageBytes===expected)return value;await sleep(150);}throw Error('Storage did not settle to the expected real file total');}
try{
 await page.goto(origin);
 const login=await api('/auth/login','POST',{username:env.INIT_ADMIN_USERNAME,password:env.INIT_ADMIN_PASSWORD});
 csrf=login.csrfToken;secret.push(csrf);owner=login.user.id;assert.equal(login.user.role,'admin');
 const before=await metric();assert.ok(before.loginCount>=1&&before.lastLoginAt&&before.loginStatsSince);
 for(let i=0;i<3;i++)await api('/me');
 await api('/auth/login','POST',{username:env.INIT_ADMIN_USERNAME,password:'invalid-test-'+randomBytes(12).toString('hex')},401);
 const afterRead=await metric();assert.equal(afterRead.loginCount,before.loginCount);assert.equal(afterRead.lastLoginAt,before.lastLoginAt);
 pass('real administrator login recorded; session reads and rejected password do not increment statistics');
 const existing=(await api('/projects')).items.map(item=>[item.id,item.ownerId,item.name,item.currentReleaseId]).sort();
 project=await api('/projects','POST',{name});assert.match(project.id,/^[a-f0-9]{48}$/);
 const url=project.url;assert.equal(new URL(url).origin,'http://localhost:8080');
 await publish(1);
 const root=path.join(workspace,'.local','data','releases',project.id);
 const firstSize=filesSize(root);assert.ok(firstSize>40000);
 await stableBytes(before.storageBytes+firstSize);
 await publish(2);
 const secondSize=filesSize(root);assert.ok(secondSize>firstSize+80000,'Both retained versions must still occupy storage');
 const afterPublish=await stableBytes(before.storageBytes+secondSize);assert.equal(afterPublish.loginCount,before.loginCount);
 const publicPage=await context.newPage();try{await publicPage.goto(url);await publicPage.getByRole('heading',{name:'Stats 2',exact:true}).waitFor();}finally{await publicPage.close();}
 pass('real ZIP v1 and v2 usage equals the actual retained files, with the same public URL serving v2');
 await page.reload();await page.getByRole('button',{name:'成员管理',exact:true}).click();
 const row=page.locator('.members-table tbody tr').filter({hasText:env.INIT_ADMIN_USERNAME}).first();await row.waitFor();
 assert.equal(await row.locator('[data-label="登录次数"]').innerText(),`${before.loginCount.toLocaleString('zh-CN')} 次`);
 assert.equal(await row.locator('[data-label="最近登录"] time').getAttribute('datetime'),before.lastLoginAt);
 assert.match(await row.locator('[data-label="最近登录"] time').getAttribute('title'),/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
 assert.ok(await row.locator('[data-label="占用空间"]').getAttribute('title'));
 pass('live member table shows real storage, count and precise last-login tooltip after reload');
 await api('/projects/'+project.id,'DELETE');await stableBytes(before.storageBytes);
 assert.equal(existsSync(root),false);
 const remaining=(await api('/projects')).items.map(item=>[item.id,item.ownerId,item.name,item.currentReleaseId]).sort();
 assert.deepEqual(remaining,existing,'Existing projects and current releases must remain unchanged');
 report.success=true;report.cleanup=true;project=null;
 pass('deleting only the temporary project releases its bytes and preserves every pre-existing project');
}catch(error){let message=String(error?.stack||error);for(const value of secret)if(value)message=message.split(value).join('[redacted]');report.error=message;console.error(message);process.exitCode=1;}
finally{
 try{
  if(project){
   const detail=await api('/projects/'+project.id);assert.equal(detail.name,name);assert.equal(detail.ownerId,owner);
   for(let i=0;i<150;i++){
    const current=await api('/projects/'+project.id);
    if(!current.latestDeployment||['SUCCEEDED','FAILED'].includes(current.latestDeployment.status)){await api('/projects/'+project.id,'DELETE');report.cleanup=true;break;}
    await sleep(200);
   }
   assert.equal(report.cleanup,true,'Temporary project remains busy; cleanup incomplete');
  }
  if(owner)await api('/auth/logout','POST',{});
 }catch{report.cleanup=false;console.error('Local cleanup failed; inspect .local/member-stats-local-report.json');process.exitCode=1;}
 writeFileSync(path.join(output,'member-stats-local-report.json'),JSON.stringify(report,null,2));await browser.close();
}

// Real browser/ZIP validation, confined to a uniquely named local project.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {randomBytes} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
import {env,api,login} from './test-helpers.mjs';
const require=createRequire(new URL('../frontend/package.json',import.meta.url));
const {chromium}=require('playwright'),{zipSync,strToU8}=require('fflate');
assert.ok(!process.env.TEST_PORT||['8080','8081'].includes(process.env.TEST_PORT));
const admin='http://console.localhost:8080',publicOrigin='http://localhost:8080';
const name='Single HTML regression '+Date.now().toString(36)+' '+randomBytes(4).toString('hex');
const report={localOnly:true,success:false,cleanup:false,steps:[],errors:[]};mkdirSync('.local',{recursive:true});
let session,project,browser,before,task;
const pass=s=>{report.steps.push(s);console.log('PASS: '+s);};
const snapshot=items=>items.map(p=>({id:p.id,ownerId:p.ownerId,name:p.name,url:p.url,currentReleaseId:p.currentReleaseId})).sort((a,b)=>a.id.localeCompare(b.id));
const html=v=>`<!doctype html><html><head><meta charset="utf-8"><title>Standalone ${v}</title><style>body{font:20px system-ui;padding:24px}</style></head><body><h1>Standalone ${v}</h1><button id="counter">0</button><script>document.querySelector('#counter').onclick=function(){this.textContent=Number(this.textContent)+1}</script></body></html>`;
async function terminal(id){for(let i=0;i<240;i++){const r=await api('/deployments/'+id,'GET',undefined,session);if(['FAILED','SUCCEEDED'].includes(r.status))return r;await new Promise(r=>setTimeout(r,250));}throw Error('Local publication timed out');}
try{
 session=await login(env.INIT_ADMIN_USERNAME,env.INIT_ADMIN_PASSWORD);before=snapshot((await api('/projects','GET',undefined,session)).items);
 browser=await chromium.launch({channel:'chrome',headless:true});const context=await browser.newContext({viewport:{width:1280,height:900},serviceWorkers:'block',reducedMotion:'reduce'});
 const eq=session.cookie.indexOf('=');await context.addCookies([{name:session.cookie.slice(0,eq),value:session.cookie.slice(eq+1),domain:'console.localhost',path:'/',httpOnly:true,secure:false,sameSite:'Lax'}]);
 await context.route('**/*',r=>[admin,publicOrigin].includes(new URL(r.request().url()).origin)?r.continue():r.abort());
 const page=await context.newPage();page.on('pageerror',e=>report.errors.push(e.message));page.setDefaultTimeout(15000);
 async function preview(v){const p=await context.newPage();p.on('pageerror',e=>report.errors.push(e.message));try{const r=await p.goto(project.url);assert.equal(r.status(),200);await p.getByRole('heading',{name:'Standalone '+v,exact:true}).waitFor();await p.locator('#counter').click();assert.equal(await p.locator('#counter').textContent(),'1');}finally{await p.close();}}
 await page.goto(admin);await page.getByRole('button',{name:/创建项目/}).first().click();let modal=page.getByRole('dialog');await modal.getByLabel('项目名称',{exact:true}).fill(name);
 await modal.getByLabel('选择原型文件或 ZIP',{exact:true}).setInputFiles({name:'prototype.html',mimeType:'text/html',buffer:Buffer.from(html('v1'))});
 await modal.getByText('文件已选好',{exact:true}).waitFor();await modal.getByText('prototype.html',{exact:true}).waitFor();assert.ok(await modal.getByRole('button',{name:'创建并发布',exact:true}).isEnabled());
 await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:'.local/single-html-mobile-selected.png'});await page.setViewportSize({width:1280,height:900});
 const created=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1/projects'&&r.request().method()==='POST');await modal.getByRole('button',{name:'创建并发布',exact:true}).click();project=await (await created).json();assert.equal(new URL(project.url).origin,publicOrigin);await modal.getByRole('heading',{name:'发布成功。',exact:true}).waitFor({timeout:60000});await preview('v1');await modal.getByRole('button',{name:'完成',exact:true}).click();
 pass('actual file picker accepts prototype.html; browser packs/uploads it and the root share URL renders interactive v1');
 async function update(file,v){await page.locator('article.project').filter({has:page.getByRole('heading',{name,exact:true})}).getByRole('button',{name:'发布更新',exact:true}).click();modal=page.getByRole('dialog');await modal.getByLabel('选择原型文件或 ZIP',{exact:true}).setInputFiles(file);await modal.getByText('文件已选好',{exact:true}).waitFor();await modal.getByRole('button',{name:'发布更新',exact:true}).click();await page.getByRole('dialog',{name:'更新成功',exact:true}).waitFor({timeout:60000});await preview(v);await page.getByRole('dialog').getByRole('button',{name:'完成',exact:true}).click();}
 await update({name:'产品原型.HTML',mimeType:'text/html',buffer:Buffer.from(html('v2'))},'v2');pass('updating with a Unicode filename and uppercase HTML extension keeps the share URL and serves v2');
 await update({name:'single-page.zip',mimeType:'application/zip',buffer:Buffer.from(zipSync({'export/prototype.htm':strToU8(html('v3'))}))},'v3');pass('ZIP containing a single arbitrarily named HTML under a wrapper directory is normalized and serves v3');
 task=await api('/projects/'+project.id+'/deployments','POST',{},session);await api('/deployments/'+task.id+'/archive','PUT',Buffer.from(zipSync({'one.html':strToU8(html('bad')),'two.html':strToU8(html('bad'))})),session,202);const result=await terminal(task.id);assert.equal(result.status,'FAILED');task=null;await preview('v3');pass('ambiguous multi-page ZIP is rejected and the previous published v3 remains usable');
 assert.deepEqual(report.errors,[]);assert.equal((await api('/projects/'+project.id,'GET',undefined,session)).url,project.url);report.success=true;
}catch(e){let message=String(e.stack||e);for(const secret of [env.INIT_ADMIN_PASSWORD,session?.cookie,session?.csrf])if(secret)message=message.split(secret).join('[redacted]');report.error=message;console.error(message);process.exitCode=1;}
finally{
 try{if(task)await terminal(task.id);if(project){const p=await api('/projects/'+project.id,'GET',undefined,session);assert.equal(p.name,name);assert.equal(p.ownerId,session.user.id);await api('/projects/'+p.id,'DELETE',undefined,session);}if(before)assert.deepEqual(snapshot((await api('/projects','GET',undefined,session)).items),before);if(session)await api('/auth/logout','POST',undefined,session);report.cleanup=true;}catch{report.cleanupError='Temporary project cleanup or existing-project snapshot check failed';process.exitCode=1;}
 await browser?.close();writeFileSync('.local/single-html-report.json',JSON.stringify(report,null,2));
}

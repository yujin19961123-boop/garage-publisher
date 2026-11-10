// Local-only UI acceptance. Changes and deletes only one randomly named test project.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,unlinkSync} from 'node:fs';
import {createRequire} from 'node:module';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const require=createRequire(new URL('../frontend/package.json',import.meta.url));
const {chromium}=require('playwright'),origin='http://console.localhost:8080';
const output=fileURLToPath(new URL('../.local/',import.meta.url));mkdirSync(output,{recursive:true});
const env=Object.fromEntries(readFileSync(new URL('../.env',import.meta.url),'utf8').split(/\r?\n/).filter(l=>/^[A-Z_]+=/.test(l)).map(l=>{const n=l.indexOf('=');return [l.slice(0,n),l.slice(n+1).replace(/^(['"])(.*)\1$/,'$2')];}));
const suffix=randomBytes(6).toString('hex');
const names=['Inline name acceptance '+suffix,...[1,2,3,4,5].map(n=>'项目名称验收'+n+' '+suffix)];
const report={localOnly:true,success:false,cleanup:false,steps:[]};
let browser,page,project,owner,csrf='',releaseResponse,patches=0;
const pass=s=>{report.steps.push(s);console.log('PASS: '+s);};
async function api(route,method='GET',body){return page.evaluate(async({route,method,body,csrf})=>{const res=await fetch('/api/v1'+route,{method,headers:{'Content-Type':'application/json',...(csrf?{'X-CSRF-Token':csrf}:{})},body:body===undefined?undefined:JSON.stringify(body)});const data=await res.json();if(!res.ok)throw Error(data.message||'Local API failed');return data;},{route,method,body,csrf});}
async function open(name){const card=page.locator('article').filter({has:page.getByRole('heading',{name,exact:true})});await card.getByRole('button',{name:/首次发布|查看详情/}).click();await page.getByRole('dialog').waitFor();}
async function edit(name,value){await page.getByRole('heading',{name,exact:true}).getByRole('button').click();const input=page.getByRole('textbox',{name:'项目名称',exact:true});await input.fill(value);return input;}
async function title(name){await page.getByRole('heading',{name,exact:true}).getByRole('button').waitFor();assert.equal((await api('/projects/'+project.id)).name,name);}
try{
 browser=await chromium.launch({channel:'chrome',headless:true});const context=await browser.newContext({viewport:{width:1280,height:960}});
 await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
 page=await context.newPage();page.on('request',r=>{if(r.method()==='PATCH')patches++;});await page.goto(origin);
 const login=await api('/auth/login','POST',{username:env.INIT_ADMIN_USERNAME,password:env.INIT_ADMIN_PASSWORD});csrf=login.csrfToken;owner=login.user.id;
 project=await api('/projects','POST',{name:names[0]});writeFileSync(output+'inline-name-fixture.json',JSON.stringify({id:project.id,owner,names}));await page.reload();await open(names[0]);
 assert.equal(await page.getByRole('button',{name:'编辑名称',exact:true}).count(),0);assert.equal(await page.getByRole('button',{name:'保存修改',exact:true}).count(),0);
 await edit(names[0],names[1]);await page.getByRole('dialog').getByRole('heading',{name:'首次发布',exact:true}).click();await title(names[1]);assert.equal((await api('/projects/'+project.id)).url,project.url);
 await edit(names[1],names[1]);await page.getByRole('dialog').getByRole('heading',{name:'首次发布',exact:true}).click();await title(names[1]);assert.equal(patches,1,'Unchanged names must not send PATCH');
 const enter=await edit(names[1],names[2]);await enter.press('Enter');await title(names[2]);
 const cancel=await edit(names[2],'discarded');await cancel.press('Escape');await title(names[2]);assert.ok(await page.getByRole('dialog').isVisible());assert.equal(patches,2);
 const empty=await edit(names[2],'   ');await page.getByRole('dialog').getByRole('heading',{name:'首次发布',exact:true}).click();await page.getByRole('alert').filter({hasText:'项目名称不能为空'}).waitFor();assert.equal(await empty.inputValue(),'   ');assert.equal(patches,2);await empty.press('Escape');
 pass('click title, blur and Enter persist; unchanged input skips request; Escape cancels and empty names are retained with feedback');
 await page.route(origin+'/api/v1/projects/'+project.id,async route=>{if(route.request().method()==='PATCH')return route.fulfill({status:503,contentType:'application/json',body:'{"message":"模拟保存失败"}'});return route.fallback();},{times:1});
 const failed=await edit(names[2],names[3]);await page.getByRole('dialog').getByRole('heading',{name:'首次发布',exact:true}).click();await page.getByRole('alert').filter({hasText:'模拟保存失败'}).waitFor();assert.equal(await failed.inputValue(),names[3]);assert.equal((await api('/projects/'+project.id)).name,names[2]);await failed.focus();await page.getByRole('dialog').getByRole('heading',{name:'首次发布',exact:true}).click();await title(names[3]);
 pass('save failure retains the draft and blur retries successfully without changing the share URL');
 let held=false;const before=patches;
 await page.route(origin+'/api/v1/projects/'+project.id,async route=>{if(route.request().method()!=='PATCH')return route.fallback();held=true;await new Promise(resolve=>{releaseResponse=resolve;});await route.continue();},{times:1});
 await edit(names[3],names[4]);await page.getByRole('button',{name:'关闭弹窗',exact:true}).click();
 for(let n=0;n<100&&!held;n++)await new Promise(r=>setTimeout(r,20));assert.ok(held);assert.ok(await page.getByRole('dialog').isVisible());assert.equal(patches,before+1,'Blur and close must share one save request');releaseResponse();releaseResponse=null;await page.getByRole('dialog').waitFor({state:'hidden'});assert.equal((await api('/projects/'+project.id)).name,names[4]);
 await open(names[4]);await edit(names[4],names[5]);await page.mouse.click(4,4);await page.getByRole('dialog').waitFor({state:'hidden'});assert.equal((await api('/projects/'+project.id)).name,names[5]);
 pass('closing or clicking outside waits for the same pending save and preserves the edited title');
 await page.setViewportSize({width:390,height:844});await open(names[5]);const heading=page.getByRole('dialog').getByRole('heading',{name:names[5],exact:true});const height=(await heading.boundingBox()).height;const mobile=await edit(names[5],names[5]);assert.ok((await page.locator('.project-name-heading').boundingBox()).height<=height+8,'Inline edit must not add a separate form row');assert.ok(await page.getByRole('dialog').evaluate(e=>e.scrollWidth<=e.clientWidth));await mobile.press('Escape');await page.screenshot({path:output+'inline-name-mobile.png',animations:'disabled'});await page.getByRole('button',{name:'关闭弹窗',exact:true}).click();
 await page.route(origin+'/api/v1/projects',async route=>{const p=await api('/projects/'+project.id);await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({items:[{...p,ownerId:'different-owner'}]})});});
 await page.reload();await open(names[5]);const foreign=page.getByRole('dialog').getByRole('heading',{name:names[5],exact:true});assert.equal(await foreign.getByRole('button').count(),0);await foreign.click();assert.equal(await page.getByRole('textbox',{name:'项目名称',exact:true}).count(),0);
 pass('mobile edit uses the title row and another owner’s title remains read-only');report.success=true;
}catch(e){let error=String(e.stack||e);if(env.INIT_ADMIN_PASSWORD)error=error.split(env.INIT_ADMIN_PASSWORD).join('[REDACTED]');report.error=error;process.exitCode=1;console.error(error);}
finally{
 releaseResponse?.();
 try{if(project){const current=await api('/projects/'+project.id);assert.equal(current.ownerId,owner);assert.ok(names.includes(current.name));await api('/projects/'+project.id,'DELETE');report.cleanup=true;unlinkSync(output+'inline-name-fixture.json');}if(csrf)await api('/auth/logout','POST',{});}catch(e){report.cleanupError=e.message;report.success=false;process.exitCode=1;}
 writeFileSync(output+'inline-name-result.json',JSON.stringify(report,null,2));await browser?.close();
}

// Frontend-only local acceptance. EVERY /api/ request is fulfilled or aborted
// here, including simulated POSTs. No credentials, accounts, projects or DB writes.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdirSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const require=createRequire(new URL('../frontend/package.json',import.meta.url));
const {chromium}=require('playwright');
const ORIGIN='http://console.localhost:8080';
for(const key of ['VERSION_UI_URL','BASE_URL','UI_BASE_URL'])if(process.env[key])assert.equal(new URL(process.env[key]).origin,ORIGIN,'This mock accepts only the fixed local console origin.');
const output=fileURLToPath(new URL('../.local/',import.meta.url));mkdirSync(output,{recursive:true});
const report={mode:'frontend API mock only',localOnly:true,databaseWrites:false,apiRequestsForwarded:false,apiRequests:[],blockedRequests:[],pageErrors:[],consoleErrors:[],steps:[],screenshots:[],success:false};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const pass=step=>{report.steps.push(step);console.log('PASS [UI MOCK / databaseWrites:false]: '+step);};
let browser,releasePending;
async function installMocks(context,foreign=false){
 const state={current:2,activation:'hold',getFailures:false,versionReads:0,historyReads:0,activationCount:0,unknown:[]};
 const user={id:'mock-owner',username:'本地界面验收',role:foreign?'admin':'member',status:'active'};
 const now='2026-11-10T08:00:00Z';
 const project=()=>({id:'mock-version-project',name:'版本交互演示（纯界面模拟）',ownerId:foreign?'different-owner':user.id,status:'published',url:'http://localhost:8080/mock-ui-version/',lastPublishedAt:now,currentReleaseId:'release-'+state.current,currentVersionNumber:state.current,latestDeployment:{id:'mock-task-2',status:foreign?'QUEUED':'SUCCEEDED'}});
 const versionItems=()=>[2,1].map(n=>({id:'release-'+n,versionNumber:n,createdAt:now,isCurrent:n===state.current,canActivate:n!==state.current,filesState:'available'}));
 const logs=()=>Array.from({length:23},(_,index)=>({id:'mock-log-'+index,status:index<2?'SUCCEEDED':'FAILED',errorMessage:index===2?'长错误记录_'+('abcdefghijklmno'.repeat(120)):index>2?'模拟上传失败':'',createdAt:now,updatedAt:now,releaseId:index<2?'release-'+(2-index):null,versionNumber:index<2?2-index:null,filesState:index<2?'available':null,isCurrent:index<2&&2-index===state.current}));
 await context.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());
  if(url.origin!==ORIGIN){report.blockedRequests.push(url.href);await route.abort('blockedbyclient');return;}
  if(!url.pathname.startsWith('/api/')){
   if(request.method()!=='GET'){report.blockedRequests.push(request.method()+' '+url.href);await route.abort('blockedbyclient');return;}
   await route.continue();return;
  }
  report.apiRequests.push({method:request.method(),path:url.pathname+url.search,foreign,forwarded:false});
  const respond=(value,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)});
  if(url.pathname==='/api/v1/me')return respond({user,csrfToken:'mock-no-real-session'});
  if(url.pathname==='/api/v1/platform-config')return respond({maxUploadBytes:104857600,maxExpandedBytes:524288000,maxFiles:10000});
  if(url.pathname==='/api/v1/projects'&&request.method()==='GET')return respond({items:[project()]});
  if(url.pathname==='/api/v1/projects/mock-version-project'&&request.method()==='GET')return respond(project());
  if(url.pathname==='/api/v1/projects/mock-version-project/versions'&&request.method()==='GET'){
   state.versionReads++;
   if(state.getFailures)return respond({message:'模拟版本服务暂不可用'},503);
   return respond({items:versionItems(),currentReleaseId:'release-'+state.current,busy:false,cleanupPending:false,retentionLimit:5});
  }
  if(url.pathname==='/api/v1/projects/mock-version-project/deployments'&&request.method()==='GET'){
   state.historyReads++;
   if(state.getFailures)return respond({message:'模拟记录服务暂不可用'},503);
   const offset=url.searchParams.has('cursor')?20:0;
   return respond({items:logs().slice(offset,offset+20),nextCursor:offset===0?'mock-next-page':null});
  }
  const activation=url.pathname.match(/^\/api\/v1\/projects\/mock-version-project\/versions\/release-(1|2)\/activate$/);
  if(activation&&request.method()==='POST'){
   const payload=request.postDataJSON();
   assert.equal(payload.expectedCurrentReleaseId,'release-'+state.current,'Expected-current protection must be present in UI request.');
   state.activationCount++;
   const next=Number(activation[1]);
   if(state.activation==='hold')await new Promise(resolve=>{releasePending=resolve;});
   state.current=next;
   if(state.activation==='abort'){await route.abort('failed');return;}
   return respond({ok:true,currentReleaseId:'release-'+next,currentVersionNumber:next,lastPublishedAt:now});
  }
  state.unknown.push(request.method()+' '+url.pathname);
  // Unknown mutations are also fulfilled locally, never forwarded to the API.
  return respond({message:'Unexpected mocked API route'},404);
 });
 return state;
}
async function until(check,message){for(let i=0;i<80;i++){if(await check())return;await pause(50);}assert.fail(message);}
async function openDetails(page){
 await page.locator('.project').getByRole('button',{name:/发布更新|查看详情/}).click();
 const dialog=page.getByRole('dialog',{name:'项目详情'});await dialog.waitFor();return dialog;
}
async function openVersions(page){
 await page.locator('.project').getByRole('button',{name:'版本管理',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'版本管理',exact:true});await dialog.waitFor();
 assert.equal(await dialog.getByTestId('version-history-toggle').count(),0,'Version modal should load automatically.');
 await until(async()=>await dialog.locator('.version-item').count()===2&&await dialog.getByRole('button',{name:'刷新版本记录',exact:true}).isEnabled(),'Version mocks did not load.');
 return dialog;
}
async function noHistoryInPublication(dialog){
 assert.equal(await dialog.getByTestId('version-history').count(),0,'Publication dialog must not contain version history.');
 assert.equal(await dialog.getByTestId('version-history-toggle').count(),0);
 assert.equal(await dialog.getByRole('button',{name:/切换到 v/}).count(),0,'Publication dialog must not expose rollback controls.');
}
async function confirmVersion(page,number){
 await page.getByRole('button',{name:'切换到 v'+number,exact:true}).click();
 await page.getByRole('group',{name:'确认切换版本'}).waitFor();
 await page.getByRole('button',{name:'确认切换',exact:true}).click();
}
async function shot(page,filename){await page.screenshot({path:path.join(output,filename),fullPage:false});report.screenshots.push(filename);}
let failure;
try{
 browser=await chromium.launch({channel:'chrome',headless:true});
 const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce',serviceWorkers:'block'});
 const state=await installMocks(context),page=await context.newPage();page.setDefaultTimeout(12000);
 page.on('pageerror',error=>report.pageErrors.push(error.message));
 page.on('console',message=>{if(message.type()==='error')report.consoleErrors.push(message.text());});
 await page.goto(ORIGIN,{waitUntil:'networkidle'});
 let dialog=await openDetails(page);
 await noHistoryInPublication(dialog);
 await dialog.locator('button.close').click();
 dialog=await openVersions(page);
 assert.equal(await dialog.locator('.file-selection,input[type="file"]').count(),0);
 assert.equal(await dialog.getByRole('button',{name:'删除项目',exact:true}).count(),0);
 pass('publication and version management use independent dialogs; versions load automatically');
 await confirmVersion(page,1);
 await until(()=>state.activationCount===1,'Activation POST was not intercepted.');
 assert.equal(await dialog.getByRole('button',{name:/发布更新|上传并发布/}).count(),0);
 assert.equal(await dialog.getByRole('button',{name:'删除项目',exact:true}).count(),0);
 assert.ok(await dialog.locator('button.close').isDisabled());
 assert.equal(await dialog.locator('.file-selection,input[type="file"]').count(),0);
 assert.ok(await page.getByRole('button',{name:'正在切换…',exact:true}).isDisabled());
 await page.keyboard.press('Escape');assert.ok(await dialog.isVisible());
 assert.ok(await page.getByRole('group',{name:'确认切换版本'}).isVisible());
 await shot(page,'versions-ui-mock-pending.png');
 pass('pending simulated POST keeps upload/delete absent and locks close, duplicate confirmation and Escape');
 releasePending();releasePending=null;
 await until(async()=>(await dialog.locator('.version-item.is-current .version-meta > strong').innerText())==='v1','Successful mock activation did not update the current version.');
 await until(async()=>(await dialog.locator('.current-version-label').innerText())==='当前版本 v1','Version modal header did not synchronize after activation.');
 await until(async()=>await dialog.locator('button.close').isEnabled(),'Dialog remained locked after success.');

 state.activation='abort';
 await confirmVersion(page,2);
 await until(async()=>(await dialog.locator('.version-item.is-current .version-meta > strong').innerText())==='v2','Lost-response reconciliation did not synchronize current version.');
 await until(async()=>(await dialog.locator('.current-version-label').innerText())==='当前版本 v2','Lost-response reconciliation did not synchronize the version modal header.');
 await until(async()=>await page.getByRole('button',{name:'刷新版本记录',exact:true}).isEnabled(),'Lost-response flow remained locked.');
 assert.match(await page.locator('.version-item.is-current').innerText(),/v2/);
 assert.ok(await page.getByRole('status').filter({hasText:'已确认当前为 v2'}).count());
 await dialog.locator('button.close').click();
 dialog=await openDetails(page);assert.equal(await dialog.locator('.link-panel,.current-version-label').count(),0,'Publication must not repeat sharing or version information.');
 await noHistoryInPublication(dialog);await dialog.locator('button.close').click();
 dialog=await openVersions(page);assert.match(await dialog.locator('.version-item.is-current').innerText(),/v2/);
 pass('simulated committed POST with lost response is discovered by GET and synchronizes detail, list and reopened project');

 state.getFailures=true;
 await page.getByRole('button',{name:'刷新版本记录',exact:true}).click();
 await page.getByRole('alert').filter({hasText:'已显示的记录会保留'}).waitFor();
 assert.equal(await page.locator('.version-item').count(),2);assert.equal(await page.locator('.version-log > li').count(),20);
 state.getFailures=false;
 await page.getByRole('button',{name:'刷新版本记录',exact:true}).click();
 await until(async()=>await page.getByRole('alert').count()===0&&await page.getByRole('button',{name:'刷新版本记录',exact:true}).isEnabled(),'503 recovery failed.');
 await page.getByRole('button',{name:'加载更多记录',exact:true}).click();
 await until(async()=>await page.locator('.version-log > li').count()===23,'Mock cursor pagination failed.');
 pass('503s preserve displayed versions/logs; refresh recovers and cursor loads more records');

 await page.getByRole('button',{name:'切换到 v1',exact:true}).click();
 await page.keyboard.press('Escape');
 assert.ok(await dialog.isVisible());assert.equal(await page.getByRole('group',{name:'确认切换版本'}).count(),0);
 pass('Escape cancels inline confirmation without closing version management');

 const reads={versions:state.versionReads,history:state.historyReads};await pause(800);
 assert.equal(state.versionReads,reads.versions);assert.equal(state.historyReads,reads.history);
 pass('settled refresh and reconciliation do not loop API fetches');
 for(const width of [390,320]){
  await page.setViewportSize({width,height:844});
  await page.locator('.version-log-error').first().scrollIntoViewIfNeeded();
  const metrics=await page.evaluate(()=>({width:innerWidth,page:document.documentElement.scrollWidth,dialog:[...document.querySelectorAll('.modal,.version-history,.version-log')].map(element=>({className:element.className,client:element.clientWidth,scroll:element.scrollWidth}))}));
  assert.ok(metrics.page<=width+1,'Page overflows at '+width);
  assert.ok(metrics.dialog.every(item=>item.scroll<=item.client+1),'Long records overflow the modal at '+width);
  report['layout'+width]=metrics;await shot(page,'versions-ui-mock-'+width+'.png');
 }
 pass('390px and 320px long-record layouts stay within page and modal bounds');

 const outsiderContext=await browser.newContext({viewport:{width:390,height:844},reducedMotion:'reduce',serviceWorkers:'block'});
 const outsider=await installMocks(outsiderContext,true),other=await outsiderContext.newPage();
 await other.goto(ORIGIN,{waitUntil:'networkidle'});
 assert.equal(await other.getByRole('button',{name:'版本管理',exact:true}).count(),0);
 const readonlyDialog=await openDetails(other);assert.ok(await readonlyDialog.locator('button.close').isEnabled(),'Another owner’s active task must not lock this read-only dialog.');
 assert.equal(await other.getByRole('button',{name:'版本管理',exact:true}).count(),0);
 assert.equal(await other.getByTestId('version-history-toggle').count(),0);
 assert.equal(await other.getByRole('button',{name:'删除项目',exact:true}).count(),0);
 assert.equal(outsider.versionReads,0);assert.equal(outsider.historyReads,0);await readonlyDialog.locator('button.close').click();await readonlyDialog.waitFor({state:'hidden'});
 pass('administrator inspecting another owner sees neither version controls nor delete entry');
 assert.equal(state.unknown.length,0);assert.equal(outsider.unknown.length,0);
 assert.equal(report.blockedRequests.length,0);assert.equal(report.pageErrors.length,0);
 report.success=true;
}catch(error){failure=error;report.failure=error.message;}
finally{
 if(releasePending)releasePending();
 if(browser)await browser.close();
 writeFileSync(path.join(output,'versions-ui-mock-result.json'),JSON.stringify(report,null,2));
}
if(failure){console.error('FAIL [UI MOCK]: '+failure.message);process.exitCode=1;}

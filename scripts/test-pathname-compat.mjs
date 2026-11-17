// Local-only real ZIP regression plus read-only verification of an existing URL.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdirSync,writeFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {env,api,login,zip} from './test-helpers.mjs';
const require=createRequire(new URL('../frontend/package.json',import.meta.url));
const {chromium}=require('playwright');
assert.ok(!process.env.TEST_PORT||['8080','8081'].includes(process.env.TEST_PORT));
const origin='http://localhost:8080',existingPath=process.argv[2];
if(existingPath)assert.match(existingPath,/^\/[a-z0-9-]+\/pages\/owned\/$/);
mkdirSync('.local',{recursive:true});
const report={localOnly:true,success:false,cleanup:false,steps:[],errors:[],failedResources:[]};
const pass=message=>{report.steps.push(message);console.log('PASS: '+message);};
let browser,session,project,task,before;
const name='Pathname regression '+Date.now().toString(36)+' '+randomBytes(4).toString('hex');
const snapshot=items=>items.map(p=>({id:p.id,name:p.name,ownerId:p.ownerId,url:p.url,currentReleaseId:p.currentReleaseId})).sort((a,b)=>a.id.localeCompare(b.id));
async function terminal(id){for(let i=0;i<240;i++){const state=await api('/deployments/'+id,'GET',undefined,session);if(['FAILED','SUCCEEDED'].includes(state.status))return state;await new Promise(r=>setTimeout(r,250));}throw Error('Local deployment timeout');}
function archive(version){return zip({
 'index.html':'<!doctype html><title>Index</title><a href="./pages/owned/">Owned</a>',
 'pages/desktop/index.html':'<!doctype html><title>Desktop</title><iframe data-desktop-app-frame></iframe><p id="loading">Loading</p><script src="../../src/desktop.js"></script>',
 'src/desktop-entry.js':`if(!window.frameElement?.hasAttribute('data-desktop-app-frame')){const destination=new URL('/pages/desktop/',location.href);destination.searchParams.set('page',location.pathname+location.search+location.hash);location.replace(destination.href);}`,
 'src/desktop.js':`const frame=document.querySelector('iframe');function pageURL(value){const url=new URL(value,location.href),match=url.pathname.match(/^\\/pages\\/([a-z0-9-]+)(?:\\/(?:index\\.html)?)?$/);return url.origin===location.origin&&match&&!['desktop'].includes(match[1])?url:null}const initial=pageURL(new URLSearchParams(location.search).get('page'))||new URL('/pages/owned/',location.href);frame.addEventListener('load',()=>{if(frame.contentWindow.location.href==='about:blank')return;const url=pageURL(frame.contentWindow.location.href);if(!url){location.assign(frame.contentWindow.location.href);return}const outer=new URL(location.href);outer.searchParams.set('page',url.pathname+url.search+url.hash);history.replaceState(null,'',outer);document.title=frame.contentDocument.title;document.querySelector('#loading').hidden=true;});frame.src=initial.href;`,
 'pages/owned/index.html':`<!doctype html><script src="../../src/desktop-entry.js"></script><title>Owned ${version}</title><h1>Owned ${version}</h1><a href="../following/">Following</a>`,
 'pages/following/index.html':`<!doctype html><script src="../../src/desktop-entry.js"></script><title>Following ${version}</title><h1>Following ${version}</h1><a href="../owned/">Owned</a>`
});}
async function deploy(version){task=await api('/projects/'+project.id+'/deployments','POST',{routeMode:'static'},session);await api('/deployments/'+task.id+'/archive','PUT',archive(version),session,202);const result=await terminal(task.id);assert.equal(result.status,'SUCCEEDED',result.errorMessage);task=null;}
async function context(){const c=await browser.newContext({viewport:{width:1366,height:900},serviceWorkers:'block'});await c.route('**/*',route=>{const request=route.request();return new URL(request.url()).origin===origin&&['GET','HEAD'].includes(request.method())?route.continue():route.abort();});return c;}
function track(page){page.on('pageerror',e=>report.errors.push(e.message));page.on('response',r=>{if(r.status()>=400)report.failedResources.push({url:r.url(),status:r.status()});});}
async function stable(page){let count=0;const listener=()=>count++;page.on('framenavigated',listener);await page.waitForTimeout(1600);page.off('framenavigated',listener);assert.equal(count,0,'Unexpected frame navigation loop');}
try{
 browser=await chromium.launch({channel:'chrome',headless:true});
 if(existingPath){
  const c=await context(),page=await c.newPage();track(page);
  await page.goto(origin+existingPath,{waitUntil:'networkidle'});
  await page.waitForFunction(()=>document.querySelector('.desktop-load-status')?.hidden===true);
  assert.match(await page.title(),/Owned/i);await stable(page);
  const frame=page.frameLocator('iframe[data-desktop-app-frame]');
  await frame.getByText('Assigned to me',{exact:true}).first().waitFor();
  await page.screenshot({path:'.local/teletask-owned-fixed.png'});
  await frame.locator('button[data-view="Subscribed"]').click();
  // This prototype changes its content view without changing the URL/title.
  await frame.getByText('Following',{exact:true}).nth(1).waitFor();
  await stable(page);await page.screenshot({path:'.local/teletask-following-fixed.png'});
  await page.reload({waitUntil:'networkidle'});
  await page.waitForFunction(()=>document.querySelector('.desktop-load-status')?.hidden===true);
  await stable(page);
  await c.close();pass('existing teletask opens without reupload; Following content view and deep-link refresh are stable');
 }
 session=await login(env.INIT_ADMIN_USERNAME,env.INIT_ADMIN_PASSWORD);
 before=snapshot((await api('/projects','GET',undefined,session)).items);
 project=await api('/projects','POST',{name},session);assert.equal(new URL(project.url).origin,origin);
 await deploy('v1');
 const c=await context(),page=await c.newPage();track(page);
 await page.goto(project.url+'pages/owned/',{waitUntil:'networkidle'});
 const frame=page.frameLocator('iframe[data-desktop-app-frame]');
 await frame.getByRole('heading',{name:'Owned v1'}).waitFor();await page.locator('#loading').waitFor({state:'hidden'});await stable(page);
 await frame.getByRole('link',{name:'Following',exact:true}).click();
 await frame.getByRole('heading',{name:'Following v1'}).waitFor();await stable(page);
 assert.ok(new URL(page.url()).searchParams.get('page').endsWith('/pages/following/'));
 await page.reload({waitUntil:'networkidle'});await frame.getByRole('heading',{name:'Following v1'}).waitFor();await stable(page);
 pass('actual ZIP passes upload adaptation; iframe navigation, regex capture and refreshed deep link remain correct');
 await deploy('v2');
 assert.equal((await api('/projects/'+project.id,'GET',undefined,session)).url,project.url);
 await page.reload({waitUntil:'networkidle'});await frame.getByRole('heading',{name:'Following v2'}).waitFor();await stable(page);
 pass('second ZIP updates the same share URL to v2 without loops');
 await c.close();assert.deepEqual(report.errors,[]);assert.deepEqual(report.failedResources,[]);report.success=true;
}catch(error){let message=String(error.stack||error);for(const secret of [env.INIT_ADMIN_PASSWORD,session?.cookie,session?.csrf])if(secret)message=message.split(secret).join('[redacted]');report.error=message;console.error(message);process.exitCode=1;}
finally{
 try{if(task)await terminal(task.id);if(project){const p=await api('/projects/'+project.id,'GET',undefined,session);assert.equal(p.name,name);assert.equal(p.ownerId,session.user.id);await api('/projects/'+p.id,'DELETE',undefined,session);}if(before)assert.deepEqual(snapshot((await api('/projects','GET',undefined,session)).items),before);if(session)await api('/auth/logout','POST',undefined,session);report.cleanup=true;}catch(e){report.cleanupError='Temporary fixture cleanup or existing-project snapshot failed';process.exitCode=1;}
 await browser?.close();writeFileSync('.local/pathname-compat-report.json',JSON.stringify(report,null,2));
}

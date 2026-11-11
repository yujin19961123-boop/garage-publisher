// Local real-artifact regression. Creates/deletes only a uniquely named project.
import assert from 'node:assert/strict';
import {readFileSync,readdirSync,writeFileSync,mkdirSync} from 'node:fs';
import {createRequire} from 'node:module';
import {createHash,randomBytes} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {env,api,login} from './test-helpers.mjs';
const require=createRequire(new URL('../frontend/package.json',import.meta.url));
const{chromium}=require('playwright'),{zipSync}=require('fflate');
assert.ok(process.env.ORIGINAL_DIST_DIR,'Set ORIGINAL_DIST_DIR to the original export, not an existing published directory.');
assert.ok(['8080','8081'].includes(process.env.TEST_PORT||'8081'),'Only local service ports are supported.');
const source=path.resolve(process.env.ORIGINAL_DIST_DIR),files={};
assert.ok(readFileSync(path.join(source,'index.html'),'utf8').includes('teleMail'),'This regression expects the teleMail export.');
function collect(dir){for(const entry of readdirSync(dir,{withFileTypes:true})){
 const file=path.join(dir,entry.name);if(entry.isSymbolicLink())throw Error('Source links are not accepted');
 if(entry.isDirectory())collect(file);else{assert.ok(!entry.name.startsWith('.'),'Hidden files are not accepted');files['dist/'+path.relative(source,file).split(path.sep).join('/')]=readFileSync(file);}
}}
collect(source);const archive=zipSync(files,{level:6});
const archiveHash=createHash('sha256').update(archive).digest('hex');
const output=fileURLToPath(new URL('../.local/',import.meta.url));mkdirSync(output,{recursive:true});
const name='Mobile hash regression '+Date.now().toString(36)+' '+randomBytes(4).toString('hex');
const report={localOnly:true,success:false,cleanup:false,steps:[],archiveSha256:archiveHash,files:Object.keys(files).length,pageErrors:[]};
let session,project,browser,task,existing;
const pass=message=>{report.steps.push(message);console.log('PASS: '+message);};
const snapshot=items=>items.map(p=>({id:p.id,ownerId:p.ownerId,name:p.name,url:p.url,currentReleaseId:p.currentReleaseId})).sort((a,b)=>a.id.localeCompare(b.id));
async function terminal(id){for(let i=0;i<240;i++){const d=await api('/deployments/'+id,'GET',undefined,session);if(['SUCCEEDED','FAILED'].includes(d.status))return d;await new Promise(r=>setTimeout(r,250));}throw Error('Temporary publication did not finish');}
try{
 session=await login(env.INIT_ADMIN_USERNAME,env.INIT_ADMIN_PASSWORD);
 existing=snapshot((await api('/projects','GET',undefined,session)).items);
 project=await api('/projects','POST',{name},session);assert.equal(new URL(project.url).origin,'http://localhost:8080');
 task=await api('/projects/'+project.id+'/deployments','POST',{},session);
 await api('/deployments/'+task.id+'/archive','PUT',Buffer.from(archive),session,202);
 const result=await terminal(task.id);assert.equal(result.status,'SUCCEEDED',result.errorMessage);task=null;
 pass('original export published without manual changes through the repaired upload pipeline');
 browser=await chromium.launch({channel:'chrome',headless:true});
 const context=await browser.newContext({viewport:{width:1156,height:1004},serviceWorkers:'block'});
 await context.route('**/*',route=>{const req=route.request(),url=new URL(req.url());return url.origin==='http://localhost:8080'&&['GET','HEAD'].includes(req.method())?route.continue():route.abort();});
 const page=await context.newPage();page.on('pageerror',e=>report.pageErrors.push(e.message));
 const failures=[];page.on('response',r=>{if(r.status()>=400&&/\.(?:js|css)(?:[?#]|$)/.test(r.url()))failures.push(r.status());});
 await page.goto(project.url+'#mobile',{waitUntil:'networkidle'});
 const frame=page.frameLocator('iframe.mobile-prototype-frame');
 await frame.getByRole('button',{name:'App',exact:true}).click();
 await frame.getByRole('heading',{name:'Apps',exact:true}).waitFor();
 assert.match(page.url(),/#mobile\/im\/apps/);
 await frame.getByText('Quick Links',{exact:true}).waitFor();
 await page.waitForLoadState('networkidle');
 assert.ok(await frame.locator('img').evaluateAll(nodes=>nodes.some(n=>n.src.includes('/mobile/im/apps/'))),'App assets must be present after the loading screen.');
 assert.equal(await frame.locator('img').evaluateAll(nodes=>nodes.filter(n=>n.src.includes('/mobile/im/apps/')&&(!n.complete||n.naturalWidth===0)).length),0,'App assets must still load after preserving internal routes.');
 await page.screenshot({path:path.join(output,'mobile-hash-apps.png')});
 pass('App opens Apps inside the embedded phone and its images load correctly');
 await frame.locator('nav.mobile-conversation-nav').getByRole('button',{name:/^Chats/}).click();
 await frame.getByRole('button',{name:'App',exact:true}).waitFor();
 assert.match(page.url(),/#mobile\/im\/conversations/);
 await frame.getByRole('button',{name:'App',exact:true}).click();await frame.getByRole('heading',{name:'Apps',exact:true}).waitFor();
 await page.reload({waitUntil:'networkidle'});await frame.getByRole('heading',{name:'Apps',exact:true}).waitFor();
 pass('Chats/App navigation and refreshing the deep link preserve the intended route');
 const standalone=await context.newPage();standalone.on('pageerror',e=>report.pageErrors.push(e.message));
 await standalone.goto(project.url+'?prototype=mobile-runtime#im/apps?locale=zh-CN',{waitUntil:'networkidle'});
 await standalone.getByRole('heading',{name:'Apps',exact:true}).waitFor();
 await standalone.getByRole('button',{name:/^Chats/}).click();await standalone.getByRole('button',{name:'App',exact:true}).click();
 await standalone.getByRole('heading',{name:'Apps',exact:true}).waitFor();await standalone.getByText('Quick Links',{exact:true}).waitFor();await standalone.close();
 assert.deepEqual(report.pageErrors,[]);assert.deepEqual(failures,[]);
 pass('standalone runtime and lazy JS/CSS resources work without route exceptions');
 report.success=true;
}catch(error){let message=String(error?.stack||error);for(const value of [env.INIT_ADMIN_PASSWORD,session?.csrf,session?.cookie])if(value)message=message.split(value).join('[redacted]');report.error=message;console.error(message);process.exitCode=1;}
finally{
 try{
  if(task)await terminal(task.id);
  if(project){const p=await api('/projects/'+project.id,'GET',undefined,session);assert.equal(p.name,name);assert.equal(p.ownerId,session.user.id);await api('/projects/'+p.id,'DELETE',undefined,session);}
  if(existing)assert.deepEqual(snapshot((await api('/projects','GET',undefined,session)).items),existing,'Existing projects/current versions changed');
  report.cleanup=true;if(session)await api('/auth/logout','POST',undefined,session);
 }catch{report.cleanup=false;console.error('Temporary fixture cleanup/snapshot check failed; inspect the local report.');process.exitCode=1;}
 writeFileSync(path.join(output,'mobile-hash-routing-report.json'),JSON.stringify(report,null,2));await browser?.close();
}

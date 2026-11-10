// Read-only browser acceptance for the existing local Next.js static export.
// No login, project creation, publication, deletion, or production requests.
import {createRequire} from 'node:module';
import {mkdirSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
const require=createRequire(new URL('../frontend/package.json',import.meta.url));
const {chromium}=require('playwright');
const base=new URL(process.env.NEXT_PREVIEW_URL||'http://localhost:8080/laobaby/');
assert.ok(['localhost','127.0.0.1'].includes(base.hostname),'This acceptance script only visits localhost.');
assert.equal(base.pathname,'/laobaby/','This script targets the existing laobaby project only.');
const prefix=base.pathname,portal=new URL('zh-CN/',base).href;
const output=fileURLToPath(new URL('../.local/',import.meta.url));
mkdirSync(output,{recursive:true});
const report={base:base.href,steps:[],outOfBounds:[],localFailures:[],jsErrors:[],consoleErrors:[],externalFailures:[],cdpRequests:[],cdpFailures:[],cdpLogs:[],success:false};
const browser=await chromium.launch({channel:'chrome',headless:true});
const context=await browser.newContext({viewport:{width:1440,height:1000}});
// External resources are not controlled by this publisher and never receive
// credentials. Requests are observed, but never opened as test navigation.
const page=await context.newPage();
// Chromium sometimes emits favicon errors through the browser network stack
// without a Playwright page request. Preserve CDP URLs instead of hiding them.
const cdp=await context.newCDPSession(page);
const cdpRequests=new Map();
cdp.on('Network.requestWillBeSent',event=>{
 const item={requestId:event.requestId,url:event.request.url,type:event.type,initiator:event.initiator?.type};
 cdpRequests.set(event.requestId,item);report.cdpRequests.push(item);
});
cdp.on('Network.responseReceived',event=>{
 if(event.response.status>=400)report.cdpFailures.push({kind:'response',requestId:event.requestId,url:event.response.url,status:event.response.status,type:event.type});
});
cdp.on('Network.loadingFailed',event=>{
 report.cdpFailures.push({kind:'loadingFailed',requestId:event.requestId,url:cdpRequests.get(event.requestId)?.url,error:event.errorText,type:event.type,canceled:event.canceled});
});
cdp.on('Log.entryAdded',({entry})=>{
 if(['error','warning'].includes(entry.level))report.cdpLogs.push({level:entry.level,source:entry.source,text:entry.text,url:entry.url,line:entry.lineNumber,requestId:entry.networkRequestId,requestURL:cdpRequests.get(entry.networkRequestId)?.url});
});
cdp.on('Runtime.consoleAPICalled',event=>{
 if(event.type==='error')report.cdpLogs.push({level:'error',source:'console-api',text:event.args.map(arg=>arg.value??arg.description??'').join(' '),url:event.stackTrace?.callFrames?.[0]?.url});
});
await Promise.all([cdp.send('Network.enable'),cdp.send('Log.enable'),cdp.send('Runtime.enable')]);
page.on('request',request=>{
 const url=new URL(request.url());
 if(url.origin===base.origin&&!url.pathname.startsWith(prefix))report.outOfBounds.push({url:url.href,type:request.resourceType()});
});
page.on('response',response=>{
 if(response.status()<400)return;
 const url=new URL(response.url()),item={url:url.href,status:response.status(),type:response.request().resourceType()};
 (url.origin===base.origin?report.localFailures:report.externalFailures).push(item);
});
page.on('requestfailed',request=>{
 if(request.failure()?.errorText==='net::ERR_ABORTED')return;
 const url=new URL(request.url()),item={url:url.href,error:request.failure()?.errorText,type:request.resourceType()};
 (url.origin===base.origin?report.localFailures:report.externalFailures).push(item);
});
page.on('pageerror',error=>report.jsErrors.push({url:page.url(),message:error.message}));
page.on('console',message=>{if(message.type()==='error')report.consoleErrors.push({url:page.url(),message:message.text(),location:message.location()});});
function inside(){assert.ok(new URL(page.url()).pathname.startsWith(prefix),'Navigation escaped the project prefix.');}
async function settled(){await page.waitForLoadState('networkidle',{timeout:20000});inside();}
async function record(step,details={}){report.steps.push({step,url:page.url(),...details});console.log('PASS: '+step);}
async function portalPage(){
 await page.goto(portal,{waitUntil:'networkidle',timeout:30000});
 await page.getByRole('heading',{name:'原型中心',exact:true}).waitFor();inside();
}
async function nextLink(route,heading){
 await portalPage();
 const destination=new URL(route,base).href;
 const link=page.locator('a').filter({hasText:/./}).and(page.locator('a[href="'+new URL(destination).pathname+'"]')).first();
 await link.waitFor({state:'visible'});
 const token='next-client-'+Date.now()+'-'+Math.random();
 await page.evaluate(value=>{window.__nextAcceptanceToken=value;},token);
 await link.click();await page.waitForURL(destination,{timeout:20000});await settled();
 await page.getByRole('heading',{name:heading,exact:true}).waitFor({state:'attached'});
 const navigationMode=(await page.evaluate(()=>window.__nextAcceptanceToken))===token?'client':'document';
 await record('Next Link navigation: '+route,{heading,navigationMode});
}
let failure;
try{
 const response=await page.goto(base.href,{waitUntil:'domcontentloaded',timeout:30000});
 assert.ok(response&&response.status()<400,'Project root returned an error.');
 await page.waitForURL(portal,{timeout:20000});await settled();
 await page.getByRole('heading',{name:'原型中心',exact:true}).waitFor();
 await record('root redirects to project-scoped zh-CN portal');

 await nextLink('zh-CN/web/mail/inbox/','收件箱');
 const inbox=page.url();
 await page.reload({waitUntil:'networkidle'});inside();
 await page.getByRole('heading',{name:'收件箱',exact:true}).waitFor({state:'attached'});
 assert.equal(page.url(),inbox);await record('direct child-page refresh renders inbox');
 await page.goBack({waitUntil:'networkidle'});inside();
 await page.getByRole('heading',{name:'原型中心',exact:true}).waitFor();
 await record('browser Back returns to portal');
 await page.goForward({waitUntil:'networkidle'});inside();
 await page.getByRole('heading',{name:'收件箱',exact:true}).waitFor({state:'attached'});
 assert.equal(page.url(),inbox);await record('browser Forward returns to inbox');

 await nextLink('zh-CN/docs/system/components/','组件目录');
 // Component category buttons are client state controls, not static HTML.
 const mobileCategory=page.getByRole('button',{name:'移动端组件',exact:true});
 await mobileCategory.click();
 await page.waitForFunction(()=>[...document.querySelectorAll('button[aria-pressed]')].some(button=>button.textContent.trim()==='移动端组件'&&button.getAttribute('aria-pressed')==='true'));
 await page.getByRole('button',{name:'全部',exact:true}).first().click();
 await record('component catalog controls respond after hydration');

 await page.setViewportSize({width:390,height:844});
 await nextLink('zh-CN/mobile/im/conversations/','原型用户');
 const unread=page.getByRole('button',{name:/^未读(?:\s+\d+)?$/});
 await unread.click();
 await page.waitForFunction(()=>[...document.querySelectorAll('button[aria-pressed]')].some(button=>/^未读(?:\s+\d+)?$/.test(button.textContent.trim())&&button.getAttribute('aria-pressed')==='true'));
 await page.getByRole('button',{name:'全部',exact:true}).first().click();
 await record('mobile conversations and interactive filter buttons');

 await portalPage();
 const english=page.getByRole('button',{name:'English',exact:true});
 await english.click();
 await page.waitForURL(new URL('en/',base).href,{timeout:20000});await settled();
 await page.getByRole('heading',{name:'Prototype center',exact:true}).waitFor();
 await record('language button navigates to project-scoped English portal');
 await page.getByRole('button',{name:'简体中文',exact:true}).click();
 await page.waitForURL(portal,{timeout:20000});await settled();
 await page.getByRole('heading',{name:'原型中心',exact:true}).waitFor();
 await record('language button returns to project-scoped Chinese portal');

 await page.setViewportSize({width:1440,height:1000});
 await page.screenshot({path:path.join(output,'next-preview-fixed.png'),fullPage:true});
 assert.equal(report.outOfBounds.length,0,'Local requests escaped /laobaby/; see report.');
 assert.equal(report.localFailures.length,0,'Local resources or route payloads failed; see report.');
 assert.equal(report.jsErrors.length,0,'JavaScript runtime/hydration errors detected; see report.');
 assert.equal(report.consoleErrors.length,0,'Browser console errors detected; see report.');
 report.success=true;await record('no local resource failures, escaped paths, or hydration errors');
}catch(error){
 failure=error;report.failure={message:error.message,url:page.url()};
 try{report.failure.visibleText=(await page.locator('body').innerText()).slice(0,1800);await page.screenshot({path:path.join(output,'next-preview-failed.png'),fullPage:true});}catch{}
}finally{
 // Surface URL-bearing diagnostics for otherwise unattributed browser 404s.
 const missingResources=report.cdpFailures.filter(item=>item.status>=400);
 const networkLogs=report.cdpLogs.filter(item=>item.level==='error'&&item.source==='network');
 if(missingResources.length||networkLogs.length)console.error('CDP resource diagnostics: '+JSON.stringify({responses:missingResources,networkLogs},null,2));
 writeFileSync(path.join(output,'next-preview-result.json'),JSON.stringify(report,null,2));
 await browser.close();
}
if(failure){console.error('FAIL: '+failure.message);console.error('Details: .local/next-preview-result.json');process.exitCode=1;}

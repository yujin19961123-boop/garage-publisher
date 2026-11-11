// Local UI regression: all APIs and upload transport are simulated; no data writes.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdirSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const require=createRequire(new URL('../frontend/package.json',import.meta.url));
const {chromium}=require('playwright');
const output=fileURLToPath(new URL('../.local/',import.meta.url));mkdirSync(output,{recursive:true});
const origin='http://console.localhost:8080',steps=[];
const folderFixture=fileURLToPath(new URL('../frontend/dist',import.meta.url));
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
 const context=await browser.newContext({viewport:{width:1156,height:1004},serviceWorkers:'block'});
 const user={id:'progress-user',username:'demo',role:'member',status:'active'};
 const project={id:'progress-project',name:'mail',ownerId:user.id,status:'published',url:'http://localhost:8080/progress/',currentReleaseId:'r1',currentVersionNumber:1,lastPublishedAt:new Date().toISOString()};
 let status='UPLOADING',created=null,deployments=0;
 const errors=[];
 await context.route('**/*',route=>{
  const req=route.request(),url=new URL(req.url());
  if(url.origin!==origin)return route.abort();
  if(!url.pathname.startsWith('/api/'))return route.continue();
  const reply=body=>route.fulfill({contentType:'application/json',body:JSON.stringify(body)});
  if(url.pathname==='/api/v1/me')return reply({user});
  if(url.pathname==='/api/v1/platform-config')return reply({maxUploadBytes:104857600,maxExpandedBytes:524288000,maxFiles:10000});
  if(url.pathname==='/api/v1/projects/progress-project/versions')return reply({items:[],currentReleaseId:'r1',busy:false,cleanupPending:false,retentionLimit:5});
  if(url.pathname==='/api/v1/projects'&&req.method()==='POST'){created={...project,id:'created-progress',name:req.postDataJSON().name};return reply(created);}
  if(url.pathname==='/api/v1/projects')return reply({items:created?[project,created]:[project]});
  if(url.pathname.match(/^\/api\/v1\/projects\/[^/]+\/deployments$/)){deployments++;return reply({id:'upload-'+deployments,status:'UPLOADING'});}
  if(url.pathname.startsWith('/api/v1/deployments/'))return reply({id:url.pathname.split('/').at(-1),status,...(status==='FAILED'?{errorMessage:'测试：文件检查失败'}:{})});
  if(url.pathname==='/api/v1/projects/created-progress')return reply(created);
  throw Error('Unexpected simulated API: '+url.pathname);
 });
 await context.addInitScript(()=>{
  const read=File.prototype.arrayBuffer;
  File.prototype.arrayBuffer=async function(){if(window.__holdPreparation&&this.name==='index.html')await new Promise(resolve=>window.__finishPreparation=resolve);return read.call(this);};
  // Only the app's dedicated archive upload uses XHR. All API fetches are mocked above.
  window.XMLHttpRequest=class {
   upload={};status=202;responseText='{}';
   open(method,url){if(method!=='PUT'||!/^\/api\/v1\/deployments\/[^/]+\/archive$/.test(url))throw Error('Unexpected upload URL');}
   setRequestHeader(){}
   send(body){if(!(body instanceof File)||!body.size)throw Error('Expected a real prepared archive');window.__upload=this;}
   abort(){this.onabort?.();}
  };
 });
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 await page.goto(origin);await page.getByRole('button',{name:'发布更新',exact:true}).waitFor();
 const dialog=page.getByRole('dialog');
 const input=()=>dialog.getByLabel('选择原型文件或 ZIP', {exact:true});
 const select=(name='index.html')=>input().setInputFiles({name,mimeType:'text/html',buffer:Buffer.from('<!doctype html><h1>Prototype</h1>')});
 const bar=()=>dialog.getByRole('progressbar');
 const title=text=>dialog.getByRole('status').filter({hasText:text}).waitFor();
 const progress=async n=>{await page.evaluate(n=>window.__upload.upload.onprogress?.({lengthComputable:true,loaded:n,total:100}),n);await page.waitForFunction(n=>document.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')===String(n),n);};
 const finish=async()=>page.evaluate(()=>window.__upload.onload());
 const shot=name=>page.screenshot({path:output+name});
 const pass=message=>{steps.push(message);console.log('PASS: '+message);};

 await page.getByRole('button',{name:'发布更新',exact:true}).click();await select();
 await page.evaluate(()=>window.__holdPreparation=true);
 await dialog.getByRole('button',{name:'发布更新',exact:true}).evaluate(el=>{el.click();el.click();});
 await title('正在整理文件');assert.equal(deployments,0);
 assert.equal(await bar().getAttribute('aria-valuenow'),null);
 assert.equal(await dialog.locator('.file-dropzone').count(),0);
 assert.equal(await dialog.getByRole('button',{name:'发布更新',exact:true}).count(),0);
 await page.keyboard.press('Escape');assert.equal(await dialog.count(),1);assert.equal(await dialog.locator('.close').isDisabled(),true);
 assert.notEqual(await dialog.locator('.publish-orbit').evaluate(el=>getComputedStyle(el).animationName),'none');
 await shot('publish-progress-preparing.png');
 await page.evaluate(()=>{window.__holdPreparation=false;window.__finishPreparation();});
 await page.waitForFunction(()=>!!window.__upload);await progress(47);await title('正在上传文件');
 await page.waitForTimeout(260);await shot('publish-progress-upload.png');
 await progress(100);await title('文件已传送');assert.equal(await dialog.getByRole('heading',{name:'更新成功',exact:true}).count(),0);
 pass('preparation animates immediately; real transport events drive 47%/100%; duplicate submission and closing stay locked');

 status='QUEUED';await finish();await title('等待发布处理');
 assert.equal(await bar().getAttribute('aria-valuenow'),null);
 status='VALIDATING';await title('正在检查文件');
 status='PREPARING';await title('正在发布原型');
 assert.equal(await dialog.locator('.publish-steps [aria-current="step"]').innerText(),'3\n发布原型');
 await shot('publish-progress-publishing.png');
 for(const width of [390,320]){
  await page.setViewportSize({width,height:844});
  assert.equal(await dialog.evaluate(el=>el.scrollWidth>el.clientWidth+1),false);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  if(width===390)await shot('publish-progress-mobile.png');
 }
 await page.emulateMedia({reducedMotion:'reduce'});
 assert.equal(await dialog.locator('.publish-orbit').evaluate(el=>getComputedStyle(el).animationName),'none');
 assert.equal(await dialog.locator('.publish-track > span').evaluate(el=>getComputedStyle(el).animationName),'none');
 await page.emulateMedia({reducedMotion:'no-preference'});await page.setViewportSize({width:1156,height:1004});
 status='SUCCEEDED';project.currentVersionNumber=2;project.currentReleaseId='r2';
 await dialog.getByRole('heading',{name:'更新成功',exact:true}).waitFor();assert.equal(deployments,1);
 assert.equal(await bar().count(),0);assert.equal(await dialog.getByRole('button',{name:'复制链接',exact:true}).count(),1);
 await dialog.getByRole('button',{name:'完成',exact:true}).click();
 pass('server phases use indeterminate motion, 390/320px fit, reduced motion is respected, success replaces progress');

 await page.getByRole('button',{name:'发布更新',exact:true}).click();
 assert.equal(await dialog.locator('.is-selected').count(),0);await select();
 await page.evaluate(()=>window.__upload=null);status='UPLOADING';
 await dialog.getByRole('button',{name:'发布更新',exact:true}).click();await page.waitForFunction(()=>!!window.__upload);
 status='FAILED';await page.evaluate(()=>window.__upload.onerror());
 await dialog.locator('.selected-file-name').waitFor();assert.equal(await dialog.locator('.selected-file-name').innerText(),'index.html');
 assert.equal(await bar().count(),0);assert.equal(await dialog.getByRole('button',{name:'发布更新',exact:true}).isEnabled(),true);
 assert.ok((await dialog.innerText()).includes('旧版仍可访问'));
 await page.evaluate(()=>window.__upload=null);status='UPLOADING';
 await dialog.getByRole('button',{name:'发布更新',exact:true}).click();await page.waitForFunction(()=>!!window.__upload);
 await progress(12);status='SUCCEEDED';await finish();await dialog.getByRole('heading',{name:'更新成功',exact:true}).waitFor();
 await dialog.getByRole('button',{name:'完成',exact:true}).click();
 pass('upload failure restores the selected file and retry; retry starts a fresh progress state and reaches success');

 await page.getByRole('button',{name:'创建项目',exact:true}).first().click();
 const projectName=dialog.getByRole('textbox',{name:'项目名称',exact:true});
 const note=dialog.getByRole('textbox',{name:/版本备注/});
 await dialog.getByLabel('选择原型文件夹',{exact:true}).setInputFiles(folderFixture);
 await dialog.getByText('dist',{exact:true}).waitFor();
 assert.equal(await projectName.getAttribute('placeholder'),'dist');
 await projectName.press('Tab');assert.equal(await projectName.inputValue(),'dist');
 await projectName.fill('');
 await select('新原型.HTML');
 await dialog.getByText('新原型.HTML',{exact:true}).waitFor();
 assert.equal(await projectName.getAttribute('placeholder'),'新原型');
 assert.equal(await projectName.inputValue(),'');
 await projectName.press('Shift+Tab');assert.equal(await projectName.inputValue(),'');
 await projectName.press('Tab');assert.equal(await projectName.inputValue(),'新原型');
 assert.equal(await note.evaluate(el=>el===document.activeElement),true);
 await projectName.fill('自定义名称');
 await select('另一份.html');
 await dialog.getByText('另一份.html',{exact:true}).waitFor();
 await projectName.press('Tab');assert.equal(await projectName.inputValue(),'自定义名称');
 await page.evaluate(()=>window.__upload=null);status='UPLOADING';
 await dialog.getByRole('button',{name:'创建并发布',exact:true}).click();await page.waitForFunction(()=>!!window.__upload);
 await progress(63);assert.equal(await bar().getAttribute('aria-valuenow'),'63');
 status='QUEUED';await finish();await title('等待发布处理');
 status='SUCCEEDED';await dialog.getByRole('heading',{name:'发布成功。',exact:true}).waitFor();
 assert.equal(await bar().count(),0);assert.equal(deployments,4);assert.equal(created.name,'自定义名称');assert.deepEqual(errors,[]);
 pass('folders and standalone HTML suggest their names, accept with Tab, and preserve a custom name after reselection');
 pass('first publication shares the same progress UI and keeps the dedicated success result');
 writeFileSync(output+'publish-progress-report.json',JSON.stringify({success:true,simulatedAPIs:true,noDataWrites:true,steps},null,2));
}finally{await browser.close();}

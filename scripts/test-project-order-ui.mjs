// Local browser regression; every API is intercepted, never writes business data.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdirSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const require=createRequire(new URL('../frontend/package.json',import.meta.url));const {chromium}=require('playwright');
const origin='http://console.localhost:8080',output=fileURLToPath(new URL('../.local/',import.meta.url));mkdirSync(output,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true}),steps=[];
const pass=message=>{steps.push(message);console.log('PASS: '+message);};
try{
 async function setup(options={}){
  const context=await browser.newContext({viewport:{width:1156,height:1004},...options});
  const user={id:'order-owner',username:'排序演示',role:'member',status:'active'};
  const projects=['A','B','C'].map((name,index)=>({id:name.toLowerCase().repeat(48),name:'项目 '+name,ownerId:user.id,status:'published',url:'http://localhost:8080/order-'+name+'/',currentReleaseId:'r'+index,currentVersionNumber:1,lastPublishedAt:new Date(Date.now()-index*3600000).toISOString()}));
  const state={items:[...projects],sortMode:'updated',sortRevision:0,fail:0,writes:0,errors:[]};
  await context.addInitScript(id=>sessionStorage.setItem('garage:welcome:'+id,'seen'),user.id);
  await context.route('**/*',async route=>{
   const req=route.request(),url=new URL(req.url());if(url.origin!==origin)return route.abort();if(!url.pathname.startsWith('/api/'))return route.continue();
   const reply=(data,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
   if(url.pathname==='/api/v1/me')return reply({user});
   if(url.pathname==='/api/v1/platform-config')return reply({maxUploadBytes:104857600,maxExpandedBytes:524288000});
   if(url.pathname==='/api/v1/projects')return reply(state);
   if(url.pathname==='/api/v1/projects/order'&&req.method()==='PUT'){
    state.writes++;const data=req.postDataJSON();assert.equal(data.expectedRevision,state.sortRevision);
    await new Promise(r=>setTimeout(r,160));
    if(state.fail){const failure=state.fail;state.fail=0;if(failure===409){state.items=[projects[1],projects[2],projects[0]];state.sortRevision++;}return reply({message:failure===409?'排序已在其他窗口更新，请刷新后再调整':'排序保存失败，请重试'},failure);}
    if(data.mode==='manual'){assert.equal(new Set(data.projectIds).size,3);state.items=data.projectIds.map(id=>projects.find(p=>p.id===id));}else state.items=[...projects];
    state.sortMode=data.mode;state.sortRevision++;return reply(state);
   }
   throw Error('Unexpected simulated request: '+url.pathname);
  });
  const page=await context.newPage();page.setDefaultTimeout(12000);page.on('pageerror',e=>state.errors.push(e.message));
  await page.goto(origin);await page.locator('article.project').last().waitFor();await page.waitForTimeout(700);
  return {context,page,state,projects};
 }
 const {context,page,state,projects}=await setup();
 const id=name=>name.toLowerCase().repeat(48),card=name=>page.locator(`[data-project-id="${id(name)}"]`);
 const order=()=>page.locator('.sortable-grid > .project').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('aria-label')));
 async function waitOrder(names){await page.waitForFunction(names=>JSON.stringify([...document.querySelectorAll('.sortable-grid > .project')].map(n=>n.getAttribute('aria-label')))===JSON.stringify(names),names.map(n=>'项目 '+n));await page.waitForFunction(()=>document.querySelector('.sortable-grid')?.getAttribute('aria-busy')==='false');}
 async function drag(from,to,{cancel=false,shot=false,inspectAnimation=false}={}){
  await card(from).scrollIntoViewIfNeeded();const a=await card(from).boundingBox(),b=await card(to).boundingBox();
  await page.mouse.move(a.x+15,a.y+15);await page.mouse.down();
  if(inspectAnimation)await page.mouse.move(a.x+25,a.y+15);
  await page.mouse.move(b.x+70,b.y+50,{steps:inspectAnimation?1:12});
  if(inspectAnimation){
   await page.waitForFunction(()=>document.querySelector('.sortable-grid > .project')?.getAttribute('aria-label')==='项目 C');
   assert.equal(state.writes,0,'Preview must not write before release');
   assert.equal(await card('C').evaluate(el=>getComputedStyle(el).opacity),'0.25');
   assert.equal(await card('C').getByRole('heading',{includeHidden:true}).evaluate(el=>getComputedStyle(el).visibility),'hidden');
   const animations=await page.evaluate(()=>document.getAnimations().filter(a=>a.id==='project-reflow').map(a=>a.effect.getKeyframes()));
   assert.ok(animations.length>=2,'Displaced cards must animate before mouseup');
   assert.ok(animations.every(frames=>frames.every(frame=>!['height','width','left','top'].some(key=>key in frame))),'Reflow must not animate layout properties');
   const start=await card('A').boundingBox();await page.waitForTimeout(75);const middle=await card('A').boundingBox();assert.ok(Math.hypot(middle.x-start.x,middle.y-start.y)>5,'Card must visibly move during the animation');
   await page.waitForTimeout(280);assert.deepEqual(await order(),['项目 C','项目 A','项目 B'],'Stationary pointer must not cause preview oscillation');assert.equal(state.writes,0);
  }
  await page.locator('.project-sort-ghost').waitFor();if(shot)await page.screenshot({path:output+'project-sort-dragging.png'});
  if(cancel)await page.keyboard.press('Escape');await page.mouse.up();
  if(inspectAnimation){await page.waitForFunction(()=>document.getAnimations().some(a=>a.id==='project-drop'));await page.screenshot({path:output+'project-sort-drop.png'});await page.locator('.project-sort-ghost').waitFor({state:'hidden'});}
 }
 assert.deepEqual(await order(),['项目 A','项目 B','项目 C']);
 await drag('C','A',{shot:true,inspectAnimation:true});await waitOrder(['C','A','B']);assert.equal(state.sortMode,'manual');assert.equal(state.writes,1);
 await page.reload({waitUntil:'networkidle'});await waitOrder(['C','A','B']);
 pass('blank-card mouse dragging persists the submitted order and refresh restores it');
 pass('cards reflow while held, stationary pointer stays stable, and the ghost animates into its final slot on release');
 const logicalBox=name=>card(name).evaluate(el=>{const g=el.parentElement.getBoundingClientRect();return {x:g.left+el.offsetLeft,y:g.top+el.offsetTop,width:el.offsetWidth,height:el.offsetHeight};});
 const rapidSource=await logicalBox('B'),rapidFirst=await logicalBox('C');
 await page.mouse.move(rapidSource.x+15,rapidSource.y+15);await page.mouse.down();await page.mouse.move(rapidFirst.x+70,rapidFirst.y+50);
 await page.waitForFunction(()=>document.querySelector('.sortable-grid > .project')?.getAttribute('aria-label')==='项目 B');
 const lastSlot=await logicalBox('A');await page.mouse.move(lastSlot.x+70,Math.min(920,lastSlot.y+lastSlot.height-35));
 await page.waitForFunction(()=>document.querySelector('.sortable-grid > .project')?.getAttribute('aria-label')==='项目 C');
 await page.mouse.move(rapidFirst.x+70,rapidFirst.y+50);await page.waitForFunction(()=>document.querySelector('.sortable-grid > .project')?.getAttribute('aria-label')==='项目 B');
 await page.waitForTimeout(320);assert.deepEqual(await order(),['项目 B','项目 C','项目 A']);assert.equal(state.writes,1);
 await page.keyboard.press('Escape');await page.mouse.up();await waitOrder(['C','A','B']);await page.waitForTimeout(350);
 pass('rapid reversals interrupt smoothly, keep preview stable and never save when cancelled');
 await card('C').focus();await page.keyboard.press('Alt+ArrowDown');await waitOrder(['A','C','B']);
 assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('data-project-id')),id('C'));
 await drag('B','A',{cancel:true});await page.waitForTimeout(450);assert.equal(state.writes,2);assert.deepEqual(await order(),['项目 A','项目 C','项目 B']);
 assert.equal(await page.locator('.project-sort-ghost').count(),0);
 const writes=state.writes;await card('A').getByRole('button',{name:'发布更新',exact:true}).click();await page.getByRole('dialog').waitFor();assert.equal(state.writes,writes);await page.keyboard.press('Escape');
 const title=await card('A').getByRole('heading').boundingBox(),target=await card('B').boundingBox();await page.mouse.move(title.x+8,title.y+8);await page.mouse.down();await page.mouse.move(target.x+60,target.y+40,{steps:8});await page.mouse.up();assert.equal(state.writes,writes);assert.equal(await page.locator('.project-sort-ghost').count(),0);
 pass('keyboard Alt+arrows reorders with retained focus; Escape cancels; buttons and title text never start a drag');
 state.fail=503;await drag('B','A');await page.getByRole('alert').filter({hasText:'排序保存失败'}).waitFor();await waitOrder(['A','C','B']);await page.locator('.project-sort-ghost').waitFor({state:'hidden'});assert.equal(await page.locator('.is-sort-source').count(),0);
 state.fail=409;await page.waitForTimeout(450);await drag('B','A');await page.getByRole('alert').filter({hasText:'其他窗口'}).waitFor();await waitOrder(['B','C','A']);
 assert.equal(await page.locator('.project-order-toolbar').count(),0);assert.equal(await page.getByRole('button',{name:'恢复按更新时间',exact:true}).count(),0);assert.equal(await page.getByText('手动排序',{exact:true}).count(),0);
 await page.locator('.project-sort-ghost').waitFor({state:'hidden'});await page.waitForTimeout(450);const beforeCancel=state.writes;
 await card('A').scrollIntoViewIfNeeded();const source=await card('A').boundingBox(),firstCard=await card('B').boundingBox();
 await page.mouse.move(source.x+15,source.y+15);await page.mouse.down();await page.mouse.move(firstCard.x+70,firstCard.y+50,{steps:5});await page.locator('.project-sort-ghost').waitFor();
 await page.setViewportSize({width:943,height:852});await page.locator('.project-sort-ghost').waitFor({state:'hidden'});await page.mouse.up();assert.equal(state.writes,beforeCancel);assert.deepEqual(await order(),['项目 B','项目 C','项目 A']);
 assert.equal(await page.locator('.is-sort-source').count(),0);assert.equal(await page.locator('body.project-sorting,body.project-sort-settling').count(),0);
 assert.deepEqual(state.errors,[]);await context.close();
 pass('save failures restore order, stale-window conflicts refresh server order, no sorting label or reset control is shown');

 const reduced=await setup({reducedMotion:'reduce'}),reducedCards=reduced.page.locator('.sortable-grid > .project');
 const ra=await reducedCards.first().boundingBox(),rc=await reducedCards.last().boundingBox();
 await reduced.page.mouse.move(rc.x+15,rc.y+15);await reduced.page.mouse.down();await reduced.page.mouse.move(ra.x+70,ra.y+50,{steps:5});
 await reduced.page.waitForFunction(()=>document.querySelector('.sortable-grid > .project')?.getAttribute('aria-label')==='项目 C');assert.equal(reduced.state.writes,0);
 assert.equal(await reduced.page.evaluate(()=>document.getAnimations().filter(a=>a.id==='project-reflow'||a.id==='project-drop').length),0);
 await reduced.page.mouse.up();await reduced.page.waitForFunction(()=>document.querySelector('.sortable-grid')?.getAttribute('aria-busy')==='false');assert.equal(reduced.state.writes,1);
 await reduced.page.locator('.project-sort-ghost').waitFor({state:'hidden'});assert.deepEqual(reduced.state.errors,[]);await reduced.context.close();
 pass('resize cancels preview without saving; reduced-motion still previews and saves without reflow/drop animation');

 const mobile=await setup({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
 const session=await mobile.context.newCDPSession(mobile.page);
 const touch=(type,x,y)=>session.send('Input.dispatchTouchEvent',{type,touchPoints:type==='touchEnd'?[]:[{x,y,id:1}]});
 const a=await mobile.page.locator(`[data-project-id="${id('A')}"]`).boundingBox();
 await touch('touchStart',a.x+15,a.y+80);await touch('touchMove',a.x+15,a.y-50);await touch('touchEnd');await mobile.page.waitForTimeout(200);
 assert.ok(await mobile.page.evaluate(()=>scrollY)>0,'Normal card swipes must scroll');assert.equal(mobile.state.writes,0);
 await mobile.page.evaluate(()=>scrollTo(0,0));await mobile.page.waitForTimeout(200);
 const first=await mobile.page.locator(`[data-project-id="${id('A')}"]`).boundingBox(),second=await mobile.page.locator(`[data-project-id="${id('B')}"]`).boundingBox();
 await touch('touchStart',first.x+15,first.y+70);await mobile.page.waitForTimeout(400);await mobile.page.locator('.project-sort-ghost').waitFor();
 await touch('touchMove',second.x+80,Math.min(815,second.y+second.height-25));await mobile.page.waitForTimeout(100);await touch('touchEnd');
 await mobile.page.waitForFunction(()=>document.querySelector('.sortable-grid > .project')?.getAttribute('aria-label')==='项目 B');
 await mobile.page.waitForFunction(()=>document.querySelector('.sortable-grid')?.getAttribute('aria-busy')==='false');assert.equal(mobile.state.writes,1);
 await mobile.page.evaluate(()=>scrollTo(0,0));assert.equal(await mobile.page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await mobile.page.screenshot({path:output+'project-sort-mobile.png'});await mobile.page.setViewportSize({width:320,height:844});assert.equal(await mobile.page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 assert.deepEqual(mobile.state.errors,[]);await mobile.context.close();pass('real touch swipes still scroll; long-press dragging reorders on mobile; 390/320px layout fits');
 writeFileSync(output+'project-order-ui-report.json',JSON.stringify({success:true,allAPIsMocked:true,noBusinessWrites:true,steps},null,2));
}finally{await browser.close();}

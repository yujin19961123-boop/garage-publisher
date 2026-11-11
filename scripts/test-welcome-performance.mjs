// Local mocked UI, real Chrome compositor metrics under 6x CPU throttling.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const require=createRequire(new URL('../frontend/package.json',import.meta.url));
const {chromium}=require('playwright');
const origin='http://console.localhost:8080',dir=new URL('../.local/',import.meta.url);
mkdirSync(dir,{recursive:true});
const baseline=process.argv.includes('--baseline');
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
 async function setup(count=40){
  const context=await browser.newContext({viewport:{width:1156,height:1004},reducedMotion:'no-preference'});
  const user={id:'welcome-performance',username:'本地性能检查',role:'member',status:'active'};
  await context.route('**/*',route=>{
   const req=route.request(),url=new URL(req.url());if(url.origin!==origin)return route.abort();
   if(!url.pathname.startsWith('/api/'))return route.continue();assert.equal(req.method(),'GET');
   let body;
   if(url.pathname==='/api/v1/me')body={user};
   else if(url.pathname==='/api/v1/platform-config')body={maxUploadBytes:104857600,maxExpandedBytes:524288000,maxFiles:10000};
   else if(url.pathname==='/api/v1/projects')body={items:Array.from({length:count},(_,i)=>({id:'perf-'+i,name:'性能检查 '+i,ownerId:user.id,status:'published',url:'http://localhost:8080/perf-'+i+'/',lastPublishedAt:new Date().toISOString(),currentReleaseId:'r-'+i,currentVersionNumber:1}))};
   else throw Error('Unexpected mocked request');
   return route.fulfill({contentType:'application/json',body:JSON.stringify(body)});
  });
  const page=await context.newPage(),cdp=await context.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate',{rate:6});
  await cdp.send('Performance.enable');await page.goto(origin);await page.bringToFront();await page.locator('.project').last().waitFor();
  await page.waitForTimeout(800);
  return{context,page,cdp};
 }
 const result={mode:baseline?'before':'after',cpuThrottle:6,projects:40,localOnly:true,databaseWrites:false};
 {
  const{context,page,cdp}=await setup();
  const initial=Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m=>[m.name,m.value]));
  await page.evaluate(()=>{
   window.welcomeFrames={gaps:[],states:[]};let last=0;
   function frame(now){const state=document.querySelector('.project-masthead')?.dataset.welcomeState;const r=window.welcomeFrames;if(r.states.at(-1)!==state)r.states.push(state);if(state==='collapsing'){if(last)r.gaps.push(now-last);last=now;}else last=0;if(state!=='compact')requestAnimationFrame(frame);}
   requestAnimationFrame(frame);
  });
  await page.waitForFunction(()=>document.querySelector('.project-masthead')?.dataset.welcomeState==='compact');
  const end=Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m=>[m.name,m.value]));
  const samples=await page.evaluate(()=>window.welcomeFrames);
  const gaps=samples.gaps.sort((a,b)=>a-b);
  result.animation={layoutCount:end.LayoutCount-initial.LayoutCount,layoutMs:(end.LayoutDuration-initial.LayoutDuration)*1000,styleCount:end.RecalcStyleCount-initial.RecalcStyleCount,frames:gaps.length,p95FrameMs:gaps[Math.floor(gaps.length*.95)]||0,maxFrameMs:gaps.at(-1)||0,states:samples.states};
  await context.close();
 }
 {
  const{context,page}=await setup(7);
  const box=await page.locator('.project-grid').boundingBox();
  const point={x:box.x+20,y:box.y-8};
  result.initialCursorGuarded=await page.evaluate(({x,y})=>!!document.elementFromPoint(x,y)?.closest('.project-grid,.empty,.header-actions,.share-orb'),point);
  assert.equal(result.initialCursorGuarded,false,'Start in the blank gap, outside protected controls.');
  await page.mouse.move(point.x,point.y);
  if(baseline)await page.waitForTimeout(3600);
  else await page.waitForFunction(()=>['compact','paused'].includes(document.querySelector('.project-masthead')?.dataset.welcomeState),null,{timeout:10000});
  result.stationaryCursorState=await page.locator('.project-masthead').getAttribute('data-welcome-state');
  if(!baseline)assert.equal(result.stationaryCursorState,'compact','A passing card must not stall the exit animation.');
  await context.close();
 }
 const file=new URL(baseline?'welcome-performance-before.json':'welcome-performance-after.json',dir);
 if(!baseline){
  const previous=new URL('welcome-performance-before.json',dir);
  if(existsSync(previous)){const before=JSON.parse(readFileSync(previous));result.comparedWithBefore={layoutCount:before.animation.layoutCount,layoutMs:before.animation.layoutMs,stationaryCursorState:before.stationaryCursorState};}
  assert.ok(result.animation.layoutCount<=12,'Exit must not re-layout the entire project list every frame.');
 }
 writeFileSync(file,JSON.stringify(result,null,2));
 console.log(JSON.stringify(result));
}finally{await browser.close();}

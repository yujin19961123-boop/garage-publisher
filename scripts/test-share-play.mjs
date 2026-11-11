// Read-only local interaction checks. No login, mutations, storage or production access.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdirSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const require=createRequire(new URL('../frontend/package.json',import.meta.url)),{chromium}=require('playwright');
const origin='http://localhost:8080',path=process.argv[2]||'/_share/yujin/';assert.match(path,/^\/_share\/[a-z0-9-]+\/$/);
const output=fileURLToPath(new URL('../.local/',import.meta.url));mkdirSync(output,{recursive:true});
const report={success:false,readOnly:true,steps:[],errors:[]},browser=await chromium.launch({channel:'chrome',headless:true});
const pass=message=>{report.steps.push(message);console.log('PASS: '+message);};
async function setup(options={},clock=false){
 const context=await browser.newContext({viewport:{width:1156,height:1004},serviceWorkers:'block',...options});
 await context.route('**/*',route=>{const req=route.request();assert.ok(['GET','HEAD'].includes(req.method()),'Mutation rejected');return new URL(req.url()).origin===origin?route.continue():route.abort();});
 const page=await context.newPage();page.setDefaultTimeout(12000);page.on('pageerror',e=>report.errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&/Content Security Policy|Refused to execute/i.test(m.text()))report.errors.push(m.text());});
 if(clock)await page.clock.install({time:new Date('2026-11-11T12:00:00+08:00')});
 const response=await page.goto(origin+path,{waitUntil:'networkidle'});assert.equal(response.status(),200);await page.locator('.hero').scrollIntoViewIfNeeded();await page.waitForTimeout(950);
 await page.evaluate(()=>{window.shareFrames=0;const original=window.requestAnimationFrame;window.requestAnimationFrame=callback=>original.call(window,time=>{window.shareFrames++;callback(time);});});
 return {context,page,response};
}
try{
 const {context,page,response}=await setup(),hero=page.locator('.hero'),field=page.locator('.glass-installation'),glyph=page.locator('.collection-glyph').first();
 await page.mouse.move(5,5);assert.equal(await field.getAttribute('data-game-state'),null);assert.equal(await field.locator('.orbit-game-hud').evaluate(el=>getComputedStyle(el).opacity),'0');assert.equal(await field.locator('.orbit-game-effects').evaluate(el=>el.childElementCount),0);
 const resting=await hero.screenshot({path:output+'share-play-rest.png'});
 // Compare with the pre-effect, unsplit title using the same document and CSP.
 const source=await response.text(),baseline=source.replace(/<div class="collection-display">[\s\S]*?<\/em><\/div>/,'<div class="collection-display"><span>原型</span><em>合集<span class="title-dot">。</span></em></div>');assert.notEqual(baseline,source);
 const old=await context.newPage();await old.route(origin+'/_share/play-baseline/',route=>route.fulfill({headers:{'content-type':'text/html; charset=utf-8','content-security-policy':response.headers()['content-security-policy']},body:baseline}));await old.goto(origin+'/_share/play-baseline/');await old.locator('.hero').scrollIntoViewIfNeeded();await old.waitForTimeout(950);const original=await old.locator('.hero').screenshot();
 report.restDifference=await old.evaluate(async ([a,b])=>{
  async function pixels(base64){const img=new Image();img.src='data:image/png;base64,'+base64;await img.decode();const c=document.createElement('canvas');c.width=img.width;c.height=img.height;const x=c.getContext('2d');x.drawImage(img,0,0);return {pixels:x.getImageData(0,0,c.width,c.height).data,width:c.width,height:c.height};}
  const x=await pixels(a),y=await pixels(b);if(x.width!==y.width||x.height!==y.height)return {sameSize:false};let delta=0,changed=0,significant=0;for(let i=0;i<x.pixels.length;i+=4){let maximum=0;for(let k=0;k<3;k++){const d=Math.abs(x.pixels[i+k]-y.pixels[i+k]);delta+=d;maximum=Math.max(maximum,d);}if(maximum)changed++;if(maximum>3)significant++;}return {sameSize:true,mean:delta/(x.width*x.height*3),fraction:changed/(x.width*x.height),significantFraction:significant/(x.width*x.height)};
 },[original.toString('base64'),resting.toString('base64')]);
 assert.ok(report.restDifference.sameSize&&report.restDifference.mean<.15&&report.restDifference.significantFraction<.002,'Static composition changed');await old.close();await page.bringToFront();
 const b=await glyph.boundingBox();await page.mouse.move(b.x+b.width*.85,b.y+b.height*.3);
 await page.waitForFunction(()=>Math.abs(new DOMMatrixReadOnly(getComputedStyle(document.querySelector('.collection-glyph')).transform).m41)>2);
 const shifts=await page.locator('.collection-glyph').evaluateAll(nodes=>nodes.map(node=>new DOMMatrixReadOnly(getComputedStyle(node).transform).m41.toFixed(1)));assert.ok(new Set(shifts).size>2);
 await page.mouse.click(b.x+b.width*.8,b.y+b.height*.4);assert.ok(await page.locator('.text-ripple').evaluate(el=>el.getAnimations().some(a=>a.playState==='running')));
 await hero.screenshot({path:output+'share-play-text.png'});await page.mouse.move(5,5);await page.waitForFunction(()=>[...document.querySelectorAll('.collection-glyph')].every(el=>!el.style.transform));
 const idle=await page.evaluate(()=>window.shareFrames);await page.waitForTimeout(350);assert.equal(await page.evaluate(()=>window.shareFrames),idle);
 pass('untouched composition matches; per-letter mouse repulsion/ripple returns to rest and stops RAF');

 const timed=await setup({},true),game=timed.page.locator('.glass-installation');
 await timed.page.clock.pauseAt(await timed.page.evaluate(()=>Date.now()+200));
 const rect=await game.boundingBox();await timed.page.mouse.move(rect.x+rect.width/2,rect.y+rect.height/2);const started=await timed.page.evaluate(()=>performance.now());await timed.page.clock.runFor(500);
 assert.equal(await game.getAttribute('data-game-state'),'playing');assert.equal(await game.locator('[data-game-hint]').textContent(),'');assert.equal(await game.locator('.orbit-seed').count(),6);assert.ok(await timed.page.evaluate(()=>window.shareFrames)>15);
 for(let i=0;i<14&&Number(await game.locator('[data-game-score]').innerText())<4;i++){
  const seed=game.locator('.orbit-seed:not(.is-dormant)').first();if(!await seed.count()){await timed.page.clock.runFor(300);continue;}
  const point=await seed.boundingBox();await timed.page.mouse.move(point.x+point.width/2,point.y+point.height/2);await timed.page.clock.runFor(350);
 }
 assert.ok(Number(await game.locator('[data-game-score]').innerText())>=4,'Moving the mouse must collect actual seeds');
 await timed.page.mouse.click(rect.x+rect.width*.65,rect.y+rect.height*.5);assert.ok(await game.locator('.orbit-pulse').evaluate(el=>el.getAnimations().some(a=>a.playState==='running')));
 await timed.page.clock.runFor(120);await timed.page.locator('.hero').screenshot({path:output+'share-play-game.png'});
 const pool=await game.locator('.orbit-game-effects > span').count();assert.ok(pool<=24,'Effects must reuse a bounded pool');
 pass('hover reveals a playable orbital field; spring probe collects seeds, scores combos and produces click pulse feedback');
 const elapsed=await timed.page.evaluate(()=>performance.now())-started;await timed.page.clock.runFor(29900-elapsed);
 assert.equal(await game.getAttribute('data-game-state'),'playing');assert.equal(await game.locator('[data-game-time]').innerText(),'00:01');
 await timed.page.clock.runFor(170);assert.equal(await game.getAttribute('data-game-state'),'finished');assert.equal(await game.locator('[data-game-time]').innerText(),'00:00');assert.equal(await game.locator('[data-game-hint]').innerText(),'点击再玩一轮');
 await timed.page.clock.runFor(4000);const stopped=await timed.page.evaluate(()=>window.shareFrames);await timed.page.clock.runFor(600);assert.equal(await timed.page.evaluate(()=>window.shareFrames),stopped);
 await timed.page.mouse.click(rect.x+rect.width/2,rect.y+rect.height/2);assert.equal(await game.getAttribute('data-game-state'),'playing');assert.equal(await game.locator('[data-game-hint]').textContent(),'');assert.equal(await game.locator('[data-game-score]').innerText(),'00');assert.equal(await game.locator('[data-game-time]').innerText(),'00:30');assert.equal(await game.locator('.orbit-game-effects > span').count(),pool);
 await timed.page.clock.runFor(160);await timed.page.mouse.move(5,5);await timed.page.clock.runFor(4000);assert.equal(await game.getAttribute('data-game-state'),null);assert.equal(await game.locator('.glass-orb').evaluate(el=>el.style.transform),'');
 const returned=await timed.page.evaluate(()=>window.shareFrames);await timed.page.clock.runFor(500);assert.equal(await timed.page.evaluate(()=>window.shareFrames),returned);await timed.context.close();
 pass('round lasts exactly 30 seconds, settles without idle frames, restarts without new nodes, and leaving restores the original artwork');

 const f=await field.boundingBox();await page.mouse.move(f.x+f.width/2,f.y+f.height/2);await page.waitForFunction(()=>document.querySelector('.glass-installation').dataset.gameState==='playing');
 await page.evaluate(()=>window.dispatchEvent(new Event('blur')));assert.equal(await field.getAttribute('data-game-state'),null);
 await page.mouse.move(f.x+f.width*.6,f.y+f.height*.4);await page.emulateMedia({reducedMotion:'reduce'});await page.waitForFunction(()=>!document.querySelector('.glass-installation').hasAttribute('data-game-state'));
 assert.equal(await field.locator('.orbit-game-effects').evaluate(el=>getComputedStyle(el).display),'none');await page.mouse.click(f.x+f.width/2,f.y+f.height/2);assert.equal(await field.getAttribute('data-game-state'),null);
 for(const width of [390,320]){await page.setViewportSize({width,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);}
 await page.emulateMedia({reducedMotion:'no-preference'});await page.locator('.hero').scrollIntoViewIfNeeded();await page.waitForTimeout(400);
 const narrowField=await field.boundingBox();assert.ok(narrowField.width<220);await page.mouse.move(narrowField.x+narrowField.width/2,narrowField.y+narrowField.height/2);assert.equal(await field.getAttribute('data-game-state'),null);
 const narrowGlyph=await glyph.boundingBox();await page.mouse.move(narrowGlyph.x+narrowGlyph.width*.8,narrowGlyph.y+narrowGlyph.height*.3);await page.mouse.click(narrowGlyph.x+narrowGlyph.width*.8,narrowGlyph.y+narrowGlyph.height*.3);await page.waitForTimeout(300);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await context.close();
 const mobile=await setup({viewport:{width:390,height:844},isMobile:true,hasTouch:true}),mf=await mobile.page.locator('.glass-installation').boundingBox();
 await mobile.page.touchscreen.tap(mf.x+mf.width/2,mf.y+mf.height/2);assert.equal(await mobile.page.locator('.glass-installation').getAttribute('data-game-state'),null);assert.equal(await mobile.page.locator('.orbit-game-effects').evaluate(el=>getComputedStyle(el).display),'none');
 const beforeScroll=await mobile.page.evaluate(()=>scrollY),session=await mobile.context.newCDPSession(mobile.page),mx=mf.x+mf.width/2,my=mf.y+mf.height/2;
 await session.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:mx,y:my,id:1}]});await session.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:mx,y:Math.min(820,my+130),id:1}]});await session.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await mobile.page.waitForTimeout(250);assert.ok(await mobile.page.evaluate(()=>scrollY)<beforeScroll,'Touching the artwork must still allow page scrolling');
 await mobile.page.locator('.hero').screenshot({path:output+'share-play-mobile.png'});assert.equal(await mobile.page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await mobile.context.close();
 pass('blur/reduced-motion reset immediately; touch stays static and 390/320px remain within the page');
 assert.deepEqual(report.errors,[]);report.success=true;
}catch(error){report.error=String(error.stack||error);console.error(report.error);process.exitCode=1;}
finally{await browser.close();writeFileSync(output+'share-play-report.json',JSON.stringify(report,null,2));}

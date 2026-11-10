import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
const require=createRequire(new URL('../frontend/package.json',import.meta.url));
const {chromium}=require('playwright');
const base=process.env.PREVIEW_URL||'http://localhost:8080/123/';
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000}});
let errors=[],critical=[];
page.on('pageerror',e=>errors.push(e.message));
page.on('response',r=>{if(r.status()>=400&&/\.(?:js|mjs|css)(?:[?#]|$)/.test(r.url()))critical.push({url:r.url(),status:r.status()});});
page.on('requestfailed',r=>{if(/\.(?:js|mjs|css)(?:[?#]|$)/.test(r.url())&&r.failure()?.errorText!=='net::ERR_ABORTED')critical.push({url:r.url(),error:r.failure()?.errorText});});
const report=[];
try{
 await page.goto(base,{waitUntil:'domcontentloaded'});
 await page.getByRole('link',{name:'打开桌面端原型',exact:true}).waitFor();
 assert.ok((await page.locator('body').innerText()).includes('原型目录'));
 await page.getByRole('link',{name:'打开桌面端原型',exact:true}).click();
 await page.locator('iframe').waitFor({state:'attached',timeout:15000});
 const iframe=page.frameLocator('iframe').first();
 await iframe.getByRole('heading',{name:'TeleMail',exact:true}).waitFor({timeout:15000});
 await page.waitForTimeout(500);
 assert.ok(!errors.length,JSON.stringify(errors));assert.ok(!critical.length,JSON.stringify(critical));
 await page.screenshot({path:'.local/123-preview-fixed.png',fullPage:true});
 report.push({route:'desktop',textVisible:true,errors:[...errors],resourceFailures:[...critical]});
 for(const [hash,text]of [['overview','原型目录'],['mobile','移动'],['components','组件预览'],['tokens','设计系统'],['recipes','标准拼接示例']]){
  errors=[];critical=[];
  await page.goto(base+'#'+hash,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>document.body.innerText.trim().length>30);
  if(hash==='overview')await page.getByRole('heading',{name:text,exact:true}).waitFor();
  if(['components','tokens','recipes'].includes(hash))await page.getByRole('heading',{name:text,exact:true}).first().waitFor();
  await page.waitForTimeout(500);
  assert.ok(!errors.length,hash+': '+JSON.stringify(errors));
  assert.ok(!critical.length,hash+': '+JSON.stringify(critical));
  console.log('Checked '+hash);
  report.push({route:hash,textVisible:true,errors:[...errors],resourceFailures:[...critical]});
 }
 writeFileSync('.local/preview-browser-result.json',JSON.stringify(report,null,2));
 console.log('PASS: real Chrome overview -> desktop iframe plus mobile, components, design system, examples; no runtime errors or failed JS/CSS.');
}catch(e){console.error(JSON.stringify({error:e.message,url:page.url(),errors,critical,text:(await page.locator('body').innerText()).slice(0,1000)},null,2));throw e;}finally{await browser.close();}

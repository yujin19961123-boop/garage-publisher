import {createRequire} from 'node:module';
const require=createRequire(new URL('../frontend/package.json',import.meta.url));
const {chromium}=require('playwright');
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1280,height:900}});
const errors=[],failures=[];
page.on('pageerror',e=>errors.push(e.stack||e.message));
page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
page.on('response',r=>{if(r.status()>=400)failures.push({url:r.url(),status:r.status()});});
page.on('requestfailed',r=>failures.push({url:r.url(),error:r.failure()?.errorText}));
try{
 await page.goto(process.env.PREVIEW_URL||'http://localhost:8080/123/',{waitUntil:'networkidle'});
 if(process.env.TEST_NAV==='1'){await page.getByRole('link',{name:'打开桌面端原型',exact:true}).click();await page.locator('iframe').waitFor({state:'attached',timeout:5000}).catch(()=>{});await page.waitForLoadState('networkidle');}
 console.log(JSON.stringify({url:page.url(),title:await page.title(),text:(await page.locator('body').innerText()).slice(0,3000),errors,failures},null,2));
 await page.screenshot({path:'.local/preview-debug.png',fullPage:true});
}finally{await browser.close();}

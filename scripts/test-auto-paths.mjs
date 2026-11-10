import {env,api,login,request} from './test-helpers.mjs';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
const require=createRequire(new URL('../frontend/package.json',import.meta.url));
const {unzipSync}=require('fflate');
const admin=await login(env.INIT_ADMIN_USERNAME,env.INIT_ADMIN_PASSWORD);
const project=await api('/projects','POST',{name:'路径适配临时验收'+Date.now().toString(36)},admin);
writeFileSync('.local/path-adaptation-test.json',JSON.stringify({id:project.id,publicId:project.publicId,url:project.url,ownerId:admin.user.id}));
const original=readFileSync('dist.zip');
const d=await api('/projects/'+project.id+'/deployments','POST',{},admin);
await api('/deployments/'+d.id+'/archive','PUT',original,admin,202);
let done=false;
for(let i=0;i<240;i++){
 const status=await api('/deployments/'+d.id,'GET',undefined,admin);
 if(status.status==='FAILED')throw Error(status.errorMessage);
 if(status.status==='SUCCEEDED'){done=true;break;}
 await new Promise(r=>setTimeout(r,500));
}
assert.ok(done,'publish timed out');
const url=new URL(project.url),prefix=url.pathname;
const get=(path)=>request(prefix+path,{host:url.host});
const home=await get('');assert.equal(home.status,200);assert.match(home.text,/teleMail/);
assert.ok(home.text.includes(prefix+'assets/index-'));
assert.ok(!home.text.includes('src="/assets/'));
const originals=unzipSync(original);
const jsNames=Object.keys(originals).filter(x=>x.startsWith('dist/')&&x.endsWith('.js')).map(x=>x.slice(5));
mkdirSync('.local/path-check',{recursive:true});
for(let i=0;i<jsNames.length;i++){
 const result=await get(jsNames[i]);assert.equal(result.status,200,jsNames[i]);
 const path='.local/path-check/'+i+'.mjs';writeFileSync(path,result.text);
 execFileSync(process.execPath,['--check',path],{stdio:'pipe'});
}
assert.equal((await get('mail/mesh-logo.png')).status,200);
const stageName=jsNames.find(x=>x.includes('DesktopPrototypeStage-')&&Buffer.from(originals['dist/'+x]).toString().includes('/?prototype=desktop'));
assert.ok(stageName,'desktop stage not found');
const stage=await get(stageName);
assert.ok(stage.text.includes(prefix+'?prototype=desktop'),'iframe URL must remain in project path');
const cssNames=Object.keys(originals).filter(x=>x.startsWith('dist/assets/')&&x.endsWith('.css')).map(x=>x.slice(5));
for(const path of cssNames)assert.equal((await get(path)).status,200,path);
console.log('PASS: original dist.zip published without manual edits; root assets, all '+jsNames.length+' JavaScript files syntax-checked, CSS/images and iframe navigation prefixes.');
console.log(project.url);

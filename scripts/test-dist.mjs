import {env,request,api,login,zip} from './test-helpers.mjs';
import {readFileSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const admin=await login(env.INIT_ADMIN_USERNAME,env.INIT_ADMIN_PASSWORD);
const project=await api('/projects','POST',{name:'teleMail · 真实产物验收'},admin);
async function deploy(file,expected){const d=await api('/projects/'+project.id+'/deployments','POST',{routeMode:'spa'},admin);await api('/deployments/'+d.id+'/archive','PUT',Buffer.isBuffer(file)?file:readFileSync(file),admin,202);for(let i=0;i<120;i++){const s=await api('/deployments/'+d.id,'GET',undefined,admin);if(['FAILED','SUCCEEDED'].includes(s.status)){assert.equal(s.status,expected,JSON.stringify(s));return s;}await new Promise(r=>setTimeout(r,250));}throw Error('timeout');}
await deploy('dist.zip','SUCCEEDED');
const host=new URL(project.url).host;
const preview=(path='/',headers={})=>request(new URL(path.replace(/^\//,''),project.url).pathname,{host,headers});
const home=await preview();assert.equal(home.status,200);assert.match(home.text,/teleMail/);
const paths=[...home.text.matchAll(/(?:src|href)="([^"]+)"/g)].map(m=>m[1]).filter(p=>p.includes('/assets/')).map(p=>new URL(p,project.url).pathname);
assert.ok(paths.length>=2);
for(const path of paths){const r=await request(path,{host});assert.equal(r.status,200,path);assert.ok(r.text.length>0);}
assert.equal((await preview('/desktop',{Accept:'text/html'})).status,200);
await deploy('dist.zip','SUCCEEDED');
const after=await api('/projects/'+project.id,'GET',undefined,admin);assert.equal(after.url,project.url);
await deploy(zip({'readme.txt':'missing homepage'}),'FAILED');
assert.match((await preview()).text,/teleMail/);
writeFileSync('.local/dist-result.json',JSON.stringify({url:project.url,projectId:project.id,assets:paths,passed:true},null,2));
console.log('PASS: original ZIP automatically normalized and adapted; HTML/assets served; SPA direct route; same URL after update; invalid update preserved published content.');
console.log(project.url);

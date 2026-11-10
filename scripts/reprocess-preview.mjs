// Re-publish the current immutable release through the normal publication API.
// No source files or existing release directories are edited in place.
import {env,api,login} from './test-helpers.mjs';
import {createRequire} from 'node:module';
import {readdirSync,lstatSync,readFileSync,writeFileSync} from 'node:fs';
import path from 'node:path';
const require=createRequire(new URL('../frontend/package.json',import.meta.url));
const {zip}=require('fflate');
const target=process.env.REPAIR_PROJECT_ID;
if(!/^[a-f0-9]{48}$/.test(target||''))throw Error('Set REPAIR_PROJECT_ID explicitly');
const session=await login(env.INIT_ADMIN_USERNAME,env.INIT_ADMIN_PASSWORD);
const project=await api('/projects/'+target,'GET',undefined,session);
if(project.ownerId!==session.user.id)throw Error('Cannot re-publish another owner project');
const previous=project.latestDeployment;
if(previous?.status!=='SUCCEEDED'||!/^[a-f0-9]{48}$/.test(previous.id))throw Error('Current latest release is not successful; do not overwrite a concurrent publication');
const root=path.resolve('.local/data/releases',target,previous.id);
const files=Object.create(null);
function read(dir,prefix=''){
 for(const e of readdirSync(dir,{withFileTypes:true})){
  const file=path.join(dir,e.name),relative=prefix+e.name;
  if(lstatSync(file).isSymbolicLink())throw Error('Unexpected release link');
  if(e.isDirectory())read(file,relative+'/');
  else if(e.isFile())files[relative]=readFileSync(file);
 }
}
read(root);
const archive=await new Promise((resolve,reject)=>zip(files,{level:6},(e,d)=>e?reject(e):resolve(Buffer.from(d))));
const check=await api('/projects/'+target,'GET',undefined,session);
if(check.latestDeployment?.id!==previous.id)throw Error('Project changed during preparation; stopped without publishing');
const task=await api('/projects/'+target+'/deployments','POST',{},session);
await api('/deployments/'+task.id+'/archive','PUT',archive,session,202);
for(let i=0;i<240;i++){
 const state=await api('/deployments/'+task.id,'GET',undefined,session);
 if(state.status==='FAILED')throw Error(state.errorMessage);
 if(state.status==='SUCCEEDED'){
  const updated=await api('/projects/'+target,'GET',undefined,session);
  if(updated.url!==project.url)throw Error('Project URL changed unexpectedly');
  writeFileSync('.local/preview-repair-result.json',JSON.stringify({projectId:target,previousRelease:previous.id,newRelease:task.id,url:updated.url},null,2));
  console.log('Reprocessed current release successfully: '+updated.url);process.exit(0);
 }
 await new Promise(r=>setTimeout(r,500));
}
throw Error('Timed out waiting for publication');

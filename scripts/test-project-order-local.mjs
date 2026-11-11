// Real local ZIP/update/share regression. Does not change any account's order preference.
import assert from 'node:assert/strict';
import {writeFileSync,mkdirSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {env,api,login,publish,request} from './test-helpers.mjs';
const tag='Order local '+Date.now().toString(36)+' '+randomBytes(4).toString('hex');
const report={success:false,cleanup:false,steps:[]};let session,baseline,projects=[];
const snapshot=items=>items.map(p=>({id:p.id,name:p.name,url:p.url,currentReleaseId:p.currentReleaseId,updatedAt:p.updatedAt})).sort((a,b)=>a.id.localeCompare(b.id));
const pass=text=>{report.steps.push(text);console.log('PASS: '+text);};
const files=v=>({'index.html':'<!doctype html><h1>Order '+v+'</h1>'});
async function checkOrder(first,second){const data=await api('/projects','GET',undefined,session);assert.equal(data.sortMode,'updated');assert.deepEqual(data.items.filter(p=>projects.some(x=>x.id===p.id)).map(p=>p.id),[first.id,second.id]);}
async function checkShare(first,second){const share=await api('/share-page','GET',undefined,session);const url=new URL(share.url);assert.equal(url.origin,'http://localhost:8080');const res=await fetch(url);assert.equal(res.status,200);const html=await res.text(),a=html.indexOf('href="'+first.url+'"'),b=html.indexOf('href="'+second.url+'"');assert.ok(a>=0&&b>a,'Collection order differs from publisher');}
try{
 session=await login(env.INIT_ADMIN_USERNAME,env.INIT_ADMIN_PASSWORD);baseline=await api('/projects','GET',undefined,session);assert.equal(baseline.sortMode,'updated','This test refuses to overwrite a manual preference; use isolated database tests instead.');
 const a=await api('/projects','POST',{name:tag+' A'},session);projects.push(a);const b=await api('/projects','POST',{name:tag+' B'},session);projects.push(b);
 await checkOrder(b,a);await publish(a,files('A1'),session);await checkOrder(a,b);
 await publish(b,files('B1'),session);await checkOrder(b,a);await checkShare(b,a);
 pass('newest first by default; publishing the older project moves it first; anonymous collection follows published order');
 const first=(await api('/projects/'+a.id+'/versions','GET',undefined,session)).items[0];
 await publish(a,files('A2'),session);const updated=await api('/projects/'+a.id,'GET',undefined,session);await checkOrder(a,b);await checkShare(a,b);
 await api('/projects/'+a.id+'/versions/'+first.id+'/activate','POST',{expectedCurrentReleaseId:updated.currentReleaseId},session);
 const rolled=await api('/projects/'+a.id,'GET',undefined,session);assert.ok(Date.parse(rolled.updatedAt)>Date.parse(updated.updatedAt));assert.equal(rolled.url,a.url);await checkShare(a,b);
 const current=await request(new URL(a.url).pathname,{host:'localhost:8081'});assert.equal(current.status,200);assert.ok(current.text.includes('Order A1'));
 pass('real ZIP update and rollback refresh recency, preserve the URL, and keep collection order aligned');
 const beforeFailure=await api('/projects/'+b.id,'GET',undefined,session);const d=await api('/projects/'+b.id+'/deployments','POST',{},session);await api('/deployments/'+d.id+'/archive','PUT',Buffer.from('invalid ZIP'),session,202);
 for(let n=0;n<120;n++){const task=await api('/deployments/'+d.id,'GET',undefined,session);if(task.status==='FAILED')break;assert.notEqual(task.status,'SUCCEEDED');await new Promise(r=>setTimeout(r,250));if(n===119)throw Error('Failed upload did not finish');}
 const afterFailure=await api('/projects/'+b.id,'GET',undefined,session);assert.equal(afterFailure.updatedAt,beforeFailure.updatedAt);assert.equal(afterFailure.currentReleaseId,beforeFailure.currentReleaseId);await checkOrder(a,b);
 await api('/projects/'+b.id,'PATCH',{name:tag+' B renamed'},session);await checkOrder(b,a);await checkShare(b,a);
 pass('failed upload leaves recency and live content unchanged; actual name change reorders both publisher and collection');report.success=true;
}catch(error){let message=String(error?.stack||error);for(const secret of [env.INIT_ADMIN_PASSWORD,session?.cookie,session?.csrf])if(secret)message=message.split(secret).join('[redacted]');report.error=message;console.error(message);process.exitCode=1;}
finally{
 try{
  if(session){for(const p of projects){for(let n=0;n<120;n++){const current=await api('/projects/'+p.id,'GET',undefined,session);assert.equal(current.ownerId,session.user.id);assert.ok(current.name.startsWith(tag));if(!current.latestDeployment||['SUCCEEDED','FAILED'].includes(current.latestDeployment.status)){await api('/projects/'+p.id,'DELETE',undefined,session);break;}await new Promise(r=>setTimeout(r,250));if(n===119)throw Error('Temporary project still busy');}}
   if(baseline){const after=await api('/projects','GET',undefined,session);assert.deepEqual(snapshot(after.items),snapshot(baseline.items));assert.equal(after.sortMode,baseline.sortMode);assert.equal(after.sortRevision,baseline.sortRevision);}await api('/auth/logout','POST',undefined,session);
  }report.cleanup=true;
 }catch{report.cleanup=false;console.error('Local temporary project cleanup or original project snapshot comparison failed.');process.exitCode=1;}
 mkdirSync('.local',{recursive:true});writeFileSync('.local/project-order-local-report.json',JSON.stringify(report,null,2));
}

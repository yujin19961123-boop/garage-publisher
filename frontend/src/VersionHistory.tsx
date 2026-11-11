import {useEffect,useRef,useState} from 'react';
import {RelativeTime} from './RelativeTime';
import './versions.css';

type Api=<T>(route:string,method?:string,body?:unknown,signal?:AbortSignal)=>Promise<T>;
type Version={id:string;versionNumber:number;createdAt:string;isCurrent:boolean;canActivate:boolean;filesState:'available'|'missing'};
type Versions={items:Version[];currentReleaseId:string|null;busy:boolean;cleanupPending:boolean;retentionLimit:number};
type RecordItem={id:string;status:string;errorMessage:string;createdAt:string;updatedAt:string;releaseId:string|null;versionNumber:number|null;filesState:'available'|'cleanup_pending'|'cleaned'|'missing'|null;isCurrent:boolean};
type Records={items:RecordItem[];nextCursor:string|null};
export type Activation={ok:true;currentReleaseId:string;currentVersionNumber:number;lastPublishedAt:string};
const statusNames:Record<string,string>={UPLOADING:'上传中',QUEUED:'等待处理',VALIDATING:'检查文件中',PREPARING:'发布中',SUCCEEDED:'发布成功',FAILED:'发布失败'};
const fileNames:Record<string,string>={available:'文件可用',cleanup_pending:'等待清理',cleaned:'文件已清理',missing:'文件缺失'};

export function VersionHistory({projectId,revision,disabled,api,onBusyChange,onActivated}:{projectId:string;revision:string;disabled:boolean;api:Api;onBusyChange:(busy:boolean)=>void;onActivated:(result:Activation)=>Promise<unknown>}){
 const [versions,setVersions]=useState<Versions|null>(null),[records,setRecords]=useState<RecordItem[]>([]),[cursor,setCursor]=useState<string|null>(null);
 const [loading,setLoading]=useState(false),[moreLoading,setMoreLoading]=useState(false),[switching,setSwitching]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[confirm,setConfirm]=useState<Version|null>(null);
 const alive=useRef(true),epoch=useRef(0),loadAbort=useRef<AbortController|null>(null),moreAbort=useRef<AbortController|null>(null),switchAbort=useRef<AbortController|null>(null),switchLock=useRef(false),moreLock=useRef(false);
 const callbacks=useRef({onBusyChange,onActivated});callbacks.current={onBusyChange,onActivated};
 const cancelButton=useRef<HTMLButtonElement>(null),previousFocus=useRef<HTMLElement|null>(null);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;epoch.current++;loadAbort.current?.abort();moreAbort.current?.abort();switchAbort.current?.abort();};},[]);

 async function load(preserveError=false){
  const request=++epoch.current;
  loadAbort.current?.abort();moreAbort.current?.abort();moreLock.current=false;setMoreLoading(false);
  const controller=new AbortController();loadAbort.current=controller;setLoading(true);if(!preserveError)setError('');
  const results=await Promise.allSettled([
   api<Versions>('/projects/'+projectId+'/versions','GET',undefined,controller.signal),
   api<Records>('/projects/'+projectId+'/deployments','GET',undefined,controller.signal),
  ]);
  if(!alive.current||controller.signal.aborted||request!==epoch.current)return;
  const messages:string[]=[];
  if(results[0].status==='fulfilled')setVersions(results[0].value);else messages.push('版本列表暂时无法读取。');
  if(results[1].status==='fulfilled'){setRecords(results[1].value.items);setCursor(results[1].value.nextCursor);}else messages.push('发布记录暂时无法读取。');
  if(messages.length)setError(previous=>[preserveError?previous:'',messages.join('')+'已显示的记录会保留，请刷新重试。'].filter(Boolean).join(' '));
  setLoading(false);
 }
 useEffect(()=>{
  if(!switchLock.current)void load();
  return()=>{epoch.current++;loadAbort.current?.abort();moreAbort.current?.abort();};
 },[projectId,revision]);
 useEffect(()=>{if(disabled||versions?.busy)setConfirm(null);},[disabled,versions?.busy]);
 useEffect(()=>{
  if(!confirm)return;
  previousFocus.current=document.activeElement as HTMLElement|null;
  cancelButton.current?.focus();
  const escape=(event:KeyboardEvent)=>{if(event.isComposing)return;if(event.key==='Escape'){event.preventDefault();event.stopPropagation();if(!switchLock.current)setConfirm(null);}};
  document.addEventListener('keydown',escape,true);
  return()=>{document.removeEventListener('keydown',escape,true);if(previousFocus.current?.isConnected)previousFocus.current.focus();};
 },[confirm]);

 async function syncCurrent(signal:AbortSignal,expectedEpoch:number,candidateId?:string){
  const current=await api<{currentReleaseId:string|null;currentVersionNumber:number|null;lastPublishedAt:string|null}>('/projects/'+projectId,'GET',undefined,signal);
  if(!alive.current||signal.aborted||expectedEpoch!==epoch.current)return;
  if(current.currentReleaseId&&current.currentVersionNumber!=null&&current.lastPublishedAt){
   const result:Activation={ok:true,currentReleaseId:current.currentReleaseId,currentVersionNumber:current.currentVersionNumber,lastPublishedAt:current.lastPublishedAt};
   if(candidateId===current.currentReleaseId){setConfirm(null);setError('');setNotice('已确认当前为 v'+current.currentVersionNumber+'。');}
   try{await callbacks.current.onActivated(result);}catch{if(alive.current&&!signal.aborted)setNotice('已确认当前为 v'+current.currentVersionNumber+'，项目列表暂未刷新。');}
  }
 }
 async function refreshRecords(){
  setConfirm(null);
  const reading=load(),controller=loadAbort.current,request=epoch.current;
  const results=await Promise.allSettled([reading,controller?syncCurrent(controller.signal,request):Promise.resolve()]);
  if(alive.current&&controller&&!controller.signal.aborted&&request===epoch.current&&results[1].status==='rejected')setNotice('记录已刷新，项目信息暂时无法同步，请稍后重试。');
 }

 async function more(){
  if(!cursor||loading||moreLock.current||switchLock.current)return;
  moreLock.current=true;setMoreLoading(true);setError('');
  const request=epoch.current,controller=new AbortController();moreAbort.current=controller;
  try{
   const result=await api<Records>('/projects/'+projectId+'/deployments?cursor='+encodeURIComponent(cursor),'GET',undefined,controller.signal);
   if(!alive.current||controller.signal.aborted||request!==epoch.current)return;
   setRecords(items=>{const ids=new Set(items.map(item=>item.id));return [...items,...result.items.filter(item=>!ids.has(item.id))];});setCursor(result.nextCursor);
  }catch{if(alive.current&&!controller.signal.aborted&&request===epoch.current)setError('更多发布记录读取失败，请重试。');}
  finally{if(moreAbort.current===controller){moreLock.current=false;if(alive.current)setMoreLoading(false);}}
 }
 async function activate(){
  if(!confirm||!versions||disabled||versions.busy||loading||switchLock.current||!confirm.canActivate||confirm.filesState!=='available')return;
  const candidate=confirm;
  switchLock.current=true;setSwitching(true);callbacks.current.onBusyChange(true);setError('');setNotice('');
  loadAbort.current?.abort();moreAbort.current?.abort();epoch.current++;
  const controller=new AbortController();switchAbort.current=controller;
  try{
   const result=await api<Activation>('/projects/'+projectId+'/versions/'+candidate.id+'/activate','POST',{expectedCurrentReleaseId:versions.currentReleaseId},controller.signal);
   if(!alive.current||controller.signal.aborted)return;
   setVersions(current=>current?{...current,currentReleaseId:result.currentReleaseId,items:current.items.map(item=>({...item,isCurrent:item.id===result.currentReleaseId,canActivate:item.id!==result.currentReleaseId&&item.filesState==='available'}))}:current);
   setRecords(items=>items.map(item=>({...item,isCurrent:item.releaseId===result.currentReleaseId})));
   setConfirm(null);setNotice('已切换到 v'+result.currentVersionNumber+'，分享链接保持不变。');
   try{await callbacks.current.onActivated(result);}catch{if(alive.current)setNotice('版本已切换成功，项目信息暂时无法刷新；请稍后刷新列表。');}
  }catch(e){
   if(alive.current&&!controller.signal.aborted){
    setError((e as Error).message||'切换失败，请刷新版本记录后重试。');
    // A lost POST response does not prove that activation failed. Re-read the
    // project before offering a retry, and synchronize the detail's label too.
    try{await syncCurrent(controller.signal,epoch.current,candidate.id);}catch{if(alive.current&&!controller.signal.aborted)setNotice('切换结果暂未确认，请刷新版本记录。');}
   }
  }
  finally{
   switchLock.current=false;
   if(alive.current){setSwitching(false);callbacks.current.onBusyChange(false);await load(true);}
  }
 }
 const locked=disabled||switching||!!versions?.busy;
 return <section data-testid="version-history" className="version-history" aria-label="版本记录">
   <div className="version-heading"><h3>可切换版本</h3><button type="button" className="version-refresh" disabled={loading||switching} onClick={()=>void refreshRecords()}>{loading?'读取中…':'刷新版本记录'}</button></div>
   <p className="small muted">保留最近 {versions?.retentionLimit||5} 个成功版本（含当前），分享链接不变。</p>
   {loading&&<p role="status" className="version-loading">正在读取版本记录…</p>}
   {error&&<div role="alert" className="alert">{error}</div>}{notice&&<div role="status" className="success">{notice}</div>}
   {versions?.busy&&<p role="status" className="task-state">项目正在发布，完成后可刷新并切换版本。</p>}
   {versions?.cleanupPending&&<p className="small muted">较早版本的文件正在清理，记录仍会保留。</p>}
   {versions&&!versions.items.length&&<p className="version-empty">还没有成功发布的版本。</p>}
   <ol className="version-list">{versions?.items.map(item=><li key={item.id} className={'version-item'+(item.isCurrent?' is-current':'')}>
    <div className="version-meta"><strong>v{item.versionNumber}</strong>{item.isCurrent&&<span className="version-current">当前版本</span>}<RelativeTime value={item.createdAt}/>{item.filesState==='missing'&&<span className="version-unavailable">文件缺失，无法切换</span>}</div>
    {!item.isCurrent&&<button type="button" disabled={locked||loading||!item.canActivate||item.filesState!=='available'} onClick={()=>{setConfirm(item);setError('');}}>切换到 v{item.versionNumber}</button>}
   </li>)}</ol>
   {confirm&&<div role="group" aria-label="确认切换版本" className="version-confirm">
    <strong>切换到 v{confirm.versionNumber}？</strong><p>分享链接将展示这个版本。</p>
    <div className="share-actions"><button ref={cancelButton} type="button" disabled={switching} onClick={()=>setConfirm(null)}>取消切换</button><button type="button" className="primary" data-testid="version-switch-confirm" disabled={locked||loading} onClick={activate}>{switching?'正在切换…':'确认切换'}</button></div>
   </div>}
   {switching&&<p role="status" className="task-state">正在切换…</p>}
   <div className="version-log-heading"><h3>全部发布记录</h3></div>
   {!loading&&!records.length&&<p className="version-empty">暂无发布记录。</p>}
   <ol className="version-log">{records.map(item=><li key={item.id}>
    <div className="version-log-top"><strong>{item.versionNumber!==null?'v'+item.versionNumber:'发布任务'}</strong><span className={item.status==='FAILED'?'version-failed':''}>{statusNames[item.status]||item.status}</span>{item.isCurrent&&<span className="version-current">当前版本</span>}</div>
    <RelativeTime value={item.createdAt}/>{item.filesState&&item.filesState!=='available'&&<span className="version-files">{fileNames[item.filesState]}</span>}
    {item.errorMessage&&<p className="version-log-error">{item.errorMessage}</p>}
   </li>)}</ol>
   {cursor&&<button type="button" className="version-more" disabled={loading||moreLoading||switching} onClick={more}>{moreLoading?'正在读取…':'加载更多记录'}</button>}
 </section>;
}

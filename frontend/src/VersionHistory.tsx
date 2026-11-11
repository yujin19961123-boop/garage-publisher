import {useEffect,useRef,useState} from 'react';
import {ActionIcon} from './ActionIcon';
import {VersionTimestamp,type Version,type Versions} from './VersionFields';
import './versions.css';

type Api=<T>(route:string,method?:string,body?:unknown,signal?:AbortSignal)=>Promise<T>;
type RecordItem={id:string;status:string;errorMessage:string;createdAt:string;updatedAt:string;releaseId:string|null;versionNumber:number|null;filesState:'available'|'cleanup_pending'|'cleaned'|'missing'|null;isCurrent:boolean;note?:string;uploadedAt?:string|null;filesUpdatedAt?:string|null;superseded?:boolean;replacement?:boolean;savedOnly?:boolean};
type Records={items:RecordItem[];nextCursor:string|null};
export type VersionState={ok:true;currentReleaseId:string;currentVersionNumber:number;lastPublishedAt:string|null;published?:boolean};
type VersionAction={version:Version;published?:boolean};
const statusNames:Record<string,string>={UPLOADING:'上传中',QUEUED:'等待处理',VALIDATING:'检查文件中',PREPARING:'发布中',SUCCEEDED:'发布成功',FAILED:'发布失败'};
const fileNames:Record<string,string>={available:'文件可用',cleanup_pending:'等待清理',cleaned:'文件已清理',missing:'文件缺失'};

function recordStatus(item:RecordItem){
 if(item.savedOnly&&item.status==='SUCCEEDED')return '已保存';
 if(item.savedOnly&&item.status==='FAILED')return '保存失败';
 if(item.replacement&&item.status==='SUCCEEDED')return '覆盖成功';
 if(item.replacement&&item.status==='FAILED')return '覆盖失败';
 return statusNames[item.status]||item.status;
}

export function VersionHistory({projectId,revision,disabled,api,onBusyChange,onChanged,onEdit}:{projectId:string;revision:string;disabled:boolean;api:Api;onBusyChange:(busy:boolean)=>void;onChanged:(result:VersionState)=>Promise<unknown>;onEdit:(version:Version)=>void}){
 const [versions,setVersions]=useState<Versions|null>(null),[records,setRecords]=useState<RecordItem[]>([]),[cursor,setCursor]=useState<string|null>(null);
 const [loading,setLoading]=useState(false),[moreLoading,setMoreLoading]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const [confirm,setConfirm]=useState<Version|null>(null),[pendingAction,setPendingAction]=useState<VersionAction|null>(null);
 const switching=pendingAction!==null;
 const alive=useRef(true),epoch=useRef(0),loadAbort=useRef<AbortController|null>(null),moreAbort=useRef<AbortController|null>(null),switchAbort=useRef<AbortController|null>(null),switchLock=useRef(false),moreLock=useRef(false);
 const callbacks=useRef({onBusyChange,onChanged});callbacks.current={onBusyChange,onChanged};
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

 async function syncCurrent(signal:AbortSignal,expectedEpoch:number,action?:VersionAction){
  const current=await api<{currentReleaseId:string|null;currentVersionNumber:number|null;lastPublishedAt:string|null;status:string}>('/projects/'+projectId,'GET',undefined,signal);
  if(!alive.current||signal.aborted||expectedEpoch!==epoch.current)return;
  if(current.currentReleaseId&&current.currentVersionNumber!=null){
   const result:VersionState={ok:true,currentReleaseId:current.currentReleaseId,currentVersionNumber:current.currentVersionNumber,lastPublishedAt:current.lastPublishedAt,published:current.status==='published'};
   setVersions(versions=>versions?{...versions,published:result.published}:versions);
   if(action?.version.id===current.currentReleaseId&&(action.published===undefined||action.published===result.published)){
    setConfirm(null);setError('');setNotice(action.published===undefined?'已确认当前为 v'+current.currentVersionNumber+'。':action.published?'已确认重新发布。':'已确认取消发布。');
   }
   try{await callbacks.current.onChanged(result);}catch{if(alive.current&&!signal.aborted)setNotice('版本状态已确认，项目列表暂未刷新。');}
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
 async function applyChange(action:VersionAction){
  if(!versions||disabled||versions.busy||loading||switchLock.current)return;
  const {version:candidate,published:publication}=action;
  if(publication===undefined){
   if(!candidate.canActivate||candidate.filesState!=='available')return;
  }else if(candidate.id!==versions.currentReleaseId||(publication&&candidate.filesState!=='available')){
   return;
  }
  switchLock.current=true;
  setPendingAction(action);
  if(publication!==undefined)setConfirm(null);
  callbacks.current.onBusyChange(true);setError('');setNotice('');
  loadAbort.current?.abort();moreAbort.current?.abort();epoch.current++;
  const controller=new AbortController();switchAbort.current=controller;
  try{
   const route='/projects/'+projectId+'/versions/'+candidate.id;
   const result=publication===undefined?
    await api<VersionState>(route+'/activate','POST',{expectedCurrentReleaseId:versions.currentReleaseId},controller.signal):
    await api<VersionState>(route+'/publication','PUT',{published:publication},controller.signal);
   if(!alive.current||controller.signal.aborted)return;
   setVersions(current=>current?{...current,published:result.published??current.published,currentReleaseId:result.currentReleaseId,items:current.items.map(item=>({...item,isCurrent:item.id===result.currentReleaseId,canActivate:item.id!==result.currentReleaseId&&item.filesState==='available'}))}:current);
   setRecords(items=>items.map(item=>({...item,isCurrent:item.releaseId===result.currentReleaseId})));
   setConfirm(null);
   setNotice(publication===false?'已取消发布，原分享链接暂时无法访问。':publication===true?'已发布，原分享链接已恢复访问。':
    result.published===false?'已切换到 v'+result.currentVersionNumber+'，项目仍未发布。':'已切换到 v'+result.currentVersionNumber+'，分享链接保持不变。');
   try{await callbacks.current.onChanged(result);}catch{if(alive.current)setNotice('版本状态已更新，项目列表暂未刷新。');}
  }catch(e){
   if(alive.current&&!controller.signal.aborted){
    setError((e as Error).message||'操作失败，请刷新版本记录后重试。');
    // Reconcile a lost response before asking the user to retry.
    try{await syncCurrent(controller.signal,epoch.current,action);}catch{if(alive.current&&!controller.signal.aborted)setNotice('操作结果暂未确认，请刷新版本记录。');}
   }
  }
  finally{
   switchLock.current=false;
   if(alive.current){setPendingAction(null);callbacks.current.onBusyChange(false);await load(true);}
  }
 }
 const locked=disabled||switching||!!versions?.busy;
 const published=versions?.published??true;
 const publicationLabel=published?'取消发布':'发布';
 const busyLabel=pendingAction?.published===undefined?'正在切换…':pendingAction.published?'正在发布…':'正在取消发布…';
 return <section data-testid="version-history" className="version-history" aria-label="版本记录">
   <div className="version-heading"><h3>可切换版本</h3><button type="button" className="version-icon" title="刷新版本记录" aria-label="刷新版本记录" disabled={loading||switching} onClick={()=>void refreshRecords()}><ActionIcon name="refresh"/></button></div>
   <p className="small muted">最多保留 {versions?.retentionLimit||5} 个版本，满额后可覆盖更新。</p>
   {loading&&<p role="status" className="version-loading">正在读取版本记录…</p>}
   {error&&<div role="alert" className="alert">{error}</div>}{notice&&<div role="status" className="success">{notice}</div>}
   {versions?.busy&&<p role="status" className="task-state">项目正在发布，完成后可刷新并切换版本。</p>}
   {versions?.cleanupPending&&<p className="small muted">较早版本的文件正在清理，记录仍会保留。</p>}
   {versions&&!versions.items.length&&<p className="version-empty">还没有成功发布的版本。</p>}
   <ol className="version-list">{versions?.items.map(item=><li key={item.id} className={'version-item'+(item.isCurrent?' is-current':'')}>
    <div className="version-meta">
     <strong>v{item.versionNumber}</strong>{item.isCurrent&&<span className="version-current">当前版本</span>}
     {item.isCurrent&&!published&&<span className="version-unavailable">未发布</span>}
     {item.filesState==='missing'&&<span className="version-unavailable">文件缺失，无法切换</span>}
    </div>
    <VersionTimestamp label="创建时间" value={item.createdAt}/>
    <div className="version-actions">
     <button type="button" className="version-icon" title={'编辑 v'+item.versionNumber} aria-label={'编辑 v'+item.versionNumber} disabled={locked||loading||!!confirm} onClick={()=>onEdit(item)}><ActionIcon name="edit"/></button>
     {item.isCurrent?
      <button type="button" className="version-icon" title={publicationLabel+' v'+item.versionNumber} aria-label={publicationLabel+' v'+item.versionNumber}
       disabled={locked||loading||(!published&&item.filesState!=='available')} onClick={()=>void applyChange({version:item,published:!published})}><ActionIcon name={published?'unpublish':'upload'}/></button>:
      <button type="button" className="version-icon" title={'切换到 v'+item.versionNumber} aria-label={'切换到 v'+item.versionNumber}
       disabled={locked||loading||!item.canActivate||item.filesState!=='available'} onClick={()=>{setConfirm(item);setError('');}}><ActionIcon name="switch"/></button>}
    </div>
    {item.note&&<p className="version-note">{item.note}</p>}
   </li>)}</ol>
   {confirm&&<div role="group" aria-label="确认切换版本" className="version-confirm">
    <strong>切换到 v{confirm.versionNumber}？</strong>
    <p>{published?'分享链接将展示这个版本。':'切换后，发布当前版本即可恢复分享链接。'}</p>
    <div className="share-actions"><button ref={cancelButton} type="button" disabled={switching} onClick={()=>setConfirm(null)}>取消切换</button><button type="button" className="primary" data-testid="version-switch-confirm" disabled={locked||loading} onClick={()=>void applyChange({version:confirm})}>{switching?'正在切换…':'确认切换'}</button></div>
   </div>}
   {switching&&<p role="status" className="task-state">{busyLabel}</p>}
   <div className="version-log-heading"><h3>全部发布记录</h3></div>
   {!loading&&!records.length&&<p className="version-empty">暂无发布记录。</p>}
   <ol className="version-log">{records.map(item=><li key={item.id}>
    <div className="version-log-top">
     <strong>{item.versionNumber!==null?'v'+item.versionNumber:'发布任务'}</strong>
     <span className={item.status==='FAILED'?'version-failed':''}>{recordStatus(item)}</span>
     {item.isCurrent&&<span className="version-current">当前版本</span>}{item.superseded&&<span>已被覆盖</span>}
     {item.filesState&&item.filesState!=='available'&&<span className="version-files">{fileNames[item.filesState]}</span>}
    </div>
    <VersionTimestamp label="更新时间" value={item.filesUpdatedAt||item.updatedAt}/>
    {item.note&&<p className="version-note">{item.note}</p>}
    {item.errorMessage&&<p className="version-log-error">{item.errorMessage}</p>}
   </li>)}</ol>
   {cursor&&<div className="version-more"><button type="button" className="version-icon" title="加载更多记录" aria-label="加载更多记录" aria-busy={moreLoading} disabled={loading||moreLoading||switching} onClick={more}><ActionIcon name="more"/></button></div>}
 </section>;
}

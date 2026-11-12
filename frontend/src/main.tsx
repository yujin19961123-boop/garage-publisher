import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
import {Brand,SignalMark} from './Identity';
import {ModalFrame} from './ModalFrame';
import {ResetPasswordModal} from './ResetPasswordModal';
import {VersionHistory,type VersionState} from './VersionHistory';
import {VersionNoteInput,VersionPublishMode,VersionTarget,VersionTimes,type Version,type Versions} from './VersionFields';
import {RelativeTime} from './RelativeTime';
import {LoginForm} from './LoginForm';
import {LoginScene} from './LoginScene';
import {ProjectWelcome,resetProjectWelcome} from './ProjectWelcome';
import {MemberTable,type Member} from './MemberTable';
import {ActionIcon} from './ActionIcon';
import {InlineProjectName,type NameEditor} from './InlineProjectName';
import {usePointerSurfaces} from './usePointerSurfaces';
import {FileSelection} from './FileSelection';
import {PublishProgress} from './PublishProgress';
import {SortableProjectGrid} from './SortableProjectGrid';
import {prepareArchive,selectionFolder,standaloneHtml,type Selection,type UploadLimits} from './upload-input';

type User = Member;
type Deployment = {id:string; status:string; errorMessage?:string; versionNumber?:number|null; replacement?:boolean; isCurrent?:boolean; savedOnly?:boolean; projectPublished?:boolean};
type Project = {id:string; name:string; ownerId:string; status:string; url:string; currentReleaseId:string|null; currentVersionNumber:number|null; lastPublishedAt?:string|null; latestDeployment?:Deployment};
type SharePage = {url:string; publishedCount:number};
type Config = UploadLimits;
type ProjectCollection={items:Project[];sortMode?:'updated'|'manual';sortRevision?:number};
const active = (d?:Deployment) => !!d && !['SUCCEEDED','FAILED','succeeded','failed'].includes(d.status);
let csrfToken = '';
async function api<T>(path:string, method='GET', data?:unknown,signal?:AbortSignal):Promise<T> {
  const res=await fetch('/api/v1'+path,{method,signal,credentials:'same-origin',headers:{'Content-Type':'application/json',...(csrfToken?{'X-CSRF-Token':csrfToken}:{})},body:data===undefined?undefined:JSON.stringify(data)});
  const token=res.headers.get('X-CSRF-Token'); if(token) csrfToken=token;
  const body=await res.json().catch(()=>({}));
  if(body.csrfToken) csrfToken=body.csrfToken;
  if(!res.ok) {if(res.status===401 && path!='/auth/login' && path!='/me') window.dispatchEvent(new Event('session-expired')); throw Object.assign(new Error(body.message||'请求失败，请稍后重试'),{status:res.status,code:body.code});}
  return body;
}
function upload(id:string,file:File,onProgress:(n:number)=>void,signal?:AbortSignal):Promise<void>{return new Promise((resolve,reject)=>{const xhr=new XMLHttpRequest();xhr.open('PUT',`/api/v1/deployments/${id}/archive`);xhr.setRequestHeader('Content-Type','application/zip');if(csrfToken)xhr.setRequestHeader('X-CSRF-Token',csrfToken);xhr.upload.onprogress=e=>{if(e.lengthComputable)onProgress(Math.round(e.loaded/e.total*100));};xhr.onload=()=>{if(xhr.status>=200&&xhr.status<300)resolve();else{let message='上传失败，请重试';try{message=JSON.parse(xhr.responseText).message||message;}catch{}reject(new Error(message));}};xhr.onerror=()=>reject(new Error('上传中断，请检查网络后重试。之前发布的内容仍可打开。'));xhr.timeout=600000;xhr.ontimeout=()=>reject(new Error('上传超时，请重试'));xhr.onabort=()=>reject(new Error('上传已结束'));signal?.addEventListener('abort',()=>xhr.abort(),{once:true});if(signal?.aborted){xhr.abort();reject(new Error('上传已结束'));return;}xhr.send(file);});}
const size=(n?:number)=>n?`${Number((n/1000000).toFixed(1))} MB`:'正在读取限制';
const exportInstructions = `请导出可直接在浏览器打开的静态网页。单文件可用任意 .html 文件名，请内联本地资源；多文件请提供含 index.html 和全部资源的文件夹或 ZIP。
请检查页面、样式和跳转是否正常。`;
const projectNameMaxLength=100;

function uploadNameSuggestion(selection:Selection|null){
 const folder=selectionFolder(selection);
 const name=(folder||standaloneHtml(selection)?.file.name.replace(/\.html$/i,'')||'').trim();
 const draft=name.slice(0,projectNameMaxLength).replace(/[\uD800-\uDBFF]$/,'');
 // The project API also limits names to 200 UTF-8 bytes.
 const {read}=new TextEncoder().encodeInto(draft,new Uint8Array(200));
 return draft.slice(0,read).trimEnd();
}

function App(){
 usePointerSurfaces();
 const [user,setUser]=useState<User|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const [projects,setProjects]=useState<Project[]>([]),[users,setUsers]=useState<User[]>([]),[tab,setTab]=useState('projects'),[config,setConfig]=useState<Config>({});
 const [sortRevision,setSortRevision]=useState(0),[ordering,setOrdering]=useState(false),orderLock=useRef(false);
 const currentUserId=useRef(user?.id);currentUserId.current=user?.id;
 const [selected,setSelected]=useState<Project|null>(null),[showCreate,setShowCreate]=useState(false),[busy,setBusy]=useState(false),[progress,setProgress]=useState<number|null>(null);
 const [projectView,setProjectView]=useState<'publish'|'versions'>('publish');
 const [editingVersion,setEditingVersion]=useState(false),[targetVersion,setTargetVersion]=useState<Version|null>(null);
 const [publishNow,setPublishNow]=useState(true);
 const [uploadNotes,setUploadNotes]=useState<Record<string,string>>({});
 const [uploadVersions,setUploadVersions]=useState<Versions|null>(null);
 const [versionLoadError,setVersionLoadError]=useState(false),[versionReload,setVersionReload]=useState(0);
 const noteKey=targetVersion?.id||'';
 const uploadNote=uploadNotes[noteKey]??targetVersion?.note??'';
 const targetChanged=!!(targetVersion&&uploadVersions&&!uploadVersions.items.some(item=>item.id===targetVersion.id));
 const loadUploadVersions=projectView==='publish'&&!editingVersion&&selected?.ownerId===user?.id&&selected?.currentReleaseId?selected.id:null;
 const mustReplace=!!uploadVersions&&uploadVersions.items.length>=uploadVersions.retentionLimit;
 const uploadTargetRequired=!!loadUploadVersions&&(!uploadVersions||(mustReplace&&!targetVersion));
 useEffect(()=>{
  if(!loadUploadVersions)return;
  const controller=new AbortController();
  setVersionLoadError(false);
  api<Versions>('/projects/'+loadUploadVersions+'/versions','GET',undefined,controller.signal)
   .then(result=>{if(!controller.signal.aborted)setUploadVersions(result);})
   .catch(()=>{if(!controller.signal.aborted)setVersionLoadError(true);});
  return()=>controller.abort();
 },[loadUploadVersions,selected?.currentReleaseId,versionReload]);
 const nameEditor=useRef<NameEditor>(null);
 const [task,setTask]=useState<Deployment|undefined>(),[selection,setSelection]=useState<Selection|null>(null);
 const ownDeploymentId=useRef<string|null>(null);
 const [updateSuccess,setUpdateSuccess]=useState<string|null>(null),updateSubmitLock=useRef(false);
 const [showShare,setShowShare]=useState(false);
 const [openingShare,setOpeningShare]=useState(false),shareOpenLock=useRef<symbol|null>(null);
 useEffect(()=>{if(!notice)return;const timer=setTimeout(()=>setNotice(''),4000);return()=>clearTimeout(timer);},[notice]);
 const [confirmDelete,setConfirmDelete]=useState(false),[deleting,setDeleting]=useState(false);
 const [resetUser,setResetUser]=useState<User|null>(null);
 const deleteLock=useRef<symbol|null>(null);
 const [versionSwitching,setVersionSwitching]=useState(false),versionSwitchLock=useRef(false);
 useEffect(()=>{ownDeploymentId.current=null;updateSubmitLock.current=false;setUpdateSuccess(null);setVersionSwitching(false);versionSwitchLock.current=false;setTab('projects');setUsers([]);setProjects([]);setResetUser(null);setOpeningShare(false);shareOpenLock.current=null;setConfirmDelete(false);setDeleting(false);deleteLock.current=null;setSelected(null);setTask(undefined);setSelection(null);},[user?.id]);
 const updateController=useRef(new AbortController());
 useEffect(()=>{updateController.current=new AbortController();return()=>updateController.current.abort();},[user?.id]);
 const [selectionBusy,setSelectionBusy]=useState(false),[prepareStage,setPrepareStage]=useState('');
 useEffect(()=>{setShowShare(false);setShowCreate(false);},[user?.id]);
 function acceptCollection(data:ProjectCollection){const items=data.items||[];setProjects(items);setSortRevision(data.sortRevision||0);return items;}
 const refresh=async()=>{const requestedUser=currentUserId.current;const data=await api<ProjectCollection>('/projects');if(currentUserId.current!==requestedUser)return [];const items=acceptCollection(data);setSelected(p=>p?(items.find(x=>x.id===p.id)||p):null);return items;};
 useEffect(()=>{setSortRevision(0);setOrdering(false);orderLock.current=false;},[user?.id]);
 async function saveOrder(ids:string[]){
  if(orderLock.current||!user)return;
  const owner=user.id,before=projects;orderLock.current=true;setOrdering(true);setError('');
  const positions=new Map(ids.map((id,index)=>[id,index]));setProjects(items=>[...items].sort((a,b)=>positions.get(a.id)!-positions.get(b.id)!));
  try{const data=await api<ProjectCollection>('/projects/order','PUT',{mode:'manual',projectIds:ids,expectedRevision:sortRevision},updateController.current.signal);if(currentUserId.current===owner){acceptCollection(data);setNotice('顺序已保存，已同步到分享页');}}
  catch(e){if(currentUserId.current===owner){setProjects(before);setError((e as Error).message||'排序保存失败，请重试');try{await refresh();}catch{ /* Keep the last confirmed order. */ }}}
  finally{if(currentUserId.current===owner){orderLock.current=false;setOrdering(false);}}
 }
 useEffect(()=>{api<{user:User}>('/me').then(result=>setUser(result.user)).catch(()=>{}).finally(()=>setLoading(false));const expired=()=>{setUser(null);setError('登录已失效，请重新登录');};window.addEventListener('session-expired',expired);return()=>window.removeEventListener('session-expired',expired);},[]);
 useEffect(()=>{if(!user)return;refresh().catch(e=>setError(e.message));api<Config>('/platform-config').then(setConfig).catch(e=>setError(e.message));},[user]);
 useEffect(()=>{if(!user||!active(task))return;let stopped=false;const timer=setInterval(async()=>{try{const d=await api<Deployment>('/deployments/'+task!.id);if(stopped)return;setTask(d);if(!active(d)){const items=await refresh();if(!stopped)setSelected(p=>items.find(x=>x.id===p?.id)||p);}}catch(e){if(!stopped)setError((e as Error).message);}},2000);return()=>{stopped=true;clearInterval(timer);};},[user?.id,task?.id,task?.status]);
 async function action(fn:()=>Promise<void>){setError('');setNotice('');setBusy(true);try{await fn();}catch(e){setError((e as Error).message);}finally{setBusy(false);setPrepareStage('');}}
 useEffect(()=>{if(task?.id!==ownDeploymentId.current||active(task))return;ownDeploymentId.current=null;if(task?.status==='SUCCEEDED'&&selected&&projectView==='publish'){setUpdateSuccess(selected.id);setSelection(null);setProgress(null);setError('');setNotice('');}},[task?.id,task?.status,selected?.id,projectView]);
 function open(p:Project,view:'publish'|'versions'='publish',version:Version|null=null){
  const ownProject=p.ownerId===currentUserId.current;
  ownDeploymentId.current=ownProject&&view==='publish'&&active(p.latestDeployment)?p.latestDeployment!.id:null;
  updateSubmitLock.current=false;setUpdateSuccess(null);setProjectView(view);
  setEditingVersion(version!==null);setTargetVersion(version);setUploadNotes({});
  setPublishNow(p.status==='published'||!p.currentReleaseId);
  setUploadVersions(null);setVersionLoadError(false);
  setVersionSwitching(false);versionSwitchLock.current=false;setConfirmDelete(false);setSelected(p);
  setTask(!ownProject||p.latestDeployment?.status==='SUCCEEDED'?undefined:p.latestDeployment);
  setSelection(null);setError('');setNotice('');setProgress(null);
 }
 async function closeProjectUpload(){
  if(await nameEditor.current?.commit()===false)return;
  if(editingVersion&&selected){open(selected,'versions');return;}
  setSelected(null);setTask(undefined);setConfirmDelete(false);setUpdateSuccess(null);
 }
 async function submitUpdate(event:React.FormEvent<HTMLFormElement>){
  event.preventDefault();
  if(!selected||busy||active(task)||selectionBusy||deleting||targetChanged||uploadTargetRequired||updateSubmitLock.current||versionSwitchLock.current||deleteLock.current)return;
  const noteOnly=!selection&&editingVersion&&targetVersion&&uploadNote.trim()!==(targetVersion.note||'');
  if(!selection&&!noteOnly)return;
  updateSubmitLock.current=true;
  const signal=updateController.current.signal;
  try{
   await action(async()=>{
    if(!selection&&targetVersion){
     await api('/projects/'+selected.id+'/versions/'+targetVersion.id,'PATCH',{note:uploadNote},signal);
     if(!signal.aborted){
      open(selected,'versions');
      setNotice('v'+targetVersion.versionNumber+' 的备注已保存');
     }
     return;
    }
    if(!selection)return;
    setTask(undefined);
    const archive=await prepareArchive(selection,config,setPrepareStage,signal);
    setPrepareStage('');
    let deployment:Deployment;
    try{
     deployment=await api<Deployment>('/projects/'+selected.id+'/deployments','POST',{
      note:targetVersion?uploadNotes[noteKey]:uploadNote,replaceReleaseId:targetVersion?.id,
      publishNow:targetVersion?undefined:publishNow,
     },signal);
    }catch(error){
     const code=(error as {code?:string}).code;
     if(code==='VERSION_CHANGED'||code==='VERSION_LIMIT_REACHED')setVersionReload(value=>value+1);
     throw error;
    }
    ownDeploymentId.current=deployment.id;setTask(deployment);setProgress(0);
    try{
     await upload(deployment.id,archive,setProgress,signal);
     setTask(await api<Deployment>('/deployments/'+deployment.id,'GET',undefined,signal));
    }catch(error){
     if(signal.aborted)return;
     const latest=await api<Deployment>('/deployments/'+deployment.id,'GET',undefined,signal).catch(()=>deployment);
     setTask(latest);
     if(active(latest))setNotice('正在确认发布结果…');
     else if(latest.status!=='SUCCEEDED')throw error;
    }finally{
     setProgress(null);
     try{await refresh();}catch{if(!signal.aborted)setNotice('列表暂时无法刷新，请稍后重试。');}
    }
   });
  }finally{updateSubmitLock.current=false;}
 }
 async function syncVersionState(result:VersionState){
  const id=selected?.id;if(!id)return;
  const patch={currentReleaseId:result.currentReleaseId,currentVersionNumber:result.currentVersionNumber,lastPublishedAt:result.lastPublishedAt,
   ...(result.published===undefined?{}:{status:result.published?'published':'unpublished'})};
  setSelected(current=>current?.id===id?{...current,...patch}:current);
  setProjects(items=>items.map(item=>item.id===id?{...item,...patch}:item));await refresh();
 }
 async function copy(text:string,message='链接已复制',errorMessage='复制失败，请选中链接后手动复制'){try{await navigator.clipboard.writeText(text);setNotice(message);}catch{setError(errorMessage);}}
 async function openOwnShare(){
  if(!user||busy||shareOpenLock.current)return;
  const owner=user.id,operation=Symbol('open-own-share'),signal=updateController.current.signal;
  shareOpenLock.current=operation;setOpeningShare(true);setError('');setNotice('');
  let preview:Window|null=null;
  // Open during the click gesture so the async API request cannot trigger a
  // popup blocker. Detach the opener before navigating to uploaded content.
  try{preview=window.open('about:blank','_blank');if(preview)preview.opener=null;}catch{}
  try{
   const page=await api<SharePage>('/share-page','POST',{},signal);
   if(signal.aborted||currentUserId.current!==owner){if(preview&&!preview.closed)preview.close();return;}
   const url=new URL(page.url);
   if(!['http:','https:'].includes(url.protocol))throw new Error('分享地址无效，请重试');
   if(preview){if(!preview.closed)preview.location.replace(url.href);}
   else window.location.assign(url.href);
  }catch(e){
   if(preview&&!preview.closed)preview.close();
   if(!signal.aborted&&currentUserId.current===owner)setError((e as Error).message||'暂时无法打开分享页，请重试');
  }finally{
   if(shareOpenLock.current===operation){shareOpenLock.current=null;if(!signal.aborted&&currentUserId.current===owner)setOpeningShare(false);}
  }
 }
 async function removeProject(){
  if(!selected||selected.ownerId!==user?.id||busy||active(task)||selectionBusy||deleting||versionSwitchLock.current||deleteLock.current)return;
  const projectId=selected.id,operation=Symbol('delete-project'),signal=updateController.current.signal;
  deleteLock.current=operation;setDeleting(true);setError('');setNotice('');
  try{
   try{
    const result=await api<{ok:boolean}>('/projects/'+projectId,'DELETE',undefined,signal);
    if(!result.ok)throw new Error('删除未完成，请重试');
   }catch(e){if((e as {status?:number}).status!==404)throw e;}
   if(signal.aborted)return;
   setSelected(null);setTask(undefined);setSelection(null);setConfirmDelete(false);setProgress(null);setPrepareStage('');
   setProjects(items=>items.filter(p=>p.id!==projectId));setNotice('项目已删除');
   try{
    const data=await api<{items:Project[]}>('/projects','GET',undefined,signal);
    if(!signal.aborted)setProjects(data.items||[]);
   }catch{if(!signal.aborted)setError('项目已删除，列表暂时无法刷新，请稍后刷新页面。');}
  }catch(e){if(!signal.aborted)setError((e as Error).message||'删除失败，请重试');}
  finally{if(deleteLock.current===operation){deleteLock.current=null;if(!signal.aborted)setDeleting(false);}}
 }
 const pageTab=user?.role==='admin'&&tab==='users'?'users':'projects';
 const publishingUpdate=(busy&&updateSubmitLock.current&&!!selection)||active(task);
 const unpublished=selected?.status==='unpublished'&&!!selected.currentReleaseId;
 const savedOnly=task?.savedOnly===true;
 const updatedProjectVisible=task?.projectPublished??!unpublished;
 const updateTitle=savedOnly?'版本已保存':'更新成功';
 const replacedNumber=task?.replacement?task.versionNumber:targetVersion?.versionNumber;
 const replacedHistory=task?.replacement?task.isCurrent===false:!!targetVersion&&!targetVersion.isCurrent;
 const navigationItems=[{id:'projects',label:'项目',ariaLabel:'项目列表',number:'01'},...(user?.role==='admin'?[{id:'users',label:'成员',ariaLabel:'成员管理',number:'02'}]:[])];
 if(loading)return <div className="loading"><SignalMark/><span>正在打开发布台</span></div>;
 if(!user)return <div className="login">
  <LoginScene/>
  <main className="login-panel">
   <h2 className="login-heading">登录，<br/><em>开工。</em></h2>
   <LoginForm error={error} onClearError={()=>setError('')} onLogin={async(username,password)=>{const result=await api<User & {user?:User}>('/auth/login','POST',{username,password});const account=result.user||result;resetProjectWelcome(account.id);setUser(account);}}/>
   <p className="login-subtitle">没有账号或忘记密码？联系Eugene</p>
  </main>
 </div>;
 return <div className="shell">
  <aside className={'topbar'+(navigationItems.length===1?' single-navigation':'')}>
   <Brand/>
   {navigationItems.length>1&&<nav className="nav-tabs" aria-label="主导航">{navigationItems.map(item=><button key={item.id} className={pageTab===item.id?'selected':''} aria-label={item.ariaLabel} onClick={()=>{setTab(item.id);if(item.id==='users')action(async()=>setUsers((await api<{items:User[]}>('/admin/users')).items));}}><span className="nav-number" aria-hidden="true">{item.number}</span>{item.label}</button>)}</nav>}
   <div className="account"><span className="avatar" aria-hidden="true">{user.username.slice(0,1).toUpperCase()}</span><div><strong className="account-name">{user.username}</strong><span className="account-role">{user.role==='admin'?'管理员':'团队成员'}</span></div><button className="logout" aria-label="退出登录" onClick={()=>action(async()=>{await api('/auth/logout','POST');setUser(null);setSelected(null);setTask(undefined);})}>退出<ActionIcon name="logout"/></button></div>
  </aside>
  <main className="workspace">
   {pageTab==='projects'?<ProjectWelcome key={user.id} userId={user.id} count={projects.length} published={projects.filter(p=>p.status==='published').length} blocked={!!selected||showCreate||showShare||!!resetUser||busy||openingShare||ordering} openingShare={openingShare} onOpenShare={openOwnShare} onShare={()=>setShowShare(true)} onCreate={()=>setShowCreate(true)}/>:<header className="masthead" key={pageTab} data-pointer-surface="hero">
    <div className="headline-block"><span className="eyebrow">GOOD COMPANY / 02</span><h1 aria-label="成员管理"><span>一起</span><em>创造<span className="title-dot">。</span></em></h1></div>
    <button type="button" className="hero-mark share-orb" data-pointer-surface="orb" onClick={openOwnShare} disabled={openingShare||busy} aria-label="查看我的全部原型" aria-busy={openingShare} title={openingShare?'正在打开分享页…':'查看我的全部原型'}><SignalMark/></button>
   </header>}
   {error&&!selected&&<div className="alert" role="alert">{error}<button onClick={()=>setError('')} aria-label="关闭错误">×</button></div>}
   {notice&&!selected&&<div className="success toast" role="status"><span aria-hidden="true">✓</span>{notice}<button onClick={()=>setNotice('')} aria-label="关闭提示">×</button></div>}
   {pageTab==='projects'?<div className="project-content">
    {!projects.length?<div className="empty"><span className="empty-number" aria-hidden="true">000</span><h2 className="empty-title">下一个好点子，<br/>从这里出发。</h2><button className="empty-create" aria-label="创建项目" onClick={()=>setShowCreate(true)}><span aria-hidden="true">＋</span><span>创建项目</span></button></div>:<SortableProjectGrid ids={projects.map(p=>p.id)} disabled={ordering||busy||!!selected||showCreate||showShare||!!resetUser} saving={ordering} onReorder={saveOrder}>{projects.map((p,index)=><article data-pointer-surface="card" data-project-id={p.id} tabIndex={0} aria-describedby="project-order-help" aria-label={p.name} className="project" key={p.id} style={{'--order':Math.min(index,8)} as React.CSSProperties}>
     <div className="project-top"><span className="project-number">{String(index+1).padStart(2,'0')}<span aria-hidden="true"> /</span></span><span className={'badge project-status '+(active(p.latestDeployment)?'processing':p.status)}>{active(p.latestDeployment)?'处理中':p.status==='published'?'已发布':'未发布'}</span></div>
     <div className="project-body"><h2 className="project-name" title={p.name}>{p.name}</h2><div className="timestamp">{p.lastPublishedAt?<><span>上次发布</span><strong><RelativeTime value={p.lastPublishedAt}/></strong></>:<span>等待首次发布</span>}</div>{p.latestDeployment?.status==='FAILED'&&<p className="task-error">上次上传失败，{p.status==='published'?'旧版仍可访问':'可重新上传'}</p>}</div>
     <div className="project-path" title={p.url}><span aria-hidden="true">↳</span><span>{new URL(p.url,window.location.origin).pathname}</span></div>
     <footer><button className="project-manage" onClick={()=>open(p)}>{p.ownerId===user.id?p.currentReleaseId?p.status==='published'?'发布更新':'上传更新':'首次发布':'查看详情'}</button>{p.ownerId===user.id&&<button className="project-versions" onClick={()=>open(p,'versions')}>版本管理</button>}{p.status==='published'&&<><button className="project-copy" onClick={()=>copy(p.url)}>复制链接</button><a className="project-open" href={p.url} target="_blank" rel="noopener noreferrer" aria-label={'打开原型：'+p.name}><ActionIcon name="external"/></a></>}</footer>
    </article>)}<button className="create-tile" onClick={()=>setShowCreate(true)}><span aria-hidden="true">＋</span><strong>下一个，轮到你。</strong><span>创建项目</span></button></SortableProjectGrid>}
    <footer className="app-footer"><span aria-hidden="true">◈ GARAGE</span><span>持有链接即可查看，请勿上传敏感资料。</span></footer>
   </div>:<>
    <section className="card member-create"><div className="section-heading"><span className="eyebrow">INVITE SOMETHING GREAT</span><h2>开通成员</h2></div><form className="inline-form" onSubmit={e=>{e.preventDefault();const el=e.currentTarget;const f=new FormData(el);action(async()=>{await api('/admin/users','POST',{username:f.get('username'),password:f.get('password')});setUsers((await api<{items:User[]}>('/admin/users')).items);el.reset();setNotice('成员账号已创建');});}}><label>账号<input name="username" placeholder="成员账号" required autoComplete="off"/></label><label>初始密码<input name="password" type="password" placeholder="至少6位，可纯数字" minLength={6} required autoComplete="new-password"/></label><button data-pointer-surface="button" className="primary" disabled={busy}>创建账号</button></form></section>
    <MemberTable users={users} currentUserId={user.id} busy={busy} onRefresh={()=>action(async()=>setUsers((await api<{items:User[]}>('/admin/users')).items))} onToggle={u=>action(async()=>{await api('/admin/users/'+u.id+'/status','PATCH',{status:u.status==='active'?'disabled':'active'});setUsers((await api<{items:User[]}>('/admin/users')).items);})} onReset={u=>{setError('');setResetUser(u);}}/>
   </>}
  </main>
  {showShare&&<ShareAllModal key={user.id} isAdmin={user.role==='admin'} onClose={()=>setShowShare(false)}/>}
  {showCreate&&<CreateProjectModal key={user.id} config={config} onClose={()=>setShowCreate(false)} onChange={refresh}/>}
  {resetUser&&<ResetPasswordModal key={resetUser.id} username={resetUser.username} onClose={()=>setResetUser(null)} onSave={async(password,signal)=>{await api('/admin/users/'+resetUser.id+'/reset-password','POST',{password},signal);setNotice('密码已重置');}}/>}
  {selected&&projectView==='publish'&&<ModalFrame className={'wide project-modal'+(updateSuccess===selected.id?' is-success':'')} label={updateSuccess===selected.id?updateTitle:editingVersion?'编辑版本':'项目详情'} locked={busy||active(task)||selectionBusy||deleting} onClose={closeProjectUpload}>
   {updateSuccess===selected.id?<>
    <div className="success-mark" aria-hidden="true">✓</div><h2>{updateTitle}</h2>
    {savedOnly?<p>v{task?.versionNumber} 已保存。可在版本管理中{task?.isCurrent?'发布':'切换到'}该版本。</p>:
     <p>{!updatedProjectVisible?'文件已更新。可在版本管理中发布当前版本。':replacedNumber!=null?(replacedHistory?'v'+replacedNumber+' 的文件已覆盖，切换到该版本后生效。':'v'+replacedNumber+' 的文件已覆盖，原分享链接可查看更新。'):selected.name+' 已更新，原分享链接可查看新版。'}</p>}
    {error&&<div className="alert" role="alert">{error}</div>}{notice&&<div className="success" role="status">{notice}</div>}
    <div className="share-actions">
     {!savedOnly&&!replacedHistory&&updatedProjectVisible&&<><a href={selected.url} target="_blank" rel="noopener noreferrer">查看原型<ActionIcon name="external"/></a><button className="primary" onClick={()=>copy(selected.url)}>复制链接</button></>}
     {(savedOnly||!updatedProjectVisible)&&!editingVersion&&<button className="primary" onClick={()=>open(selected,'versions')}>版本管理</button>}
     <button disabled={busy} onClick={()=>void closeProjectUpload()}>完成</button>
    </div>
   </>:<>
   {editingVersion&&targetVersion?<><h2>编辑 v{targetVersion.versionNumber}</h2><div className="version-project-heading"><strong>{selected.name}</strong>{targetVersion.isCurrent&&<span className="version-current">当前版本</span>}</div></>:
   <InlineProjectName key={selected.id} ref={nameEditor} name={selected.name} editable={selected.ownerId===user.id} disabled={busy||active(task)||selectionBusy||deleting||versionSwitching} onSave={async(name,signal)=>{const saved=await api<Project>('/projects/'+selected.id,'PATCH',{name},signal);if(signal.aborted)return;setSelected(current=>current?.id===selected.id?{...current,name:saved.name}:current);setProjects(items=>items.map(item=>item.id===selected.id?{...item,name:saved.name}:item));try{await refresh();}catch{setNotice('名称已保存，列表稍后刷新即可更新顺序');}}}/>}
   {error&&<div role="alert" className="alert">{error}</div>}{notice&&<div className="success" role="status">{notice}</div>}
   {selected.ownerId===user.id&&<><h3>{editingVersion?'更新版本文件':selected.currentReleaseId?'上传更新':'首次上传'}</h3><form onSubmit={submitUpdate}>
    {publishingUpdate?<PublishProgress selection={selection} preparing={prepareStage} percent={progress} taskStatus={active(task)?task?.status:undefined}/>:<>
    <div className="version-upload-fields">
     {!editingVersion&&uploadVersions&&(uploadVersions.items.length>0||targetVersion)&&<VersionTarget versions={uploadVersions.items} value={noteKey} onChange={setTargetVersion} disabled={busy||selectionBusy||deleting} mustReplace={mustReplace}/>}
     {mustReplace&&!editingVersion&&<p className="small muted">已保存 {uploadVersions.retentionLimit} 个版本，请选择一个版本覆盖。</p>}
     {loadUploadVersions&&!uploadVersions&&!versionLoadError&&<p className="small muted" role="status">正在读取版本…</p>}
     {!editingVersion&&versionLoadError&&<p className="small muted">版本列表暂时无法读取。 <button type="button" onClick={()=>setVersionReload(value=>value+1)}>重试</button></p>}
     {!targetVersion&&!mustReplace&&(!loadUploadVersions||uploadVersions)&&
      <VersionPublishMode publishNow={publishNow} onChange={setPublishNow} disabled={busy||selectionBusy||deleting}/>}
     {targetVersion&&<VersionTimes uploaded={targetVersion.createdAt} updated={targetVersion.filesUpdatedAt||targetVersion.createdAt}/>}
     {targetChanged?<p className="small muted" role="status">目标版本已变化，请重新选择。</p>:targetVersion&&
      <p className="small muted">{unpublished?'更新后可在版本管理中发布当前版本。':targetVersion.isCurrent?'覆盖后，分享链接将展示新文件。':'覆盖后，切换到该版本时将展示新文件。'}</p>}
     <VersionNoteInput value={uploadNote} onChange={note=>setUploadNotes(notes=>({...notes,[noteKey]:note}))} disabled={busy||deleting}/>
    </div>
    <FileSelection value={selection} onChange={setSelection} disabled={busy||active(task)||deleting||versionSwitching} limits={config} onBusyChange={setSelectionBusy}/>
    <UploadHelp config={config} copy={copy}/>
    {task?.status==='FAILED'&&<div className="alert" role="status">上次上传失败{task.errorMessage&&<p>{task.errorMessage}</p>}{selected.status==='published'&&<p>旧版仍可访问。</p>}</div>}
    {editingVersion&&!selection?<button type="submit" className="primary full version-edit-save" disabled={busy||selectionBusy||uploadNote.trim()===(targetVersion?.note||'')}>保存备注</button>:
     <button data-pointer-surface="button" className="primary full" disabled={!selection||busy||active(task)||selectionBusy||deleting||versionSwitching||targetChanged||uploadTargetRequired}><span>{targetVersion?'覆盖 v'+targetVersion.versionNumber:!publishNow?'保存新版本':selected.currentReleaseId?'发布更新':'上传并发布'}</span><ActionIcon name="upload"/></button>}
    </>}
   </form>{!editingVersion&&!publishingUpdate&&<div className="delete-project">{confirmDelete?<div className="delete-confirm" role="group" aria-label="确认删除项目"><strong>确定删除这个项目？</strong><p>无法恢复，原分享链接将失效。</p><div className="share-actions"><button disabled={deleting} onClick={()=>setConfirmDelete(false)}>取消</button><button className="danger" disabled={busy||active(task)||selectionBusy||deleting||versionSwitching} onClick={removeProject}>{deleting?'正在删除…':'确认删除'}</button></div></div>:<button className="delete-entry" disabled={busy||active(task)||selectionBusy||deleting||versionSwitching} onClick={()=>{setError('');setConfirmDelete(true);}}>删除项目</button>}</div>}</>}
   </>}
  </ModalFrame>}
  {selected&&projectView==='versions'&&selected.ownerId===user.id&&<ModalFrame className="wide version-modal" label="版本管理" locked={versionSwitching} onClose={()=>{setSelected(null);setTask(undefined);}}>
   <h2>版本管理</h2>
   <div className="version-project-heading"><strong>{selected.name}</strong>{selected.currentVersionNumber!=null&&<span className="current-version-label">当前版本 v{selected.currentVersionNumber}</span>}</div>
   {notice&&<div className="success" role="status">{notice}</div>}
   <VersionHistory key={user.id+selected.id} projectId={selected.id} revision={[selected.currentReleaseId,selected.latestDeployment?.id,task?.status].join('|')} disabled={busy||active(task)} api={api} onBusyChange={value=>{versionSwitchLock.current=value;setVersionSwitching(value);}} onChanged={syncVersionState} onEdit={version=>open(selected,'publish',version)}/>
  </ModalFrame>}
 </div>;
}

function UploadHelp({config,copy}:{config:Config;copy:(text:string,message?:string,errorMessage?:string)=>Promise<void>}){
 return <div className="upload-help"><details><summary>文件要求与上传限制</summary><p>单个 .html 文件可任意命名。上传文件夹、多个文件或 ZIP 时，需包含 index.html 和全部资源。</p><p>压缩包上限 {size(config.maxUploadBytes)} · 文件总量 {size(config.maxExpandedBytes)}</p><button type="button" onClick={()=>copy(exportInstructions,"导出说明已复制","复制失败，请手动复制下方说明")}>复制导出说明给 AI</button><textarea readOnly rows={3} value={exportInstructions} aria-label="给 AI 的导出说明"/></details></div>;
}
function CreateProjectModal({config,onClose,onChange}:{config:Config;onClose:()=>void;onChange:()=>Promise<unknown>}){
 const [name,setName]=useState(''),[selection,setSelection]=useState<Selection|null>(null);
 const [note,setNote]=useState('');
 const [project,setProject]=useState<Project|null>(null),[task,setTask]=useState<Deployment|undefined>(),[requestBusy,setRequestBusy]=useState(false),[progress,setProgress]=useState<number|null>(null);
 const [error,setError]=useState(''),[notice,setNotice]=useState(''),[success,setSuccess]=useState(false);
 const mounted=useRef(true),savedProject=useRef<Project|null>(null),submitting=useRef(false),controller=useRef(new AbortController());
 const [selectionBusy,setSelectionBusy]=useState(false),[prepareStage,setPrepareStage]=useState('');
 const busy=requestBusy||active(task)||selectionBusy;
 const suggestedName=!name?uploadNameSuggestion(selection):'';
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;controller.current.abort();};},[]);
 async function changed(){
  if(!mounted.current)return;
  try{await onChange();}catch{if(mounted.current)setNotice('项目已保存，列表暂时未刷新；稍后刷新页面即可查看。');}
 }
 function close(){if(busy)return;onClose();}
 useEffect(()=>{
  if(!active(task))return;
  let stopped=false,timer:ReturnType<typeof setTimeout>;
  async function poll(){
   try{
    const next=await api<Deployment>('/deployments/'+task!.id,'GET',undefined,controller.current.signal);
    if(stopped||!mounted.current)return;
    setTask(next);
    if(next.status==='SUCCEEDED'){
     setSuccess(true);setSelection(null);setError('');
     const saved=savedProject.current;
     if(saved){
      try{
       const published=await api<Project>('/projects/'+saved.id,'GET',undefined,controller.current.signal);
       if(mounted.current){savedProject.current=published;setProject(published);}
      }catch{if(mounted.current)setNotice('原型已发布成功，项目信息暂时无法刷新；分享链接仍可使用。');}
     }
     await changed();return;
    }
    if(next.status==='FAILED'){setError(next.errorMessage||'发布失败，请检查文件后重试');await changed();return;}
   }catch(e){if(stopped||!mounted.current)return;setError('暂时无法查询发布结果，将自动重试。'+(e as Error).message);}
   if(!stopped&&mounted.current)timer=setTimeout(poll,2000);
  }
  timer=setTimeout(poll,500);
  return()=>{stopped=true;clearTimeout(timer);};
 },[task?.id,task?.status]);
 async function submit(e:React.FormEvent){
  e.preventDefault();if(submitting.current||busy||success)return;
  setError('');setNotice('');
  if(!name.trim()){setError('请填写项目名称');return;}
  if(!selection){setError('请选择原型文件夹、文件或 ZIP');return;}
  submitting.current=true;setRequestBusy(true);setTask(undefined);
  let deployment:Deployment|undefined;
  try{
   const archive=await prepareArchive(selection,config,stage=>{if(mounted.current)setPrepareStage(stage);},controller.current.signal);
   if(!mounted.current)return;
   setPrepareStage('');
   let current=savedProject.current;
   if(!current){
    current=await api<Project>('/projects','POST',{name:name.trim()},controller.current.signal);
    savedProject.current=current;
   }else if(current.name!==name.trim()){
    current=await api<Project>('/projects/'+current.id,'PATCH',{name:name.trim()},controller.current.signal);
    savedProject.current=current;
   }
   if(!mounted.current)return;
   setProject(current);
   deployment=await api<Deployment>('/projects/'+current.id+'/deployments','POST',{note},controller.current.signal);
   if(!mounted.current)return;
   setProgress(0);
   try{await upload(deployment.id,archive,n=>{if(mounted.current)setProgress(n);},controller.current.signal);}
   catch(uploadError){
    if(!mounted.current)return;
    // The server may still be processing after a lost upload response. Keep its
    // task identity and poll rather than creating another deployment blindly.
    setError((uploadError as Error).message);
   }
   if(mounted.current)setTask(deployment);
  }catch(e){if(mounted.current)setError((e as Error).message);}
  finally{
   submitting.current=false;
   if(mounted.current){setProgress(null);setPrepareStage('');setRequestBusy(false);await changed();}
  }
 }
 async function copyText(text:string,message='链接已复制',errorMessage='复制失败，请选中下方链接手动复制'){
  try{await navigator.clipboard.writeText(text);if(mounted.current){setError('');setNotice(message);}}
  catch{if(mounted.current)setError(errorMessage);}
 }
 return <ModalFrame className={'wide create-modal'+(success?' is-success':'')} labelledBy="create-project-title" locked={busy} onClose={close} closeLabel="关闭创建项目弹窗">
  {success&&<div className="success-mark" aria-hidden="true"><ActionIcon name="check"/></div>}
  <h2 id="create-project-title">{success?'发布成功。':'创建项目'}</h2>
  {error&&<div className="alert" role="alert">{error}</div>}{notice&&<div className="success" role="status">{notice}</div>}
  {success&&project?<>
   <label>分享链接<input readOnly value={project.url} onFocus={e=>e.currentTarget.select()}/></label>
   <div className="share-actions"><button data-pointer-surface="button" className="primary" onClick={()=>copyText(project.url)}>复制链接</button><a href={project.url} target="_blank" rel="noopener noreferrer">打开原型<ActionIcon name="external"/></a><button onClick={close}>完成</button></div>
  </>:<form onSubmit={submit}>
   <label>项目名称<input value={name} onChange={e=>setName(e.target.value)} required maxLength={projectNameMaxLength} disabled={busy}
    placeholder={suggestedName||'给这个想法起个名字'} aria-describedby={suggestedName?'project-name-suggestion':undefined}
    onKeyDown={e=>{
     if(e.key==='Tab'&&!e.shiftKey&&!e.nativeEvent.isComposing&&suggestedName)setName(suggestedName);
    }}/></label>
   {suggestedName&&<p id="project-name-suggestion" className="small muted">按 Tab 使用{selectionFolder(selection)?'文件夹名':'文件名'}，也可直接输入。</p>}
   {requestBusy||active(task)?<PublishProgress selection={selection} preparing={prepareStage} percent={progress} taskStatus={active(task)?task?.status:undefined}/>:<>
   <div className="version-upload-fields"><VersionNoteInput value={note} onChange={setNote} disabled={busy}/></div>
   <FileSelection value={selection} onChange={setSelection} disabled={requestBusy||active(task)} limits={config} onBusyChange={setSelectionBusy}/>
   <UploadHelp config={config} copy={copyText}/>
   {project&&!busy&&<p className="small muted">项目已保留，可直接重试。</p>}
   <button data-pointer-surface="button" className="primary full" disabled={busy||!selection||!config.maxUploadBytes}><span>{busy?'正在发布…':project?'重试发布':'创建并发布'}</span><ActionIcon name="upload"/></button>
   </>}
  </form>}
 </ModalFrame>;
}

function ShareAllModal({isAdmin,onClose}:{isAdmin:boolean;onClose:()=>void}){
 const [page,setPage]=useState<SharePage|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState(''),[notice,setNotice]=useState(''),[attempt,setAttempt]=useState(0);
 useEffect(()=>{
  let stopped=false;
  setLoading(true);setError('');setNotice('');
  api<SharePage>('/share-page','POST',{}).then(result=>{if(!stopped)setPage(result);}).catch(e=>{if(!stopped)setError((e as Error).message);}).finally(()=>{if(!stopped)setLoading(false);});
  return()=>{stopped=true;};
 },[attempt]);
 async function copyShare(){
  if(!page)return;
  setError('');setNotice('');
  try{await navigator.clipboard.writeText(page.url);setNotice('分享链接已复制');}
  catch{setError('复制失败，请选中下方链接后手动复制');}
 }
 return <ModalFrame className="share-modal" labelledBy="share-all-title" onClose={onClose} closeLabel="关闭分享全部原型弹窗">
  <h2 id="share-all-title">分享全部原型</h2>
  {isAdmin&&<p className="small muted">仅包含你自己的项目。</p>}
  {loading&&<p role="status" className="task-state">正在获取链接…</p>}
  {error&&<div className="alert" role="alert">{error}</div>}{notice&&<div className="success" role="status">{notice}</div>}
  {!loading&&page&&<>
   <div className="share-total"><strong>{page.publishedCount}</strong><span>个已发布原型</span></div>
   {page.publishedCount===0&&<p className="small muted">发布后会自动加入这个分享页。</p>}
   <label>固定分享链接<input aria-label="全部原型分享链接" readOnly value={page.url} onFocus={e=>e.currentTarget.select()}/></label>
   <div className="share-actions"><button data-pointer-surface="button" className="primary" onClick={copyShare}>复制链接</button><a href={page.url} target="_blank" rel="noopener noreferrer">打开分享页<ActionIcon name="external"/></a></div>
  </>}
  {!loading&&!page&&<button data-pointer-surface="button" className="primary" onClick={()=>setAttempt(n=>n+1)}>重试</button>}
 </ModalFrame>;
}

createRoot(document.getElementById('root')!).render(<App/>);

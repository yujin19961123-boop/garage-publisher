import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
import {FileSelection} from './FileSelection';
import {prepareArchive,type Selection,type UploadLimits} from './upload-input';

type User = { id:string; username:string; role:string; status:string };
type Deployment = {id:string; status:string; errorMessage?:string};
type Project = {id:string; name:string; ownerId:string; status:string; url:string; lastPublishedAt?:string; latestDeployment?:Deployment};
type SharePage = {url:string; publishedCount:number};
type Config = UploadLimits;
const active = (d?:Deployment) => !!d && !['SUCCEEDED','FAILED','succeeded','failed'].includes(d.status);
const labels:Record<string,string>={UPLOADING:'等待上传',QUEUED:'等待处理',VALIDATING:'正在检查文件',PREPARING:'正在发布',SUCCEEDED:'发布成功',FAILED:'发布失败'};
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
const time=(s?:string)=>s?new Date(s).toLocaleString('zh-CN'):'还没有发布';
const exportInstructions = `请将当前原型导出为已编译完成、可直接在浏览器访问的静态网页。
请提供包含首页 index.html 以及完整 JavaScript、CSS、图片、字体等资源的 dist 文件夹或全部编译产物，也可以提供 ZIP。发布平台会自动处理上传内容，无需用户自行打包。
不要仅提供源代码、依赖目录或需要安装依赖、在线编译、运行后端才能访问的项目。
如果页面依赖外部 API 或第三方资源，请确保它们自身可访问，并正确配置访问权限；发布平台不提供业务后端或保证这些外部服务可用。
请检查导出的页面、样式、图片及主要跳转正常。`;

function App(){
 const [user,setUser]=useState<User|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const [projects,setProjects]=useState<Project[]>([]),[users,setUsers]=useState<User[]>([]),[tab,setTab]=useState('projects'),[config,setConfig]=useState<Config>({});
 const [selected,setSelected]=useState<Project|null>(null),[editing,setEditing]=useState(false),[showCreate,setShowCreate]=useState(false),[busy,setBusy]=useState(false),[progress,setProgress]=useState<number|null>(null);
 const [task,setTask]=useState<Deployment|undefined>(),[selection,setSelection]=useState<Selection|null>(null);
 const [showShare,setShowShare]=useState(false);
 const [confirmDelete,setConfirmDelete]=useState(false),[deleting,setDeleting]=useState(false);
 const deleteLock=useRef<symbol|null>(null);
 useEffect(()=>{setConfirmDelete(false);setDeleting(false);deleteLock.current=null;setSelected(null);setTask(undefined);setSelection(null);},[user?.id]);
 const updateController=useRef(new AbortController());
 useEffect(()=>{updateController.current=new AbortController();return()=>updateController.current.abort();},[user?.id]);
 const [selectionBusy,setSelectionBusy]=useState(false),[prepareStage,setPrepareStage]=useState('');
 useEffect(()=>{setShowShare(false);setShowCreate(false);},[user?.id]);
 const refresh=async()=>{const data=await api<{items:Project[]}>('/projects');const items=data.items||[];setProjects(items);setSelected(p=>p?(items.find(x=>x.id===p.id)||p):null);return items;};
 useEffect(()=>{api<{user:User}>('/me').then(result=>setUser(result.user)).catch(()=>{}).finally(()=>setLoading(false));const expired=()=>{setUser(null);setError('登录已失效，请重新登录');};window.addEventListener('session-expired',expired);return()=>window.removeEventListener('session-expired',expired);},[]);
 useEffect(()=>{if(!user)return;refresh().catch(e=>setError(e.message));api<Config>('/platform-config').then(setConfig).catch(e=>setError(e.message));},[user]);
 useEffect(()=>{if(!user||!active(task))return;let stopped=false;const timer=setInterval(async()=>{try{const d=await api<Deployment>('/deployments/'+task!.id);if(stopped)return;setTask(d);if(!active(d)){const items=await refresh();if(!stopped)setSelected(p=>items.find(x=>x.id===p?.id)||p);}}catch(e){if(!stopped)setError((e as Error).message);}},2000);return()=>{stopped=true;clearInterval(timer);};},[user?.id,task?.id,task?.status]);
 async function action(fn:()=>Promise<void>){setError('');setNotice('');setBusy(true);try{await fn();}catch(e){setError((e as Error).message);}finally{setBusy(false);setPrepareStage('');}}
 function open(p:Project){setConfirmDelete(false);setSelected(p);setTask(p.latestDeployment);setSelection(null);setEditing(false);setError('');setNotice('');setProgress(null);}
 async function copy(text:string,message='链接已复制',errorMessage='复制失败，请选中链接后手动复制'){try{await navigator.clipboard.writeText(text);setNotice(message);}catch{setError(errorMessage);}}
 async function removeProject(){
  if(!selected||selected.ownerId!==user?.id||busy||active(task)||selectionBusy||deleting||deleteLock.current)return;
  const projectId=selected.id,operation=Symbol('delete-project'),signal=updateController.current.signal;
  deleteLock.current=operation;setDeleting(true);setError('');setNotice('');
  try{
   try{
    const result=await api<{ok:boolean}>('/projects/'+projectId,'DELETE',undefined,signal);
    if(!result.ok)throw new Error('删除未完成，请重试');
   }catch(e){if((e as {status?:number}).status!==404)throw e;}
   if(signal.aborted)return;
   setSelected(null);setTask(undefined);setSelection(null);setConfirmDelete(false);setEditing(false);setProgress(null);setPrepareStage('');
   setProjects(items=>items.filter(p=>p.id!==projectId));setNotice('项目已删除');
   try{
    const data=await api<{items:Project[]}>('/projects','GET',undefined,signal);
    if(!signal.aborted)setProjects(data.items||[]);
   }catch{if(!signal.aborted)setError('项目已删除，列表暂时无法刷新，请稍后刷新页面。');}
  }catch(e){if(!signal.aborted)setError((e as Error).message||'删除失败，请重试');}
  finally{if(deleteLock.current===operation){deleteLock.current=null;if(!signal.aborted)setDeleting(false);}}
 }
 if(loading)return <div className="loading">正在打开发布台…</div>;
 if(!user)return <div className="login"><div className="intro"><span className="eyebrow">团队原型分享</span><h1>让想法，<br/>拥有一个链接。</h1><p>上传原型文件，获得分享链接。<br/>后续更新，继续分享原来的地址。</p><span className="intro-note">团队原型 · 自助发布</span></div><main className="login-panel"><div className="brand">◈ 原型发布台</div><h2>欢迎回来</h2><p className="muted">使用管理员为你开通的账号登录</p>{error&&<div role="alert" className="alert">{error}</div>}<form onSubmit={e=>{e.preventDefault();const f=new FormData(e.currentTarget);action(async()=>{const result=await api<User & {user?:User}>('/auth/login','POST',{username:f.get('username'),password:f.get('password')});setUser(result.user||result);});}}><label>账号<input name="username" autoComplete="username" required autoFocus/></label><label>密码<input name="password" type="password" autoComplete="current-password" required/></label><button disabled={busy} className="primary full">{busy?'正在登录…':'登录'}</button></form><p className="small muted">忘记密码或需要账号？请联系管理员。</p></main></div>;
 return <div className="shell"><aside><div className="brand">◈ 原型发布台</div><p className="side-caption">把原型带给每个人</p><nav><button className={tab==='projects'?'selected':''} onClick={()=>setTab('projects')}>▦ 项目列表</button>{user.role==='admin'&&<button className={tab==='users'?'selected':''} onClick={()=>{setTab('users');action(async()=>setUsers((await api<{items:User[]}>('/admin/users')).items));}}>♙ 成员管理</button>}</nav><div className="account"><strong>{user.username}</strong><span>{user.role==='admin'?'管理员':'团队成员'}</span><button onClick={()=>action(async()=>{await api('/auth/logout','POST');setUser(null);setSelected(null);setTask(undefined);})}>退出登录</button></div></aside><main className="workspace"><header><div><span className="eyebrow">原型分享</span><h1>{tab==='projects'?'项目列表':'成员管理'}</h1><p className="muted">{tab==='projects'?'管理原型、发布更新，让分享保持简单。':'开通与停用成员账号，管理团队访问。'}</p></div>{tab==='projects'&&<div className="header-actions"><button onClick={()=>setShowShare(true)}>分享全部原型</button><button className="primary" onClick={()=>setShowCreate(true)}>＋ 创建项目</button></div>}</header>{error&&<div className="alert" role="alert">{error}<button onClick={()=>setError('')} aria-label="关闭错误">×</button></div>}{notice&&<div className="success" role="status">{notice}</div>}
 {tab==='projects'?<><div className="summary"><span><strong>{projects.length}</strong> 个项目</span><span><strong>{projects.filter(p=>p.lastPublishedAt).length}</strong> 已发布</span><span>固定链接 · 更新无需重新分享</span></div>{!projects.length?<div className="empty"><div>◈</div><h2>发布你的第一个原型</h2><p>先给原型起个名字，再上传原型文件，即可分享。</p><button onClick={()=>setShowCreate(true)} className="primary">创建项目</button></div>:<div className="project-grid">{projects.map(p=><article className="project" key={p.id}><div className="project-top"><span className="project-icon">◈</span><span className={'badge '+(p.lastPublishedAt?'published':'')}>{p.lastPublishedAt?'已发布':'未发布'}</span></div><h2>{p.name}</h2><div className="timestamp">上次发布<br/><strong>{time(p.lastPublishedAt)}</strong></div>{p.latestDeployment?.status==='FAILED'&&<p className="task-error">上次发布没有成功</p>}{p.lastPublishedAt&&<div className="url">{p.url}</div>}<footer><button onClick={()=>open(p)}>{p.ownerId===user.id?'发布 / 更新':'查看详情'}</button>{p.lastPublishedAt&&<><button onClick={()=>copy(p.url)}>复制链接</button><a href={p.url} target="_blank" rel="noopener noreferrer">打开 ↗</a></>}</footer></article>)}</div>}<div className="footnote">任何拿到链接的人都能查看，请勿上传客户资料、密码等敏感信息。</div></>:<><section className="card"><h2>开通成员账号</h2><form className="inline-form" onSubmit={e=>{e.preventDefault();const el=e.currentTarget;const f=new FormData(el);action(async()=>{await api('/admin/users','POST',{username:f.get('username'),password:f.get('password')});setUsers((await api<{items:User[]}>('/admin/users')).items);el.reset();setNotice('成员账号已创建');});}}><label>账号<input name="username" required autoComplete="off"/></label><label>初始密码（至少6位，可纯数字）<input name="password" type="password" minLength={6} required autoComplete="new-password"/></label><button className="primary" disabled={busy}>创建账号</button></form></section><section className="card"><div className="table-scroll"><table><thead><tr><th>账号</th><th>角色</th><th>状态</th><th>操作</th></tr></thead><tbody>{users.map(u=><tr key={u.id}><td>{u.username}</td><td>{u.role==='admin'?'管理员':'成员'}</td><td>{u.status==='active'?'正常':'已停用'}</td><td>{u.id!==user.id&&u.role!=='admin'&&<><button disabled={busy} onClick={()=>action(async()=>{await api('/admin/users/'+u.id+'/status','PATCH',{status:u.status==='active'?'disabled':'active'});setUsers((await api<{items:User[]}>('/admin/users')).items);})}>{u.status==='active'?'停用':'启用'}</button><button disabled={busy} onClick={()=>{const password=prompt('输入新密码（至少 6 位，可纯数字）；重置后该成员需重新登录。');if(password)action(async()=>{await api('/admin/users/'+u.id+'/reset-password','POST',{password});setNotice('密码已重置');});}}>重置密码</button></>}</td></tr>)}</tbody></table></div></section></>}
 </main>{showShare&&<ShareAllModal key={user.id} isAdmin={user.role==="admin"} onClose={()=>setShowShare(false)}/>} {showCreate&&<CreateProjectModal key={user.id} config={config} onClose={()=>setShowCreate(false)} onChange={refresh}/>}
 {selected&&<div className="overlay"><section className="modal wide" role="dialog" aria-modal="true" aria-label="项目详情"><button className="close" onClick={()=>{if(busy||active(task)||selectionBusy||deleting||deleteLock.current){setError(deleting?'正在删除项目，请稍候':'正在处理文件，请等待发布完成后关闭');return;}setSelected(null);setTask(undefined);setConfirmDelete(false);}}>×</button><span className="eyebrow">项目详情</span><h2>{selected.name}</h2>{error&&<div role="alert" className="alert">{error}</div>}{notice&&<div className="success" role="status">{notice}</div>}{selected.ownerId===user.id&&<button className="text-button" disabled={deleting} onClick={()=>setEditing(!editing)}>{editing?'收起编辑':'编辑名称'}</button>}{editing&&<ProjectForm project={selected} busy={busy||deleting} onSave={(name)=>action(async()=>{const p=await api<Project>('/projects/'+selected.id,'PATCH',{name});setSelected(p);await refresh();setEditing(false);})}/>}{selected.lastPublishedAt?<div className="link-panel"><span>分享链接</span><a href={selected.url} target="_blank" rel="noopener noreferrer">{selected.url}</a><button onClick={()=>copy(selected.url)}>复制链接</button><small>上次发布：{time(selected.lastPublishedAt)}</small></div>:<p className="muted small">上传文件并发布成功后，这里会显示分享链接。</p>}{selected.ownerId===user.id&&<><h3>{selected.lastPublishedAt?'上传更新':'首次发布'}</h3><UploadHelp config={config} copy={copy}/><form onSubmit={e=>{e.preventDefault();if(!selection||deleting||deleteLock.current)return;action(async()=>{setTask(undefined);const signal=updateController.current.signal;const archive=await prepareArchive(selection,config,setPrepareStage,signal);setPrepareStage('');const d=await api<Deployment>('/projects/'+selected.id+'/deployments','POST',{},signal);setTask(d);setProgress(0);try{await upload(d.id,archive,setProgress,signal);setTask(await api<Deployment>('/deployments/'+d.id));}catch(err){setTask(await api<Deployment>('/deployments/'+d.id).catch(()=>undefined));throw err;}finally{setProgress(null);await refresh();}});}}><FileSelection value={selection} onChange={setSelection} disabled={busy||active(task)||deleting} limits={config} onBusyChange={setSelectionBusy}/>{prepareStage&&<p role="status" className="task-state">{prepareStage}</p>}{progress!==null&&<><progress value={progress} max={100}/><p className="small">上传进度 {progress}%</p></>}{task&&<div className={task.status==='FAILED'?'alert':'task-state'} role="status">{labels[task.status.toUpperCase()]||'正在发布'}{task.errorMessage&&<p>{task.errorMessage}</p>}{task.status==='FAILED'&&selected.lastPublishedAt&&<p>之前发布的内容仍可打开，请检查文件后重新上传。</p>}</div>}<button className="primary full" disabled={!selection||busy||active(task)||selectionBusy||deleting}>{busy?'正在上传…':active(task)?'处理中，请稍候':selected.lastPublishedAt?'更新原型':'上传并发布'}</button></form><p className="small muted">更新后链接不变。已经打开原型的人，刷新页面即可查看新内容。</p><div className="delete-project">{confirmDelete?<div className="delete-confirm" role="group" aria-label="确认删除项目"><strong>确定删除这个项目？</strong><p>删除后无法恢复，原分享链接将失效，合集也不再展示。</p><div className="share-actions"><button disabled={deleting} onClick={()=>setConfirmDelete(false)}>取消</button><button className="danger" disabled={busy||active(task)||selectionBusy||deleting} onClick={removeProject}>{deleting?"正在删除…":"确认删除"}</button></div></div>:<button className="delete-entry" disabled={busy||active(task)||selectionBusy||deleting} onClick={()=>{setError("");setConfirmDelete(true);}}>删除项目</button>}</div></>}</section></div>}</div>;
}
function UploadHelp({config,copy}:{config:Config;copy:(text:string,message?:string,errorMessage?:string)=>Promise<void>}){return <div className="upload-help">文件夹、文件或 ZIP 都可直接上传，系统自动处理，无需关心部署路径。<details><summary>文件怎么准备？</summary><p>选择生成原型时得到的 <code>dist</code> 文件夹，或拖入里面的全部内容。系统会自动寻找首页 <code>index.html</code>，无需自己打包。</p><p>请上传已编译的静态网页及完整资源。更新已有项目时，分享链接保持不变。</p><p>不知道怎么导出？可以把下面的说明复制给帮你生成原型的 AI。</p><button type="button" onClick={()=>copy(exportInstructions,"导出说明已复制，可以粘贴给 AI","复制失败，请选中下方导出说明后手动复制")}>复制给 AI 的导出说明</button><textarea readOnly rows={8} value={exportInstructions} aria-label="给 AI 的导出说明"/><p>文件总大小不超过 {size(config.maxExpandedBytes)}，整理后的上传大小不超过 {size(config.maxUploadBytes)}。</p></details></div>;}
function CreateProjectModal({config,onClose,onChange}:{config:Config;onClose:()=>void;onChange:()=>Promise<unknown>}){
 const [name,setName]=useState(''),[selection,setSelection]=useState<Selection|null>(null);
 const [project,setProject]=useState<Project|null>(null),[task,setTask]=useState<Deployment|undefined>(),[requestBusy,setRequestBusy]=useState(false),[progress,setProgress]=useState<number|null>(null);
 const [error,setError]=useState(''),[notice,setNotice]=useState(''),[success,setSuccess]=useState(false);
 const mounted=useRef(true),savedProject=useRef<Project|null>(null),submitting=useRef(false),controller=useRef(new AbortController());
 const [selectionBusy,setSelectionBusy]=useState(false),[prepareStage,setPrepareStage]=useState('');
 const busy=requestBusy||active(task)||selectionBusy;
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;controller.current.abort();};},[]);
 async function changed(){
  if(!mounted.current)return;
  try{await onChange();}catch{if(mounted.current)setNotice('项目已保存，列表暂时未刷新；稍后刷新页面即可查看。');}
 }
 function close(){if(busy)return;onClose();}
 useEffect(()=>{const escape=(e:KeyboardEvent)=>{if(e.key==='Escape'){e.preventDefault();if(!busy)onClose();}};document.addEventListener('keydown',escape);return()=>document.removeEventListener('keydown',escape);},[busy,onClose]);
 useEffect(()=>{
  if(!active(task))return;
  let stopped=false,timer:ReturnType<typeof setTimeout>;
  async function poll(){
   try{
    const next=await api<Deployment>('/deployments/'+task!.id,'GET',undefined,controller.current.signal);
    if(stopped||!mounted.current)return;
    setTask(next);
    if(next.status==='SUCCEEDED'){
     setSuccess(true);setError('');
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
   deployment=await api<Deployment>('/projects/'+current.id+'/deployments','POST',{},controller.current.signal);
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
 return <div className="overlay"><section className="modal wide" role="dialog" aria-modal="true" aria-labelledby="create-project-title" aria-busy={busy}>
  <button className="close" aria-label="关闭创建项目弹窗" disabled={busy} onClick={close}>×</button>
  <h2 id="create-project-title">{success?'发布成功':'创建项目'}</h2>
  <p className="muted">{success?'原型已经可以打开，把链接发给需要查看的人。':'填写项目名称并上传原型文件，在这里完成创建与发布。'}</p>
  {error&&<div className="alert" role="alert">{error}</div>}{notice&&<div className="success" role="status">{notice}</div>}
  {success&&project?<><label>分享链接<input readOnly value={project.url} onFocus={e=>e.currentTarget.select()}/></label><div className="share-actions"><button className="primary" onClick={()=>copyText(project.url)}>复制链接</button><a href={project.url} target="_blank" rel="noopener noreferrer">打开原型 ↗</a><button onClick={close}>完成</button></div>{project.lastPublishedAt&&<p className="small muted">发布时间：{time(project.lastPublishedAt)}</p>}<p className="small muted">后续更新仍使用这个链接。</p></>:<form onSubmit={submit}>
   <label>项目名称<input value={name} onChange={e=>setName(e.target.value)} required maxLength={100} disabled={busy} placeholder="例如：新版登录流程" autoFocus/></label>

   <UploadHelp config={config} copy={copyText}/>
   <FileSelection value={selection} onChange={setSelection} disabled={requestBusy||active(task)} limits={config} onBusyChange={setSelectionBusy}/>
   {prepareStage&&<p role="status" className="task-state">{prepareStage}</p>}
   {progress!==null&&<><progress value={progress} max={100}/><p role="status" className="small">上传进度 {progress}%</p></>}
   {active(task)&&<p className="task-state" role="status">{labels[task!.status]||'正在发布'}…</p>}
   {busy&&<p className="small muted">正在创建或发布，请等待完成；期间暂时不能关闭此窗口。</p>}
   {project&&!busy&&<p className="small muted">项目已保存。可以在这里重试；关闭后也能从项目列表继续发布，不会重复创建项目。</p>}
   <button className="primary full" disabled={busy||!selection||!config.maxUploadBytes}>{busy?'正在发布，请稍候…':project?'重试发布':'创建并发布'}</button>
  </form>}
 </section></div>;
}
function ShareAllModal({isAdmin,onClose}:{isAdmin:boolean;onClose:()=>void}){
 const [page,setPage]=useState<SharePage|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState(''),[notice,setNotice]=useState(''),[attempt,setAttempt]=useState(0);
 useEffect(()=>{
  let stopped=false;
  setLoading(true);setError('');setNotice('');
  api<SharePage>('/share-page','POST',{}).then(result=>{if(!stopped)setPage(result);}).catch(e=>{if(!stopped)setError((e as Error).message);}).finally(()=>{if(!stopped)setLoading(false);});
  return()=>{stopped=true;};
 },[attempt]);
 useEffect(()=>{const escape=(e:KeyboardEvent)=>{if(e.key==='Escape')onClose();};document.addEventListener('keydown',escape);return()=>document.removeEventListener('keydown',escape);},[onClose]);
 async function copyShare(){
  if(!page)return;
  setError('');setNotice('');
  try{await navigator.clipboard.writeText(page.url);setNotice('分享链接已复制');}
  catch{setError('复制失败，请选中下方链接后手动复制');}
 }
 return <div className="overlay"><section className="modal share-modal" role="dialog" aria-modal="true" aria-labelledby="share-all-title" aria-busy={loading}>
  <button className="close" onClick={onClose} aria-label="关闭分享全部原型弹窗" autoFocus>×</button>
  <h2 id="share-all-title">分享全部原型</h2>
  <p className="muted">这个链接展示你所有已发布的项目。以后发布的新项目也会自动加入，更新后不用重新分享。</p>
  {isAdmin&&<p className="small muted">仅包含你创建并发布的项目，不包含其他成员的项目。</p>}
  {loading&&<p role="status" className="task-state">正在获取分享链接…</p>}
  {error&&<div className="alert" role="alert">{error}</div>}
  {notice&&<div className="success" role="status">{notice}</div>}
  {!loading&&page&&<><p className="small">{page.publishedCount===0?'你还没有已发布的原型。可以先分享这个链接，发布后会自动展示。':`当前展示 ${page.publishedCount} 个已发布的原型。`}</p>
   <label>固定分享链接<input aria-label="全部原型分享链接" readOnly value={page.url} onFocus={e=>e.currentTarget.select()}/></label>
   <div className="share-actions"><button className="primary" onClick={copyShare}>复制链接</button><a href={page.url} target="_blank" rel="noopener noreferrer">打开分享页 ↗</a></div>
  </>}
  {!loading&&!page&&<button className="primary" onClick={()=>setAttempt(n=>n+1)}>重试</button>}
 </section></div>;
}
function ProjectForm({project,busy,onSave}:{project?:Project;busy:boolean;onSave:(name:string)=>void}){return <form onSubmit={e=>{e.preventDefault();const f=new FormData(e.currentTarget);onSave(String(f.get('name')).trim());}}><label>项目名称<input name="name" placeholder="例如：新版登录流程" required maxLength={100} defaultValue={project?.name}/></label><button className="primary" disabled={busy}>{busy?'保存中…':project?'保存修改':'下一步：上传文件'}</button></form>;}
createRoot(document.getElementById('root')!).render(<App/>);

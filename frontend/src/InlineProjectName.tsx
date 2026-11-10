import {forwardRef,useEffect,useImperativeHandle,useRef,useState} from 'react';

export type NameEditor={commit:()=>Promise<boolean>};
type Props={name:string;editable:boolean;disabled:boolean;onSave:(name:string,signal:AbortSignal)=>Promise<void>};

export const InlineProjectName=forwardRef<NameEditor,Props>(function InlineProjectName({name,editable,disabled,onSave},ref){
 const [editing,setEditing]=useState(false),[draft,setDraft]=useState(name),[error,setError]=useState(''),[saving,setSaving]=useState(false);
 const input=useRef<HTMLInputElement>(null),alive=useRef(true),pending=useRef<Promise<boolean>|null>(null),controller=useRef<AbortController|null>(null);
 const draftRef=useRef(draft);draftRef.current=draft;
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;controller.current?.abort();};},[]);
 useEffect(()=>{if(!editing)setDraft(name);},[name,editing]);
 useEffect(()=>{if(editing){input.current?.focus();input.current?.select();}},[editing]);
 function commit():Promise<boolean>{
  if(pending.current)return pending.current;
  if(!editing||!editable)return Promise.resolve(true);
  const value=draftRef.current.trim();
  if(!value){setError('项目名称不能为空');return Promise.resolve(false);}
  if(value===name){setError('');setEditing(false);return Promise.resolve(true);}
  const abort=new AbortController();controller.current=abort;setSaving(true);setError('');
  const request=(async()=>{
   try{await onSave(value,abort.signal);if(!alive.current||abort.signal.aborted)return false;setDraft(value);setEditing(false);return true;}
   catch(e){if(alive.current&&!abort.signal.aborted)setError((e as Error).message||'名称未保存，请重新编辑后移开光标重试');return false;}
   finally{pending.current=null;if(alive.current)setSaving(false);}
  })();
  pending.current=request;return request;
 }
 useImperativeHandle(ref,()=>({commit}));
 return <>
  <h2 className="project-name-heading">{editable?(editing?<input ref={input} className="project-name-input" aria-label="项目名称" aria-invalid={!!error} aria-describedby={error?'project-name-error':undefined} maxLength={100} value={draft} readOnly={saving} onChange={e=>{draftRef.current=e.target.value;setDraft(e.target.value);setError('');}} onBlur={()=>{void commit();}} onKeyDown={e=>{
   if(e.nativeEvent.isComposing)return;
   if(e.key==='Enter'){e.preventDefault();e.stopPropagation();e.currentTarget.blur();}
   if(e.key==='Escape'){e.preventDefault();e.stopPropagation();if(!pending.current){draftRef.current=name;setDraft(name);setError('');setEditing(false);}}
  }}/>:<button type="button" className="project-name-button" title="点击修改项目名称" disabled={disabled} onClick={()=>{setDraft(name);draftRef.current=name;setError('');setEditing(true);}}>{name}</button>):name}</h2>
  {saving&&<span className="name-save-state" role="status">保存中…</span>}
  {error&&<p id="project-name-error" className="name-save-error" role="alert">{error}</p>}
 </>;
});

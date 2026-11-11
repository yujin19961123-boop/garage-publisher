import {useEffect,useRef,useState} from 'react';
import {ModalFrame} from './ModalFrame';

export function ResetPasswordModal({username,onSave,onClose}:{username:string;onSave:(password:string,signal:AbortSignal)=>Promise<void>;onClose:()=>void}){
 const [password,setPassword]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const mounted=useRef(true),pending=useRef(false),controller=useRef(new AbortController());
 useEffect(()=>{mounted.current=true;if(controller.current.signal.aborted)controller.current=new AbortController();return()=>{mounted.current=false;controller.current.abort();};},[]);
 async function submit(e:React.FormEvent){
  e.preventDefault();if(pending.current)return;
  pending.current=true;setBusy(true);setError('');
  try{await onSave(password,controller.current.signal);if(mounted.current)onClose();}
  catch(e){if(mounted.current)setError((e as Error).message||'重置失败，请重试');}
  finally{pending.current=false;if(mounted.current)setBusy(false);}
 }
 return <ModalFrame labelledBy="reset-password-title" locked={busy} onClose={onClose}>
  <span className="modal-index">MEMBER / ACCESS</span><h2 id="reset-password-title">重置密码</h2>
  <p className="muted">账号：{username}</p>
  {error&&<div className="alert" role="alert">{error}</div>}
  <form onSubmit={submit}><label>新密码<input type="password" name="password" value={password} onChange={e=>setPassword(e.target.value)} minLength={6} required disabled={busy} placeholder="至少6位，可纯数字" autoComplete="new-password"/></label><p className="small muted">重置后，该成员需要重新登录。</p><button data-pointer-surface="button" className="primary full" disabled={busy}><span>{busy?'正在重置…':'重置密码'}</span></button></form>
 </ModalFrame>;
}

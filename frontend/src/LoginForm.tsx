import {useRef, useState} from 'react';
import {ActionIcon} from './ActionIcon';

function FieldIcon({password = false}: {password?: boolean}) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{password ? <><rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/></> : <><circle cx="12" cy="8" r="4"/><path d="M5 21v-2a7 7 0 0 1 14 0v2"/></>}</svg>;
}

export function LoginForm({error, onClearError, onLogin}: {error: string; onClearError: () => void; onLogin: (username: string, password: string) => Promise<void>}) {
  const [visible, setVisible] = useState(false), [capsLock, setCapsLock] = useState(false);
  const [pending, setPending] = useState(false), [failure, setFailure] = useState('');
  const submitting = useRef(false);
  const message = failure || error;
  function edited() { if (failure) setFailure(''); if (error) onClearError(); }

  return <form className="login-form" aria-busy={pending} onInput={edited} onSubmit={async event => {
    event.preventDefault();
    if (submitting.current) return;
    const form = event.currentTarget, data = new FormData(form);
    const username = String(data.get('username') || '').trim();
    if (!username) { setFailure('请输入账号'); form.querySelector<HTMLInputElement>('[name="username"]')?.focus(); return; }
    submitting.current = true; setPending(true); setFailure(''); onClearError();
    try { await onLogin(username, String(data.get('password') || '')); }
    catch (cause) { setFailure(cause instanceof Error ? cause.message : '暂时无法登录，请重试'); }
    finally { submitting.current = false; setPending(false); }
  }}>
    <div className="login-field">
      <label htmlFor="login-username">账号</label>
      <div className="login-input-shell">
        <span className="login-field-icon"><FieldIcon/></span>
        <input id="login-username" name="username" placeholder="输入你的账号" autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} required autoFocus readOnly={pending} aria-describedby={message ? 'login-feedback' : undefined}/>
      </div>
    </div>
    <div className="login-field">
      <label htmlFor="login-password">密码</label>
      <div className="login-input-shell">
        <span className="login-field-icon"><FieldIcon password/></span>
        <input id="login-password" name="password" placeholder="输入密码" type={visible ? 'text' : 'password'} autoComplete="current-password" required readOnly={pending} aria-describedby={[capsLock ? 'login-caps-lock' : '', message ? 'login-feedback' : ''].filter(Boolean).join(' ') || undefined} onKeyDown={event => setCapsLock(event.getModifierState('CapsLock'))} onKeyUp={event => setCapsLock(event.getModifierState('CapsLock'))} onBlur={() => setCapsLock(false)}/>
        <button className="login-reveal" type="button" aria-label={visible ? '隐藏密码' : '显示密码'} aria-pressed={visible} title={visible ? '隐藏密码' : '显示密码'} disabled={pending} onMouseDown={event => event.preventDefault()} onClick={() => setVisible(value => !value)}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>{visible && <path d="m3 3 18 18"/>}</svg>
        </button>
      </div>
      {capsLock && <p id="login-caps-lock" className="login-caps-lock" role="status">大写锁定已开启</p>}
    </div>
    {message && <p id="login-feedback" className="login-feedback" role="alert">{message}</p>}
    <button type="submit" disabled={pending} data-pointer-surface="button" className="primary full" aria-label="登录"><span>{pending ? '正在登录…' : '进入发布台'}</span>{pending ? <span className="login-pending" aria-hidden="true"/> : <ActionIcon name="next"/>}</button>
  </form>;
}

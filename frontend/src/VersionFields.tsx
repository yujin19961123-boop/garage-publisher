import {useEffect,useId,useRef,useState,type KeyboardEvent} from 'react';
import {ActionIcon} from './ActionIcon';
import {exactTime} from './relative-time';

export type Version = {
  id: string;
  versionNumber: number;
  createdAt: string;
  filesUpdatedAt?: string;
  note?: string;
  isCurrent: boolean;
  canActivate: boolean;
  filesState: 'available' | 'missing';
};

export type Versions = {
  items: Version[];
  currentReleaseId: string | null;
  busy: boolean;
  cleanupPending: boolean;
  retentionLimit: number;
  published?: boolean;
};

export function VersionTimestamp({label, value}: {label: string; value: string}) {
  return <div className="version-timestamp"><span>{label}：</span><time dateTime={value}>{exactTime(value).slice(0, 16)}</time></div>;
}

export function VersionTimes({uploaded, updated}: {uploaded: string; updated?: string | null}) {
  return <dl className="version-times">
    <div><dt>创建时间</dt><dd><time dateTime={uploaded}>{exactTime(uploaded).slice(0, 16)}</time></dd></div>
    {updated && <div><dt>文件更新时间</dt><dd><time dateTime={updated}>{exactTime(updated).slice(0, 16)}</time></dd></div>}
  </dl>;
}

export function VersionTarget({versions, value, onChange, disabled, mustReplace}: {
  versions: Version[];
  value: string;
  onChange: (version: Version | null) => void;
  disabled: boolean;
  mustReplace: boolean;
}) {
  const id=useId();
  const root=useRef<HTMLDivElement>(null);
  const activeOption=useRef<HTMLDivElement>(null);
  const [open,setOpen]=useState(false),[activeKey,setActiveKey]=useState('');
  const choices=[
    ...(mustReplace?[]:[{key:'',label:'创建新版本',version:null}]),
    ...versions.map(version=>({key:version.id,label:'覆盖 v'+version.versionNumber,version})),
  ];
  const selected=choices.find(choice=>choice.key===value);
  const activeIndex=choices.findIndex(choice=>choice.key===activeKey);
  const expanded=open&&!disabled&&choices.length>0;

  useEffect(()=>{
    if(!expanded)return;
    function dismiss(event:PointerEvent){
      if(event.target instanceof Node&&!root.current?.contains(event.target))setOpen(false);
    }
    document.addEventListener('pointerdown',dismiss);
    return()=>document.removeEventListener('pointerdown',dismiss);
  },[expanded]);
  useEffect(()=>{
    if(expanded)activeOption.current?.scrollIntoView({block:'nearest'});
  },[expanded,activeIndex]);

  function choose(index:number){
    const choice=choices[index];
    if(!choice)return;
    onChange(choice.version);
    setOpen(false);
  }
  function keyDown(event:KeyboardEvent<HTMLButtonElement>){
    if(event.key==='Tab'){setOpen(false);return;}
    if(expanded&&event.key==='Escape'){
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      return;
    }
    if(expanded&&(event.key==='Enter'||event.key===' ')){
      event.preventDefault();
      choose(activeIndex);
      return;
    }
    if(event.key==='ArrowDown'||event.key==='ArrowUp'){
      event.preventDefault();
      const step=event.key==='ArrowDown'?1:-1;
      const edge=step===1?0:choices.length-1;
      const next=expanded&&activeIndex>=0?Math.max(0,Math.min(choices.length-1,activeIndex+step)):selected?choices.indexOf(selected):edge;
      setActiveKey(choices[next].key);
      setOpen(true);
    }else if(expanded&&(event.key==='Home'||event.key==='End')){
      event.preventDefault();
      setActiveKey(choices[event.key==='Home'?0:choices.length-1].key);
    }
  }
  const label=selected?.label||(value?'原目标已变化，请重新选择':'选择要覆盖的版本');
  return <div ref={root} className="version-target">
    <span id={id+'-label'} className="version-target-label">发布到</span>
    <button type="button" role="combobox" className="version-target-trigger" aria-labelledby={id+'-label'} aria-describedby={id+'-value'}
      aria-expanded={expanded} aria-controls={expanded?id+'-list':undefined} aria-haspopup="listbox"
      aria-activedescendant={expanded&&activeIndex>=0?id+'-'+activeIndex:undefined}
      disabled={disabled||!choices.length} onBlur={()=>setOpen(false)} onKeyDown={keyDown}
      onClick={()=>{if(!expanded)setActiveKey(selected?.key??choices[0].key);setOpen(!expanded);}}>
      <span id={id+'-value'} className="version-target-value">{label}{selected?.version?.isCurrent&&<span className="version-current">当前版本</span>}</span>
      <ActionIcon name="chevron-down"/>
    </button>
    {expanded&&<div id={id+'-list'} role="listbox" aria-labelledby={id+'-label'} className="version-target-menu">
      {choices.map((choice,index)=><div key={choice.key} id={id+'-'+index} role="option" aria-selected={choice.key===value}
        ref={index===activeIndex?activeOption:undefined} className={'version-target-option'+(index===activeIndex?' is-active':'')}
        onMouseDown={event=>event.preventDefault()} onClick={()=>choose(index)}>
        <span className="version-target-option-title">{choice.label}{choice.version?.isCurrent&&<span className="version-current">当前版本</span>}</span>
        {choice.version&&<span className="version-target-time">更新 {exactTime(choice.version.filesUpdatedAt||choice.version.createdAt).slice(0,16)}</span>}
        {choice.key===value&&<ActionIcon name="check"/>}
      </div>)}
    </div>}
  </div>;
}

export function VersionNoteInput({value, onChange, disabled}: {
  value: string;
  onChange: (note: string) => void;
  disabled: boolean;
}) {
  return <label>版本备注 <span className="muted small">选填</span>
    <textarea className="version-note-input" rows={2} maxLength={500} disabled={disabled} value={value}
      onChange={event => onChange(event.target.value)} placeholder="记录此版本的改动"/>
  </label>;
}

export function VersionPublishMode({publishNow, onChange, disabled}: {
  publishNow: boolean;
  onChange: (publishNow: boolean) => void;
  disabled: boolean;
}) {
  const id=useId();
  return <fieldset className="version-publish-mode" disabled={disabled} aria-describedby={id+'-hint'}>
    <legend>上传后</legend>
    <div className="version-publish-options">
      <label>
        <input type="radio" name={id} checked={publishNow} onChange={()=>onChange(true)}/>
        <span>上传并发布</span>
      </label>
      <label>
        <input type="radio" name={id} checked={!publishNow} onChange={()=>onChange(false)}/>
        <span>仅保存版本</span>
      </label>
    </div>
    <p id={id+'-hint'} className="small muted">{publishNow?'上传成功后，分享链接将展示新版本。':'保存到版本管理，之后可手动切换或发布。'}</p>
  </fieldset>;
}

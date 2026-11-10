import {useEffect,useRef,type ReactNode} from 'react';

export function ModalFrame({children,onClose,locked=false,className='',label,labelledBy,closeLabel='关闭弹窗'}:{children:ReactNode;onClose:()=>void;locked?:boolean;className?:string;label?:string;labelledBy?:string;closeLabel?:string}){
 const panel=useRef<HTMLElement>(null),close=useRef(onClose),isLocked=useRef(locked);
 close.current=onClose;isLocked.current=locked;
 useEffect(()=>{
  const previous=document.activeElement as HTMLElement|null;
  const oldOverflow=document.body.style.overflow;
  document.body.style.overflow='hidden';
  const frame=requestAnimationFrame(()=>{if(!panel.current?.contains(document.activeElement)){const field=Array.from(panel.current?.querySelectorAll<HTMLElement>('input:not([readonly]):not(:disabled):not([hidden]):not([type="file"]),textarea:not([readonly]):not(:disabled)')||[]).find(e=>e.getClientRects().length);(field||panel.current?.querySelector<HTMLElement>('button:not(:disabled),a[href]')||panel.current)?.focus();}});
  const keydown=(e:KeyboardEvent)=>{
   if(e.isComposing)return;
   if(e.key==='Escape'){e.preventDefault();if(!isLocked.current)close.current();return;}
   if(e.key!=='Tab')return;
   const elements=Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),textarea:not(:disabled),select:not(:disabled),summary,[tabindex="0"]')||[]).filter(e=>{const hiddenDetails=e.closest('details:not([open])');return e.getClientRects().length&&(!hiddenDetails||hiddenDetails.querySelector('summary')===e);});
   if(!elements.length){e.preventDefault();panel.current?.focus();return;}
   const first=elements[0],last=elements[elements.length-1];
   if(e.shiftKey&&(document.activeElement===first||!panel.current?.contains(document.activeElement))){e.preventDefault();last.focus();}
   else if(!e.shiftKey&&(document.activeElement===last||!panel.current?.contains(document.activeElement))){e.preventDefault();first.focus();}
  };
  document.addEventListener('keydown',keydown);
  return()=>{cancelAnimationFrame(frame);document.body.style.overflow=oldOverflow;document.removeEventListener('keydown',keydown);if(previous?.isConnected)previous.focus();};
 },[]);
 return <div className="overlay" onMouseDown={e=>{if(e.target===e.currentTarget&&!locked)onClose();}}><section ref={panel} data-pointer-surface="glass" tabIndex={-1} className={'modal '+className} role="dialog" aria-modal="true" aria-label={label} aria-labelledby={labelledBy} aria-busy={locked}><button className="close" aria-label={closeLabel} disabled={locked} onClick={onClose}><span aria-hidden="true">×</span></button>{children}</section></div>;
}

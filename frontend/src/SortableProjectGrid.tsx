import {Children,isValidElement,useEffect,useLayoutEffect,useRef,useState,type ReactNode} from 'react';
import {useGridReflow} from './useGridReflow';
import './project-order.css';

type Drag={id:string;card:HTMLElement;x:number;y:number;startX:number;startY:number;offsetX:number;offsetY:number;pointer:number;touch:boolean;active:boolean;timer?:ReturnType<typeof setTimeout>;ghost?:HTMLElement;order:string[];inside:boolean};
type Landing={retarget:()=>void;cancel:()=>void};
const interactive='button,a,input,textarea,select,summary,[contenteditable],h2,.timestamp,.project-path,.badge,.project-number';

export function SortableProjectGrid({ids,disabled,saving,onReorder,children}:{ids:string[];disabled:boolean;saving:boolean;onReorder:(ids:string[])=>Promise<void>;children:ReactNode}){
 const grid=useRef<HTMLDivElement>(null),drag=useRef<Drag|null>(null),live=useRef({ids,disabled,onReorder}),suppressClick=useRef(0);
 live.current={ids,disabled,onReorder};
 const [announcement,setAnnouncement]=useState('');
 const [preview,setPreview]=useState<string[]|null>(null),layoutPending=useRef(false),landing=useRef<Landing|null>(null);
 const reflow=useGridReflow(grid);
 useLayoutEffect(()=>{layoutPending.current=false;});
 useLayoutEffect(()=>{landing.current?.retarget();},[ids.join('|')]);
 const cancel=useRef<()=>void>(()=>{}),begin=useRef<(target:EventTarget|null,x:number,y:number,pointer:number,touch:boolean)=>void>(()=>{});
 useEffect(()=>{
  let frame=0;
  function clear(){
   const current=drag.current;drag.current=null;cancelAnimationFrame(frame);frame=0;
   if(!current)return;
   reflow.capture();setPreview(null);layoutPending.current=false;
   clearTimeout(current.timer);current.ghost?.remove();current.card.classList.remove('is-sort-source');
   if(current.active)suppressClick.current=Date.now()+400;
   document.body.classList.remove('project-sorting');
  }
  cancel.current=clear;
  function start(d:Drag){
   if(drag.current!==d||live.current.disabled)return clear();
   d.active=true;window.getSelection()?.removeAllRanges();
   const ghost=d.card.cloneNode(true) as HTMLElement;
   const original=[d.card,...d.card.querySelectorAll<HTMLElement>('*')],cloned=[ghost,...ghost.querySelectorAll<HTMLElement>('*')];
   original.forEach((node,index)=>{const style=getComputedStyle(node);Object.assign(cloned[index].style,{color:style.color,backgroundColor:style.backgroundColor,borderColor:style.borderColor});cloned[index].removeAttribute('id');cloned[index].removeAttribute('data-pointer-surface');});
   const rect=d.card.getBoundingClientRect();
   ghost.classList.add('project-sort-ghost');ghost.removeAttribute('data-project-id');ghost.setAttribute('aria-hidden','true');ghost.inert=true;
   Object.assign(ghost.style,{width:rect.width+'px',height:rect.height+'px'});
   d.ghost=ghost;document.body.append(ghost);d.card.classList.add('is-sort-source');document.body.classList.add('project-sorting');
   setAnnouncement('正在移动项目，松开放置，按 Escape 取消');tick();
  }
  function tick(){
   const d=drag.current;if(!d?.active)return;
   d.ghost!.style.transform=`translate3d(${d.x-d.offsetX}px,${d.y-d.offsetY}px,0) rotate(1.5deg)`;
   const bounds=grid.current!.getBoundingClientRect();
   let target:HTMLElement|undefined;
   d.inside=d.x>=bounds.left-30&&d.x<=bounds.right+30&&d.y>=bounds.top-30&&d.y<=bounds.bottom+30;
   if(d.inside&&!layoutPending.current){
    let distance=Infinity;
    for(const card of grid.current!.querySelectorAll<HTMLElement>('[data-project-id]')){
     // Hit-test the final layout, never the moving animation. Otherwise cards
     // crossing a stationary pointer can repeatedly swap back and forth.
     const r={left:bounds.left+card.offsetLeft,top:bounds.top+card.offsetTop,width:card.offsetWidth,height:card.offsetHeight};
     const dx=Math.max(r.left-d.x,0,d.x-r.left-r.width),dy=Math.max(r.top-d.y,0,d.y-r.top-r.height);
     const value=dx*dx+dy*dy+Math.hypot(d.x-r.left-r.width/2,d.y-r.top-r.height/2)*.001;
     if(value<distance){distance=value;target=card;}
    }
   }
   if(target===d.card)target=undefined;
   if(target){
    const top=target.offsetTop,sourceTop=d.card.offsetTop,sameRow=Math.min(sourceTop+d.card.offsetHeight,top+target.offsetHeight)-Math.max(sourceTop,top)>Math.min(d.card.offsetHeight,target.offsetHeight)*.5;
    const before=sameRow?d.x<bounds.left+target.offsetLeft+target.offsetWidth/2:d.y<bounds.top+top+target.offsetHeight/2;
    const ordered=d.order.filter(id=>id!==d.id),index=ordered.indexOf(target.dataset.projectId!);ordered.splice(index+(before?0:1),0,d.id);
    if(!ordered.every((id,index)=>id===d.order[index])){reflow.capture();d.order=ordered;layoutPending.current=true;setPreview(ordered);setAnnouncement(`将放在第 ${ordered.indexOf(d.id)+1} 个位置，松手保存`);}
   }
   const edge=65,speed=d.y<edge?-Math.ceil((edge-d.y)/7):d.y>innerHeight-edge?Math.ceil((d.y-innerHeight+edge)/7):0;
   if(speed)window.scrollBy(0,Math.max(-18,Math.min(18,speed)));
   frame=requestAnimationFrame(tick);
  }
  function move(x:number,y:number){const d=drag.current;if(!d)return;d.x=x;d.y=y;if(!d.active&&Math.hypot(x-d.startX,y-d.startY)>7){if(d.touch)clear();else start(d);}}
  async function finish(){
   const d=drag.current;if(!d)return;
   if(!d.active||!d.inside||live.current.disabled){clear();return;}
   const ordered=d.order,id=d.id,ghost=d.ghost!;d.ghost=undefined;clear();
   d.card.classList.add('is-sort-source');document.body.classList.add('project-sort-settling');
   let animation:Animation|undefined,raf=0,done=false,resolve!:()=>void;
   const settled=new Promise<void>(r=>resolve=r);
   const cleanup=()=>{if(done)return;done=true;cancelAnimationFrame(raf);animation?.cancel();ghost.remove();d.card.classList.remove('is-sort-source');document.body.classList.remove('project-sort-settling');landing.current=null;resolve();};
   const retarget=()=>{
    cancelAnimationFrame(raf);if(done)return;
    if(!d.card.isConnected||matchMedia('(prefers-reduced-motion: reduce)').matches){cleanup();return;}
    const current=getComputedStyle(ghost).transform;animation?.cancel();
    const bounds=grid.current!.getBoundingClientRect(),width=parseFloat(ghost.style.width),height=parseFloat(ghost.style.height);
    const end=`translate3d(${bounds.left+d.card.offsetLeft}px,${bounds.top+d.card.offsetTop}px,0) rotate(0deg) scale(${d.card.offsetWidth/width},${d.card.offsetHeight/height})`;
    animation=ghost.animate([{transform:current,opacity:.94},{transform:end,opacity:1}],{duration:230,easing:'cubic-bezier(.2,.75,.25,1)',fill:'both'});animation.id='project-drop';void animation.finished.then(cleanup,()=>{});
   };
   landing.current={retarget,cancel:cleanup};raf=requestAnimationFrame(retarget);
   const changed=!ordered.every((value,index)=>value===live.current.ids[index]);
   if(changed)setAnnouncement('正在保存项目顺序');
   await Promise.all([changed?live.current.onReorder(ordered):Promise.resolve(),settled]);
   grid.current?.querySelector<HTMLElement>(`[data-project-id="${CSS.escape(id)}"]`)?.focus({preventScroll:true});
  }
  begin.current=(target,x,y,pointer,touch)=>{
   if(live.current.disabled||landing.current||live.current.ids.length<2||!(target instanceof Element)||target.closest(interactive))return;
   const card=target.closest<HTMLElement>('[data-project-id]');if(!card||card.parentElement!==grid.current)return;
   clear();const rect=card.getBoundingClientRect();
   const d:Drag={id:card.dataset.projectId!,card,x,y,startX:x,startY:y,offsetX:x-rect.left,offsetY:y-rect.top,pointer,touch,active:false,order:[...live.current.ids],inside:true};drag.current=d;
   if(touch)d.timer=setTimeout(()=>start(d),350);
  };
  const pointerMove=(e:PointerEvent)=>{if(drag.current&&!drag.current.touch&&e.pointerId===drag.current.pointer){if(drag.current.active)e.preventDefault();move(e.clientX,e.clientY);}};
  const pointerUp=(e:PointerEvent)=>{if(drag.current&&!drag.current.touch&&e.pointerId===drag.current.pointer)void finish();};
  const touchMove=(e:TouchEvent)=>{const d=drag.current;if(!d?.touch)return;if(e.touches.length!==1)return clear();const touch=Array.from(e.touches).find(t=>t.identifier===d.pointer);if(!touch)return clear();if(d.active)e.preventDefault();move(touch.clientX,touch.clientY);};
  const touchEnd=()=>{if(drag.current?.touch)void finish();};
  const key=(e:KeyboardEvent)=>{if(e.key==='Escape'&&drag.current){e.preventDefault();clear();setAnnouncement('已取消移动');}};
  const scroll=()=>{if(drag.current&&!drag.current.active)clear();};
  const contextMenu=(e:Event)=>{if(drag.current?.active)e.preventDefault();};
  const visibility=()=>{if(document.hidden)interrupt();};
  const interrupt=()=>{clear();landing.current?.cancel();};
  const reduced=matchMedia('(prefers-reduced-motion: reduce)');reduced.addEventListener('change',interrupt);
  window.addEventListener('pointermove',pointerMove,{passive:false});window.addEventListener('pointerup',pointerUp);window.addEventListener('pointercancel',clear);
  window.addEventListener('touchmove',touchMove,{passive:false});window.addEventListener('touchend',touchEnd);window.addEventListener('touchcancel',clear);
  window.addEventListener('keydown',key);window.addEventListener('blur',interrupt);window.addEventListener('resize',interrupt);window.addEventListener('scroll',scroll);
  document.addEventListener('contextmenu',contextMenu);document.addEventListener('visibilitychange',visibility);
  return()=>{interrupt();reduced.removeEventListener('change',interrupt);window.removeEventListener('pointermove',pointerMove);window.removeEventListener('pointerup',pointerUp);window.removeEventListener('pointercancel',clear);window.removeEventListener('touchmove',touchMove);window.removeEventListener('touchend',touchEnd);window.removeEventListener('touchcancel',clear);window.removeEventListener('keydown',key);window.removeEventListener('blur',interrupt);window.removeEventListener('resize',interrupt);window.removeEventListener('scroll',scroll);document.removeEventListener('contextmenu',contextMenu);document.removeEventListener('visibilitychange',visibility);};
 },[]);
 useEffect(()=>{cancel.current();},[disabled,ids.join('|')]);
 const positions=new Map((preview||ids).map((id,index)=>[id,index]));
 const position=(node:ReactNode)=>{if(!isValidElement<{'data-project-id'?:string}>(node))return Infinity;return positions.get(node.props['data-project-id']||'')??Infinity;};
 const orderedChildren=Children.toArray(children).sort((a,b)=>position(a)-position(b));
 return <><p className="project-order-accessible" id="project-order-help">拖拽卡片空白处调整顺序；触屏长按后拖动；键盘聚焦卡片后按 Alt 加方向键移动。</p><p className="project-order-accessible" role="status" aria-live="polite">{announcement}</p><div ref={grid} className={'project-grid sortable-grid'+(disabled?' sort-locked':'')} aria-label="项目卡片" aria-busy={saving} onPointerDown={e=>{if(e.pointerType!=='touch'&&e.button===0)begin.current(e.target,e.clientX,e.clientY,e.pointerId,false);}} onTouchStart={e=>{if(e.touches.length!==1){cancel.current();return;}const t=e.touches[0];begin.current(e.target,t.clientX,t.clientY,t.identifier,true);}} onClickCapture={e=>{if(Date.now()<suppressClick.current){e.preventDefault();e.stopPropagation();}}} onDragStart={e=>{if(!(e.target instanceof Element)||!e.target.closest('a'))e.preventDefault();}} onKeyDown={e=>{
  if(!e.altKey||e.ctrlKey||e.metaKey||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)||disabled||landing.current||!(e.target instanceof HTMLElement)||!e.target.matches('[data-project-id]'))return;
  e.preventDefault();const id=e.target.dataset.projectId!,index=ids.indexOf(id),next=index+(['ArrowLeft','ArrowUp'].includes(e.key)?-1:1);if(index<0||next<0||next>=ids.length)return;
  const ordered=[...ids];[ordered[index],ordered[next]]=[ordered[next],ordered[index]];reflow.capture();setAnnouncement('正在保存项目顺序');void onReorder(ordered);
 }}>{orderedChildren}</div></>;
}

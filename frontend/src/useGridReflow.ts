import {useCallback,useEffect,useLayoutEffect,useRef,type RefObject} from 'react';

type Bounds={left:number;top:number;width:number;height:number};
type Motion={animation:Animation;willChange:string};
const key=(element:HTMLElement)=>element.dataset.projectId||'create-project';

// Keep positions relative to the grid: scrolling or the welcome section folding
// must not become a large, unrelated card animation at the next reorder.
export function useGridReflow(grid:RefObject<HTMLDivElement|null>){
 const positions=useRef(new Map<string,Bounds>()),pending=useRef<Map<string,Bounds>|null>(null),order=useRef('');
 const motions=useRef(new Map<HTMLElement,Motion>());
 const capture=useCallback(()=>{
  if(!grid.current)return;
  const origin=grid.current.getBoundingClientRect();
  pending.current=new Map(Array.from(grid.current.children,child=>{
   const element=child as HTMLElement,r=element.getBoundingClientRect();
   return [key(element),{left:r.left-origin.left,top:r.top-origin.top,width:r.width,height:r.height}];
  }));
 },[grid]);
 const stop=useCallback(()=>{
  for(const [element,motion]of motions.current){element.style.willChange=motion.willChange;motion.animation.cancel();}
  motions.current.clear();
 },[]);
 const reset=useCallback(()=>{stop();pending.current=null;positions.current.clear();order.current='';},[stop]);
 useLayoutEffect(()=>{
  const node=grid.current;if(!node)return;
  const children=Array.from(node.children) as HTMLElement[],nextOrder=children.map(key).join('|');
  const changed=!!order.current&&order.current!==nextOrder;
  const before=pending.current||new Map(positions.current);
  if(changed&&!pending.current){
   // A save failure/reset may interrupt the previous move. Recover its current
   // visual position before cancelling it, rather than snapping to its endpoint.
   for(const element of motions.current.keys()){
    const old=before.get(key(element));if(!old)continue;
    const style=getComputedStyle(element),translation=style.translate.split(/\s+/).map(parseFloat),scale=style.scale.split(/\s+/).map(parseFloat);
    before.set(key(element),{left:old.left+(translation[0]||0),top:old.top+(translation[1]||0),width:old.width*(scale[0]||1),height:old.height*(scale[1]||scale[0]||1)});
   }
  }
  if(changed)stop();
  const after=new Map(children.map(element=>[key(element),{left:element.offsetLeft,top:element.offsetTop,width:element.offsetWidth,height:element.offsetHeight}]));
  positions.current=after;order.current=nextOrder;pending.current=null;
  if(!changed||matchMedia('(prefers-reduced-motion: reduce)').matches)return;
  for(const element of children){
   if(element.classList.contains('is-sort-source'))continue; // The ghost lands in this stable empty slot.
   const from=before.get(key(element)),to=after.get(key(element));if(!from||!to||!to.width||!to.height)continue;
   const dx=from.left-to.left,dy=from.top-to.top,sx=from.width/to.width,sy=from.height/to.height;
   if(Math.abs(dx)<.5&&Math.abs(dy)<.5&&Math.abs(sx-1)<.01&&Math.abs(sy-1)<.01)continue;
   const willChange=element.style.willChange;element.style.willChange='translate, scale';
   const animation=element.animate([{translate:`${dx}px ${dy}px`,scale:`${sx} ${sy}`,transformOrigin:'0 0'},{translate:'0px 0px',scale:'1 1',transformOrigin:'0 0'}],{duration:280,easing:'cubic-bezier(.2,.75,.25,1)',fill:'both'});
   animation.id='project-reflow';motions.current.set(element,{animation,willChange});
   const clean=()=>{if(motions.current.get(element)?.animation!==animation)return;element.style.willChange=willChange;motions.current.delete(element);animation.cancel();};
   void animation.finished.then(clean,()=>{});
  }
 });
 useEffect(()=>{
  const reduced=matchMedia('(prefers-reduced-motion: reduce)');
  reduced.addEventListener('change',reset);window.addEventListener('resize',reset);
  return()=>{reset();reduced.removeEventListener('change',reset);window.removeEventListener('resize',reset);};
 },[reset]);
 return {capture,reset};
}

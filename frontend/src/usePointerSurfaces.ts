import {useEffect} from 'react';

// One delegated listener also covers dialogs and cards created after startup.
// CSS handles presentation; pointer movement never causes a React render.
export function usePointerSurfaces(){
 useEffect(()=>{
  const finePointer=matchMedia('(hover: hover) and (pointer: fine)');
  const reduced=matchMedia('(prefers-reduced-motion: reduce)');
  const active=new Set<HTMLElement>();
  const properties=['--pointer-x','--pointer-y','--tilt-x','--tilt-y','--drift-x','--drift-y'];
  let frame=0,position:{x:number;y:number;target:Element}|null=null;
  function clear(element:HTMLElement){
   delete element.dataset.pointerActive;
   for(const name of properties)element.style.removeProperty(name);
   active.delete(element);
  }
  function reset(){
   cancelAnimationFrame(frame);frame=0;position=null;
   for(const element of [...active])clear(element);
  }
  function update(){
   frame=0;
   if(!position||!finePointer.matches||reduced.matches){reset();return;}
   const hovered=new Set<HTMLElement>();
   let element=position.target.closest<HTMLElement>('[data-pointer-surface]');
   while(element){if(!(element instanceof HTMLButtonElement&&element.disabled))hovered.add(element);element=element.parentElement?.closest<HTMLElement>('[data-pointer-surface]')||null;}
   for(const previous of [...active])if(!hovered.has(previous)||!previous.isConnected)clear(previous);
   const measurements=[...hovered].filter(e=>e.isConnected).map(element=>({element,rect:element.getBoundingClientRect()}));
   for(const {element,rect} of measurements){
    if(!rect.width||!rect.height)continue;
    const x=Math.max(0,Math.min(1,(position.x-rect.left)/rect.width));
    const y=Math.max(0,Math.min(1,(position.y-rect.top)/rect.height));
    element.style.setProperty('--pointer-x',(x*100).toFixed(2)+'%');
    element.style.setProperty('--pointer-y',(y*100).toFixed(2)+'%');
    element.style.setProperty('--tilt-x',((.5-y)*6).toFixed(2)+'deg');
    element.style.setProperty('--tilt-y',((x-.5)*6).toFixed(2)+'deg');
    element.style.setProperty('--drift-x',((x-.5)*6).toFixed(2)+'px');
    element.style.setProperty('--drift-y',((y-.5)*6).toFixed(2)+'px');
    element.dataset.pointerActive='true';active.add(element);
   }
  }
  function move(event:PointerEvent){
   if(event.pointerType!=='mouse'||!finePointer.matches||reduced.matches){reset();return;}
   if(!(event.target instanceof Element))return;
   position={x:event.clientX,y:event.clientY,target:event.target};
   if(!frame)frame=requestAnimationFrame(update);
  }
  function leave(event:PointerEvent){if(!event.relatedTarget)reset();}
  document.addEventListener('pointermove',move,{passive:true});
  document.addEventListener('pointerout',leave,{passive:true});
  window.addEventListener('blur',reset);
  finePointer.addEventListener('change',reset);reduced.addEventListener('change',reset);
  return()=>{
   reset();document.removeEventListener('pointermove',move);document.removeEventListener('pointerout',leave);window.removeEventListener('blur',reset);
   finePointer.removeEventListener('change',reset);reduced.removeEventListener('change',reset);
  };
 },[]);
}

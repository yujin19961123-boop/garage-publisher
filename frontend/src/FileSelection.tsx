import React, {useEffect, useRef, useState} from 'react';
import {collectDropped, selectionFromFiles, validateSelection, type Selection, type UploadLimits} from './upload-input';
const mb=(n:number)=>(n/1000000).toFixed(1)+' MB';
export function FileSelection({value,onChange,disabled,limits,onBusyChange}:{value:Selection|null;onChange:(value:Selection|null)=>void;disabled:boolean;limits:UploadLimits;onBusyChange?:(busy:boolean)=>void}){
 const folder=useRef<HTMLInputElement>(null),files=useRef<HTMLInputElement>(null),alive=useRef(true),reading=useRef(false);
 const [error,setError]=useState(''),[collecting,setCollecting]=useState(false),[drag,setDrag]=useState(false);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 const locked=disabled||collecting;
 const selected=!!value?.items.length;
 const total=value?.items.reduce((sum,item)=>sum+item.file.size,0)||0;
 const root=value?.items[0]?.path.split('/')[0]||'';
 const folderName=value?.items.every(item=>item.path.startsWith(root+'/'))?root:'';
 const selectionName=folderName|| (value?.items.length===1?value.items[0].file.name:'已选文件');
 async function accept(collect:()=>Promise<Selection>){
  if(disabled||reading.current)return;
  reading.current=true;setCollecting(true);setError('');onChange(null);onBusyChange?.(true);
  try{const selection=await collect();validateSelection(selection,limits);if(alive.current)onChange(selection);}
  catch(e){if(alive.current)setError((e as Error).message||'无法读取文件，请重新选择');}
  finally{reading.current=false;if(alive.current){setCollecting(false);onBusyChange?.(false);}}
 }
 return <div className="file-selection"><div className={'file-dropzone'+(selected?' is-selected':'')+(drag?' is-dragging':'')+(locked?' is-disabled':'')} onDragOver={e=>{e.preventDefault();if(!locked)setDrag(true);}} onDragLeave={()=>setDrag(false)} onDrop={e=>{e.preventDefault();setDrag(false);if(locked)return;const items=Array.from(e.dataTransfer.items).filter(x=>x.kind==='file');const fallback=Array.from(e.dataTransfer.files);void accept(()=>collectDropped(items,fallback,limits,()=>alive.current));}}>
  {selected&&value?<div className="selected-file-state" role="status" aria-live="polite">
   <div className="selected-file-heading"><span className="selected-file-check" aria-hidden="true">✓</span><strong>文件已选好</strong></div>
   <div className="selected-file-card"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d={folderName?'M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Z':'M6 3h8l4 4v14H6V3Zm8 0v5h4M9 12h6M9 16h6'}/></svg><div><strong className="selected-file-name" title={selectionName}>{selectionName}</strong><span>{value.items.length} 个文件 · {mb(total)}</span></div></div>
   {!folderName&&value.items.length>1&&<p className="selected-file-preview">{value.items.slice(0,3).map(item=>item.file.name).join('、')}{value.items.length>3?' 等':''}</p>}
   <p className="selected-file-hint">{disabled?'文件处理中，请稍候…':'已准备好，点击下方发布按钮后开始上传。'}</p>
  </div>:!collecting&&<><strong>拖入原型文件夹、文件或 ZIP</strong><p className="small muted">整个文件夹或里面的全部内容都可以，无需自己打包。</p></>}
  {collecting&&<p role="status" className="file-reading-state">正在读取文件，请稍候…</p>}
  <div className="file-selection-actions"><button type="button" disabled={locked} onClick={()=>folder.current?.click()}>{selected?'更换文件夹':'选择文件夹'}</button><button type="button" disabled={locked} onClick={()=>files.current?.click()}>{selected?'更换文件':'选择文件'}</button></div>
  <input ref={folder} hidden type="file" multiple {...({webkitdirectory:'',directory:''} as React.InputHTMLAttributes<HTMLInputElement>)} disabled={locked} aria-label="选择原型文件夹" onChange={e=>{const list=Array.from(e.currentTarget.files||[]);e.currentTarget.value='';if(list.length)void accept(async()=>selectionFromFiles(list));}}/>
  <input ref={files} hidden type="file" multiple disabled={locked} aria-label="选择原型文件或 ZIP" onChange={e=>{const list=Array.from(e.currentTarget.files||[]);e.currentTarget.value='';if(list.length)void accept(async()=>selectionFromFiles(list));}}/>
 </div>{error&&<div role="alert" className="alert">{error}</div>}</div>;
}

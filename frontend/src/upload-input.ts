import {zip} from 'fflate';

export type UploadLimits={maxUploadBytes?:number;maxExpandedBytes?:number;maxFiles?:number;maxFileBytes?:number};
export type Selection={items:{path:string;file:File}[];archive?:File};
export type Entry={isFile:boolean;isDirectory:boolean;name:string;file:(ok:(file:File)=>void,fail:(error:DOMException)=>void)=>void;createReader:()=>{readEntries:(ok:(entries:Entry[])=>void,fail:(error:DOMException)=>void)=>void}};
const caches=new WeakMap<Selection,File>();
const mb=(n:number)=>(n/1000000).toFixed(1)+' MB';

export function standaloneHtml(selection:Selection|null){
 if(selection?.items.length!==1)return undefined;
 const item=selection.items[0];
 if(item.path===item.file.name&&!item.path.includes('/')&&/\.html$/i.test(item.path))return item;
}

export function selectionFolder(selection:Selection|null){
 const root=selection?.items[0]?.path.split('/')[0];
 return root&&selection?.items.every(item=>item.path.startsWith(root+'/'))?root:'';
}

function safePath(path:string){
 if(!path||path.startsWith('/')||/[\\:\x00-\x1f]/.test(path)||path.split('/').some(p=>!p||p==='.'||p==='..')||path.split('/').length>21)throw new Error('文件路径无效，请重新选择完整的原型文件夹');
 if(path.split('/').some(p=>p.startsWith('.')&&p!=='.DS_Store'&&!p.startsWith('._')))throw new Error('不能上传 .env 等隐藏文件，请移除敏感文件后重新选择');
}
export function validateSelection(selection:Selection,limits:UploadLimits){
 delete selection.archive;
 if(!limits.maxUploadBytes||!limits.maxExpandedBytes)throw new Error('正在读取上传限制，请稍后重试');
 if(!selection.items.length)throw new Error('没有找到文件，请选择包含网页内容的文件夹或文件');
 if(selection.items.length>(limits.maxFiles||10000))throw new Error('文件数量超过限制，请减少文件后重试');
 const paths=new Set<string>();let total=0;
 for(const item of selection.items){safePath(item.path);if(paths.has(item.path))throw new Error('存在同名文件，请选择一个完整的原型文件夹');paths.add(item.path);total+=item.file.size;}
 const zips=selection.items.filter(x=>/\.zip$/i.test(x.path));
 if(selection.items.length===1&&zips.length===1&&zips[0].path===zips[0].file.name){
  const file=zips[0].file;
  if(!file.size)throw new Error('文件为空，请重新选择');
  if(file.size>limits.maxUploadBytes)throw new Error('ZIP 太大，上传上限为 '+mb(limits.maxUploadBytes));
  selection.archive=file;return;
 }
 for(const {file} of selection.items){if(file.size>(limits.maxFileBytes||100*1024*1024))throw new Error('单个文件太大，请缩小文件后重试');}
 if(!total)throw new Error('所选文件没有内容，请重新选择');
 if(total>limits.maxExpandedBytes)throw new Error('所选文件太大，文件总大小上限为 '+mb(limits.maxExpandedBytes));
 if(standaloneHtml(selection))return;
 // Fail before creating a project when the selected content cannot have a web entry.
 let content=selection.items.map(x=>x.path).filter(p=>!p.split('/').some(s=>s==='__MACOSX'||s==='.DS_Store'||s.startsWith('._')));
 while(!content.includes('index.html')){
  if(!content.length||content.some(p=>!p.includes('/')))throw new Error(zips.some(x=>x.path===x.file.name)?'ZIP 请单独上传，或选择包含首页的完整原型文件':'没有找到唯一的首页文件 index.html，请选择已导出的完整原型');
  const folder=content[0].split('/')[0];
  if(content.some(p=>!p.startsWith(folder+'/')))throw new Error('所选内容包含多个文件夹，无法确定首页，请只选择一个完整原型');
  content=content.map(p=>p.slice(folder.length+1));
 }
}
export async function prepareArchive(selection:Selection,limits:UploadLimits,onStage:(stage:string)=>void,signal?:AbortSignal):Promise<File>{
 validateSelection(selection,limits);
 if(signal?.aborted)throw new Error('操作已结束');
 if(selection.archive)return selection.archive;
 const cached=caches.get(selection);if(cached)return cached;
 onStage('正在整理文件…');
 const files:Record<string,Uint8Array>=Object.create(null);
 const html=standaloneHtml(selection);
 for(const item of selection.items){
  if(signal?.aborted)throw new Error('操作已结束');
  // Keep the published entry point consistent with folder and ZIP uploads.
  files[item===html?'index.html':item.path]=new Uint8Array(await item.file.arrayBuffer());
 }
 if(signal?.aborted)throw new Error('操作已结束');
 onStage('正在准备上传，请稍候…');
 const bytes=await new Promise<Uint8Array>((resolve,reject)=>{
  let cancel:()=>void=()=>{};
  const abort=()=>{cancel();reject(new Error('操作已结束'));};
  signal?.addEventListener('abort',abort,{once:true});
  cancel=zip(files,{level:6},(error,data)=>{signal?.removeEventListener('abort',abort);if(error)reject(new Error('整理文件失败，请重新选择文件后重试'));else resolve(data);});
  if(signal?.aborted)abort();
 });
 if(signal?.aborted)throw new Error('操作已结束');
 if(bytes.byteLength>limits.maxUploadBytes!)throw new Error('整理后的文件太大，上传上限为 '+mb(limits.maxUploadBytes!));
 const buffer=new ArrayBuffer(bytes.byteLength);new Uint8Array(buffer).set(bytes);
 const archive=new File([buffer],'prototype.zip',{type:'application/zip'});
 caches.set(selection,archive);return archive;
}

export function selectionFromFiles(list:File[]){return {items:list.map(file=>({file,path:file.webkitRelativePath||file.name}))};}
export async function collectDropped(items:DataTransferItem[],fallback:File[],limits:UploadLimits,isAlive:()=>boolean=()=>true):Promise<Selection>{
  const roots=items.map(item=>(item as unknown as {webkitGetAsEntry?:()=>Entry|null}).webkitGetAsEntry?.()||null);
  if(!roots.some(Boolean))return selectionFromFiles(fallback);
  const individualFiles=items.map(item=>item.getAsFile());
  const result:Selection={items:[]};let total=0,visited=0;
  async function walk(entry:Entry,prefix:string){
   if(!isAlive())throw new Error('操作已结束');
   if(++visited>(limits.maxFiles||10000))throw new Error('文件及文件夹数量超过限制');
   const relative=prefix+entry.name;safePath(relative);
   if(entry.isFile){
    const file=await new Promise<File>((resolve,reject)=>entry.file(resolve,reject));
    result.items.push({path:relative,file});total+=file.size;
    if(result.items.length>(limits.maxFiles||10000)||total>Math.max(limits.maxExpandedBytes||0,limits.maxUploadBytes||0))throw new Error('所选文件数量或大小超过限制');
   }else if(entry.isDirectory){
    const reader=entry.createReader();
    for(;;){const batch=await new Promise<Entry[]>((resolve,reject)=>reader.readEntries(resolve,reject));if(!batch.length)break;for(const child of batch)await walk(child,relative+'/');}
   }
  }
  for(let index=0;index<items.length;index++){
   const entry=roots[index];if(entry)await walk(entry,'');else{const file=individualFiles[index];if(file)result.items.push({file,path:file.webkitRelativePath||file.name});}
  }
  return result;
 }

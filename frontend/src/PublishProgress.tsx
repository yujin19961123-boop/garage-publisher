import {ActionIcon} from './ActionIcon';
import type {Selection} from './upload-input';
import './PublishProgress.css';

export function PublishProgress({selection,preparing,percent,taskStatus}:{selection:Selection|null;preparing:string;percent:number|null;taskStatus?:string}){
 const status=taskStatus?.toUpperCase();
 const step=preparing?0:percent!==null||status==='UPLOADING'?1:status?2:0;
 const uploadPercent=step===1&&percent!==null?Math.max(0,Math.min(100,percent)):null;
 const title=preparing?'正在整理文件':step===1?(uploadPercent===null?'正在确认上传状态':uploadPercent===100?'文件已传送':'正在上传文件'):step===2?(status==='VALIDATING'?'正在检查文件':status==='QUEUED'?'等待发布处理':'正在发布原型'):'正在准备上传';
 const root=selection?.items[0]?.path.split('/')[0];
 const filename=selection?.items.every(item=>item.path.startsWith(root+'/'))?root:selection?.items.length===1?selection.items[0].file.name:selection?`${selection.items.length} 个文件`:'';
 return <section className="publish-progress" aria-label="发布进度">
  <div className="publish-motion" aria-hidden="true"><span className="publish-orbit"/><span className="publish-core"><ActionIcon name="upload"/></span></div>
  <div className="publish-progress-heading"><h4 role="status" aria-live="polite">{title}<span aria-hidden="true" className="publish-dots"><i/><i/><i/></span></h4>{uploadPercent!==null&&<strong className="publish-percent" aria-hidden="true">{uploadPercent}<small>%</small></strong>}</div>
  {filename&&<p className="publish-filename" title={filename}>{filename}</p>}
  <div className={'publish-track'+(uploadPercent===null?' is-indeterminate':'')} role="progressbar" aria-label={title} aria-valuemin={0} aria-valuemax={100} aria-valuenow={uploadPercent??undefined} aria-valuetext={uploadPercent!==null?`${title}，${uploadPercent}%`:title}><span style={uploadPercent!==null?{transform:`scaleX(${uploadPercent/100})`}:undefined}/></div>
  <ol className="publish-steps" aria-label="发布步骤">{['整理文件','上传文件','发布原型'].map((label,index)=><li key={label} className={index<step?'is-complete':index===step?'is-current':''} aria-current={index===step?'step':undefined}><span className="publish-step-dot" aria-hidden="true">{index<step?<ActionIcon name="check"/>:index+1}</span><span>{label}</span></li>)}</ol>
 </section>;
}

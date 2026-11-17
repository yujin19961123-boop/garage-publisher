import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {selectionFromFiles,validateSelection,prepareArchive,collectDropped} from '../frontend/src/upload-input.ts';
const require=createRequire(new URL('../frontend/package.json',import.meta.url));
const {unzipSync}=require('fflate');
const limits={maxUploadBytes:100*1024*1024,maxExpandedBytes:500*1024*1024};
function file(path,text='test'){const value=new File([text],path.split('/').at(-1));Object.defineProperty(value,'webkitRelativePath',{value:path.includes('/')?path:''});return value;}
const whole=selectionFromFiles([file('dist/index.html','whole'),file('dist/assets/app.js','script')]);
const wholeArchive=await prepareArchive(whole,limits,()=>{});
assert.deepEqual(Object.keys(unzipSync(new Uint8Array(await wholeArchive.arrayBuffer()))).sort(),['dist/assets/app.js','dist/index.html']);
const contents=selectionFromFiles([file('index.html','contents'),file('assets/app.js','script')]);
const contentsArchive=await prepareArchive(contents,limits,()=>{});
assert.ok(unzipSync(new Uint8Array(await contentsArchive.arrayBuffer()))['index.html']);
assert.equal(await prepareArchive(contents,limits,()=>{}),contentsArchive);
assert.equal(await prepareArchive(selectionFromFiles([wholeArchive]),limits,()=>{}),wholeArchive);
validateSelection(selectionFromFiles([file('index.html'),file('download.zip')]),limits);
for(const path of ['prototype.html','原型预览.HTML','preview.htm','dist/prototype.html','export/dist/prototype.html']){
 const original=file(path,'<!doctype html><h1>Single HTML</h1>');
 const selection=selectionFromFiles([original]);
 validateSelection(selection,limits);
 const archive=await prepareArchive(selection,limits,()=>{});
 const content=unzipSync(new Uint8Array(await archive.arrayBuffer()));
 assert.deepEqual(Object.keys(content),[path],'Server owns homepage normalization');
 assert.equal(new TextDecoder().decode(content[path]),'<!doctype html><h1>Single HTML</h1>');
 assert.equal(selection.items[0].file.name,path.split('/').at(-1),'Selected file must not be renamed');
}
function fileEntry(path){return {name:path,isFile:true,isDirectory:false,file:(ok)=>ok(file(path)),createReader:()=>{throw Error('not directory');}};}
function directory(name,batches){let calls=0;return {name,isFile:false,isDirectory:true,file:()=>{throw Error('not file');},createReader:()=>({readEntries:(ok)=>{calls++;ok(batches.shift()||[]);}}),calls:()=>calls};}
const assets=directory('assets',[[fileEntry('app.js')],[]]);
const entries=[fileEntry('index.html'),...Array.from({length:105},(_,i)=>fileEntry('image-'+i+'.txt')),assets];
const dist=directory('dist',[entries.slice(0,100),entries.slice(100),[]]);
const dropped=await collectDropped([{webkitGetAsEntry:()=>dist,getAsFile:()=>null}],[],limits);
assert.equal(dropped.items.length,107);assert.equal(dist.calls(),3);
assert.ok(dropped.items.some(x=>x.path==='dist/assets/app.js'));
validateSelection(dropped,limits);
const assetContents=directory('assets',[[fileEntry('app.js')],[]]);
const droppedContents=await collectDropped([{webkitGetAsEntry:()=>fileEntry('index.html'),getAsFile:()=>null},{webkitGetAsEntry:()=>assetContents,getAsFile:()=>null}],[],limits);
assert.deepEqual(droppedContents.items.map(x=>x.path),['index.html','assets/app.js']);
const singleDropped=await collectDropped([{webkitGetAsEntry:()=>fileEntry('prototype.html'),getAsFile:()=>null}],[],limits);
validateSelection(singleDropped,limits);assert.equal(singleDropped.items[0].path,'prototype.html');
for(const invalid of [[],[file('index.html'),file('.env')],[file('../index.html')],[file('a/index.html'),file('b/index.html')],[file('index.html'),file('index.html')],[file('one.html'),file('two.html')],[file('prototype.html'),file('style.css')],[file('prototype.html'),file('.env')],[file('prototype.txt')]]){
 assert.throws(()=>validateSelection(selectionFromFiles(invalid),limits));
}
assert.throws(()=>validateSelection(selectionFromFiles([file('index.html','too big')]),{maxUploadBytes:100,maxExpandedBytes:2}));
const controller=new AbortController();controller.abort();
await assert.rejects(prepareArchive(contents,limits,()=>{},controller.signal));
console.log('PASS: arbitrarily named single HTML (picker/drag, Unicode, uppercase, nested), whole folder, contents, ZIP passthrough, ZIP resource, nested drag entries, multi-batch readers, unsafe/ambiguous inputs, limits and cancellation. No projects created.');

import {createRequire} from 'node:module';
import {readFileSync,readdirSync,lstatSync,mkdirSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
const require=createRequire(new URL('../frontend/package.json',import.meta.url));
const {zipSync,unzipSync}=require('fflate');
const files=Object.create(null);
function safe(file){const p=file.replaceAll('\\','/');if(p.split('/').some(s=>['.local','.tools','.git','node_modules','.env'].includes(s)))throw Error('Private source path rejected');return p;}
function add(file){const p=safe(file);if(lstatSync(file).isSymbolicLink())throw Error('Unexpected source link');files[p]=readFileSync(file);}
function tree(dir,accept=()=>true){for(const e of readdirSync(dir,{withFileTypes:true})){if(['.local','.tools','.git','node_modules','.env'].includes(e.name))continue;const f=path.join(dir,e.name);if(lstatSync(f).isSymbolicLink())throw Error('Unexpected source link');if(e.isDirectory())tree(f,accept);else if(accept(f))add(f);}}
tree('backend',file=>/\.(?:go|sql|html|css|js)$/.test(file)||['go.mod','go.sum'].includes(path.basename(file)));
// Validate each go:embed reference against the actual tree AND packaged files.
// Fail closed on unsupported pattern syntax rather than shipping a broken build.
function embedMatch(pattern,value){
 let re='^';for(let i=0;i<pattern.length;i++){const c=pattern[i];if(c==='*')re+='[^/]*';else if(c==='?')re+='[^/]';else if(c==='['){let end=pattern.indexOf(']',i+1);if(end<0)throw Error('Malformed embed character class');const part=pattern.slice(i,end+1);if(part.includes('\\'))throw Error('Unsupported escaped embed character class');re+=part;i=end;}else if(c==='\\'){if(++i>=pattern.length)throw Error('Malformed embed escape');re+=pattern[i].replace(/[.*+?^${}()|[\]\\]/g,'\\$&');}else re+=c.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');}return new RegExp(re+'$').test(value);
}
const disk=[];function inventory(dir){for(const e of readdirSync(dir,{withFileTypes:true})){const f=path.join(dir,e.name);if(lstatSync(f).isSymbolicLink())throw Error('Unexpected backend source link');disk.push({file:f.replaceAll('\\','/'),directory:e.isDirectory()});if(e.isDirectory())inventory(f);}}inventory('backend');
let embedReferences=0;
for(const [source,bytes]of Object.entries(files).filter(([p])=>p.startsWith('backend/')&&p.endsWith('.go'))){
 for(const directive of bytes.toString('utf8').matchAll(/^\/\/go:embed\s+(.+)$/gm)){
  const tokens=directive[1].match(/"(?:\\.|[^"\\])*"|`[^`]*`|[^\s]+/g)||[];
  for(let pattern of tokens){if(pattern[0]==='"')pattern=JSON.parse(pattern);else if(pattern[0]==='`')pattern=pattern.slice(1,-1);const all=pattern.startsWith('all:');if(all)pattern=pattern.slice(4);
   if(!pattern||pattern.startsWith('/')||pattern.split('/').some(p=>p==='..'||p==='.'||p===''))throw Error('Unsafe go:embed pattern in '+source);
   const base=path.posix.dirname(source)+'/',matches=disk.filter(e=>e.file.startsWith(base)&&embedMatch(pattern,e.file.slice(base.length)));
   const required=new Set();for(const match of matches){if(!match.directory)required.add(match.file);else for(const e of disk){if(e.directory||!e.file.startsWith(match.file+'/'))continue;const sub=e.file.slice(match.file.length+1);if(all||!sub.split('/').some(p=>p.startsWith('.')||p.startsWith('_')))required.add(e.file);}}
   if(!required.size)throw Error('go:embed has no files: '+source+' '+pattern);
   for(const file of required)if(!Object.hasOwn(files,file))throw Error('go:embed asset excluded from controlled package: '+file);
   embedReferences++;
  }
 }
}
for(const file of readdirSync('frontend'))if(/^(?:package(?:-lock)?\.json|index\.html|tsconfig.*\.json|vite\.config\.ts)$/.test(file))add('frontend/'+file);
tree('frontend/src');tree('infra/production');add('infra/backend.Dockerfile');add('.dockerignore');
if(Object.keys(files).some(p=>p.startsWith('.local/')||p.startsWith('.tools/')||p==='.env'||p.endsWith('/.env')))throw Error('Private data in source package');
mkdirSync('.local',{recursive:true});
const archive=zipSync(files,{level:6});
const unpacked=unzipSync(archive);for(const [file,bytes]of Object.entries(files)){if(!unpacked[file]||!Buffer.from(unpacked[file]).equals(bytes))throw Error('Archive source integrity mismatch: '+file);}
if(Object.keys(unpacked).some(p=>safe(p)!==p))throw Error('Unsafe archive entry');
writeFileSync('.local/garage-source.zip',archive);
console.log(JSON.stringify({file:'.local/garage-source.zip',entries:Object.keys(files).length,embedReferences,staticEmbedVerified:true,bytes:archive.length,sha256:createHash('sha256').update(archive).digest('hex')}));

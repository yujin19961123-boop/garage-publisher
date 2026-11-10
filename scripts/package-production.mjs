import {createRequire} from 'node:module';
import {readFileSync,readdirSync,lstatSync,mkdirSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
const require=createRequire(new URL('../frontend/package.json',import.meta.url));
const {zipSync}=require('fflate');
const files=Object.create(null);
function add(file){files[file.replaceAll('\\','/')]=readFileSync(file);}
function tree(dir){for(const e of readdirSync(dir,{withFileTypes:true})){const f=path.join(dir,e.name);if(lstatSync(f).isSymbolicLink())throw Error('Unexpected source link');if(e.isDirectory())tree(f);else add(f);}}
for(const file of readdirSync('backend'))if(/\.(?:go|sql)$/.test(file)||['go.mod','go.sum'].includes(file))add('backend/'+file);
for(const file of readdirSync('frontend'))if(/^(?:package(?:-lock)?\.json|index\.html|tsconfig.*\.json|vite\.config\.ts)$/.test(file))add('frontend/'+file);
tree('frontend/src');tree('infra/production');add('infra/backend.Dockerfile');add('.dockerignore');
if(Object.keys(files).some(p=>p.startsWith('.local/')||p.startsWith('.tools/')||p==='.env'||p.endsWith('/.env')))throw Error('Private data in source package');
mkdirSync('.local',{recursive:true});
const archive=zipSync(files,{level:6});writeFileSync('.local/garage-source.zip',archive);
console.log(JSON.stringify({file:'.local/garage-source.zip',entries:Object.keys(files).length,bytes:archive.length,sha256:createHash('sha256').update(archive).digest('hex')}));

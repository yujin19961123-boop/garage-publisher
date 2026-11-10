import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../frontend/dist');
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.ico':'image/x-icon','.woff2':'font/woff2'};
const server=http.createServer((req,res)=>{
  const host=(req.headers.host||'').toLowerCase();
  const consoleHost=/^console\.localhost(:8080)?$/.test(host);
  const previewHost=/^(localhost|127\.0\.0\.1)(:8080)?$/.test(host)||/^p-[a-f0-9]{32}\.localhost(:8080)?$/.test(host);
  if(!consoleHost&&!previewHost){res.writeHead(421);return res.end('Unknown host');}
  const pathname=(req.url||'/').split('?')[0];
  if(previewHost&&/^(localhost|127\.0\.0\.1)(:8080)?$/.test(host)&&pathname==='/'){
    res.writeHead(307,{'Location':'http://console.localhost:8080/','Cache-Control':'no-store'});return res.end();
  }
  if(previewHost||pathname.startsWith('/api/')||pathname==='/healthz'){
    const headers={...req.headers};
    delete headers['x-forwarded-host']; delete headers['forwarded'];
    headers['x-forwarded-proto']='http';
    const upstream=http.request({hostname:'127.0.0.1',port:8081,path:req.url,method:req.method,headers},r=>{
      res.writeHead(r.statusCode||502,r.headers);r.pipe(res);
    });
    upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end('Backend unavailable');});
    req.on('aborted',()=>upstream.destroy());res.on('close',()=>upstream.destroy());
    req.pipe(upstream);return;
  }
  if(!['GET','HEAD'].includes(req.method)){res.writeHead(405);return res.end();}
  let decoded;try{decoded=decodeURIComponent(pathname);}catch{res.writeHead(400);return res.end();}
  if(decoded.includes('\\')||decoded.includes('\0')||decoded.split('/').some(p=>p==='..'||p.startsWith('.'))){res.writeHead(400);return res.end();}
  let file=path.resolve(root,'.'+decoded);
  if(file!==root&&!file.startsWith(root+path.sep)){res.writeHead(400);return res.end();}
  try{if(fs.statSync(file).isDirectory())file=path.join(file,'index.html');}catch{}
  if(!fs.existsSync(file)&&!path.extname(decoded))file=path.join(root,'index.html');
  let stat;try{stat=fs.statSync(file);if(!stat.isFile())throw Error();}catch{res.writeHead(404);return res.end('Not found; build frontend first');}
  res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream','Content-Length':stat.size,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
  if(req.method==='HEAD')return res.end();
  fs.createReadStream(file).on('error',()=>res.destroy()).pipe(res);
});
server.requestTimeout=600000;
server.listen(8080,'127.0.0.1',()=>console.log('Local console http://console.localhost:8080; preview http://localhost:8080/<slug>/'));

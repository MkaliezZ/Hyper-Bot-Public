import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {createReadStream,createWriteStream} from 'node:fs';
import {mkdir,readFile,writeFile,realpath,lstat,unlink,stat,copyFile,rmdir} from 'node:fs/promises';
import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {Problem,id} from './contracts.mjs';

const marker='.hyper-bot-group.json';
const indexPath=host=>path.join(host.app.config.data,'group-folder.json');
const fail=msg=>new Problem(409,msg,'group_folder');
export const fileTypes=new Set('.txt .md .csv .json .pdf .docx .pptx .html .mp4 .mov .mkv .webm .wav .mp3 .m4a .png .jpg .jpeg .webp .srt'.split(' '));
export async function binding(host){
  try{return JSON.parse(await readFile(indexPath(host),'utf8'));}
  catch(error){if(error.code==='ENOENT')return null;throw error;}
}
export async function canonicalFolder(value) {
  if(typeof value!=='string'||!path.isAbsolute(value)||value.length>900)throw fail('请选择已存在的本机绝对路径。');
  const folder=await realpath(value).catch(()=>{throw fail('找不到群组文件夹。');});
  if(folder===path.parse(folder).root||!(await stat(folder)).isDirectory())throw fail('请选择一个文件夹。');
  return folder;
}
export function overlaps(a,b){
  const within=(parent,child)=>{const rel=path.relative(parent,child);return !rel||(!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel));};
  return within(a,b)||within(b,a);
}
export async function bindFolder(host,folder){
  const existing=await binding(host);
  if(existing){if(existing.folder===folder)return existing;throw fail('此群组已绑定文件夹。');}
  const dir=path.join(folder,'群组文档');
  try {await mkdir(dir,{mode:0o700});}catch(error){if(error.code==='EEXIST')throw fail('该目录已含有「群组文档」，请选择独立的群组文件夹。');throw error;}
  const token=randomUUID();
  const created=[];
  try{
    await writeFile(path.join(dir,marker),token,{flag:'wx',mode:0o600});created.push(path.join(dir,marker));
    for(const file of host.store.read().groupFiles??[]){
      const name=validatedName(file);
      const archived=path.join(host.app.config.data,'group-documents',name);
      const info=await lstat(archived).catch(()=>null);
      if(!info?.isFile()||info.isSymbolicLink())throw fail('备份缺少群组文件，请核对归档。');
      const destination=path.join(dir,name);
      await copyFile(archived,destination,1);created.push(destination);
    }
    await writeFile(indexPath(host),JSON.stringify({folder,token}),{flag:'wx',mode:0o600});
  }catch(error){
    for(const f of created.reverse())await unlink(f).catch(()=>{});
    await rmdir(dir).catch(()=>{});throw error;
  }
  return {folder,token};
}
async function documentDir(host){
  const owner=await binding(host);
  if(!owner)throw fail('请先为群组选择文件夹。');
  const dir=path.join(owner.folder,'群组文档');
  if(path.relative(dir,await realpath(dir).catch(()=>''))!==''||
     (await readFile(path.join(dir,marker),'utf8').catch(()=>''))!==owner.token)throw fail('群组文件夹已移动或绑定发生变化。');
  return dir;
}
export function validatedName(file){
  if(!id.safeParse(file.id).success||typeof file.name!=='string'||file.diskName!==file.id+'-'+file.name||
    path.basename(file.name)!==file.name||/[\\/:*?"<>|\p{Cc}]/u.test(file.name))throw fail('群组文件索引无效。');
  return file.diskName;
}
export async function groupFile(host,key) {
  const file=(host.store.read().groupFiles??[]).find(f=>f.id===id.parse(key));
  if(!file)throw new Problem(404,'本群没有这份文件。','group_file');
  const target=path.join(await documentDir(host),validatedName(file));
  const info=await lstat(target).catch(()=>null);
  if(!info?.isFile()||info.isSymbolicLink()||info.nlink!==1)throw fail('群组文件已移走或不再是独立文件。');
  if(file.sha256){
    const digest=createHash('sha256');
    for await(const chunk of createReadStream(target))digest.update(chunk);
    if(digest.digest('hex')!==file.sha256)throw fail('文件内容已在磁盘上改动，请重新上传新版后再使用。');
  }
  return {file,target};
}
const writing=new WeakMap();
export async function saveGroupFile(host,name,source,{key='',limit=512*1024*1024}={}) {
  if(!name||name.length>170||/[\\/:*?"<>|\p{Cc}]/u.test(name)||!fileTypes.has(path.extname(name).toLowerCase()))throw new Problem(422,'文件名或类型不受支持。');
  const files=host.store.read().groupFiles??[];
  const prior=key&&files.find(f=>f.key===key);
  if(prior){if(source?.destroy)source.destroy();return prior;}
  let pending=writing.get(host);if(!pending){pending=new Map();writing.set(host,pending);}
  if(key&&pending.has(key)){if(source?.destroy)source.destroy();return pending.get(key);}
  const work=(async()=>{
    const dir=await documentDir(host),id=randomUUID();
    const diskName=id+'-'+name;
    const target=path.join(dir,diskName);
    let size=0;const digest=createHash('sha256');
    try{
      await pipeline(source instanceof Uint8Array?Readable.from([source]):source,new Transform({transform(chunk,_encoding,done){
        size+=chunk.length;digest.update(chunk);done(size>limit?new Problem(413,'单份群组文件最多 512 MiB。'):null,chunk);
      }}),createWriteStream(target,{flags:'wx',mode:0o600}));
      const file={id,name,diskName,size,sha256:digest.digest('hex'),key,createdAt:new Date().toISOString()};
      host.store.change(state=>(state.groupFiles??=[]).push(file));
      return file;
    }catch(error){await unlink(target).catch(()=>{});throw error;}
  })();
  if(key)pending.set(key,work);
  try{return await work;}finally{if(key)pending.delete(key);}
}
export async function downloadGroupFile(host,key,response,preview=false){
  const {target,file}=await groupFile(host,key);
  if(preview){
    if(!file.name.toLowerCase().endsWith('.html')||!(host.store.read().groupMessages??[]).some(m=>m.outputs?.includes(key)&&['teaching-classroom','teaching-practice'].includes(m.bot)))
      throw new Problem(404,'本群没有可预览的课件或练习单。');
    response.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Frame-Options':'SAMEORIGIN',
      'Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; frame-ancestors 'self'; base-uri 'none'; form-action 'none'; sandbox allow-scripts"});
    return pipeline(createReadStream(target),response);
  }
  response.writeHead(200,{'Content-Type':'application/octet-stream','Cache-Control':'no-store',
    'Content-Disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(file.name)});
  await pipeline(createReadStream(target),response);
}

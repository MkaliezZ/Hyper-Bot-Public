import {spawn,execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readFile,mkdir,access} from 'node:fs/promises';
import {once} from 'node:events';
import {promisify} from 'node:util';
import {Problem} from './contracts.mjs';
import {processEnvironment} from './config.mjs';
import {teachingWorkbench} from './teaching-workbench.mjs';

async function portForChild() {
  const socket=net.createServer();
  socket.listen(0,'127.0.0.1');
  await once(socket,'listening');
  const {port}=socket.address();
  await new Promise(resolve=>socket.close(resolve));
  return port;
}

async function startTrial(data,onExit,installation) {
  if(!installation?.ok)throw new Problem(503,installation?.reason||'内置教培组件未就绪。','teaching_installation');
  const {root,bundled,python}=installation;
  await mkdir(data,{recursive:true,mode:0o700});
  const cert=path.join(data,'localhost.crt'),key=path.join(data,'localhost.key');
  if(!bundled&&!await access(cert).then(()=>true,()=>false)){
    const gitSSL=path.join(process.env.ProgramFiles||'C:/Program Files','Git/usr/bin/openssl.exe');
    const ssl=process.platform==='win32'&&await access(gitSSL).then(()=>true,()=>false)?gitSSL:'openssl';
    await promisify(execFile)(ssl,['req','-x509','-newkey','rsa:2048','-nodes','-days','3650','-subj','/CN=127.0.0.1',
      '-addext','subjectAltName=IP:127.0.0.1','-keyout',key,'-out',cert],{windowsHide:true});
  }
  const externalPort=bundled?undefined:await portForChild();
  const bridgeKey=bundled?randomUUID():undefined;
  const child=spawn(process.execPath,['--import','tsx',fileURLToPath(new URL('./teaching-trial-worker.mjs',import.meta.url))],{
    cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe','ipc'],env:processEnvironment({
      M0_DATA:data,M0_PYTHON:python,ELECTRON_RUN_AS_NODE:'1',
      ...(bundled?{HYPER_BOT_TEACHING_BRIDGE:bridgeKey}:{M0_PORT:String(externalPort)})
    })});
  child.stderr.resume();
  const closed=new Promise(resolve=>child.once('close',()=>{onExit();resolve();}));
  let port;
  try {
    port=await new Promise((resolve,reject)=>{
      const finish=(error,value)=>{
        clearTimeout(timer);
        child.stdout.off('data',line);child.off('message',message);child.off('error',fail);child.off('exit',fail);
        error?reject(error):resolve(value);
      };
      const fail=()=>finish(new Problem(503,'英语教培运行时未就绪，请检查 Hyper Bot 安装。','teaching_start'));
      let log='';
      const line=chunk=>{
        log=(log+chunk).slice(-512);
        if(log.includes('M0 listening on https://127.0.0.1:'+externalPort))finish(null,externalPort);
      };
      const message=event=>{
        const value=event?.teachingPort;
        if(Number.isInteger(value)&&value>=1024&&value<=65535)finish(null,value);
      };
      const timer=setTimeout(fail,20000);
      if(bundled){child.stdout.resume();child.on('message',message);}
      else child.stdout.on('data',line);
      child.once('error',fail);child.once('exit',fail);
    });
  } catch(error){child.kill();throw error;}
  const service=teachingWorkbench({HYPER_BOT_TEACHING_PORT:port,HYPER_BOT_TEACHING_CA:cert},
    async()=>JSON.parse(await readFile(path.join(data,'accounts.json'),'utf8')).teacher,bridgeKey);
  return {...service,close:()=>{child.kill();return closed;}};
}

export function teachingServices() {
  const formal=teachingWorkbench(),running=new Map();
  async function forHost(host){
    if(host.app.config.teachingAccess==='teacher')return formal;
    const data=path.join(host.app.config.data,'teaching-trial');
    if(!running.has(data)){
      const drop=()=>{if(running.get(data)===pending)running.delete(data);};
      const pending=startTrial(data,drop,host.app.config.teaching).catch(error=>{drop();throw error;});
      running.set(data,pending);
    }
    return running.get(data);
  }
  return {forHost,async render(req,res,ticket){
    if(formal.hasPreview(ticket))return formal.render(req,res,ticket);
    for(const item of await Promise.allSettled(running.values()))if(item.status==='fulfilled'&&item.value.hasPreview(ticket))return item.value.render(req,res,ticket);
    throw new Problem(404,'预览已过期。');
  },async close(){for(const item of await Promise.allSettled(running.values()))if(item.status==='fulfilled')await item.value.close();}};
}

import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Problem } from '../server/contracts.mjs';
import { root } from '../server/config.mjs';
import { validWindowKey } from '../server/window-session.mjs';

function requestHost(child,type,change,timeout) {
  const ticket=randomUUID();
  const offline=()=>new Problem(503,'本机服务暂未响应。请重新检查设置状态。','settings_offline');
  return new Promise((resolve,reject)=>{
    function finish(error,status) {
      clearTimeout(timer);
      child.off('close',unavailable);
      child.off('message',answer);
      if (error) reject(error);
      else resolve(status);
    }
    const unavailable=()=>finish(offline());
    const answer=packet=>{
      if (packet?.type!==type+'-result' || packet.ticket!==ticket) return;
      if (packet.error) finish(new Problem(packet.status,packet.error,packet.code));
      else finish(null,packet.value);
    };
    const timer=setTimeout(unavailable,timeout);
    child.once('close',unavailable);
    child.on('message',answer);
    try { child.send({type,ticket,...change},error=>{if(error)unavailable();}); }
    catch { unavailable(); }
  });
}

export async function startHost(dev,port,credential) {
  // The pinned DSH Windows add-ons target standalone Node. Keep the Electron
  // window and that runtime in different processes and give neither a shared session.
  const environment={...process.env};
  delete environment.ELECTRON_RUN_AS_NODE;
  for (const name of Object.keys(environment)) {
    if (name.toLowerCase()==='deepseek_api_key') delete environment[name];
  }
  environment.HYPER_BOT_DESKTOP_PORT=String(port);
  const bundled = process.resourcesPath && path.join(process.resourcesPath,'node','node.exe');
  const executable=environment.HYPER_BOT_NODE_RUNTIME ||
    (bundled && existsSync(bundled) ? bundled : process.platform==='win32' ? 'node.exe' : 'node');
  const child=fork(fileURLToPath(new URL('./server.mjs',import.meta.url)),dev?['--dev']:[],{
    cwd:root,execPath:executable,execArgv:[],env:environment,stdio:['ignore','ignore','ignore','ipc'],windowsHide:true
  });
  let finished=false, closing=false;
  const completed=new Promise(resolve=>child.once('close',()=>{finished=true;resolve();}));
  const {origin,windowKey}=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Problem(503,'本机 Node 服务启动超时。')),23000);
    const onClose=()=>{clearTimeout(timer);reject(new Problem(503,'本机 Node 服务未启动。'));};
    child.once('close',onClose);
    child.once('error',onClose);
    const onMessage=packet=>{
      if(packet?.status==='ready'&&/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(packet.origin)&&
        Number(packet.origin.split(':').at(-1))<=65535&&validWindowKey(packet.windowKey)) {
        clearTimeout(timer);
        child.off('message',onMessage);
        resolve({origin:packet.origin,windowKey:packet.windowKey});
      }
      if(packet?.status==='error') {
        clearTimeout(timer);
        reject(new Problem(503,packet.message));
      }
    };
    child.on('message',onMessage);
    child.send({type:'initialize',credential},error=>{if(error)onClose();});
  }).catch(async error=>{
    if(!finished)child.kill();
    await completed;
    throw error;
  });
  return {origin,windowKey,exited:completed,
    changeCredential:change=>requestHost(child,'credential',change,8000),
    changeRuntime:change=>requestHost(child,'runtime-installation',change,22000),
    get active() { return !closing && !finished && child.connected && child.exitCode===null && child.signalCode===null; },
    async close() {
    if(finished || closing)return completed;
    closing=true;
    if(child.connected)child.send({type:'close'},()=>{});
    const deadline=setTimeout(()=>{if(!finished)child.kill();},26000);
    await completed;
    clearTimeout(deadline);
  }};
}


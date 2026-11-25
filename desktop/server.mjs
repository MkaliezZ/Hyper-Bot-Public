import { once } from 'node:events';
import { launch } from '../server/http.mjs';
import { Problem } from '../server/contracts.mjs';
import { workspaceDirectory } from '../server/config.mjs';
import { newWindowKey } from '../server/window-session.mjs';
import { persistDesktopCredential } from './credentials.mjs';
import { installation, readRuntimeInstallations, runtimeId, saveRuntimeInstallation } from './runtime-installations.mjs';

if (!process.connected) throw new Error('请通过 Hyper Bot 桌面程序启动本机服务。');
const windowKey=newWindowKey();
let host;
async function close() {
  await host?.close();
  if(process.connected) process.disconnect();
}
process.on('disconnect',()=>{void close();});
async function receive(packet) {
  if (packet?.type==='close') {void close();return;}
  if (!process.connected || !['credential','runtime-installation'].includes(packet?.type)) return;
  const {type,ticket}=packet;
  let result, restart=false;
  try {
    if (type==='credential') {
      const {credential,sealed}=packet;
      const value=await host.configure('请等各工作区任务结束后再更改模型凭据。',()=>
        host.app.applyDesktopCredential(credential,()=>persistDesktopCredential(host.config.data,sealed)));
      result={value};
    } else {
      const id=runtimeId.parse(packet.id);
      const selected=packet.selection===null?null:installation.parse(packet.selection);
      await host.configure('请等各工作区任务结束后再更换本机组件。',()=>
        host.app.prepareRuntimeInstallation(id,selected,value=>saveRuntimeInstallation(host.config.data,id,value)));
      restart=true;
      result={value:true};
    }
  } catch(error) {
    const problem=error instanceof Problem ? error : new Problem(503,'本机设置暂时无法更新。','settings_unavailable');
    result={status:problem.status,code:problem.code,error:problem.message};
  }
  if (process.connected) process.send({type:type+'-result',ticket,...result},()=>{if(restart)void close();});
  else if (restart) void close();
}

try {
  const [initial]=await once(process,'message');
  if (initial?.type!=='initialize' || !initial.credential?.status) throw new Error('Missing desktop configuration');
  host=await launch({port:Number(process.env.HYPER_BOT_DESKTOP_PORT||0),dev:process.argv.includes('--dev'),windowKey,
    options:{desktopCredential:initial.credential,
      desktopInstallations:process.platform==='win32'?readRuntimeInstallations(workspaceDirectory()):undefined}});
  process.on('message',receive);
  if(process.connected)process.send({status:'ready',origin:host.origin,windowKey});
  else await close();
} catch(error) {
  if(process.connected)process.send({status:'error',message:error?.status?error.message:'请检查本机 Node.js、依赖和数据目录。'});
  if(process.connected)process.disconnect();
  process.exitCode=1;
}


import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { runProfile } from '@deepseek-ai/dsh/profile-boot';
import { DSH_VERSION } from './config.mjs';

const require=createRequire(import.meta.url);
const dsh=createRequire(require.resolve('@deepseek-ai/dsh/package.json'));
const allowed=new Set(['/api/session/create','/api/session/prompt','/api/session/events','/api/session/cancel']);

async function main(patchFile) {
  if (!process.send || dsh('@deepseek-ai/dsh/package.json').version!==DSH_VERSION) {
    throw new Error('Unknown DSH Web Host version');
  }
  const launch=await import(pathToFileURL(dsh.resolve('@deepseek-ai/dsh-launch-environment')).href);
  const environment=launch.createLaunchEnvironmentSnapshot([{source:'process',values:process.env}]);
  const {ctx,shutdown}=await runProfile({profile:'sdk-minimal',environment,patchFiles:[patchFile],args:[]});
  try {
    const persistence=ctx.get('sessionPersistence');
    if (!ctx.get('sessionController') || !ctx.get('typertGateway') || !ctx.get('webServer') || !persistence?.flush) {
      throw new Error('DSH Session Controller did not mount');
    }
    // Admission on the official Connection still checks the signed, local-only
    // API peer. Narrow its HTTP dispatch to the methods the parent needs.
    ctx.on('connection/request',(request,response,next)=>{
      if (request.method==='POST' && allowed.has(request.url)) return next();
      response.writeHead(404).end();
    });

    // DSH publishes live terminal events before its batched JSONL writer
    // finishes. Drain the owned Session when the turn ends and let that
    // receipt finish persisting if the parent disappears in the same window.
    let terminalFlush=Promise.resolve();
    let closing;
    ctx.on('session/event',(_session,event)=>{
      if (event.type==='turn/end') {
        terminalFlush=terminalFlush.then(()=>persistence.flush()).catch(error=>{
          console.error('Hyper Bot DSH persistence:',error.name);
        });
      }
    });
    const close=()=>closing??=terminalFlush.then(()=>shutdown.shutdown(0))
      .finally(()=>{if(process.connected)process.disconnect();});
    const origin=ctx.webServer.getOrigin();
    const token=new URL(ctx.connection.authenticatedUrl(origin)).searchParams.get('token');
    process.on('message',message=>{if(message==='close')void close();});
    process.once('disconnect',()=>{void close();});
    process.send({origin,token});
  } catch(error) {
    await shutdown.shutdown(1);
    throw error;
  }
}

try { await main(process.argv[2]); }
catch(error) {
  console.error('Hyper Bot DSH Web Host:',error.name);
  process.exitCode=1;
  if (process.connected) process.disconnect();
}


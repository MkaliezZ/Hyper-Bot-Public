import { parseArgs } from 'node:util';
import { backupWorkspace, restoreWorkspace, verifyWorkspace } from '../server/workspace-archive.mjs';
import { cleanupWorkspace } from '../server/workspace-retirement.mjs';

const usage='可用 backup <工作区> <新备份> [--retain-until 时间]、verify <备份>、restore <备份> <新工作区>、retire <工作区> 或 purge-expired <备份>。清理命令先预检，再用 --confirm <确认码> 执行。';
try {
  const {positionals,values}=parseArgs({allowPositionals:true,options:{
    'retain-until':{type:'string'},confirm:{type:'string'}
  }});
  const [action,source,target,...extra]=positionals;
  const hasTarget=action==='backup' || action==='restore';
  const cleaning=action==='retire' || action==='purge-expired';
  if (!source || !!target!==hasTarget || extra.length ||
      (values['retain-until']!==undefined && action!=='backup') || (values.confirm!==undefined && !cleaning)) {
    throw new Error(usage);
  }

  let result;
  if (action==='backup') {
    const {target:backup,manifest,retainUntil}=await backupWorkspace(source,target,{retainUntil:values['retain-until']});
    result={backup,files:manifest.files.length,version:manifest.version,retainUntil};
  } else if (action==='verify') {
    const {source:verified,manifest,retainUntil,retentionEnded,safeToRestore}=await verifyWorkspace(source);
    result={verified,files:manifest.files.length,version:manifest.version,retainUntil,retentionEnded,safeToRestore};
  } else if (action==='restore') {
    result=await restoreWorkspace(source,target);
  } else if (cleaning) {
    result=await cleanupWorkspace(source,action==='retire'?'workspace':'backup',values.confirm);
  } else {
    throw new Error(usage);
  }
  console.log(JSON.stringify(result));
} catch(error) {
  console.error(error.message);
  process.exitCode=1;
}

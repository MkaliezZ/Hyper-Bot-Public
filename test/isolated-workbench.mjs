import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const exec=promisify(execFile);

export async function startFixtureWorkbench({appRoot,config,processEnvironment,state,projects}) {
  assert.ok(config.workbench.ok,config.workbench.reason);
  await mkdir(state,{recursive:true});
  const env=processEnvironment({SELF_MEDIA_STATE_DIR:state,SELF_MEDIA_DATA_DIR:projects});
  const opts={cwd:config.workbenchRoot,env,windowsHide:true,timeout:35000};
  const location=await exec(config.workbenchPython,['-B','-X','utf8',join(appRoot,'scripts','workbench_server.py'),
    config.workbenchRoot,'--locate'],opts);
  const locator=JSON.parse(location.stdout).manifest;
  assert.equal(resolve(locator,'../..'),state);
  await exec(config.workbenchPython,['-B','-X','utf8',join(config.workbenchRoot,'workbench.py'),'call','GET','/api/projects'],opts);
  const registration=JSON.parse(await readFile(locator,'utf8'));
  assert.match(registration.base_url,/^http:\/\/127\.0\.0\.1:\d+$/);
  assert.ok(Number.isSafeInteger(registration.pid)&&registration.pid>1);
  const close=()=>{
    try {process.kill(registration.pid);} catch(error) {if(error.code!=='ESRCH') throw error;}
  };
  return {locator,registration,close};
}


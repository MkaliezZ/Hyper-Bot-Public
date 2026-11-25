import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { modelFixture } from '../test/model-fixture.mjs';

const [, , archive, app = fileURLToPath(new URL('../',import.meta.url))]=process.argv;
const appRoot=path.resolve(app);
const [{launch},{restoreWorkspace}]=await Promise.all(['http','workspace-archive'].map(filename=>
  import(pathToFileURL(path.join(appRoot,'server',filename+'.mjs')))));
const shell=await mkdtemp(path.join(tmpdir(),'hb-restored-project-'));
const data=path.join(shell,'restored');
await restoreWorkspace(archive,data);
const model=await modelFixture();
let host;
try {
  host=await launch({options:{data,providerKey:'local-fixture',upstream:model.origin}});
  const workspace=host.app.index();
  const id=workspace.conversations.find(room=>room.botId==='media').id;
  const before=host.app.room(id);
  const prior=before.artifacts.at(-1);
  const context=await host.app.workbench.context(before.project);
  assert.equal(context.heads.script,prior.receipt.id);
  const priorReceipts=before.artifacts.map(record=>record.receipt.id);
  const next=await host.app.start(id,{
    text:'在恢复后的原项目里继续改稿，最后一镜突出纸页翻动的声音。',
    attachments:prior.materialIds,base:prior.id,clientRequestId:randomUUID(),authorized:true
  });
  async function waitFor(status) {
    for(let tries=0;tries<200;tries++){
      const run=host.app.room(id).runs.find(item=>item.id===next.id);
      if(run.state===status)return run;
      if(['failed','cancelled','interrupted'].includes(run.state))throw new Error(run.error);
      await sleep(250);
    }
    throw new Error('Timed out waiting for '+status);
  }
  const waiting=await waitFor('waiting_approval');
  host.app.decide(waiting.id,{id:waiting.approval.id,digest:waiting.approval.digest,allow:true});
  await waitFor('succeeded');
  const after=host.app.room(id);
  const asset=after.artifacts.at(-1);
  assert.equal(asset.project,before.project);
  assert.equal(asset.receipt.supersedes,prior.receipt.id);
  assert.deepEqual(after.artifacts.slice(0,-1).map(record=>record.receipt.id),priorReceipts);
  const fresh=await host.app.workbench.context(before.project);
  assert.equal(fresh.heads.script,asset.receipt.id);
  console.log(JSON.stringify({project:before.project,kept:priorReceipts,
    newArtifact:asset.receipt.id,version:asset.version,sourceDocuments:fresh.sources.length,fixture:true}));
} finally {
  await host?.close();
  await model.close();
}


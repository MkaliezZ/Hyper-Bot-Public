import { lstat, readFile, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { id, sha } from './contracts.mjs';

const projectKey=/^[0-9a-f]{32}$/;
const sourceKey=/^E[0-9a-f]{32}$/;
const artifactKey=/^A[0-9a-f]{32}$/;
const tempName=/\.json\.[0-9a-f]{32}\.tmp$/;
const at=()=>new Date().toISOString();

async function info(file,type) {
  try {
    const found=await lstat(file);
    if (found.isSymbolicLink() || !found[type]() || await realpath(file)!==file) {
      throw new Error('Workbench retention path is outside the isolated workspace.');
    }
    return true;
  } catch(error) {
    if (error.code!=='ENOENT') throw error;
    return false;
  }
}

async function files(directory,discardTemps=false) {
  if (!await info(directory,'isDirectory')) return [];
  const items=[];
  for (const name of await readdir(directory)) {
    if (discardTemps && tempName.test(name)) {
      const file=path.join(directory,name);
      if (await info(file,'isFile')) await unlink(file);
    } else if (name.endsWith('.json')) {
      const file=path.join(directory,name);
      if (await info(file,'isFile')) items.push(file);
    }
  }
  return items;
}

const read=async file=>JSON.parse(await readFile(file,'utf8'));

async function replace(file,value) {
  const scratch=file+'.retention.tmp';
  if (await info(scratch,'isFile')) await unlink(scratch);
  await writeFile(scratch,value,{encoding:'utf8',flag:'wx'});
  await rename(scratch,file);
}
const write=(file,value)=>replace(file,JSON.stringify(value,null,2));

function touchesSource(value,ids) {
  if (!value || typeof value!=='object') return false;
  if (ids.has(value.source_id)) return true;
  return Object.values(value).some(child=>touchesSource(child,ids));
}

function updateProject(project,origin,withdrawn) {
  const oldSources=project.agent_sources;
  const oldHeads=project.agent_heads;
  const typed=oldSources?.filter(row=>row.origin!==origin);
  const heads=oldHeads && Object.fromEntries(Object.entries(oldHeads).filter(([,key])=>!withdrawn.has(key)));
  const changed=oldSources?.length!==typed?.length || JSON.stringify(oldHeads)!==JSON.stringify(heads);
  if (!changed) return false;
  if (typed) project.agent_sources=typed;
  if (heads) project.agent_heads=heads;
  return true;
}

function reducedArtifact(artifact) {
  const {id,stage,request_id,created_at,supersedes,input_artifact_ids,scope}=artifact;
  return {id,stage,request_id,created_at,supersedes,input_artifact_ids,scope,payload:{},material_withdrawn:true};
}

async function clearTaskRequests(root,projectId,runIds,affectedContext) {
  for (const file of await files(path.join(root,'task-requests'),true)) {
    const record=await read(file);
    if (record.result?.project_id!==projectId) continue;
    const run=path.basename(file,'.json');
    const withdrawn=runIds.has(run);
    if (!withdrawn && !affectedContext(record.result.context)) continue;
    delete record.result.context;
    if (withdrawn) {
      delete record.result.task;
      record.result.material_withdrawn=true;
    }
    await write(file,record);
  }
}

// Only the private Workbench child uses this directory. Its host drains the
// service before touching these known stores of the pinned Workbench version.
export async function purgeWorkbenchMaterial(data,projectId,materialId,affectedRuns,digest) {
  if (!projectKey.test(projectId)) throw new Error('Unrecognized Workbench project.');
  const origin='hyper-bot:material:'+id.parse(materialId);
  const runIds=new Set(affectedRuns.map(run=>id.parse(run)));
  const root=path.join(data,'workbench'), project=path.join(root,'projects',projectId);
  if (!await info(root,'isDirectory') || !await info(project,'isDirectory')) return;
  const currentFile=path.join(project,'project.json');
  if (!await info(currentFile,'isFile')) return;
  const agent=path.join(project,'agent');
  await info(agent,'isDirectory');
  await files(project,true);
  const revisions=await files(path.join(project,'versions'),true);
  const current=await read(currentFile);
  const versions=await Promise.all(revisions.map(read));
  const sourceIds=new Set();
  const registeredIds=new Set();
  for (const version of [current,...versions]) {
    for (const row of version.agent_sources ?? []) {
      registeredIds.add(row.id);
      if (row.origin!==origin) continue;
      if (!sourceKey.test(row.id) || row.relative_path!=='agent/sources/'+row.id+'.txt') {
        throw new Error('Unexpected path for a Hyper Bot material copy.');
      }
      sourceIds.add(row.id);
    }
  }
  const sources=path.join(agent,'sources');
  if (await info(sources,'isDirectory')) {
    for (const name of await readdir(sources)) {
      const key=path.basename(name,'.txt');
      if (!sourceKey.test(key) || name!==key+'.txt') continue;
      const file=path.join(sources,name);
      if (!await info(file,'isFile')) continue;
      // A crash can leave bytes behind between writing a source and its first
      // revision snapshot. Match that orphan by the original digest only.
      const orphan=digest && !registeredIds.has(key) && sha(await readFile(file))===digest;
      if (sourceIds.has(key) || orphan) await unlink(file);
    }
  }

  const artifactFiles=await files(path.join(agent,'artifacts'),true);
  const artifacts=await Promise.all(artifactFiles.map(read));
  const withdrawn=new Set(artifacts.filter(row=>runIds.has(row.request_id) || touchesSource(row.payload,sourceIds)).map(row=>row.id));
  let changed=true;
  while(changed) {
    const before=withdrawn.size;
    for (const row of artifacts) {
      if (row.input_artifact_ids?.some(key=>withdrawn.has(key))) withdrawn.add(row.id);
    }
    changed=withdrawn.size!==before;
  }
  const isAffected=row=>runIds.has(row?.request_id) || withdrawn.has(row?.id) || touchesSource(row?.payload,sourceIds);
  const affectedContext=value=>!!value && (
    value.sources?.some(row=>row.origin===origin) || value.artifacts?.some(isAffected) ||
    value.tasks?.some(row=>runIds.has(row.request?.request_id))
  );
  for (const [index,row] of artifacts.entries()) {
    if (!withdrawn.has(row.id) || row.material_withdrawn) continue;
    if (!artifactKey.test(row.id) || path.basename(artifactFiles[index])!==row.id+'.json') {
      throw new Error('Unexpected Workbench artifact identity.');
    }
    await write(artifactFiles[index],reducedArtifact(row));
  }
  for (const file of await files(path.join(agent,'contexts'),true)) {
    if (affectedContext(await read(file))) await unlink(file);
  }
  for (const file of await files(path.join(agent,'attempts'),true)) {
    const attempt=await read(file);
    if (!isAffected(attempt.request) && !isAffected(attempt.response?.artifact)) continue;
    const request_id=attempt.request?.request_id;
    const {at,request_hash,response}=attempt;
    await write(file,{at,request_hash,request:{request_id},response:{
      accepted:!!response?.accepted,material_withdrawn:true,
      ...(response?.artifact ? {artifact:reducedArtifact(response.artifact)} : {})
    }});
  }
  for (const file of await files(path.join(agent,'tasks'),true)) {
    const task=await read(file);
    if (!runIds.has(task.request?.request_id) || task.material_withdrawn) continue;
    task.request.task='此任务说明已随材料授权清理。';
    task.material_withdrawn=true;
    await write(file,task);
  }
  await clearTaskRequests(root,projectId,runIds,affectedContext);
  const events=path.join(project,'events.jsonl');
  if (await info(events,'isFile')) {
    const rows=(await readFile(events,'utf8')).trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
    const registered=rows.filter(row=>row.action==='agent_source_registered' &&
      (row.detail.origin===origin || sourceIds.has(row.detail.id)));
    for (const row of registered) row.detail={id:row.detail.id,material_withdrawn:true};
    if (registered.length) await replace(events,rows.map(JSON.stringify).join('\n')+'\n');
  }
  // Source identities remain in the old revisions until the copy and its
  // derivatives are gone, so a restart can repeat a partially applied cleanup.
  for (const [index,version] of versions.entries()) {
    if (updateProject(version,origin,withdrawn)) await write(revisions[index],version);
  }
  if (updateProject(current,origin,withdrawn)) {
    current.revision++;
    current.updated_at=at();
    await write(path.join(project,'versions',String(current.revision).padStart(6,'0')+'.json'),current);
    await write(currentFile,current);
  }
}


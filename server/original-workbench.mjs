import { execFile } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { Problem, sha } from './contracts.mjs';
import { processEnvironment, requireRuntimeSource, root } from './config.mjs';
import { payloadHash, projectId, projectPath, scriptId, sourceId, workbenchRequest } from './workbench-protocol.mjs';

const exec=promisify(execFile);
const isHexHash=value=>typeof value==='string' && /^[a-f0-9]{64}$/.test(value);
const canonical=(value)=>process.platform==='win32'?path.normalize(value).toLowerCase():path.normalize(value);
const samePath=(left,right)=>typeof left==='string' && path.isAbsolute(left) && canonical(left)===canonical(right);
const offline=()=>new Problem(503,'未连接到正在运行的独立 Self Media Workbench。打开原工作台项目后可刷新。','original_workbench_offline');
const changed=()=>new Problem(409,'独立工作台的项目或材料已变化，请刷新原项目再继续。','workbench_conflict');
const otherStore=()=>new Problem(409,'当前服务对应的工作台数据目录与原绑定不一致。','workbench_identity');
const originFor=id=>'hyper-bot:material:'+id;
const normalizeText=content=>content.replace(/\r\n?/g,'\n');

function sourceLabel(source) {
  const label=String(source.label??'').replace(/[\\/:*?"<>|\x00-\x1f]/g,' ').trim().slice(0,170);
  return !label?'工作台材料.txt':/\.(txt|md)$/i.test(label)?label:label+'.txt';
}

const eligible = source => source?.integrity===true && sourceId.test(source.id) && isHexHash(source.sha256) &&
  typeof source.content==='string' && !!source.content.trim() && !source.content.includes('\0') &&
  Buffer.byteLength(source.content)<=64000;

function originValue(value) {
  const url=new URL(value);
  if (url.protocol!=='http:' || url.hostname!=='127.0.0.1' || !url.port || url.pathname!=='/' ||
      url.username || url.password || url.search || url.hash || (value!==url.origin && value!==url.href)) throw offline();
  return url.origin;
}

const scriptSources=record=>[...new Set(record.payload.claims.flatMap(claim=>claim.evidence.map(link=>link.source_id)))];

function contextWitness(context,{exceptSource,exceptTask}={}) {
  const {context_id,context_snapshot_path,project,sources,tasks,...rest}=context;
  const {revision,updated_at,agent_sources,...attributes}=project;
  return payloadHash({...rest,project:{...attributes,agent_sources:(agent_sources??[]).filter(source=>source.id!==exceptSource)},
    sources:sources.filter(source=>source.id!==exceptSource),tasks:tasks.filter(task=>task.request?.request_id!==exceptTask)});
}

export class OriginalWorkbench {
  constructor(config) { this.config=config; }

  async location(signal) {
    await requireRuntimeSource(this.config,'workbench',signal);
    const env=processEnvironment(Object.fromEntries(Object.entries({
      SELF_MEDIA_STATE_DIR:this.config.originalWorkbenchState,
      SELF_MEDIA_DATA_DIR:this.config.originalWorkbenchData
    }).filter(([,value])=>!!value)));
    try {
      const {stdout}=await exec(this.config.workbenchPython,
        ['-B','-X','utf8',path.join(root,'scripts','workbench_server.py'),this.config.workbenchRoot,'--locate'],
        {cwd:this.config.workbenchRoot,env,windowsHide:true,timeout:6500,signal});
      const {base,projects,manifest}=JSON.parse(stdout);
      if (![base,projects,manifest].every(value=>typeof value==='string'&&path.isAbsolute(value))) throw offline();
      const checkedRoot=await realpath(this.config.workbenchRoot);
      const data=await realpath(projects);
      if (!samePath(base,checkedRoot)) throw offline();
      const local=path.resolve(await realpath(this.config.data),'workbench','projects');
      if (samePath(data,local)) throw otherStore();
      return {root:checkedRoot,projects:data,manifest,storage:sha(canonical(data))};
    } catch(error) {
      if (signal?.aborted) throw signal.reason;
      if (error instanceof Problem) throw error;
      throw offline();
    }
  }

  async registry(location) {
    try {
      const row=JSON.parse(await readFile(location.manifest,'utf8'));
      if (!Number.isSafeInteger(row.pid) || row.pid<1 || !samePath(row.root,location.root)) throw offline();
      process.kill(row.pid,0);
      return {pid:row.pid,origin:originValue(row.base_url)};
    } catch {throw offline();}
  }

  async connect(signal) {
    const location=await this.location(signal);
    const session=await this.registry(location);
    const connection={...location,...session};
    try {
      const status=await this.request(connection,'GET','/api/status',undefined,signal);
      if (!samePath(status.root,location.root) || status.agent_capabilities!=='/api/agent/v1/capabilities') throw offline();
    } catch(error) {
      if (signal?.aborted) throw signal.reason;
      throw offline();
    }
    return connection;
  }

  async request(connection,method,route,body,signal) {
    const current=await this.registry(connection);
    if (current.pid!==connection.pid || current.origin!==connection.origin) {
      throw new Problem(503,'独立工作台服务已切换。请先核对原项目。','workbench_transport');
    }
    return workbenchRequest(connection.origin,method,route,body,signal);
  }

  async list(signal) {
    const client=await this.connect(signal);
    const rows=await this.request(client,'GET','/api/projects',undefined,signal);
    if (!Array.isArray(rows)) throw offline();
    return rows.filter(row=>projectId.test(row?.id) && typeof row.title==='string' && row.title.trim())
      .map(({id,title,simulation})=>({id,title,simulation:!!simulation,storage:client.storage}));
  }

  async context(project,original,signal,client) {
    client??=await this.connect(signal);
    if (original && original.storage!==client.storage) throw otherStore();
    const ctx=await this.request(client,'GET',projectPath(project,'/context'),undefined,signal);
    if (ctx.protocol_version!==1 || ctx.project?.id!==project || !Number.isSafeInteger(ctx.project.revision) ||
        typeof ctx.project.created_at!=='string' || !Array.isArray(ctx.sources) || !Array.isArray(ctx.artifacts) ||
        !Array.isArray(ctx.tasks) || !ctx.heads || !isHexHash(ctx.context_id)) throw otherStore();
    if (original && original.createdAt!==ctx.project.created_at) throw otherStore();
    const expected=path.join(client.projects,project,'agent','contexts',ctx.context_id+'.json');
    if (!samePath(ctx.context_snapshot_path,expected) ||
        !samePath(await realpath(ctx.context_snapshot_path).catch(()=>null),expected)) throw otherStore();
    return {ctx,client};
  }

  async bind(project,storage,signal) {
    const connection=await this.connect(signal);
    if (storage!==connection.storage) throw otherStore();
    const {ctx,client}=await this.context(project,null,signal,connection);
    return {id:project,title:ctx.project.title,simulation:!!ctx.project.simulation,
      original:{storage:client.storage,createdAt:ctx.project.created_at}};
  }

  async contents(room,signal) {
    const {ctx}=await this.context(room.project,room.original,signal);
    const draft=ctx.artifacts.find(row=>row.id===ctx.heads.script && row.stage==='script' &&
      !row.material_withdrawn && Array.isArray(row.payload?.segments) && row.payload.segments.length>0 &&
      Array.isArray(row.payload?.claims));
    return {project:room.project,revision:ctx.project.revision,
      sources:ctx.sources.filter(eligible).map(row=>({id:row.id,name:sourceLabel(row),digest:row.sha256,
        bytes:Buffer.byteLength(row.content)})),
      latest:draft?{id:draft.id,segments:draft.payload.segments.length,createdAt:draft.created_at,
        sourceIds:scriptSources(draft)}:null};
  }

  async material(room,id,expected,signal) {
    const {ctx}=await this.context(room.project,room.original,signal);
    const file=ctx.sources.find(row=>row.id===id);
    if (!eligible(file) || file.sha256!==expected) throw changed();
    return {name:sourceLabel(file),content:file.content,originalSource:{id,digest:file.sha256}};
  }

  async prepare(room,run,materials,signal,onProject) {
    const {ctx}=await this.context(room.project,room.original,signal);
    const sources={}, pending=[];
    for (const file of materials) {
      if (file.originalSource) {
        const source=ctx.sources.find(row=>row.id===file.originalSource.id);
        if (!eligible(source) || source.sha256!==file.originalSource.digest || source.content!==file.content) throw changed();
        sources[file.id]=source.id;
      } else {
        const matches=ctx.sources.filter(row=>row.origin===originFor(file.id));
        if (matches.length>1) throw changed();
        if (matches.length) {
          const [source]=matches;
          if (!eligible(source) || source.content!==normalizeText(file.content) ||
              source.sha256!==file.digest) throw changed();
          sources[file.id]=source.id;
        } else {
          sources[file.id]=file.id;
          pending.push({id:file.id,name:file.name,content:file.content,digest:file.digest,
            nature:room.simulation?'simulation':'provided'});
        }
      }
    }
    const base=run.originalBase?this.currentScript(ctx,run.originalBase,room.projectTitle,new Set(Object.values(sources))):null;
    onProject(room.project,null);
    return {project:room.project,context:ctx,original:room.original,conversation:room.id,pending,sources,base};
  }

  currentScript(ctx,id,title,allowedSources) {
    const record=ctx.artifacts.find(row=>row.id===id && row.id===ctx.heads.script && row.stage==='script');
    const shots=record?.payload?.segments;
    if (!scriptId.test(id) || record?.material_withdrawn || !Array.isArray(shots) || !shots.length) throw changed();
    if (!Array.isArray(record.payload.claims) || scriptSources(record).some(id=>!allowedSources.has(id))) {
      throw new Problem(403,'带入原稿时，请一并选用原稿引用的项目材料。','material_scope');
    }
    const sequence=shots.map((shot,index)=>({
      name:'镜头 '+(index+1),start:shot.start,end:shot.end,spoken:shot.spoken,visual:shot.visual,subtitle:shot.subtitle
    }));
    const base={title,segments:sequence,notes:record.unresolved??[]};
    if (Buffer.byteLength(JSON.stringify(base))>96000) {
      throw new Problem(422,'原项目当前稿件正文超过本轮可用长度。可先选取授权文字生成新版本。','original_base_size');
    }
    return base;
  }

  async save(plan,beforeWrite,signal) {
    let {ctx,client}=await this.context(plan.project,plan.original,signal);
    if (ctx.context_id!==plan.body.context_id || ctx.project.revision!==plan.body.revision) throw changed();
    const mapped=new Map();
    for (const item of plan.register) {
      if (sha(item.content)!==item.digest || ctx.sources.some(source=>source.origin===originFor(item.id))) throw changed();
      beforeWrite({kind:'source',material:item.id});
      const added=await this.request(client,'POST',projectPath(plan.project,'/sources'),{
        revision:ctx.project.revision,label:item.name,nature:item.nature,origin:originFor(item.id),content:item.content
      },signal);
      const id=added.source?.id;
      const {ctx:next}=await this.context(plan.project,plan.original,signal,client);
      const source=next.sources.find(row=>row.id===id);
      if (!eligible(source) || source.origin!==originFor(item.id) || source.sha256!==item.digest ||
          next.project.revision!==ctx.project.revision+1 || contextWitness(ctx)!==contextWitness(next,{exceptSource:id})) throw changed();
      mapped.set(item.id,id);
      ctx=next;
    }
    beforeWrite({kind:'task',sources:[...mapped.values()]});
    const task=await this.request(client,'POST','/api/agent/v1/tasks',{
      request_id:plan.body.request_id,session_key:'hyper-bot:'+plan.conversation,intent:'script',
      task:'Hyper Bot 已批准的口播分镜提交',project:plan.project,new_project:false,simulation:!!ctx.project.simulation
    },signal);
    const {ctx:next}=await this.context(plan.project,plan.original,signal,client);
    if (task.project_id!==plan.project || task.project_created || !projectId.test(task.task_id) ||
        !next.tasks.some(row=>row.request?.request_id===plan.body.request_id &&
          row.request?.session_key==='hyper-bot:'+plan.conversation) ||
        next.project.revision!==ctx.project.revision || contextWitness(ctx)!==
          contextWitness(next,{exceptTask:plan.body.request_id})) throw changed();
    const body=structuredClone(plan.body);
    body.context_id=next.context_id;
    body.revision=next.project.revision;
    for (const claim of body.payload.claims) {
      for (const reference of claim.evidence) {
        reference.source_id=mapped.get(reference.source_id)??reference.source_id;
        if (!sourceId.test(reference.source_id)) throw changed();
      }
    }
    const submission={body,digest:payloadHash(body)};
    beforeWrite({kind:'artifact',submission,task:task.task_id,sources:[...mapped.values()]});
    return {client,submission};
  }

  async sourceEffects(plan,signal) {
    const {ctx}=await this.context(plan.project,plan.original,signal);
    const added=[];
    for (const item of plan.register) {
      const matches=ctx.sources.filter(source=>source.origin===originFor(item.id));
      if (matches.length>1 || matches.some(source=>!eligible(source) || source.sha256!==item.digest)) throw changed();
      if (matches.length) added.push(matches[0].id);
    }
    return {added,task:ctx.tasks.some(row=>row.request?.request_id===plan.body.request_id)};
  }
}


import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { addAbortListener } from 'node:events';
import { mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { Problem } from './contracts.mjs';
import { processEnvironment, requireRuntimeSource, root } from './config.mjs';
import { purgeWorkbenchMaterial } from './workbench-retention.mjs';
import { OriginalWorkbench } from './original-workbench.mjs';
import { payloadHash, planDigest, projectId, projectPath, workbenchRequest } from './workbench-protocol.mjs';
import { estimateScriptTiming, scriptTimingNotes } from './workbench-workflow.mjs';
import { evidenceReviewNotes, reviewScriptEvidence } from './script-evidence.mjs';

export { payloadHash, planDigest };

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
export class Workbench {
  static async rehearseScript(config,run,materials,result,signal) {
    signal.throwIfAborted();
    const isolated=new Workbench({...config,data:path.join(config.data,'runtime',run.id)});
    try {
      const conversation={id:run.id,title:run.title,simulation:true};
      const prepared=await isolated.prepare(conversation,run,materials,signal,()=>{});
      const plan=await isolated.proposal(prepared,run,result,materials,signal);
      await isolated.commit(plan,()=>{},signal);
      return {timing:plan.timing,...(plan.evidenceReview?{evidenceReview:plan.evidenceReview}:{})};
    } finally {
      await isolated.close();
    }
  }

  constructor(config) {
    this.config = config;
    this.data = path.join(config.data, 'workbench');
    this.child = null;
    this.pending = null;
    this.base = null;
    this.bridgeKey = randomUUID();
    this.maintenance = null;
    this.original = new OriginalWorkbench(config);
  }

  async ensure(signal) {
    signal?.throwIfAborted();
    if (this.maintenance) await this.maintenance.catch(() => {});
    signal?.throwIfAborted();
    if (!this.config.workbench.ok) throw new Problem(503, this.config.workbench.reason, 'workbench_unavailable');
    if (this.base && this.child?.exitCode === null) return this.base;
    this.pending ??= this.start().finally(() => { this.pending = null; });
    return this.pending;
  }

  async start() {
    const {workbenchRoot, workbenchPython} = this.config;
    await mkdir(this.data, {recursive:true});
    await requireRuntimeSource(this.config,'workbench');
    // Workbench adds generated file names and temporary suffixes under this directory.
    const state = path.toNamespacedPath(await realpath(this.data));
    const child = spawn(workbenchPython,['-B','-X','utf8',path.join(root,'scripts/workbench_server.py'),workbenchRoot],{
      cwd:workbenchRoot,env:processEnvironment({SELF_MEDIA_STATE_DIR:state,
        SELF_MEDIA_DATA_DIR:path.join(state,'projects'),PYTHONDONTWRITEBYTECODE:'1',PYTHONUTF8:'1',
        HYPER_BOT_WORKBENCH_BRIDGE:this.bridgeKey}),
      windowsHide:true,stdio:['pipe','pipe','pipe']
    });
    child.stdin.on('error', () => {});
    child.stderr.resume();
    const lines = createInterface({input:child.stdout});
    this.child = child;
    let closed = false;
    const origin = await new Promise((resolve,reject) => {
      const timer = setTimeout(() => reject(new Error('Workbench startup timeout')),18000);
      timer.unref();
      child.once('error', () => {clearTimeout(timer);reject(new Error('Workbench Python unavailable'));});
      child.once('close', () => {
        closed = true;
        clearTimeout(timer);
        if (this.child === child) {this.base = null;this.child = null;}
        reject(new Error('Workbench process exited'));
      });
      lines.on('line',line => {
        try {
          const {port} = JSON.parse(line);
          if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) return;
          clearTimeout(timer);
          resolve('http://127.0.0.1:'+port);
        } catch { /* Ignore non-protocol lines. */ }
      });
    }).catch(async () => {
      await this.stopChild();
      throw new Problem(503,'自媒体工作台无法启动。请检查已登记的 Python 和依赖。','workbench_unavailable');
    });
    for (let attempt = 0; attempt < 30 && !closed; attempt++) {
      try {
        const status = await fetch(origin+'/api/status',{redirect:'error',signal:AbortSignal.timeout(800),headers:{'X-Hyper-Bot-Bridge':this.bridgeKey}}).then(r=>r.json());
        if (path.resolve(status.root) === path.resolve(workbenchRoot)) {
          this.base = origin;
          return origin;
        }
      } catch { /* The child is still starting. */ }
      await wait(120);
    }
    await this.stopChild();
    throw new Problem(503,'自媒体工作台启动后未能完成握手。','workbench_unavailable');
  }

  async close() {
    await this.pending?.catch(() => {});
    await this.stopChild();
  }

  async stopChild() {
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    const closed = new Promise(resolve => child.once('close',resolve));
    child.stdin.end();
    const timer = setTimeout(() => child.kill(),3500);
    timer.unref();
    await closed;
    clearTimeout(timer);
  }

  async clearMaterials(project, material, runs, digest) {
    const work=async()=>{
      await this.close();
      await purgeWorkbenchMaterial(await realpath(this.config.data),project,material,runs,digest);
    };
    this.maintenance=work().finally(()=>{this.maintenance=null;});
    return this.maintenance;
  }

  async request(method,route,body,signal) {
    const ready=this.ensure(signal);
    let origin;
    if (signal) {
      // A task can stop waiting while the shared bridge continues starting.
      const stopped=Promise.withResolvers();
      const listener=addAbortListener(signal,()=>stopped.reject(signal.reason));
      try {origin=await Promise.race([ready,stopped.promise]);}
      finally {listener[Symbol.dispose]();}
    } else origin=await ready;
    signal?.throwIfAborted();
    return workbenchRequest(origin,method,route,body,signal,{'X-Hyper-Bot-Bridge':this.bridgeKey});
  }

  async list(signal) {
    const items=await this.request('GET','/api/projects',undefined,signal);
    return items.map(({id,title,simulation})=>({id,title,simulation}));
  }

  path(project,suffix) {return projectPath(project,suffix);}

  async context(project,signal,original) {
    if (original) return (await this.original.context(project,original,signal)).ctx;
    return this.request('GET',this.path(project,'/context'),undefined,signal);
  }

  async prepare(conversation, run, materials, signal, onProject) {
    if (conversation.original) return this.original.prepare(conversation,run,materials,signal,onProject);
    let selected = conversation.project;
    if (conversation.projectRequired && !selected) {
      throw new Problem(409,'当前会话缺少确认过的原项目。','workbench_missing');
    }
    const session = 'hyper-bot:'+conversation.id;
    if (!selected) {
      // Resolve the deterministic first project even if the previous response was lost.
      const projectTitle = (conversation.projectTitle || conversation.title).slice(0,100)+' · '+conversation.id.slice(0,8);
      const matches = (await this.list(signal)).filter(item=>item.title===projectTitle&&item.simulation===conversation.simulation);
      if (matches.length>1) throw new Problem(409,'已发现多个可能的原项目，需核对绑定。','workbench_conflict');
      if (matches.length===1) selected=matches[0].id;
      else {
        const binding=await this.request('POST','/api/agent/v1/tasks',{
          request_id:'bind-'+conversation.id,session_key:session,intent:'script',
          task:'初始化 Hyper Bot 口播项目',new_project:true,title:projectTitle,simulation:conversation.simulation
        },signal);
        selected=binding.project_id;
      }
      signal.throwIfAborted();
      if (!projectId.test(selected??'')) throw new Problem(502,'工作台没有返回可确认的项目。','workbench_transport');
      onProject(selected,null);
    }
    const intake = await this.request('POST','/api/agent/v1/tasks',{
      request_id:run.id, session_key:session, intent:'script',
      task:run.prompt, project:selected, new_project:false, simulation:conversation.simulation
    },signal);
    const project = intake.project_id;
    if (!projectId.test(project??'') || (selected && selected !== project)) {
      throw new Problem(409,'工作台返回了不同的项目。','workbench_conflict');
    }
    onProject(project,intake.task_id);
    let ctx = await this.context(project,signal);
    const sources = {};
    for (const item of materials) {
      signal.throwIfAborted();
      const origin = 'hyper-bot:material:'+item.id;
      const previous = ctx.sources.find(row=>row.origin === origin);
      if (previous && (previous.content !== item.content || !previous.integrity)) {
        throw new Problem(409,'已登记材料的内容发生变化。','workbench_conflict');
      }
      if (previous) sources[item.id] = previous.id;
      else {
        const response = await this.request('POST', this.path(project,'/sources'), {
          revision:ctx.project.revision,label:item.name,nature:conversation.simulation ? 'simulation' : 'provided',
          origin,content:item.content
        },signal);
        sources[item.id] = response.source.id;
        ctx = await this.context(project,signal);
      }
    }
    return {project, context:ctx, sources};
  }

  async proposal(prepared,run,result,materials,signal) {
    const timing=await estimateScriptTiming(this.config,result.segments,signal);
    const evidenceReview=reviewScriptEvidence(result,materials);
    const reviewShots=new Set(evidenceReview.map(row=>row.index));
    const ctx=await this.context(prepared.project,signal,prepared.original);
    if (ctx.project.revision !== prepared.context.project.revision || ctx.context_id !== prepared.context.context_id) {
      throw new Problem(409,'生成期间原项目发生变化。请使用当前材料重新生成。','workbench_conflict');
    }
    const claims = [];
    const segments = result.segments.map((row,index) => {
      const claim_id = 'c'+(index+1);
      const evidence = row.evidence.map(ref=>({source_id:prepared.sources[ref.material],quote:ref.quote}));
      const needsReview=reviewShots.has(index);
      claims.push({ id:claim_id, text:row.spoken, kind:needsReview?'hypothesis':evidence.length?'observation':'plan', evidence,
        limitation:needsReview?'本镜有待核对的表述。请比对原文并结合语境读审。':
          evidence.length?'已登记原文摘录，稿件表述与材料的关系待创作者读审。':'本镜按拍摄安排处理。' });
      return {id:'s'+(index+1),start:row.start,end:row.end,spoken:row.spoken,visual:row.visual,
        subtitle:row.subtitle,claim_ids:[claim_id]};
    });
    const supersedes = ctx.heads.script ?? null;
    const topic = ctx.artifacts.find(row=>row.id === ctx.heads.topics && !row.dependency_stale);
    const body = {
      request_id:run.id, stage:'script', revision:ctx.project.revision,context_id:ctx.context_id,
      input_artifact_ids:topic ? [topic.id] : [],
      standalone_reason:topic ? null : '用户已给定选题或内容方向，本轮只处理口播分镜。',
      payload:{topic_artifact_id:topic?.id ?? null,topic_id:topic?.payload?.selected_id ?? null,
        claims,segments,cta:'',production_limits:[...scriptTimingNotes(timing),...result.notes]},
      declared_status:'needs_review',unresolved:[...result.notes,...evidenceReviewNotes(evidenceReview)],supersedes,
      revision_reason:supersedes ? run.prompt.slice(0,420) : null
    };
    const plan={project:prepared.project,body,result,timing,...(evidenceReview.length?{evidenceReview}:{})};
    if (prepared.original) {
      const used=new Set(claims.flatMap(claim=>claim.evidence.map(ref=>ref.source_id)));
      Object.assign(plan,{original:prepared.original,conversation:prepared.conversation,
        register:prepared.pending.filter(item=>used.has(item.id))});
    }
    return {...plan,digest:planDigest(plan)};
  }

  async commit(plan,onSubmit,signal) {
    await requireRuntimeSource(this.config,'workbench',signal);
    if (plan.original) {
      const {client,submission}=await this.original.save(plan,onSubmit,signal);
      const result=await this.original.request(client,'POST',projectPath(plan.project,'/artifacts'),submission.body,signal);
      if (!result.accepted) throw new Problem(422,'原工作台未接受此稿。','workbench_validation');
      return this.confirmReceipt({...plan,submission},result,signal);
    }
    const current = await this.context(plan.project,signal);
    if (current.context_id !== plan.body.context_id || current.project.revision !== plan.body.revision) {
      throw new Problem(409,'原项目在审批期间发生变化，请核对后重新生成。','workbench_conflict');
    }
    onSubmit();
    const result = await this.request('POST',this.path(plan.project,'/artifacts'),plan.body,signal);
    if (!result.accepted) throw new Problem(422,'工作台未接受此稿。','workbench_validation');
    return this.confirmReceipt(plan,result,signal);
  }

  async confirmReceipt(plan,result,signal) {
    const verified=await this.recover(plan,signal).catch(()=>null);
    if (!verified || verified.id !== result.artifact?.id) {
      throw new Problem(502,'写入后未读到一致的工作台回执。','workbench_transport');
    }
    return verified;
  }

  async recover(plan,signal) {
    if (plan.original && !plan.submission) return null;
    const expected=plan.submission??plan;
    const ctx=await this.context(plan.project,signal,plan.original);
    const record=ctx.artifacts.find(row=>row.request_id===expected.body.request_id && row.stage==='script');
    if (!record) return null;
    const recovered = Object.fromEntries(Object.keys(expected.body).map(key=>[key,record[key]]));
    if (payloadHash(recovered)!==expected.digest) {
      throw new Problem(409,'原项目有同任务编号的不同写入记录，需人工核对。','workbench_conflict');
    }
    return {id:record.id, project:ctx.project.id, revision:ctx.project.revision, supersedes:record.supersedes,
      publishedAt:record.created_at};
  }
}


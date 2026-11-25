import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { z } from 'zod';
import { Problem, botKey as slug, heading, sha, definitionPrompt, resultOf } from './contracts.mjs';
import { at, botOf, isLive, skillOf } from './store.mjs';
import { checkedSample, checkSampleResult, materializeExample, sampleDigest, sampleFixtureInput } from './bot-sample.mjs';
import { cleanRuntime } from './materials.mjs';
import { DRIVERS, execute } from './engines.mjs';
import { dependencies, requireRuntimeSource, WB_REVISION } from './config.mjs';
import { unusedMeter } from './provider.mjs';
import { legacyVerification, upstreamMode } from './run-receipts.mjs';
import { Workbench } from './workbench.mjs';

const version = z.string().regex(/^\d+\.\d+\.\d+$/);
const kind = z.enum(['script','brief']);
const referencePath = /^references\/(?:[\p{L}\p{N}][\p{L}\p{N}\p{M}._-]{0,60}\/)*[\p{L}\p{N}][\p{L}\p{N}\p{M}._-]{0,60}\.md$/iu;
const document = z.strictObject({name:z.string().regex(referencePath),text:z.string().trim().min(1).max(16000)});
const importInput = z.strictObject({slug,version,name:heading,origin:z.string().trim().min(1).max(500),
  content:z.string().trim().min(20).max(20000),references:z.array(document).max(6),
  outputKind:kind.nullable().default(null),reviewed:z.literal(true)});
const botInput = z.strictObject({id:slug,name:heading,kind,driver:z.enum(Object.keys(DRIVERS)),
  description:z.string().trim().min(4).max(400),skills:z.array(z.string().min(1).max(100)).max(6),
  workflow:slug.optional(),fixture:sampleFixtureInput.optional(),sourceRevision:z.number().int().positive().optional(),
  reuseSample:z.strictObject({authorized:z.literal(true)}).optional() });

export { makeSamples } from './bot-sample.mjs';

const skillKind = skill => skill.outputKind ?? (skill.builtin
  ? {'talking-script':'script','material-brief':'brief'}[skill.id] ?? null
  : null);

function setupSkills(state,bot) {
  return bot.skills.map(id=>{
    const skill=skillOf(state,id);
    if (skill.revokedAt) throw new Problem(409,'Skill「'+skill.name+'」已撤销，请选择可用版本。','skill_revoked');
    const output=skillKind(skill);
    if (output && output!==bot.kind) {
      throw new Problem(422,'Skill「'+skill.name+'」与所选成果类型不兼容。','skill_scope');
    }
    if (sha(skill.content)!==skill.digest) {
      throw new Problem(409,'Skill「'+skill.name+'」与登记摘要不一致。','skill_integrity');
    }
    return skill;
  });
}

const installedDriver=bot=>Object.hasOwn(DRIVERS,bot.driver)?DRIVERS[bot.driver]:null;
const workflowFor=(bot,id)=>installedDriver(bot)?.workflows?.find(flow=>flow.id===id&&flow.kind===bot.kind);
function changedWorkflow(bot) {
  if (!bot.workflow) return false;
  const workflow=workflowFor(bot,bot.workflow.id);
  return bot.skills.length>0 || !workflow || workflow.digest!==bot.workflow.digest;
}
const workflowMetadata=({instructions,...info})=>info;

function setupMethods(state,bot) {
  if (changedWorkflow(bot)) {
    throw new Problem(409,'此版自带流程与本机登记不同。请基于此版重新装配。','workflow_binding');
  }
  return {skills:setupSkills(state,bot),workflow:workflowFor(bot,bot.workflow?.id)};
}

function digestAssembly(bot,{skills,workflow}) {
  const fixture=bot.fixture;
  if (fixture && sampleDigest(fixture)!==fixture.digest) throw new Problem(409,'样例摘要不一致。','sample_integrity');
  return sha(JSON.stringify({
    id:bot.id,revision:bot.revision,kind:bot.kind,driver:bot.driver,driverRevision:bot.driverRevision,
    skills:skills.map(skill=>({id:skill.id,digest:skill.digest,outputKind:skillKind(skill)})),
    fixture:fixture?.digest??'bookstore-v1',
    ...(workflow?{workflow:{id:workflow.id,digest:workflow.digest}}:{})
  }));
}

function sampleReady(state,bot,model,methods) {
  const sample=bot.sample;
  if (!sample?.ok || !bot.driverRevision || sample.driverRevision!==bot.driverRevision) return false;
  if (bot.status==='draft' && bot.kind==='script' && sample.workbenchRevision!==WB_REVISION) return false;
  if (!sample.assemblyDigest) return !bot.fixture&&!bot.workflow; // Pre-existing qualifications.
  try {
    return (!model || sample.model===model) && sample.assemblyDigest===digestAssembly(bot,methods??setupMethods(state,bot));
  } catch {return false;}
}

function inheritedSample(source,kind) {
  if (!source?.fixture || source.kind!==kind) {
    throw new Problem(422,'所选来源版本没有适用于此成果类型的自备样例。','sample_source');
  }
  const {digest,...fixture}=source.fixture;
  if (sampleDigest(fixture)!==digest) throw new Problem(409,'样例摘要不一致。','sample_integrity');
  return checkedSample({...fixture,authorized:true},kind);
}

const revokedSkill=(state,bot)=>state.skills.find(skill=>skill.revokedAt&&bot.skills.includes(skill.id));

function verifiedPreview(state,bot) {
  if (!bot.sample?.ok || revokedSkill(state,bot)) return;
  const run=state.verifications?.find(row=>row.id===bot.sample.runId && row.botId===bot.id &&
    row.botRevision===bot.revision && row.state==='succeeded');
  const preview=run?.samplePreview;
  if (preview && preview.assemblyDigest===bot.sample.assemblyDigest) return preview;
}

async function clearSampleRuntime(data,id) {
  try {
    await cleanRuntime(data,id);
    return true;
  } catch(error) {
    console.error('Hyper Bot sample cleanup:',error?.code??error?.name);
    return false;
  }
}

function publicBot(bot) {
  const {fixture,...visible}=bot;
  return fixture ? {...visible,
    exampleTitle:fixture.useInChat ? fixture.title : null,
    verificationFixture:{title:fixture.title,fileCount:fixture.files.length,digest:fixture.digest,
      checksReference:!!fixture.expectedQuote}
  } : visible;
}

export function botBlock(state, config, bot) {
  const revoked=revokedSkill(state,bot);
  if (revoked) return 'Skill「'+revoked.name+'」已撤销。请基于此版重新装配。';
  const driver=installedDriver(bot);
  if (!driver) return '本机缺少此 Bot 绑定的 Harness。请基于此版重新装配。';
  const {revision}=driver;
  if (bot.driverRevision!==revision) return '此 Bot 绑定的 Harness 版本与本机不同。请基于此版重新装配。';
  if (changedWorkflow(bot)) return '此版自带流程与本机登记不同。请基于此版重新装配。';
  if (state.registered[bot.driver]!==revision) return 'Harness 版本待登记。';
  const health=dependencies(config);
  return health[bot.driver] || (bot.kind==='script' ? health.workbench : '');
}

export function approvedMethodsForRun(state,bot) {
  const methods=setupMethods(state,bot);
  if (!bot.qualification && !sampleReady(state,bot,undefined,methods)) {
    throw new Problem(409,'此版本的任务流程与已通过的样例不一致。请重新装配并验证。','sample_required');
  }
  return methods;
}

function checkedText(text, source, names) {
  if (/\0|```(?:ps1|powershell|bash|sh|shell|cmd|bat|python|py|javascript|js|node|ruby|perl|exe)\b|<script\b|(?:^|\n)\s*(?:allowed-tools|mcpServers|hooks|command|scripts)\s*:/i.test(text)) {
    throw new Problem(422,'Skill 仅允许说明性 Markdown。检测到脚本或权限声明。','invalid_skill');
  }
  for (const match of text.matchAll(/\]\(\s*([^\s)]+)(?:\s+[^)]*)?\)/g)) {
    const [target] = match[1].split('#',1);
    if (target && (target.startsWith('/') || !/^[\p{L}\p{N}\p{M}._/-]+$/u.test(target) ||
        (!names.has(posix.join(posix.dirname(source),target)) && !names.has(target)))) {
      throw new Problem(422,'Skill 引用了包外或未登记文件。','invalid_skill');
    }
  }
}

export class Registry {
  constructor(store,config) {
    this.store = store;
    this.config = config;
    this.testing = null;
  }

  bindLegacyDrivers() {
    const unbound=bot=>!Object.hasOwn(bot,'driverRevision');
    if (!this.store.read().bots.some(unbound)) return;
    this.store.change(state=>{
      for (const bot of state.bots.filter(unbound)) {
        bot.driverRevision=bot.sample?.driverRevision??state.registered[bot.driver]??null;
      }
    });
  }

  view(state) {
    return {
      bots: state.bots.map(bot=>({...publicBot(bot),blocked:botBlock(state,this.config,bot),
        skillRevoked:!!revokedSkill(state,bot),harnessChanged:installedDriver(bot)?.revision!==bot.driverRevision,
        workflowChanged:changedWorkflow(bot),sampleReady:sampleReady(state,bot,bot.status==='draft'?this.config.model:undefined),
        sampleBusy:this.testing===bot.id+'/'+bot.revision,samplePreviewAvailable:!!verifiedPreview(state,bot)})),
      skills:state.skills.map(({content,...meta})=>({...meta,outputKind:skillKind(meta)})),
      drivers:Object.values(DRIVERS).map(({run,workflows=[],...meta})=>({...meta,workflows:workflows.map(workflowMetadata),
        registered:state.registered[meta.id]===meta.revision,blocked:dependencies(this.config)[meta.id]}))
    };
  }

  samplePreview(id,revision) {
    const state=this.store.read(), bot=botOf(state,id,revision);
    const preview=verifiedPreview(state,bot);
    if (!preview) throw new Problem(404,'此版没有可查看的样例成果。','sample_preview_unavailable');
    return {kind:bot.kind,runId:bot.sample.runId,model:bot.sample.model,at:bot.sample.at,
      ...(bot.sample.workbenchRevision?{workbenchRevision:bot.sample.workbenchRevision}:{}),
      ...(preview.timing?{timing:preview.timing}:{}),
      ...(preview.evidenceReview?{evidenceReview:preview.evidenceReview}:{}),
      result:preview.result,materials:preview.materials};
  }

  ingest(raw) {
    const input = importInput.parse(raw);
    const names = new Set(['SKILL.md',...input.references.map(file=>file.name)]);
    if (new Set(input.references.map(file=>file.name.toLowerCase())).size!==input.references.length) {
      throw new Problem(409,'引用文件名重复。','invalid_skill');
    }
    checkedText(input.content,'SKILL.md',names);
    for (const file of input.references) checkedText(file.text,file.name,names);
    const content = [input.content,...input.references.map(file=>'\n# '+file.name+'\n'+file.text)].join('\n');
    const id = input.slug+'@'+input.version;
    const record = {id,name:input.name,version:input.version,content,digest:sha(content),origin:input.origin,
      outputKind:input.outputKind,references:input.references.map(file=>({name:file.name,digest:sha(file.text)})),
      importedAt:at(),builtin:false};
    return this.store.change(state=>{
      if (state.skills.some(row=>row.id===id)) throw new Problem(409,'该 Skill 版本已经登记。');
      state.skills.push(record);
      return id;
    });
  }

  revokeSkillIn(state,emit,id) {
    const skill=skillOf(state,id);
    if (skill.revokedAt) return {revokedAt:skill.revokedAt,affected:[]};
    skill.revokedAt=at();
    // Keep the identifier and original digest. Older builds also reject this entry.
    skill.content='';
    const affected=state.bots.filter(bot=>bot.skills.includes(skill.id));
    for (const bot of affected) {
      const verification=state.verifications?.find(row=>row.id===bot.sample?.runId);
      if (verification) delete verification.samplePreview;
      this.disableIn(state,emit,bot.id,bot.revision,'本轮使用的 Skill 已撤销，待写入授权已失效。');
    }
    return {revokedAt:skill.revokedAt,affected};
  }

  async checkSources(bot,signal) {
    const {workbench,hermes}=this.config;
    try {
      if (bot.kind==='script') await requireRuntimeSource(this.config,'workbench',signal);
      if (bot.driver==='hermes') await requireRuntimeSource(this.config,'hermes',signal);
    } catch (error) {
      if (workbench!==this.config.workbench || hermes!==this.config.hermes) this.store.change(()=>{});
      throw error;
    }
  }

  async registerDriver(driver) {
    const entry = DRIVERS[driver];
    if (!entry || !Object.hasOwn(DRIVERS,driver)) throw new Problem(404,'Harness 适配器未受审核。');
    await this.checkSources({driver});
    const blocked = dependencies(this.config)[driver];
    if (blocked) throw new Problem(503,blocked);
    this.store.change(state=>{state.registered[driver]=entry.revision;});
  }

  draft(raw) {
    const {fixture:submitted,sourceRevision,reuseSample,workflow:workflowId,...input}=botInput.parse(raw);
    if (reuseSample && (submitted || sourceRevision===undefined)) {
      throw new Problem(422,'沿用样例需指定来源版本，请选择一种样例来源。','sample_source');
    }
    if (new Set(input.skills).size !== input.skills.length) throw new Problem(422,'请删除重复 Skill。');
    if (!DRIVERS[input.driver].capabilities.includes(input.kind==='script'?'script':'text')) {
      throw new Problem(422,'所选 Harness 缺少该成果类型需要的能力。','invalid_driver');
    }
    const workflow=workflowFor(input,workflowId);
    if (workflowId && (!workflow || input.skills.length)) {
      throw new Problem(422,'请使用所选 Harness 声明的自带流程，或引用已审阅的 Skill。','workflow_scope');
    }
    if (!workflow&&!input.skills.length) {
      throw new Problem(422,'请选择已审阅的 Skill 或自带流程。','workflow_required');
    }
    return this.store.change(state=>{
      setupSkills(state,input);
      const source=sourceRevision===undefined?null:botOf(state,input.id,sourceRevision);
      const fixture=reuseSample?inheritedSample(source,input.kind):checkedSample(submitted,input.kind);
      const revision = Math.max(0,...state.bots.filter(bot=>bot.id===input.id).map(bot=>bot.revision))+1;
      const bot = {...input,fixture,revision,driverRevision:DRIVERS[input.driver].revision,
        ...(source?{sourceRevision:source.revision}:{}),...(workflow?{workflow:workflowMetadata(workflow)}:{}),
        subtitle:input.kind==='script'?'Self Media Workbench':'文字材料',
        input:input.kind==='script'?'授权 TXT / Markdown，连同受众、方向和时长':'2–6 份授权的 TXT / Markdown',
        output:input.kind==='script'?'口播分镜稿':'带引用的素材简报',status:'draft',createdAt:at(),sample:null};
      state.bots.push(bot);
      return publicBot(bot);
    });
  }

  async interruptVerifications() {
    const pending=this.store.read().verifications?.filter(run=>run.state==='running'||run.cleanupPending)??[];
    if (!pending.length) return;
    const cleaned=new Map();
    for (const run of pending) cleaned.set(run.id,await clearSampleRuntime(this.config.data,run.id));
    this.store.change((state,emit)=>{
      for (const run of state.verifications.filter(row=>cleaned.has(row.id))) {
        if (cleaned.get(run.id)) delete run.cleanupPending;
        else run.cleanupPending=true;
        if (run.state!=='running') continue;
        const reason='本机服务退出，候选验证已中断。';
        this.store.transition(state,emit,run,'interrupted',{error:reason});
        const bot=botOf(state,run.botId,run.botRevision);
        bot.sample={ok:false,reason,at:run.finishedAt,runId:run.id,
          usage:run.usage,model:run.model,driverRevision:run.driverRevision??bot.driverRevision};
      }
    });
  }

  async verify(id,revision) {
    const state = this.store.read(),bot = botOf(state,id,revision);
    if (bot.status!=='draft') throw new Problem(409,'只可验证候选版本。');
    if (this.testing || state.runs.some(isLive)) throw new Problem(409,'已有任务在处理。完成后可验证候选版本。','busy');
    const blocked = botBlock(state,this.config,bot);
    if (blocked) throw new Problem(503,blocked);
    const runId=randomUUID(), controller=new AbortController();
    this.store.change((next,emit)=>{
      const records=next.verifications??=[];
      const legacy=legacyVerification(bot);
      if (legacy&&!records.some(run=>run.id===legacy.id)) records.push(legacy);
      const prior=records.findLast(run=>run.botId===id&&run.botRevision===revision);
      if (prior) delete prior.samplePreview;
      const started=at();
      const run={id:runId,botId:id,botRevision:revision,driver:bot.driver,driverRevision:bot.driverRevision,role:'maintainer',
        model:this.config.model,modelMode:upstreamMode(this.config),state:'running',
        createdAt:started,updatedAt:started,usage:unusedMeter(),retryOf:prior?.id??null,
        ...(bot.workflow?{workflow:bot.workflow}:{})};
      records.push(run);
      emit(run,'verification_started',{role:'maintainer',state:'running',driverRevision:run.driverRevision,retryOf:run.retryOf,
        ...(run.workflow?{workflow:run.workflow}:{})});
    });
    this.testing=id+'/'+revision;
    this.controller=controller;
    let observation,usage,assemblyDigest,preview,cleaned;
    const recordProvider=(value,terminal)=>this.store.change((next,emit)=>{
      const run=next.verifications.find(row=>row.id===runId);
      run.usage=value;
      emit(run,terminal?'provider_completed':'provider_requested',{usage:value});
    });
    try {
      const methods=setupMethods(state,bot);
      assemblyDigest=digestAssembly(bot,methods);
      const workflow=methods.workflow?await methods.workflow.instructions(this.config,controller.signal):undefined;
      await this.checkSources(bot,controller.signal);
      const {materials,expectedQuote,prompt:request,title}=materializeExample(bot,{verification:true});
      const prompt=definitionPrompt({kind:bot.kind,skills:methods.skills,workflow,request,materials,conversationTitle:title});
      const text=await execute(this.config,bot.driver,runId,prompt,controller.signal,()=>{},value=>{usage=value;},
        value=>recordProvider(value,true),value=>recordProvider(value,false),retry=>this.store.change((next,emit)=>{
          controller.signal.throwIfAborted();
          emit(next.verifications.find(row=>row.id===runId),'runtime_start_retry',retry);
        }));
      const output=resultOf(bot.kind,text,materials,request);
      checkSampleResult(output,expectedQuote);
      const checks=bot.kind==='script'
        ? await Workbench.rehearseScript(this.config,{id:runId,title,prompt:request},materials,output,controller.signal)
        : {};
      preview={result:output,materials:materials.map(({id,name})=>({id,name})),assemblyDigest,...checks};
      observation={ok:true,summary:output.title,...(bot.kind==='script'?{workbenchRevision:this.config.workbench.revision}:{}),
        ...(checks.evidenceReview?.length?{evidenceReviewShots:checks.evidenceReview.length}:{})};
    } catch(error) {
      observation={ok:false,reason:error instanceof Problem?error.message:'样例未完成。',
        code:error instanceof Problem?error.code:'sample_failed'};
    } finally {
      cleaned=await clearSampleRuntime(this.config.data,runId);
      this.controller=null;
      this.testing=null;
    }
    if (controller.signal.reason?.code==='skill_revoked') {
      observation={ok:false,reason:controller.signal.reason.message,code:'skill_revoked'};
    } else if (controller.signal.aborted) {
      observation={ok:false,reason:'候选样例验证已中断。',code:'sample_interrupted'};
    } else if (observation.ok && !cleaned) {
      observation={ok:false,reason:'样例临时文件尚未清理。请重启本机服务后重新验证。',code:'sample_cleanup'};
    }
    return this.store.change((next,emit)=>{
      const run=next.verifications.find(row=>row.id===runId);
      const outcome=controller.signal.aborted?'interrupted':observation.ok?'succeeded':'failed';
      this.store.transition(next,emit,run,outcome,{usage:usage??run.usage,error:observation.reason??null});
      const sample={...observation,at:run.finishedAt,runId,usage:run.usage,assemblyDigest,
        driverRevision:run.driverRevision,model:run.model,...(run.workflow?{workflow:run.workflow}:{})};
      if (!cleaned) run.cleanupPending=true;
      if (outcome==='succeeded') run.samplePreview=preview;
      botOf(next,id,revision).sample=sample;
      return sample;
    });
  }

  async publish(id,revision) {
    const check=state=>{
      const bot=botOf(state,id,revision);
      const block=botBlock(state,this.config,bot);
      if (block) throw new Problem(503,block);
      if (this.testing===id+'/'+revision || bot.status!=='draft' || !sampleReady(state,bot,this.config.model)) {
        throw new Problem(409,'请先在当前配置下通过候选版本验证。','sample_required');
      }
      return bot;
    };
    await this.checkSources(check(this.store.read()));
    return this.store.change((state,emit)=>{
      const bot=check(state);
      // Publishing a new revision leaves its predecessor usable only for history.
      this.disableIn(state,emit,id);
      bot.status='enabled';bot.enabledAt=at();
      return publicBot(bot);
    });
  }

  disableIn(state,emit,id,revision,reason='Bot 版本已停用，原待确认授权已撤销。') {
    for (const version of state.bots) {
      if (version.id!==id || (revision!==undefined && version.revision!==revision) || version.status!=='enabled') continue;
      version.status='disabled';
      for (const run of state.runs) {
        if (run.botId!==id || run.botRevision!==version.revision || run.state!=='waiting_approval') continue;
        run.approval.status='revoked';
        this.store.transition(state,emit,run,'interrupted',{error:reason});
      }
    }
  }

  async restore(id,revision) {
    const check=state=>{
      const bot=botOf(state,id,revision);
      const block=botBlock(state,this.config,bot);
      if(block)throw new Problem(503,block);
      if (bot.status!=='disabled' || (!bot.qualification && !sampleReady(state,bot))) {
        throw new Problem(409,'仅能恢复具备当前验收依据的历史版本。');
      }
      return bot;
    };
    await this.checkSources(check(this.store.read()));
    return this.store.change((state,emit)=>{
      const bot=check(state);
      this.disableIn(state,emit,id);
      bot.status='enabled';bot.enabledAt=at();
      return publicBot(bot);
    });
  }

  disable(id,revision) {
    this.store.change((state,emit)=>{
      botOf(state,id,revision);
      this.disableIn(state,emit,id,revision);
    });
  }
}


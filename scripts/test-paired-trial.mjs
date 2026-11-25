import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { modelFixture } from '../test/model-fixture.mjs';
import { loadTrialTasks, matchTrialSource, trialScript, trialSubmission } from '../test/paired-trial-fixture.mjs';
import { checkTrial, readFrozenTrial } from './launch-paired-trial.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const run=promisify(execFile), load=json=>readFile(json,'utf8').then(JSON.parse);
const digest=value=>createHash('sha256').update(value).digest('hex');
const importFile=file=>import(pathToFileURL(file).href);
const elapsed=start=>Math.round(performance.now()-start);
const {values:args}=parseArgs({options:{
  baseline:{type:'string'},candidate:{type:'string'},out:{type:'string'},
  'live-trial':{type:'string'},'candidate-archive':{type:'string'},from:{type:'string'},pairs:{type:'string'},arm:{type:'string'}
}});
assert.ok(args.baseline&&args.candidate&&args.out,'需要 --baseline、--candidate 与 --out。');
const old=path.resolve(args.baseline), candidate=path.resolve(args.candidate), out=path.resolve(args.out);
const model='deepseek-v4-flash';
const live=!!args['live-trial'];
const turnLimit=live?190000:65000;
const versionOf=directory=>load(path.join(directory,'package.json')).then(row=>row.version);
const sdkOf=directory=>load(createRequire(path.join(directory,'package.json')).resolve('@deepseek-ai/dsh-sdk-client/package.json'))
  .then(row=>row.version);
const [oldVersion,currentVersion,oldDsh,currentDsh]=await Promise.all([versionOf(old),versionOf(candidate),sdkOf(old),sdkOf(candidate)]);
assert.equal(oldVersion,'0.1.0');
assert.equal(oldDsh,currentDsh);
const oldManifest=await load(path.join(old,'workbench.manifest.json'));
const {configFor,WB_REVISION}=await importFile(path.join(candidate,'server/config.mjs'));
const config=await configFor({providerKey:live?process.env.DEEPSEEK_API_KEY:'fixture'});
assert.ok(config.workbench.ok,config.workbench.reason);
assert.equal(oldManifest.commit,WB_REVISION);
assert.equal(config.workbench.revision,WB_REVISION);
const oldReference=await readFile(path.join(config.workbenchRoot,'skills/self-media-workflow/references/script.md'),'utf8');
const newSkill=await readFile(path.join(candidate,'skills/talking-script.md'),'utf8');
assert.ok(newSkill.includes(WB_REVISION));
const tasks=await loadTrialTasks(path.join(root,'docs/配对试用'));
const {chromium}=createRequire(import.meta.url)(process.env.HYPER_BOT_TEST_PLAYWRIGHT||'playwright');
const {modelServer}=await importFile(path.join(old,'tests/fixtures/model-server.ts'));
const {createApp}=await importFile(path.join(old,'dist/server/app.js'));
const {launch}=await importFile(path.join(candidate,'server/http.mjs'));

function lookup(text) {
  const task=tasks.find(row=>text.includes(row.revise)||text.includes(row.prompt));
  assert.ok(task,'模型请求须携带已冻结的任务卡。');
  return {task,revision:text.includes(task.revise)};
}
function blockText(content) {
  return typeof content==='string'?content:content.filter(block=>block.type==='text').map(block=>block.text).join('\n');
}
function latestToolResult(messages) {
  for (const message of [...messages].reverse()) {
    if (!Array.isArray(message.content)) continue;
    const result=message.content.findLast(block=>block.type==='tool_result');
    if (result) return JSON.parse(blockText(result.content));
  }
  throw new Error('旧版执行器未返回工具结果。');
}
function modelForBaseline(states) {
  return body=>{
    assert.equal(body.model,model);
    const text=body.messages.filter(message=>message.role==='user')
      .map(message=>blockText(message.content)).findLast(value=>value.includes('当前项目 ID：'));
    const pid=/当前项目 ID：([a-z0-9-]+)/i.exec(text)?.[1];
    assert.ok(pid);
    const {task,revision}=lookup(text);
    const key=pid+'-'+(revision?'v2':'v1');
    const step=states.get(key)??{phase:0};
    states.set(key,step);
    if (step.phase++===0) return {tool:{name:'media_context',input:{}}};
    const response=latestToolResult(body.messages);
    if (step.phase===2) {
      assert.equal(response.project.id,pid);
      step.context=response;
      return {tool:{name:'media_reference',input:{name:'references/script.md'}}};
    }
    if (step.phase===3) {
      assert.equal(response.text,oldReference);
      return {tool:{name:'media_schema',input:{name:'script'}}};
    }
    if (step.phase===4) {
      assert.ok(JSON.stringify(response).includes('segments'));
      const result=trialScript(task,step.context.sources,revision);
      return {tool:{name:'media_request',input:{method:'POST',path:'/api/agent/v1/projects/'+pid+'/artifacts',
        body_json:JSON.stringify(trialSubmission(step.context,result,revision?task.revise:task.prompt))}}};
    }
    assert.equal(step.phase,5);
    assert.equal(response.accepted,true);
    step.saved=response.artifact.id;
    return {text:'已在原项目保存本轮合成分镜。时长为估算。'};
  };
}

function testMaterials(task) {
  if (task.uploads) return task.uploads;
  return task.files.map(({name,content})=>({name,mimeType:'text/markdown',buffer:Buffer.from(content)}));
}
function inspectVersion(context,asset,task) {
  assert.equal(asset.stage,'script');
  const {segments,claims,production_limits}=asset.payload;
  assert.equal(segments.length,4);
  assert.ok(production_limits.some(line=>line.includes('估算')));
  const shots=segments.map(({start,end,spoken,visual,subtitle,claim_ids})=>({
    start,end,spoken,visual,subtitle,quotes:claim_ids.flatMap(id=>claims.find(row=>row.id===id).evidence.map(ref=>{
      const source=context.sources.find(row=>row.id===ref.source_id);
      assert.ok(source?.integrity);
      assert.ok(source.content.includes(ref.quote));
      return {file:matchTrialSource(task,source)?.name,quote:ref.quote};
    }))
  }));
  assert.deepEqual(shots.map(({start,end})=>[start,end]),[[0,8],[8,19],[19,33],[33,45]]);
  assert.ok(shots[0].spoken.startsWith('“'+task.quote+'”'));
  assert.deepEqual([...new Set(shots.flatMap(shot=>shot.quotes.map(ref=>ref.file)))].sort(),task.files.map(file=>file.name).sort());
  return shots;
}

function checkVersions(context,task,first,second) {
  const assets=context.artifacts.filter(row=>row.stage==='script');
  assert.equal(assets.length,2);
  assert.equal(context.heads.script,second);
  const old=assets.find(row=>row.id===first), next=assets.find(row=>row.id===second);
  assert.equal(next.supersedes,first);
  const v1=inspectVersion(context,old,task), v2=inspectVersion(context,next,task);
  assert.deepEqual(v2.slice(0,3),v1.slice(0,3));
  assert.deepEqual(v2[3],{...v1[3],visual:task.revisionVisual});
  return {project:context.project.id,v1:first,v2:second,normalized:{v1,v2}};
}

function captureVersion(context, id, task) {
  const asset=context.artifacts.find(row=>row.id===id&&row.stage==='script');
  assert.ok(asset, '工作台未读回指定口播稿。');
  const {segments,claims,production_limits}=asset.payload;
  const shots=segments.map(({start,end,spoken,visual,subtitle,claim_ids})=>({
    start,end,spoken,visual,subtitle,quotes:claim_ids.flatMap(id=>{
      return (claims.find(row=>row.id===id)?.evidence??[]).map(ref=>{
        const source=context.sources.find(row=>row.id===ref.source_id);
        const file=matchTrialSource(task,source);
        return {file:file?.name??null,quote:ref.quote,exact:!!file&&file.content.includes(ref.quote)};
      });
    })
  }));
  return {id,supersedes:asset.supersedes,limits:production_limits,unresolved:asset.unresolved,
    shots,openingQuote:shots[0]?.spoken.trimStart().replace(/^[“「『"']/,'').startsWith(task.quote)??false,
    openingClaim:shots[0]?.quotes.some(ref=>ref.exact&&ref.quote.includes(task.quote))??false};
}

async function candidateRelease(freeze, folder) {
  if (!args['candidate-archive']) {
    assert.equal(candidate,path.join(folder,'apps','candidate','resources','app'));
    assert.equal(currentVersion,freeze.hyperBot.version);
    return freeze.hyperBot;
  }
  const archive=path.resolve(args['candidate-archive']);
  const unpacked=path.join(path.dirname(archive),path.basename(archive,'.zip'));
  assert.equal(candidate,path.join(unpacked,'resources','app'));
  const manifest=await load(path.join(unpacked,'包内文件摘要.json'));
  const runtimeFiles=manifest.files.filter(({path:file})=>/^resources\/app\/(?:server|dist|skills)\//.test(file));
  assert.ok(runtimeFiles.length>0,'候选包缺少前端和服务文件清单。');
  await Promise.all(runtimeFiles.map(async ({path:file,sha256})=>{
    assert.equal(digest(await readFile(path.join(unpacked,file))),sha256,file);
  }));
  const hash=createHash('sha256');
  for await (const chunk of createReadStream(archive)) hash.update(chunk);
  return {name:'Hyper Bot',archive:path.basename(archive),version:currentVersion,sha256:hash.digest('hex')};
}

function responseFor(page,suffix) {
  return page.waitForResponse(response=>response.request().method()==='POST'&&
    new URL(response.url()).pathname.endsWith(suffix));
}
async function waitForBaselineTask(instance,{projectId,taskId}) {
  const deadline=AbortSignal.timeout(turnLimit);
  for (;;) {
    const task=instance.store.get(projectId).tasks.find(row=>row.id===taskId);
    if (task?.status==='done') return task;
    if (task?.error) throw new Error('现有入口任务失败。'+task.error);
    await delay(150,null,{signal:deadline});
  }
}

async function oldTask(page,task,origin,instance,steps,record={}) {
  await page.goto(origin+'/');
  await page.getByRole('heading',{name:'这次，想完成哪项创作？',exact:true}).waitFor();
  const start=performance.now();
  const turn=async (request,inputName)=>{
    await page.getByRole('textbox',{name:inputName,exact:true}).fill(request);
    const response=responseFor(page,'/api/tasks');
    await page.getByRole('button',{name:'发送创作需求',exact:true}).click();
    const accepted=await response;
    assert.ok(accepted.ok(),await accepted.text());
    return accepted.json();
  };
  const version=v=>page.getByRole('heading',{name:'口播稿 · 第 '+v+' 版',exact:true}).waitFor({timeout:live?15000:turnLimit});
  await page.getByRole('button',{name:/^口播脚本 /}).click();
  record.entryMs=elapsed(start);
  await page.locator('input[type=file]').setInputFiles(testMaterials(task));
  for (const file of task.files) await page.getByText(file.name,{exact:true}).first().waitFor();
  const first=await turn(task.prompt,'描述创作需求');
  record.firstSubmittedMs=elapsed(start);
  record.project=first.projectId;
  record.tasks=[first.taskId];
  const firstWait=performance.now();
  await waitForBaselineTask(instance,first);
  const context=()=>instance.wb.context(first.projectId);
  const scripts=ctx=>ctx.artifacts.filter(row=>row.stage==='script')
    .sort((a,b)=>a.created_at.localeCompare(b.created_at));
  const firstContext=live?await context():null;
  const firstRecord=live?firstContext.heads.script:steps.get(first.projectId+'-v1')?.saved;
  assert.ok(firstRecord);
  const firstNumber=live?scripts(firstContext).findIndex(row=>row.id===firstRecord)+1:1;
  if (live) {
    record.firstDraft=captureVersion(firstContext,firstRecord,task);
    record.firstDraft.version=firstNumber;
  }
  await version(firstNumber);
  record.firstWaitMs=elapsed(firstWait);

  const reopenStart=performance.now();
  await page.getByRole('button',{name:'新建创作',exact:true}).click();
  await page.getByRole('heading',{name:'这次，想完成哪项创作？',exact:true}).waitFor();
  await page.getByRole('button',{name:'我的项目',exact:true}).click();
  await page.getByRole('textbox',{name:'搜索项目'}).fill(task.label);
  await page.locator('.project-table-row').filter({hasText:task.label}).click();
  await version(firstNumber);
  record.reopenMs=elapsed(reopenStart);
  await page.getByRole('combobox',{name:'选择任务类型'}).selectOption('script');
  const second=await turn(task.revise,'继续描述创作要求');
  assert.equal(second.projectId,first.projectId);
  record.tasks.push(second.taskId);
  const revisionWait=performance.now();
  await waitForBaselineTask(instance,second);
  const nextContext=live?await context():null;
  const nextRecord=live?nextContext.heads.script:steps.get(first.projectId+'-v2')?.saved;
  assert.ok(nextRecord);
  const nextNumber=live?scripts(nextContext).findIndex(row=>row.id===nextRecord)+1:2;
  if (live) {
    assert.notEqual(firstRecord,nextRecord,'续改未保存新版本。');
    record.revision=captureVersion(nextContext,nextRecord,task);
    record.revision.version=nextNumber;
  }
  await version(nextNumber);
  record.revisionWaitMs=elapsed(revisionWait);
  await page.getByRole('tab',{name:'版本',exact:true}).click();
  await page.locator('.version-item').filter({hasText:'第 '+firstNumber+' 版'}).getByRole('button',{name:'查看此版'}).click();
  await version(firstNumber);
  record.priorVersionVisible=true;
  return {...(live?{}:checkVersions(await context(),task,firstRecord,nextRecord)),
    tasks:[first.taskId,second.taskId],reopenedFromHome:true,writeDecision:'模型通过工具提交'};
}

async function hyperTask(page,task,instance,record={}) {
  await page.goto(instance.origin+'/');
  await page.getByRole('heading',{name:'工作台',exact:true}).waitFor();
  const start=performance.now();
  await page.locator('.directory-card').filter({has:page.getByRole('heading',{name:'自媒体口播',exact:true})})
    .getByRole('button',{name:'新建会话',exact:true}).click();
  record.entryMs=elapsed(start);
  await page.getByRole('textbox',{name:'会话标题'}).fill(task.label);
  await page.getByRole('button',{name:'开始会话',exact:true}).click();
  await page.waitForURL(url=>url.hash.startsWith('#chat/'));
  const roomId=new URL(page.url()).hash.slice(6);
  record.room=roomId;
  const runPath='/api/rooms/'+roomId+'/runs';
  const openingQuoteReview={approval:[],saved:[],preview:[]};
  const openingNeedsReview=review=>(review??[]).some(row=>row.index===0 && row.statements.some(item=>item.fields.includes('spoken')));
  const readRun=id=>instance.app.room(roomId).runs.find(run=>run.id===id);
  const waitForRun=async (id,expected)=>{
    const limit=AbortSignal.timeout(turnLimit);
    for (;;) {
      const current=readRun(id);
      if (current?.state===expected) return current;
      if (['failed','interrupted','cancelled','denied','succeeded'].includes(current?.state)) {
        throw new Error('Hyper Bot 未到达 '+expected+'。'+(current.error||current.state));
      }
      await delay(150,null,{signal:limit});
    }
  };
  const checkPreview=async()=>{
    const firstShot=page.locator('#right-preview .shot').first();
    await firstShot.waitFor();
    return (await firstShot.getByText('依据待核对',{exact:true}).count())>0;
  };
  const turn=async (request,phase)=>{
    await page.getByRole('textbox',{name:'给自媒体口播发消息'}).fill(request);
    const response=responseFor(page,runPath);
    await page.getByRole('button',{name:'发送消息',exact:true}).click();
    const accepted=await response;
    assert.ok(accepted.ok(),await accepted.text());
    const result=await accepted.json();
    (record.tasks??=[]).push(result.id);
    if (phase==='first') record.firstSubmittedMs=elapsed(start);
    const wait=performance.now();
    const approve=page.getByRole('button',{name:'允许本次写入',exact:true});
    if (live) await waitForRun(result.id,'waiting_approval');
    await approve.waitFor({timeout:live?15000:turnLimit});
    const pending=readRun(result.id);
    assert.equal(pending.state,'waiting_approval');
    record[phase+'ToApprovalMs']=elapsed(wait);
    openingQuoteReview.approval.push(openingNeedsReview(pending.previewEvidenceReview));
    await approve.click();
    return result.id;
  };
  const version=async (v,runId)=>{
    if (live&&runId) await waitForRun(runId,'succeeded');
    await page.locator('.panel-subhead .version').getByText('v'+v,{exact:true}).waitFor({timeout:45000});
  };
  await page.locator('.composer input[type=file]').setInputFiles(testMaterials(task));
  for (const file of task.files) await page.locator('.composer-files').getByRole('button',{name:file.name,exact:true}).waitFor();
  const first=await turn(task.prompt,'first');
  await version(1,first);
  const original=instance.app.room(roomId).artifacts.find(row=>row.run===first);
  assert.ok(original?.receipt);
  record.project=original.receipt.project;
  if (live) record.firstDraft=captureVersion(await instance.app.workbench.context(record.project),original.receipt.id,task);
  openingQuoteReview.saved.push(openingNeedsReview(original.evidenceReview));
  openingQuoteReview.preview.push(await checkPreview());

  const reopenStart=performance.now();
  await page.getByRole('link',{name:'工作台',exact:true}).click();
  await page.getByRole('heading',{name:'工作台',exact:true}).waitFor();
  await page.getByRole('link',{name:'查看全部会话',exact:true}).click();
  await page.getByRole('searchbox',{name:'搜索会话或项目'}).fill(task.label);
  await page.locator('.history-list').getByRole('link',{name:new RegExp(task.label)}).click();
  await version(1);
  record.reopenMs=elapsed(reopenStart);
  await page.getByRole('tab',{name:/版本/}).click();
  await page.getByRole('button',{name:'继续改稿',exact:true}).click();
  const second=await turn(task.revise,'revision');
  await page.getByRole('tab',{name:'分镜稿',exact:true}).click();
  await version(2,second);
  const current=instance.app.room(roomId);
  const newer=current.artifacts.find(row=>row.run===second);
  assert.ok(newer?.receipt);
  openingQuoteReview.saved.push(openingNeedsReview(newer.evidenceReview));
  openingQuoteReview.preview.push(await checkPreview());
  assert.equal(newer.receipt.project,original.receipt.project);
  if (live) record.revision=captureVersion(await instance.app.workbench.context(record.project),newer.receipt.id,task);
  await page.getByRole('tab',{name:/版本/}).click();
  await page.locator('.side-row').filter({hasText:'v1'}).getByRole('button').click();
  await page.getByRole('button',{name:'查看此版',exact:true}).click();
  await version(1);
  record.priorVersionVisible=true;
  return {...(live?{}:checkVersions(await instance.app.workbench.context(current.project),task,original.receipt.id,newer.receipt.id)),
    tasks:[first,second],room:roomId,reopenedFromHome:true,writeDecision:'每轮在原会话确认',openingQuoteReview};
}

async function runLive() {
  const key=process.env.DEEPSEEK_API_KEY?.trim();
  assert.ok(key, '需要当前进程的 DeepSeek 配置。');
  const folder=path.resolve(args['live-trial']);
  const setup=await load(path.join(folder,'试用配置.json'));
  const preflight=await checkTrial(folder);
  const {parsed:{freeze}}=await readFrozenTrial(folder,setup.trial);
  assert.equal(old,path.join(folder,'apps','baseline'));
  const testedCandidate=await candidateRelease(freeze,folder);
  assert.equal(model,freeze.model);
  assert.equal(freeze.upstream,'https://api.deepseek.com');
  assert.equal(config.workbench.revision,freeze.workbenchCommit);
  const from=Number(args.from??1), count=Number(args.pairs??6);
  assert.ok(Number.isInteger(from)&&Number.isInteger(count)&&from>=1&&count>=1&&from+count<=7,
    '仅支持试用方案中的前六组。');
  assert.ok(!args.arm||['baseline','hyperBot'].includes(args.arm),'未识别的复验入口。');
  const prepared=await Promise.all(freeze.tasks.map(async row=>{
    const task=tasks.find(item=>item.id===row.id);
    assert.equal(task.prompt,row.firstPrompt);
    assert.equal(task.revise,row.revisionPrompt);
    const uploads=await Promise.all(row.materials.map(async ({path:file,sha256})=>{
      const buffer=await readFile(path.join(root,'docs/配对试用',file));
      assert.equal(digest(buffer),sha256);
      return {name:path.basename(file),mimeType:'text/markdown',buffer};
    }));
    return {...task,uploads};
  }));
  await mkdir(out,{mode:0o700});
  const browserEnv=Object.fromEntries(Object.entries(process.env).filter(([name])=>name!=='DEEPSEEK_API_KEY'));
  const browser=await chromium.launch({executablePath:process.env.HYPER_BOT_TEST_CHROMIUM||undefined,env:browserEnv});
  const report={openedAt:new Date().toISOString(),mode:'agent-operated live model',model,
    operator:'Codex via Playwright',humanPairs:0,humanReadThroughs:0,actualCashCNY:null,
    browser:{name:'Chromium',version:browser.version(),view:[1440,900]},
    preflight,baselineArchive:freeze.baseline,hyperBotArchive:testedCandidate,
    workbench:freeze.workbenchCommit,maxTokens:freeze.maxOutputTokens,results:[]};
  const save=(filename,data,flag='wx')=>writeFile(path.join(out,filename),JSON.stringify(data,null,2)+'\n',{flag});
  const safeMessage=error=>String(error?.message??error).replaceAll(key,'[redacted]')
    .replace(/sk-[A-Za-z0-9_-]{20,}/g,'[redacted]').slice(0,800);
  try {
    await save('执行配置.json',report);
    for (const slot of setup.slots.slice(from-1,from-1+count)) {
      const pair={id:slot.id,order:slot.order,arms:[]};
      await mkdir(path.join(out,slot.id));
      for (const selection of slot.order) {
        const [arm,taskId]=selection.split(':');
        if (args.arm&&args.arm!==arm) continue;
        const task=prepared.find(item=>item.id===taskId);
        const record={arm,task:taskId,startedAt:new Date().toISOString(),blockedOrigins:[]};
        const state=path.join(out,slot.id,arm);
        let app, origin, browserContext;
        try {
          if (arm==='baseline') {
            app=await createApp({root:old,home:state});
            const {protocol,...settings}=setup.baselineSettings;
            await app.config.save(settings);
            assert.equal(app.config.public().keySource,'environment');
            origin=await app.app.listen({host:'127.0.0.1',port:0});
            app.setOrigin(origin);
          } else {
            app=await launch({options:{data:state,model,providerKey:key,
              originalWorkbenchState:path.join(state,'legacy-state'),originalWorkbenchData:path.join(state,'legacy-data')}});
            record.initialDependencies=app.app.index().localDependencies.checks;
            origin=app.origin;
          }
          assert.equal(new URL(origin).hostname,'127.0.0.1');
          browserContext=await browser.newContext({viewport:{width:1440,height:900}});
          await browserContext.route('**/*',route=>{
            const requested=new URL(route.request().url()).origin;
            if (requested===origin) return route.continue();
            if (!record.blockedOrigins.includes(requested)) record.blockedOrigins.push(requested);
            return route.abort();
          });
          const page=await browserContext.newPage();
          const flow=arm==='baseline'?await oldTask(page,task,origin,app,null,record):await hyperTask(page,task,app,record);
          Object.assign(record,flow,{status:'completed'});
          record.revisionSameProject=record.revision?.supersedes===record.firstDraft?.id;
        } catch(error) {
          Object.assign(record,{status:'incomplete',error:safeMessage(error)});
        } finally {
          if (arm==='hyperBot'&&app&&record.room) {
            const state=app.app.room(record.room);
            record.runs=state.runs.map(({id,state,error,usage,modelMode})=>({id,state,
              error:error?safeMessage(error):null,usage,modelMode}));
          } else if (arm==='baseline'&&app&&record.project) {
            record.runs=app.store.get(record.project).tasks.map(({id,status,error,finishedAt,usage})=>({id,status,
              error:error?safeMessage(error):null,finishedAt,usage:usage??null}));
          }
          await browserContext?.close();
          if (arm==='baseline') {
            await app?.app.close();
            await app?.wb.stopIfIdle();
          } else await app?.close();
        }
        record.finishedAt=new Date().toISOString();
        pair.arms.push(record);
        await save(path.join(slot.id,arm+'-回执.json'),record);
        console.log(slot.id+' '+selection+' '+record.status+(record.error?' '+record.error:''));
      }
      report.results.push(pair);
      await save(slot.id+'-配对回执.json',pair);
    }
    await save('代测回执.json',{...report,finishedAt:new Date().toISOString()});
  } finally { await browser.close(); }
}

async function runFixture() {
  await mkdir(out,{mode:0o700});
  const failures=[],steps=new Map(),baselineRespond=modelForBaseline(steps);
  const controlFixture=await modelServer(body=>{
    try { return baselineRespond(body); }
    catch(error) { failures.push(error.message);return {status:422}; }
  });
  const candidateFixture=await modelFixture({respond:({text,sources})=>{
    assert.ok(text.includes(newSkill));
    const {task,revision}=lookup(text);
    return trialScript(task,sources,revision);
  }});
  let previous,host,browser;
  try {
    previous=await createApp({root:old,home:path.join(out,'self-media-state')});
    await previous.config.save({model,baseUrl:controlFixture.url,apiKey:'sk-'+'0'.repeat(32),
      maxTokens:4096,vision:false,workbenchRoot:config.workbenchRoot,python:config.workbenchPython});
    const origin=await previous.app.listen({host:'127.0.0.1',port:0});
    previous.setOrigin(origin);
    host=await launch({options:{data:path.join(out,'hyper-bot-state'),model,providerKey:'synthetic-pairing-fixture',
      upstream:candidateFixture.origin}});
    for (const item of [origin,host.origin,controlFixture.url,candidateFixture.origin]) assert.equal(new URL(item).hostname,'127.0.0.1');
    browser=await chromium.launch({executablePath:process.env.HYPER_BOT_TEST_CHROMIUM||undefined});
    const blocked=[], results=[];
    for (const task of tasks) {
      const context=await browser.newContext({viewport:{width:1440,height:900}});
      await context.route('**/*',route=>{
        if ([origin,host.origin].includes(new URL(route.request().url()).origin)) return route.continue();
        blocked.push(new URL(route.request().url()).origin);
        return route.abort();
      });
      const a=await context.newPage(), b=await context.newPage();
      try {
        const baseline=await oldTask(a,task,origin,previous,steps);
        const current=await hyperTask(b,task,host);
        assert.notEqual(baseline.project,current.project);
        assert.deepEqual(baseline.normalized,current.normalized);
        results.push({task:task.id,title:task.title,baseline,current,matchingContent:true,
          frozenInput:task.files.map(file=>({name:file.name,sha256:digest(file.content)})),
          firstRequestSha256:digest(task.prompt),revisionRequestSha256:digest(task.revise)});
        console.log('OK '+task.title+' 两路保存、找回、续改并核对四镜与逐字引用');
      } catch (error) {
        const pages=await Promise.all([a,b].map(async page=>({
          url:page.url(), visible:(await page.locator('body').innerText({timeout:1500}).catch(()=>'')).slice(0,500)
        })));
        console.error('样例 '+task.id+' 的页面状态 '+JSON.stringify(pages));
        throw error;
      } finally {
        await context.close();
      }
    }
    assert.deepEqual(failures,[]);
    assert.equal(new Set(results.flatMap(row=>[row.baseline.project,row.current.project])).size,4);
    assert.equal(steps.size,4);
    assert.equal(controlFixture.requests.length,20);
    assert.equal(candidateFixture.calls.length,4);
    assert.ok(controlFixture.requests.every(row=>row.model===model));
    assert.ok(candidateFixture.calls.every(row=>row.model===model&&row.materialCount===2));
    const {stdout}=await run('git',['-C',config.workbenchRoot,'rev-parse','HEAD'],{windowsHide:true,timeout:5000});
    assert.equal(stdout.trim(),WB_REVISION);
    const report={checkedAt:new Date().toISOString(),mode:'model-protocol rehearsal',model,dsh:currentDsh,
      workbench:WB_REVISION,sharedReferenceSha256:digest(oldReference),candidateSkillSha256:digest(newSkill),
      baseline:oldVersion,candidate:currentVersion,results,browserExternalRequestsBlocked:blocked,isolatedBrowserContexts:true,
      mockModelRequests:{baseline:controlFixture.requests.length,hyperBot:candidateFixture.calls.length},
      humanPairs:0,humanReadThroughs:0,paidProviderCalls:0,actualCashCNY:null};
    await writeFile(path.join(out,'配对工程回执.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  } catch(error) {
    if (failures.length) console.error('旧版模型夹具校验：'+failures.join('；'));
    throw error;
  } finally {
    await browser?.close();
    await host?.close();
    await previous?.app.close();
    await previous?.wb.stopIfIdle();
    await candidateFixture.close();
    await controlFixture.close();
  }
}

if (live) await runLive();
else await runFixture();

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { appendFile, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { modelFixture } from '../test/model-fixture.mjs';

const appRoot=path.resolve(process.env.HYPER_BOT_TEST_APP_ROOT??fileURLToPath(new URL('../',import.meta.url)));
const load=name=>import(pathToFileURL(path.join(appRoot,'server',name+'.mjs')).href);
const [{launch},{configFor}]=await Promise.all([load('http'),load('config')]);
const version=JSON.parse(await readFile(path.join(appRoot,'package.json'),'utf8')).version;
const setup=await configFor({providerKey:'local-drift-fixture'});
assert.ok(setup.hermes.ok,setup.hermes.reason);
assert.ok(setup.workbench.ok,setup.workbench.reason);
const isolation=await mkdtemp(path.join(tmpdir(),'hb-runtime-source-'));
const exec=promisify(execFile);
const git=(args)=>exec('git',['-c','core.fsmonitor=false',...args],{windowsHide:true,timeout:50000,maxBuffer:128*1024});
const components=await Promise.all([
  ['hermes','HYPER_BOT_HERMES_ROOT',setup.hermesRoot,setup.hermes.revision],
  ['workbench','HYPER_BOT_WORKBENCH_ROOT',setup.workbenchRoot,setup.workbench.revision]
].map(async([id,variable,source,revision])=>{
  const directory=path.join(isolation,id);
  await git(['clone','--shared','--no-checkout','--',source,directory]);
  await git(['-C',directory,'checkout','--detach',revision]);
  const file=path.join(directory,'README.md');
  const bytes=await readFile(file);
  return {id,variable,directory,file,bytes,prior:process.env[variable]};
}));
const fixture=await modelFixture();
const options={data:path.join(isolation,'state'),upstream:fixture.origin,providerKey:'local-drift-fixture'};
const proof={version,checkedAt:new Date().toISOString(),checks:[],paidRequests:0};
let host,browser;
const byId=id=>components.find(item=>item.id===id);
const pass=note=>{proof.checks.push(note);console.log('OK '+note);};
const dirty=id=>appendFile(byId(id).file,'\nHyper Bot QA created this isolated documentation edit.\n');
const restore=id=>writeFile(byId(id).file,byId(id).bytes);
const ui=!process.argv.includes('--no-ui');

async function api(route,body,status=200) {
  const response=await fetch(host.origin+'/api'+route,{signal:AbortSignal.timeout(45000),
    headers:{'X-Hyper-Bot':'1','Content-Type':'application/json'},
    ...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)})});
  const value=await response.json();
  assert.equal(response.status,status,JSON.stringify(value));
  return value;
}

const current=id=>api('/rooms/'+id);
const request=room=>({...room.draft,draftToken:room.draftToken,clientRequestId:randomUUID(),authorized:true});
const send=(room,input=request(room),status=202)=>api('/rooms/'+room.id+'/runs',input,status);

async function example(botId,title,revision=1) {
  const {id}=await api('/rooms',{botId,revision,title,example:true},201);
  return current(id);
}

async function settled(room,id,state) {
  const signal=AbortSignal.timeout(85000);
  for(;;) {
    const view=await current(room.id);
    const run=view.runs.find(item=>item.id===id);
    if(run?.state===state)return {view,run};
    if(run&&['succeeded','failed','cancelled','interrupted'].includes(run.state))throw new Error(run.error??run.state);
    await wait(100,null,{signal});
  }
}

async function repaired(component) {
  await restore(component);
  const signal=AbortSignal.timeout(25000);
  for(;;) {
    const response=await fetch(host.origin+'/api/dependencies',{
      method:'POST',headers:{'X-Hyper-Bot':'1','Content-Type':'application/json'},body:'{}',signal
    });
    const body=await response.json();
    if(response.ok){assert.equal(body.checks[component].ok,true);return;}
    assert.equal(response.status,409,JSON.stringify(body));
    await wait(125,null,{signal});
  }
}

async function browserRefusal(room) {
  const {chromium}=createRequire(import.meta.url)(process.env.HYPER_BOT_TEST_PLAYWRIGHT??'playwright');
  browser=await chromium.launch({executablePath:process.env.HYPER_BOT_TEST_CHROMIUM||undefined});
  const page=await browser.newPage({viewport:{width:1440,height:900}});
  const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(host.origin+'/#bots');
  const card=page.locator('.directory-card').filter({has:page.getByRole('heading',{name:'素材简报',exact:true})});
  await card.getByRole('button',{name:'新建会话',exact:true}).waitFor();
  await page.goto(host.origin+'/#chat/'+room.id);
  const composer=page.locator('.composer textarea');
  await composer.waitFor();
  assert.equal(await composer.inputValue(),room.draft.text);
  await dirty('hermes');
  const sending=page.waitForResponse(reply=>reply.request().method()==='POST'&&
    new URL(reply.url()).pathname==='/api/rooms/'+room.id+'/runs');
  await composer.press('Control+Enter');
  const refused=await sending;
  assert.equal(refused.status(),503);
  assert.equal((await refused.json()).code,'dependency_unavailable');
  const check=page.getByRole('link',{name:'检查依赖',exact:true});
  await check.waitFor();
  assert.equal(await composer.inputValue(),room.draft.text);
  await check.click();
  const panel=page.getByRole('region',{name:'Hermes ACP',exact:true});
  await panel.getByText(/未通过版本核对/).waitFor();
  if(process.env.HYPER_BOT_TEST_SCREENSHOT)await page.screenshot({path:process.env.HYPER_BOT_TEST_SCREENSHOT,animations:'disabled'});
  assert.deepEqual(errors,[]);
  proof.ui=true;
}

try {
  for(const runtime of components)process.env[runtime.variable]=runtime.directory;
  host=await launch({options});
  const initial=(await api('/workspace')).localDependencies.checks;
  assert.ok(initial.hermes.ok&&initial.workbench.ok);
  const history=await example('brief','历史素材简报');
  const original=request(history);
  const accepted=await send(history,original);
  const saved=await settled(history,accepted.id,'succeeded');
  assert.equal(saved.view.artifacts.length,1);

  const brief=await example('brief','保留原草稿');
  if(ui)await browserRefusal(brief);
  else {
    await dirty('hermes');
    assert.equal((await send(brief,request(brief),503)).code,'dependency_unavailable');
  }
  const blocked=await current(brief.id);
  assert.deepEqual(blocked.draft,brief.draft);
  assert.equal(blocked.runs.length,0);
  assert.equal((await api('/workspace')).localDependencies.checks.hermes.code,'modified');
  assert.equal((await send(history,original)).id,accepted.id);
  assert.equal(fixture.calls.length,1);
  assert.equal((await current(history.id)).artifacts[0].id,saved.view.artifacts[0].id);
  pass('Hermes 源码变更后保留草稿和旧成果，旧请求回读沿用原任务');
  await repaired('hermes');

  const skill=await api('/skills',{slug:'drift-check',version:'1.0.0',name:'素材观点核对',origin:'Hyper Bot 合成回归',
    content:'归纳授权文字中可核对的观察，并在简报中保留与原始材料一致的引用。',references:[],outputKind:'brief',reviewed:true},201);
  const bot=await api('/bots',{id:'drift-brief',name:'观点核对简报',description:'读取授权材料并交付可回查原句的简报。',
    kind:'brief',driver:'hermes',skills:[skill.id]},201);
  const action=name=>'/bots/'+bot.id+'/'+bot.revision+'/'+name;
  await dirty('hermes');
  const refused=await api(action('verify'),{});
  assert.equal(refused.ok,false);
  assert.equal(refused.code,'dependency_unavailable');
  assert.equal(fixture.calls.length,1);
  await repaired('hermes');
  assert.equal((await api(action('verify'),{})).ok,true);
  await dirty('hermes');
  await api(action('publish'),{},503);
  assert.equal((await api('/workspace')).bots.find(item=>item.id===bot.id).status,'draft');
  assert.equal(fixture.calls.length,2);
  await repaired('hermes');
  assert.equal((await api(action('publish'),{})).status,'enabled');
  const assembled=await example(bot.id,'新装配简报',bot.revision);
  const requested=await send(assembled);
  assert.equal((await settled(assembled,requested.id,'succeeded')).view.artifacts.length,1);
  assert.equal(fixture.calls.length,3);
  pass('候选验证和启用各自核对 Hermes。恢复锁定版本后，同一 Skill 装配从目录可运行');

  const media=await example('media','同项目口播');
  await dirty('workbench');
  assert.equal((await send(media,request(media),503)).code,'workbench_unavailable');
  const stayed=await current(media.id);
  assert.equal(stayed.project,media.project);
  assert.deepEqual(stayed.draft,media.draft);
  assert.equal(stayed.runs.length,0);
  assert.equal(fixture.calls.length,3);
  await repaired('workbench');
  pass('工作台源文件变化时不受理新口播，保留原会话和材料');

  const scriptRun=await send(stayed);
  const pending=(await settled(media,scriptRun.id,'waiting_approval')).run;
  const project=pending.project;
  const before=await host.app.workbench.context(project);
  assert.equal(before.artifacts.filter(item=>item.stage==='script').length,0);
  const approval={id:pending.approval.id,digest:pending.approval.digest,allow:true};
  await dirty('workbench');
  await api('/runs/'+pending.id+'/decide',approval,202);
  const attempt=await settled(media,pending.id,'failed');
  assert.equal(attempt.run.unwrittenDraft,true);
  assert.equal(attempt.view.artifacts.length,0);
  assert.match(attempt.run.error,/未通过版本核对/);
  assert.ok(!(await api('/runs/'+pending.id+'/events')).some(event=>event.kind==='workbench_submit_started'));
  assert.equal(fixture.calls.length,4);
  await api('/runs/'+pending.id+'/decide',approval,409);
  await repaired('workbench');
  const after=await host.app.workbench.context(project);
  assert.equal(after.heads.script,before.heads.script);
  assert.equal(after.artifacts.filter(item=>item.stage==='script').length,0);
  assert.equal(fixture.calls.length,4);
  pass('等待审批期间工作台改变时，旧批准不发起写入，分镜可带回原会话');
  proof.modelRequests=fixture.calls.length;
  proof.target='local protocol fixture';
  proof.ui=!!proof.ui;
  if(process.env.HYPER_BOT_TEST_REPORT){
    await writeFile(process.env.HYPER_BOT_TEST_REPORT,JSON.stringify(proof,null,2)+'\n',{flag:'wx'});
  }
  console.log(JSON.stringify(proof));
} finally {
  await browser?.close();
  await host?.close();
  await fixture.close();
  for(const {variable,prior} of components) {
    if(prior===undefined)delete process.env[variable];
    else process.env[variable]=prior;
  }
}

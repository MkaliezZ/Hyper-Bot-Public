import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { modelFixture } from '../test/model-fixture.mjs';

const root=path.resolve(process.env.HYPER_BOT_TEST_APP_ROOT??fileURLToPath(new URL('../',import.meta.url)));
const [{launch},{configFor,processEnvironment}]=await Promise.all(['http','config'].map(name=>
  import(pathToFileURL(path.join(root,'server',name+'.mjs')))));
const {chromium}=createRequire(import.meta.url)(process.env.HYPER_BOT_TEST_PLAYWRIGHT??'playwright');
const exec=promisify(execFile);
const data=await mkdtemp(path.join(tmpdir(),'hb-dependency-'));
const registered=await configFor({data,providerKey:''});
assert.ok(registered.workbench.ok&&registered.hermes.ok,'The installed Workbench and Hermes fixtures are required.');
const python=registered.workbenchPython;
const runPython=(executable,args)=>exec(executable,args,{windowsHide:true,timeout:25000,env:processEnvironment()});
const sitePath=async executable=>(await runPython(executable,['-E','-c','import sysconfig; print(sysconfig.get_path("purelib"))'])).stdout.trim();
const virtual=path.join(data,'test-venv');
const recovering=path.join(virtual,process.platform==='win32'?'Scripts/python.exe':'bin/python');
const envName='HYPER_BOT_WORKBENCH_PYTHON';
const priorPython=process.env[envName];
process.env[envName]=recovering;
const model=await modelFixture();
const context={data:path.join(data,'workspace'),upstream:model.origin,providerKey:'isolated-readiness-fixture'};
let host,browser;
const checks=[];
function pass(message){checks.push(message);console.log('OK '+message);}

async function api(route,body,status) {
  const response=await fetch(host.origin+'/api'+route,{
    signal:AbortSignal.timeout(18000),...(body===undefined?{}:{
      method:'POST',headers:{'X-Hyper-Bot':'1','Content-Type':'application/json'},body:JSON.stringify(body)
    })
  });
  const value=await response.json();
  if(status)assert.equal(response.status,status,JSON.stringify(value));
  else assert.ok(response.ok,JSON.stringify(value));
  return value;
}

const waitFor=async predicate=>{
  const limit=AbortSignal.timeout(30000);
  for(;;) {
    limit.throwIfAborted();
    const result=await predicate();
    if(result)return result;
    await delay(100,null,{signal:limit});
  }
};
const screens=process.env.HYPER_BOT_TEST_SCREENSHOTS;
async function shot(page,filename) {
  if(!screens)return;
  await mkdir(screens,{recursive:true});
  await page.screenshot({path:path.join(screens,filename+'.png'),animations:'disabled'});
}

try {
  host=await launch({options:context});
  const initial=await api('/workspace');
  const setup=initial.localDependencies;
  assert.equal(setup.checks.workbench.code,'python_missing');
  assert.equal(setup.checks['dsh-web'].ok,true);
  assert.equal(setup.checks.provider.ok,true);
  assert.equal(setup.checks.hermes.ok,true);
  const safe=JSON.stringify(setup);
  assert.ok(!safe.includes(context.providerKey)&&!safe.includes(JSON.stringify(recovering).slice(1,-1)));
  assert.match(initial.bots.find(bot=>bot.id==='media').blocked,/Python/);
  assert.equal(initial.bots.find(bot=>bot.id==='brief').blocked,'');
  const existing=await api('/rooms',{botId:'media',revision:1,title:'续改书店的原会话',example:true},201);
  const original=await api('/rooms/'+existing.id);
  const rejected=await api('/rooms/'+existing.id+'/runs',{...original.draft,authorized:true,clientRequestId:randomUUID()},503);
  assert.equal(rejected.code,'dependency_unavailable');
  assert.equal(model.calls.length,0);
  pass('缺少已登记 Python 时只暂停口播，素材简报可用，诊断数据省去凭据值和路径');

  browser=await chromium.launch({executablePath:process.env.HYPER_BOT_TEST_CHROMIUM||undefined});
  const page=await browser.newPage({viewport:{width:1440,height:900}});
  const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(host.origin+'/#chat/'+existing.id);
  const composer=page.locator('.composer textarea');
  await composer.waitFor();
  await composer.fill('根据访谈和拍摄笔记写开门分镜。');
  await page.getByRole('link',{name:'检查依赖',exact:true}).click();
  await page.getByRole('heading',{name:'本机依赖',exact:true}).waitFor();
  const workbench=page.getByRole('region',{name:'Self Media Workbench',exact:true});
  await workbench.getByText('找不到已配置的 Python。',{exact:true}).waitFor();
  assert.equal(await page.getByRole('region',{name:'Hermes ACP',exact:true}).count(),0);
  const back=page.getByRole('link',{name:'返回会话',exact:true});
  assert.equal(await back.getAttribute('href'),'#chat/'+existing.id);
  await shot(page,'桌面-本机依赖检查');
  for (const width of [1024,768,390,320]) {
    await page.setViewportSize({width,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),width);
    const card=await page.locator('.dependency-card').boundingBox();
    assert.ok(card.x>=0&&card.x+card.width<=width);
    if(width===390)await shot(page,'手机-本机依赖检查');
  }
  await page.emulateMedia({reducedMotion:'reduce'});
  assert.equal(await page.locator('.dependency-card').evaluate(el=>getComputedStyle(el).animationName),'none');
  const check=page.getByRole('button',{name:'重新检查',exact:true});
  await runPython(python,['-E','-m','venv','--without-pip',virtual]);
  await check.focus();
  await page.keyboard.press('Enter');
  await workbench.getByText('Python 环境缺少运行模块。',{exact:true}).waitFor();
  const modules=(await api('/workspace')).localDependencies.checks.workbench;
  assert.equal(modules.code,'python_modules');
  assert.ok(modules.missing.includes('fastapi'));
  assert.equal(model.calls.length,0);
  pass('从原会话进入对应检查，空虚拟环境显示缺少模块，键盘操作和五种视口及减少动效生效');

  const watcher=await browser.newPage();
  await watcher.goto(host.origin+'/#bots/media');
  const disabled=watcher.getByRole('button',{name:'新建会话',exact:true});
  await disabled.waitFor();
  assert.equal(await disabled.isEnabled(),false);
  const directoryLink=watcher.getByRole('link',{name:'检查依赖',exact:true});
  assert.equal(await directoryLink.getAttribute('href'),'#manage/dependencies?bot=media&revision=1');
  await directoryLink.click();
  await watcher.getByRole('link',{name:'返回 自媒体口播',exact:true}).waitFor();
  await watcher.goBack();
  await disabled.waitFor();

  await writeFile(path.join(await sitePath(recovering),'attached-test-site.pth'),(await sitePath(python))+'\n');
  await check.click();
  await workbench.getByText('就绪',{exact:true}).waitFor();
  await watcher.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.textContent.includes('新建会话')&&!b.disabled));
  const ready=await api('/workspace');
  assert.equal(ready.localDependencies.checks.workbench.ok,true);
  assert.ok(Date.parse(ready.localDependencies.checkedAt)>Date.parse(setup.checkedAt));
  assert.equal(ready.bots.find(bot=>bot.id==='media').blocked,'');
  assert.equal(model.calls.length,0);
  await back.click();
  await composer.waitFor();
  assert.equal(await composer.inputValue(),'根据访谈和拍摄笔记写开门分镜。');
  await page.getByRole('button',{name:'发送消息',exact:true}).click();
  await page.getByRole('button',{name:'允许本次写入',exact:true}).waitFor({timeout:45000});
  assert.equal((await api('/dependencies',{},409)).code,'busy');
  await page.getByRole('button',{name:'允许本次写入',exact:true}).click();
  const saved=await waitFor(async()=>{
    const room=await api('/rooms/'+existing.id);
    return room.artifacts.at(0);
  });
  assert.equal(saved.receipt.project,saved.project);
  assert.ok(saved.receipt.id);
  assert.equal(saved.version,1);
  assert.equal(model.calls.length,1);
  assert.deepEqual(errors,[]);
  pass('原进程复查解锁两个浏览器视图，保留原草稿，使用真实 Web Host 与 Workbench 保存首稿，审批期间保持配置稳定');

  await host.close();
  host=await launch({options:{...context,data:path.join(data,'without-credential'),providerKey:''}});
  const cold=await api('/workspace');
  assert.equal(cold.localDependencies.checks.provider.code,'credential');
  assert.equal(cold.localDependencies.checks.workbench.ok,true);
  assert.ok(cold.bots.every(bot=>bot.blocked.includes('凭据')));
  assert.equal((await api('/dependencies',{})).checks.provider.ok,false);
  assert.equal(model.calls.length,1);
  pass('无凭据的冷启动显示本机组件状态，检查过程无模型请求，发起任务仍受阻');

  const report=process.env.HYPER_BOT_TEST_REPORT;
  if(report) {
    const {version}=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
    await writeFile(report,JSON.stringify({version,checkedAt:new Date().toISOString(),checks,
      model:'local HTTP fixture',workbench:'isolated installed Self Media Workbench',modelCalls:model.calls.length,
      versionSaved:saved.version,receipt:saved.receipt.id},null,2)+'\n');
  }
} finally {
  await browser?.close();
  await host?.close();
  await model.close();
  if(priorPython===undefined)delete process.env[envName];
  else process.env[envName]=priorPython;
}


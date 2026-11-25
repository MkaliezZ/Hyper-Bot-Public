import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { modelFixture } from '../test/model-fixture.mjs';

const root=resolve(process.env.HYPER_BOT_TEST_APP_ROOT??fileURLToPath(new URL('../',import.meta.url)));
const loadApp=directory=>import(pathToFileURL(join(directory,'server','http.mjs')));
const {launch}=await loadApp(root);
const [{DRIVERS},{sha}]=await Promise.all(['engines','contracts']
  .map(name=>import(pathToFileURL(join(root,'server',name+'.mjs')))));
const {chromium}=createRequire(import.meta.url)(process.env.HYPER_BOT_TEST_PLAYWRIGHT??'playwright');
const data=await mkdtemp(join(tmpdir(),'hb-bot-revisions-'));
const quote='开门前先按编号核对展签。';
const marker='这段合成样例只用于候选验证。';
const display='展陈材料核对';
const form={id:'gallery-brief',name:display,kind:'brief',driver:'dsh-web',
  description:'整理展陈访谈，逐字引用已确认的工作记录。',skills:['material-brief']};
const sample={
  title:'展品志愿者样例',prompt:'核对展馆开门准备，归纳现场原话和后续核实项。',
  files:[{name:'志愿者访谈.md',content:quote+'\n'+marker},{name:'展台笔记.txt',content:'遇到稿签错位时，记录编号并通知值班员。'}],
  expectedQuote:quote,useInChat:false,authorized:true
};
let privatePrompts=0;
const model=await modelFixture({respond:({sources})=>{
  const [first,second]=sources;
  if(first.content.includes(marker))privatePrompts++;
  return {title:'展馆开门前的材料简报',points:[
    {name:'核对展签',text:'值班志愿者逐件核对展签。',evidence:[{material:first.id,quote:first.content.split('\n')[0]}]},
    {name:'记录问题',text:'发现错位就记录编号。',evidence:[{material:second.id,quote:second.content}]}
  ],notes:[]};
}});
const options={data,upstream:model.origin,providerKey:'fixture'};
let host,browser;
const checks=[];
function pass(message){checks.push(message);console.log('OK '+message);}
const pictures=process.env.HYPER_BOT_TEST_SCREENSHOTS;

async function api(path,body,status) {
  const request=body===undefined?{}:{method:'POST',headers:{'X-Hyper-Bot':'1','Content-Type':'application/json'},
    body:JSON.stringify(body)};
  const response=await fetch(host.origin+'/api'+path,{...request,signal:AbortSignal.timeout(45000)});
  const result=await response.json();
  if(status)assert.equal(response.status,status,JSON.stringify(result));
  else assert.ok(response.ok,JSON.stringify(result));
  return result;
}
const feature=(revision,action)=>'/bots/'+form.id+'/'+revision+'/'+action;
const workspace=()=>api('/workspace');
const room=id=>api('/rooms/'+id);
const versions=async()=>((await workspace()).bots.filter(bot=>bot.id===form.id));
async function until(read,pass) {
  const deadline=AbortSignal.timeout(45000);
  for(;;){
    const value=await read();
    if(pass(value))return value;
    await delay(170,null,{signal:deadline});
  }
}
async function capture(page,name) {
  if(!pictures)return;
  await mkdir(pictures,{recursive:true});
  await page.screenshot({path:join(pictures,name+'.png'),animations:'disabled'});
}
const label=(page,text)=>page.getByLabel(text,{exact:true});
const buttons=(page,text)=>page.getByRole('button',{name:text,exact:true});
const choice=(page,text)=>page.getByRole('combobox',{name:new RegExp('^'+text)});
const card=(page,heading)=>page.locator('.manage-card').filter({has:page.getByRole('heading',{name:heading,exact:true})});

try {
  host=await launch({options});
  const old=await api('/bots',{...form,fixture:sample},201);
  assert.equal(old.revision,1);
  assert.equal((await api(feature(1,'verify'),{})).ok,true);
  await api(feature(1,'publish'),{});
  assert.equal((await api('/rooms',{botId:form.id,revision:1,title:'未共享样例',example:true},422)).code,'sample_scope');
  const firstRoom=(await api('/rooms',{botId:form.id,revision:1,title:'上一版现场材料'},201)).id;
  const publicFiles=[{name:'展签核对.txt',content:quote},sample.files[1]];
  const attachments=[];
  for(const file of publicFiles)attachments.push((await api('/rooms/'+firstRoom+'/materials',{...file,authorized:true},201)).id);
  const ran=await api('/rooms/'+firstRoom+'/runs',{text:'整理今天的展签核对记录。',attachments,
    clientRequestId:randomUUID(),authorized:true},202);
  const saved=await until(()=>room(firstRoom),record=>{
    const state=record.runs.find(run=>run.id===ran.id)?.state;
    if(['failed','cancelled','interrupted'].includes(state))throw new Error(JSON.stringify(record.runs));
    return state==='succeeded';
  });
  const artifact=saved.artifacts[0].id;
  const pinned=DRIVERS[form.driver];
  const examinedRevision=pinned.revision;
  const incomingRevision=examinedRevision+'-upgrade-fixture';
  const queued=await api('/bots',{...form,id:'harness-binding-draft',name:'版本绑定候选'},201);
  const sendAgain=()=>({text:'再次核对现场资料。',attachments,clientRequestId:randomUUID(),authorized:true});
  host.store.change(state=>{
    delete state.bots.find(bot=>bot.id===form.id&&bot.revision===1).driverRevision;
    delete state.bots.find(bot=>bot.id==='brief'&&bot.revision===1).driverRevision;
  });
  await host.close();
  host=await launch({options});
  const beforeSubstitution=model.calls.length;
  pinned.revision=incomingRevision;
  try {
    await api('/harnesses/'+form.driver,{});
    const blocked=await api('/rooms/'+firstRoom+'/runs',sendAgain(),503);
    assert.match(blocked.error,/绑定的 Harness 版本/);
    assert.equal((await api('/bots/'+queued.id+'/1/verify',{},503)).error,blocked.error);
    assert.equal((await versions())[0].driverRevision,examinedRevision);
    assert.equal((await workspace()).bots.find(bot=>bot.id==='brief').driverRevision,DRIVERS.hermes.revision);
    const rebound=await api('/bots',{...form,id:queued.id,name:'版本绑定候选',sourceRevision:1},201);
    assert.equal(rebound.driverRevision,incomingRevision);
    assert.equal(rebound.status,'draft');
    assert.equal((await api('/bots/'+queued.id+'/2/publish',{},409)).code,'sample_required');
    const history=await room(firstRoom);
    assert.equal(history.runs.length,1);
    assert.equal(history.artifacts[0].id,artifact);
    assert.equal((await api('/artifacts/'+artifact+'/export')).manifest.id,artifact);
    assert.equal(model.calls.length,beforeSubstitution);
    browser??=await chromium.launch({executablePath:process.env.HYPER_BOT_TEST_CHROMIUM||undefined});
    const bindingPage=await browser.newPage({viewport:{width:1440,height:900}});
    try {
      await bindingPage.goto(host.origin+'/#chat/'+firstRoom);
      await bindingPage.getByRole('link',{name:'查看 Bot 版本',exact:true}).click();
      await bindingPage.waitForURL(url=>url.hash==='#manage?bot='+form.id+'&revision=1&room='+firstRoom);
      const locked=card(bindingPage,display+' r1');
      await locked.getByText(blocked.error,{exact:true}).waitFor();
      const [lockedVersion,availableVersion]=await locked.locator('.harness-binding code').all();
      assert.equal(await lockedVersion.getAttribute('title'),examinedRevision);
      assert.equal(await availableVersion.getAttribute('title'),incomingRevision);
      await locked.getByText('待重新装配',{exact:true}).waitFor();
      await locked.getByText(/^原版本样例通过/).waitFor();
      for(const width of [1440,1024,768,390,320]){
        await bindingPage.setViewportSize({width,height:width<=390?844:900});
        await locked.scrollIntoViewIfNeeded();
        const bounds=await locked.boundingBox();
        assert.ok(bounds.x>=0&&bounds.x+bounds.width<=width+1);
        if(width===1440||width===390)await capture(bindingPage,width===1440?'桌面-Harness版本绑定':'手机-Harness版本绑定');
      }
    } finally {await bindingPage.close();}
  } finally {
    pinned.revision=examinedRevision;
    await api('/harnesses/'+form.driver,{});
  }
  pass('已验版本由原回执绑定，旧内置 Bot 由原登记绑定，登记不同版本后原会话与旧候选停止接任务，旧稿可读，新组合待验');

  const skill=host.store.read().skills.find(item=>item.id===form.skills[0]);
  const changedInstructions=skill.content+'\n这是用于检验摘要的合成改动。';
  const amend=fields=>host.store.change(state=>Object.assign(state.skills.find(item=>item.id===skill.id),fields));
  try {
    amend({content:changedInstructions});
    assert.equal((await api('/rooms/'+firstRoom+'/runs',sendAgain(),409)).code,'skill_integrity');
    amend({digest:sha(changedInstructions)});
    assert.equal((await api('/rooms/'+firstRoom+'/runs',sendAgain(),409)).code,'sample_required');
    assert.equal(model.calls.length,beforeSubstitution);
    assert.equal((await room(firstRoom)).artifacts[0].id,artifact);
  } finally {
    amend({content:skill.content,digest:skill.digest});
  }
  assert.equal(ran.driverRevision,examinedRevision);
  const accounted=(await api('/receipts?category=simulation&days=all')).rows.find(row=>row.id===ran.id);
  assert.equal(accounted.driverRevision,examinedRevision);
  const checked=(await api('/receipts?category=verification&days=all')).rows.find(row=>row.botId===form.id);
  assert.equal(checked.driverRevision,examinedRevision);
  pass('运行前核对已审阅 Skill 摘要及样例通过的组合，失配时模型调用为零，任务与验证回执保留执行版本');

  const otherSkill=(await api('/skills',{slug:'gallery-claims',version:'1.0.0',name:'展陈逐句核对',
    origin:'合成验收',content:'# 逐句核对\n第二段记录需要保留核对对象和来源。不补造事实。',
    references:[],outputKind:'brief',reviewed:true},201)).id;
  const pending=await api('/bots',{...form,id:'gallery-draft',name:'展陈候选草稿'},201);

  const authorized={...form,sourceRevision:1,reuseSample:{authorized:true}};
  assert.match((await api('/bots',{...authorized,id:'wrong-family'},404)).error,/Bot 版本不存在/);
  assert.equal((await api('/bots',{...authorized,fixture:sample},422)).code,'sample_source');
  assert.equal((await api('/bots',{...authorized,reuseSample:{authorized:false}},422)).code,'validation');
  assert.equal((await api('/bots',{...authorized,kind:'script',skills:['talking-script']},422)).code,'sample_source');
  assert.equal((await versions()).length,1);
  assert.doesNotMatch(JSON.stringify(await workspace()),new RegExp(marker));
  pass('跨 Bot、不同成果类型、重复样例来源和无授权请求均未建版，未共享样例原文未对工作区列表公开');

  browser??=await chromium.launch({executablePath:process.env.HYPER_BOT_TEST_CHROMIUM||undefined});
  const page=await browser.newPage({viewport:{width:1440,height:900}});
  page.setDefaultTimeout(25000);
  const problems=[];
  page.on('pageerror',error=>problems.push(error.message));
  await page.goto(host.origin+'/#manage');
  await buttons(page,'装配 Bot').click();
  await label(page,'Bot 名称').fill('样例材料归纳');
  await label(page,'稳定 ID').fill('catalog-brief');
  await page.getByRole('textbox',{name:/^用途说明/}).fill('归纳现场材料与逐句引用。');
  await page.getByText('将绑定 '+DRIVERS.dsh.revision,{exact:true}).waitFor();
  await buttons(page,'保存候选版本').click();
  await page.waitForURL(url=>url.hash==='#manage?bot=catalog-brief&revision=1');
  const newCard=card(page,'样例材料归纳 r1');
  await newCard.getByRole('button',{name:'验证样例',exact:true}).waitFor();
  await page.waitForFunction(()=>document.activeElement?.textContent.trim()==='样例材料归纳 r1');
  assert.equal(await newCard.locator('.harness-binding code').textContent(),DRIVERS.dsh.revision);
  assert.equal(await newCard.getByRole('button',{name:'启用此版',exact:true}).isDisabled(),true);
  pass('从零装配时显示将绑定的版本，保存后以键盘焦点直达可验证的候选卡');
  await card(page,'展陈候选草稿 r1').getByRole('link',{name:'打开装配草稿',exact:true}).press('Enter');
  assert.equal(await label(page,'Bot 名称').inputValue(),'展陈候选草稿');
  assert.equal(await label(page,'稳定 ID').inputValue(),pending.id);
  assert.equal(await choice(page,'样例来源').inputValue(),'builtin');
  await buttons(page,'保存下一候选版').click();
  await page.waitForURL(url=>url.hash==='#manage?bot=gallery-draft&revision=2');
  assert.equal((await workspace()).bots.find(item=>item.id===pending.id&&item.revision===2).sourceRevision,1);
  pass('从已保存候选打开原配置并保存下一版，原候选版本仍可查阅');

  await card(page,display+' r1').getByRole('link',{name:'基于此版装配',exact:true}).press('Enter');
  await page.waitForURL(url=>url.hash==='#manage/compose?bot='+form.id+'&revision=1');
  const heading=page.getByRole('heading',{name:'基于 '+display+' r1 装配',exact:true});
  await heading.waitFor();
  assert.ok(await heading.evaluate(node=>node===document.activeElement));
  assert.equal(await label(page,'Bot 名称').inputValue(),display);
  assert.equal(await page.getByRole('textbox',{name:/^用途说明/}).inputValue(),form.description);
  assert.equal(await label(page,'稳定 ID').inputValue(),form.id);
  assert.equal(await label(page,'稳定 ID').evaluate(node=>node.readOnly),true);
  assert.equal(await choice(page,'Harness').inputValue(),'dsh-web');
  assert.equal(await choice(page,'样例来源').inputValue(),'inherited');
  const review=label(page,'已获授权将此样例用于新版本验证。');
  const saveNext=buttons(page,'保存下一候选版');
  await saveNext.click();
  assert.equal((await versions()).length,1);
  assert.ok(await review.evaluate(node=>node===document.activeElement));
  await review.check();
  await choice(page,'Harness').selectOption('hermes');
  assert.equal(await review.isChecked(),false);
  await review.check();
  await label(page,'素材简报 · 1.0.0').uncheck();
  await label(page,'展陈逐句核对 · 1.0.0').check();
  assert.equal(await review.isChecked(),false);
  await label(page,'Bot 名称').fill('展陈素材归纳');
  await page.getByText('展品志愿者样例 · 2 份材料 · 仅候选验证',{exact:true}).waitFor();
  assert.equal(await page.locator('.management-form.view-in').evaluate(node=>getComputedStyle(node).animationDuration),'0.22s');
  await review.check();
  if(pictures){
    await page.getByText('已保存候选版本。',{exact:true}).waitFor({state:'hidden'});
    await page.locator('.route-page').evaluate(node=>node.scrollTo({top:0,behavior:'instant'}));
    await capture(page,'桌面-基于Bot版本装配');
  }
  await page.emulateMedia({reducedMotion:'reduce'});
  assert.equal(await page.locator('.sample-fields.status-in').evaluate(node=>getComputedStyle(node).animationName),'none');
  for(const width of [1440,1024,768,390,320]){
    await page.setViewportSize({width,height:width<500?844:900});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),width);
    const field=await page.locator('.management-form').boundingBox();
    assert.ok(field&&field.x>=0&&field.x+field.width<=width+1);
    if(pictures&&width===390){
      await heading.evaluate(node=>node.scrollIntoView({block:'start',behavior:'instant'}));
      await capture(page,'手机-基于Bot版本装配');
    }
  }
  pass('来源表单预填稳定 ID、用途、Skill 与 Harness，变更 Skill 或 Harness 后须确认沿用样例授权，覆盖五种屏宽与减少动效');

  await saveNext.click();
  await page.waitForURL(url=>url.hash==='#manage?bot='+form.id+'&revision=2');
  await page.waitForFunction(()=>document.activeElement?.textContent.trim()==='展陈素材归纳 r2');
  const fresh=card(page,'展陈素材归纳 r2');
  await fresh.getByRole('link',{name:'r1',exact:true}).waitFor();
  const enable=fresh.getByRole('button',{name:'启用此版',exact:true});
  assert.equal(await enable.isDisabled(),true);
  const [initial,next]=await versions();
  assert.equal(initial.status,'enabled');
  assert.equal(next.status,'draft');
  assert.equal(next.sourceRevision,1);
  assert.equal(next.driver,'hermes');
  assert.deepEqual(next.skills,[otherSkill]);
  assert.equal(next.verificationFixture.digest,old.verificationFixture.digest);
  assert.equal(next.sample,null);
  assert.equal((await api(feature(2,'publish'),{},409)).code,'sample_required');
  const sourceHistory=await room(firstRoom);
  assert.equal(sourceHistory.revision,1);
  assert.equal(sourceHistory.artifacts[0].id,artifact);
  pass('保存后焦点落在准确的新候选卡，来源版本可回查，旧会话继续绑定原配置和成果');

  await fresh.getByRole('button',{name:'验证样例',exact:true}).click();
  await fresh.getByText('样例已通过 · 展馆开门前的材料简报',{exact:true}).waitFor();
  const afterValidation=(await versions())[1];
  assert.equal(afterValidation.sample.usage.protocol,'chat-completions');
  assert.equal(afterValidation.driverRevision,DRIVERS.hermes.revision);
  assert.equal(afterValidation.sample.driverRevision,DRIVERS.hermes.revision);
  assert.equal(privatePrompts,2);
  await enable.click();
  await fresh.getByText('已启用',{exact:true}).waitFor();
  assert.equal((await versions())[0].status,'disabled');
  assert.equal((await api('/rooms',{botId:form.id,revision:2,title:'尝试载入私有样例',example:true},422)).code,'sample_scope');
  await page.goto(host.origin+'/#bots/'+form.id);
  await page.getByRole('heading',{name:'展陈素材归纳',level:1,exact:true}).waitFor();
  await buttons(page,'新建会话').click();
  await page.getByRole('dialog').getByRole('textbox',{name:/会话/}).fill('新版本会话');
  await buttons(page,'开始会话').click();
  await page.waitForURL(url=>url.hash.startsWith('#chat/'));
  assert.equal((await room(new URL(page.url()).hash.slice(6))).revision,2);
  assert.equal((await room(firstRoom)).artifacts[0].id,artifact);
  pass('原 DSH 运行与改版 Hermes 验证均真实执行，启用后新会话进 r2，私有样例和 r1 历史保留各自范围');

  const replacement={...sample,title:'另一批展签验证',useInChat:true};
  const changed=await api('/bots',{...form,sourceRevision:1,fixture:replacement},201);
  assert.equal(changed.revision,3);
  assert.notEqual(changed.verificationFixture.digest,old.verificationFixture.digest);
  assert.equal(changed.exampleTitle,replacement.title);
  await page.goto(host.origin+'/#manage/compose?bot='+form.id+'&revision=99');
  await page.getByRole('heading',{name:'找不到所选版本',exact:true}).waitFor();
  assert.equal(await label(page,'稳定 ID').count(),0);
  assert.deepEqual(problems,[]);
  pass('可选择新的授权样例，失效版本链接能返回版本列表');

  let rollback=null;
  const previous=process.env.HYPER_BOT_TEST_PREVIOUS_APP_ROOT;
  if(previous){
    await browser.close();
    browser=null;
    await host.close();
    const present=await loadApp(resolve(previous));
    host=await present.launch({options});
    const current=(await versions()).find(row=>row.status==='enabled');
    assert.equal(current.revision,2);
    assert.equal(current.sourceRevision,1);
    assert.equal((await room(firstRoom)).artifacts[0].id,artifact);
    const {version}=JSON.parse(await readFile(join(previous,'package.json'),'utf8'));
    rollback={version,revision:2,historyArtifact:artifact};
    pass('回滚后仍能读取来源版次、已启用的新版本和旧成果');
  }
  const {version:applicationVersion}=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
  const result={applicationVersion,mode:'Windows 本机真实 DSH Web Host 与 Hermes ACP，模型协议夹具',checks,
    originalHarness:examinedRevision,simulatedAvailableHarness:incomingRevision,verifiedHarness:afterValidation.driverRevision,
    version:(await versions()).find(row=>row.status==='enabled').revision,artifact,
    derivativeDriver:afterValidation.driver,sourceAndDerivativeSampleDigest:old.verificationFixture.digest,
    privatePrompts,rollback};
  if(process.env.HYPER_BOT_TEST_REPORT)await writeFile(process.env.HYPER_BOT_TEST_REPORT,JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result,null,2));
} finally {
  await browser?.close();
  await host?.close();
  await model.close();
}


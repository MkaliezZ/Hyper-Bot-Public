import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { modelFixture, sample } from '../test/model-fixture.mjs';

const root=resolve(process.env.HYPER_BOT_TEST_APP_ROOT??fileURLToPath(new URL('../',import.meta.url)));
const {launch}=await import(pathToFileURL(join(root,'server','http.mjs')));
const {chromium}=createRequire(import.meta.url)(process.env.HYPER_BOT_TEST_PLAYWRIGHT??'playwright');
const version=JSON.parse(await readFile(join(root,'package.json'),'utf8')).version;
const data=await mkdtemp(join(tmpdir(),'hb-assembly-review-'));
const shots=process.env.HYPER_BOT_TEST_SCREENSHOTS;
const title='素材引文审阅';
const botId='materials-review';
const sourceTitle='逐条核对原文';
const scopeTitle='标注材料缺项';
const sourceId='source-audit@1.0.0';
const scopeId='scope-review@1.0.0';
const privateText='仅原件可读的合成原文标识';
const quote='开门后先摆书。';
const files=[{name:'核对访谈.txt',content:privateText+'\n'+quote},
  {name:'拍摄备注.md',content:'开门后的灯光颜色还需核对。'}];
const captured=[];
const checks=[];
const measurements=[];
const errors=[];
let failNext=false;
let host,browser;
const model=await modelFixture({
  observe({text,sources}){
    const order=[['ORDER-A',sourceId],['ORDER-B',scopeId]].filter(([mark])=>text.includes(mark))
      .sort(([a],[b])=>text.indexOf(a)-text.indexOf(b)).map(([,id])=>id);
    captured.push({order,privateSource:sources.some(file=>file.content.includes(privateText))});
  },
  respond(prompt){
    if(failNext){failNext=false;return {title:'未通过结构的样例'};}
    return sample(prompt);
  }
});
const pass=label=>{checks.push(label);console.log('OK '+label);};
const access={'X-Hyper-Bot':'1'};

async function request(route,body,status=200,headers=access) {
  const init=body===undefined?{headers}:{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify(body)};
  const response=await fetch(host.origin+'/api'+route,{...init,signal:AbortSignal.timeout(100000)});
  const result=await response.json();
  assert.equal(response.status,status,JSON.stringify(result));
  return result;
}
async function until(read,accept,timeout=66000){
  const limit=AbortSignal.timeout(timeout);
  for(;;){
    const value=await read();
    if(accept(value))return value;
    await delay(100,null,{signal:limit});
  }
}
const workspace=()=>request('/workspace');
const bots=(state,revision)=>state.bots.find(bot=>bot.id===botId&&bot.revision===revision);
const candidate=async revision=>bots(await workspace(),revision);
const preview=revision=>'/bots/'+botId+'/'+revision+'/sample-preview';
const card=(page,name,revision)=>page.locator('.manage-card').filter({has:page.getByRole('heading',{name:name+' r'+revision,exact:true})});
const up=(page,name)=>page.getByRole('button',{name:'上移 '+name+' 1.0.0',exact:true});
const down=(page,name)=>page.getByRole('button',{name:'下移 '+name+' 1.0.0',exact:true});
const order=page=>page.locator('.assembly-skill').filter({has:page.locator('input:checked')}).getByRole('checkbox').evaluateAll(
  items=>items.map(input=>input.closest('label').textContent.trim()));
const opener=entry=>entry.getByRole('button',{name:'查看样例成果',exact:true});
const review=page=>page.getByRole('dialog',{name:'样例预览',exact:true});
const verify=entry=>entry.getByRole('button',{name:'验证样例',exact:true});
const enable=entry=>entry.getByRole('button',{name:'启用此版',exact:true});
async function focus(page,control) {
  const found=await control.elementHandle();
  try {await page.waitForFunction(node=>node===document.activeElement,found,{timeout:5000});}
  finally {await found.dispose();}
}
async function capture(page,name) {
  if(!shots)return;
  await mkdir(shots,{recursive:true});
  await page.screenshot({path:join(shots,name+'.png'),animations:'disabled'});
}
async function checkResponsive(page,width,height) {
  await page.setViewportSize({width,height});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),width);
}
const fixtureFiles=items=>items.map(file=>({name:file.name,mimeType:'text/plain',buffer:Buffer.from(file.content)}));

async function startFromDirectory(page,revision){
  await page.goto(host.origin+'/#bots');
  await page.locator('.directory-card').filter({has:page.getByRole('heading',{name:title,exact:true})})
    .getByRole('button',{name:'新建会话',exact:true}).click();
  assert.equal(await page.getByRole('button',{name:/载入.*演练/}).count(),0);
  await page.getByRole('textbox',{name:'会话标题'}).fill('现场材料核对 '+revision);
  await page.getByRole('button',{name:'开始会话',exact:true}).click();
  await page.waitForURL(/#chat\/[-a-f0-9]+$/);
  const id=page.url().split('#chat/')[1];
  const room=()=>request('/rooms/'+id);
  const choice=page.waitForEvent('filechooser');
  await page.getByRole('button',{name:'材料',exact:true}).click();
  await (await choice).setFiles(fixtureFiles([{name:'原始采访.txt',content:'请记录门口的脚步声音。'},
    {name:'现场笔记.md',content:'光线仍待核对。'}]));
  await until(room,value=>value.draft.attachments.length===2);
  await page.locator('#message').fill('从两份授权素材归纳已知内容。');
  await page.getByRole('button',{name:'发送消息',exact:true}).click();
  const saved=await until(room,value=>{
    const run=value.runs[0];
    if(run?.state==='failed'||run?.state==='interrupted')throw new Error(run.error);
    return run?.state==='succeeded';
  });
  assert.equal(saved.revision,revision);
  assert.ok(saved.artifacts[0].result.points.length);
  return {id,room:saved,artifact:saved.artifacts[0].id};
}

async function openCandidate(page,revision){
  await page.goto(host.origin+'/#manage?bot='+botId+'&revision='+revision);
  const entry=card(page,title,revision);
  await entry.waitFor();
  return entry;
}

try {
  host=await launch({options:{data,upstream:model.origin,providerKey:'fixture'}});
  for(const [slug,name,content] of [['source-audit',sourceTitle,'ORDER-A：逐条引用经授权材料中的连续原句。'],
    ['scope-review',scopeTitle,'ORDER-B：把现场尚缺的内容写入待确认项。']]){
    await request('/skills',{slug,version:'1.0.0',name,content,origin:'Hyper Bot 合成装配验收',
      outputKind:'brief',references:[],reviewed:true},201);
  }
  browser=await chromium.launch({executablePath:process.env.HYPER_BOT_TEST_CHROMIUM||undefined});
  const page=await browser.newPage({viewport:{width:1440,height:900}});
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(host.origin+'/#manage/compose');
  await page.getByLabel('Bot 名称',{exact:true}).fill(title);
  await page.getByLabel('稳定 ID',{exact:true}).fill(botId);
  await page.getByLabel('用途说明',{exact:true}).fill('检查素材中的引文及需要记录的缺项。');
  await page.getByRole('combobox',{name:'Harness',exact:true}).selectOption('dsh-web');
  await page.getByRole('checkbox',{name:/素材.*简报|简报.*素材/}).uncheck();
  await page.getByRole('checkbox',{name:new RegExp('^'+scopeTitle)}).check();
  await page.getByRole('checkbox',{name:new RegExp('^'+sourceTitle)}).check();
  assert.deepEqual(await order(page),[scopeTitle+' · 1.0.0',sourceTitle+' · 1.0.0']);
  await up(page,sourceTitle).press('Enter');
  await focus(page,down(page,sourceTitle));
  assert.ok(await up(page,sourceTitle).isDisabled());
  assert.deepEqual(await order(page),[sourceTitle+' · 1.0.0',scopeTitle+' · 1.0.0']);
  await down(page,sourceTitle).press('Enter');
  await focus(page,up(page,sourceTitle));
  assert.ok(await down(page,sourceTitle).isDisabled());
  assert.deepEqual(await order(page),[scopeTitle+' · 1.0.0',sourceTitle+' · 1.0.0']);
  await up(page,sourceTitle).press('Enter');
  const widths=[[1440,900],[1024,900],[768,900],[390,844],[320,780]];
  for(const [width,height] of widths){
    await checkResponsive(page,width,height);
    const move=up(page,scopeTitle);
    await move.scrollIntoViewIfNeeded();
    const box=await move.boundingBox();
    assert.ok(box.x>=0&&box.x+box.width<=width);
    if(width<=390)assert.ok(box.width>=44&&box.height>=44);
    if(width===1440||width===390) {
      await page.locator('.assembly-skills').evaluate(node=>node.scrollIntoView({block:'center',behavior:'instant'}));
      await capture(page,(width===390?'手机':'桌面')+'-Skill装配顺序');
    }
  }
  await checkResponsive(page,1440,900);
  await page.getByLabel('样例来源').selectOption('custom');
  await page.getByLabel('样例名称').fill('开门前私有核对样例');
  await page.getByLabel('样例任务').fill('逐条归纳现场记录，引用指定句子并注明缺项。');
  await page.getByLabel('样例材料',{exact:true}).setInputFiles(fixtureFiles(files));
  await page.getByLabel('指定引用原文（可选）').fill(quote);
  await page.getByLabel('已获授权将这些文字用于模型验证。').check();
  await page.getByRole('button',{name:'保存候选版本',exact:true}).click();
  let first=card(page,title,1);
  await first.getByText(sourceTitle+'、'+scopeTitle,{exact:true}).waitFor();
  assert.deepEqual((await candidate(1)).skills,[sourceId,scopeId]);
  assert.equal((await request(preview(1),undefined,404)).code,'sample_preview_unavailable');
  await verify(first).click();
  await opener(first).waitFor();
  assert.deepEqual(captured[0],{order:[sourceId,scopeId],privateSource:true});
  pass('装配页和版本卡的 Skill 顺序一致，键盘可调整，实际 DSH 样例请求采用该顺序');

  const getPreview=()=>request(preview(1));
  const firstSample=await getPreview();
  assert.equal(firstSample.runId,(await candidate(1)).sample.runId);
  assert.deepEqual(firstSample.materials.map(item=>item.name),files.map(item=>item.name));
  assert.ok(firstSample.materials.every(file=>Object.keys(file).sort().join(',')==='id,name'));
  assert.equal((await request(preview(1),undefined,403,{})).code,'invalid_sample_preview');
  const every=(await workspace()).bots.find(bot=>bot.id===botId);
  assert.ok(!JSON.stringify(every).includes(quote)&&!('result' in every.sample));
  assert.ok(!JSON.stringify(await request('/receipts')).includes(quote));
  assert.ok(!JSON.stringify(firstSample).includes(privateText));
  pass('样例成果绑定验证回执，专门请求才返回校验后的内容和材料名称，普通列表及回执不含样例原文');

  for(const [width,height] of widths){
    const reduced=width===320;
    await page.emulateMedia({reducedMotion:reduced?'reduce':'no-preference'});
    await checkResponsive(page,width,height);
    await opener(first).press('Enter');
    const modal=review(page);
    await modal.getByText(quote,{exact:true}).waitFor();
    await modal.getByText(files[0].name,{exact:true}).waitFor();
    await modal.getByText('DeepSeek Harness · Web Host',{exact:true}).waitFor();
    assert.equal(await modal.evaluate(node=>getComputedStyle(node).animationName),reduced?'none':'sheet-in');
    if(!reduced)assert.equal(await modal.evaluate(node=>getComputedStyle(node).animationDuration),'0.24s');
    const box=await modal.boundingBox();
    assert.ok(box.x>=0&&box.x+box.width<=width&&box.y>=0&&box.y+box.height<=height);
    if(width===1440||width===390)await capture(page,(width===390?'手机':'桌面')+'-候选样例成果');
    await page.keyboard.press('Escape');
    if(!reduced){
      await modal.locator('xpath=self::*[contains(@class," closing")]').waitFor({timeout:1000});
      assert.equal(await modal.evaluate(node=>getComputedStyle(node).animationDuration),'0.12s');
    }
    await modal.waitFor({state:'hidden'});
    await focus(page,opener(first));
    measurements.push({width,openMs:reduced?0:240,closeMs:reduced?0:120,focusReturned:true});
  }
  pass('五种窗口宽度可读简报与引用，弹窗支持键盘、回焦、240/120 ms 和减少动效');

  await checkResponsive(page,1440,900);
  await enable(first).click();
  await first.getByRole('button',{name:'停用此版'}).waitFor();
  const firstUse=await startFromDirectory(page,1);
  assert.equal(firstUse.room.runs[0].driver,'dsh-web');
  assert.deepEqual(captured[1],{order:[sourceId,scopeId],privateSource:false});

  first=await openCandidate(page,1);
  await first.getByRole('link',{name:'基于此版装配'}).click();
  await page.getByRole('combobox',{name:'Harness',exact:true}).selectOption('hermes');
  const consent=page.getByLabel('已获授权将此样例用于新版本验证。');
  await consent.check();
  await up(page,scopeTitle).press('Enter');
  assert.equal(await consent.isChecked(),false);
  await up(page,sourceTitle).press('Enter');
  await consent.check();
  await page.getByRole('button',{name:'保存下一候选版',exact:true}).click();
  const second=card(page,title,2);
  await second.waitFor();
  assert.equal((await candidate(2)).driver,'hermes');
  assert.deepEqual((await candidate(2)).skills,[sourceId,scopeId]);
  await verify(second).click();
  const initialHermes=await until(()=>candidate(2),bot=>bot.sample && !bot.sampleBusy,105000);
  assert.equal(initialHermes.sample.ok,true,initialHermes.sample.reason);
  await opener(second).waitFor();
  const hermesSample=await request(preview(2));
  assert.equal(hermesSample.runId,initialHermes.sample.runId);
  assert.deepEqual(captured[2],{order:[sourceId,scopeId],privateSource:true});
  assert.deepEqual(hermesSample.result.points.map(item=>item.evidence[0].quote),
    firstSample.result.points.map(item=>item.evidence[0].quote));
  pass('同一个 Skill 组合沿用已授权样例切到 Hermes，移动顺序后重新确认授权，两引擎原文引用一致');

  failNext=true;
  await verify(second).click();
  const failed=await until(()=>candidate(2),bot=>bot.sample && !bot.sampleBusy && bot.sample.runId!==hermesSample.runId,105000);
  assert.equal(failed.sample.code,'invalid_output');
  await second.getByText(/成果结构未通过校验/).waitFor();
  assert.ok(await enable(second).isDisabled());
  assert.equal(await opener(second).count(),0);
  await request(preview(2),undefined,404);
  assert.equal(host.app.store.read().verifications.find(run=>run.id===hermesSample.runId).samplePreview,undefined);
  await verify(second).click();
  const verified=await until(()=>candidate(2),bot=>bot.sample && !bot.sampleBusy && bot.sample.runId!==failed.sample.runId,105000);
  assert.equal(verified.sample.ok,true,verified.sample.reason);
  await opener(second).waitFor();
  const repaired=await request(preview(2));
  assert.equal(repaired.runId,verified.sample.runId);
  pass('复验失败后版本保持候选，失败原因可读。重新验证通过后预览只绑定最新样例');

  await enable(second).click();
  await second.getByRole('button',{name:'停用此版'}).waitFor();
  const secondUse=await startFromDirectory(page,2);
  assert.equal(secondUse.room.runs[0].driver,'hermes');
  assert.deepEqual(captured[5],{order:[sourceId,scopeId],privateSource:false});
  assert.equal((await request('/rooms/'+firstUse.id)).artifacts[0].id,firstUse.artifact);
  pass('用户从同一目录正常使用两个版次，原会话保留 DSH 成果，切版后的新会话由 Hermes 运行');

  await request('/bots',{id:'script-review',name:'口播样例审阅',description:'从授权素材生成可核对口播稿。',
    kind:'script',driver:'dsh-web',skills:['talking-script']},201);
  await page.goto(host.origin+'/#manage?bot=script-review&revision=1');
  const script=card(page,'口播样例审阅',1);
  await verify(script).click();
  await opener(script).click();
  await review(page).getByRole('button',{name:/摆书$/}).click();
  await review(page).getByText('画面',{exact:true}).waitFor();
  await review(page).getByText('字幕',{exact:true}).waitFor();
  await capture(page,'桌面-口播样例成果');
  await page.keyboard.press('Escape');
  await review(page).waitFor({state:'hidden'});
  assert.equal((await workspace()).conversations.some(room=>room.botId==='script-review'),false);
  pass('口播候选复用分镜预览，可展开镜头查看口播、画面、字幕和引用');

  let rollback;
  const previousRoot=process.env.HYPER_BOT_TEST_PREVIOUS_APP_ROOT;
  if(previousRoot){
    await browser.close(); browser=null;
    await host.close();
    const {launch:previousLaunch}=await import(pathToFileURL(join(previousRoot,'server','http.mjs')));
    host=await previousLaunch({options:{data,upstream:model.origin,providerKey:'fixture'}});
    assert.deepEqual((await candidate(2)).skills,[sourceId,scopeId]);
    assert.ok(!JSON.stringify(await workspace()).includes(quote));
    assert.equal((await request('/rooms/'+secondUse.id)).artifacts[0].id,secondUse.artifact);
    await host.close();
    host=await launch({options:{data,upstream:model.origin,providerKey:'fixture'}});
    assert.equal((await request(preview(2))).runId,repaired.runId);
    rollback={version:JSON.parse(await readFile(join(previousRoot,'package.json'),'utf8')).version,orderAndHistory:true,
      previewReturnedAfterUpgrade:true};
    pass('回滚可读装配顺序和历史成果，升级后可查看原验证结果');
  }

  await request('/skills/'+sourceId+'/revoke',{confirmed:true});
  for(const revision of [1,2]){
    assert.equal((await candidate(revision)).samplePreviewAvailable,false);
    await request(preview(revision),undefined,404);
  }
  assert.equal((await request('/rooms/'+secondUse.id)).artifacts[0].id,secondUse.artifact);
  assert.equal(model.calls.length,7);
  assert.ok(model.calls.every(call=>call.tools===0));
  assert.deepEqual(errors,[]);
  pass('撤销 Skill 后停止展示关联的验证预览，原用户会话的已存成果仍可读，模型调用总数未增加');

  const report={version,checks,viewports:measurements,providerRequests:model.calls.length,paidRequests:0,
    drivers:[firstUse.room.runs[0].driver,secondUse.room.runs[0].driver],order:[sourceId,scopeId],...(rollback?{rollback}:{})};
  if(process.env.HYPER_BOT_TEST_REPORT)await writeFile(process.env.HYPER_BOT_TEST_REPORT,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report));
} finally {
  await browser?.close();
  await host?.close();
  await model.close();
}

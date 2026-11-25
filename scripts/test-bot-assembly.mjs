import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { modelFixture } from '../test/model-fixture.mjs';

const root=resolve(process.env.HYPER_BOT_TEST_APP_ROOT ?? fileURLToPath(new URL('../',import.meta.url)));
const {launch}=await import(pathToFileURL(join(root,'server','http.mjs')));
const data=await mkdtemp(join(tmpdir(),'hb-assembly-'));
const lastLine='我每天把修好的表分两排摆上柜台。';
const unused='开门前先将表盘和标签分好。';
const files=[
  {name:'修表摊访谈.txt',content:[unused,lastLine].join('\n')},
  {name:'拍摄记录.md',content:'柜台旁录一段上弦声音。'}
];
const sample={title:'修表摊开张',prompt:'从两份文字核对修表摊的证据。先保留摊主对摆放顺序的原话。',
  files,expectedQuote:lastLine,authorized:true,useInChat:true};
const skillSource={slug:'clock-brief',version:'1.0.0',name:'修表摊归纳',
  origin:'Hyper Bot 自备合成夹具',outputKind:'brief',reviewed:true,
  content:'# 修表摊归纳\n从访谈和记录找可核查出处。参照[摘录要求](references/guidance.md)。',
  references:[{name:'references/guidance.md',text:'逐字摘录可核查的文字，并明确区分拍摄设想。'}]};
const folderSource={...skillSource,slug:'clock-brief-folder',name:'修表摊目录归纳',
  content:'# 修表摊归纳\n目录版口播资料核对。先看[读审口径](references/访谈/读审.md)。',
  references:[
    {name:'references/访谈/读审.md',text:'逐字摘录可核查的文字。按[读审顺序](../checklist.md#顺序)复核。'},
    {name:'references/checklist.md',text:'# 顺序\n先核对原话，再确认拍摄笔记和拟用时长。'}
  ]};
let folderReads=0;
const model=await modelFixture({
  observe({text,sources}) {
    if (!text.includes('修表摊开张')) return;
    assert.deepEqual(sources.map(({name,content})=>({name,content})),files);
    assert.ok(text.includes('逐字摘录可核查的文字'));
    if (text.includes('目录版口播资料核对')) {
      for(const file of folderSource.references) {
        assert.ok(text.includes('# '+file.name+'\n'+file.text));
      }
      folderReads++;
    }
  },
  respond({text,sources}) {
    const evidence=sources.map(source=>[{material:source.id,quote:source.content.split('\n').at(-1)}]);
    if (text.includes('"segments"')) {
      return {title:'修表摊开张的口播分镜',segments:[
        {name:'开张',start:0,end:15,spoken:lastLine,visual:'从柜台掠过两排修好的表。',subtitle:'修表摊开张',evidence:evidence[0]},
        {name:'留声',start:15,end:30,spoken:'听一段上弦的声音。',visual:'指尖转动表冠。',subtitle:'上弦声',evidence:evidence[1]}
      ],notes:[]};
    }
    return {title:'修表摊开张的素材简报',points:[
      {name:'柜台摆放',text:'摊主会将修好的表分两排摆放。',evidence:evidence[0]},
      {name:'现场录音',text:'拍摄笔记安排收录一段上弦声。',evidence:evidence[1]}
    ],notes:[]};
  }
});
const checks=[];
const pass=value=>{checks.push(value);console.log('OK '+value);};
const options={data,providerKey:'hyper-bot-test',upstream:model.origin,model:'deepseek-v4-flash'};
let host;
const open=(modelName=options.model)=>launch({options:{...options,model:modelName}});
const post=(body)=>({method:'POST',headers:{'Content-Type':'application/json','X-Hyper-Bot':'1'},body:JSON.stringify(body)});
async function api(route,body,status) {
  const res=await fetch(host.origin+'/api'+route,body===undefined?{}:post(body));
  const output=await res.json();
  if (status) assert.equal(res.status,status,JSON.stringify(output));
  else assert.ok(res.ok,JSON.stringify(output));
  return output;
}
const enabled=(bot)=>api('/bots/'+bot.id+'/'+bot.revision+'/publish',{});
const verify=(bot)=>api('/bots/'+bot.id+'/'+bot.revision+'/verify',{});
const room=(id)=>api('/rooms/'+id);
const start=(id,text,attachments)=>api('/rooms/'+id+'/runs',{text,attachments,clientRequestId:randomUUID(),authorized:true});
const workspace=()=>api('/workspace');
const route=(bot,method)=>'/bots/'+bot.id+'/'+bot.revision+'/'+method;
async function until(read,accept,label) {
  for (let count=0;count<160;count++) {
    const actual=await read();
    if (accept(actual)) return actual;
    await sleep(175);
  }
  throw new Error('Timed out waiting for '+label);
}
async function state(id,run,desired) {
  return until(()=>room(id),value=>{
    const current=value.runs.find(item=>item.id===run);
    if (current?.state!==desired && ['failed','interrupted','cancelled','succeeded'].includes(current?.state)) {
      throw new Error('Expected '+desired+', got '+current.state+' '+current.error);
    }
    return current?.state===desired;
  },desired);
}

async function rendererCheck() {
  const playwright=process.env.HYPER_BOT_TEST_PLAYWRIGHT;
  if (!playwright) return;
  const {chromium}=createRequire(import.meta.url)(playwright);
  const browser=await chromium.launch({executablePath:process.env.HYPER_BOT_TEST_CHROMIUM||undefined});
  const shots=process.env.HYPER_BOT_TEST_SCREENSHOTS;
  if (shots) await mkdir(shots,{recursive:true});
  const errors=[];
  try {
    const page=await browser.newPage({viewport:{width:1440,height:900}});
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(host.origin+'/#manage');
    await page.getByRole('button',{name:'Skill 与 Harness'}).click();
    await page.getByLabel('Skill 名称').fill('修表摊归纳 UI');
    await page.getByLabel('Skill ID').fill('clock-brief-ui');
    await page.getByLabel('使用依据',{exact:true}).fill('联调合成样例');
    await page.getByLabel('适用成果').selectOption('brief');
    await page.getByLabel('SKILL.md 与引用文件').setInputFiles([
      {name:'SKILL.md',mimeType:'text/markdown',buffer:Buffer.from(skillSource.content)},
      {name:'guidance.md',mimeType:'text/markdown',buffer:Buffer.from(skillSource.references[0].text)}
    ]);
    await page.getByLabel('已审阅文本及使用依据。').check();
    await page.getByRole('button',{name:'导入 Skill'}).click();
    await page.getByText('已登记 Skill 版本。',{exact:true}).waitFor();

    const folder=await mkdtemp(join(data,'skill-folder-'));
    const extra=await mkdtemp(join(data,'unreviewed-'));
    await writeFile(join(folder,'SKILL.md'),folderSource.content);
    for(const reference of folderSource.references) {
      const target=join(folder,reference.name);
      await mkdir(dirname(target),{recursive:true});
      await writeFile(target,reference.text);
    }
    await writeFile(join(extra,'SKILL.md'),folderSource.content);
    await writeFile(join(extra,'补充.py'),'合成测试文件');
    await page.getByLabel('Skill 名称').fill(folderSource.name);
    await page.getByLabel('Skill ID').fill(folderSource.slug);
    const folderInput=page.getByLabel('Skill 文件夹',{exact:true});
    const folderButton=page.getByRole('button',{name:'选择 Skill 文件夹',exact:true});
    const review=page.getByLabel('已审阅文本及使用依据。');
    const loadSkill=page.getByRole('button',{name:'导入 Skill'});
    await folderInput.setInputFiles(extra);
    await page.getByRole('alert').getByText('请选择 SKILL.md 和 references/ 下的 Markdown 文档。').waitFor();
    assert.equal(await loadSkill.isDisabled(),true);
    const [picker]=await Promise.all([page.waitForEvent('filechooser'),folderButton.press('Enter')]);
    await picker.setFiles(folder);
    const folderList=page.getByRole('list',{name:'待导入文件'});
    await folderList.getByText('references/访谈/读审.md',{exact:true}).waitFor();
    assert.deepEqual(await folderList.getByRole('listitem').allTextContents(),
      ['SKILL.md','references/checklist.md','references/访谈/读审.md']);
    assert.ok(await folderButton.evaluate(node=>node===document.activeElement));
    assert.equal(await folderList.evaluate(el=>getComputedStyle(el).animationDuration),'0.18s');
    await review.check();
    await folderInput.setInputFiles(folder);
    assert.equal(await review.isChecked(),false);
    await review.check();
    await page.getByLabel('使用依据',{exact:true}).fill('审阅了已选目录内的两个引用文档');
    assert.equal(await loadSkill.isDisabled(),true);
    await review.check();
    if(shots) {
      await page.getByText('已登记 Skill 版本。',{exact:true}).waitFor({state:'hidden'});
      await folderList.scrollIntoViewIfNeeded();
      await page.screenshot({path:join(shots,'桌面-Skill目录导入.png'),animations:'disabled'});
    }
    const registered=page.waitForResponse(response=>response.url()===host.origin+'/api/skills'&&response.status()===201);
    await loadSkill.click();
    const imported=await (await registered).json();
    assert.equal(imported.id,folderSource.slug+'@1.0.0');

    await page.getByRole('button',{name:'装配 Bot'}).click();
    await page.getByLabel('Bot 名称').fill('修表摊素材核对');
    await page.getByLabel('稳定 ID').fill('clock-role-ui');
    await page.getByRole('combobox',{name:/^Harness/}).selectOption('dsh-web');
    await page.getByLabel('用途说明').fill('把访谈和拍摄记录整理成可逐字核对的简报。');
    await page.getByLabel(/素材简报 · 1.0.0/).uncheck();
    await page.getByLabel(folderSource.name+' · 1.0.0',{exact:true}).check();
    assert.equal(await page.getByLabel(/口播分镜 · 1.0.0/).count(),0);
    await page.getByLabel('样例来源').selectOption('custom');
    await page.getByLabel('样例名称').fill(sample.title);
    const reveal=page.locator('.sample-fields.status-in');
    assert.equal(await reveal.evaluate(el=>getComputedStyle(el).animationDuration),'0.18s');
    await page.getByLabel('样例任务').fill(sample.prompt);
    await page.getByLabel('样例材料').setInputFiles(files.map(file=>({
      name:file.name,mimeType:'text/plain',buffer:Buffer.from(file.content)})));
    await page.getByLabel('指定引用原文（可选）').fill(sample.expectedQuote);
    await page.getByText('修表摊访谈.txt、拍摄记录.md',{exact:true}).waitFor();
    await page.getByLabel('已获授权将这些文字用于模型验证。').check();
    await page.getByLabel('允许在该 Bot 的会话中载入此样例。').check();
    if(shots) {
      await page.getByText('已登记 Skill 版本。',{exact:true}).waitFor({state:'hidden'});
      await page.getByLabel('样例名称').scrollIntoViewIfNeeded();
      await page.screenshot({path:join(shots,'桌面-装配验证样例.png'),animations:'disabled'});
    }
    await page.getByRole('button',{name:'保存候选版本'}).click();
    await page.getByText('已保存候选版本。',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Bot 版本'}).click();
    const card=page.locator('.manage-card').filter({hasText:'修表摊素材核对'});
    const enable=card.getByRole('button',{name:'启用此版'});
    assert.ok(await enable.isDisabled());
    await card.getByRole('button',{name:'验证样例'}).click();
    await card.getByText('样例已通过 · 修表摊开张的素材简报',{exact:true}).waitFor();
    await enable.click();
    await card.getByText('已启用',{exact:true}).waitFor();
    if(shots) await page.screenshot({path:join(shots,'桌面-样例验证通过.png'),animations:'disabled'});

    await page.goto(host.origin+'/#bots/clock-role-ui');
    await page.getByRole('button',{name:'新建会话'}).click();
    await page.getByRole('button',{name:'载入 Bot 演练'}).click();
    await page.locator('.compose-wrap').getByText('修表摊访谈.txt',{exact:true}).waitFor();
    assert.equal(await page.locator('.composer textarea').inputValue(),sample.prompt);
    await page.goto(host.origin+'/#manage');
    await page.getByRole('button',{name:'装配 Bot'}).click();
    for (const width of [1024,768]) {
      await page.setViewportSize({width,height:900});
      const rect=await page.locator('.management-form').boundingBox();
      assert.ok(rect?.x>=0&&rect.x+rect.width<=width);
      await page.getByRole('button',{name:'Skill 与 Harness'}).click();
      await page.getByLabel('Skill 文件夹',{exact:true}).setInputFiles(folder);
      const field=page.locator('.skill-file-picker');
      await field.getByText('references/访谈/读审.md',{exact:true}).waitFor();
      assert.equal(await field.evaluate(el=>el.scrollWidth<=el.clientWidth),true);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),width);
      await page.getByRole('button',{name:'装配 Bot'}).click();
    }
    const mobile=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true,reducedMotion:'reduce'});
    mobile.on('pageerror',error=>errors.push(error.message));
    await mobile.goto(host.origin+'/#manage');
    await mobile.getByRole('button',{name:'装配 Bot'}).click();
    await mobile.getByLabel('样例来源').selectOption('custom');
    assert.equal(await mobile.locator('.sample-fields.status-in').evaluate(el=>getComputedStyle(el).animationName),'none');
    for (const width of [390,320]) {
      await mobile.setViewportSize({width,height:844});
      const inside=await mobile.locator('fieldset.sample-fields').boundingBox();
      assert.ok(inside?.x>=0&&inside.x+inside.width<=width);
      assert.equal(await mobile.evaluate(()=>document.documentElement.scrollWidth),width);
    }
    await mobile.getByRole('button',{name:'Skill 与 Harness'}).click();
    await mobile.getByLabel('Skill 文件夹',{exact:true}).setInputFiles(folder);
    const selectedFiles=mobile.getByRole('list',{name:'待导入文件'});
    await selectedFiles.getByText('references/访谈/读审.md',{exact:true}).waitFor();
    assert.equal(await selectedFiles.evaluate(el=>getComputedStyle(el).animationName),'none');
    for(const width of [320,390]) {
      await mobile.setViewportSize({width,height:844});
      assert.equal(await mobile.evaluate(()=>document.documentElement.scrollWidth),width);
      const button=await mobile.getByRole('button',{name:'选择 Skill 文件夹'}).boundingBox();
      assert.ok(button?.height>=44);
    }
    if(shots) {
      await mobile.getByLabel('Skill 名称').fill(folderSource.name);
      await mobile.getByLabel('Skill ID').fill(folderSource.slug);
      await mobile.getByLabel('使用依据',{exact:true}).fill('已审阅本地访谈核对规则');
      await mobile.getByLabel('适用成果').selectOption('brief');
      await mobile.getByLabel('已审阅文本及使用依据。').check();
      await selectedFiles.scrollIntoViewIfNeeded();
      await mobile.screenshot({path:join(shots,'手机-Skill目录导入.png'),animations:'disabled'});
    }
    assert.deepEqual(errors,[]);
    pass('逐文件导入、键盘选目录、目录内相对路径、超范围文件拒绝和重新确认均通过，五种屏宽可用');
    pass('真实浏览器用目录 Skill 装配、验证、启用并载入演练，减少动效通过');
    return imported.id;
  } finally {
    await browser.close();
  }
}

try {
  host=await open();
  const folderFromUI=await rendererCheck();
  const skill=await api('/skills',skillSource,201);
  await api('/skills',{...skillSource,slug:'clock-brief-legacy',references:[...skillSource.references,
    {name:'references/read-first.md',text:'打开[原有引用](references/guidance.md)。'}]},201);
  const folderId=folderFromUI??(await api('/skills',folderSource,201)).id;
  const folderMeta=(await workspace()).skills.find(row=>row.id===folderId);
  assert.deepEqual([...folderMeta.references.map(item=>item.name)].sort(),folderSource.references.map(item=>item.name).sort());
  assert.ok(folderMeta.references.every(item=>/^[a-f0-9]{64}$/.test(item.digest)));
  const outside={...folderSource.references[0],text:'[未登记资料](../../未登记资料.md)'};
  const rejected=await api('/skills',{...folderSource,slug:'clock-brief-outside',references:[outside,folderSource.references[1]]},422);
  assert.equal(rejected.code,'invalid_skill');
  assert.equal((await workspace()).skills.some(item=>item.id==='clock-brief-outside@1.0.0'),false);
  const declared=(await workspace()).skills.find(record=>record.id===skill.id);
  assert.equal(declared.outputKind,'brief');
  assert.deepEqual(declared.references.map(item=>item.name),['references/guidance.md']);
  assert.match(declared.references[0].digest,/^[a-f0-9]{64}$/);
  const form={id:'clock-candidate',name:'修表摊材料整理',kind:'brief',driver:'dsh-web',
    description:'保存合成修表摊样例的核对结果。',skills:[folderId]};
  assert.equal((await api('/bots',{...form,kind:'script'},422)).code,'skill_scope');
  assert.equal((await api('/bots',{...form,driver:'desk-random'},422)).code,'validation');
  await api('/bots',{...form,fixture:{...sample,authorized:false}},422);
  assert.equal((await api('/bots',{...form,fixture:{...sample,expectedQuote:'未出现在样例中的句子'}},422)).code,'sample_reference');
  pass('Skill 按成果类型装配并保留引用文件指纹，越界组合和不属于样例的原句被拒绝');

  const bad=await api('/bots',{...form,fixture:{...sample,expectedQuote:unused}},201);
  const listed=(await workspace()).bots.find(row=>row.id===bad.id);
  assert.equal(listed.verificationFixture.title,sample.title);
  assert.equal(listed.verificationFixture.fileCount,2);
  assert.equal(listed.exampleTitle,sample.title);
  assert.equal('fixture' in listed,false);
  assert.ok(!JSON.stringify(listed).includes(unused));
  await api(route(bad,'publish'),{},409);
  const badSample=await verify(bad);
  assert.equal(badSample.ok,false);
  assert.equal(badSample.code,'sample_reference');
  assert.ok(badSample.usage?.requests===1);
  await api(route(bad,'publish'),{},409);
  await assert.rejects(access(join(data,'runtime',badSample.runId)),{code:'ENOENT'});
  pass('结构和普通引用虽通过，遗漏指定原句仍留候选状态，失败用量与原因保留');

  const good=await api('/bots',{...form,fixture:sample},201);
  assert.equal(good.revision,bad.revision+1);
  const user=(await api('/rooms',{botId:'brief',revision:1,title:'并发检查',example:true})).id;
  const attachments=(await room(user)).draft.attachments;
  const live=await start(user,'慢速取消。整理已授权材料。',attachments);
  assert.equal((await api(route(good,'verify'),{},409)).code,'busy');
  await api('/runs/'+live.id+'/stop',{});
  await state(user,live.id,'cancelled');
  const pending=verify(good);
  await until(async()=>host.app.registry.testing,value=>!!value,'sample validating');
  assert.equal((await api('/rooms/'+user+'/runs',{text:'同一时刻另发',attachments,clientRequestId:randomUUID(),authorized:true},409)).code,'busy');
  await api(route(good,'publish'),{},409);
  const first=await pending;
  assert.equal(first.ok,true);
  assert.match(first.assemblyDigest,/^[a-f0-9]{64}$/);
  assert.equal(first.model,'deepseek-v4-flash');
  pass('会话执行与维护验证互斥，验证中的候选版本不能启用');

  await host.close(); host=await open('deepseek-v4-pro');
  const waiting=(await workspace()).bots.find(row=>row.id===good.id&&row.revision===good.revision);
  assert.equal(waiting.sample.ok,true);
  assert.equal(waiting.sampleReady,false);
  await api(route(good,'publish'),{},409);
  const rechecked=await verify(good);
  assert.equal(rechecked.ok,true);
  assert.equal(rechecked.model,'deepseek-v4-pro');
  assert.equal(first.assemblyDigest,rechecked.assemblyDigest);
  assert.equal((await enabled(good)).status,'enabled');
  const using=(await api('/rooms',{botId:good.id,revision:good.revision,title:sample.title,example:true})).id;
  const stateOf=await room(using);
  assert.equal(stateOf.draft.text,sample.prompt);
  assert.deepEqual(stateOf.materials.map(file=>file.name),files.map(file=>file.name));
  const run=await start(using,stateOf.draft.text,stateOf.draft.attachments);
  const finished=await state(using,run.id,'succeeded');
  const previousArtifact=finished.artifacts[0].id;
  assert.ok(previousArtifact);
  await api(route(good,'disable'),{});
  assert.equal((await room(using)).artifacts[0].id,previousArtifact);
  await api(route(good,'restore'),{});
  pass('候选回执绑定组合和验证模型，复核启用后可在会话载入明确共享的样例，停用后历史可读');

  const other=await api('/bots',{...form,id:'clock-hermes-test',driver:'hermes',
    fixture:{...sample,useInChat:false}},201);
  const beforeHermes=folderReads;
  assert.ok(beforeHermes>0);
  const second=await verify(other);
  assert.equal(second.ok,true);
  assert.equal(folderReads,beforeHermes+1);
  assert.notEqual(second.assemblyDigest,rechecked.assemblyDigest);
  assert.equal((await enabled(other)).exampleTitle,null);
  const privateTask=await api('/rooms',{botId:other.id,revision:other.revision,title:sample.title,example:true},422);
  assert.equal(privateTask.code,'sample_scope');
  pass('同一目录 Skill 的原路径和全文通过 DSH Web Host 与 Hermes ACP 验证，私有样例保留在维护中心');

  const projects=await api('/projects');
  const script=await api('/bots',{...form,id:'clock-script-test',kind:'script',driver:'dsh-web',
    skills:['talking-script'],fixture:{...sample,title:'修表摊口播验证'}},201);
  const scripted=await verify(script);
  assert.equal(scripted.ok,true);
  assert.equal(scripted.workbenchRevision,host.config.workbench.revision);
  await assert.rejects(access(join(data,'runtime',scripted.runId)),{code:'ENOENT'});
  assert.deepEqual(await api('/projects'),projects);
  pass('口播分镜候选用自备样例验引用，在隔离工作台保存并回读，同时保留原项目列表');

  let rollback=null;
  const previousRoot=process.env.HYPER_BOT_TEST_PREVIOUS_APP_ROOT;
  if(previousRoot) {
    const previousApp=resolve(previousRoot);
    const previous=await import(pathToFileURL(join(previousApp,'server','http.mjs')));
    await host.close();
    host=await previous.launch({options:{...options,model:'deepseek-v4-pro'}});
    const restored=(await workspace()).skills.find(item=>item.id===folderId);
    assert.deepEqual(restored.references,folderMeta.references);
    assert.equal((await room(using)).artifacts[0].id,previousArtifact);
    const {version}=JSON.parse(await readFile(join(previousApp,'package.json'),'utf8'));
    rollback={version,readableReferences:restored.references.length,artifact:previousArtifact};
    pass('回滚后，目录 Skill 的引用路径及已保存成果可读');
  }
  const report={mode:'实际 DSH Web Host / Hermes ACP，模型协议夹具',checks,
    folder:{id:folderId,references:folderMeta.references,modelObservations:folderReads},rollback,
    bots:{webHost:{id:good.id,revision:good.revision,artifact:previousArtifact,qualification:rechecked},
      hermes:{id:other.id,revision:other.revision,qualification:second}},providerCalls:model.calls.length};
  if(process.env.HYPER_BOT_TEST_REPORT) await writeFile(process.env.HYPER_BOT_TEST_REPORT,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
} finally {
  await host?.close();
  await model.close();
}


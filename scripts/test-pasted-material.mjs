import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { modelFixture } from '../test/model-fixture.mjs';

const root=resolve(process.env.HYPER_BOT_TEST_APP_ROOT??fileURLToPath(new URL('../',import.meta.url)));
const {launch}=await import(pathToFileURL(join(root,'server','http.mjs')));
const {chromium}=createRequire(import.meta.url)(process.env.HYPER_BOT_TEST_PLAYWRIGHT??'playwright');
const data=await mkdtemp(join(tmpdir(),'hb-pasted-material-'));
const quote='我每天先把门口那排书摆好，再开灯。';
const content='【合成测试原文】\n'+quote+'\n开灯后留两秒翻书声。';
const message='用受访者的话开场，整理一条约 45 秒的口播分镜。';
const filename='开店采访.txt';
const shots=process.env.HYPER_BOT_TEST_SCREENSHOTS;
const readouts=[];
const evidence=[];
const model=await modelFixture({observe:prompt=>evidence.push(prompt.sources.map(({id,name,content})=>({id,name,content})))});
let host,browser;

async function read(route,status=200) {
  const response=await fetch(host.origin+'/api'+route,{signal:AbortSignal.timeout(10000)});
  const payload=await response.json();
  assert.equal(response.status,status,JSON.stringify(payload));
  return payload;
}

async function until(load,accept) {
  const timeout=AbortSignal.timeout(60000);
  for (;;) {
    const record=await load();
    if(accept(record))return record;
    await delay(110,null,{signal:timeout});
  }
}

const entry=page=>page.getByRole('button',{name:'粘贴文字',exact:true});
const dialog=page=>page.getByRole('dialog',{name:'粘贴文字材料'});
const raw=modal=>modal.getByRole('textbox',{name:'原文',exact:true});
const materialName=modal=>modal.getByRole('textbox',{name:'材料名称',exact:true});
const add=modal=>modal.getByRole('button',{name:'授权并添加',exact:true});
const messageBox=page=>page.getByRole('textbox',{name:'给自媒体口播发消息',exact:true});
const waitFocus=async (page,locator)=>{
  const target=await locator.elementHandle();
  try {await page.waitForFunction(el=>document.activeElement===el,target,{timeout:3500});}
  finally {await target.dispose();}
};

async function createRoom(page,bot,title) {
  await page.goto(host.origin+'/#bots');
  await page.locator('.directory-card').filter({has:page.getByRole('heading',{name:bot,exact:true})})
    .getByRole('button',{name:'新建会话',exact:true}).click();
  await page.getByRole('textbox',{name:'会话标题'}).fill(title);
  await page.getByRole('button',{name:'开始会话',exact:true}).click();
  await page.waitForURL(/#chat\/[-a-f0-9]+$/);
  const route='/rooms/'+page.url().split('#chat/')[1];
  return ()=>read(route);
}

async function capture(page,file) {
  if(!shots)return;
  await mkdir(shots,{recursive:true});
  await page.screenshot({path:join(shots,file+'.png'),animations:'disabled'});
}

try {
  host=await launch({options:{data,upstream:model.origin,providerKey:'fixture'}});
  browser=await chromium.launch({executablePath:process.env.HYPER_BOT_TEST_CHROMIUM||undefined});
  const issues=[];
  const desk=await browser.newPage({viewport:{width:1440,height:900}});
  desk.on('pageerror',error=>issues.push(error.message));
  const room=await createRoom(desk,'自媒体口播','开店采访分镜');
  await messageBox(desk).fill(message);

  const chooser=desk.waitForEvent('filechooser');
  await desk.getByRole('button',{name:'材料',exact:true}).click();
  assert.ok((await chooser).isMultiple());

  const stage=dialog(desk);
  await entry(desk).press('Enter');
  await waitFocus(desk,raw(stage));
  assert.ok(await add(stage).isDisabled());
  await raw(stage).fill(content);
  await desk.keyboard.press('Escape');
  await stage.waitFor({state:'hidden'});
  await waitFocus(desk,entry(desk));
  assert.equal((await room()).materials.length,0);
  assert.equal(await messageBox(desk).inputValue(),message);

  await entry(desk).click();
  await materialName(stage).fill('采访/原文');
  await raw(stage).fill(content);
  await add(stage).click();
  await stage.getByRole('alert').filter({hasText:'不能包含路径符号'}).waitFor();
  await materialName(stage).fill('开店采访');
  await raw(stage).fill('测'.repeat(22000));
  await add(stage).click();
  await stage.getByRole('alert').filter({hasText:'每份最多 64 KB'}).waitFor();
  assert.equal((await room()).materials.length,0);
  await raw(stage).fill(content);

  let firstReceipt;
  await desk.route(/\/api\/rooms\/[^/]+\/materials$/,async route=>{
    const response=await route.fetch();
    firstReceipt={status:response.status(),...(await response.json())};
    await route.abort('failed');
  },{times:1});
  await add(stage).click();
  await stage.getByRole('alert').filter({hasText:'暂未确认材料是否已保存'}).waitFor();
  assert.equal(firstReceipt.status,201);
  assert.equal(await raw(stage).inputValue(),content);
  await add(stage).click();
  await stage.waitFor({state:'hidden'});
  await waitFocus(desk,entry(desk));
  const added=await until(room,state=>state.draft.attachments.includes(firstReceipt.id));
  assert.deepEqual(added.materials.map(file=>[file.id,file.name]),[[firstReceipt.id,filename]]);
  assert.equal(added.draft.text,message);
  await desk.locator('.composer-files').getByRole('button',{name:filename,exact:true}).waitFor();
  await capture(desk,'桌面-已添加粘贴材料');
  console.log('OK 目录建会话后可粘贴纯文字，取消和校验失败保留消息草稿，丢失回执后重试复用同一授权材料');

  for(const [width,height] of [[1440,900],[1024,900],[768,900],[390,844],[320,780]]) {
    const phone=width<=390,reduced=width===320;
    const page=await browser.newPage({viewport:{width,height},isMobile:phone,hasTouch:phone,
      reducedMotion:reduced?'reduce':'no-preference'});
    page.on('pageerror',error=>issues.push(error.message));
    await page.goto(desk.url());
    await page.locator('.composer-files').getByRole('button',{name:filename,exact:true}).waitFor();
    const button=await entry(page).boundingBox();
    const composer=await page.locator('.composer').boundingBox();
    const send=await page.getByRole('button',{name:'发送消息',exact:true}).boundingBox();
    assert.ok(button.x>=composer.x&&button.x+button.width<=composer.x+composer.width);
    if(phone)assert.ok(button.height>=44);
    assert.ok(await page.locator('.compose-start').evaluate((el,sendX)=>el.getBoundingClientRect().right<=sendX,send.x));
    await entry(page).press('Enter');
    const modal=dialog(page);
    await waitFocus(page,raw(modal));
    const motion=await modal.evaluate(el=>({animation:getComputedStyle(el).animationName,duration:getComputedStyle(el).animationDuration}));
    assert.equal(motion.animation,reduced?'none':'sheet-in');
    if(!reduced)assert.equal(motion.duration,'0.24s');
    const frame=await modal.boundingBox();
    assert.ok(frame.x>=0&&frame.x+frame.width<=width&&frame.y>=0&&frame.y+frame.height<=height);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),width);
    if(width===1440||width===390) {
      await materialName(modal).fill('开店采访');
      await raw(modal).fill(content);
      await capture(page,(phone?'手机':'桌面')+'-粘贴文字');
    }
    await page.keyboard.press('Escape');
    if(!reduced) {
      const leaving=modal.locator('xpath=self::*[contains(@class," closing")]');
      await leaving.waitFor({timeout:1000});
      assert.equal(await modal.evaluate(el=>getComputedStyle(el).animationDuration),'0.12s');
    }
    await modal.waitFor({state:'hidden'});
    await waitFocus(page,entry(page));
    await page.close();
    readouts.push({width,openAnimationMs:reduced?0:240,closeAnimationMs:reduced?0:120,focusReturned:true});
  }

  await desk.getByRole('button',{name:'发送消息',exact:true}).click();
  await desk.getByRole('button',{name:'允许本次写入',exact:true}).click();
  const saved=await until(room,state=>state.runs[0]?.state==='succeeded');
  assert.deepEqual(saved.runs[0].materialIds,[firstReceipt.id]);
  assert.equal(saved.artifacts[0].receipt.project,saved.project);
  assert.deepEqual(evidence,[[{id:firstReceipt.id,name:filename,content}]]);
  assert.equal(model.calls.length,1);
  await desk.locator('.result-link').click();
  await desk.locator('.shot-detail').getByRole('button',{name:filename}).click();
  const mark=desk.locator('#right-preview mark');
  await mark.waitFor();
  assert.equal(await mark.textContent(),quote);
  await capture(desk,'桌面-粘贴文字引用');
  await desk.getByRole('button',{name:'管理授权',exact:true}).click();
  await desk.getByRole('button',{name:'撤回授权…'}).click();
  await desk.getByRole('button',{name:'确认撤回',exact:true}).click();
  await desk.getByRole('heading',{name:'授权已撤回',exact:true}).waitFor();
  const ended=await room();
  assert.ok(ended.materials[0].endedAt&&ended.artifacts[0].endedAt);
  console.log('OK 单份粘贴原文生成口播，模型收到授权原文，工作台回读、引用定位及撤回通过');

  const brief=await createRoom(desk,'素材简报','开店材料简报');
  const picked=desk.waitForEvent('filechooser');
  await desk.getByRole('button',{name:'材料',exact:true}).click();
  await (await picked).setFiles({name:'拍摄补记.md',mimeType:'text/markdown',buffer:Buffer.from('拍到台阶和刚亮起的书架。')});
  await until(brief,state=>state.draft.attachments.length===1);
  await entry(desk).click();
  await materialName(stage).fill('现场补记.md');
  await raw(stage).fill('门口经过两位顾客。\n店内保留十秒环境声。');
  await add(stage).click();
  await stage.waitFor({state:'hidden'});
  const mixed=await until(brief,state=>state.draft.attachments.length===2);
  assert.deepEqual(mixed.materials.map(file=>file.name),['拍摄补记.md','现场补记.md']);
  await desk.getByRole('textbox',{name:'给素材简报发消息',exact:true}).fill('综合两份材料，整理已知事项。');
  await desk.getByRole('button',{name:'发送消息',exact:true}).click();
  const summary=await until(brief,state=>state.runs[0]?.state==='succeeded');
  assert.equal(summary.runs[0].driver,'hermes');
  assert.equal(summary.artifacts[0].kind,'brief');
  assert.deepEqual(evidence[1].map(file=>file.id),mixed.draft.attachments);
  assert.equal(model.calls.length,2);
  assert.deepEqual(issues,[]);
  console.log('OK 素材简报可混用粘贴内容与 Markdown 文件，Hermes 收到按本轮选择的两份原文');
  const report={checks:{filePicker:true,cancelPreservedDraft:true,invalidNotStored:true,lostReceiptDeduplicated:true,
    savedWorkbench:true,quoteLocated:true,revoked:true,mixedHermesBrief:true},viewports:readouts,providerRequests:model.calls.length,paidRequests:0};
  if(process.env.HYPER_BOT_TEST_REPORT) await writeFile(process.env.HYPER_BOT_TEST_REPORT,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report));
} finally {
  await browser?.close();
  await host?.close();
  await model.close();
}

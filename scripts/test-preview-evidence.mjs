import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { modelFixture } from '../test/model-fixture.mjs';

const root=resolve(process.env.HYPER_BOT_TEST_APP_ROOT??fileURLToPath(new URL('../',import.meta.url)));
const {launch}=await import(pathToFileURL(join(root,'server','http.mjs')));
const {chromium}=createRequire(import.meta.url)(process.env.HYPER_BOT_TEST_PLAYWRIGHT??'playwright');
const observe=process.argv.includes('--observe');
const output=process.env.HYPER_BOT_TEST_SCREENSHOTS;
const roomTitle='街角书店开门前';
const fileName='店主采访长稿.txt';
const openingQuote='我每天先把门口那排书摆好，再开灯。';
const lightQuote='书架从暗处亮起来，客人才看得清书脊上的字。';
const chapter=Array.from({length:52},(_,i)=>'店门观察 '+(i+1)+'　记录开门前经过人行道的脚步声。');
const longText=[...chapter,openingQuote,'问：开灯的时候，书店看起来有什么不一样？',lightQuote,
  '店主把开关拨到上面，书脊一格一格亮起来。','录音结束前，店主把今天的第一本书递给顾客。'].join('\n');
const model=await modelFixture({respond:({sources,text})=>{
  const long=sources.find(source=>source.content.includes(lightQuote));
  const revision=text.includes('试写夜景')?' · 试写夜景':text.includes('补拍灯亮')?' · 补拍灯亮':'';
  const shots=[
    ['开门与摆书','门开后，把最靠外的那排书摆整齐。','手拿钥匙开门，切到门边的书架。',openingQuote],
    ['路口原声','有人从门前经过，书店还没有开灯。','留两秒原声，拍台阶与人行道。'],
    ['书架亮起来'+revision,'书摆好了才开灯，客人这才看得清书脊。','跟拍手指拨开关，接书架逐渐亮起。',lightQuote]
  ];
  return {title:'书店开门前的 45 秒'+revision,segments:shots.map(([name,spoken,visual,quote],i)=>({
    name,spoken,visual,subtitle:spoken,start:15*i,end:15*(i+1),evidence:quote?[{material:long.id,quote}]:[]
  })),notes:[]};
}});
const data=await mkdtemp(join(tmpdir(),'hb-preview-evidence-'));
let host,browser;
const reports=[];

async function api(path,body) {
  const method=body===undefined?{}:{method:'POST',headers:{'X-Hyper-Bot':'1','Content-Type':'application/json'},body:JSON.stringify(body)};
  const response=await fetch(host.origin+'/api'+path,{...method,signal:AbortSignal.timeout(15000)});
  const result=await response.json();
  assert.ok(response.ok,JSON.stringify(result));
  return result;
}

async function waitFor(id,runId,state) {
  const limit=AbortSignal.timeout(55000);
  for(;;) {
    const room=await api('/rooms/'+id);
    const run=room.runs.find(item=>item.id===runId);
    if(run?.state===state)return {room,run};
    if(['failed','cancelled','interrupted','succeeded'].includes(run?.state))throw new Error(run.state+' '+run.error);
    await delay(170,null,{signal:limit});
  }
}

async function prepare(id,materialIds,text,base) {
  const start=await api('/rooms/'+id+'/runs',{text,base,attachments:materialIds,clientRequestId:randomUUID(),authorized:true});
  return (await waitFor(id,start.id,'waiting_approval')).run;
}

async function decide(run,allow) {
  await api('/runs/'+run.id+'/decide',{id:run.approval.id,digest:run.approval.digest,allow});
  return waitFor(run.conversation,run.id,allow?'succeeded':'cancelled');
}

const focused=locator=>locator.evaluate(el=>el===document.activeElement);
const settleFrame=page=>page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));
async function inPanel(locator) {
  return locator.evaluate(el=>{
    const panel=el.closest('[role="tabpanel"]');
    const rect=el.getClientRects()[0];
    const pane=panel.getBoundingClientRect();
    return {visible:rect.top>=pane.top+2&&rect.bottom<=pane.bottom-2,top:Math.round(panel.scrollTop)};
  });
}
async function focusOn(page,locator) {
  const target=await locator.elementHandle();
  try {await page.waitForFunction(el=>document.activeElement===el,target,{timeout:3000});}
  catch(error) {
    const active=await page.evaluate(()=>document.activeElement?.outerHTML.slice(0,220));
    throw new Error(page.viewportSize().width+'px '+locator.toString()+' 未恢复焦点。实际 '+active,{cause:error});
  } finally {await target.dispose();}
}
const readings=page=>page.evaluate(()=>({document:document.scrollingElement.scrollTop,chat:document.getElementById('message-feed').scrollTop}));
const tab=(page,kind)=>page.locator('#tab-'+kind);
const close=page=>page.getByRole('button',{name:'关闭预览',exact:true});
const toggle=page=>page.getByRole('button',{name:'预览',exact:true});

async function capture(page,name) {
  if(!output)return;
  await mkdir(output,{recursive:true});
  await page.screenshot({path:join(output,name+'.png'),animations:'disabled'});
}

try {
  host=await launch({options:{data,upstream:model.origin,providerKey:'fixture'}});
  const {id}=await api('/rooms',{botId:'media',revision:1,title:roomTitle,example:true});
  const {id:longId}=await api('/rooms/'+id+'/materials',{name:fileName,content:longText,authorized:true});
  const {draft}=await api('/rooms/'+id);
  const ids=[...draft.attachments,longId];
  const first=await prepare(id,ids,'用采访材料整理书店开门的分镜。',null);
  const v1=(await decide(first,true)).room.artifacts[0];
  const second=await prepare(id,ids,'保留原文，补拍灯亮。',v1.id);
  const v2=(await decide(second,true)).room.artifacts.at(-1);
  assert.deepEqual([v1.version,v2.version],[1,2]);

  browser=await chromium.launch({executablePath:process.env.HYPER_BOT_TEST_CHROMIUM||undefined});
  const viewports=observe?[[1440,900],[390,844]]:[[1440,900],[1024,900],[768,900],[390,844],[320,780]];
  for(const [width,height] of viewports) {
    const small=width<=760, reduced=width===320;
    const page=await browser.newPage({viewport:{width,height},reducedMotion:reduced?'reduce':'no-preference'});
    const errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(host.origin+'/#chat/'+id);
    await page.getByRole('heading',{name:roomTitle,exact:true}).waitFor();
    const preview=page.locator('#right-preview');
    if(!small)await close(page).click();
    await preview.waitFor({state:'hidden'});
    await toggle(page).press('Enter');
    await preview.waitFor();
    await settleFrame(page);
    const headerFocus=await focused(tab(page,'script'));
    if(!observe)assert.ok(headerFocus,'预览打开后应聚焦所选标签');
    await close(page).click();
    await preview.waitFor({state:'hidden'});
    if(!observe)await focusOn(page,toggle(page));

    const opener=page.locator('#task-'+first.id+' .result-link');
    await opener.press('Enter');
    const third=preview.getByRole('button',{name:/书架亮起来$/});
    await third.press('Enter');
    const citation=preview.locator('.shot-detail').getByRole('button',{name:fileName});
    const before=await readings(page);
    await citation.press('Enter');
    const mark=preview.locator('mark');
    await mark.waitFor();
    assert.equal(await mark.textContent(),lightQuote);
    await settleFrame(page);
    const jump=await inPanel(mark);
    const returnButton=preview.getByRole('button',{name:'返回第 3 镜',exact:true});
    if(observe) {
      await close(page).click();
      await preview.waitFor({state:'hidden'});
      await settleFrame(page);
      reports.push({width,headerFocus,markInFrame:jump.visible,previewScroll:jump.top,
        openerFocus:await focused(opener)});
      assert.deepEqual(errors,[]);
      await page.close();
      continue;
    }
    assert.ok(jump.visible&&jump.top>800,'引用应定位到长材料后段 '+JSON.stringify(jump));
    await focusOn(page,mark);
    assert.deepEqual(await readings(page),before,'预览定位应保持会话与根页面滚动位置');
    assert.equal(await tab(page,'materials').getAttribute('aria-selected'),'true');
    await preview.evaluate(el=>Promise.allSettled(el.getAnimations().map(animation=>animation.finished)));
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),width);
    assert.ok(await preview.evaluate(el=>el.getBoundingClientRect().right<=innerWidth+.5),width+'px 预览超出可用宽度');
    if(reduced) {
      assert.equal(await preview.evaluate(el=>getComputedStyle(el).animationName),'none');
      assert.equal(await preview.locator('.tab-in').evaluate(el=>getComputedStyle(el).animationName),'none');
    }
    if(width===1440||width===390)await capture(page,(small?'手机':'桌面')+'-定位引用原文');

    await returnButton.press('Enter');
    await focusOn(page,third);
    assert.equal(await third.getAttribute('aria-expanded'),'true');
    assert.equal(await preview.locator('.version').textContent(),'v1');
    assert.ok((await inPanel(third)).visible);
    if(width===1440)await capture(page,'桌面-返回引用分镜');

    if(small)await page.keyboard.press('Escape');
    else await close(page).click();
    await preview.waitFor({state:'hidden'});
    await focusOn(page,opener);
    if(width===1440) {
      const chatCitation=page.locator('#task-'+first.id+' blockquote button');
      await chatCitation.press('Enter');
      await focusOn(page,mark);
      assert.equal(await mark.textContent(),openingQuote);
      await preview.getByRole('tabpanel').evaluate(el=>{el.scrollTop=0;});
      await chatCitation.press('Enter');
      await focusOn(page,mark);
      assert.ok((await inPanel(mark)).visible,'同一引用再次打开仍会回到原文');
      await preview.getByRole('button',{name:'返回第 1 镜'}).press('Enter');
      await focusOn(page,preview.getByRole('button',{name:/开门与摆书/}));
      await tab(page,'materials').click();
      assert.equal(await returnButton.count(),0,'手动切材料标签应从普通预览开始');
      await preview.locator('.side-row').getByRole('button',{name:new RegExp(fileName)}).click();
      assert.equal(await mark.count(),0,'手动选文件应清除引用高亮');
      await tab(page,'materials').press('ArrowRight');
      assert.equal(await tab(page,'versions').getAttribute('aria-selected'),'true');
      await focusOn(page,tab(page,'versions'));
    }
    assert.deepEqual(errors,[]);
    reports.push({width,height,reducedMotion:reduced,version:v1.version,shot:3,previewScroll:jump.top,openerRestored:true});
    await page.close();
  }
  if(!observe) {
    const third=await prepare(id,ids,'先试写夜景，等我决定是否保留。',v2.id);
    const page=await browser.newPage({viewport:{width:390,height:844}});
    await page.goto(host.origin+'/#chat/'+id);
    await page.locator('#task-'+third.id+' .approval-preview').press('Enter');
    const shot=page.locator('#right-preview').getByRole('button',{name:/书架亮起来 · 试写夜景/});
    if(await shot.getAttribute('aria-expanded')!=='true')await shot.press('Enter');
    const evidence=page.locator('.shot-detail').getByRole('button',{name:fileName});
    await evidence.press('Enter');
    const back=page.getByRole('button',{name:'返回第 3 镜'});
    await back.press('Enter');
    await focusOn(page,shot);
    assert.match(await page.locator('#right-preview .version').textContent(),/^待确认 · v3$/);
    await evidence.press('Enter');
    const cancelled=await decide(third,false);
    assert.equal(cancelled.room.artifacts.length,2);
    await back.waitFor({state:'hidden'});
    reports.push({proposalVersion:3,cancelled:true,expiredReturnHidden:true});
    await page.close();
  }
  console.log(JSON.stringify({mode:observe?'observation':'regression',reports},null,2));
} finally {
  await browser?.close();
  await host?.close();
  await model.close();
}


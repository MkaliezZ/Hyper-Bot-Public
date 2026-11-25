import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { modelFixture } from '../test/model-fixture.mjs';

const root=resolve(process.env.HYPER_BOT_TEST_APP_ROOT??fileURLToPath(new URL('../',import.meta.url)));
const {launch}=await import(pathToFileURL(join(root,'server/http.mjs')));
const {chromium}=createRequire(import.meta.url)(process.env.HYPER_BOT_TEST_PLAYWRIGHT??'playwright');
const fixture=await modelFixture();
const options={data:await mkdtemp(join(tmpdir(),'hb-draft-continuity-')),upstream:fixture.origin,providerKey:'test-only'};
const checks=[],errors=[];
const pass=message=>{checks.push(message);console.log('OK '+message);};
let host,browser,releasePending;

async function api(route,body,status) {
  const options=body===undefined?{}:{method:'POST',headers:{'X-Hyper-Bot':'1','Content-Type':'application/json'},body:JSON.stringify(body)};
  const response=await fetch(host.origin+'/api'+route,{...options,signal:AbortSignal.timeout(10000)});
  const result=await response.json();
  if(status)assert.equal(response.status,status,JSON.stringify(result));
  else assert.ok(response.ok,JSON.stringify(result));
  return result;
}

const room=id=>api('/rooms/'+id);
const open=async(botId,title)=>(await api('/rooms',{botId,title,revision:1,example:true},201)).id;
const approve=(run,allow)=>api('/runs/'+run.id+'/decide',{id:run.approval.id,digest:run.approval.digest,allow},202);
async function until(check,timeout=17000) {
  const deadline=AbortSignal.timeout(timeout);
  for(;;) {
    const value=await check();
    if(value)return value;
    await delay(95,null,{signal:deadline});
  }
}
const awaitingRemote=promise=>Promise.race([promise,delay(15000,null,{ref:false}).then(()=>{throw new Error('未等到预期的浏览器请求。');})]);
const runAt=(id,requestId,state)=>until(async()=>(await room(id)).runs.find(row=>row.id===requestId&&row.state===state),55000);
async function capture(page,name) {
  const dir=process.env.HYPER_BOT_TEST_SCREENSHOTS;
  if(!dir)return;
  await mkdir(dir,{recursive:true});
  await page.screenshot({path:join(dir,name+'.png'),animations:'disabled'});
}

try {
  host=await launch({options});
  const script=await open('media','书店续稿会话'), brief=await open('brief','书店简报会话');
  const scriptPath='/rooms/'+script;
  const initial=(await room(script)).draft;
  const first=await api(scriptPath+'/runs',{...initial,clientRequestId:randomUUID(),authorized:true},202);
  await approve(await runAt(script,first.id,'waiting_approval'),true);
  await runAt(script,first.id,'succeeded');
  const v1=(await room(script)).artifacts[0];
  const briefDraft=(await room(brief)).draft;
  browser=await chromium.launch({executablePath:process.env.HYPER_BOT_TEST_CHROMIUM||undefined});
  const page=await browser.newPage({viewport:{width:1440,height:900}});
  page.on('pageerror',error=>errors.push(error.message));
  const composer=page.locator('#message');
  async function revise() {
    await page.getByRole('tab',{name:/版本/}).click();
    await page.getByRole('button',{name:'继续改稿',exact:true}).click();
  }
  const waitForRoom=name=>page.getByRole('heading',{name,exact:true}).waitFor();
  async function go(id,name) {
    await page.evaluate(value=>{location.hash='chat/'+value;},id);
    await waitForRoom(name);
  }
  await page.goto(host.origin+'/#chat/'+script);
  await waitForRoom('书店续稿会话');
  const draftPattern='**/api'+scriptPath+'/draft';
  const firstEdit='改稿中，保留这段尚未写完的文字。';
  const latestEdit='回到原会话，在这段文字后补上最后一句。';
  const firstSave=Promise.withResolvers(), holdSave=Promise.withResolvers();
  releasePending=holdSave.resolve;
  await page.route(draftPattern,async operation=>{
    if(operation.request().postDataJSON().text===firstEdit) {
      firstSave.resolve();
      await holdSave.promise;
    }
    await operation.continue();
  });
  await revise();
  await composer.fill(firstEdit);
  await go(brief,'书店简报会话');
  await awaitingRemote(firstSave.promise);
  assert.equal(await composer.inputValue(),briefDraft.text);
  await go(script,'书店续稿会话');
  assert.equal(await composer.inputValue(),firstEdit);
  await page.getByText('继续修改 v1',{exact:true}).waitFor();
  assert.equal(await page.locator('.composer-files > span').count(),v1.materialIds.length);
  await composer.fill(latestEdit);
  holdSave.resolve();
  const saved=await until(async()=>{
    const draft=(await room(script)).draft;
    return draft.text===latestEdit&&draft;
  });
  assert.equal(saved.base,v1.id);
  assert.deepEqual(saved.attachments,v1.materialIds);
  await page.unroute(draftPattern);
  pass('保存请求延迟时跨 Bot 切换，返回看到文字、已选材料和 v1 续改来源，最后一处编辑按顺序保存');

  async function competingEdit(local,remote) {
    const entered=Promise.withResolvers(), hold=Promise.withResolvers();
    releasePending=hold.resolve;
    await page.route(draftPattern,async operation=>{
      if(operation.request().postDataJSON().text===local){entered.resolve();await hold.promise;}
      await operation.continue();
    });
    await composer.fill(local);
    await awaitingRemote(entered.promise);
    const latest=await room(script);
    await api(scriptPath+'/draft',{...latest.draft,text:remote,draftToken:latest.draftToken});
    const stale=await api(scriptPath+'/runs',{...latest.draft,text:local,draftToken:latest.draftToken,
      clientRequestId:randomUUID(),authorized:true},409);
    assert.equal(stale.code,'draft_conflict');
    hold.resolve();
    await page.getByText('此会话有新的已保存草稿。',{exact:true}).waitFor();
    assert.equal(await composer.inputValue(),local);
    assert.equal((await room(script)).draft.text,remote);
    assert.equal(await page.getByRole('button',{name:'发送消息'}).isDisabled(),true);
    return async()=>page.unroute(draftPattern);
  }

  const endFirstConflict=await competingEdit('本窗口正在写的内容。','另一窗口已保存的内容。');
  await capture(page,'桌面-草稿冲突');
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),390);
  await capture(page,'手机-草稿冲突');
  await page.getByRole('button',{name:'采用已保存稿'}).click();
  await page.waitForFunction(()=>document.querySelector('#message').value==='另一窗口已保存的内容。');
  await endFirstConflict();
  const endSecondConflict=await competingEdit('确认保留当前窗口这段。','另一窗口的下一版。');
  await page.getByRole('button',{name:'保存当前稿'}).click();
  await until(async()=>(await room(script)).draft.text==='确认保留当前窗口这段。');
  await endSecondConflict();
  await page.setViewportSize({width:1440,height:900});
  pass('并发修改时保留两边内容供选择，过时保存和发送都被阻止，经用户选择才采用对应稿件');

  let readNewest=false,remoteCommitted=false;
  const priorRead=Promise.withResolvers(),readAfterChange=Promise.withResolvers();
  const earlier=await room(script);
  const roomPattern='**/api'+scriptPath;
  await page.route(roomPattern,async operation=>{
    if(readNewest){await operation.continue();return;}
    await operation.fulfill({json:earlier});
    if(remoteCommitted)readAfterChange.resolve();
    else priorRead.resolve();
  });
  await page.route(draftPattern,operation=>operation.abort('failed'));
  await composer.fill('这段网络失败的本机草稿。');
  const retrySave=page.getByRole('button',{name:'重试保存'});
  await retrySave.waitFor();
  await awaitingRemote(priorRead.promise);
  remoteCommitted=true;
  await api(scriptPath+'/draft',{...earlier.draft,text:'联机后发现的另一份已保存草稿。',draftToken:earlier.draftToken});
  await awaitingRemote(readAfterChange.promise);
  await page.unroute(draftPattern);
  await retrySave.focus();
  readNewest=true;
  await page.keyboard.press('Enter');
  await page.getByText('此会话有新的已保存草稿。',{exact:true}).waitFor();
  assert.equal(await composer.inputValue(),'这段网络失败的本机草稿。');
  assert.equal((await room(script)).draft.text,'联机后发现的另一份已保存草稿。');
  await page.getByRole('button',{name:'采用已保存稿'}).click();
  await page.waitForFunction(()=>document.querySelector('#message').value==='联机后发现的另一份已保存草稿。');
  await page.unroute(roomPattern);
  pass('重试保存发现服务器已存入另一份草稿时，转入冲突选择，保留两边内容');

  let writes=0;
  await page.route(draftPattern,async operation=>{
    writes++;
    assert.equal((await operation.fetch()).status(),200);
    await operation.abort('failed');
  });
  const lost='草稿保存响应丢失后的原文。';
  await composer.fill(lost);
  await until(async()=>(await room(script)).draft.text===lost);
  await page.getByRole('button',{name:'重试保存'}).waitFor({state:'hidden'});
  await page.unroute(draftPattern);
  assert.equal(writes,1);
  pass('草稿已落库但保存响应丢失时，以原会话的已保存内容确认，没有重复写入');

  const runPattern='**/api'+scriptPath+'/runs';
  let serverAccepted,acceptedBody;
  await page.route(runPattern,async operation=>{
    acceptedBody=operation.request().postDataJSON();
    const response=await operation.fetch();
    assert.equal(response.status(),202);
    serverAccepted=await response.json();
    await operation.abort('failed');
  });
  await page.getByRole('button',{name:'发送消息',exact:true}).click();
  await until(()=>serverAccepted);
  const accepted=await runAt(script,serverAccepted.id,'waiting_approval');
  await page.waitForFunction(()=>document.querySelector('#message').value==='');
  assert.equal((await room(script)).runs.filter(row=>row.clientRequestId===accepted.clientRequestId).length,1);
  assert.equal((await room(script)).draft.text,'');
  const afterAccept=await room(script);
  const staleWrite=await api(scriptPath+'/draft',{text:lost,attachments:accepted.materialIds,base:v1.id,
    draftToken:acceptedBody.draftToken},409);
  assert.equal(staleWrite.code,'draft_conflict');
  await api(scriptPath+'/draft',{...afterAccept.draft,text:'受理之后另外写下的草稿。',draftToken:afterAccept.draftToken});
  assert.equal((await api(scriptPath+'/runs',acceptedBody,202)).id,accepted.id);
  assert.equal((await room(script)).draft.text,'受理之后另外写下的草稿。');
  await page.unroute(runPattern);
  await approve(accepted,false);
  await runAt(script,accepted.id,'cancelled');
  pass('发送已受理但响应丢失时，回读确认一次受理，拒绝旧保存，重复受理保留后来编辑');

  const submitted=[];
  await page.route(runPattern,async operation=>{
    submitted.push(operation.request().postDataJSON());
    if(submitted.length===1)await operation.abort('failed');
    else await operation.continue();
  });
  await revise();
  const retry='确认同一条尚未受理的口播消息。';
  await composer.fill(retry);
  await composer.press('Enter');
  const same=page.getByRole('button',{name:'重试同一条消息'});
  await same.waitFor();
  await page.getByText('尚未查到受理回执。重试会使用同一请求编号。',{exact:true}).waitFor();
  assert.equal((await room(script)).runs.length,2);
  assert.equal(await composer.inputValue(),retry);
  await same.click();
  await until(()=>submitted.length===2);
  assert.deepEqual(submitted[0],submitted[1]);
  const retried=await until(async()=>(await room(script)).runs.find(row=>row.clientRequestId===submitted[1].clientRequestId&&row.state==='waiting_approval'),55000);
  await approve(retried,false);
  await runAt(script,retried.id,'cancelled');
  await page.unroute(runPattern);
  pass('连接中断且未查到受理时，只有用户确认才再次发出同一请求编号和原始内容');

  const port=Number(new URL(host.origin).port);
  await host.close();
  host=null;
  await page.getByText('本机服务已断开 · 显示最近确认的状态',{exact:true}).waitFor({timeout:18000});
  const offline='本机服务断线时保留这段文字。';
  await composer.fill(offline);
  await page.evaluate(()=>{location.hash='bots';});
  await page.getByRole('heading',{name:'Bot 目录',exact:true}).waitFor();
  host=await launch({port,options});
  const reconnect=page.getByRole('button',{name:'重连',exact:true});
  if(await reconnect.isVisible())await reconnect.click({timeout:1500}).catch(()=>{});
  await go(script,'书店续稿会话');
  await page.waitForFunction(value=>document.querySelector('#message')?.value===value,offline,{timeout:17000});
  await until(async()=>(await room(script)).draft.text===offline);
  await page.reload();
  await composer.waitFor();
  assert.equal(await composer.inputValue(),offline);
  pass('真实本机服务退出后，窗口暂存断线编辑，重连保存到原会话，刷新可读');

  const guarded=Promise.withResolvers(), holdRevocation=Promise.withResolvers();
  releasePending=holdRevocation.resolve;
  await page.route(draftPattern,async operation=>{
    guarded.resolve();
    await holdRevocation.promise;
    await operation.continue();
  });
  await revise();
  await composer.fill('材料授权已撤回时应清理此草稿。');
  await awaitingRemote(guarded.promise);
  await api(scriptPath+'/materials/'+v1.materialIds[0]+'/revoke',{confirmed:true},202);
  holdRevocation.resolve();
  await page.waitForFunction(value=>document.querySelector('#message').value===value,offline);
  const afterRevoke=(await room(script)).draft;
  assert.equal(afterRevoke.text,offline);
  assert.equal(afterRevoke.base,null);
  assert.equal(afterRevoke.attachments.includes(v1.materialIds[0]),false);
  assert.deepEqual(errors,[]);
  pass('撤回材料时丢弃依赖该材料或旧稿的待保存草稿，迟到请求无法恢复原文');

  const chinese=await open('media','中文输入会话');
  await go(chinese,'中文输入会话');
  const chineseDraft=(await room(chinese)).draft;
  const chineseRuns='/api/rooms/'+chinese+'/runs';
  const submissions=[];
  let sendRequested=false;
  await page.route('**'+chineseRuns,async operation=>{
    if(operation.request().method()!=='POST')return operation.continue();
    submissions.push(operation.request().postDataJSON());
    if(sendRequested)await operation.continue();
    else await operation.abort('failed');
  });
  await composer.fill('目标画面是');
  await composer.evaluate(element=>{
    window.imeConfirmations=[];
    document.addEventListener('keydown',event=>{
      if(event.target===element&&event.key==='Enter'&&event.keyCode===229) {
        window.imeConfirmations.push({trusted:event.isTrusted,isComposing:event.isComposing,
          keyCode:event.keyCode,consumed:event.defaultPrevented});
      }
    });
  });
  const modelBeforeInput=fixture.calls.length;
  const cdp=await page.context().newCDPSession(page);
  try {
    await cdp.send('Input.imeSetComposition',{text:'shudian',selectionStart:7,selectionEnd:7});
    assert.equal(await composer.inputValue(),'目标画面是shudian');
    const compositionEnter=await composer.evaluate(element=>{
      const event=new KeyboardEvent('keydown',{bubbles:true,cancelable:true,key:'Enter',isComposing:true,keyCode:13});
      element.dispatchEvent(event);
      return event.defaultPrevented;
    });
    assert.equal(compositionEnter,false);
    await cdp.send('Input.insertText',{text:'书店'});
    assert.equal(await composer.inputValue(),'目标画面是书店');
    const confirmation={key:'Enter',code:'Enter',windowsVirtualKeyCode:229,nativeVirtualKeyCode:229};
    await cdp.send('Input.dispatchKeyEvent',{type:'rawKeyDown',...confirmation});
    await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',...confirmation});
  } finally {
    await cdp.detach();
  }
  const confirmation=await page.evaluate(()=>window.imeConfirmations);
  assert.deepEqual(confirmation,[{trusted:true,isComposing:false,keyCode:229,consumed:false}]);
  assert.equal(await composer.inputValue(),'目标画面是书店');
  await composer.press('Shift+Enter');
  await page.keyboard.insertText('字幕先保留原句。');
  const pendingText='目标画面是书店\n字幕先保留原句。';
  assert.equal(await composer.inputValue(),pendingText);
  await until(async()=>(await room(chinese)).draft.text===pendingText);
  const beforeSend=await room(chinese);
  assert.equal(beforeSend.runs.length,0);
  assert.equal(submissions.length,0);
  assert.equal(fixture.calls.length,modelBeforeInput);
  assert.deepEqual(beforeSend.draft.attachments,chineseDraft.attachments);

  sendRequested=true;
  const submittedChinese=page.waitForResponse(response=>response.url().endsWith(chineseRuns)&&response.request().method()==='POST');
  await composer.press('Control+Enter');
  const chineseResponse=await submittedChinese;
  assert.equal(chineseResponse.status(),202);
  const chineseRun=await runAt(chinese,(await chineseResponse.json()).id,'waiting_approval');
  assert.equal(submissions.length,1);
  assert.equal(submissions[0].text,pendingText);
  assert.deepEqual(chineseRun.materialIds,chineseDraft.attachments);
  assert.equal(fixture.calls.length-modelBeforeInput,1);
  await approve(chineseRun,false);
  await runAt(chinese,chineseRun.id,'cancelled');
  assert.equal((await room(chinese)).artifacts.length,0);
  assert.deepEqual(errors,[]);
  const ime={confirmation:confirmation[0],draftPreserved:true,multiline:true,unintendedSubmissions:0,intentionalSubmissions:1,
    modelRequestsDuringConfirmation:0,modelRequestsAfterSend:1};
  pass('中文选词的确认回车不触发派活，Shift+Enter 保留多行草稿，Ctrl+Enter 将原文和材料只提交一次');

  const mediaTitle='等待导入的口播会话', otherTitle='独立简报草稿';
  const mediaRoom=await open('media',mediaTitle), otherRoom=await open('brief',otherTitle);
  const mediaPath='/rooms/'+mediaRoom, originalMaterials=(await room(mediaRoom)).draft.attachments;
  const otherBefore=(await room(otherRoom)).draft;
  const fixtureBefore=fixture.calls.length;
  const uploadName='等待返回的采访补充.txt', lostName='回执断开的画面补充.md';
  const contents='【合成材料】收尾用翻页声。';
  const picker=page.locator('.composer input[type=file]');
  const send=page.getByRole('button',{name:'发送消息',exact:true});
  const adding=page.getByRole('status').filter({hasText:'正在添加材料…'});
  const chip=name=>page.locator('.composer-files').getByRole('button',{name,exact:true});
  const attach=name=>picker.setInputFiles({name,mimeType:'text/plain',buffer:Buffer.from(contents)});
  const newPrompt='请用本轮已选材料补全书店口播。';
  const attempts=[];
  let permitSubmission=false;
  await page.route('**/api'+mediaPath+'/runs',async operation=>{
    attempts.push(operation.request().postDataJSON());
    if(permitSubmission)await operation.continue();
    else await operation.abort('failed');
  });
  await go(mediaRoom,mediaTitle);
  await composer.fill(newPrompt);
  await until(async()=>(await room(mediaRoom)).draft.text===newPrompt);
  const reached=Promise.withResolvers(), acknowledge=Promise.withResolvers();
  releasePending=acknowledge.resolve;
  await page.route('**/api'+mediaPath+'/materials',async operation=>{
    reached.resolve();
    await acknowledge.promise;
    await operation.continue();
  },{times:1});
  await attach(uploadName);
  await awaitingRemote(reached.promise);
  await adding.waitFor();
  assert.equal(await send.isDisabled(),true);
  await go(otherRoom,otherTitle);
  assert.equal(await composer.inputValue(),otherBefore.text);
  await attach('只给简报的材料.txt');
  await chip('只给简报的材料.txt').waitFor();
  const otherAfter=await until(async()=>{
    const state=await room(otherRoom);
    return state.draft.attachments.length===otherBefore.attachments.length+1?state:null;
  });
  await go(mediaRoom,mediaTitle);
  await adding.waitFor();
  assert.equal(await composer.inputValue(),newPrompt);
  assert.equal(await send.isDisabled(),true);
  await page.keyboard.press('Control+Enter');
  await page.locator('.composer').dispatchEvent('submit');
  await page.setViewportSize({width:420,height:580});
  assert.equal(await send.isDisabled(),true);
  await capture(page,'窄窗-会话材料等待回执');
  await page.setViewportSize({width:1440,height:900});
  assert.equal((await room(mediaRoom)).runs.length,0);
  assert.equal(attempts.length,0);
  assert.equal(fixture.calls.length,fixtureBefore);
  const rebuilding=Promise.withResolvers(), freshWorkspace=Promise.withResolvers();
  releasePending=()=>{acknowledge.resolve();freshWorkspace.resolve();};
  await page.route('**/api/workspace',async operation=>{
    rebuilding.resolve();
    await freshWorkspace.promise;
    await operation.continue();
  });
  acknowledge.resolve();
  await awaitingRemote(rebuilding.promise);
  await adding.waitFor({state:'hidden'});
  assert.equal(await send.isEnabled(),true);
  freshWorkspace.resolve();
  await page.unroute('**/api/workspace');
  await chip(uploadName).waitFor();

  // The service saves the second material before the browser loses its reply.
  const committed=Promise.withResolvers(), disconnect=Promise.withResolvers();
  releasePending=disconnect.resolve;
  await page.route('**/api'+mediaPath+'/materials',async operation=>{
    const result=await operation.fetch();
    committed.resolve({status:result.status(),...(await result.json())});
    await disconnect.promise;
    await operation.abort('failed');
  },{times:1});
  await attach(lostName);
  const lostMaterial=await awaitingRemote(committed.promise);
  assert.equal(lostMaterial.status,201);
  await go(otherRoom,otherTitle);
  disconnect.resolve();
  await go(mediaRoom,mediaTitle);
  await page.getByRole('alert').filter({hasText:'暂未确认材料是否已保存'}).filter({hasText:lostName}).waitFor();
  assert.equal(await composer.inputValue(),newPrompt);
  assert.equal(await chip(lostName).count(),0);
  assert.equal((await room(mediaRoom)).draft.attachments.includes(lostMaterial.id),false);
  await attach(lostName);
  await chip(lostName).waitFor();
  await adding.waitFor({state:'hidden'});
  const prepared=await until(async()=>{
    const state=await room(mediaRoom);
    return state.draft.attachments.length===originalMaterials.length+2?state:null;
  });
  assert.deepEqual(prepared.materials.filter(file=>file.name===lostName).map(file=>file.id),[lostMaterial.id]);
  const uploaded=prepared.materials.find(file=>file.name===uploadName);
  assert.deepEqual(prepared.draft.attachments,[...originalMaterials,uploaded.id,lostMaterial.id]);
  permitSubmission=true;
  const submittedWithMaterials=page.waitForResponse(response=>response.url().endsWith(mediaPath+'/runs')&&response.request().method()==='POST');
  await composer.press('Control+Enter');
  const submittedRun=await submittedWithMaterials;
  assert.equal(submittedRun.status(),202);
  const admitted=await runAt(mediaRoom,(await submittedRun.json()).id,'waiting_approval');
  assert.equal(attempts.length,1);
  assert.deepEqual(admitted.materialIds,prepared.draft.attachments);
  await approve(admitted,false);
  await runAt(mediaRoom,admitted.id,'cancelled');
  assert.deepEqual((await room(otherRoom)).draft,otherAfter.draft);
  assert.equal((await room(otherRoom)).runs.length,0);
  assert.equal((await room(mediaRoom)).artifacts.length,0);
  assert.equal(fixture.calls.length-fixtureBefore,1);
  assert.deepEqual(errors,[]);
  const materialImport={blockedAfterNavigation:true,blockedInSmallWindow:true,submissionsBeforeAcknowledgement:0,unblockedBeforeWorkspaceRefresh:true,
    independentRoomDraftPreserved:true,ambiguousReceiptReported:true,retryDeduplicated:true,
    acceptedAttachments:admitted.materialIds.length,modelRequestsAfterSend:1,originalApproval:'cancelled'};
  pass('材料导入期间跨 Bot 往返仍阻止提前发送，另一会话可选材料，丢回执后同件重试且原审批归属正确');

  if(process.env.HYPER_BOT_TEST_REPORT) {
    const {version}=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
    await writeFile(process.env.HYPER_BOT_TEST_REPORT,JSON.stringify({version,checks,ime,materialImport,modelFixture:true,modelRequests:fixture.calls.length},null,2)+'\n');
  }
} finally {
  releasePending?.();
  await browser?.close();
  await host?.close();
  await fixture.close();
}


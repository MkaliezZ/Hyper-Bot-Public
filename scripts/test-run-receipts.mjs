import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { modelFixture, sample } from '../test/model-fixture.mjs';

const root=path.resolve(process.env.HYPER_BOT_TEST_APP_ROOT??fileURLToPath(new URL('../',import.meta.url)));
const {launch}=await import(pathToFileURL(path.join(root,'server','http.mjs')));
const {chromium}=createRequire(import.meta.url)(process.env.HYPER_BOT_TEST_PLAYWRIGHT??'playwright');
const data=await mkdtemp(path.join(tmpdir(),'hb-run-receipts-'));
const privateText='只在原会话提示存在的合成口令';
const key='key-for-local-protocol-fixture';
let host,browser,malformed=false,omitUsage=false;
const checks=[], observed=[];
const pass=message=>{checks.push(message);console.log('OK '+message);};
const model=await modelFixture({
  observe(){
    const state=host.store.read();
    const run=state.runs.find(row=>row.state==='running')??state.verifications?.find(row=>row.state==='running');
    observed.push({id:run?.id,requests:run?.usage?.requests,protocol:run?.usage?.protocol});
  },
  respond:prompt=>malformed?{unusable:true}:sample(prompt),
  reportedUsage(_prompt,protocol){
    if(omitUsage)return null;
    if(protocol==='messages')return {input_tokens:30,output_tokens:14,cache_read_input_tokens:12,cache_creation_input_tokens:3};
    return {prompt_tokens:60,completion_tokens:24,prompt_cache_hit_tokens:12,total_tokens:84};
  }
});
const open=()=>launch({options:{data,providerKey:key,upstream:model.origin}});
const shots=process.env.HYPER_BOT_TEST_SCREENSHOTS;

async function api(route,body,status) {
  const bodyFields=body===undefined?{}:{method:'POST',headers:{'X-Hyper-Bot':'1','Content-Type':'application/json'},body:JSON.stringify(body)};
  const response=await fetch(host.origin+'/api'+route,{...bodyFields,signal:AbortSignal.timeout(90000)});
  const value=await response.json();
  if(status)assert.equal(response.status,status,JSON.stringify(value));
  else assert.ok(response.ok,JSON.stringify(value));
  return value;
}
const room=id=>api('/rooms/'+id);
const report=(category='simulation',days='all')=>api('/receipts?category='+category+'&days='+days);
const openRoom=(botId,title)=>api('/rooms',{botId,revision:1,title,example:true},201).then(row=>row.id);
async function start(id,text) {
  const {draft}=await room(id);
  return api('/rooms/'+id+'/runs',{...draft,text,clientRequestId:randomUUID(),authorized:true},202);
}
async function phase(id,expected) {
  const timeout=AbortSignal.timeout(55000);
  for(;;) {
    const view=await room(id);
    const run=view.runs.at(-1);
    if(run?.state===expected)return run;
    if(run&&['succeeded','failed','cancelled','interrupted'].includes(run.state)) {
      throw new Error('Expected '+expected+', got '+run.state+' '+run.error);
    }
    await delay(160,null,{signal:timeout});
  }
}
async function shot(page,file) {
  if(!shots)return;
  await mkdir(shots,{recursive:true});
  await page.screenshot({path:path.join(shots,file),animations:'disabled'});
}

try {
  host=await open();
  const briefer=await openRoom('brief','书店简报演练');
  const editor=await openRoom('media','书店分镜演练');
  malformed=true;
  const first=await start(briefer,'请整理书店开门前的素材。'+privateText);
  const failed=await phase(briefer,'failed');
  assert.equal(first.id,failed.id);
  const sibling=await api('/rooms/'+editor+'/draft',{text:'其他会话的草稿',attachments:[],retryOf:failed.id},403);
  assert.equal(sibling.code,'retry_scope');
  const firstReport=await report();
  assert.equal(firstReport.summary.delivered,0);
  assert.equal(firstReport.summary.failureRate,1);
  assert.equal(firstReport.summary.averageTokens,null);
  assert.deepEqual(firstReport.summary.tokens.input,{total:60,missing:0});
  assert.equal(firstReport.rows[0].usage.protocol,'chat-completions');
  const firstEvents=await api('/runs/'+first.id+'/events');
  assert.equal(firstEvents.find(row=>row.kind==='provider_requested').data.usage.requests,1);
  assert.equal(firstEvents.find(row=>row.kind==='provider_completed').data.usage.requestId,'fixture-request-1');
  assert.equal(observed[0].requests,1);
  pass('真实 Hermes 失败前已持久记录模型请求，报告保留实际用量、失败原因和提供方编号，禁止跨会话重试');

  browser=await chromium.launch({executablePath:process.env.HYPER_BOT_TEST_CHROMIUM||undefined});
  const page=await browser.newPage({viewport:{width:1440,height:900}});
  const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(host.origin+'/#chat/'+briefer);
  malformed=false;
  await page.getByRole('button',{name:'带回本轮草稿',exact:true}).click();
  await page.getByRole('button',{name:'取消重试关联',exact:true}).waitFor();
  const sent=page.waitForResponse(response=>response.request().method()==='POST'&&
    new URL(response.url()).pathname==='/api/rooms/'+briefer+'/runs');
  await page.getByRole('button',{name:'发送消息',exact:true}).click();
  assert.equal((await sent).status(),202);
  const retry=await phase(briefer,'succeeded');
  assert.equal(retry.retryOf,first.id);
  assert.equal((await api('/runs/'+retry.id+'/events')).find(row=>row.kind==='accepted').data.retryOf,first.id);

  const submitted=await start(editor,'把材料整理成一份带时间码的口播分镜。');
  const proposal=await phase(editor,'waiting_approval');
  await api('/receipts/'+proposal.id+'/accounting',{activeSeconds:10},409);
  await api('/runs/'+proposal.id+'/decide',{id:proposal.approval.id,digest:proposal.approval.digest,allow:true},202);
  const saved=await phase(editor,'succeeded');
  assert.equal(saved.id,submitted.id);
  assert.equal(observed[2].protocol,'messages');
  const uses=await report();
  assert.equal(uses.summary.retries,1);
  assert.equal(uses.summary.failed,1);
  assert.equal(uses.summary.delivered,2);
  assert.equal(uses.summary.averageTokens,113.5);
  assert.deepEqual(uses.summary.tokens.input,{total:165,missing:0});
  const script=uses.rows.find(row=>row.id===saved.id);
  assert.deepEqual([script.usage.input,script.usage.output,script.usage.cached,script.usage.cacheWrite],[45,14,12,3]);
  assert.equal((await report('work')).rows.length,0);
  assert.doesNotMatch(JSON.stringify(uses),new RegExp(privateText+'|'+key));
  pass('界面重试绑定原任务，真实 Web Host 按最终完整帧统一输入口径，两份交付的均值包含失败请求');

  await page.goto(host.origin+'/#manage/receipts');
  await page.getByRole('combobox',{name:'任务类型',exact:true}).selectOption('simulation');
  const card=page.getByRole('article',{name:/自媒体口播/});
  await card.getByRole('button',{name:'登记实际记录',exact:true}).click();
  const form=page.getByRole('dialog',{name:'账单与人工记录'});
  await form.getByLabel('人工处理秒数',{exact:true}).fill('45');
  await form.getByLabel('关系动用次数',{exact:true}).fill('1');
  await form.getByLabel('关系动用记录编号',{exact:true}).fill('pilot-R01');
  await form.getByLabel('已核对金额（元）',{exact:true}).fill('0.000125');
  await form.getByRole('button',{name:'保存实际记录',exact:true}).click();
  await form.getByText('请填写已核对的账单条目编号。',{exact:true}).waitFor();
  const billField=form.getByLabel('账单条目编号',{exact:true});
  assert.ok(await billField.evaluate(node=>node===document.activeElement));
  await form.getByText('fixture-request-3',{exact:true}).waitFor();
  await billField.fill('fixture-invoice-L01');
  await form.getByRole('button',{name:'保存实际记录',exact:true}).click();
  await form.waitFor({state:'hidden'});
  await card.getByRole('button',{name:'编辑核对记录',exact:true}).waitFor();
  const global=await report();
  assert.equal(global.summary.accounting.amountCny,'0.000125');
  assert.equal(global.summary.accounting.averageCny,null);
  assert.deepEqual(global.summary.accounting.activeSeconds,{total:45,missing:2});
  assert.equal((await api('/receipts/'+saved.id+'/accounting',{activeSeconds:2},409)).code,'accounting_conflict');
  assert.equal((await room(editor)).runs[0].accounting,undefined);
  const accountingEvent=(await api('/runs/'+saved.id+'/events')).find(row=>row.kind==='accounting_recorded');
  assert.equal(accountingEvent.data.role,'maintainer');
  assert.equal(accountingEvent.data.accounting.billRef,'fixture-invoice-L01');

  const download=page.waitForEvent('download');
  await page.getByRole('button',{name:'导出回执',exact:true}).click();
  const exported=JSON.parse(await readFile(await (await download).path(),'utf8'));
  assert.equal(exported.filters.category,'simulation');
  assert.equal(exported.rows.length,3);
  assert.equal(exported.summary.accounting.amountCny,'0.000125');
  assert.doesNotMatch(JSON.stringify(exported),new RegExp(privateText+'|'+key));

  const firstRow=page.getByRole('article').filter({has:page.getByText(first.id.slice(0,8),{exact:true})});
  await firstRow.getByRole('button',{name:'登记实际记录',exact:true}).click();
  await form.getByLabel('已核对金额（元）').fill('0.000033');
  await billField.fill('fixture-invoice-L01');
  await form.getByRole('button',{name:'保存实际记录',exact:true}).click();
  await form.getByText('该账单条目已登记到任务 '+saved.id.slice(0,8)+'。请核对本轮条目。',{exact:true}).waitFor();
  assert.equal(await billField.getAttribute('aria-invalid'),'true');
  assert.ok(await billField.evaluate(node=>node===document.activeElement));
  assert.equal((await report()).rows.find(row=>row.id===first.id).accounting,null);
  await page.setViewportSize({width:320,height:800});
  assert.ok(await form.evaluate(node=>node.scrollWidth<=node.clientWidth+1));
  await shot(page,'窄屏-重复账单登记.png');
  await billField.fill('fixture-invoice-L02');
  await form.getByRole('button',{name:'保存实际记录',exact:true}).click();
  await form.waitFor({state:'hidden'});
  await api('/receipts/'+retry.id+'/accounting',{billRef:'fixture-invoice-L03',amountCny:'0.000208'});
  const reconciled=await report();
  assert.equal(reconciled.summary.accounting.amountCny,'0.000366');
  assert.equal(reconciled.summary.accounting.averageCny,'0.000183');
  assert.equal(reconciled.summary.accounting.billConflicts,0);
  await page.locator('.toast').waitFor({state:'hidden'});
  for(const width of [1440,1024,768,390,320]){
    await page.setViewportSize({width,height:900});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),width);
    const rect=await page.locator('.receipts-page').boundingBox();
    assert.ok(rect.x>=0&&rect.x+rect.width<=width);
    const columns=await page.locator('.receipts-summary .receipt-metrics').first()
      .evaluate(el=>getComputedStyle(el).gridTemplateColumns.split(' ').length);
    assert.equal(columns,width<=560?2:4);
    if(width===1440)await shot(page,'桌面-运行回执.png');
    if(width===390)await shot(page,'手机-运行回执.png');
  }
  await page.emulateMedia({reducedMotion:'reduce'});
  assert.equal(await page.locator('.receipts-page').evaluate(el=>getComputedStyle(el).animationName),'none');
  assert.deepEqual(errors,[]);
  pass('账单与人工登记保留缺项，拒绝同条目重复入账，复核失败和重试计费，五种视口及导出通过');

  const incomplete=await openRoom('brief','模型漏报测试');
  omitUsage=true;
  const draft=await start(incomplete,'整理书店简报。');
  assert.equal((await phase(incomplete,'succeeded')).id,draft.id);
  omitUsage=false;
  const legacyId=randomUUID();
  host.store.change(state=>{
    const previous=state.runs.find(row=>row.id===first.id);
    state.runs.push({...previous,id:legacyId,createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:00:20.000Z',
      finishedAt:'2026-01-01T00:00:20.000Z',usage:{requests:1,input:11,output:8,cached:0}});
  });
  const withMissing=await report();
  assert.equal(withMissing.summary.missing,2);
  assert.equal(withMissing.summary.averageTokens,null);
  assert.deepEqual(withMissing.summary.tokens.input,{total:165,missing:2});
  assert.equal(withMissing.rows.find(row=>row.id===legacyId).usage.status,'legacy');
  assert.equal(withMissing.rows.find(row=>row.id===draft.id).usage.requests,1);
  assert.equal(withMissing.summary.accounting.billConflicts,2);
  assert.equal(withMissing.summary.accounting.amountCny,'0.000333');
  assert.equal(withMissing.summary.accounting.averageCny,null);
  const recent=await report('simulation','7');
  assert.equal(recent.rows.some(row=>row.id===legacyId),false);
  assert.equal(recent.rows.find(row=>row.id===first.id).billConflict,true);
  assert.equal(recent.summary.accounting.billConflicts,1);
  assert.equal(recent.summary.accounting.amountCny,'0.000333');
  await page.setViewportSize({width:1440,height:900});
  await page.goto(host.origin+'/#manage/receipts');
  await page.getByRole('combobox',{name:'任务类型',exact:true}).selectOption('simulation');
  const warning=page.getByText('1 轮的账单条目重复，金额待复核。',{exact:true});
  await warning.waitFor();
  await page.getByRole('heading',{name:'运行回执',exact:true}).scrollIntoViewIfNeeded();
  assert.ok(await warning.evaluate(node=>node.getBoundingClientRect().bottom<=window.innerHeight));
  await shot(page,'桌面-历史账单待复核.png');
  await api('/receipts/'+legacyId+'/accounting',{expectedRevision:1,amountCny:null,billRef:null});
  assert.equal((await report()).summary.accounting.amountCny,'0.000366');
  assert.equal((await report()).summary.accounting.billConflicts,0);
  pass('缺报与旧口径仍可核对，跨周期的历史重复条目退出金额合计，清除重复后恢复');

  const candidate=await api('/bots',{id:'receipt-check',name:'回执验证简报',kind:'brief',driver:'dsh-web',
    description:'检查候选验证的独立回执。',skills:['material-brief']},201);
  const verify=()=>api('/bots/'+candidate.id+'/'+candidate.revision+'/verify',{});
  malformed=true;
  const rejected=await verify();
  assert.equal(rejected.ok,false);
  malformed=false;
  const accepted=await verify();
  assert.equal(accepted.ok,true);
  const crossCategory=await api('/receipts/'+accepted.runId+'/accounting',
    {billRef:'fixture-invoice-L01',amountCny:'0.000125'},409);
  assert.equal(crossCategory.code,'bill_entry_conflict');
  await host.close();
  const modelBefore=model.calls.length;
  host=await open();
  const audits=await report('verification');
  assert.equal(audits.rows.length,2);
  assert.equal(audits.summary.failed,1);
  assert.equal(audits.summary.verified,1);
  assert.equal(audits.rows.find(row=>row.id===accepted.runId).retryOf,rejected.runId);
  assert.deepEqual(audits.summary.tokens.input,{total:90,missing:0});
  assert.equal((await report()).summary.total,5);
  assert.equal(model.calls.length,modelBefore);
  pass('候选验证失败与重验各有独立回执，重启后可查看，演练和维护记录各自统计');

  const previousApp=process.env.HYPER_BOT_TEST_PREVIOUS_APP;
  if(previousApp) {
    const {launch:launchPrevious}=await import(pathToFileURL(path.join(previousApp,'server','http.mjs')));
    await api('/rooms/'+briefer+'/draft',{text:'从失败的旧任务重试',attachments:failed.materialIds,base:null,retryOf:failed.id});
    assert.equal((await room(briefer)).draft.retryOf,failed.id);
    await host.close();
    host=await launchPrevious({options:{data,providerKey:key,upstream:model.origin}});
    const retained=(await room(briefer)).draft;
    assert.equal(retained.retryOf,undefined);
    await api('/rooms/'+briefer+'/draft',{...retained,text:'在旧版编辑的草稿'});
    await host.close();
    host=await open();
    const updated=(await room(briefer)).draft;
    assert.equal(updated.text,'在旧版编辑的草稿');
    assert.equal(updated.retryOf,undefined);
    assert.equal((await report('verification')).rows.length,2);
    assert.equal(model.calls.length,modelBefore);
    pass('真实旧版可读取和编辑新建重试草稿，升级后保留编辑且清除已失效的重试关联');
  }

  const output=process.env.HYPER_BOT_TEST_REPORT;
  if(output) {
    const {version}=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
    await writeFile(output,JSON.stringify({version,checkedAt:new Date().toISOString(),checks,
      model:'local HTTP fixture',modelCalls:model.calls.length,legacyFieldsPreserved:true,
      savedVersion:saved.artifact,verifiedTrials:audits.rows.length,exampleMetrics:global.summary,
      billing:{newDuplicateRejected:true,ignoredLegacyDuplicates:withMissing.summary.accounting.billConflicts,
        conflictOutsideFilter:recent.summary.accounting.billConflicts,crossCategoryRejected:true,
        correctedAmountCny:reconciled.summary.accounting.amountCny,averageCny:reconciled.summary.accounting.averageCny}},null,2)+'\n');
  }
} finally {
  await browser?.close();
  await host?.close();
  await model.close();
}


import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { modelFixture } from '../test/model-fixture.mjs';

const root=resolve(process.env.HYPER_BOT_TEST_APP_ROOT??fileURLToPath(new URL('../',import.meta.url)));
const {launch}=await import(pathToFileURL(join(root,'server','http.mjs')));
const {unzipSync,strFromU8}=createRequire(join(root,'package.json'))('fflate');
const version=JSON.parse(await readFile(join(root,'package.json'),'utf8')).version;
const data=await mkdtemp(join(tmpdir(),'hb-export-proof-'));
const quote='开门前先摆好第一排书。';
const hidden='UNQUOTED_FIXTURE_'+randomUUID();
const model=await modelFixture({respond:({text,sources})=>{
  const refs=sources.map(source=>({material:source.id,quote}));
  if (!text.includes('"segments"')) {
    return {title:"同名访谈的简报 (📚)",points:refs.map((ref,i)=>({
      name:'核对原话 '+(i+1),text:'按授权副本核对这句采访。',evidence:[ref]
    })),notes:[]};
  }
  return {title:'书店开门前的 45 秒',
    segments:refs.map((ref,i)=>({name:['开门','摆书'][i],start:i*10,end:[10,45][i],
      spoken:'把授权材料的动作说清楚。',visual:'近拍正在发生的动作。',subtitle:'书店开门前',evidence:[ref]})),notes:[]};
}});
const host=await launch({options:{data,upstream:model.origin,providerKey:'export-fixture'}});
let browser;
const checks=[], viewports=[];
const pass=value=>{checks.push(value);console.log('OK '+value);};
const hash=content=>createHash('sha256').update(content).digest('hex');
const exportRoute=id=>'/artifacts/'+id+'/export';
const room=id=>api('/rooms/'+id);
const filesFor=(id,files)=>Promise.all(files.map(file=>api('/rooms/'+id+'/materials',{...file,authorized:true},201)));
const headers={'Content-Type':'application/json','X-Hyper-Bot':'1'};
const respond=(route,body)=>fetch(host.origin+'/api'+route,{
  ...(body===undefined?{}:{method:'POST',headers,body:JSON.stringify(body)}),signal:AbortSignal.timeout(30000)
});
async function api(route,body,status) {
  const r=await respond(route,body);
  const value=await r.json();
  if (status) assert.equal(r.status,status,JSON.stringify(value));
  else assert.ok(r.ok,JSON.stringify(value));
  return value;
}
async function until(read,ready){
  const limit=AbortSignal.timeout(65000);
  for(;;){
    const result=await read();
    if(ready(result)) return result;
    await delay(140,null,{signal:limit});
  }
}

async function generate(roomId,materialIds,text,base=null) {
  const job=await api('/rooms/'+roomId+'/runs',{text,base,attachments:materialIds,
    clientRequestId:randomUUID(),authorized:true},202);
  const read=()=>room(roomId).then(value=>value.runs.find(run=>run.id===job.id));
  const run=await until(read,item=>item.state==='waiting_approval'||!!item.finishedAt);
  if(run.state==='waiting_approval') {
    await api('/runs/'+job.id+'/decide',{id:run.approval.id,digest:run.approval.digest,allow:true},202);
    await until(read,item=>!!item.finishedAt);
  }
  const saved=await read();
  assert.equal(saved.state,'succeeded',saved.error);
  const view=await room(roomId);
  return view.artifacts.find(item=>item.id===saved.artifact);
}

async function zip(route,status=200) {
  const r=await fetch(host.origin+'/api'+route,{headers:{'X-Hyper-Bot':'1'},signal:AbortSignal.timeout(30000)});
  assert.equal(r.status,status);
  if (status!==200) return r.json();
  assert.equal(r.headers.get('Content-Type'),'application/zip');
  assert.equal(r.headers.get('Cache-Control'),'no-store');
  const disposition=r.headers.get('Content-Disposition');
  assert.ok(disposition?.startsWith("attachment; filename*=UTF-8''"));
  const filename=decodeURIComponent(disposition.split("''")[1]);
  const bytes=new Uint8Array(await r.arrayBuffer());
  assert.equal(bytes.length,Number(r.headers.get('Content-Length')));
  return {filename,bytes};
}

function inspect(bytes,record,roomId,sources) {
  const archive=unzipSync(bytes);
  assert.deepEqual(Object.keys(archive).sort(),['版本与来源.json','稿件.md'].sort());
  const manifest=JSON.parse(strFromU8(archive['版本与来源.json']));
  const text=strFromU8(archive['稿件.md']);
  assert.equal(manifest.format,'hyper-bot-artifact');
  assert.equal(manifest.schema,1);
  assert.equal(manifest.sourceEncoding,'utf-8');
  assert.equal(manifest.markdownFile,'稿件.md');
  assert.equal(manifest.markdownSha256,hash(archive[manifest.markdownFile]));
  assert.equal(manifest.id,record.id);
  assert.equal(manifest.version,record.version);
  assert.equal(manifest.runId,record.run);
  assert.equal(manifest.conversationId,roomId);
  assert.equal(manifest.previous,record.previous);
  assert.equal(manifest.base,record.base??null);
  assert.equal(manifest.workbench?.id,record.receipt?.id);
  assert.ok(text.includes(record.run)&&text.includes(record.id));
  assert.ok(!text.includes(hidden));
  assert.ok(!JSON.stringify(manifest).includes(hidden));
  assert.deepEqual(manifest.sources.map(file=>file.id),record.materialIds);
  const rows=record.result.segments??record.result.points;
  assert.equal(manifest.citations.length,rows.reduce((sum,row)=>sum+row.evidence.length,0));
  for (const [index,citation] of manifest.citations.entries()) {
    const file=sources.get(citation.materialId);
    assert.ok(file);
    assert.equal(manifest.sources.find(row=>row.id===file.id).digest,hash(file.content));
    assert.equal(citation.number,index+1);
    assert.equal(citation.item.kind,record.kind==='script'?'shot':'point');
    const row=rows[citation.item.index-1];
    assert.equal(citation.item.name,row.name);
    if (record.kind==='script') assert.deepEqual([citation.item.startSeconds,citation.item.endSeconds],[row.start,row.end]);
    assert.ok(row.evidence.some(ref=>ref.material===file.id&&ref.quote===citation.quote));
    assert.equal(citation.quote,quote);
    const at=file.content.indexOf(quote);
    const byteSource=Buffer.from(file.content,'utf8');
    const match=citation.firstMatch;
    assert.equal(match.startByte,Buffer.byteLength(file.content.slice(0,at)));
    assert.equal(match.line,(file.content.slice(0,at).match(/\r\n|\r|\n/g)?.length??0)+1);
    assert.equal(byteSource.subarray(match.startByte,match.endByte).toString('utf8'),quote);
    assert.equal(match.occurrences,file.content.split(quote).length-1);
    assert.ok(text.split('\n').some(line=>line.startsWith('- 引用 '+citation.number+' · '+file.name)));
  }
  return {manifest,text};
}

try {
  const media=(await api('/rooms',{botId:'media',revision:1,title:'书店口播离线核对',simulation:true},201)).id;
  const mediaSources=[
    {name:'店主访谈.txt',content:'📚 已整理拍摄顺序。\n'+quote+'\n'+hidden},
    {name:'现场笔记.md',content:'先核对动作和内容。\n'+quote}
  ];
  const scriptIds=(await filesFor(media,mediaSources)).map(file=>file.id);
  const scriptSource=new Map(await Promise.all(scriptIds.map(async id=>[id,await api('/rooms/'+media+'/materials/'+id)])));
  const first=await generate(media,scriptIds,'按两份材料整理书店分镜。');
  const second=await generate(media,scriptIds,'沿用原稿并整理成第二版。',first.id);
  const firstPath=exportRoute(first.id);
  assert.equal((await fetch(host.origin+'/api'+firstPath+'?format=bundle')).status,403);
  const firstZip=await zip(firstPath+'?format=bundle');
  const secondZip=await zip(exportRoute(second.id)+'?format=bundle');
  assert.match(firstZip.filename,/-v1-成果包\.zip$/);
  assert.match(secondZip.filename,/-v2-成果包\.zip$/);
  const {manifest:firstManifest,text:firstText}=inspect(firstZip.bytes,first,media,scriptSource);
  const {manifest:secondManifest}=inspect(secondZip.bytes,second,media,scriptSource);
  assert.equal(secondManifest.previous,first.id);
  assert.equal(secondManifest.base,first.id);
  assert.equal(secondManifest.workbench.project,firstManifest.workbench.project);
  assert.notEqual(secondManifest.markdownSha256,firstManifest.markdownSha256);
  const unchanged=await api(firstPath);
  assert.equal(unchanged.markdown,firstText);
  assert.equal(unchanged.manifest.markdownSha256,firstManifest.markdownSha256);
  assert.deepEqual(unchanged.manifest.citations,firstManifest.citations);
  pass('口播同一原项目的 v1、v2 可分别打包，文件摘要、来源稿和版本链匹配');

  const b=(await api('/rooms',{botId:'brief',revision:1,title:'区分两份同名访谈',simulation:true},201)).id;
  const separate=[
    {name:'同名访谈.txt',content:'📚 采访甲。\r\n'+quote+'\r\n另外记录：'+quote+'\r\n'+hidden},
    {name:'同名访谈.txt',content:'🎙 采访乙。\n记录落款。\n'+quote}
  ];
  const briefIds=(await filesFor(b,separate)).map(file=>file.id);
  assert.equal(new Set(briefIds).size,2);
  const briefSources=new Map(await Promise.all(briefIds.map(async id=>[id,await api('/rooms/'+b+'/materials/'+id)])));
  const brief=await generate(b,briefIds,'分别核对两份同名材料。');
  const briefZip=await zip(exportRoute(brief.id)+'?format=bundle');
  assert.match(briefZip.filename,/\(📚\)-v1-成果包\.zip$/);
  const {manifest:briefManifest}=inspect(briefZip.bytes,brief,b,briefSources);
  assert.deepEqual(briefManifest.citations.map(citation=>citation.firstMatch.line),[2,3]);
  assert.deepEqual(briefManifest.citations.map(citation=>citation.firstMatch.occurrences),[2,1]);
  assert.deepEqual(briefManifest.citations.map(citation=>citation.materialId),briefIds);
  pass('简报按引文编号区分同名材料，含中文、表情和 CRLF 的 UTF-8 位置与原句一致');

  if (!process.argv.includes('--no-ui')) {
    const {chromium}=createRequire(import.meta.url)(process.env.HYPER_BOT_TEST_PLAYWRIGHT??'playwright');
    browser=await chromium.launch({executablePath:process.env.HYPER_BOT_TEST_CHROMIUM||undefined});
    const page=await browser.newPage({viewport:{width:1440,height:900},acceptDownloads:true});
    const screenshots=process.env.HYPER_BOT_TEST_SCREENSHOTS;
    await page.goto(host.origin+'/#chat/'+media+'?artifact='+first.id);
    const options=page.getByRole('button',{name:'导出选项'});
    const dialog=page.getByRole('dialog',{name:'导出成果'});
    const button=dialog.getByRole('button',{name:'稿件与来源 ZIP'});
    for(const width of [1440,1024,768,390,320]) {
      await page.setViewportSize({width,height:width>=768?900:844});
      await page.emulateMedia({reducedMotion:width===320?'reduce':'no-preference'});
      if(width<=760&&!await options.isVisible())await page.getByRole('button',{name:'预览',exact:true}).click();
      await options.click();
      await dialog.getByText('v1',{exact:true}).waitFor();
      assert.ok(await button.evaluate(node=>document.activeElement===node));
      const measured=await dialog.evaluate(node=>{
        const bounds=node.getBoundingClientRect();
        return {width:innerWidth,left:bounds.left,right:bounds.right,
          overflow:node.scrollWidth-node.clientWidth,animation:getComputedStyle(node).animationDuration,
          targets:[...node.querySelectorAll('button')].map(b=>b.getBoundingClientRect().height)};
      });
      assert.ok(measured.left>=0&&measured.right<=width+0.5&&measured.overflow<=0);
      assert.equal(measured.animation,width===320?'0s':'0.24s');
      assert.ok(measured.targets.every(n=>n>=44));
      viewports.push(measured);
      if(screenshots&&[1440,390].includes(width)) {
        await mkdir(screenshots,{recursive:true});
        await page.screenshot({path:join(screenshots,width===1440?'桌面-导出成果.png':'手机-导出成果.png'),animations:'disabled'});
      }
      await page.keyboard.press('Escape');
      await dialog.waitFor({state:'hidden'});
      assert.ok(await options.evaluate(node=>document.activeElement===node));
    }
    await options.click();
    const ready=page.waitForEvent('download');
    await button.click();
    const saved=await ready;
    assert.equal(saved.suggestedFilename(),firstZip.filename);
    inspect(await readFile(await saved.path()),first,media,scriptSource);
    await options.click();
    const readyJson=page.waitForEvent('download');
    await dialog.getByRole('button',{name:'仅版本与来源 JSON'}).click();
    const json=await readyJson;
    assert.equal(JSON.parse(await readFile(await json.path(),'utf8')).markdownSha256,firstManifest.markdownSha256);
  }
  pass('压缩包只含所选稿件和来源清单，逐条摘录可独立回查');

  await api('/bots/media/1/disable',{});
  const history=await zip('/bots/media/1/history-export');
  const contents=unzipSync(history.bytes);
  const catalog=JSON.parse(strFromU8(contents['版本与来源.json']));
  assert.equal(catalog.format,'hyper-bot-history');
  assert.ok(catalog.versions.every(item=>item.citations.length===2 && item.markdownSha256===item.sha256));
  assert.ok(catalog.versions.every(item=>hash(contents[item.file])===item.sha256));
  pass('停用后的历史 ZIP 延续原目录和清单，逐版引用及 SHA-256 可对应');

  await api('/rooms/'+media+'/materials/'+scriptIds[0]+'/revoke',{confirmed:true},202);
  assert.equal((await zip(firstPath+'?format=bundle',410)).code,'material_ended');
  assert.equal((await api(firstPath,undefined,410)).code,'material_ended');
  assert.equal((await zip('/bots/media/1/history-export',410)).code,'no_history_export');
  assert.equal((await zip(exportRoute(brief.id)+'?format=bundle')).filename,briefZip.filename);
  pass('撤回材料后稿件、成果包和历史导出同步失效，其他会话仍可导出');

  if (viewports.length) pass('桌面和手机实际下载所选旧版本，逐一检查五种视口、减弱动效和关闭后回焦');
  const result={version,fixture:true,checks,viewports,modelRequests:model.calls.length,
    versionIds:[first.id,second.id],brief:{id:brief.id,sameNames:2,positions:briefManifest.citations.map(ref=>ref.firstMatch)},
    package:{sha256:hash(firstZip.bytes),markdownSha256:firstManifest.markdownSha256,entries:['稿件.md','版本与来源.json']}};
  if (process.env.HYPER_BOT_TEST_REPORT) await writeFile(process.env.HYPER_BOT_TEST_REPORT,JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result));
} finally {
  await browser?.close();
  await host.close();
  await model.close();
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resultOf, definitionPrompt, sha } from '../server/contracts.mjs';
import { payloadHash } from '../server/workbench.mjs';
import { reviewScriptEvidence } from '../server/script-evidence.mjs';
import { receiptReport } from '../server/run-receipts.mjs';
import { provider } from '../server/provider.mjs';
import { launch } from '../server/http.mjs';
import { newWindowKey, windowHeader } from '../server/window-session.mjs';
import { retryLocalCheck } from '../server/config.mjs';
import { backupWorkspace, restoreWorkspace } from '../server/workspace-archive.mjs';
import { memoryContext, memoryRefsFor } from '../server/workspace-memory.mjs';
import { entityContext, entityOwner, grantEntityRead } from '../server/entity-archive.mjs';

test('Entity archives confirmed versions with local evidence and rechecks revocation',async()=>{
  const data=await mkdtemp(path.join(tmpdir(),'hyper-bot-entity-'));
  let host;
  try {
    host=await launch({options:{data,providerKey:''}});
    async function api(route,body,status=200) {
      const response=await fetch(host.origin+'/api'+route,{headers:{'X-Hyper-Bot':'1','Content-Type':'application/json'},
        ...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)})});
      const result=await response.json();
      assert.equal(response.status,status,JSON.stringify(result));
      return result;
    }
    const {id:room}=await api('/rooms',{botId:'media',revision:1,title:'测试口播'},201);
    const content='原文证据。';
    const {id:material}=await api('/rooms/'+room+'/materials',{name:'采访.txt',content,authorized:true},201);
    const artifact=randomUUID(),run=randomUUID(),approval=randomUUID(),project='test-project';
    const digest=sha('confirmed-version');
    host.store.change((state,emit)=>{
      const at=new Date().toISOString();
      const actor=entityOwner(state,at).entity_id;
      const job={id:run,conversation:room,entityActor:actor,botId:'media',botRevision:1,kind:'script',
        state:'succeeded',artifact,materialIds:[material],approval:{id:approval,status:'accepted',digest}};
      state.runs.push(job);
      state.artifacts.push({id:artifact,run,conversation:room,kind:'script',project,version:2,materialIds:[material],
        receipt:{id:'workbench-version',project},result:{title:'档案口播',segments:[{evidence:[{material,quote:content}]}]}});
      emit(job,'approval',{role:'user',decision:'accepted',target:project,digest});
    });
    const candidate=await api('/entity/candidates/'+artifact);
    assert.equal(candidate.sources[0].line,1);
    assert.equal(candidate.run,run);
    assert.equal((await api('/entity/candidates/'+randomUUID(),undefined,404)).code,'entity_source');
    const {ref}=await api('/entity/records',{artifact,form:'confirmed',confirmed:true},201);
    assert.deepEqual((await api('/entity/records',{artifact,form:'confirmed',confirmed:true},201)).ref,ref);
    const {claim_id,version}=ref;
    const selection={claim_id,version};
    const target=(await api('/rooms',{botId:'media',revision:1,title:'新任务'},201)).id;
    await api('/rooms/'+target+'/draft',{text:'重用经历',attachments:[],entityRef:selection});
    assert.deepEqual((await api('/rooms/'+target)).draft.entityRef,selection);
    const group=await api('/v1/workspaces',{name:'独立团队'},201);
    assert.equal((await api('/v1/workspaces/'+group.id+'/entity',undefined,403)).code,'entity_scope');
    const state=host.store.read(),destination=host.config.upstream;
    const selected=grantEntityRead(state,state.conversations.find(item=>item.id===target),selection,new Date().toISOString(),destination);
    const consumer={...selected,conversation:target,entityActor:state.entityOwner.entity_id};
    const projected=entityContext(state,consumer,destination);
    assert.equal(projected.summary,'确认了《档案口播》口播分镜 v2。');
    assert.ok(!JSON.stringify(projected).includes(content));
    assert.throws(()=>entityContext(state,consumer,'http://another-provider'),{code:'entity_unavailable'});
    assert.equal(state.entityRecords[0].claim.evidence.find(item=>item.asset_ref.asset_id===material).relation,'context');
    state.materials.find(row=>row.id===material).expiresAt=new Date(0).toISOString();
    assert.throws(()=>entityContext(state,consumer,destination),{code:'entity_unavailable'});
    await api('/entity/records/'+claim_id+'/revoke',{version,confirmed:true});
    const inactive=(await api('/entity')).records[0];
    assert.equal(inactive.revoked,true);
    assert.equal(inactive.source,undefined);
    assert.equal(inactive.statement,undefined);
  } finally {
    await host?.close();
    await rm(data,{recursive:true,force:true});
  }
});

test('desktop API requires the current Host credential before reads, events and writes',async()=>{
  const data=await mkdtemp(path.join(tmpdir(),'hyper-bot-window-contract-'));
  const options={data,providerKey:''};
  const firstKey=newWindowKey();
  let host=await launch({options,windowKey:firstKey});
  const origin=host.origin;
  const ask=(route,key,payload)=>{
    const headers=key?{[windowHeader]:key}:{};
    return fetch(origin+'/api'+route,{headers:{...headers,'X-Hyper-Bot':'1',
      ...(payload===undefined?{}:{'Content-Type':'application/json'})},signal:AbortSignal.timeout(5000),
      ...(payload===undefined?{}:{method:'POST',body:JSON.stringify(payload)})});
  };
  const denied=async (route,key,payload)=>{
    const response=await ask(route,key,payload);
    if (response.status!==403) await response.body?.cancel();
    assert.equal(response.status,403,route);
    assert.equal((await response.json()).code,'window_access');
  };
  try {
    await denied('/workspace');
    await denied('/events','invalid');
    await denied('/rooms',undefined,{});
    assert.equal((await ask('/workspace',firstKey)).status,200);
    assert.equal((await ask('/rooms',firstKey,{})).status,422);
    await host.close();
    const nextKey=newWindowKey();
    assert.notEqual(nextKey,firstKey);
    host=await launch({port:Number(new URL(origin).port),options,windowKey:nextKey});
    assert.equal(host.origin,origin);
    await denied('/workspace',firstKey);
    const events=await ask('/events',nextKey);
    assert.equal(events.status,200);
    assert.match(events.headers.get('Content-Type'),/^text\/event-stream/);
    await events.body.cancel();
    assert.equal((await ask('/workspace',nextKey)).status,200);
  } finally { await host.close(); }
});

test('workspace installation, drafts, materials and backup stay in their own group',async()=>{
  const base=await mkdtemp(path.join(tmpdir(),'hyper-bot-groups-test-'));
  const source=path.join(base,'source');
  const restored=path.join(base,'restored');
  const windowKey=newWindowKey();
  let host;
  async function api(route,body,expected=200) {
    const response=await fetch(host.origin+'/api'+route,{signal:AbortSignal.timeout(10000),
      headers:{[windowHeader]:windowKey,'Content-Type':'application/json','X-Hyper-Bot':'1'},
      ...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)})});
    const payload=await response.json();
    assert.equal(response.status,expected,route+': '+JSON.stringify(payload));
    return payload;
  }
  try {
    host=await launch({options:{data:source,providerKey:''},windowKey});
    const legacy=await api('/rooms',{botId:'media',revision:1,title:'原个人会话'},201);
    const personal=()=>api('/workspace');
    const remove='/bot-instances/remove-from-sidebar';
    assert.ok((await personal()).sidebarBots.includes('media'));
    await api(remove,{botId:'media'});
    await api(remove,{botId:'media'});
    assert.ok(!(await personal()).sidebarBots.includes('media'));
    assert.ok((await personal()).installedBots.includes('media'));
    const endpoint='/v1/workspaces';
    const [first,same]=await Promise.all([
      api(endpoint,{name:'内容工作室'},201),api(endpoint,{name:' 内容工作室 '},201)
    ]);
    assert.equal(first.id,same.id);
    const second=await api(endpoint,{name:'课程运营'},201);
    const a=endpoint+'/'+first.id,b=endpoint+'/'+second.id;
    const initial=await api(a+'/workspace');
    assert.deepEqual(initial.installedBots,[]);
    assert.deepEqual(initial.conversations,[]);
    assert.equal(initial.workspace.name,'内容工作室');
    const [room,replayed]=await Promise.all([
      api(a+'/bot-instances',{botId:'media'}),api(a+'/bot-instances',{botId:'media'})
    ]);
    assert.equal(room.id,replayed.id);
    const isolated=await api(b+'/bot-instances',{botId:'media'});
    assert.notEqual(room.id,isolated.id);
    await api(a+'/bot-instances',{botId:'brief'});
    assert.deepEqual((await api(a+'/workspace')).installedBots,['media','brief']);
    assert.deepEqual((await api(b+'/workspace')).installedBots,['media']);
    await api(a+remove,{botId:'media'},403);
    assert.deepEqual((await api(a+'/workspace')).sidebarBots,['media','brief']);
    const fact={title:'本组口播约定',content:'开场保留采访者完整原话。',bots:['media'],confirmed:true};
    assert.equal((await api(a+'/rooms/'+room.id)).useWorkspaceMemory===true,false);
    const note=await api(a+'/memories',fact,201);
    await api(a+'/rooms/'+room.id+'/memory',{enabled:true});
    assert.equal((await api(a+'/rooms/'+room.id)).useWorkspaceMemory,true);
    assert.equal((await api(b+'/rooms/'+isolated.id)).useWorkspaceMemory===true,false);
    await api(b+'/memories/'+note.id+'/revoke',{revision:1,confirmed:true},404);
    assert.deepEqual(await api(b+'/memories'),[]);
    const edited=await api(a+'/memories/'+note.id,{...fact,content:'末镜留两秒现场原声。',revision:1});
    assert.equal(edited.revision,2);
    await api(a+'/memories/'+note.id+'/revoke',{revision:1,confirmed:true},409);
    const content='内容组内部材料';
    const upload=await api(a+'/rooms/'+room.id+'/materials',{name:'来源.txt',content,authorized:true},201);
    await api(a+'/rooms/'+room.id+'/draft',{text:'内容组草稿',attachments:[upload.id],base:null});
    const before=await api(a+'/workspace');
    await api(b+'/rooms/'+isolated.id+'/draft',{text:'运营草稿',attachments:[],base:null});
    assert.equal((await api(a+'/workspace')).version,before.version);
    assert.deepEqual((await api(b+'/workspace')).conversations.map(row=>row.id),[isolated.id]);
    assert.equal((await api(a+'/rooms/'+room.id)).draft.text,'内容组草稿');
    assert.equal((await api(b+'/rooms/'+isolated.id)).draft.text,'运营草稿');
    await api(b+'/rooms/'+room.id,undefined,404);
    assert.equal((await api(b+'/rooms/'+isolated.id+'/materials/'+upload.id,undefined,403)).code,'material_scope');
    await api(a+'/projects/original',undefined,403);
    await api('/rooms/'+room.id,undefined,404);
    assert.equal((await api('/rooms/'+legacy.id)).title,'原个人会话');
    await host.close();host=null;
    const archive=path.join(base,'archive');
    await backupWorkspace(source,archive);
    await restoreWorkspace(archive,restored);
    host=await launch({options:{data:restored,providerKey:''},windowKey});
    assert.ok(!(await personal()).sidebarBots.includes('media'));
    assert.equal((await api('/rooms/'+legacy.id)).title,'原个人会话');
    assert.equal((await api('/bot-instances',{botId:'media'})).id,legacy.id);
    assert.ok((await personal()).sidebarBots.includes('media'));
    assert.deepEqual((await api(a+'/workspace')).sidebarBots,['media','brief']);
    assert.equal((await api(a+'/rooms/'+room.id)).draft.text,'内容组草稿');
    assert.equal((await api(a+'/rooms/'+room.id+'/materials/'+upload.id)).content,content);
    assert.equal((await api(b+'/rooms/'+isolated.id)).draft.text,'运营草稿');
    assert.equal((await api(a+'/memories'))[0].content,'末镜留两秒现场原声。');
    await api(a+'/memories/'+note.id+'/revoke',{revision:2,confirmed:true});
    assert.deepEqual(await api(a+'/memories'),[]);
  } finally {
    await host?.close();
    await rm(base,{recursive:true,force:true});
  }
});

const material={id:randomUUID(),name:'fixture.md',content:'门先开，再摆书。'};
const example={title:'书店分镜',segments:[
  {name:'开门',start:0,end:6,spoken:'“门先开”',visual:'拍门把手',subtitle:'开门',
    evidence:[{material:material.id,quote:'门先开'}]},
  {name:'摆书',start:6,end:12,spoken:'然后摆书。',visual:'拍书架',subtitle:'摆书',evidence:[]}
],notes:[]};

test('accepts exact source citations and a sequential script',()=>{
  assert.deepEqual(resultOf('script',JSON.stringify(example),[material]),example);
  const prompt=definitionPrompt({kind:'script',skills:[{content:'只根据材料作答。'}],request:'写口播。',
    materials:[{...material,unauthorizedPath:'C:\\test\\other-file'}],conversationTitle:'书店'});
  assert.match(prompt,/门先开/);
  assert.ok(!prompt.includes('other-file'));
});

test('workspace memories are scoped context with pinned versions and never evidence',()=>{
  const entry={id:randomUUID(),title:'写作偏好',content:'尾镜留两秒现场声。',revision:1,bots:['media'],updatedAt:'2026-11-24T00:00:00.000Z'};
  const state={memories:[entry]};
  assert.deepEqual(memoryRefsFor(state,'brief'),[]);
  const run={botId:'media',memoryRefs:memoryRefsFor(state,'media')};
  const memory=memoryContext(state,run);
  const prompt=definitionPrompt({kind:'script',skills:[],request:'写口播。',materials:[material],conversationTitle:'书店',memory});
  assert.match(prompt,/不能作为证据/);
  assert.match(prompt,/尾镜留两秒现场声/);
  assert.ok(prompt.indexOf('工作区记忆')<prompt.indexOf('授权材料（只读）'));
  const bad=structuredClone(example);
  bad.segments[0].evidence[0].quote=entry.content;
  assert.throws(()=>resultOf('script',JSON.stringify(bad),[material]),{code:'invalid_evidence'});
  entry.revision=2;
  assert.throws(()=>memoryContext(state,run),{code:'memory_changed'});
});

test('rejects unsupported evidence and overlapping shots',()=>{
  const noEvidence=structuredClone(example);
  noEvidence.segments[0].evidence[0].quote='来源未说过的话';
  assert.throws(()=>resultOf('script',JSON.stringify(noEvidence),[material]),{code:'invalid_evidence'});
  const overlapping=structuredClone(example);
  overlapping.segments[1].start=5;
  assert.throws(()=>resultOf('script',JSON.stringify(overlapping),[material]),{code:'invalid_timing'});
  assert.throws(()=>resultOf('script','不是 JSON',[material]),{code:'invalid_output'});
});

test('a requested verbatim opening starts on the entire sourced quote before review',()=>{
  const line='我每天先摆书，再开灯。';
  const source={...material,content:`店主说：“${line}”`};
  const shot={...example.segments[0],spoken:`店主这么说：“${line}”接着看店里。`,
    subtitle:`店主这么说：“${line}”`,evidence:[{material:source.id,quote:source.content}]};
  const draft={...example,segments:[shot,example.segments[1]]};
  const request='准备一份分镜。用店主的完整原话开场。';
  const result=resultOf('script',JSON.stringify(draft),[source],request);
  assert.deepEqual(result.segments,[{...shot,spoken:`“${line}”接着看店里。`,subtitle:`“${line}”`},draft.segments[1]]);
  assert.deepEqual(resultOf('script',JSON.stringify(result),[source],request),result);
  assert.deepEqual(resultOf('script',JSON.stringify(draft),[source],'不要用原话开场。'),draft);
  const fragment={...draft,segments:[{...shot,spoken:'“我每天先摆书”'},draft.segments[1]]};
  assert.throws(()=>resultOf('script',JSON.stringify(fragment),[source],request),{code:'invalid_opening_quote'});
  const unquoted={...draft,segments:[{...shot,spoken:line},draft.segments[1]]};
  assert.deepEqual(resultOf('script',JSON.stringify(unquoted),[source],request),unquoted);
});

test('local read-only checks retry transient errors once and honor cancellation',async()=>{
  const timeout=Object.assign(new Error('fixture deadline'),{killed:true,signal:'SIGTERM'});
  const attempts=[];
  assert.equal(await retryLocalCheck(again=>{
    attempts.push(again);
    if (!again) throw timeout;
    return 'recovered';
  }),'recovered');
  assert.deepEqual(attempts,[false,true]);
  await assert.rejects(retryLocalCheck(again=>{
    assert.equal(again,false);
    throw new Error('invalid source');
  }),/invalid source/);
  const controller=new AbortController();
  await assert.rejects(retryLocalCheck(again=>{
    assert.equal(again,false);
    controller.abort();
    throw timeout;
  },controller.signal),{name:'AbortError'});
});

test('flags unmatched claims per shot, including a quote cropped out of a qualified sentence',()=>{
  const id=randomUUID();
  const exact='我每天记录进店人数';
  const cropped='排书让进店人数提高80%';
  const count='样本共13次';
  const file={id,name:'书店记录.md',content:`样本共113次。未证实${cropped}。\n> “${exact}。”\n回访率为两成。`};
  const draft={...example,title:'45 秒口播',segments:[
    {...example.segments[0],spoken:`${count}。${cropped}。${exact}。`,subtitle:'样本共１３次。',
      evidence:[{material:id,quote:'样本共113次。'},{material:id,quote:cropped}]},
    {...example.segments[1],spoken:`“${exact}。”回访率为两成。翻开一本书。`,subtitle:'',
      evidence:[{material:id,quote:`“${exact}。”`},{material:id,quote:'回访率为两成。'}]}
  ]};
  const script=resultOf('script',JSON.stringify(draft),[file]);
  assert.deepEqual(reviewScriptEvidence(script,[file]),[{index:0,statements:[
    {text:count,kinds:['number'],fields:['spoken','subtitle']},
    {text:cropped,kinds:['number','cause'],fields:['spoken']},
    {text:exact,kinds:['experience'],fields:['spoken']}
  ]}]);
});

test('credits a complete attributed source quote when the current shot quotes it',()=>{
  const daily='我每天先把门口那排书摆好，再开灯。';
  const earlier='去年我每天记录书单。那个月记录了12次。';
  const earlierLine=`受访者：「${earlier}」`;
  const file={...material,content:`【合成演练材料】\n店主说：“${daily}”\n> ${earlierLine}`};
  const draft={...example,segments:[
    {...example.segments[0],spoken:`“${daily}”`,subtitle:daily,
      evidence:[{material:file.id,quote:daily}]},
    {...example.segments[1],spoken:`「${earlier}」`,subtitle:`“${earlier}”`,
      evidence:[{material:file.id,quote:earlierLine}]}
  ]};
  const script=resultOf('script',JSON.stringify(draft),[file]);
  assert.deepEqual(reviewScriptEvidence(script,[file]),[{index:0,statements:[
    {text:daily.slice(0,-1),kinds:['experience'],fields:['subtitle']}
  ]}]);
});

test('keeps review for cropped, qualified and other-shot quotations',()=>{
  const daily='我每天先把门口那排书摆好。';
  const fuller=`试营业期间，${daily}`;
  const cause='摆书让进店人数提高了80%。';
  const file={...material,content:`店主说：“${fuller}”\n如果店主说：“${cause}”\n店主说：“${cause}” 这句有待核实。`};
  const draft={...example,segments:[
    {...example.segments[0],spoken:`“${daily}”`,subtitle:`“${cause}”`,
      evidence:[{material:file.id,quote:daily},{material:file.id,quote:cause},{material:file.id,quote:fuller}]},
    {...example.segments[1],spoken:`“${fuller}”`,subtitle:'',evidence:[]}
  ]};
  const script=resultOf('script',JSON.stringify(draft),[file]);
  assert.deepEqual(reviewScriptEvidence(script,[file]),[
    {index:0,statements:[
      {text:'“'+daily.slice(0,-1),kinds:['experience'],fields:['spoken']},
      {text:'“'+cause.slice(0,-1),kinds:['number','cause'],fields:['subtitle']}
    ]},
    {index:1,statements:[{text:'“'+fuller.slice(0,-1),kinds:['experience'],fields:['spoken']}]}
  ]);
});

test('checks an attributed opening quote separately from the rest of the spoken field',()=>{
  const first='我每天先铺好垫布，再打开工具盒。';
  const second='我每天先把门垫放平，再去开窗。';
  const narration='所以到了周末，进店人数提高80%';
  const vendors={...material,content:'合成材料。摊主说：“'+first+'”'};
  const volunteers={...material,id:randomUUID(),content:'拍摄访谈。志愿者说：“'+second+'”'};
  const draft={...example,segments:[
    {...example.segments[0],spoken:'“'+first+'”修表摊的准备从这张桌子开始。'+narration+'。',subtitle:'',
      evidence:[{material:vendors.id,quote:first}]},
    {...example.segments[1],spoken:'“'+second+'”花房开门前从门垫开始。'+second,subtitle:'',
      evidence:[{material:volunteers.id,quote:second}]}
  ]};
  const sources=[vendors,volunteers];
  const script=resultOf('script',JSON.stringify(draft),sources);
  assert.deepEqual(reviewScriptEvidence(script,sources),[
    {index:0,statements:[{text:narration,kinds:['number','cause'],fields:['spoken']}]},
    {index:1,statements:[{text:second.slice(0,-1),kinds:['experience'],fields:['spoken']}]}
  ]);
});

test('digest is order independent and binds changes inside the approval scope',()=>{
  assert.equal(payloadHash({project:'one',plan:[{a:1,b:2}]}),payloadHash({plan:[{b:2,a:1}],project:'one'}));
  assert.notEqual(payloadHash({project:'two',plan:[{a:1,b:2}]}),payloadHash({project:'one',plan:[{a:1,b:2}]}));
});

test('money totals exclude duplicated statement lines even outside the current filter',()=>{
  const date='2026-06-18T12:00:00.000Z';
  const initial={state:'succeeded',createdAt:date,finishedAt:date,usage:{requests:1},modelMode:'deepseek',
    accounting:{amountCny:'0.04',billRef:'statement-L01'}};
  const work={...initial,id:'work',conversation:'room',artifact:'draft'};
  const rehearsal={...initial,id:'rehearsal',conversation:'rehearsal-room',modelMode:'test'};
  const old={...initial,id:'validation',createdAt:'2026-05-03T12:00:00.000Z',state:'failed'};
  const state={bots:[],conversations:[],runs:[work,rehearsal],verifications:[old]};
  const now=Date.parse(date);
  const workView=receiptReport(state,{category:'work',days:'7'},now);
  assert.equal(workView.rows[0].billConflict,true);
  assert.equal(workView.summary.accounting.amountCny,null);
  assert.equal(workView.summary.accounting.averageCny,null);
  assert.equal(receiptReport(state,{category:'verification',days:'7'},now).rows.length,0);
  const fixtures=receiptReport(state,{category:'simulation',days:'7'},now);
  assert.equal(fixtures.summary.accounting.billConflicts,0);
  assert.equal(fixtures.summary.accounting.amountCny,'0.04');
});

test('registered model gateway rejects tools before any outbound requests',async()=>{
  const controller=new AbortController();
  const gateway=await provider({model:'test-model',key:'test-only',upstream:'http://127.0.0.1:1'},controller.signal);
  try {
    const response=await fetch(gateway.url+'/v1/messages',{method:'POST',
      body:JSON.stringify({model:'test-model',tools:[{name:'placeholder'}]})});
    assert.equal(response.status,422);
    assert.equal(gateway.usage.requests,0);
    assert.equal(gateway.error().code,'runtime_policy');
  } finally {await gateway.close();}
});

async function withGateway(send,check,type='text/event-stream') {
  const upstream=http.createServer((request,response)=>{
    request.resume();
    response.writeHead(200,{'content-type':type});
    send(response);
  });
  upstream.listen(0,'127.0.0.1');
  await once(upstream,'listening');
  const gateway=await provider({model:'test-model',key:'test-only',upstream:'http://127.0.0.1:'+upstream.address().port},
    new AbortController().signal);
  const post=route=>fetch(gateway.url+route,{method:'POST',signal:AbortSignal.timeout(2200),
    body:JSON.stringify({model:'test-model',stream:type==='text/event-stream'})});
  try {await check(gateway,post);}
  finally {
    await gateway.close();
    const stopped=new Promise(resolve=>upstream.close(resolve));
    upstream.closeAllConnections();
    await stopped;
  }
}

test('Anthropic terminal frame closes the model stream before a late socket close',async()=>{
  await withGateway(response=>{
    response.write('data: {"type":"message_delta","usage":{"output_tokens":24}}\r\n\r\n');
    response.write('event: message_stop\r\ndata: {"type":"message_stop"}\r\n');
    setImmediate(()=>response.write('\r\n'));
    // The upstream keeps its socket open. Downstream must finish at message_stop.
  },async(gateway,post)=>{
    const response=await post('/v1/messages');
    assert.match(await response.text(),/message_stop/);
    assert.equal(gateway.complete(),true);
    assert.equal(gateway.error(),null);
    assert.equal(gateway.usage.output,24);
  });
});

test('OpenAI terminal sentinel preserves the final usage and ends the stream',async()=>{
  await withGateway(response=>{
    response.write('data: {"usage":{"prompt_tokens":17,"completion_tokens":6}}\n\n');
    response.write('data: [DONE]\n\n');
  },async(gateway,post)=>{
    const response=await post('/v1/chat/completions');
    assert.match(await response.text(),/\[DONE\]/);
    assert.equal(gateway.complete(),true);
    assert.equal(gateway.error(),null);
    assert.equal(gateway.usage.input,17);
    assert.equal(gateway.usage.output,6);
  });
});

test('a stream ending before its terminal remains failed even with token usage',async()=>{
  await withGateway(response=>{
    response.end('data: {"type":"message_delta","usage":{"output_tokens":24}}\n\n');
  },async(gateway,post)=>{
    await assert.rejects(async()=>{
      const response=await post('/v1/messages');
      await response.text();
    });
    assert.equal(gateway.complete(),false);
    assert.equal(gateway.error().code,'provider_error');
  });
});

test('forwards a fragmented text event as one checked SSE data field',async()=>{
  await withGateway(response=>{
    response.write('event: content_block_delta\r\ndata: {"type":"content_block_delta",\r');
    setImmediate(()=>response.end('\ndata: "delta":{"type":"text_delta","text":"书店"}}\r\n\r\n'+
      'event: message_stop\n'+'data: {"type":"message_stop"}\n\n'));
  },async(gateway,post)=>{
    const text=await (await post('/v1/messages')).text();
    assert.match(text,/^data: \{"type":"content_block_delta","delta":\{"type":"text_delta","text":"书店"\}\}$/m);
    assert.equal(gateway.complete(),true);
  });
});

for (const [protocol,route,value] of [
  ['Messages','/v1/messages',{type:'content_block_start',content_block:{type:'tool_use',name:'unsupported_fixture'}}],
  ['Chat Completions','/v1/chat/completions',{choices:[{delta:{tool_calls:[{id:'unsupported_fixture'}]}}]}]
]) {
  test(protocol+' stops before forwarding an unsupported tool event',async()=>{
    await withGateway(response=>{
      const text=JSON.stringify(value);
      response.write('data: '+text.slice(0,15));
      setImmediate(()=>response.end(text.slice(15)+'\r\n\r\n'));
    },async(gateway,post)=>{
      let seen='';
      await assert.rejects(async()=>{
        const response=await post(route);
        for await (const chunk of response.body) seen+=new TextDecoder().decode(chunk);
      });
      assert.doesNotMatch(seen,/unsupported_fixture/);
      const retry=await post(route);
      assert.equal(retry.status,429);
      await retry.body.cancel();
      assert.equal(gateway.error().code,'runtime_policy');
      assert.match(gateway.error().message,/禁用的工具动作/);
      assert.equal(gateway.complete(),false);
    });
  });
}

test('a non-streamed tool response is rejected before forwarding any provider payload',async()=>{
  await withGateway(response=>response.end(JSON.stringify({
    id:'receipt-fixture',choices:[{message:{function_call:{name:'unsupported_fixture'}},finish_reason:'function_call'}]
  })),async(gateway,post)=>{
    const response=await post('/v1/chat/completions');
    assert.equal(response.status,502);
    assert.doesNotMatch(await response.text(),/unsupported_fixture/);
    assert.equal(gateway.usage.responseId,'receipt-fixture');
    assert.equal(gateway.error().code,'runtime_policy');
    assert.equal(gateway.complete(),false);
  },'application/json');
});

test('forwards a non-streamed text response with an empty tool list and preserves usage',async()=>{
  const expected={id:'message-fixture',choices:[{message:{role:'assistant',content:'书店',tool_calls:[]},finish_reason:'stop'}],
    usage:{prompt_tokens:17,completion_tokens:6,prompt_cache_hit_tokens:0}};
  await withGateway(response=>response.end(JSON.stringify(expected)),async(gateway,post)=>{
    const response=await post('/v1/chat/completions');
    assert.equal(response.status,200);
    assert.deepEqual(await response.json(),expected);
    assert.equal(gateway.complete(),true);
    assert.equal(gateway.usage.input,17);
    assert.equal(gateway.usage.output,6);
  },'application/json');
});


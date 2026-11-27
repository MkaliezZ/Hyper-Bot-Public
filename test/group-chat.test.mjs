import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import path from 'node:path';
import os from 'node:os';
import {mkdtemp,mkdir,readFile,writeFile,realpath,rm} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {launch} from '../server/http.mjs';
import {backupWorkspace,restoreWorkspace} from '../server/workspace-archive.mjs';

test('the catalog updates seeded descriptions in existing workspaces and preserves custom revisions',async t=>{
  const dir=await mkdtemp(path.join(await realpath(os.tmpdir()),'hb-catalog-'));
  const host=await launch({options:{data:dir}});
  t.after(async()=>{try{await host.close();}finally{await rm(dir,{recursive:true,force:true});}});
  const catalog=async()=>(await (await fetch(host.origin+'/api/workspace')).json()).bots;
  const fresh=await catalog();
  const seeded=fresh.filter(bot=>['media','brief'].includes(bot.id));
  assert.equal(seeded.length,2);
  host.store.change(state=>{
    for(const bot of state.bots){
      bot.description='早期内置说明';
      bot.input='早期输入';
      bot.output='早期输出';
    }
    state.bots.push({...state.bots[0],revision:2,qualification:undefined,
      status:'candidate',description:'本工作室自行编写的说明'});
  });
  const upgraded=await catalog();
  for(const original of seeded){
    const visible=upgraded.find(bot=>bot.id===original.id && bot.revision===original.revision);
    for(const field of ['description','input','output'])assert.equal(visible[field],original[field]);
  }
  assert.equal(upgraded.find(bot=>bot.revision===2).description,'本工作室自行编写的说明');
});

test('group conversations reply without dispatching and keep context scoped to the same group and Bot',async t=>{
  const dir=await mkdtemp(path.join(await realpath(os.tmpdir()),'hb-group-conversation-'));
  const calls=[];
  const model=http.createServer(async (request,response)=>{
    const chunks=[];
    for await(const chunk of request)chunks.push(chunk);
    calls.push({route:request.url,body:JSON.parse(Buffer.concat(chunks))});
    response.writeHead(200,{'Content-Type':'application/json'});
    response.end(JSON.stringify({id:'chat-fixture',choices:[{finish_reason:'stop',
      message:{role:'assistant',content:'可以先对比两条视频的开场。'}}],
      usage:{prompt_tokens:30,completion_tokens:12,prompt_cache_hit_tokens:0}}));
  });
  model.listen(0,'127.0.0.1');
  await once(model,'listening');
  let host;
  t.after(async()=>{
    try{await host?.close();}
    finally{
      const close=new Promise(resolve=>model.close(resolve));
      model.closeAllConnections();
      await close;
      await rm(dir,{recursive:true,force:true});
    }
  });
  host=await launch({options:{data:path.join(dir,'host'),providerKey:'fixture',
    upstream:'http://127.0.0.1:'+model.address().port}});
  async function api(route,body,status=200){
    const result=await fetch(host.origin+'/api'+route,body===undefined?{}:{method:'POST',
      headers:{'Content-Type':'application/json','X-Hyper-Bot':'1'},body:JSON.stringify(body)});
    const value=await result.json();
    assert.equal(result.status,status,JSON.stringify(value));
    return value;
  }
  async function create(name){
    const folder=path.join(dir,name);await mkdir(folder);
    const group=await api('/v1/workspaces',{name,folder,bots:['media-benchmark','media-account','teaching-bot']},201);
    return '/v1/workspaces/'+group.id+'/group-chat';
  }
  async function chat(route,bot,text){
    const input={id:crypto.randomUUID(),bot,text,mode:'chat'};
    const received=await api(route,input,201);
    for(let attempt=0;attempt<100;attempt++){
      const row=(await api(route)).messages.find(item=>item.id===received.id);
      if(row.status==='done'){
        assert.equal(row.room,undefined);
        assert.equal(row.outputs,undefined);
        assert.equal(row.usage.requests,1);
        return {input,row};
      }
      assert.equal(row.status,'working',row.reply);
      await delay(20);
    }
    assert.fail('Group chat response did not finish.');
  }
  const a=await create('甲'), b=await create('乙');
  const intro=await api(a,{id:crypto.randomUUID(),bot:'media-benchmark',text:'简述一下你的功能。',mode:'chat'},201);
  assert.equal(intro.status,'done');
  assert.equal(calls.length,0);
  const first=await chat(a,'media-benchmark','我在做社区书店的账号，第一步怎么选样本？');
  assert.deepEqual(await api(a,first.input,201),first.row);
  await api(a,{...first.input,mode:'task'},409);
  await chat(a,'media-benchmark','那开场应该看什么？');
  assert.equal(calls.length,2);
  assert.equal(calls[1].route,'/chat/completions');
  assert.deepEqual(calls[1].body.messages.slice(-3),[
    {role:'user',content:first.input.text},{role:'assistant',content:first.row.reply},
    {role:'user',content:'那开场应该看什么？'}
  ]);
  await chat(a,'media-account','那开场应该看什么？');
  await chat(b,'media-benchmark','那开场应该看什么？');
  assert.deepEqual(calls.slice(2).map(call=>call.body.messages.map(message=>message.role)),[
    ['system','user'],['system','user']
  ]);
  assert.equal((await api(a)).files.length,0);

  const assistant=await api(a,{id:crypto.randomUUID(),bot:'teaching-bot',text:'怎么练习对比开场？',mode:'task'},201);
  for(let attempt=0;attempt<100;attempt++){
    const {messages,files}=await api(a);
    const row=messages.find(item=>item.id===assistant.id);
    if(row.status==='done'){
      assert.ok(row.room);
      assert.equal(row.reply,'可以先对比两条视频的开场。');
      assert.equal(row.outputs.length,1);
      const [file]=files;
      assert.equal(file.id,row.outputs[0]);
      const saved=await readFile(path.join(dir,'甲','群组文档',file.diskName),'utf8');
      assert.match(saved,/可以先对比两条视频的开场。/);
      assert.deepEqual((await api(b)).files,[]);
      return;
    }
    assert.equal(row.status,'working',row.reply);
    await delay(30);
  }
  assert.fail('Teaching assistant assignment did not finish.');
});

test('group dispatch, owned files, teaching access and restart', {timeout:120000},async t=>{
  const previous=process.env.HYPER_BOT_TEACHING_ROOT;
  if(process.env.HYPER_BOT_TEACHING_TEST_ROOT)process.env.HYPER_BOT_TEACHING_ROOT=process.env.HYPER_BOT_TEACHING_TEST_ROOT;
  t.after(()=>{if(previous===undefined)delete process.env.HYPER_BOT_TEACHING_ROOT;else process.env.HYPER_BOT_TEACHING_ROOT=previous;});
  const dir=await mkdtemp(path.join(await realpath(os.tmpdir()),'hb-groups-'));
  const options={data:path.join(dir,'host')};
  let host=await launch({options});
  const teachingReady=host.config.teaching.ok&&host.config.teaching.lessons.ok;
  t.after(async()=>{try{await host?.close();}finally{await rm(dir,{recursive:true,force:true});}});
  async function api(route,body,status=200,token=''){
    const res=await fetch(host.origin+'/api'+route,{method:body===undefined?'GET':'POST',
      headers:{'Content-Type':'application/json','X-Hyper-Bot':'1','X-Hyper-Teaching':token},body:JSON.stringify(body)});
    const value=await res.json();assert.equal(res.status,status,route+' '+JSON.stringify(value));return value;
  }
  const bots=['teaching-classroom','teaching-practice','teaching-students','media-full','media-music','media','media-account','media-benchmark'];
  const groups=[];
  for(const name of ['甲','乙']){
    const folder=path.join(dir,name);await mkdir(folder);
    groups.push(await api('/v1/workspaces',{name,folder,bots},201));
  }
  const [a,b]=groups.map(g=>'/v1/workspaces/'+g.id);
  await api('/v1/workspaces',{name:'重复文件夹',folder:path.join(dir,'甲'),bots},409);
  await api(a+'/group-chat',{id:crypto.randomUUID(),text:'写稿',bot:'media-review'},422);
  const send=(base,bot,text,files=[])=>api(base+'/group-chat',{id:crypto.randomUUID(),bot,text,files},201);
  const note={id:crypto.randomUUID(),text:'本群记录'};
  await api(a+'/group-chat',note,201);await api(a+'/group-chat',note,201);
  assert.equal((await api(a+'/group-chat')).messages.length,1);
  const catalog=(await api(a+'/workspace')).bots;
  for(const bot of ['media','media-account','media-benchmark']){
    const entry=catalog.find(item=>item.id===bot&&item.status==='enabled');
    const question={id:crypto.randomUUID(),bot,text:'简述你的功能。'};
    const answer=await api(a+'/group-chat',question,201);
    assert.equal(answer.status,'done');
    assert.equal(answer.reply,entry.description+'\n需要：'+entry.input+'\n交付：'+entry.output);
    assert.equal(answer.room,undefined);
    assert.deepEqual(await api(a+'/group-chat',question,201),answer);
  }
  const material='Our reading club meets in the library on Fridays. Bring your notebook and register on Thursday. Emma will compare two stories and share one detail with a partner. This week the meeting is in Room 204.';
  async function upload(base,name,bytes){
    const response=await fetch(host.origin+'/api'+base+'/group-files?name='+encodeURIComponent(name),{method:'POST',
      headers:{'Content-Type':'application/octet-stream','X-Hyper-Bot':'1'},body:bytes});
    const file=await response.json();assert.equal(response.status,201,JSON.stringify(file));return file;
  }
  const source=await upload(a,'lesson.txt',material),other=await upload(b,'lesson.txt','Second group.');
  assert.notEqual(source.id,other.id);
  assert.equal((await fetch(host.origin+'/api'+b+'/group-files/'+source.id)).status,404);
  await api(b+'/group-chat',{id:crypto.randomUUID(),bot:'teaching-classroom',text:'生成课件',files:[source.id]},404);
  const wait=async(base,id)=>{
    for(let i=0;i<180;i++){const info=await api(base+'/group-chat'),m=info.messages.find(m=>m.id===id);
      if(['done','input'].includes(m.status))return m;
      assert.ok(!['interrupted','failed'].includes(m.status),m.reply);await delay(300);}
    assert.fail('No completed group message');
  };
  if(teachingReady){
    for(const kind of ['classroom','practice']){
      const task=await send(a,'teaching-'+kind,'根据材料制作阅读练习',[source.id]);
      const finished=await wait(a,task.id);assert.equal(finished.outputs.length,2);
      for(const id of finished.outputs){const file=(await api(a+'/group-chat')).files.find(f=>f.id===id);
        const disk=await readFile(path.join(dir,'甲','群组文档',file.diskName));
        assert.ok(disk.length>150);if(file.name.endsWith('.pptx'))assert.equal(disk.subarray(0,2).toString(),'PK');
        const download=await fetch(host.origin+'/api'+a+'/group-files/'+id);
        assert.equal(download.status,200);assert.ok(Buffer.from(await download.arrayBuffer()).equals(disk));
        if(file.name.endsWith('.html')){
          const preview=await fetch(host.origin+'/api'+a+'/group-files/'+id+'/preview');
          assert.equal(preview.status,200);assert.match(preview.headers.get('content-security-policy'),/sandbox allow-scripts/);
          assert.equal((await fetch(host.origin+'/api'+b+'/group-files/'+id+'/preview')).status,404);
        }
      }
    }
    const m=await send(a,'teaching-students','新增一名虚构学员');assert.equal((await wait(a,m.id)).status,'input');
    const native=a+'/rooms/'+m.room+'/teaching',trial=await api(native+'/trial',{}),token=trial.token;
    const account=await api(native+'/record-write',{key:crypto.randomUUID(),record:'',action:'students',input:{name:'Synthetic User',code:'',className:'',track:'k12',status:'active'}},200,token);
    assert.ok(account.student.id);assert.equal((await wait(a,m.id)).status,'done');
    const second=await send(b,'teaching-students','列出学员');
    const result=await wait(b,second.id);assert.equal(result.outputs.length,1);
    const res=await fetch(host.origin+'/api'+b+'/group-files/'+result.outputs[0]);assert.deepEqual((await res.json()).students,[]);
    const own=await send(a,'teaching-students','列出学员');
    const view=await wait(a,own.id);
    assert.equal((await (await fetch(host.origin+'/api'+a+'/group-files/'+view.outputs[0])).json()).students[0].id,account.student.id);
    const bRoom=b+'/rooms/'+result.room+'/teaching';
    await api(bRoom+'/records',undefined,401,token);
  }
  const before=await api(a+'/group-chat');await host.close();host=await launch({options});
  assert.deepEqual(await api(a+'/group-chat'),before);
  assert.equal((await api(b+'/group-chat')).messages.some(m=>m.id===note.id),false);
  await host.close();host=null;
  const archive=path.join(dir,'archive'),restored=path.join(dir,'restored');
  const snapshot=await backupWorkspace(options.data,archive);
  assert.ok(snapshot.manifest.files.some(f=>f.path.includes('/group-documents/')));
  assert.ok(!snapshot.manifest.files.some(f=>/accounts.json|localhost.key|group-folder.json/.test(f.path)));
  await restoreWorkspace(archive,restored);host=await launch({options:{data:restored}});
  const newFolder=path.join(dir,'恢复群');await mkdir(newFolder);
  assert.equal((await api(a+'/group-chat')).folder,'');
  await api(a+'/group-folder',{folder:newFolder});
  assert.equal(await (await fetch(host.origin+'/api'+a+'/group-files/'+source.id)).text(),material);
  assert.equal(await readFile(path.join(dir,'甲','群组文档',source.diskName),'utf8'),material);
  if(teachingReady){
    const restoredTask=await send(a,'teaching-students','导出恢复的学员记录');
    const finished=await wait(a,restoredTask.id);
    const res=await fetch(host.origin+'/api'+a+'/group-files/'+finished.outputs[0]);
    assert.equal((await res.json()).students[0].name,'Synthetic User');
    const directory=process.env.HYPER_BOT_TEACHING_ROOT;
    try{
      process.env.HYPER_BOT_TEACHING_ROOT=path.join(dir,'missing-installation');
      await api('/dependencies',{});
      const unavailable=(await api('/workspace')).bots.find(bot=>bot.id==='teaching-practice');
      assert.ok(unavailable.blocked);
    }finally{
      if(directory===undefined)delete process.env.HYPER_BOT_TEACHING_ROOT;
      else process.env.HYPER_BOT_TEACHING_ROOT=directory;
    }
    await api('/dependencies',{});
    assert.equal((await api('/workspace')).bots.find(bot=>bot.id==='teaching-practice').blocked,'');
  }
  await writeFile(path.join(newFolder,'群组文档',source.diskName),'local edit');
  assert.equal((await fetch(host.origin+'/api'+a+'/group-files/'+source.id)).status,409);
  assert.equal(await readFile(path.join(dir,'甲','群组文档',source.diskName),'utf8'),material);
});

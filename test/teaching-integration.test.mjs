import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { launch } from '../server/http.mjs';
import { backupWorkspace, restoreWorkspace } from '../server/workspace-archive.mjs';

const nativeRoot=process.env.HYPER_BOT_TEACHING_TEST_ROOT;
test('teaching projects produce interactive lessons and reviewed practice', {timeout:180000},async t=>{
  const parent=await realpath(tmpdir());
  const scratch=await mkdtemp(path.join(parent,'hb-teaching-test-'));
  const data=path.join(scratch,'native');
  let gateway,host,password,model;
  t.after(async()=>{
    try {await host?.close();}
    finally {
      if(gateway?.pid&&gateway.exitCode===null&&gateway.signalCode===null){
        const exited=once(gateway,'exit');gateway.kill();await exited;
      }
      if(model){
        const closed=once(model,'close');
        model.close();model.closeAllConnections();
        await closed;
      }
      const resolved=await realpath(scratch);
      assert.equal(path.dirname(resolved),parent);
      assert.match(path.basename(resolved),/^hb-teaching-test-/);
      await rm(resolved,{recursive:true,force:true,maxRetries:6,retryDelay:120});
    }
  });
  const keys=['HYPER_BOT_TEACHING_ROOT','HYPER_BOT_TEACHING_ACCESS','HYPER_BOT_TEACHING_PORT','HYPER_BOT_TEACHING_CA'];
  const prior=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  t.after(()=>{for(const key of keys){if(prior[key]===undefined)delete process.env[key];else process.env[key]=prior[key];}});
  if(nativeRoot){
    await mkdir(data);
    password=randomUUID();
    await writeFile(path.join(data,'accounts.json'),JSON.stringify({teacher:password,reviewer:randomUUID()}),{mode:0o600});
    const cert=path.join(data,'localhost.crt'), key=path.join(data,'localhost.key');
    const gitOpenSSL=path.join(process.env.ProgramFiles??'','Git','usr','bin','openssl.exe');
    const openssl=process.env.M0_OPENSSL||(process.platform==='win32'&&existsSync(gitOpenSSL)?gitOpenSSL:'openssl');
    execFileSync(openssl,['req','-x509','-newkey','rsa:2048','-nodes','-days','2','-subj','/CN=127.0.0.1',
      '-addext','subjectAltName=IP:127.0.0.1','-keyout',key,'-out',cert],{stdio:'ignore',windowsHide:true});
    const portProbe=net.createServer().listen(0,'127.0.0.1');
    await once(portProbe,'listening');
    const port=String(portProbe.address().port);
    await new Promise(resolve=>portProbe.close(resolve));
    gateway=spawn(process.execPath,['--import','tsx','server/gateway.ts'],{cwd:nativeRoot,windowsHide:true,
      env:{...process.env,M0_DATA:data,M0_PORT:port,M0_DS_BOT_TOKEN:'',PYTHONDONTWRITEBYTECODE:'1'},
      stdio:['ignore','pipe','ignore']});
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Teaching gateway startup timed out')),20000);
      gateway.stdout.on('data',chunk=>{if(chunk.toString().includes('listening')){clearTimeout(timer);resolve();}});
      gateway.once('error',error=>{clearTimeout(timer);reject(error);});
      gateway.once('exit',code=>{clearTimeout(timer);reject(new Error('Teaching gateway exited '+code));});
    });
    // This test runs in its own node:test child process.
    process.env.HYPER_BOT_TEACHING_PORT=port;
    process.env.HYPER_BOT_TEACHING_CA=cert;
    process.env.HYPER_BOT_TEACHING_ACCESS="teacher";
  }else{
    delete process.env.HYPER_BOT_TEACHING_ROOT;
    process.env.HYPER_BOT_TEACHING_ACCESS='trial';
  }
  const prompts=[];
  if(!nativeRoot){
    model=http.createServer(async (request,response)=>{
      const chunks=[];
      for await(const chunk of request)chunks.push(chunk);
      prompts.push(JSON.parse(Buffer.concat(chunks)).messages);
      response.writeHead(200,{'Content-Type':'application/json'});
      response.end(JSON.stringify({id:'teaching-fixture',choices:[{finish_reason:'stop',
        message:{role:'assistant',content:'可以先让学生找出活动发生的时间。'}}],
        usage:{prompt_tokens:40,completion_tokens:20,prompt_cache_hit_tokens:0}}));
    }).listen(0,'127.0.0.1');
    await once(model,'listening');
  }
  const options={data:path.join(scratch,'hyper-bot'),...(model?{providerKey:'fixture',upstream:'http://127.0.0.1:'+model.address().port}:{})};
  host=await launch({options});
  if(!nativeRoot){
    assert.equal(host.config.teaching.bundled,true,host.config.teaching.reason);
    assert.ok(host.config.teaching.lessons.ok,'Run npm run setup:teaching before this test.');
  }
  let token='';
  async function request(route,body,status=200){
    const multipart=body instanceof FormData;
    const response=await fetch(host.origin+'/api'+route,{method:body===undefined?'GET':'POST',
      headers:{'X-Hyper-Bot':'1','X-Hyper-Teaching':token,...(multipart?{}:{'Content-Type':'application/json'})},
      body:multipart?body:JSON.stringify(body)});
    assert.equal(response.status,status,route);
    if(response.headers.get('content-type')?.includes('application/json'))return response.json();
    return Buffer.from(await response.arrayBuffer());
  }
  async function projectTask(room,action,input,assets){
    const body={key:randomUUID(),action,input,assets};
    const accepted=await request(room+'/submit',body,202);
    assert.equal((await request(room+'/submit',body,202)).task_id,accepted.task_id);
    for(let i=0;i<180;i++){
      const project=await request(room+'/project');
      const task=project.tasks.find(row=>row.task_id===accepted.task_id);
      if(task?.status==='succeeded')return request(room+'/artifact?id='+task.artifact_ids[0]);
      assert.ok(!['interrupted','failed'].includes(task?.status),task?.summary);
      await pause(500);
    }
    throw new Error('Timed out waiting for '+action);
  }
  const directory='/teaching/students';
  const before=await request('/workspace');
  await request(directory+'/records',undefined,401);
  const {token:directoryToken}=await request(directory+(nativeRoot?'/login':'/trial'),nativeRoot?{password}:{});
  token=directoryToken;
  let student;
  if(!nativeRoot){
    ({student}=await request(directory+'/record-write',{action:'students',record:'',key:randomUUID(),
      input:{name:'合成学员',code:'synthetic',className:'合成班级',track:'k12',status:'active'}}));
    assert.equal((await request(directory+'/detail?id='+student.id)).student.id,student.id);
    assert.equal((await request(directory+'/records?q=synthetic')).students[0].id,student.id);
    const after=await request('/workspace');
    assert.deepEqual(after.conversations,before.conversations);
    assert.deepEqual(after.sidebarBots,before.sidebarBots);
    const group=await request('/v1/workspaces',{name:'档案访问范围测试'},201);
    await request('/v1/workspaces/'+group.id+directory+'/records',undefined,404);
  }
  const rooms={};
  for(const kind of ['classroom','practice']){
    const {id}=await request('/bot-instances',{botId:'teaching-'+kind});
    rooms[kind]='/rooms/'+id+'/teaching';
  }
  token='';
  await request(rooms.classroom+'/project',undefined,401);
  token=directoryToken;
  const material='Our reading club meets in the library on Fridays. Bring your notebook and register on Thursday. Emma will compare two stories and share one detail with a partner. This week the meeting is in Room 204.';
  const ids={};
  for(const [kind,room] of Object.entries(rooms)){
    await request(room+'/bind',kind==='classroom'?{track:'k12'}:{});
    const upload=new FormData();upload.append('file',new Blob([material]),'reading-club.txt');
    ids[kind]=(await request(room+'/upload',upload,201)).asset_id;
  }
  const lesson=await projectTask(rooms.classroom,'generate_lesson',{track:'k12'},[ids.classroom]);
  assert.equal(lesson.kind,'lesson');
  const slides=await request(rooms.classroom+'/download?id='+lesson.artifact_id+'&format=pptx');
  assert.equal(slides.subarray(0,2).toString(),'PK');
  await request(rooms.practice+'/artifact?id='+lesson.artifact_id,undefined,404);
  const analysis=await projectTask(rooms.practice,'identify_learning_targets',{},[ids.practice]);
  const pack=await projectTask(rooms.practice,'design_practice_pack',{analysis_id:analysis.artifact_id,
    target_ids:[analysis.targets[0].id],mode:'mixed',methods:[],difficulty:'standard',sequence:'standard'},[]);
  assert.equal(pack.kind,'practice_pack');
  const versions=await Promise.all(['student','teacher'].map(format=>
    request(rooms.practice+'/download?id='+pack.artifact_id+'&format='+format)));
  assert.ok(versions.every(bytes=>bytes.length>100));
  assert.ok(!versions[0].equals(versions[1]));
  if(!nativeRoot){
    const catalog=(await request('/workspace')).bots.filter(bot=>bot.category==='英语教培');
    assert.equal(catalog.length,10);
    assert.ok(catalog.every(bot=>!bot.blocked));
    for(const kind of ['calendar','signals','history','renewals','students','enrollments','learning']){
      const {id}=await request('/bot-instances',{botId:'teaching-'+kind});
      rooms[kind]='/rooms/'+id+'/teaching';
    }
    const write=(kind,action,input,record='')=>request(rooms[kind]+'/record-write',{action,input,record,key:randomUUID()});
    const calendar=await write('calendar','calendar',{title:'合成校历',track:'k12',date:'2024-07-01',leadDays:7,
      recurrence:'once',status:'confirmed',sourceUrl:'',details:''});
    assert.ok((await request(rooms.calendar+'/records')).calendar.some(row=>row.id===calendar.id));
    const signal=await write('signals','signals',{kind:'hotspot',title:'合成资讯',track:'all',region:'测试',
      sourceUrl:'https://www.ets.org/toefl/',publishedOn:'2024-07-01',effectiveOn:null,status:'unverified',facts:'合成摘要',reviewNotes:''});
    assert.ok((await request(rooms.signals+'/records')).signals.some(row=>row.id===signal.id));

    const renewalCSV='id,label,track,endOn,remainingLessons,attendancePct,feedback,issue,state,contactAllowed,lastContactOn\n'+
      'sample-term,合成课程段,k12,2024-07-31,2,95,positive,none,unpaid,true,';
    assert.equal((await write('history','renewalImport',{csv:renewalCSV})).imported,1);
    const historyCSV='id,track,asOf,endOn,observedThrough,renewed,arm,randomized,experimentId,feedback,attendancePct,state\n'+
      'sample-history,k12,2024-07-01,2024-07-31,2024-08-15,true,standard,false,,positive,95,unpaid';
    assert.equal((await write('history','historyImport',{csv:historyCSV})).imported,1);
    await write('renewals','renewals',{date:'2024-07-10',outcome:'contacted',note:'合成跟进'},'sample-term');
    assert.equal((await request(rooms.renewals+'/records')).followUps['sample-term'][0].note,'合成跟进');
    assert.equal((await request(rooms.students+'/records?q=synthetic')).students[0].id,student.id);
    await write('enrollments','link',{enrollmentId:'sample-term'},student.id);
    let detail=await request(rooms.enrollments+'/detail?id='+student.id);
    assert.equal(detail.enrollments[0].id,'sample-term');
    await write('enrollments','unlink',{enrollmentId:'sample-term'},student.id);
    detail=await request(rooms.enrollments+'/detail?id='+student.id);
    assert.deepEqual(detail.enrollments,[]);
    await write('learning','learning',{artifactId:lesson.artifact_id,status:'used',occurredOn:null,note:'合成课件记录'},student.id);
    assert.equal((await request(rooms.learning+'/detail?id='+student.id)).learning[0].artifactId,lesson.artifact_id);
    assert.equal((await request(directory+'/detail?id='+student.id)).learning[0].artifactId,lesson.artifact_id);

    const assistant=(await request('/bot-instances',{botId:'teaching-bot'})).id;
    async function ask(text){
      const input={requestId:randomUUID(),text,evidence:'只使用合成教材。'};
      const submitted=await request('/rooms/'+assistant+'/teaching-assistant',input,202);
      assert.equal((await request('/rooms/'+assistant+'/teaching-assistant',input,202)).id,submitted.id);
      for(let i=0;i<100;i++){
        const run=(await request('/rooms/'+assistant)).runs.find(item=>item.id===submitted.id);
        if(run.state==='succeeded'){
          assert.ok(run.teachingReply.includes('活动'));
          assert.equal(run.usage.requests,1);
          assert.equal(run.teachingEvidence,undefined);
          return;
        }
        assert.ok(!['interrupted','failed'].includes(run.state),run.error);
        await pause(25);
      }
      assert.fail('Timed out waiting for assistant');
    }
    await ask('怎么教阅读定位？');
    await ask('再给我一个问题。');
    assert.equal(prompts.length,2);
    assert.ok(prompts[1].some(message=>message.role==='user'&&message.content==='怎么教阅读定位？'));
    assert.ok(prompts[1].some(message=>message.role==='assistant'));
  }
  await request(rooms.practice+'/logout',{});
  await request(rooms.classroom+'/project',undefined,401);
  if(!nativeRoot){
    await host.close();
    host=null;
    const archive=path.join(scratch,'backup');
    const restored=path.join(scratch,'restored');
    const backup=await backupWorkspace(options.data,archive);
    assert.ok(backup.manifest.files.some(file=>file.path==='teaching-trial/m0.sqlite'));
    assert.ok(!backup.manifest.files.some(file=>file.path==='teaching-trial/accounts.json'));
    await restoreWorkspace(archive,restored);
    host=await launch({options:{...options,data:restored}});
    token=(await request(rooms.classroom+'/trial',{})).token;
    const restoredSlides=await request(rooms.classroom+'/download?id='+lesson.artifact_id+'&format=pptx');
    assert.ok(slides.equals(restoredSlides));
  }
});

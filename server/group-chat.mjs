import {createReadStream,openAsBlob} from 'node:fs';
import {readFile,stat} from 'node:fs/promises';
import {Readable} from 'node:stream';
import {setTimeout as delay} from 'node:timers/promises';
import {z} from 'zod';
import {dependencyStatus} from './config.mjs';
import {Problem,id,message,botKey} from './contracts.mjs';
import {artifactBundle} from './export.mjs';
import {binding,groupFile,saveGroupFile} from './group-files.mjs';
import {provider} from './provider.mjs';
import {windowHeader} from './window-session.mjs';

const taskInput=z.strictObject({id,bot:botKey.optional(),text:message,files:z.array(id).max(8).default([]),
  mode:z.enum(['chat','task']).optional()});
const asksAboutCapabilities=/^(?:请\s*)?(?:(?:简述|(?:简单|简要)?介绍)(?:一下)?(?:你的功能|你自己)|你(?:能做什么|有(?:什么|哪些)功能))[。！？.!?]*$/u;
const pending=row=>row.status==='working'||row.status==='approval';
const busy=(rows,{bot,mode})=>rows.some(row=>pending(row)&&
  (mode==='chat'?row.mode==='chat'&&row.bot===bot:row.mode!=='chat'));
const clean=value=>value.replace(/[\\/:*?"<>|\p{Cc}]/gu,'-').slice(0,75)||'成果';
export const onsetCsv=tracks=>'\ufeff素材,时间（秒）,相对强度\r\n'+tracks.flatMap(t=>t.candidates.map(mark=>
  '"'+String(t.素材).replaceAll('"','""')+'",'+mark.source_time+','+mark.relative_strength)).join('\r\n');

async function replyInGroup(host,bot,msg,signal){
  const {config}=host.app;
  const credential=dependencyStatus(config).checks.provider;
  if(!credential.ok)throw new Problem(503,credential.reason,'dependency_unavailable');
  const recent=host.store.read().groupMessages.filter(row=>row.bot===bot.id&&row.status==='done'&&!row.room&&row.reply).slice(-6);
  const messages=[
    {role:'system',content:[
      '你是 Hyper Bot 群聊中的「'+bot.name+'」。用用户的语言自然、简明地对话，结合已经收到的上下文回答。',
      '你的职责：'+bot.description,'专项任务所需材料：'+bot.input,'专项任务交付：'+bot.output,
      '可以讨论思路、解释怎么使用和回答追问。需要实际执行专项工作时，请说明所需材料，并提示用户选择「派发任务」。',
      '本轮只有文字对话。不要声称已读取文件、完成专项任务、保存或发布成果。'
    ].join('\n')},
    ...recent.flatMap(row=>[{role:'user',content:row.text.slice(0,1800)},{role:'assistant',content:row.reply.slice(0,1800)}]),
    {role:'user',content:msg.text}
  ];
  const timeout=AbortSignal.timeout(config.timeoutMs);
  const actual=AbortSignal.any([signal,timeout]);
  const gateway=await provider(config,actual);
  try{
    const response=await fetch(gateway.url+'/chat/completions',{method:'POST',signal:actual,redirect:'error',
      headers:{'Content-Type':'application/json'},body:JSON.stringify({model:config.model,messages,
        thinking:{type:'disabled'},max_tokens:1024,stream:false})});
    if(!response.ok)throw gateway.error()??new Problem(502,'模型服务未能回复，请重试。','provider_error');
    const choice=(await response.json()).choices?.[0];
    const content=choice?.message?.content;
    if(!gateway.complete()||choice?.finish_reason!=='stop'||typeof content!=='string'||!content.trim()){
      throw new Problem(502,'模型未返回完整回复，请重试。','provider_error');
    }
    return {reply:content.trim(),usage:{...gateway.usage}};
  }catch(error){
    if(timeout.aborted&&!signal.aborted)throw new Problem(504,'回复超时，请重新发送。','chat_timeout');
    throw gateway.error()??error;
  }finally{await gateway.close();}
}

export function groupChat(originOf,windowKey) {
  const sending=new WeakMap();
  const active=new Map(),controller=new AbortController(),signal=controller.signal;
  const patch=(host,id,fields)=>host.store.change(state=>Object.assign(state.groupMessages.find(m=>m.id===id),fields,
    ['done','failed','interrupted'].includes(fields.status)?{finishedAt:new Date().toISOString()}:{}));
  async function work(host,msg){
    const app=host.app, members=app.index().bots,bot=members.find(b=>b.id===msg.bot&&b.status==='enabled');
    if(!bot)throw new Problem(422,'这位成员已停用。');
    if(msg.mode==='chat'){
      const answer=await replyInGroup(host,bot,msg,signal);
      patch(host,msg.id,{status:'done',...answer});
      return;
    }
    const room=msg.room;
    const inputs=await Promise.all(msg.files.map(key=>groupFile(host,key)));
    const saved=[];
    async function save(name,source) {
      const f=await saveGroupFile(host,name,source,{key:msg.id+'/'+name});
      saved.push(f.id);
      patch(host,msg.id,{outputs:[...saved]});
    }
    const markdown=(title,text)=>save(clean(title)+'.md',Buffer.from('# '+title+'\n\n'+text+'\n'));
    if(bot.kind==='teaching'&&bot.target!=='bot'){
      const base=originOf()+'/api/v1/workspaces/'+host.group.id+'/rooms/'+room+'/teaching/';
      let token;
      async function call(action,body,binary=false){
        const form=body instanceof FormData;
        const headers={'X-Hyper-Bot':'1',...(windowKey?{[windowHeader]:windowKey}:{}),...(token?{'X-Hyper-Teaching':token}:{}),
          ...(body!==undefined&&!form?{'Content-Type':'application/json'}:{})};
        const res=await fetch(base+action,{method:body===undefined?'GET':'POST',headers,body:form?body:JSON.stringify(body),signal,redirect:'error'});
        if(!res.ok)throw new Problem(res.status,(await res.json()).error);
        return binary?Readable.fromWeb(res.body):res.json();
      }
      token=(await call('trial',{})).token;
      try {
        if(['operations','students'].includes(bot.target)){
          if(!/^(查看|查询|列出|导出|读取|统计|显示)/u.test(msg.text)){
            patch(host,msg.id,{status:'input',reply:'请填写记录并确认保存。',room});return;
          }
          const records=await call('records');
          await save(bot.name+'.json',Buffer.from(JSON.stringify(records,null,2)));
          patch(host,msg.id,{status:'done',reply:bot.name+'已导出。'});return;
        }
        if(inputs.length!==1)throw new Problem(422,'请附上一份教材文件，再派发此任务。');
        const {file,target}=inputs[0];
        if(file.size>32*1024*1024)throw new Problem(413,'教材最大 32 MiB。');
        const project=await call('bind',{track:'k12',title:host.group.name+' · '+bot.name});
        const form=new FormData();form.append('file',await openAsBlob(target),file.name);
        const asset=(await call('upload',form)).asset_id;
        const lesson=bot.target==='classroom';
        async function task(action,input,assets,key){
          const receipt=await call('submit',{action,input,assets,key});
          for(let i=0;i<420;i++){
            const p=await call('project'),row=p.tasks.find(t=>t.task_id===receipt.task_id);
            if(row?.status==='succeeded')return call('artifact?id='+row.artifact_ids[0]);
            if(['failed','interrupted'].includes(row?.status))throw new Problem(422,row.summary);
            await delay(500,undefined,{signal});
          }
          throw new Problem(504,'任务仍在教培工作台执行，请打开成员会话核对。');
        }
        let card=await task(lesson?'generate_lesson':'identify_learning_targets',lesson?{track:project.track,goal:msg.text.slice(0,300)}:{focus:msg.text.slice(0,300)},[asset],msg.id);
        if(!lesson){
          if(!card.targets?.length)throw new Problem(422,'未找到可用知识点。');
          card=await task('design_practice_pack',{analysis_id:card.artifact_id,target_ids:card.targets.slice(0,3).map(t=>t.id),
            methods:[],mode:'mixed',difficulty:'standard',sequence:'standard'},[],msg.followUp);
        }
        for(const format of lesson?['html','pptx']:['student','teacher']){
          const ext=format==='pptx'?'pptx':'html';
          await save(clean(card.title)+'-'+({student:'学生版',teacher:'教师版'}[format]||format)+'.'+ext,
            await call('download?id='+card.artifact_id+'&format='+format,undefined,true));
        }
        patch(host,msg.id,{status:'done',reply:card.title});return;
      }finally{await call('logout',{}).catch(()=>{});}
    }
    let run=host.store.read().runs.find(r=>r.clientRequestId===msg.id);
    if(!run){
      if(bot.blocked)throw new Problem(503,bot.blocked);
      if(bot.id==='teaching-bot'){
        const excerpts=[];
        for(const {file,target} of inputs){
          if(!/\.(md|txt|csv|json)$/i.test(file.name)||file.size>16000)throw new Problem(422,'助手接收 16 KB 以内的文字材料。');
          excerpts.push(await readFile(target,'utf8'));
        }
        const evidence=excerpts.join('\n');
        if(evidence.length>16000)throw new Problem(422,'助手的文字材料总计最多 16000 字符。');
        run=app.startTeachingAssistant(room,{requestId:msg.id,text:msg.text,evidence});
      }else if(bot.kind==='workbench'){
        for(const {file,target} of inputs){
          const stream=createReadStream(target);stream.headers={'content-length':String((await stat(target)).size)};
          try{await app.uploadSpecialist(room,file.name,stream);}finally{stream.destroy();}
        }
        run=app.startSpecialist(room,{requestId:msg.id,text:msg.text,authorized:true});
      }else{
        const attachments=[];
        for(const {file,target} of inputs){
          if(file.size>64000||!/\.(md|txt)$/i.test(file.name))throw new Problem(422,'请选择 64 KB 以内的 TXT 或 Markdown。');
          attachments.push(app.upload(room,{name:file.name,content:await readFile(target,'utf8'),authorized:true}));
        }
        run=await app.start(room,{clientRequestId:msg.id,authorized:true,text:msg.text,attachments});
      }
    }
    patch(host,msg.id,{run:run.id});
    for(;;){
      signal.throwIfAborted();
      const state=host.store.read();
      const job=state.runs.find(r=>r.id===run.id);
      if(job.state==='succeeded'){
        if(job.teachingReply){
          await markdown('教培任务回复',job.teachingReply);
          patch(host,msg.id,{status:'done',reply:job.teachingReply});
          return;
        }
        const out=job.specialistResult;
        if(out){
          if(out.details) {
            if(bot.mode==='onsets')await save('音乐卡点.csv',Buffer.from(onsetCsv(out.details)));
            else if(out.details.回复)await markdown(out.title,out.details.回复);
            else await save(clean(out.title)+'.json',Buffer.from(JSON.stringify(out.details,null,2)));
          }
          for(const f of out.files??[]){
            const native=app.specialistFile(room,job.id,f.name);
            const res=await fetch(await app.workbench.ensure()+native.route,{redirect:'error',signal,headers:{'X-Hyper-Bot-Bridge':app.workbench.bridgeKey}});
            if(!res.ok)throw new Problem(502,'成片读取失败。');await save(f.name,Readable.fromWeb(res.body));
          }
        }else{
          const record=state.artifacts.find(f=>f.run===job.id);
          if(!record)throw new Problem(404,'未找到本次任务的稿件。');
          const doc=artifactBundle(host.store,record.id,false);await save(doc.filename,Buffer.from(doc.markdown));
        }
        patch(host,msg.id,{status:'done',reply:out?.details?.回复??out?.title??'稿件已保存。'});return;
      }
      if(['failed','cancelled','interrupted'].includes(job.state))throw new Problem(422,job.error||'任务已中断。');
      if(job.state==='waiting_approval'&&state.groupMessages.find(m=>m.id===msg.id)?.status!=='approval')
        patch(host,msg.id,{status:'approval',reply:'请在成员会话中确认写入。'});
      await delay(450,undefined,{signal});
    }
  }
  function launch(host,msg){
    const k=host.group.id+'/'+msg.id;
    if(active.has(k))return;
    const op=work(host,msg).catch(e=>{
      if(!signal.aborted)patch(host,msg.id,{status:'failed',reply:e instanceof Problem?e.message:
        msg.mode==='chat'?'暂时无法回复，请重新发送。':'未能保存或执行任务，请核对文件夹和运行环境。'});
    }).finally(()=>active.delete(k));
    active.set(k,op);
  }
  async function send(host,raw){
    const input=taskInput.parse(raw),state=host.store.read();
    if(!(await binding(host)))throw new Problem(409,'请先为群组绑定文件夹。');
    const prior=(state.groupMessages??[]).find(m=>m.id===input.id);
    if(prior){if(prior.text!==input.text||prior.bot!==input.bot||prior.mode!==input.mode||JSON.stringify(prior.files)!==JSON.stringify(input.files))throw new Problem(409,'消息编号冲突。');return prior;}
    if(input.mode&&!input.bot)throw new Problem(422,'请先选择一位 Bot。');
    if(input.mode==='chat'&&input.files.length)throw new Problem(422,'带文件的消息请选择「派发任务」。');
    for(const key of input.files)await groupFile(host,key);
    if(input.bot&&!state.installedBots?.includes(input.bot))throw new Problem(422,'只能 @ 本群成员。');
    const introduction=input.bot&&input.mode!=='task'&&!input.files.length&&asksAboutCapabilities.test(input.text);
    if(input.bot&&!introduction&&busy(state.groupMessages??[],input))throw new Problem(409,
      input.mode==='chat'?'请等待这位 Bot 回复。':'请等待本群当前任务完成。');
    const row={...input,createdAt:new Date().toISOString(),status:input.bot?'working':'sent'};
    if(input.bot){
      const bot=host.app.index().bots.find(b=>b.id===input.bot&&b.status==='enabled');
      if(!bot)throw new Problem(422,'成员不可用。');
      if(introduction){
        row.status='done';
        row.finishedAt=row.createdAt;
        row.reply=bot.description+'\n需要：'+bot.input+'\n交付：'+bot.output;
      }else if(input.mode!=='chat'){
        // Each assignment has a separate input staging area. Reuse teaching records within this group.
        row.room=await host.app.open({botId:bot.id,revision:bot.revision,title:input.text.slice(0,80)});
        row.followUp=crypto.randomUUID();
      }
    }
    const stored=host.store.change(s=>{
      const rows=s.groupMessages??=[],old=rows.find(m=>m.id===row.id);
      if(old)return old;
      if(row.status==='working'&&busy(rows,row))throw new Problem(409,'本群当前消息仍在处理。');
      rows.push(row);return row;
    });
    if(stored===row&&row.status==='working')launch(host,row);
    return stored;

  }
  return {async view(host){
    const state=host.store.read(),rows=state.groupMessages??[];
    for(const row of rows.filter(pending)){
      const key=host.group.id+'/'+row.id;
      if(!active.has(key)){
        if(state.runs.some(r=>r.clientRequestId===row.id))launch(host,row);
        else patch(host,row.id,{status:'interrupted',reply:row.mode==='chat'?
          '本机服务已重启，请重新发送这条消息。':'主机已重启，请核对成员任务记录后重新派活。'});
      }
    }
    const folder=(await binding(host))?.folder??'';
    const snapshot=host.store.read();
    return {folder,messages:snapshot.groupMessages??[],files:snapshot.groupFiles??[]};
  },send(host,raw){
    const previous=sending.get(host)??Promise.resolve();
    const operation=previous.then(()=>send(host,raw));
    sending.set(host,operation.catch(()=>{}));
    return operation;
  },async close(){controller.abort();await Promise.allSettled(active.values());}};
}

import React,{useState,useEffect,useCallback,useRef} from 'react';
import {PanelRight,X} from 'lucide-react';
import {BotMark} from './components.jsx';
import {downloadFile} from './client.js';
import {openTeachingBot,studentDirectoryHref,teachingRequest} from './teaching-client.js';
import {TeachingRecords} from './teaching-records.jsx';
import {TeachingAccount,useTeachingSession} from './teaching-session.jsx';

const tracks={k12:'K12 英语',toefl:'托福',ielts:'雅思'};
const statusNames={queued:'排队中',running:'生成中',succeeded:'已完成',failed:'生成失败',interrupted:'已中断'};
const methods={single_choice:'单选',short_fill:'短填空',judgment_evidence:'判断与证据',short_response:'短表达',editing:'编辑英文草稿',sequencing:'语篇排序',planning:'活动策划',branching:'分支对话',relationship_map:'关系图',route:'读图指路',rule_discovery:'发现规则',rule_flip:'变换条件',student_questions:'学生出题',audience_messages:'按受众改写',comic:'漫画对白',dictogloss:'听后重建',listening_numbers:'数字听辨',predict_verify:'预测与验证',voice_revision:'口语修订'};
function Select({label,options,...props}){return <label>{label}<select aria-label={label} {...props}>{Object.entries(options).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></label>;}
function PracticeChoices({card,exec,busy}) {
  const [ids,setIds]=useState([]),[choices,setChoices]=useState([]),[picture,setPicture]=useState(null),[mode,setMode]=useState('mixed');
  const toggle=(value,list,set)=>set(list.includes(value)?list.filter(id=>id!==value):[...list,value]);
  return <form className="teach-fields" onSubmit={event=>{
    event.preventDefault();const f=new FormData(event.currentTarget);
    void exec('design_practice_pack',{analysis_id:card.artifact_id,target_ids:ids,methods:choices,mode:f.get('mode'),sequence:f.get('sequence'),difficulty:f.get('difficulty'),
      ...(picture&&f.get('alt')?{image_alt:f.get('alt')}:{})},picture);
  }}><fieldset disabled={busy}><legend>确认知识点（最多 3 项）</legend>{card.targets.map(t=><label key={t.id} className="teach-choice">
    <input type="checkbox" checked={ids.includes(t.id)} disabled={ids.length>=3&&!ids.includes(t.id)} onChange={()=>toggle(t.id,ids,setIds)}/><span>{t.label}<small>{t.evidence} · {t.locator}</small></span></label>)}</fieldset>
    <Select label="练习方式" name="mode" value={mode} options={{mixed:'混合练习',traditional:'传统练习',activity:'活动练习'}} onChange={e=>{setMode(e.target.value);setChoices([]);}}/>
    <details><summary>指定题型（最多 4 项）</summary>{Object.entries(methods).filter(([key])=>mode==='mixed'||(mode==='traditional')===['single_choice','short_fill','judgment_evidence','short_response'].includes(key)).map(([k,v])=><label className="teach-choice" key={k}><input type="checkbox" checked={choices.includes(k)} disabled={choices.length>=4&&!choices.includes(k)} onChange={()=>toggle(k,choices,setChoices)}/>{v}</label>)}</details>
    <Select label="练习顺序" name="sequence" options={{standard:'常规练习',scaffold:'逐步撤去提示',revise:'首答后自改',spaced:'间隔复练'}}/>
    <Select label="难度" name="difficulty" options={{standard:'常规',guided:'有提示',challenge:'挑战'}}/>
    <details><summary>附练习配图</summary><input aria-label="练习配图" type="file" accept=".png,.jpg,.jpeg,.webp" onChange={e=>setPicture(e.target.files[0])}/>{picture&&<label>图片说明<input name="alt" maxLength={160}/></label>}</details>
    <button className="button primary" disabled={busy||!ids.length}>生成练习单</button></form>;
}

export function TeachingConversation({room,bot,navButton,workspace,directoryLinks,studentId,enrollmentId,learningArtifactId,taskId}) {
  const [busy,setBusy]=useState(false);
  const [previewOpen,setPreviewOpen]=useState(!!taskId),[project,setProject]=useState(null),[projects,setProjects]=useState([]);
  const [binding,setBinding]=useState(''),[track,setTrack]=useState('k12'),[goal,setGoal]=useState(''),[file,setFile]=useState(null),[pages,setPages]=useState('');
  const [chosen,setChosen]=useState(null),[card,setCard]=useState(null),[preview,setPreview]=useState(''),[edition,setEdition]=useState('student');
  const [recordsPreview,setRecordsPreview]=useState(null),[connection,setConnection]=useState(null);
  const picker=useRef(),attempt=useRef(),inFlight=useRef(false),generation=useRef(0);
  const call=useCallback((action,options)=>teachingRequest(room.id,action,options),[room.id]);
  const recordMode=['operations','students'].includes(bot.target),isBot=bot.target==='bot',lesson=bot.target==='classroom';
  const previewTitle=bot.target==='students'?'学员档案':'教培成果';
  const task=chosen||taskId?project?.tasks?.find(t=>t.task_id===(chosen||taskId)):project?.tasks?.[0];
  useEffect(()=>{setChosen(null);if(taskId)setPreviewOpen(true);},[taskId]);
  const artifact=task?.artifact_ids?.[0];
  const active=project?.tasks?.some(t=>['running','queued'].includes(t.status));
  const clear=useCallback(()=>{
    generation.current++;setProject(null);setProjects([]);setPreview('');setCard(null);setFile(null);setGoal('');setChosen(null);setConnection(null);attempt.current=null;
  },[]);
  const session=useTeachingSession(call,bot.trial,clear);
  const {logged,error,setError}=session;
  useEffect(()=>{
    if(!logged)return;
    const ctrl=new AbortController(),options={signal:ctrl.signal};
    (async()=>{
      await call('context',options);
      if(recordMode)return;
      if(isBot)setConnection(await call('connection',options));
      const value=await call('project',options);
      if(ctrl.signal.aborted)return;
      setProject(value);
      if(!value)setProjects(await call('projects',options));
    })().catch(e=>{if(!ctrl.signal.aborted)setError(e.message);});
    return ()=>ctrl.abort();
  },[call,logged,recordMode,isBot]);
  useEffect(()=>{
    if(!logged||!active)return;
    const ctrl=new AbortController();let timer;
    async function poll(){try{const value=await call('project',{signal:ctrl.signal});if(!ctrl.signal.aborted)setProject(value);}
      catch(e){if(!ctrl.signal.aborted)setError(e.message);}
      finally{if(!ctrl.signal.aborted)timer=setTimeout(poll,1000);}}
    timer=setTimeout(poll,450);
    return ()=>{ctrl.abort();clearTimeout(timer);};
  },[active,logged,call]);
  useEffect(()=>{
    setCard(null);setPreview('');if(!logged||!artifact)return;
    const ctrl=new AbortController();
    call('artifact?id='+artifact,{signal:ctrl.signal}).then(value=>{if(!ctrl.signal.aborted)setCard(value);}).catch(e=>{if(!ctrl.signal.aborted)setError(e.message);});
    return ()=>ctrl.abort();
  },[artifact,logged,call]);
  useEffect(()=>{
    setPreview('');if(!logged||!['lesson','practice_pack'].includes(card?.kind)||card.artifact_id!==artifact)return;
    const ctrl=new AbortController();
    call('preview?id='+artifact+'&format='+(card.kind==='lesson'?'lesson':edition),{body:{},signal:ctrl.signal})
      .then(value=>{if(!ctrl.signal.aborted)setPreview(value.url);}).catch(e=>{if(!ctrl.signal.aborted)setError(e.message);});
    return ()=>ctrl.abort();
  },[call,card,artifact,edition,logged]);
  async function run(fn){
    if(inFlight.current)return;
    inFlight.current=true;setBusy(true);setError('');
    try{await fn();}catch(e){setError(e.message);}finally{inFlight.current=false;setBusy(false);}
  }
  async function bind(){const bound=await call('bind',{body:binding?{project:binding}:{...(lesson?{track}:{}),title:(file?.name||room.title).slice(0,100)}});
    return bound;}
  function execute(action,input,material){
    return run(async()=>{
      const epoch=generation.current;
      const signature=JSON.stringify([action,input,binding,material?.name,material?.size,material?.lastModified]);
      if(attempt.current?.signature!==signature||attempt.current?.material!==material)attempt.current={signature,material,key:crypto.randomUUID()};
      const pending=attempt.current;
      if(!project){await bind();setProject(await call('project'));}
      if(material&&!pending.asset)pending.asset=(await call('upload',{file:material})).asset_id;
      const response=await call('submit',{body:{action,input,assets:pending.asset?[pending.asset]:[],key:pending.key}});
      if(epoch!==generation.current)return;
      const value=await call('project');
      setProject(value);setChosen(response.task_id);setPreviewOpen(true);setFile(null);setGoal('');setPages('');
      if(isBot)setConnection(current=>({...current,messages:[...(current?.messages??[]),{taskId:response.task_id,prompt:input.prompt}]}));
      if(picker.current)picker.current.value='';
      attempt.current=null;
    });
  }
  const visibleCard=card?.artifact_id===artifact?card:null;
  return <div className={'conversation with-preview specialist-chat teaching-chat'+(previewOpen?' specialist-preview-open':'')}>
    <main className="chat" aria-label={bot.name+'会话'}><header className="chat-head">{navButton}<BotMark bot={bot} className="large"/>
    <div className="chat-ident"><h1>{bot.name}</h1><p>英语教培</p></div><button className="preview-toggle" type="button" aria-expanded={previewOpen} aria-controls="teaching-preview" onClick={()=>setPreviewOpen(!previewOpen)}><PanelRight size={18}/>{bot.target==='students'?previewTitle:'成果'}</button></header>
    <div className="thread-scroll"><div className="thread-body teach-fields">
    <TeachingAccount session={session} disabled={busy}/>
    {directoryLinks&&studentId&&!recordMode&&<a className="text-button" href={studentDirectoryHref(studentId)}>返回学员档案</a>}
    {logged&&(recordMode?<TeachingRecords key={[bot.id,studentId,enrollmentId,learningArtifactId].join('/')} area={bot.id.slice('teaching-'.length)} title={bot.name}
      call={call} preview={recordsPreview} onError={setError} directoryLinks={directoryLinks} studentId={studentId} enrollmentId={enrollmentId}
      artifactId={learningArtifactId} openRelated={directoryLinks?(id,student)=>run(()=>openTeachingBot(workspace,id,{studentId:student})):undefined}/>:<>
    {isBot&&connection&&connection.connection!=='ready'&&<p role="status">当前教师工作台的专用 Bot {connection.connection==='offline'?'暂时离线':'尚未配置'}。</p>}
    {!project?<><Select label="教培任务记录" value={binding} onChange={e=>setBinding(e.target.value)} options={Object.fromEntries([['','创建任务记录'],...projects.map(p=>[p.id,p.title])])}/>
      {binding&&<button className="button" disabled={busy} onClick={()=>run(async()=>{await bind();setProject(await call('project'));})}>接续所选记录</button>}</>
      :<h2>{project.title}</h2>}
    {[...(project?.tasks??[])].reverse().map(t=><article className="message reply" key={t.task_id}><BotMark bot={bot}/><div><strong>{connection?.messages?.find(m=>m.taskId===t.task_id)?.prompt??t.title}</strong><p>{t.summary}</p>
      <button className="text-button" onClick={()=>{setChosen(t.task_id);setPreviewOpen(true);}}>{statusNames[t.status]??t.status} · 查看</button></div></article>)}</>)}
    {error&&<p role="alert" className="form-error">{error}</p>}
    </div></div>
    {logged&&!recordMode&&<footer className="compose-wrap"><form className="composer teach-fields" onSubmit={event=>{event.preventDefault();
      const range=file?.name.toLowerCase().endsWith('.pdf')&&pages?{pages}:{};
      void execute(isBot?'ask_bot':lesson?'generate_lesson':'identify_learning_targets',isBot?{prompt:goal.trim()}:lesson?{track:project?.track||projects.find(p=>p.id===binding)?.track||track,...range,goal:goal.trim()}:{...range,focus:goal.trim()},file);
    }}>
    {!isBot&&<>{lesson&&<Select label="课程轨道" value={project?.track||projects.find(p=>p.id===binding)?.track||track} disabled={!!(project?.track||projects.find(p=>p.id===binding)?.track)} onChange={e=>setTrack(e.target.value)} options={tracks}/>}
    <label>教材文件<input ref={picker} type="file" required accept={lesson?'.pdf,.docx,.pptx,.txt,.md,.png,.jpg,.jpeg,.webp':'.pdf,.docx,.pptx,.txt,.md'} onChange={e=>setFile(e.target.files[0])}/></label>
    {file?.name.toLowerCase().endsWith('.pdf')&&<label>页码范围<input placeholder="例如 2-5" pattern="[1-9][0-9]{0,2}-[1-9][0-9]{0,2}" value={pages} onChange={e=>setPages(e.target.value)}/></label>}</>}
    <textarea aria-label="任务说明" placeholder={isBot?'输入教培任务':lesson?'这节课想重点讲什么？':'想让学生重点练什么？'} value={goal} maxLength={isBot?1800:300} onChange={e=>setGoal(e.target.value)}/>
    <button className="button primary" disabled={busy||active||(isBot?!goal.trim()||connection?.connection!=='ready':!file)}>{isBot?'发送任务':lesson?'生成互动课件':'识别知识点'}</button></form></footer>}
    </main><aside id="teaching-preview" className="preview specialist-preview" aria-label={previewTitle}><header className="preview-head"><h2>{previewTitle}</h2><button className="icon-button mobile-control" type="button" aria-label={'关闭'+previewTitle} onClick={()=>setPreviewOpen(false)}><X size={18}/></button></header>
    <div className="preview-content teach-fields" ref={recordMode?setRecordsPreview:undefined}>{logged&&!recordMode&&(visibleCard?<><h3>{visibleCard.title}</h3>
    {visibleCard.kind==='practice_analysis'?<PracticeChoices key={artifact} card={visibleCard} busy={busy||active} exec={execute}/>:visibleCard.kind==='bot_reply'?<p>{visibleCard.reply}</p>:<>
      <p>{visibleCard.objective}</p>{visibleCard.kind==='practice_pack'&&<Select label="预览版本" value={edition} onChange={e=>setEdition(e.target.value)} options={{student:'学生练习单',teacher:'教师参考'}}/>}
      {preview&&<iframe key={preview} title="教培成果预览" className="teach-preview-frame" sandbox={visibleCard.kind==='lesson'?'allow-scripts allow-forms':''} src={preview}/>}
      {directoryLinks&&<button className="button compact" type="button" disabled={busy}
        onClick={()=>void run(()=>openTeachingBot(workspace,'teaching-learning',{studentId,artifactId:artifact}))}>登记到学员档案</button>}
      <div className="memory-actions">{(visibleCard.kind==='lesson'?['pptx','html']:[edition]).map(fmt=><button className="button compact" disabled={busy} key={fmt} onClick={()=>run(async()=>{const bytes=await call('download?id='+artifact+'&format='+fmt,{blob:true});
        downloadFile(bytes,(fmt==='student'?'学生练习单':fmt==='teacher'?'教师参考':'互动课件')+'.'+(fmt==='pptx'?'pptx':'html'));})}>下载 {fmt==='student'?'学生版':fmt==='teacher'?'教师版':fmt.toUpperCase()}</button>)}</div></>}
    </>:<p className="muted">{task?.summary||'任务完成后在这里查看成果。'}</p>)}</div></aside></div>;
}

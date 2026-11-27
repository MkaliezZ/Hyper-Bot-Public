import React,{useState,useRef} from 'react';
import { BookOpen, Paperclip, PanelRight, X } from 'lucide-react';
import { api, apiPath, clock, runPhase, downloadFile } from './client.js';
import { BotMark } from './components.jsx';

const labels={objective:'目标',audience:'受众',account_scope:'账号范围',claims:'观察与判断',priority_action:'优先行动',
  source_time:'时间（秒）',relative_strength:'相对强度',evidence:'依据',text:'内容',kind:'判断类型',limitation:'适用限制',quote:'原文',candidates:'候选',question:'问题',
  angle:'角度',selection_reason:'选择原因',title:'标题',caption:'发布文案',disclosure:'披露说明',metrics:'指标',
  hypotheses:'假设',next_experiment:'下次实验',checklist:'核对清单',item:'核对项',state:'状态'};
const identifiers=new Set(['id','source_id','selected_id','claim_ids','profile_sha256']);
function Content({value}) {
  if(value===null||value===undefined)return <span className="muted">未知</span>;
  if(Array.isArray(value))return <ul>{value.map((item,index)=><li key={index}><Content value={item}/></li>)}</ul>;
  if(typeof value==='object')return <dl>{Object.entries(value).filter(([key])=>!identifiers.has(key)).map(([key,item])=>
    <React.Fragment key={key}><dt>{labels[key]??key}</dt><dd><Content value={item}/></dd></React.Fragment>)}</dl>;
  return <span>{String(value)}</span>;
}

function TaskResult({job,room}) {
  const [saving,setSaving]=useState(false);
  const [saveError,setSaveError]=useState('');
  async function download(event,file) {
    if(!window.hyperBot?.exportSpecialist)return;
    event.preventDefault();
    if(saving)return;
    setSaving(true);setSaveError('');
    try {await window.hyperBot.exportSpecialist(room.id,job.id,file.name);}
    catch {setSaveError('无法保存此文件。请核对本机成果及目标目录后重试。');}
    finally {setSaving(false);}
  }
  const result=job?.specialistResult;
  if(!job)return <p className="muted">提交后可在这里查看执行状态和成果。</p>;
  if(!result)return <p className={job.error?'form-error':'muted'} role={job.error?'alert':'status'}>
    {job.error||runPhase(job)}</p>;
  return <div className="specialist-result">
    <h3>{result.title}</h3>
    {result.note&&<p className="muted">{result.note}</p>}
    {Array.isArray(result.details)&&result.details.every(track=>Array.isArray(track.candidates))&&<button className="button compact" onClick={()=>{
      const lines=result.details.flatMap(t=>t.candidates.map(m=>'"'+String(t.素材).replaceAll('"','""')+'",'+m.source_time+','+m.relative_strength));
      downloadFile(new Blob(['\ufeff素材,时间（秒）,相对强度\r\n'+lines.join('\r\n')],{type:'text/csv'}),'音乐卡点.csv');
    }}>导出卡点 CSV</button>}
    {result.details&&<Content value={result.details}/>}
    {result.files?.map(file=><a key={file.name} className="button compact"
      href={apiPath('/rooms/'+room.id+'/specialist-download/'+job.id+'/'+encodeURIComponent(file.name))}
      onClick={event=>void download(event,file)} aria-disabled={saving} download>{file.label}</a>)}
    {saveError&&<p className="form-error" role="alert">{saveError}</p>}
  </div>;
}

export function SpecialistConversation({room,bot,workspace,navButton,online,refresh}) {
  const [text,setText]=useState('');
  const [evidence,setEvidence]=useState('');
  const [length,setLength]=useState(6);
  const [portrait,setPortrait]=useState(false);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [visible,setVisible]=useState(false);
  const [chosen,setChosen]=useState(null);
  const attempt=useRef(null);
  const picker=useRef(null);
  const last=room.runs.find(run=>run.id===chosen)??room.runs.at(-1);
  const blocked=busy||!online||!!workspace.active||!!bot.blocked;
  const cutting=['cut','transition','mask'].includes(bot.mode);

  async function submit(event) {
    event.preventDefault();
    if(blocked||!text.trim())return;
    setBusy(true);setError('');
    const input={text:text.trim(),evidence,length:Number(length),portrait,authorized:true};
    const key=JSON.stringify(input);
    if(attempt.current?.key!==key)attempt.current={key,id:crypto.randomUUID()};
    try {
      const job=await api('/rooms/'+room.id+'/specialist',{...input,requestId:attempt.current.id},
        {signal:AbortSignal.timeout(15000)});
      setChosen(job.id);setText('');setEvidence('');
      attempt.current=null;
      await refresh();
    } catch(problem) {
      if(problem.code)attempt.current=null;
      setError(problem.message);
    } finally {setBusy(false);}
  }

  async function addFiles(files) {
    setBusy(true);setError('');
    try {
      for(const file of files) {
        const response=await fetch(apiPath('/rooms/'+room.id+'/specialist-upload?name='+encodeURIComponent(file.name)),{
          method:'POST',headers:{'Content-Type':'application/octet-stream','X-Hyper-Bot':'1'},body:file
        });
        if(!response.ok)throw new Error((await response.json()).error);
      }
    } catch(problem){setError(problem.message);}
    finally {await refresh();setBusy(false);}
  }

  async function removeFile(id) {
    setBusy(true);setError('');
    try {await api('/rooms/'+room.id+'/specialist-upload/'+id+'/remove',{});await refresh();}
    catch(problem){setError(problem.message);}
    finally {setBusy(false);}
  }

  return <div className={'conversation with-preview specialist-chat'+(visible?' specialist-preview-open':'')}>
    <main className="chat" aria-label={bot.name+'会话'}>
      <header className="chat-head">{navButton}<BotMark bot={bot} className="large"/>
        <div className="chat-ident"><h1>{bot.name}</h1><p>{bot.category}</p></div>
        <button className="preview-toggle" type="button" aria-expanded={visible}
          aria-controls="specialist-preview" onClick={()=>setVisible(!visible)}><PanelRight size={18}/>成果</button>
      </header>
      <div className="thread-scroll"><div className="thread-body">
        <div className="thread-head"><h2>{room.title}</h2><p>{bot.description}</p></div>
        {room.runs.map(job=><article className="message reply" key={job.id}>
          <BotMark bot={bot}/><div className="reply-content"><div className="byline"><strong>{bot.name}</strong>
            <time dateTime={job.updatedAt}>{clock(job.updatedAt)}</time></div>
            <p>{job.prompt}</p>
            <button className="text-button" type="button" onClick={()=>{setChosen(job.id);setVisible(true);}}>
              <BookOpen size={15}/>{runPhase(job)}</button>
          </div></article>)}
        {error&&<p className="form-error" role="alert">{error}</p>}
      </div></div>
      <footer className="compose-wrap">
        <form className="composer specialist-form" onSubmit={submit}>
          <label className="sr" htmlFor="message">任务说明</label>
          <textarea id="message" rows={2} maxLength={8000} placeholder={bot.input} value={text}
            onChange={event=>setText(event.target.value)} disabled={busy}/>
          {bot.model&&<details><summary>补充授权文字</summary>
            <textarea rows={3} aria-label="授权文字" placeholder="可核对的原文、数据和来源" maxLength={16000}
              value={evidence} onChange={event=>setEvidence(event.target.value)} disabled={busy}/></details>}
          {cutting&&<div className="specialist-controls">
            <label>每段最多（秒） <input type="number" min={1} max={120} value={length} onChange={event=>setLength(event.target.value)}/></label>
            <label><input type="checkbox" checked={portrait} onChange={event=>setPortrait(event.target.checked)}/>竖屏</label>
          </div>}
          <div className="composer-files" aria-label="待登记的素材">{(room.specialistUploads??[]).map(file=><span key={file.id}>
            <span className="composer-file-name">{file.name}</span><button type="button" disabled={blocked}
              aria-label={'移除 '+file.name} onClick={()=>void removeFile(file.id)}><X size={14}/></button>
          </span>)}</div>
          <div className="compose-tools"><div className="compose-start">
            {bot.uploads&&<><input ref={picker} type="file" multiple hidden
              accept={bot.mode==='text'?'.txt,.md,.csv,.json':'.mp4,.mov,.mkv,.webm,.wav,.mp3,.m4a,.png,.jpg,.jpeg,.txt,.md,.csv,.json'}
              onChange={event=>{const files=[...event.target.files];event.target.value='';if(files.length)void addFiles(files);}}/>
              <button className="text-button" type="button" disabled={blocked} onClick={()=>picker.current.click()}>
                <Paperclip size={16}/>添加素材</button></>}
            </div><button className="button primary compact" type="submit" disabled={blocked||!text.trim()}>
              {busy?'正在处理…':'执行任务'}</button></div>
        </form>
        {bot.blocked&&<p role="status" className="muted">{bot.blocked} <a href="#manage/dependencies">检查依赖</a></p>}
      </footer>
    </main>
    <aside id="specialist-preview" className="preview specialist-preview" aria-label="工作台成果">
      <header className="preview-head"><div><PanelRight size={18}/><h2>工作台成果</h2></div>
        <button className="icon-button mobile-control" type="button" aria-label="关闭成果" onClick={()=>setVisible(false)}><X size={18}/></button></header>
      <div className="preview-content"><TaskResult key={last?.id} job={last} room={room}/></div>
    </aside>
  </div>;
}

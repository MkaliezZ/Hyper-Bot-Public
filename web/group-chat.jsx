import React,{useEffect,useState,useRef,useCallback} from 'react';
import {AtSign,Folder,Paperclip,Users,PanelRight,X} from 'lucide-react';
import {api,apiPath,clock} from './client.js';
import {BotMark} from './components.jsx';
import {TeachingRecords} from './teaching-records.jsx';
import {teachingRequest} from './teaching-client.js';
import {TeachingAccount,useTeachingSession} from './teaching-session.jsx';
import {FolderField} from './workspace-nav.jsx';

const phases={working:'执行中',approval:'待确认',input:'待补充',done:'已完成',failed:'失败',interrupted:'已中断'};
const getFile=id=>apiPath('/group-files/'+id);
function GroupFolderLocation({folder}){
  if(!folder)return null;
  const separator=folder.includes('\\')?'\\':'/';
  const location=folder.replace(/[\\/]+$/,'')+separator+'群组文档';
  return <>
    <small className="group-folder-path desktop-folder-path">{location}</small>
    <details key={folder} className="mobile-folder-location">
      <summary>文件保存位置</summary>
      <small className="group-folder-path">{location}</small>
    </details>
  </>;
}
function FilePreview({file,lesson}){
  const [text,setText]=useState(''),[error,setError]=useState('');
  const readable=file&&/\.(md|txt|json|csv|srt)$/i.test(file.name);
  useEffect(()=>{
    setText('');setError('');if(!readable||file.size>512000)return;
    const ac=new AbortController();
    fetch(getFile(file.id),{signal:ac.signal}).then(async r=>{if(!r.ok)throw Error('文件读取失败');return r.text();})
      .then(s=>{if(!ac.signal.aborted)setText(s);}).catch(e=>{if(!ac.signal.aborted)setError(e.message);});
    return ()=>ac.abort();
  },[file?.id,readable]);
  if(!file)return null;
  return <section className="group-file-preview"><h3>{file.name}</h3>{error&&<p role="alert">{error}</p>}
    {lesson&&file.name.toLowerCase().endsWith('.html')&&<iframe className="teach-preview-frame" title={file.name} sandbox="allow-scripts" src={getFile(file.id)+'/preview'}/>}
    {text&&<pre>{text}</pre>}{/\.(mp4|webm)$/i.test(file.name)&&<video controls src={getFile(file.id)}/>}
    <a className="button compact" href={getFile(file.id)} download>下载文件</a></section>;
}
function RecordEditor({task,bot}){
  const [preview,setPreview]=useState(null);
  const call=useCallback((action,options)=>teachingRequest(task.room,action,options),[task.room]);
  const session=useTeachingSession(call,true);
  return <div className="teach-fields">
    <TeachingAccount session={session}/>
    {session.error&&<p className="form-error" role="alert">{session.error}</p>}
    {session.logged&&<><TeachingRecords area={bot.id.slice('teaching-'.length)} title={bot.name} call={call} preview={preview} onError={session.setError}/>
      <div ref={setPreview}/></>}
  </div>;
}
export function GroupChat({workspace,navButton}){
  const [data,setData]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[text,setText]=useState('');
  const [attached,attach]=useState([]),[showMembers,show]=useState(false),[preview,setPreview]=useState(false),[selected,select]=useState(''),[folder,setFolder]=useState('');
  const [chooseFiles,choose]=useState(false),[handling,handle]=useState('');
  const [sendMode,setSendMode]=useState('chat');
  const field=useRef(),attempt=useRef(),picker=useRef(),bottom=useRef();
  const members=workspace.bots.filter(b=>workspace.installedBots.includes(b.id)&&b.status==='enabled');
  const files=data?.files??[],messages=data?.messages??[];
  const mode=attached.length?'task':sendMode;
  const addressed=/(?:^|\s)[@＠]/u.test(text);
  useEffect(()=>{
    const ac=new AbortController();api('/group-chat',undefined,{signal:ac.signal}).then(v=>{if(!ac.signal.aborted)setData(v);}).catch(e=>{if(!ac.signal.aborted)setError(e.message);});
    return ()=>ac.abort();
  },[workspace.version]);
  useEffect(()=>{bottom.current?.scrollIntoView({block:'nearest'});},[messages.length]);
  function mention(bot){
    const caret=field.current?.selectionStart??text.length;
    const before=text.slice(0,caret),tag=/(?:^|\s)([@＠][^\s@＠]*)$/u.exec(before);
    if(tag)setText(before.slice(0,-tag[1].length)+'@'+bot.name+' '+text.slice(caret).trimStart());
    else setText(value=>'@'+bot.name+' '+value);
    show(false);field.current?.focus();
  }
  async function upload(items){
    setBusy(true);setError('');
    try{for(const f of items){
      const response=await fetch(apiPath('/group-files?name='+encodeURIComponent(f.name)),{method:'POST',headers:{'Content-Type':'application/octet-stream','X-Hyper-Bot':'1'},body:f});
      const value=await response.json();if(!response.ok)throw Error(value.error);
      attach(list=>[...list,value.id]);
    }setData(await api('/group-chat'));}catch(e){setError(e.message);}finally{setBusy(false);}
  }
  async function send(e){
    e.preventDefault();if(busy||!text.trim())return;
    const line=text.trim();
    const tags=[...line.matchAll(/(?:^|\s)([@＠])/gu)].map(match=>match.index+match[0].length-1);
    if(tags.length>1){setError('每条消息可以派给一位 Bot。');return;}
    const start=tags[0],after=start===undefined?'':line.slice(start+1);
    const bot=start===undefined?null:members.filter(b=>after.startsWith(b.name)&&(!after[b.name.length]||/[\s，,：:]/u.test(after[b.name.length]))).sort((a,b)=>b.name.length-a.name.length)[0];
    if(start!==undefined&&!bot){setError('请从本群成员中选择 @ 对象。');show(true);return;}
    const messageText=bot?(line.slice(0,start)+after.slice(bot.name.length).replace(/^[\s，,：:]+/u,'')).trim():line;
    const body={text:messageText,files:attached,...(bot?{bot:bot.id,mode}:{})};
    if(!body.text){setError('请填写消息内容。');return;}
    const key=JSON.stringify(body);if(attempt.current?.key!==key)attempt.current={key,id:crypto.randomUUID()};
    setBusy(true);setError('');
    try{await api('/group-chat',{...body,id:attempt.current.id});attempt.current=null;setText('');attach([]);setSendMode('chat');show(false);choose(false);setData(await api('/group-chat'));}
    catch(e){setError(e.message);}finally{setBusy(false);}
  }
  const pick=id=>{select(id);handle('');setPreview(true);};
  const editing=messages.find(m=>m.id===handling&&m.status==='input');
  const lookup=id=>files.find(f=>f.id===id);
  return <div className={'conversation with-preview specialist-chat group-chat'+(preview?' specialist-preview-open':'')}>
    <main className="chat"><header className="chat-head">{navButton}<Users size={24}/><div className="chat-ident"><h1>{workspace.workspace.name}</h1><p>群组 · {members.length} 位 Bot</p></div>
      <button className="preview-toggle" aria-expanded={preview} aria-controls="group-file-panel" onClick={()=>setPreview(v=>!v)}><PanelRight size={18}/>群组文件</button></header>
      <div className="thread-scroll"><div className="thread-body">
        {!messages.length&&<div className="thread-head"><h2>群聊</h2><p>输入 @ 选择成员，可以提问或派发任务。</p></div>}
        {messages.map(m=><div key={m.id} className="group-turn"><article className="message reply"><div><div className="byline"><strong>你</strong><time>{clock(m.createdAt)}</time></div>
          <p>{m.bot&&<b className="group-mention">@{members.find(b=>b.id===m.bot)?.name??m.bot} </b>}{m.text}</p>
          {m.files.map(id=><button className="text-button" key={id} onClick={()=>pick(id)}>{lookup(id)?.name}</button>)}</div></article>
          {m.bot&&<article className="message reply group-response"><BotMark bot={members.find(b=>b.id===m.bot)}/><div><div className="byline"><strong>{members.find(b=>b.id===m.bot)?.name}</strong>
            {!(m.mode==='chat'&&m.status==='done')&&<small>{m.mode==='chat'&&m.status==='working'?'正在回复…':phases[m.status]}</small>}</div>
            {m.reply&&<p>{m.reply}</p>}
            {(m.outputs??[]).map(id=><button className="button compact" key={id} onClick={()=>pick(id)}>{lookup(id)?.name??'查看成果'}</button>)}
            {m.status==='input'&&<button className="button compact" onClick={()=>{handle(m.id);setPreview(true);}}>在群内填写</button>}
            {m.room&&<a className="text-button" href={'#chat/'+m.room}>{['approval','input'].includes(m.status)?'继续处理':'查看任务记录'}</a>}
          </div></article>}</div>)}<span ref={bottom}/>
      </div></div>
      <footer className="compose-wrap">{error&&<p className="form-error" role="alert">{error}</p>}
        {data&&!data.folder?<form className="workspace-form" onSubmit={async e=>{e.preventDefault();try{await api('/group-folder',{folder});setData(await api('/group-chat'));}catch(e){setError(e.message);}}}>
          <FolderField folder={folder} setFolder={setFolder} onError={setError}/><button className="button">绑定群组文件夹</button></form>:
        <form className="composer" onSubmit={send}>
          {showMembers&&<div className="group-choices" aria-label="选择群成员">{members.filter(b=>!/^[@＠]\S+$/u.test(text)||b.name.includes(text.slice(1))).map(b=>
            <button type="button" key={b.id} onClick={()=>mention(b)}><BotMark bot={b}/>{b.name}</button>)}</div>}
          {chooseFiles&&<div className="group-choices">{files.map(f=><label key={f.id}><input type="checkbox" checked={attached.includes(f.id)}
            onChange={()=>attach(ids=>ids.includes(f.id)?ids.filter(v=>v!==f.id):[...ids,f.id])}/>{f.name}</label>)}{!files.length&&'暂无群组文件'}</div>}
          <textarea ref={field} aria-label="群聊消息" placeholder="@成员 提问或派发任务" rows={2} value={text} maxLength={8000} onChange={e=>{setText(e.target.value);show(/(?:^|\s)[@＠][^\s@＠]*$/u.test(e.target.value.slice(0,e.target.selectionStart)));}}
            onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();void send(e);}}}/>
          <div className="composer-files">{attached.map(id=><button type="button" className="text-button" key={id} onClick={()=>attach(ids=>ids.filter(v=>v!==id))}>{lookup(id)?.name??'文件'} ×</button>)}</div>
          <div className="compose-tools"><div className="compose-start"><button type="button" className="icon-button" aria-label="@成员" onClick={()=>show(!showMembers)}><AtSign size={17}/></button>
            <button type="button" className="icon-button" aria-label="上传群组文件" disabled={busy} onClick={()=>picker.current.click()}><Paperclip size={17}/></button>
            <input type="file" multiple hidden ref={picker} onChange={e=>{const values=[...e.target.files];e.target.value='';void upload(values);}}/>
            <button type="button" className="text-button" onClick={()=>choose(!chooseFiles)}><Folder size={16}/>选群文件</button>
            {addressed&&<select className="group-send-mode" aria-label="发送模式" value={mode} disabled={busy||attached.length>0}
              title={attached.length?'带文件的消息将派发任务':undefined} onChange={event=>setSendMode(event.target.value)}>
              <option value="chat">对话</option><option value="task">派发任务</option>
            </select>}</div>
          <button className="button primary compact" disabled={busy||!text.trim()||!data?.folder}>发送</button></div></form>}
      </footer></main>
    <aside id="group-file-panel" className="preview specialist-preview"><header className="preview-head"><h2>{editing?'办理群任务':'群组文件'}</h2><button className="icon-button mobile-control" aria-label="关闭群组文件" onClick={()=>setPreview(false)}><X/></button></header>
      <div className="preview-content">{editing?<RecordEditor key={editing.id} task={editing} bot={members.find(b=>b.id===editing.bot)}/>:<><GroupFolderLocation key={preview?'open':'closed'} folder={data?.folder}/>
        {files.map(f=><button type="button" className="group-file-row" key={f.id} onClick={()=>pick(f.id)}><Paperclip size={15}/>{f.name}</button>)}
        <FilePreview file={lookup(selected)} lesson={messages.some(m=>m.outputs?.includes(selected)&&['teaching-classroom','teaching-practice'].includes(m.bot))}/><details><summary>群组成员</summary>{members.map(b=><button className="text-button" key={b.id} onClick={()=>mention(b)}><BotMark bot={b}/>@{b.name}</button>)}<a className="text-button" href="#bots">从 Bot广场添加成员</a></details></>}
      </div></aside></div>;
}

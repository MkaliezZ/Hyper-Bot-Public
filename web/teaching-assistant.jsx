import React,{useRef,useState} from 'react';
import {api,dependencyHref,runPhase} from './client.js';
import {BotMark} from './components.jsx';

export function TeachingAssistant({room,bot,workspace,navButton,online,refresh}){
  const [text,setText]=useState('');
  const [evidence,setEvidence]=useState('');
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const attempt=useRef(null);
  const disabled=busy||!online||!!workspace.active||!!bot.blocked;

  async function send(event){
    event.preventDefault();
    if(disabled||!text.trim())return;
    const message={text:text.trim(),evidence:evidence.trim()};
    const signature=JSON.stringify(message);
    if(attempt.current?.signature!==signature)attempt.current={signature,id:crypto.randomUUID()};
    setBusy(true);setError('');
    try {
      await api('/rooms/'+room.id+'/teaching-assistant',{...message,requestId:attempt.current.id});
      setText('');setEvidence('');attempt.current=null;
      await refresh();
    } catch(problem) {
      setError(problem.message);
    } finally {setBusy(false);}
  }

  return <div className="conversation specialist-chat teaching-chat">
    <main className="chat" aria-label={bot.name+'会话'}>
      <header className="chat-head">{navButton}<BotMark bot={bot} className="large"/>
        <div className="chat-ident"><h1>{bot.name}</h1><p>英语教培</p></div>
      </header>
      <div className="thread-scroll"><div className="thread-body">
        {room.runs.map(run=><article className="message reply teaching-answer" key={run.id}>
          <p>{run.prompt}</p><div className="byline"><strong>{bot.name}</strong></div>
          <p role={run.error?'alert':undefined}>{run.teachingReply||run.error||runPhase(run)}</p>
        </article>)}
        {bot.blocked&&<p role="status">{bot.blocked} <a href={dependencyHref(bot,room.id)}>检查依赖</a></p>}
        {error&&<p role="alert" className="form-error">{error}</p>}
      </div></div>
      <footer className="compose-wrap"><form className="composer teach-fields" onSubmit={send}>
        <label>教学问题<textarea value={text} maxLength={8000} onChange={event=>setText(event.target.value)}/></label>
        <details><summary>参考材料</summary><label>参考文字<textarea value={evidence} maxLength={16000}
          onChange={event=>setEvidence(event.target.value)}/></label></details>
        <button className="button primary" disabled={disabled||!text.trim()}>发送</button>
      </form></footer>
    </main>
  </div>;
}

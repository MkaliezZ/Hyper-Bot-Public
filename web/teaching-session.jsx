import React,{useCallback,useEffect,useRef,useState} from 'react';
import {teacherSession} from './teaching-client.js';

export function useTeachingSession(call,trial,onExpire) {
  const [logged,setLogged]=useState(()=>!!teacherSession());
  const [error,setError]=useState(''),[pending,setPending]=useState(false),[attempt,setAttempt]=useState(0);
  const changing=useRef(false);
  const clear=useCallback(()=>{setLogged(false);onExpire?.();},[onExpire]);
  useEffect(()=>{
    window.addEventListener('teaching-expired',clear);
    return ()=>window.removeEventListener('teaching-expired',clear);
  },[clear]);
  useEffect(()=>{
    if(!trial||logged)return;
    const controller=new AbortController();
    call('trial',{body:{},signal:controller.signal}).then(result=>{
      if(!controller.signal.aborted){teacherSession(result.token);setError('');setLogged(true);}
    }).catch(problem=>{if(!controller.signal.aborted)setError(problem.message);});
    return ()=>controller.abort();
  },[call,trial,logged,attempt]);
  useEffect(()=>{
    if(!logged)return;
    const controller=new AbortController();
    const recheck=()=>{if(!document.hidden)call('context',{signal:controller.signal}).catch(()=>{});};
    const timer=setInterval(recheck,30000);
    window.addEventListener('focus',recheck);
    return ()=>{controller.abort();clearInterval(timer);window.removeEventListener('focus',recheck);};
  },[call,logged]);
  async function change(action,body) {
    if(changing.current)return false;
    changing.current=true;
    setPending(true);
    setError('');
    try {
      const result=await call(action,{body});
      if(action==='login'){teacherSession(result.token);setLogged(true);}
      return true;
    } catch(problem) {
      setError(problem.message);
      return false;
    } finally {
      if(action==='logout'){teacherSession(null);clear();}
      changing.current=false;
      setPending(false);
    }
  }
  return {logged,error,setError,trial,pending,login:password=>change('login',{password}),logout:()=>change('logout',{}),
    reconnect:()=>{setError('');setAttempt(value=>value+1);}};
}

export function TeachingAccount({session,disabled=false}) {
  const {logged,error,trial,pending,login,logout,reconnect}=session;
  if(logged)return trial?null:<div className="teach-session"><span>教师工作台</span>
    <button type="button" className="text-button" disabled={disabled||pending} onClick={()=>void logout()}>退出教师账号</button></div>;
  if(trial)return <div role="status">{error?<button type="button" className="button" onClick={reconnect}>重新连接</button>:'正在连接教培功能…'}</div>;
  return <form className="teach-fields" onSubmit={async event=>{
    event.preventDefault();
    const form=event.currentTarget;
    if(await login(new FormData(form).get('password')))form.reset();
  }}>
    <h2>登录教师账号</h2>
    <label>原工作台教师口令<input type="password" name="password" autoComplete="current-password" required maxLength={100}/></label>
    <button className="button primary" disabled={disabled||pending}>登录英语教培工作台</button>
  </form>;
}

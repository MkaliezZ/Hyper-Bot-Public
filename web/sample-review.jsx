import React, { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { api, clock, day } from './client.js';
import { SampleOutput } from './preview.jsx';

export function SampleReview({bot,harness,onClose}) {
  const dialog=useRef(),closeControl=useRef(),timer=useRef();
  const [closing,setClosing]=useState(false);
  const [sample,setSample]=useState(null);
  const [error,setError]=useState('');
  const route='/bots/'+bot.id+'/'+bot.revision+'/sample-preview';
  const runId=bot.sample.runId;

  useEffect(()=>{
    const node=dialog.current;
    node.showModal();
    closeControl.current.focus({preventScroll:true});
    return ()=>{clearTimeout(timer.current);if(node.open)node.close();};
  },[]);
  useEffect(()=>{
    const controller=new AbortController();
    api(route,undefined,{headers:{'X-Hyper-Bot':'1'},signal:controller.signal}).then(value=>{
      if(value.runId===runId)setSample(value);
      else setError('样例已更新，请重新打开。');
    }).catch(problem=>{if(problem.name!=='AbortError')setError(problem.message);});
    return ()=>controller.abort();
  },[route,runId]);

  function close() {
    if(closing)return;
    const finish=()=>{dialog.current.close();onClose();};
    if(matchMedia('(prefers-reduced-motion: reduce)').matches)finish();
    else {setClosing(true);timer.current=setTimeout(finish,120);}
  }

  return <dialog className={'modal sample-review'+(closing?' closing':'')} ref={dialog} aria-labelledby="sample-review-title"
    onCancel={event=>{event.preventDefault();close();}}>
    <header className="modal-head"><h2 id="sample-review-title">样例预览</h2>
      <button ref={closeControl} className="icon-button" type="button" aria-label="关闭样例预览" onClick={close}><X size={19}/></button>
    </header>
    <p className="sample-review-context"><strong>{bot.name} · r{bot.revision}</strong><span>{harness}</span>
      {sample&&<time dateTime={sample.at}>{day(sample.at)} {clock(sample.at)}</time>}</p>
    {error?<p className="form-error" role="alert">{error}</p>
      :sample?<section className="sample-review-output status-in"
        aria-label={sample.workbenchRevision?'已通过工作台保存与回读的样例':'已通过结构与引用校验的样例'}>
        <SampleOutput kind={sample.kind} result={sample.result} materials={sample.materials}
          timing={sample.timing} evidenceReview={sample.evidenceReview}
          caption={sample.workbenchRevision?'工作台回读成功':undefined}/>
      </section>:<p className="muted" role="status">正在读取样例成果…</p>}
  </dialog>;
}

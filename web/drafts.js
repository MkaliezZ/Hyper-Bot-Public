import { api } from './client.js';

const emptyDraft={text:'',attachments:[],base:null};
const key = draft => JSON.stringify([draft.text,draft.attachments,draft.base??null,draft.originalBase??null,
  draft.proposalBase??null,draft.retryOf??null]);
const saveOptions = () => ({keepalive:true,signal:AbortSignal.timeout(10000)});
const readOptions = () => ({signal:AbortSignal.timeout(10000)});

function sourceEnded(draft,room) {
  return room.materials.some(file=>file.endedAt&&draft.attachments.includes(file.id)) ||
    room.artifacts.some(item=>item.endedAt&&item.id===draft.base) ||
    room.runs.some(item=>item.endedAt&&item.id===draft.proposalBase);
}

export class WorkspaceDrafts {
  records=new Map();
  materialImports=new Map();
  listeners=new Set();
  online=true;

  subscribe=listener=>{
    this.listeners.add(listener);
    return ()=>this.listeners.delete(listener);
  };

  get(id) {
    return this.records.get(id)?.view??null;
  }

  publish(entry) {
    if(this.records.get(entry.id)!==entry)return;
    const materials=this.materialImports.get(entry.id);
    entry.view={draft:entry.draft,issue:entry.issue,error:entry.error,
      submission:entry.request?.phase??(entry.sending?'sending':null),
      addingMaterials:!!materials?.pending,materialError:materials?.error};
    for(const listener of this.listeners)listener();
  }

  discard(entry) {
    clearTimeout(entry.timer);
    this.records.delete(entry.id);
    for(const listener of this.listeners)listener();
  }

  entry(room) {
    let value=this.records.get(room.id);
    if(!value) {
      value={id:room.id,draft:room.draft,draftToken:room.draftToken,version:room.snapshotVersion,dirty:false};
      this.records.set(room.id,value);
    }
    return value;
  }

  edit(room,next) {
    const entry=this.entry(room);
    if(entry.request||entry.sending)return;
    if(!this.materialImports.get(room.id)?.pending)this.materialImports.delete(room.id);
    entry.draft=typeof next==='function'?next(entry.draft):next;
    entry.dirty=true;
    entry.error=null;
    if(entry.issue!=='conflict')entry.issue=this.online?null:'retry';
    this.publish(entry);
    this.schedule(entry);
  }

  async withMaterialImport(room,operation) {
    const entry=this.entry(room);
    if(this.materialImports.get(room.id)?.pending||entry.sending||entry.request) {
      throw new Error('请等当前材料或发送操作完成。');
    }
    const transfer={pending:true,error:null};
    this.materialImports.set(room.id,transfer);
    this.publish(entry);
    try {
      transfer.error=await operation();
    } catch(error) {
      transfer.error=error.message;
      throw error;
    } finally {
      transfer.pending=false;
      if(!transfer.error)this.materialImports.delete(room.id);
      this.publish(this.records.get(room.id));
    }
  }

  schedule(entry) {
    clearTimeout(entry.timer);
    if(this.online&&entry.dirty&&!entry.issue) {
      entry.timer=setTimeout(()=>void this.flush(entry.id),260);
    }
  }

  flush(id) {
    const entry=this.records.get(id);
    if(!entry)return;
    clearTimeout(entry.timer);
    if(entry.writing)return entry.writing;
    if(!this.online||!entry.dirty||entry.issue)return;
    entry.writing=this.writePending(entry).finally(()=>{
      entry.writing=null;
      if(this.records.get(id)===entry&&entry.issue)void this.check(id);
    });
    return entry.writing;
  }

  async writePending(entry) {
    while(this.online&&this.records.get(entry.id)===entry&&entry.dirty) {
      const draft=entry.draft;
      entry.attempt=draft;
      try {
        const saved=await api('/rooms/'+entry.id+'/draft',{...draft,draftToken:entry.draftToken},saveOptions());
        entry.draftToken=saved.draftToken;
        entry.version=Math.max(entry.version,saved.snapshotVersion);
        entry.attempt=null;
        entry.dirty=entry.draft!==draft;
      } catch(error) {
        entry.issue=error.code==='draft_conflict'?'conflict':error.code?'invalid':'retry';
        entry.error=error.code?error.message:null;
        if(error.code)entry.attempt=null;
        this.publish(entry);
        return;
      }
    }
    this.publish(entry);
  }

  observe(room,{visible=false,resume=false}={}) {
    const entry=this.records.get(room?.id);
    if(!entry||room.snapshotVersion<entry.version)return;
    const discardVisible=visible&&!this.materialImports.has(room.id);
    if(sourceEnded(entry.draft,room)) {
      if(discardVisible)this.discard(entry);
      else {
        clearTimeout(entry.timer);
        this.records.delete(entry.id);
        this.publish(this.entry(room));
      }
      return;
    }
    if(entry.request) {
      const accepted=room.runs.some(run=>run.clientRequestId===entry.request.body.clientRequestId);
      if(accepted) {
        entry.request=null;
        entry.sending=false;
        entry.dirty=false;
        entry.issue=null;
        entry.error=null;
      } else {
        if(entry.request.phase==='checking') {
          entry.request.phase='retry';
          this.publish(entry);
        }
        return;
      }
    }
    if(entry.writing)return;

    entry.version=room.snapshotVersion;
    const sameDraft=key(room.draft)===key(entry.draft);
    const confirmsAttempt=entry.attempt&&key(room.draft)===key(entry.attempt);
    if(!entry.dirty||sameDraft) {
      if(discardVisible) {
        this.discard(entry);
      } else {
        entry.draft=room.draft;
        entry.draftToken=room.draftToken;
        entry.dirty=false;
        entry.attempt=null;
        entry.issue=null;
        entry.error=null;
        this.publish(entry);
      }
      return;
    }
    if(room.draftToken!==entry.draftToken&&!confirmsAttempt) {
      entry.issue='conflict';
      entry.error=null;
      this.publish(entry);
      return;
    }
    if(confirmsAttempt||resume&&entry.issue==='retry') {
      entry.draftToken=room.draftToken;
      entry.attempt=null;
      entry.issue=null;
      this.publish(entry);
      this.schedule(entry);
    }
  }

  async check(id,resume=false) {
    const entry=this.records.get(id);
    if(!entry||!this.online)return;
    if(entry.reading)return entry.reading;
    entry.reading=api('/rooms/'+id,undefined,readOptions()).then(room=>{
      this.observe(room,{resume});
      return room;
    }).catch(()=>null).finally(()=>{entry.reading=null;});
    return entry.reading;
  }

  setOnline(online) {
    this.online=online;
    for(const entry of this.records.values()) {
      if(!online)clearTimeout(entry.timer);
      else if(entry.request||entry.issue==='retry')void this.check(entry.id,true);
      else this.schedule(entry);
    }
  }

  async resolve(id,choice) {
    const entry=this.records.get(id);
    const room=await this.check(id);
    if(!room||this.records.get(id)!==entry||room.snapshotVersion<entry.version||entry.request||entry.sending)return;
    if(choice==='retry'&&entry.issue==='conflict')return;
    const keepLocal=choice!=='adopt';
    entry.issue=null;
    entry.error=null;
    entry.attempt=null;
    entry.version=room.snapshotVersion;
    entry.draftToken=room.draftToken;
    if(!keepLocal)entry.draft=room.draft;
    entry.dirty=keepLocal;
    this.publish(entry);
    await this.flush(id);
  }

  async savedToken(room) {
    const entry=this.records.get(room.id);
    await this.flush(room.id);
    if(this.materialImports.get(room.id)?.pending) throw new Error('请等本轮材料添加完成。');
    if (entry?.dirty || entry?.issue || entry?.request || entry?.sending) {
      throw new Error('请先核对并保存当前输入框中的草稿。');
    }
    return entry?.draftToken??room.draftToken;
  }

  async send(room) {
    const entry=this.entry(room);
    if(this.materialImports.get(room.id)?.pending||entry.sending||entry.request&&entry.request.phase!=='retry')return false;
    this.materialImports.delete(room.id);
    entry.sending=true;
    this.publish(entry);
    try {
      if(!entry.request) {
        await this.flush(entry.id);
        if(this.records.get(entry.id)!==entry||entry.dirty||entry.issue)return false;
        const draft=entry.draft;
        entry.request={phase:'sending',body:{...draft,text:draft.text.trim(),draftToken:entry.draftToken,
          clientRequestId:crypto.randomUUID(),authorized:true,useWorkspaceMemory:room.useWorkspaceMemory===true}};
      } else entry.request.phase='sending';
      this.publish(entry);
      const request=entry.request;
      try {
        await api('/rooms/'+entry.id+'/runs',request.body,{signal:AbortSignal.timeout(15000)});
        if(this.records.get(entry.id)===entry&&entry.request===request) {
          entry.draft=emptyDraft;
          entry.dirty=false;
          request.phase='accepted';
          this.publish(entry);
          await this.check(entry.id);
        }
        return true;
      } catch(error) {
        if(this.records.get(entry.id)!==entry||entry.request!==request)return true;
        if(error.code) {
          entry.request=null;
          if(error.code==='draft_conflict') {
            entry.dirty=true;
            entry.issue='conflict';
            await this.check(entry.id);
          }
          throw error;
        }
        request.phase='checking';
        this.publish(entry);
        await this.check(entry.id);
        return !entry.request;
      }
    } finally {
      entry.sending=false;
      this.publish(entry);
    }
  }
}


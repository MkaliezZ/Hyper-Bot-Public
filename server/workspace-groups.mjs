import { randomUUID } from 'node:crypto';
import { lstat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { Problem, id } from './contracts.mjs';
import { HyperBot } from './application.mjs';
import { Store } from './store.mjs';
import { Workbench } from './workbench.mjs';
import { workspaceLock } from './workspace-lock.mjs';

export const personalWorkspace = Object.freeze({id:'personal',name:'个人工作区'});
export const workspaceName = z.string().trim().min(1).max(40).regex(/^[^\p{Cc}]+$/u);
const input = z.strictObject({name:workspaceName});
const normalizedName = name => name.normalize('NFKC').toLocaleLowerCase('zh-CN');

export function savedGroups(state) {
  return state.workspaceGroups ?? [];
}

export class WorkspaceGroups {
  hosts = new Map();
  creating = new Map();

  constructor(primary,config,workbenchFactory) {
    this.primary=primary;
    this.config=config;
    this.workbenchFactory=workbenchFactory;
  }

  list() {
    return [personalWorkspace,...savedGroups(this.primary.store.read())];
  }

  create(raw) {
    const {name}=input.parse(raw);
    const key=normalizedName(name);
    if (key===normalizedName(personalWorkspace.name)) {
      throw new Problem(409,'此工作区名称已在使用。','workspace_name');
    }
    const existing=this.list().find(item=>normalizedName(item.name)===key);
    if (existing) return existing;
    if (!this.creating.has(key)) {
      const group={id:randomUUID(),name};
      this.creating.set(key,this.initialize(group,true).then(()=>{
        this.primary.store.change(state=>{(state.workspaceGroups??=[]).push(group);});
        return group;
      }).finally(()=>this.creating.delete(key)));
    }
    return this.creating.get(key);
  }

  get(key) {
    if (key===personalWorkspace.id) return this.primary;
    id.parse(key);
    const group=this.list().find(item=>item.id===key);
    if (!group) throw new Problem(404,'工作区不存在。','not_found');
    return this.initialize(group);
  }

  initialize(group,fresh=false) {
    if (!this.hosts.has(group.id)) {
      this.hosts.set(group.id,this.open(group,fresh).catch(error=>{
        this.hosts.delete(group.id);
        throw error;
      }));
    }
    return this.hosts.get(group.id);
  }

  async open(group,fresh) {
    const parent=path.join(this.config.data,'groups');
    const data=path.join(parent,group.id);
    if (fresh) await mkdir(parent,{recursive:true,mode:0o700});
    for (const directory of [parent,data]) {
      if (fresh && directory===data) await mkdir(data,{mode:0o700});
      const info=await lstat(directory).catch(error=>{
        if (error.code==='ENOENT') throw new Problem(404,'工作区数据目录缺失。','not_found');
        throw error;
      });
      if (!info.isDirectory()||info.isSymbolicLink()) throw new Problem(409,'工作区数据目录无效。','workspace_directory');
    }
    const release=await workspaceLock(data);
    let store, app;
    try {
      const database=path.join(data,'hyper-bot.sqlite');
      if (!fresh) {
        const info=await lstat(database);
        if (!info.isFile()||info.isSymbolicLink()) throw new Problem(409,'工作区数据库无效。','workspace_directory');
      }
      store=new Store(database);
      await store.init();
      if (fresh) {
        const source=this.primary.store.read();
        store.change(state=>{
          // Start with the local catalog structure, retaining any prior skill revocations.
          const builtIns=new Set(state.skills.map(skill=>skill.id));
          const revoked=new Set(source.skills.filter(skill=>builtIns.has(skill.id)&&skill.revokedAt).map(skill=>skill.id));
          state.skills=state.skills.map(skill=>revoked.has(skill.id)?source.skills.find(row=>row.id===skill.id):skill);
          for (const bot of state.bots) if (bot.skills.some(skill=>revoked.has(skill))) bot.status='disabled';
          state.installedBots=[];
        });
      }
      const config=Object.assign(Object.create(this.config),{data,allowOriginalWorkbench:false});
      app=new HyperBot(store,config,this.workbenchFactory?.(config) ?? new Workbench(config));
      await app.boot();
      return {app,store,group,release};
    } catch(error) {
      try { await app?.shutdown(); }
      finally {try {store?.close();} finally {await release();}}
      throw error;
    }
  }

  async requireIdle(message) {
    const pending=[...this.hosts.values()];
    if (this.creating.size) throw new Problem(409,message,'busy');
    this.primary.app.requireIdle(message);
    for (const {app} of await Promise.all(pending)) app.requireIdle(message);
  }

  async expire() {
    for (const result of await Promise.allSettled(this.hosts.values())) {
      if (result.status==='fulfilled') {
        try { result.value.app.expire(); }
        catch(error) { console.error('Hyper Bot workspace expiry:',error?.code??error?.name); }
      }
    }
  }

  async close() {
    await Promise.allSettled(this.creating.values());
    const closing=await Promise.allSettled([...this.hosts.values()].map(async pending=>{
      const {app,store,release}=await pending;
      try { await app.shutdown(); }
      finally {try {store.close();} finally {await release();}}
    }));
    const failures=closing.filter(result=>result.status==='rejected');
    if (failures.length) throw new AggregateError(failures.map(result=>result.reason),'工作区关闭失败。');
  }
}

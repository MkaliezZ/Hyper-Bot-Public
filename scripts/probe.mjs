import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import { configFor } from '../server/config.mjs';
import { execute } from '../server/engines.mjs';
import { randomUUID } from 'node:crypto';

const selected=process.argv.slice(2);
if (!selected.length || selected.some(item=>!['dsh','hermes'].includes(item))) {
  throw new Error('Usage: node scripts/probe.mjs dsh hermes');
}
const config=await configFor({data:await mkdtemp(join(tmpdir(),'hyper-bot-probe-')),timeoutMs:45000});
for (const driver of selected) {
  let usage=null;
  try {
    const answer=await execute(config,driver,randomUUID(),
      '这是仅检查运行时连通性的合成测试。只输出以下两个字：就绪',
      new AbortController().signal,()=>{},entry=>{usage=entry;});
    console.log(JSON.stringify({driver,returnedExpected:answer.trim()==='就绪',usage}));
    if(answer.trim()!=='就绪')process.exitCode=1;
  } catch(error) {
    console.log(JSON.stringify({driver,code:error.code??error.name,error:error.message,usage}));
    process.exitCode=1;
  }
}


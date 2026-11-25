import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readWindow } from '../test/native-api.mjs';

const [, , unpacked, flag, screenshot]=process.argv;
if (!unpacked || flag!=='--real') throw new Error('Pass the extracted package and --real to run one synthetic task with the configured DeepSeek provider.');
const require=createRequire(import.meta.url);
const {_electron}=require(process.env.HYPER_BOT_TEST_PLAYWRIGHT || 'playwright');
const data=await mkdtemp(path.join(os.tmpdir(),'hb-web-host-desktop-'));
const env={...process.env,HYPER_BOT_DATA_DIR:data};
delete env.HYPER_BOT_NODE_RUNTIME;
const app=await _electron.launch({executablePath:path.join(unpacked,'Hyper Bot.exe'),cwd:unpacked,env,timeout:35000});
try {
  const page=await app.firstWindow();
  await page.waitForURL(/^http:\/\/127\.0\.0\.1:/);
  const api=route=>readWindow(page,'/api'+route);
  assert.equal(await page.title(),'Hyper Bot');
  await page.getByRole('link',{name:'Bot 目录',exact:true}).click();
  const card=page.locator('.directory-card').filter({has:page.getByRole('heading',{name:'自媒体口播',exact:true})});
  assert.equal((await api('/workspace')).bots.find(bot=>bot.id==='media')?.driver,'dsh-web');
  await card.getByRole('button',{name:'新建会话',exact:true}).click();
  await page.getByRole('button',{name:'载入书店演练',exact:true}).click();
  await page.waitForURL(/#chat\/[0-9a-f-]+$/);
  await page.getByRole('button',{name:'发送消息',exact:true}).click();
  const approve=page.getByRole('button',{name:'允许本次写入',exact:true});
  await Promise.race([
    approve.waitFor({timeout:105000}),
    page.getByText('任务失败',{exact:true}).first().waitFor({timeout:105000}).then(async()=>{
      const room=await api('/rooms/'+page.url().split('#chat/')[1]);
      throw new Error('Synthetic desktop run failed: '+room.runs.at(-1)?.error);
    })
  ]);
  await approve.click();
  await page.getByText('v1',{exact:true}).first().waitFor({timeout:18000});
  const id=page.url().split('#chat/')[1];
  const room=await api('/rooms/'+id);
  const result=room.artifacts.at(-1), run=room.runs.at(-1);
  assert.equal(run.driver,'dsh-web');
  assert.equal(run.state,'succeeded');
  assert.equal(run.usage.requests,1);
  assert.equal(result?.receipt?.project,room.project);
  assert.ok(result.receipt.id);
  await page.getByRole('heading',{name:'分镜时间轴',exact:true}).waitFor();
  if (screenshot) await page.screenshot({path:screenshot,animations:'disabled'});
  console.log(JSON.stringify({version:await app.evaluate(({app})=>app.getVersion()),room:id,run:run.id,
    harness:run.driver,session:run.engineSession,workbench:result.receipt,segments:result.result.segments.length,
    usage:run.usage,synthetic:true}));
} finally {
  await app.close();
}


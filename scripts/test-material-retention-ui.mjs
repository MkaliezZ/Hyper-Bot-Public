import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { access, mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from '../server/http.mjs';
import { restoreWorkspace } from '../server/workspace-archive.mjs';
import { readWindow, windowRequest } from '../test/native-api.mjs';

const require=createRequire(import.meta.url);
const {chromium,_electron}=require(process.env.HYPER_BOT_TEST_PLAYWRIGHT || 'playwright');
const [archive,packaged,shots]=process.argv.slice(2);
if (!archive) throw new Error('Provide the synthetic bookshop backup, optionally a package folder and screenshot destination.');
const workspace=await mkdtemp(path.join(tmpdir(),'hb-retention-ui-'));
const web=path.join(workspace,'浏览器工作区');
const native=path.join(workspace,'桌面工作区');
const checks=[];
const pass=label=>{checks.push(label);console.log('OK '+label);};

async function openRoom(page,origin) {
  if (!page.url().startsWith(origin+'/')) await page.goto(origin+'/');
  const all=await readWindow(page,'/api/workspace');
  const session=all.conversations.find(room=>room.botId==='media');
  const room=await readWindow(page,'/api/rooms/'+session.id);
  await page.goto(origin+'/#chat/'+session.id);
  await page.getByRole('heading',{name:'自媒体口播',exact:true}).waitFor();
  return room;
}
async function openMaterial(page,mobile,filename) {
  if(mobile) await page.getByRole('button',{name:'预览',exact:true}).click();
  await page.getByRole('tab',{name:/^材料/}).click();
  if (filename) await page.locator('.side-row').filter({hasText:filename}).getByRole('button').click();
  await page.getByRole('heading',{name:'原文预览',exact:true}).waitFor();
  await page.getByRole('button',{name:'管理授权',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'材料授权',exact:true});
  await dialog.waitFor();
  return dialog;
}
function tomorrow() {
  const date=new Date(Date.now()+86400000);
  return new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,16);
}
const root=fileURLToPath(new URL('..',import.meta.url));
await restoreWorkspace(archive,web);
const host=await launch({options:{data:web,providerKey:''}});
let browser;
try {
  browser=await chromium.launch({executablePath:process.env.HYPER_BOT_TEST_CHROMIUM || undefined});
  if (shots) await mkdir(shots,{recursive:true});
  const desktop=await browser.newPage({viewport:{width:1440,height:900}});
  const errors=[];
  desktop.on('pageerror',error=>errors.push(error.message));
  const room=await openRoom(desktop,host.origin);
  const material=room.materials[0];
  const dialog=await openMaterial(desktop,false,material.name);
  const form=dialog.locator('input[type=datetime-local]');
  const deadline=tomorrow();
  await form.fill(deadline);
  assert.equal(await dialog.evaluate(el=>getComputedStyle(el).animationDuration),'0.24s');
  if(shots) await desktop.screenshot({path:path.join(shots,'桌面-材料授权.png'),animations:'disabled'});
  await dialog.getByRole('button',{name:'保存期限'}).click();
  await desktop.getByText('授权期限已保存。',{exact:true}).waitFor();
  await dialog.waitFor({state:'hidden'});
  await desktop.getByText(/^有效至 /).waitFor();
  const changed=await fetch(host.origin+'/api/rooms/'+room.id).then(res=>res.json());
  assert.equal(changed.materials[0].expiresAt,new Date(deadline).toISOString());
  pass('桌面材料页设置授权期限，沿用 240ms 对话框动效');

  const mobile=await browser.newPage({viewport:{width:390,height:844},hasTouch:true,isMobile:true,reducedMotion:'reduce'});
  mobile.on('pageerror',error=>errors.push(error.message));
  await openRoom(mobile,host.origin);
  const narrow=await openMaterial(mobile,true,material.name);
  assert.equal(await narrow.evaluate(el=>getComputedStyle(el).animationName),'none');
  await mobile.keyboard.press('Escape');
  await narrow.waitFor({state:'hidden'});
  await mobile.locator('#right-preview').waitFor();
  await mobile.getByRole('button',{name:'管理授权',exact:true}).click();
  await narrow.getByRole('button',{name:'撤回授权…'}).click();
  const confirm=mobile.getByRole('dialog',{name:'撤回材料授权',exact:true});
  await confirm.waitFor();
  if(shots) await mobile.screenshot({path:path.join(shots,'手机-撤回确认.png'),animations:'disabled'});
  const view=await confirm.boundingBox();
  assert.ok(view.x>=0 && view.x+view.width<=390 && view.y>=0 && view.y+view.height<=844);
  await confirm.getByRole('button',{name:'确认撤回'}).click();
  await mobile.getByRole('heading',{name:'授权已撤回',exact:true}).waitFor();
  assert.equal(await mobile.getByRole('heading',{name:'原文预览',exact:true}).count(),0);
  assert.equal(await mobile.locator('.chat-files').getByText(material.name,{exact:true}).count(),0);
  await mobile.getByRole('tab',{name:/^版本/}).click();
  await mobile.getByRole('button',{name:'查看此版',exact:true}).click();
  await mobile.getByRole('heading',{name:'稿件内容已清理',exact:true}).waitFor();
  assert.equal(await mobile.getByRole('button',{name:'导出稿件',exact:true}).count(),0);
  assert.deepEqual(errors,[]);
  pass('手机撤回确认、键盘返回、减少动效与版本占位正确');
} finally {
  await browser?.close();
  await host.close();
}

if (packaged) {
  await restoreWorkspace(archive,native);
  const env={...process.env,HYPER_BOT_DATA_DIR:native};
  delete env.HYPER_BOT_NODE_RUNTIME;
  delete env.DEEPSEEK_API_KEY;
  const app=await _electron.launch({executablePath:path.join(packaged,'Hyper Bot.exe'),cwd:packaged,env,
    timeout:35000});
  try {
    const page=await app.firstWindow();
    await page.waitForURL(/^http:\/\/127\.0\.0\.1:/);
    const origin=new URL(page.url()).origin;
    const room=await openRoom(page,origin);
    const deadlinePath='/api/rooms/'+room.id+'/materials/'+room.materials[0].id+'/revoke';
    const target=path.join(workspace,'授权结束后禁止写入.md');
    await app.evaluate(({dialog},target)=>{
      dialog.showSaveDialog=()=>{
        globalThis.holdNativeExport=true;
        return new Promise(resolve=>{globalThis.resumeNativeExport=()=>resolve({filePath:target,canceled:false});});
      };
    },target);
    await page.getByRole('button',{name:'导出稿件',exact:true}).click();
    for (let i=0;i<70&&!await app.evaluate(()=>!!globalThis.holdNativeExport);i++) {
      await page.waitForTimeout(75);
    }
    assert.ok(await app.evaluate(()=>globalThis.holdNativeExport));
    const revoked=await windowRequest(page,deadlinePath,{confirmed:true});
    assert.equal(revoked.status,202);
    await app.evaluate(()=>globalThis.resumeNativeExport());
    await page.getByText(/此稿件的材料授权已结束/).waitFor();
    await assert.rejects(access(target),{code:'ENOENT'});
    const manifest=JSON.parse(await readFile(path.join(packaged,'发布候选清单.json'),'utf8'));
    assert.equal(await app.evaluate(({app})=>app.getVersion()),manifest.version);
    pass('打包桌面版在保存对话框返回后再次核权，保护写入目标');
  } finally {await app.close();}
}
console.log(JSON.stringify({checks,packaged:!!packaged,sourceRoot:root}));


import { launch } from './http.mjs';

const port=Number(process.env.HYPER_BOT_PORT ?? 4367);
if (!Number.isInteger(port) || port<1024 || port>65535) throw new Error('HYPER_BOT_PORT 必须在 1024–65535 之间。');
const host=await launch({port,dev:process.argv.includes('--dev'),
  frontendAssets:process.env.HYPER_BOT_FRONTEND_ASSETS||undefined});
console.log('Hyper Bot '+host.origin);
async function shutdown() {
  try { await host.close();process.exitCode=0; }
  catch { process.exitCode=1; }
}
process.on('SIGINT',shutdown);
process.on('SIGTERM',shutdown);


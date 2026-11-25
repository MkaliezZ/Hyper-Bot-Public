export async function waitForExit(ended, milliseconds) {
  let timer;
  const timeout = new Promise(resolve => { timer=setTimeout(()=>resolve(false),milliseconds); });
  try {
    return await Promise.race([ended.then(()=>true),timeout]);
  } finally {
    clearTimeout(timer);
  }
}

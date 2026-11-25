import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { open, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Problem } from './contracts.mjs';

const busy = () => new Problem(409, '已有 Hyper Bot 进程使用该数据目录。请从托盘退出后再继续。', 'workspace_busy');

function isAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return true;
  try { process.kill(pid, 0); }
  catch (error) { if (error.code === 'ESRCH') return false; }
  return true;
}

export async function workspaceLock(data) {
  // Serialize new hosts and maintenance tasks even if they meet a stale marker.
  const guard = new DatabaseSync(path.join(data, 'workspace-guard.sqlite'));
  try {
    guard.exec('PRAGMA busy_timeout=400; BEGIN EXCLUSIVE');
  } catch (error) {
    guard.close();
    if (error.errcode === 5 || error.errcode === 6) throw busy();
    throw error;
  }

  // dev.1 also recognizes this marker. Keep it during the whole lease so
  // upgrading and rolling back cannot run both releases on the same data.
  const file = path.join(data, 'host.lock');
  const token = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
  try {
    let handle;
    try {
      handle = await open(file, 'wx', 0o600);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const contents = await readFile(file, 'utf8').catch(() => null);
      let prior;
      try { prior = JSON.parse(contents); } catch { throw busy(); }
      if (isAlive(prior?.pid) || await readFile(file, 'utf8').catch(() => null) !== contents) throw busy();
      await unlink(file);
      handle = await open(file, 'wx', 0o600).catch(error => {
        if (error.code === 'EEXIST') throw busy();
        throw error;
      });
    }
    try { await handle.writeFile(token); }
    finally { await handle.close(); }
  } catch (error) {
    guard.close();
    throw error;
  }

  return async () => {
    try {
      if (await readFile(file, 'utf8').catch(() => null) === token) await unlink(file);
    } finally {
      guard.close();
    }
  };
}


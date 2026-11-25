import { lstatSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

function preferencePath(data,name) {
  const directory=path.join(realpathSync(data),'desktop');
  const info=lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(directory)!==directory) {
    throw new Error('Invalid desktop preference directory');
  }
  return path.join(directory,name);
}

function regularFile(file) {
  try {
    const entry=lstatSync(file);
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Invalid preference file');
    return entry;
  } catch(error) {
    if (error.code==='ENOENT') return null;
    throw error;
  }
}

export function readPreference(data,name,maxBytes) {
  const file=preferencePath(data,name),info=regularFile(file);
  if (!info) return null;
  if (info.size<1 || info.size>maxBytes) throw new Error('Invalid preference size');
  return readFileSync(file);
}

export function writePreference(data,name,bytes) {
  const file=preferencePath(data,name),previous=regularFile(file);
  const pending=file+'.pending';
  if (regularFile(pending)) unlinkSync(pending);
  if (bytes===null) {
    if (previous) unlinkSync(file);
    return;
  }
  try {
    writeFileSync(pending,bytes,{flag:'wx',mode:0o600,flush:true});
    renameSync(pending,file);
  } catch(error) {
    try { unlinkSync(pending); } catch {}
    throw error;
  }
}

import path from 'node:path';
import { z } from 'zod';
import { Problem } from '../server/contracts.mjs';
import { readPreference, writePreference } from './preferences.mjs';

const filename='runtime-installations.json';
const absolute=z.string().min(1).max(4096).refine(value=>path.isAbsolute(value)&&!value.includes('\0'));
export const runtimeId=z.enum(['workbench','hermes']);
export const installation=z.strictObject({root:absolute,python:absolute});
const file=z.strictObject({schema:z.literal(1),workbench:installation.optional(),hermes:installation.optional()});

export function readRuntimeInstallations(data) {
  try {
    const content=readPreference(data,filename,70000);
    if (!content) return {overrides:{},issue:false};
    const {schema,...overrides}=file.parse(JSON.parse(content.toString('utf8')));
    return {overrides,issue:false};
  } catch {
    return {overrides:{},issue:true};
  }
}

export function saveRuntimeInstallation(data,id,selection) {
  try {
    const {overrides}=readRuntimeInstallations(data);
    if (selection) overrides[id]=selection;
    else delete overrides[id];
    const bytes=Object.keys(overrides).length?Buffer.from(JSON.stringify({schema:1,...overrides})+'\n'):null;
    writePreference(data,filename,bytes);
  } catch {
    throw new Problem(503,'本机组件登记无法保存。请检查工作区的访问权限。','runtime_storage');
  }
}

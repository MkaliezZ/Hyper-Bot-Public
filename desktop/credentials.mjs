import { Problem } from '../server/contracts.mjs';
import { readPreference, writePreference } from './preferences.mjs';

const filename='deepseek-credential.dpapi';
const maximumBlob=16384;

function normalize(value) {
  const key=typeof value==='string'?value.trim():'';
  if (!/^[\x21-\x7e]{1,1024}$/.test(key)) {
    throw new Problem(422,'请输入有效的 DeepSeek API Key。','credential_format');
  }
  return key;
}

function resolved(key,local,canStore,environmentKey) {
  return {key:key??environmentKey??null,status:{
    source:key?'desktop':environmentKey?'environment':null,
    local,canStore,environmentFallback:!!environmentKey
  }};
}

export function desktopCredentialStore(data,safeStorage,environmentKey) {
  const canStore=process.platform==='win32'&&safeStorage.isEncryptionAvailable();
  return {
    read() {
      try {
        const bytes=readPreference(data,filename,maximumBlob);
        if (!bytes) return resolved(null,'missing',canStore,environmentKey);
        if (!canStore) throw new Error('Credential cannot be decrypted');
        return resolved(normalize(safeStorage.decryptString(bytes)),'stored',canStore,environmentKey);
      } catch {
        return resolved(null,'unreadable',canStore,environmentKey);
      }
    },
    change(value) {
      if (!canStore) throw new Problem(503,'Windows 凭据加密暂不可用。','credential_storage');
      if (value===null) return {credential:resolved(null,'missing',canStore,environmentKey),sealed:null};
      const key=normalize(value);
      try {
        return {credential:resolved(key,'stored',canStore,environmentKey),sealed:safeStorage.encryptString(key).toString('base64')};
      } catch {
        throw new Problem(503,'Windows 无法加密本机凭据。','credential_storage');
      }
    }
  };
}

export function persistDesktopCredential(data,sealed) {
  try {
    const bytes=sealed===null?null:Buffer.from(sealed,'base64');
    if (bytes && (!bytes.length || bytes.length>maximumBlob)) throw new Error('Invalid encrypted credential');
    writePreference(data,filename,bytes);
  } catch {
    throw new Problem(503,'本机凭据文件无法更新。请检查工作区的访问权限。','credential_storage');
  }
}

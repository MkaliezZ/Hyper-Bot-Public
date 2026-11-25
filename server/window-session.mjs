import { randomBytes, timingSafeEqual } from 'node:crypto';

export const windowHeader = 'x-hyper-bot-window';
export const newWindowKey = () => randomBytes(32).toString('hex');
export const validWindowKey = value => typeof value==='string' && /^[a-f0-9]{64}$/.test(value);

export function matchesWindowKey(value, expected) {
  return validWindowKey(value) && timingSafeEqual(Buffer.from(value,'hex'),Buffer.from(expected,'hex'));
}

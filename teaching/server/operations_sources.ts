import { get } from 'node:https';
import type { OpsSignal } from '../shared/operations.js';
import { isOpsDate } from './operations_calendar.js';

type SourceEntry = Pick<OpsSignal, 'title' | 'publishedOn' | 'sourceUrl'>;
type Source = {
  url: string;
  kind: OpsSignal['kind'];
  track: OpsSignal['track'];
  region: string;
  maxAgeDays: number;
  contentType: string;
  parse: (body: string) => SourceEntry[];
};

const governmentIndex = 'https://www.gov.cn/zhengce/zuixin/ZUIXINZHENGCE.json';
const etsIndex = 'https://www.ets.org/toefl/blog.html';
const maxBytes = 1024 * 1024;
const timeoutMs = 12_000;
const dayInMs = 86_400_000;
const interest = /校外教育培训|校外培训|义务教育|中小学|双减|基础教育|课后服务|校历|节假日安排|寒暑假/;
const months = 'January February March April May June July August September October November December'.split(' ');

function officialUrl(value: string, index: string, articlePath: RegExp) {
  try {
    const url = new URL(value, index);
    if (url.origin !== new URL(index).origin || url.username || url.password || !articlePath.test(url.pathname)) return null;
    return url.origin + url.pathname;
  } catch {
    return null;
  }
}

export function sourceUrlIdentity(value: string) {
  const government = officialUrl(value, governmentIndex, /^\/zhengce\/(?:[a-z\d-]+\/)*content_\d+\.htm$/i);
  const ets = officialUrl(value, etsIndex, /^\/toefl\/blog\/[a-z\d-]+\.html$/i);
  return government ?? ets ?? value;
}

function cleanText(value: string) {
  const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return value.replace(/<[^>]*>/g, ' ').replace(/&(#\d+|#x[\da-f]+|amp|lt|gt|quot|apos|nbsp);/gi, (whole, token: string) => {
    if (!token.startsWith('#')) return entities[token.toLowerCase()] ?? whole;
    const hex = token[1]?.toLowerCase() === 'x';
    const code = Number.parseInt(token.slice(hex ? 2 : 1), hex ? 16 : 10);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : ' ';
  }).replace(/[\s\u0000-\u001f\u007f]+/g, ' ').trim();
}

function englishDate(value: string) {
  const parts = /^([A-Za-z]+) (\d{1,2}), (\d{4})$/.exec(value);
  if (!parts) return null;
  const month = months.findIndex(name => name.toLowerCase() === parts[1].toLowerCase()) + 1;
  if (!month) return null;
  const date = `${parts[3]}-${String(month).padStart(2, '0')}-${parts[2].padStart(2, '0')}`;
  return isOpsDate(date) ? date : null;
}

function parseGovernment(body: string): SourceEntry[] {
  const entries: unknown = JSON.parse(body);
  if (!Array.isArray(entries)) throw new Error('Unrecognized government index');
  return entries.flatMap((entry): SourceEntry[] => {
    if (!entry || typeof entry !== 'object' || typeof entry.TITLE !== 'string' ||
        typeof entry.URL !== 'string' || typeof entry.DOCRELPUBTIME !== 'string') return [];
    const title = cleanText(entry.TITLE);
    const publishedOn = entry.DOCRELPUBTIME.trim();
    const sourceUrl = officialUrl(entry.URL, governmentIndex, /^\/zhengce\/(?:[a-z\d-]+\/)*content_\d+\.htm$/i);
    return title && sourceUrl && isOpsDate(publishedOn) ? [{ title, publishedOn, sourceUrl }] : [];
  });
}

function parseEts(body: string): SourceEntry[] {
  const field = (card: string, tag: string) => cleanText(
    card.match(new RegExp(`<div\\b[^>]*class=["']${tag}["'][^>]*>([\\s\\S]*?)<\\/div>`, 'i'))?.[1] ?? '',
  );
  return body.split(/<div\b[^>]*class=["']bcs__card["'][^>]*>/i).slice(1).flatMap((excerpt): SourceEntry[] => {
    const card = excerpt.slice(0, 6500);
    const title = field(card, 'bcs__title');
    const publishedOn = englishDate(field(card, 'bcs__pd'));
    const actions = card.match(/<div\b[^>]*class=["']bcs__action["'][^>]*>([\s\S]*?)<\/div>/i)?.[1] ?? '';
    const href = actions.match(/<a\b[^>]*href=["']([^"']+)["']/i)?.[1];
    const sourceUrl = href ? officialUrl(href, etsIndex, /^\/toefl\/blog\/[a-z\d-]+\.html$/i) : null;
    return title && publishedOn && sourceUrl ? [{ title, publishedOn, sourceUrl }] : [];
  });
}

const sources: Source[] = [
  { url: governmentIndex, kind: 'policy', track: 'k12', region: '中国大陆', maxAgeDays: 365, contentType: 'application/json', parse: parseGovernment },
  { url: etsIndex, kind: 'hotspot', track: 'toefl', region: 'ETS 官方资讯', maxAgeDays: 14, contentType: 'text/html', parse: parseEts },
];

function download(source: Source): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = get(source.url, {
      signal: AbortSignal.timeout(timeoutMs), maxHeaderSize: 64 * 1024,
      headers: { Accept: source.contentType, 'Accept-Encoding': 'identity' },
    }, response => {
      response.on('error', reject);
      const type = response.headers['content-type']?.split(';')[0]?.trim().toLowerCase();
      const encoding = response.headers['content-encoding'];
      if (response.statusCode !== 200 || type !== source.contentType ||
          (encoding && encoding.toLowerCase() !== 'identity') || Number(response.headers['content-length']) > maxBytes) {
        response.destroy();
        reject(new Error('Official source did not return the expected index'));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) {
          reject(new Error('Official index is too large'));
          response.destroy();
        } else {
          chunks.push(chunk);
        }
      });
      response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '')));
    });
    request.on('error', reject);
  });
}

export async function discoverOpsSignals(today: string, read: (source: Source) => Promise<string> = download) {
  const results = await Promise.allSettled(sources.map(async source => {
    const entries = source.parse(await read(source));
    if (!entries.length) throw new Error('Official index contains no dated entries');
    const earliest = Date.parse(today) - source.maxAgeDays * dayInMs;
    const recent = entries.filter(entry => entry.publishedOn <= today &&
      Date.parse(entry.publishedOn) >= earliest && (source.kind === 'hotspot' || interest.test(entry.title)));
    return recent.sort((a, b) => b.publishedOn.localeCompare(a.publishedOn)).slice(0, 12).map((entry): Omit<OpsSignal, 'id'> => ({
      ...entry, title: entry.title.slice(0, 100), kind: source.kind, track: source.track, region: source.region,
      effectiveOn: null, status: 'unverified',
      facts: '已从官方列表提取标题、刊载日期和链接。请打开原文核对正文、适用范围及生效时间。',
      reviewNotes: '',
    }));
  }));
  const candidates = results.flatMap(result => result.status === 'fulfilled' ? result.value : []);
  const unique = [...new Map(candidates.map(candidate => [candidate.sourceUrl, candidate])).values()];
  return { candidates: unique, sources: results.length, unavailable: results.filter(result => result.status === 'rejected').length };
}

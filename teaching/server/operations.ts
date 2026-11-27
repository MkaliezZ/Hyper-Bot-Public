import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { OpsCalendarItem, OpsDashboard, OpsEnrollment, OpsFollowUp, OpsHistoryRow, OpsSignal } from '../shared/operations.js';
import { buildCalendar, buildSignals, isOfficialSource, isOpsDate, isOpsSourceUrl } from './operations_calendar.js';
import { createOpsDemo } from './operations_demo.js';
import { assessRenewals } from './operations_renewal.js';
import { discoverOpsSignals, sourceUrlIdentity } from './operations_sources.js';

type Dependencies = {
  db: DatabaseSync;
  auth: (request: FastifyRequest) => { owner: string };
  PublicError: new (statusCode: number, message: string) => Error;
};

type Kind = 'calendar' | 'signal' | 'renewal' | 'history';
type OpsRecord = OpsCalendarItem | OpsEnrollment | OpsHistoryRow | OpsSignal;

const base = '/api/v1/operations';
const timezone = 'Asia/Shanghai';
const dayMs = 86_400_000;
const maxCsvRows = 500;
const maxCsvBytes = 256 * 1024;
const track = z.enum(['k12', 'toefl', 'ielts']);
const audience = z.enum(['all', ...track.options]);
const id = z.string().trim().regex(/^(?!\d{7,}$)[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/)
  .refine(value => !Object.hasOwn(Object.prototype, value));
const date = z.string().refine(isOpsDate);
const feedback = z.enum(['unknown', 'positive', 'neutral', 'concern']);
const attendance = z.number().min(0).max(100).nullable();
const sourceUrl = z.string().trim().max(1400).refine(isOpsSourceUrl);
const alias = z.string().trim().min(1).max(60).refine(value =>
  !/[\u0000-\u001f\u007f]|\S+@\S+|(?:\d[ ()-]*){7,}/.test(value));

const calendarInput = z.object({
  id: id.optional(), title: z.string().trim().min(1).max(100), track: audience,
  date, leadDays: z.number().int().min(0).max(365),
  recurrence: z.enum(['once', 'annual']), status: z.enum(['confirmed', 'tentative', 'done']),
  sourceUrl: z.union([z.literal(''), sourceUrl]), details: z.string().trim().max(1000),
}).strict();

const signalInput = z.object({
  id: id.optional(), kind: z.enum(['policy', 'hotspot']), title: z.string().trim().min(1).max(100),
  track: audience, region: z.string().trim().min(1).max(100), sourceUrl,
  publishedOn: date, effectiveOn: date.nullable(), status: z.enum(['unverified', 'verified', 'dismissed']),
  facts: z.string().trim().min(1).max(1500), reviewNotes: z.string().trim().max(1000),
}).strict();

export const enrollmentInput = z.object({
  id, label: alias, track, endOn: date.nullable(), remainingLessons: z.number().min(0).max(10000).nullable(),
  attendancePct: attendance, feedback, issue: z.enum(['none', 'schedule', 'learning', 'payment', 'other']),
  state: z.enum(['unpaid', 'planned', 'paid', 'opt_out', 'paused', 'dispute']),
  contactAllowed: z.boolean(), lastContactOn: date.nullable(),
}).strict();

const historyInput = z.object({
  id, track, asOf: date, endOn: date, observedThrough: date, renewed: z.boolean().nullable(),
  arm: z.enum(['standard', 'extra', 'unknown']), randomized: z.boolean(), experimentId: id.nullable().optional(),
  feedback, attendancePct: attendance, state: z.enum(['unpaid', 'planned']),
}).strict();

const followUpInput = z.object({
  date, outcome: z.enum(['contacted', 'payment_planned', 'no_response', 'paused', 'resolved']),
  note: z.string().trim().max(400).refine(value => !/\S+@\S+|(?:\d[ ()-]*){7,}/.test(value)),
  expectedStudentId: z.string().uuid().optional(),
}).strict();

const csvInput = z.object({ csv: z.string().min(1).max(maxCsvBytes) }).strict();
const renewalHeaders = Object.keys(enrollmentInput.shape);
const historyHeaders = Object.keys(historyInput.shape);

function opsDate() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric', month: '2-digit', day: '2-digit', timeZone: timezone,
  }).formatToParts(new Date());
  const get = (type: string) => parts.find(part => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

class CsvError extends Error {}

function csvRows(source: string, headers: string[], optional: string[] = []) {
  if (Buffer.byteLength(source, 'utf8') > maxCsvBytes) throw new CsvError('CSV 超过 256 KiB，请分批导入。');
  const input = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const rows: string[][] = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  let closed = false;

  function endCell() {
    cells.push(cell.trim());
    cell = '';
    closed = false;
  }

  function endRow() {
    endCell();
    if (cells.some(value => value !== '')) rows.push(cells);
    cells = [];
    if (rows.length > maxCsvRows + 1) throw new CsvError(`每次最多导入 ${maxCsvRows} 条记录。`);
  }

  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    if (quoted) {
      if (char === '"' && input[index + 1] === '"') {
        cell += '"';
        index++;
      } else if (char === '"') {
        quoted = false;
        closed = true;
      } else {
        cell += char;
      }
      continue;
    }
    if (char === ',') endCell();
    else if (char === '\n') endRow();
    else if (char === '"' && !closed && !cell.trim()) {
      cell = '';
      quoted = true;
    } else if (char === '"' || (closed && char.trim())) {
      throw new CsvError('CSV 引号格式有误。含逗号的字段须用双引号包裹。');
    } else {
      cell += char;
    }
  }
  if (quoted) throw new CsvError('CSV 末尾有未闭合的双引号。');
  endRow();

  const [actual, ...data] = rows;
  if (!actual || !data.length) throw new CsvError('CSV 须有表头和至少一条记录。');
  if (new Set(actual).size !== actual.length || actual.some(name => !headers.includes(name)) ||
      headers.some(name => !optional.includes(name) && !actual.includes(name))) {
    throw new CsvError(`CSV 表头有误。字段为 ${headers.join(', ')}。`);
  }

  const seen = new Set<string>();
  return data.map((values, index) => {
    if (values.length !== actual.length) throw new CsvError(`第 ${index + 1} 条数据与表头列数不符。`);
    const record = Object.fromEntries(actual.map((field, column) => [field, values[column]]));
    if (seen.has(record.id)) throw new CsvError(`第 ${index + 1} 条数据的内部编号重复。`);
    seen.add(record.id);
    return record;
  });
}

function csvNumber(value: string) {
  return value === '' ? null : /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : value;
}

function csvBoolean(value: string, nullable = false) {
  if (nullable && value === '') return null;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return value;
}

function rowShape<T>(schema: z.ZodType<T>, value: unknown, index: number): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path.map(String).join('.');
    throw new CsvError(`第 ${index + 1} 条数据的${field ? ` ${field} ` : ''}字段格式不符合要求。`);
  }
  return parsed.data;
}

function readRenewals(csv: string, today: string): OpsEnrollment[] {
  return csvRows(csv, renewalHeaders).map((row, index) => {
    const record = rowShape(enrollmentInput, {
      ...row, endOn: row.endOn || null, lastContactOn: row.lastContactOn || null,
      remainingLessons: csvNumber(row.remainingLessons), attendancePct: csvNumber(row.attendancePct),
      contactAllowed: csvBoolean(row.contactAllowed),
    }, index);
    if (record.lastContactOn && record.lastContactOn > today) {
      throw new CsvError(`第 ${index + 1} 条数据的上次联系日期晚于今天。`);
    }
    return record;
  });
}

function readHistory(csv: string, today: string): OpsHistoryRow[] {
  return csvRows(csv, historyHeaders, ['experimentId']).map((row, index) => {
    const record = rowShape(historyInput, {
      ...row, experimentId: row.experimentId || null, renewed: csvBoolean(row.renewed, true),
      randomized: csvBoolean(row.randomized), attendancePct: csvNumber(row.attendancePct),
    }, index);
    const observedDaysPastExpiry = (Date.parse(record.observedThrough) - Date.parse(record.endOn)) / dayMs;
    if (record.asOf > record.endOn || record.observedThrough < record.asOf || record.observedThrough > today) {
      throw new CsvError(`第 ${index + 1} 条历史数据的观察时间顺序不成立。`);
    }
    if (record.renewed === false && observedDaysPastExpiry < 14) {
      throw new CsvError(`第 ${index + 1} 条历史数据尚未观察到期后 14 天，续费结果请留空。`);
    }
    if (record.randomized && (record.arm === 'unknown' || !record.experimentId)) {
      throw new CsvError(`第 ${index + 1} 条随机对照记录需填写分组和试验标识。`);
    }
    return record;
  });
}

export function registerOperations(app: FastifyInstance, { db, auth, PublicError }: Dependencies) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ops_records (
      owner TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('calendar', 'signal', 'renewal', 'history')),
      id TEXT NOT NULL, payload TEXT NOT NULL CHECK (json_valid(payload)), PRIMARY KEY (owner, kind, id)
    );
    CREATE TABLE IF NOT EXISTS ops_followups (
      owner TEXT NOT NULL, enrollment_id TEXT NOT NULL, id TEXT NOT NULL,
      date TEXT NOT NULL, payload TEXT NOT NULL CHECK (json_valid(payload)), PRIMARY KEY (owner, enrollment_id, id)
    );
    CREATE TABLE IF NOT EXISTS ops_submissions (
      owner TEXT NOT NULL, idempotency_key TEXT NOT NULL, digest TEXT NOT NULL,
      result TEXT NOT NULL CHECK (json_valid(result)), PRIMARY KEY (owner, idempotency_key)
    );
  `);

  const recordQuery = db.prepare('SELECT payload FROM ops_records WHERE owner=? AND kind=? ORDER BY id');
  const singleQuery = db.prepare('SELECT payload FROM ops_records WHERE owner=? AND kind=? AND id=?');
  const upsert = db.prepare(`
    INSERT INTO ops_records(owner, kind, id, payload) VALUES (?, ?, ?, ?)
    ON CONFLICT(owner, kind, id) DO UPDATE SET payload=excluded.payload
  `);
  const followUpQuery = db.prepare(
    'SELECT enrollment_id, payload FROM ops_followups WHERE owner=? ORDER BY date DESC, rowid DESC',
  );
  const insertFollowUp = db.prepare(
    'INSERT INTO ops_followups(owner,enrollment_id,id,date,payload) VALUES (?, ?, ?, ?, ?)',
  );
  const latestFollowUp = db.prepare('SELECT max(date) AS date FROM ops_followups WHERE owner=? AND enrollment_id=?');
  const getSubmission = db.prepare('SELECT digest,result FROM ops_submissions WHERE owner=? AND idempotency_key=?');
  const insertSubmission = db.prepare('INSERT INTO ops_submissions VALUES (?, ?, ?, ?)');
  let pendingSources: { today: string; result: ReturnType<typeof discoverOpsSignals> } | undefined;

  const records = <T extends OpsRecord>(owner: string, kind: Kind) =>
    recordQuery.all(owner, kind).map(row => JSON.parse(String(row.payload)) as T);
  const store = (owner: string, kind: Kind, record: OpsRecord) => {
    upsert.run(owner, kind, record.id, JSON.stringify(record));
  };

  function atomic<T>(operation: () => T) {
    db.exec('SAVEPOINT ops_write');
    try {
      const result = operation();
      db.exec('RELEASE ops_write');
      return result;
    } catch (error) {
      db.exec('ROLLBACK TO ops_write; RELEASE ops_write;');
      throw error;
    }
  }

  function validate<T>(schema: z.ZodType<T>, input: unknown): T {
    const parsed = schema.safeParse(input);
    if (parsed.success) return parsed.data;
    const field = parsed.error.issues[0]?.path.map(String).join('.');
    throw new PublicError(422, field ? `请检查运营请求中的 ${field}。` : '请检查运营请求的格式。');
  }

  function writeAction<T>(request: FastifyRequest, owner: string, action: string, payload: unknown, operation: () => T) {
    const header = request.headers['idempotency-key'];
    if (header === undefined) return atomic(operation);
    const key = validate(z.string().uuid(), header);
    const digest = createHash('sha256').update(JSON.stringify([action, payload])).digest('hex');
    return atomic(() => {
      const prior = getSubmission.get(owner, key);
      if (prior) {
        if (prior.digest !== digest) throw new PublicError(409, '提交标识已用于另一条运营请求。');
        return JSON.parse(String(prior.result)) as T;
      }
      const result = operation();
      insertSubmission.run(owner, key, digest, JSON.stringify(result));
      return result;
    });
  }

  function loadLive(owner: string): ReturnType<typeof createOpsDemo> {
    const followUps: Record<string, OpsFollowUp[]> = Object.create(null);
    for (const row of followUpQuery.all(owner)) {
      const list = followUps[String(row.enrollment_id)] ??= [];
      list.push(JSON.parse(String(row.payload)) as OpsFollowUp);
    }
    return {
      calendar: records<OpsCalendarItem>(owner, 'calendar'),
      signals: records<OpsSignal>(owner, 'signal'),
      enrollments: records<OpsEnrollment>(owner, 'renewal'),
      history: records<OpsHistoryRow>(owner, 'history'),
      followUps,
    };
  }

  app.get(base, async (request): Promise<OpsDashboard> => {
    const { owner } = auth(request);
    const { mode } = validate(z.object({ mode: z.enum(['live', 'demo']).default('live') }).strict(), request.query);
    const today = opsDate();
    const data = mode === 'demo' ? createOpsDemo(today) : loadLive(owner);
    const assessment = assessRenewals(data.enrollments, data.history, today);
    const bindings = mode === 'live' && db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='student_enrollments'").get()
      ? db.prepare('SELECT enrollment_id,student_id FROM student_enrollments WHERE owner=?').all(owner) : [];
    const studentByEnrollment = new Map(bindings.map(row => [String(row.enrollment_id), String(row.student_id)]));
    return {
      mode, today, timezone, calendar: buildCalendar(data.calendar, today), signals: buildSignals(data.signals, today),
      renewals: assessment.renewals.map(card => {
        const studentId = studentByEnrollment.get(card.enrollment.id);
        return studentId ? { ...card, studentId } : card;
      }), history: assessment.history, followUps: data.followUps,
    };
  });

  app.post(`${base}/calendar`, async (request, reply) => {
    const { owner } = auth(request);
    const input = validate(calendarInput, request.body);
    const result = writeAction(request, owner, 'calendar', input, () => {
      if (input.id && !singleQuery.get(owner, 'calendar', input.id)) throw new PublicError(404, '未找到可编辑的日历节点。');
      const record = { ...input, id: input.id ?? randomUUID() };
      store(owner, 'calendar', record);
      return { id: record.id };
    });
    return reply.code(input.id ? 200 : 201).send(result);
  });

  app.post(`${base}/signals`, async (request, reply) => {
    const { owner } = auth(request);
    const input = validate(signalInput, request.body);
    if (input.publishedOn > opsDate()) throw new PublicError(422, '发布日期不能晚于今天。');
    if (input.kind === 'policy' && input.status === 'verified' && (!input.effectiveOn || !isOfficialSource(input.sourceUrl))) {
      throw new PublicError(422, '核验政策时须填写官方来源和生效日期。未齐时请保存为待核对。');
    }
    const result = writeAction(request, owner, 'signal', input, () => {
      if (input.id && !singleQuery.get(owner, 'signal', input.id)) throw new PublicError(404, '未找到可编辑的政策或热点。');
      const record = { ...input, id: input.id ?? randomUUID() };
      store(owner, 'signal', record);
      return { id: record.id };
    });
    return reply.code(input.id ? 200 : 201).send(result);
  });

  app.post(`${base}/signals/refresh`, async request => {
    auth(request);
    const empty = z.object({}).strict();
    const input = validate(empty, request.body);
    validate(empty, request.query);
    const today = opsDate();
    if (pendingSources?.today !== today) {
      const result = discoverOpsSignals(today).finally(() => {
        if (pendingSources?.result === result) pendingSources = undefined;
      });
      pendingSources = { today, result };
    }
    const { candidates, sources, unavailable } = await pendingSources.result;
    const { owner } = auth(request);
    return writeAction(request, owner, 'signals/refresh', input, () => {
      const existing = new Set(records<OpsSignal>(owner, 'signal').map(signal => sourceUrlIdentity(signal.sourceUrl)));
      let imported = 0;
      for (const candidate of candidates) {
        if (existing.has(candidate.sourceUrl)) continue;
        store(owner, 'signal', { ...candidate, id: randomUUID() });
        existing.add(candidate.sourceUrl);
        imported++;
      }
      return { imported, sources, unavailable };
    });
  });

  function importRecords(request: FastifyRequest, kind: 'renewal' | 'history') {
    const { owner } = auth(request);
    const { csv } = validate(csvInput, request.body);
    try {
      const today = opsDate();
      const batch = kind === 'renewal' ? readRenewals(csv, today) : readHistory(csv, today);
      return writeAction(request, owner, `import/${kind}`, csv, () => {
        for (const record of batch) {
          if ('lastContactOn' in record) {
            const stored = singleQuery.get(owner, 'renewal', record.id);
            const last = stored ? (JSON.parse(String(stored.payload)) as OpsEnrollment).lastContactOn : null;
            if (last && (!record.lastContactOn || record.lastContactOn < last)) record.lastContactOn = last;
          }
          store(owner, kind, record);
        }
        return { imported: batch.length };
      });
    } catch (error) {
      if (error instanceof CsvError) throw new PublicError(422, error.message);
      throw error;
    }
  }

  app.post(`${base}/renewals/import`, async request => importRecords(request, 'renewal'));
  app.post(`${base}/history/import`, async request => importRecords(request, 'history'));

  app.post(`${base}/renewals/:id/follow-up`, async (request, reply) => {
    const { owner } = auth(request);
    const { id: enrollmentId } = validate(z.object({ id }).strict(), request.params);
    const input = validate(followUpInput, request.body);
    const { expectedStudentId, ...followUp } = input;
    if (followUp.date > opsDate()) throw new PublicError(422, '跟进记录不能填写未来日期。');
    const result = writeAction(request, owner, `follow-up/${enrollmentId}`, input, () => {
      const row = singleQuery.get(owner, 'renewal', enrollmentId);
      if (!row) throw new PublicError(404, '未找到可操作的续费记录。');
      if (expectedStudentId && !db.prepare(`SELECT 1 FROM student_enrollments
        WHERE owner=? AND enrollment_id=? AND student_id=?`).get(owner, enrollmentId, expectedStudentId)) {
        throw new PublicError(409, '课程段的学员关联已变化，请刷新后重试。');
      }
      const enrollment = JSON.parse(String(row.payload)) as OpsEnrollment;
      const lastRecorded = latestFollowUp.get(owner, enrollmentId)?.date;
      const followUpId = randomUUID();
      insertFollowUp.run(owner, enrollmentId, followUpId, followUp.date, JSON.stringify(followUp));
      if (['contacted', 'payment_planned', 'no_response'].includes(followUp.outcome) &&
          (!enrollment.lastContactOn || followUp.date > enrollment.lastContactOn)) enrollment.lastContactOn = followUp.date;
      if (!lastRecorded || followUp.date >= String(lastRecorded)) {
        if (enrollment.state === 'unpaid' && followUp.outcome === 'payment_planned') enrollment.state = 'planned';
        if (['unpaid', 'planned'].includes(enrollment.state) && followUp.outcome === 'paused') enrollment.state = 'paused';
      }
      store(owner, 'renewal', enrollment);
      return { id: followUpId };
    });
    return reply.code(201).send(result);
  });
}

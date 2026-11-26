import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { OpsEnrollment, OpsFollowUp } from '../shared/operations.js';
import type { StudentArtifact, StudentDetail, StudentDirectory, StudentLearningLink, StudentProfile } from '../shared/students.js';
import { isOpsDate } from './operations_calendar.js';

type Dependencies = {
  db: DatabaseSync;
  auth: (request: FastifyRequest) => { owner: string };
  PublicError: new (statusCode: number, message: string) => Error;
};
type LearningRow = StudentArtifact & Pick<StudentLearningLink, 'status' | 'occurredOn' | 'note' | 'updatedAt'>;

const base = '/api/v1/students';
const studentId = z.string().uuid();
const externalCode = z.string().trim().regex(/^(?!\d{7,}$)[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
function containsContact(value: string) {
  const withoutDates = value.replace(/\b\d{4}[-/.]\d{1,2}[-/.]\d{1,2}\b/g, '');
  return /\S+@\S+|(?:\d[ ()-]*){7,}/.test(withoutDates);
}
const displayName = z.string().trim().min(1).max(60)
  .refine(value => !/[\u0000-\u001f\u007f]/.test(value) && !containsContact(value));
const activityDate = z.string().refine(isOpsDate);
const studentFields = z.object({
  name: displayName,
  code: z.union([externalCode, z.literal(''), z.null()]).optional(),
  className: z.union([displayName, z.literal(''), z.null()]).optional(),
  track: z.enum(['k12', 'toefl', 'ielts']),
  status: z.enum(['active', 'paused', 'archived']).default('active'),
}).strict();
const updateFields = studentFields.extend({ expectedVersion: z.number().int().positive() }).strict();
const studentParams = z.object({ id: studentId }).strict();
const enrollmentInput = z.object({ enrollmentId: externalCode }).strict();
const learningInput = z.object({
  artifactId: z.string().uuid(),
  status: z.enum(['reference', 'used', 'assigned', 'completed']).default('reference'),
  occurredOn: activityDate.nullable().default(null),
  note: z.string().trim().max(300).default('').refine(value => !containsContact(value)),
}).strict();

const schoolCalendar = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });
function schoolDate() {
  const parts = schoolCalendar.formatToParts();
  return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)?.value).join('-');
}

export function registerStudents(app: FastifyInstance, { db, auth, PublicError }: Dependencies) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS students (
      owner TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, code TEXT COLLATE NOCASE, class_name TEXT,
      track TEXT NOT NULL CHECK(track IN ('k12','toefl','ielts')),
      status TEXT NOT NULL CHECK(status IN ('active','paused','archived')),
      version INTEGER NOT NULL CHECK(version > 0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(owner,id), UNIQUE(owner,code)
    );
    CREATE TABLE IF NOT EXISTS student_enrollments (
      owner TEXT NOT NULL, enrollment_id TEXT NOT NULL, student_id TEXT NOT NULL, linked_at TEXT NOT NULL,
      enrollment_kind TEXT NOT NULL DEFAULT 'renewal' CHECK(enrollment_kind='renewal'),
      PRIMARY KEY(owner,enrollment_id),
      FOREIGN KEY(owner,student_id) REFERENCES students(owner,id),
      FOREIGN KEY(owner,enrollment_kind,enrollment_id) REFERENCES ops_records(owner,kind,id)
    );
    CREATE TABLE IF NOT EXISTS student_learning_links (
      owner TEXT NOT NULL, student_id TEXT NOT NULL, artifact_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('reference','used','assigned','completed')),
      occurred_on TEXT, note TEXT NOT NULL, linked_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(owner,student_id,artifact_id),
      FOREIGN KEY(owner,student_id) REFERENCES students(owner,id),
      FOREIGN KEY(artifact_id) REFERENCES artifacts(id)
    );
    CREATE TABLE IF NOT EXISTS student_requests (
      owner TEXT NOT NULL, idempotency_key TEXT NOT NULL, digest TEXT NOT NULL,
      result TEXT NOT NULL CHECK(json_valid(result)), PRIMARY KEY(owner,idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS student_enrollments_by_student ON student_enrollments(owner,student_id);
  `);

  const studentProjection = 'id,name,code,class_name AS className,track,status,version,created_at AS createdAt,updated_at AS updatedAt';
  const getStudent = db.prepare(`SELECT ${studentProjection} FROM students WHERE owner=? AND id=?`);
  const listStudents = db.prepare(`SELECT ${studentProjection} FROM students WHERE owner=?
    ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END,name,id`);
  const findCode = db.prepare('SELECT id FROM students WHERE owner=? AND code=?');
  const createStudent = db.prepare(`INSERT INTO students
    (owner,id,name,code,class_name,track,status,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,1,?,?)`);
  const updateStudent = db.prepare(`UPDATE students
    SET name=?,code=?,class_name=?,track=?,status=?,version=version+1,updated_at=?
    WHERE owner=? AND id=? AND version=?`);
  const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?");
  function prepareOperations() {
    return {
      get: db.prepare(`SELECT 1 FROM ops_records WHERE owner=? AND kind='renewal' AND id=?`),
      list: db.prepare(`SELECT r.payload,b.student_id AS studentId FROM ops_records AS r
        LEFT JOIN student_enrollments AS b ON b.owner=r.owner AND b.enrollment_id=r.id AND b.enrollment_kind=r.kind
        WHERE r.owner=? AND r.kind='renewal' ORDER BY r.id`),
      forStudent: db.prepare(`SELECT r.payload FROM student_enrollments AS b
        JOIN ops_records AS r ON r.owner=b.owner AND r.kind=b.enrollment_kind AND r.id=b.enrollment_id
        WHERE b.owner=? AND b.student_id=? ORDER BY r.id`),
    };
  }
  let opsStatements: ReturnType<typeof prepareOperations> | undefined;
  function operations() {
    if (!opsStatements && hasTable.get('ops_records')) opsStatements = prepareOperations();
    return opsStatements;
  }
  let followUpStatement: ReturnType<typeof db.prepare> | undefined;
  function followUps(owner: string, enrollmentId: string) {
    if (!followUpStatement && hasTable.get('ops_followups')) {
      followUpStatement = db.prepare('SELECT payload FROM ops_followups WHERE owner=? AND enrollment_id=? ORDER BY date DESC,rowid DESC');
    }
    return followUpStatement?.all(owner, enrollmentId).map(item => JSON.parse(String(item.payload)) as OpsFollowUp) ?? [];
  }
  const getEnrollmentLink = db.prepare('SELECT student_id FROM student_enrollments WHERE owner=? AND enrollment_id=?');

  const artifactProjection = `a.id AS artifactId,t.id AS taskId,t.project AS projectId,
    json_extract(a.card,'$.kind') AS kind,json_extract(a.card,'$.title') AS title,
    json_extract(a.card,'$.version') AS version`;
  const artifactJoin = 'FROM artifacts AS a JOIN tasks AS t ON t.id=a.task JOIN projects AS p ON p.id=t.project AND p.owner=t.owner';
  const supportedArtifact = `((p.module='classroom' AND json_extract(a.card,'$.kind')='lesson')
    OR (p.module='practice' AND json_extract(a.card,'$.kind')='practice_pack'))
    AND json_extract(t.snapshot,'$.status')='succeeded'`;
  const listArtifacts = db.prepare(`SELECT ${artifactProjection} ${artifactJoin}
    WHERE t.owner=? AND ${supportedArtifact} ORDER BY t.rowid DESC,a.id`);
  const findArtifact = db.prepare(`SELECT ${artifactProjection} ${artifactJoin}
    WHERE t.owner=? AND a.id=? AND ${supportedArtifact}`);
  const studentLearning = db.prepare(`SELECT ${artifactProjection},l.status,l.occurred_on AS occurredOn,
    l.note,l.updated_at AS updatedAt ${artifactJoin}
    JOIN student_learning_links AS l ON l.artifact_id=a.id AND l.owner=t.owner
    WHERE l.owner=? AND l.student_id=? AND ${supportedArtifact} ORDER BY l.updated_at DESC,a.id`);
  const saveLearning = db.prepare(`INSERT INTO student_learning_links
    (owner,student_id,artifact_id,status,occurred_on,note,linked_at,updated_at) VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(owner,student_id,artifact_id)
    DO UPDATE SET status=excluded.status,occurred_on=excluded.occurred_on,note=excluded.note,updated_at=excluded.updated_at`);

  const getRequest = db.prepare('SELECT digest,result FROM student_requests WHERE owner=? AND idempotency_key=?');
  const saveRequest = db.prepare('INSERT INTO student_requests VALUES (?,?,?,?)');

  function validate<T>(schema: z.ZodType<T>, input: unknown): T {
    const checked = schema.safeParse(input);
    if (checked.success) return checked.data;
    const field = checked.error.issues[0]?.path.map(String).join('.');
    throw new PublicError(422, field ? `请检查学员请求中的 ${field}。` : '请核对学员请求格式。');
  }

  function studentFor(owner: string, id: string) {
    const record = getStudent.get(owner, id) as StudentProfile | undefined;
    if (!record) throw new PublicError(404, '学员档案不可用。');
    return record;
  }

  function ensureCodeAvailable(owner: string, code?: string | null, except?: string) {
    if (!code) return;
    const duplicate = findCode.get(owner, code);
    if (duplicate && duplicate.id !== except) throw new PublicError(409, '此学员编号已被使用。');
  }

  function writeAction<T>(request: FastifyRequest, owner: string, action: string, payload: unknown, write: () => T): T {
    const header = request.headers['idempotency-key'];
    const key = header === undefined ? undefined : validate(z.string().uuid(), header);
    const digest = key ? createHash('sha256').update(JSON.stringify([action, payload])).digest('hex') : '';
    db.exec('SAVEPOINT student_write');
    try {
      const prior = key ? getRequest.get(owner, key) : undefined;
      if (prior && prior.digest !== digest) throw new PublicError(409, '提交标识已用于其他学员请求。');
      const result = prior ? JSON.parse(String(prior.result)) as T : write();
      if (key && !prior) saveRequest.run(owner, key, digest, JSON.stringify(result));
      db.exec('RELEASE student_write');
      return result;
    } catch (error) {
      db.exec('ROLLBACK TO student_write; RELEASE student_write');
      throw error;
    }
  }

  app.get(base, async (request): Promise<StudentDirectory> => {
    const { owner } = auth(request);
    const { q } = validate(z.object({ q: z.string().trim().max(80).optional() }).strict(), request.query);
    const filter = q?.toLocaleLowerCase() ?? '';
    const students = (listStudents.all(owner) as StudentProfile[]).filter(student =>
      !filter || [student.name, student.code, student.className].some(value => value?.toLocaleLowerCase().includes(filter)));
    const enrollments = (operations()?.list.all(owner) ?? []).map(row => {
      const { id, label, track, endOn, state } = JSON.parse(String(row.payload)) as OpsEnrollment;
      return { id, label, track, endOn, state, studentId: row.studentId === null ? null : String(row.studentId) };
    });
    return { students, enrollments, artifacts: listArtifacts.all(owner) as StudentArtifact[] };
  });

  app.get(`${base}/:id`, async (request): Promise<StudentDetail> => {
    const { owner } = auth(request);
    const { id } = validate(studentParams, request.params);
    const student = studentFor(owner, id);
    const enrollments = (operations()?.forStudent.all(owner, id) ?? []).map(row => {
      const enrollment = JSON.parse(String(row.payload)) as OpsEnrollment;
      return { ...enrollment, followUps: followUps(owner, enrollment.id) };
    });
    const learning = (studentLearning.all(owner, id) as LearningRow[])
      .map(({ status, occurredOn, note, updatedAt, ...artifact }) => ({ artifactId: artifact.artifactId, artifact, status, occurredOn, note, updatedAt }));
    return { student, enrollments, learning };
  });

  app.post(base, async (request, reply) => {
    const { owner } = auth(request);
    const input = validate(studentFields, request.body);
    const result = writeAction(request, owner, 'create', input, () => {
      ensureCodeAvailable(owner, input.code);
      const id = randomUUID();
      const now = new Date().toISOString();
      createStudent.run(owner, id, input.name, input.code || null, input.className || null, input.track, input.status, now, now);
      return { student: studentFor(owner, id) };
    });
    return reply.code(201).send(result);
  });

  app.post(`${base}/:id`, async request => {
    const { owner } = auth(request);
    const { id } = validate(studentParams, request.params);
    const input = validate(updateFields, request.body);
    return writeAction(request, owner, `edit/${id}`, input, () => {
      const prior = studentFor(owner, id);
      if (prior.version !== input.expectedVersion) throw new PublicError(409, '档案已更新，请刷新后再编辑。');
      ensureCodeAvailable(owner, input.code, id);
      const result = updateStudent.run(input.name, input.code || null, input.className || null, input.track, input.status,
        new Date().toISOString(), owner, id, input.expectedVersion);
      if (result.changes !== 1) throw new PublicError(409, '档案已更新，请刷新后再编辑。');
      return { student: studentFor(owner, id) };
    });
  });

  app.post(`${base}/:id/enrollments`, async (request, reply) => {
    const { owner } = auth(request);
    const { id } = validate(studentParams, request.params);
    const input = validate(enrollmentInput, request.body);
    const result = writeAction(request, owner, `enrollment/${id}`, input, () => {
      studentFor(owner, id);
      if (!operations()?.get.get(owner, input.enrollmentId)) throw new PublicError(404, '课程段不可用。');
      const prior = getEnrollmentLink.get(owner, input.enrollmentId);
      if (prior && prior.student_id !== id) throw new PublicError(409, '此课程段已关联到本账号下的另一名学员。');
      if (!prior) {
        const insert = db.prepare('INSERT INTO student_enrollments(owner,enrollment_id,student_id,linked_at) VALUES (?,?,?,?)');
        insert.run(owner, input.enrollmentId, id, new Date().toISOString());
      }
      return { enrollmentId: input.enrollmentId };
    });
    return reply.code(201).send(result);
  });

  app.post(`${base}/:id/enrollments/unlink`, async request => {
    const { owner } = auth(request);
    const { id } = validate(studentParams, request.params);
    const input = validate(enrollmentInput, request.body);
    return writeAction(request, owner, `enrollment-unlink/${id}`, input, () => {
      studentFor(owner, id);
      if (!operations()?.get.get(owner, input.enrollmentId)) throw new PublicError(404, '课程段不可用。');
      const remove = db.prepare('DELETE FROM student_enrollments WHERE owner=? AND student_id=? AND enrollment_id=?');
      remove.run(owner, id, input.enrollmentId);
      return { enrollmentId: input.enrollmentId };
    });
  });

  app.post(`${base}/:id/learning-links`, async (request, reply) => {
    const { owner } = auth(request);
    const { id } = validate(studentParams, request.params);
    const input = validate(learningInput, request.body);
    if (input.occurredOn && input.occurredOn > schoolDate()) throw new PublicError(422, '活动日期不能晚于今天。');
    const result = writeAction(request, owner, `learning/${id}`, input, () => {
      studentFor(owner, id);
      const artifact = findArtifact.get(owner, input.artifactId) as StudentArtifact | undefined;
      if (!artifact) throw new PublicError(404, '课件或练习成果不可用。');
      if (input.status === 'used' && artifact.kind !== 'lesson'
        || (input.status === 'assigned' || input.status === 'completed') && artifact.kind !== 'practice_pack') {
        throw new PublicError(422, '请选择与该教学成果匹配的活动状态。');
      }
      const now = new Date().toISOString();
      saveLearning.run(owner, id, input.artifactId, input.status, input.occurredOn, input.note, now, now);
      return { artifactId: input.artifactId };
    });
    return reply.code(201).send(result);
  });
}

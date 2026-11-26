import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { materialExtension, maxMaterialBytes } from '../shared/materials.js';
import type { MaterialExtension } from '../shared/materials.js';
import { matchesMaterialHeader } from './material-upload.js';
import { registerOperations } from './operations.js';
import { registerStudents } from './students.js';
import type { FastifyRequest } from 'fastify';

const root = fileURLToPath(new URL('..', import.meta.url));
const data = process.env.M0_DATA;
const python = process.env.M0_PYTHON;
const bridgeKey = process.env.HYPER_BOT_TEACHING_BRIDGE;
if (!data || !path.isAbsolute(data) || !python || !bridgeKey) throw new Error('Invalid teaching runtime configuration');
let origin: string;
const execute = promisify(execFile);
const random = () => randomBytes(32).toString('hex');
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const isEqual = (a: unknown, b: string) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
await mkdir(path.join(data, 'assets'), { recursive: true });
const accounts = ['teacher', 'reviewer'] as const;
const credentials = await readFile(path.join(data, 'accounts.json'), 'utf8').then(JSON.parse).catch(async error => {
  if (error.code !== 'ENOENT') throw error;
  const generated = Object.fromEntries(accounts.map(name => [name, random()]));
  await writeFile(path.join(data, 'accounts.json'), JSON.stringify(generated), { flag: 'wx', mode: 0o600 });
  return generated;
});

const db = new DatabaseSync(path.join(data, 'm0.sqlite'));
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
  CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, owner TEXT NOT NULL, module TEXT NOT NULL, title TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS assets (id TEXT PRIMARY KEY, project TEXT NOT NULL REFERENCES projects(id));
  CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, owner TEXT NOT NULL, project TEXT NOT NULL REFERENCES projects(id),
    idem TEXT NOT NULL, digest TEXT NOT NULL, snapshot TEXT NOT NULL, UNIQUE(owner, idem));
  CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, task TEXT NOT NULL REFERENCES tasks(id), card TEXT NOT NULL);`);
for (const [table, column, statement] of [
  ['projects', 'track', 'ALTER TABLE projects ADD COLUMN track TEXT'],
  ['assets', 'extension', "ALTER TABLE assets ADD COLUMN extension TEXT NOT NULL DEFAULT '.pdf'"],
  ['assets', 'filename', "ALTER TABLE assets ADD COLUMN filename TEXT NOT NULL DEFAULT '已上传材料.pdf'"],
]) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some(info => info.name === column)) db.exec(statement);
}
db.exec(`CREATE INDEX IF NOT EXISTS tasks_project_owner ON tasks(project, owner);
  CREATE INDEX IF NOT EXISTS artifacts_task ON artifacts(task);`);
type Snapshot = { task_id: string; revision: number; status: string; title: string; summary: string; artifact_ids: string[]; next_action: string | null;
  action?: 'identify_learning_targets' | 'design_practice_pack'; analysis_task_id?: string };
type Session = { token: string; csrf: string; owner: string; expires: number };
type Track = 'k12' | 'toefl' | 'ielts';
type Project = { id: string; owner: string; module: 'classroom' | 'practice'; title: string; track?: Track | null };
type Asset = { id: string; extension: MaterialExtension; filename: string };
type TaskRow = { id: string; project: string; snapshot: string; digest: string };
const sessions = new Map<string, Session>();
const jobs = new Set<Promise<void>>();
const snap = (row: TaskRow): Snapshot => JSON.parse(row.snapshot);
const getTask = (id: string, owner: string) => db.prepare('SELECT id, project, snapshot, digest FROM tasks WHERE id=? AND owner=?').get(id, owner) as TaskRow | undefined;
for (const row of db.prepare('SELECT id, project, snapshot, digest FROM tasks').all() as TaskRow[]) {
  const last = snap(row);
  if (['queued', 'running'].includes(last.status)) {
    const interrupted = { ...last, revision: last.revision + 1, status: 'interrupted', summary: '服务重启，执行已中断。', next_action: 'retry' };
    db.prepare('UPDATE tasks SET snapshot=? WHERE id=?').run(JSON.stringify(interrupted), row.id);
  }
}

class PublicError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); }
}
function auth(request: FastifyRequest) {
  const token = request.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith('m0_session='))?.slice('m0_session='.length);
  const session = token ? sessions.get(token) : undefined;
  if (!session || session.expires <= Date.now()) throw new PublicError(401, '请重新登录。');
  if (request.method === 'POST' && (!isEqual(request.headers['x-csrf-token'], session.csrf) || request.headers.origin !== origin)) throw new PublicError(403, '请求校验失败。');
  return session;
}
function projectFor(id: string, owner: string) {
  const project = db.prepare(`SELECT p.id,p.owner,p.module,p.title,COALESCE(p.track,(
    SELECT json_extract(a.card,'$.track') FROM tasks t JOIN artifacts a ON a.task=t.id
    WHERE t.project=p.id AND t.owner=p.owner AND json_extract(a.card,'$.kind')='lesson' ORDER BY t.rowid DESC LIMIT 1
  )) AS track FROM projects p WHERE p.id=? AND p.owner=?`).get(id, owner) as Project | undefined;
  if (!project) throw new PublicError(404, '项目不可用。');
  return project;
}
function assetFor(id: string, project: string) {
  const asset = db.prepare('SELECT id,extension,filename FROM assets WHERE id=? AND project=?').get(id, project) as Asset | undefined;
  if (!asset) throw new PublicError(404, '素材不可用。');
  return asset;
}
function setSnapshot(snapshot: Snapshot, status: string, summary: string, artifacts: string[] = [], nextAction: string | null = null) {
  const next: Snapshot = { ...snapshot, revision: snapshot.revision + 1, status,
    summary, artifact_ids: artifacts, next_action: nextAction };
  db.prepare('UPDATE tasks SET snapshot=? WHERE id=?').run(JSON.stringify(next), next.task_id);
  return next;
}

const moduleID = z.enum(['classroom', 'practice']);
const trackID = z.enum(['k12', 'toefl', 'ielts']);
const pdfPages = z.string().regex(/^[1-9]\d{0,2}-[1-9]\d{0,2}$/).optional();
const classroomInput = z.object({ track: trackID, pages: pdfPages, goal: z.string().trim().max(300).optional() }).strict();
const practiceCatalogText = await readFile(path.join(root, 'shared', 'practice.json'), 'utf8');
const practiceCatalog = z.object({ methods: z.array(z.object({ id: z.string() })).nonempty(), sequences: z.array(z.object({ id: z.string() })).nonempty() })
  .parse(JSON.parse(practiceCatalogText));
const practiceCatalogSha256 = createHash('sha256').update(practiceCatalogText).digest('hex');
const practiceMethods = new Set(practiceCatalog.methods.map(method => method.id));
const practiceSequences = new Set(practiceCatalog.sequences.map(sequence => sequence.id));
const practiceMethod = z.string().refine(id => practiceMethods.has(id));
const practiceSequence = z.string().refine(id => practiceSequences.has(id));
const noDuplicates = (ids: string[]) => new Set(ids).size === ids.length;
const practiceTargetId = z.string().min(1).max(100);
const practiceInput = z.object({
  analysis_id: z.string().uuid(),
  target_ids: z.array(practiceTargetId).min(1).max(3).refine(noDuplicates),
  methods: z.array(practiceMethod).max(4).refine(noDuplicates),
  mode: z.enum(['mixed', 'traditional', 'activity']).default('mixed'),
  sequence: practiceSequence,
  difficulty: z.enum(['guided', 'standard', 'challenge']),
  image_prompt: z.string().trim().max(500).optional(),
  image_alt: z.string().trim().max(160).optional(),
}).strict();
const taskInput = z.discriminatedUnion('action', [
  z.object({ module: z.literal('classroom'), action: z.literal('generate_lesson'), project_id: z.string().uuid(), input: classroomInput, asset_ids: z.tuple([z.string().uuid()]) }).strict(),
  z.object({ module: z.literal('practice'), action: z.literal('identify_learning_targets'), project_id: z.string().uuid(),
    input: z.object({ pages: pdfPages, focus: z.string().trim().max(300).optional() }).strict(), asset_ids: z.tuple([z.string().uuid()]) }).strict(),
  z.object({ module: z.literal('practice'), action: z.literal('design_practice_pack'), project_id: z.string().uuid(), input: practiceInput, asset_ids: z.array(z.string().uuid()).max(1) }).strict(),
]);
type TaskInput = z.infer<typeof taskInput>;
const validateLesson = z.object({ title: z.string(), objective: z.string(), source: z.string(), pages: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), activities: z.number().int().positive(), slides: z.number().int().positive() }).strict();
const validateAnalysis = z.object({ title: z.string(), source: z.string(), targets: z.array(z.object({
  id: practiceTargetId, label: z.string(), category: z.string(), objective: z.string(), evidence: z.string(), locator: z.string(),
}).strict()).min(1).max(30).refine(targets => noDuplicates(targets.map(target => target.id))) }).strict();
const validatePracticePack = z.object({ title: z.string(), source: z.string(), objective: z.string(),
  item_count: z.number().int().positive(), methods: z.array(practiceMethod).nonempty(), sequence: practiceSequence,
  duration_min: z.number().int().positive(), notes: z.array(z.string()) }).strict();
const previewPath = (id: string, file: string) => path.join(data, 'artifacts', id, file);
const storedAssetPath = (asset: Asset) => path.join(data, 'assets', `${asset.id}${asset.extension}`);
const practiceMaterial = (extension: MaterialExtension) => ['.pdf', '.docx', '.pptx', '.txt', '.md'].includes(extension);
const practiceImage = (extension: MaterialExtension) => ['.png', '.jpg', '.jpeg', '.webp'].includes(extension);
const maxPracticeImageBytes = 12 * 1024 * 1024;
const materialErrors: Record<string, string> = {
  MATERIAL_RANGE: '选页范围无效。请核对页数，单次最多选 20 页。',
  MATERIAL_EMPTY: '没有读到可用文字。可改传带文本的文档，或上传要讲解的页面截图。',
  MATERIAL_INVALID: '材料内容无法读取。请检查文件是否完整、格式是否与扩展名一致。',
};
const practiceErrors: Record<string, string> = {
  PRACTICE_INVALID: '无法读取练习材料。请核对文件格式和内容。',
  PRACTICE_TEXT_REQUIRED: '没有读到足够的可用文字。请改用带文本层的页面，或补充一份可编辑文档。',
  PRACTICE_PAGES: '选页范围无效。请核对页数，单次最多选 20 页。',
  PRACTICE_NO_METHOD: '所选练习方式与材料或知识点不匹配。请改用自动组合，或更换练习方式。',
  PRACTICE_IMAGE: '无法读取配图。请换一张正常打开的 PNG、JPEG 或 WebP 图片后重试。',
};
async function checkArtifacts(folder: string, files: string[]) {
  await Promise.all(files.map(async file => {
    const info = await stat(path.join(folder, file));
    if (!info.isFile() || !info.size) throw new Error('EMPTY_ARTIFACT');
  }));
}
async function practiceForTask(input: Extract<TaskInput, { module: 'practice' }>, taskId: string, artifactId: string, asset?: Asset) {
  const folder = previewPath(artifactId, '');
  await mkdir(folder, { recursive: true });
  const run = async (args: string[]) => JSON.parse((await execute(python,
    ['-B', '-X', 'utf8', path.join(root, 'server', 'practice.py'), ...args], { timeout: 90000, windowsHide: true })).stdout);
  // Retain plan lineage internally. Only the reviewed card schema and two exports are served.
  const provenance = { task_id: taskId, artifact_id: artifactId, version: 1, project_id: input.project_id, catalog_sha256: practiceCatalogSha256 };
  if (input.action === 'identify_learning_targets') {
    if (!asset) throw new Error('MISSING_TASK_MATERIAL');
    const result = validateAnalysis.parse(await run(['identify', storedAssetPath(asset),
      folder, asset.filename, input.input.pages || 'auto', input.input.focus || '']));
    await checkArtifacts(folder, ['analysis.json']);
    await writeFile(path.join(folder, 'provenance.json'), JSON.stringify({ ...provenance, source_asset_id: asset.id, source_asset_version: 1,
      pages: input.input.pages ?? null }), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    return { kind: 'practice_analysis', ...result };
  }
  const { analysis_id, ...options } = input.input;
  const optionsFile = path.join(folder, 'options.json');
  await writeFile(optionsFile, JSON.stringify(options), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  const args = ['generate', previewPath(analysis_id, 'analysis.json'), folder, optionsFile];
  if (asset) args.push('--image', storedAssetPath(asset));
  const result = validatePracticePack.parse(await run(args));
  await checkArtifacts(folder, ['student.html', 'teacher.html']);
  await writeFile(path.join(folder, 'provenance.json'), JSON.stringify({ ...provenance, analysis_id,
    ...(asset ? { image_asset_id: asset.id, image_asset_version: 1 } : {}) }), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return { kind: 'practice_pack', ...result };
}
async function runTask(snapshot: Snapshot, input: TaskInput, asset?: Asset) {
  const runningMessage = input.module === 'classroom' ? '正在核对教材并生成课堂包。'
    : input.action === 'identify_learning_targets' ? '正在识别教材中的练习目标。' : '正在按确认的目标生成练习。';
  const running = setSnapshot(snapshot, 'running', runningMessage);
  const artifactId = randomUUID();
  try {
    let card: object;
    let summary = '互动 HTML 与可编辑 PPTX 已生成。';
    if (input.module === 'classroom') {
      if (!asset) throw new Error('MISSING_TASK_MATERIAL');
      const folder = previewPath(artifactId, '');
      const { stdout } = await execute(python, ['-B', '-X', 'utf8', path.join(root, 'server', 'lesson.py'),
        storedAssetPath(asset), folder, input.input.track, input.input.pages || 'auto',
        `--filename=${asset.filename}`, `--goal=${input.input.goal || ''}`], { timeout: 90000, windowsHide: true });
      const lesson = validateLesson.parse(JSON.parse(stdout));
      await checkArtifacts(folder, ['lesson.html', 'lesson.pptx']);
      card = { artifact_id: artifactId, kind: 'lesson', version: 1, review_status: 'needs_review', track: input.input.track,
        title: lesson.title, objective: lesson.objective, source: lesson.source, pages: lesson.pages, activities: lesson.activities, slides: lesson.slides };
    } else {
      const result = await practiceForTask(input, snapshot.task_id, artifactId, asset);
      card = { artifact_id: artifactId, version: 1, review_status: 'needs_review', ...result };
      summary = result.kind === 'practice_analysis' ? '候选知识点已生成，请核对和选择。' : '学生练习和教师答案已生成，待审阅。';
    }
    db.prepare('INSERT INTO artifacts VALUES (?,?,?)').run(artifactId, snapshot.task_id, JSON.stringify(card));
    setSnapshot(running, 'succeeded', summary, [artifactId], 'open_artifact');
  } catch (error) {
    console.error(JSON.stringify({ task_id: snapshot.task_id, code: 'RENDER_OR_PERSIST' }));
    const stderr = (error as { stderr?: unknown } | null)?.stderr;
    const publicErrors = input.module === 'practice' ? practiceErrors : materialErrors;
    const message = typeof stderr === 'string' && Object.hasOwn(publicErrors, stderr.trim()) ? publicErrors[stderr.trim()] : undefined;
    const fallback = input.module === 'classroom' ? '未能生成课件，请核对材料后重试。' : '课后练习任务未完成，请核对材料与选项后重试。';
    setSnapshot(running, 'failed', message ?? fallback, [], 'retry');
  }
}

const app = Fastify({ logger: false });
await app.register(multipart, { limits: { files: 1, fields: 0, fileSize: maxMaterialBytes }, throwFileSizeLimit: false });
app.addHook('onRequest', async (request, reply) => {
  if (!isEqual(request.headers['x-hyper-bot-teaching-bridge'], bridgeKey) || request.headers.host !== new URL(origin).host) {
    return reply.code(403).send({ error: '教培运行时仅对当前 Hyper Bot 开放。' });
  }
  reply.header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'same-origin');
  if (request.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
});
app.setErrorHandler((error, _request, reply) => {
  if (error instanceof PublicError) return reply.code(error.statusCode).send({ error: error.message });
  if (error instanceof z.ZodError) return reply.code(400).send({ error: '请检查轨道、素材或任务输入。' });
  const status = (error as { statusCode?: number } | null)?.statusCode;
  if (typeof status === 'number' && status >= 400 && status < 500) return reply.code(status).send({ error: '无法读取请求。' });
  console.error(JSON.stringify({ code: 'GATEWAY_REQUEST_FAILED' }));
  return reply.code(500).send({ error: '服务暂时不可用。' });
});
const prefix = '/api/v1';
app.post(`${prefix}/session`, async (request, reply) => {
  if (request.headers.origin !== origin) throw new PublicError(403, '请求校验失败。');
  const { account, password } = z.object({ account: z.enum(accounts), password: z.string().max(100) }).strict().parse(request.body);
  if (!isEqual(password, credentials[account])) throw new PublicError(401, '登录信息不匹配。');
  const session = { token: random(), csrf: random(), owner: account, expires: Date.now() + 4 * 60 * 60 * 1000 };
  sessions.set(session.token, session);
  reply.header('Set-Cookie', `m0_session=${session.token}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=14400`);
  return { account, csrf_token: session.csrf };
});
app.post(`${prefix}/session/end`, async (request, reply) => {
  const session = auth(request);
  sessions.delete(session.token);
  return reply.header('Set-Cookie', 'm0_session=; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=0').code(204).send();
});
app.get(`${prefix}/context`, async request => {
  const session = auth(request);
  return { account: session.owner, csrf_token: session.csrf, organization: 'm0-local', modules: [...moduleID.options, 'operations', 'students'], classes: [] };
});
app.get(`${prefix}/projects`, async request => {
  const session = auth(request);
  const { module } = z.object({ module: moduleID }).parse(request.query);
  return db.prepare(`SELECT p.id, p.module, p.title, COALESCE(p.track, (
      SELECT json_extract(a.card, '$.track') FROM tasks t JOIN artifacts a ON a.task=t.id
      WHERE t.project=p.id AND t.owner=p.owner AND json_extract(a.card, '$.kind')='lesson' ORDER BY t.rowid DESC LIMIT 1
    )) AS track, (SELECT COUNT(*) FROM tasks WHERE project=p.id AND owner=p.owner) AS task_count
    FROM projects p WHERE p.owner=? AND p.module=? ORDER BY p.rowid DESC`).all(session.owner, module);
});
app.post(`${prefix}/projects`, async (request, reply) => {
  const session = auth(request);
  const { module, title, track } = z.object({ module: moduleID, title: z.string().trim().min(1).max(100), track: trackID.optional() }).strict().parse(request.body);
  if (module === 'practice' && track) throw new PublicError(400, '课后练习项目按导入材料生成。');
  const id = randomUUID();
  db.prepare('INSERT INTO projects (id, owner, module, title, track) VALUES (?,?,?,?,?)').run(id, session.owner, module, title, track ?? null);
  return reply.code(201).send({ id, module, title, track: track ?? null, task_count: 0 });
});
app.get(`${prefix}/projects/:id`, async request => {
  const { id } = request.params as { id: string };
  const session = auth(request);
  const { module, title, track } = projectFor(id, session.owner);
  const rows = db.prepare('SELECT snapshot FROM tasks WHERE project=? AND owner=? ORDER BY rowid DESC').all(id, session.owner) as TaskRow[];
  return { id, module, title, track: track ?? null, task_count: rows.length, tasks: rows.map(snap) };
});
app.post(`${prefix}/assets`, async (request, reply) => {
  const session = auth(request);
  const { project_id } = z.object({ project_id: z.string().uuid() }).parse(request.query);
  const project = projectFor(project_id, session.owner);
  const part = await request.file();
  const suppliedName = part ? path.basename(path.win32.basename(part.filename)).replace(/[\u0000-\u001f\u007f]/g, '').trim() : '';
  const extension = materialExtension(suppliedName);
  if (!part || !extension) {
    part?.file.resume();
    throw new PublicError(415, '请选择 PDF、Word（DOCX）、PPTX、TXT、Markdown 或 PNG / JPEG / WebP 图片。');
  }
  const filename = suppliedName.slice(0, 180);
  const id = randomUUID();
  const destination = path.join(data, 'assets', `${id}${extension}`);
  try {
    await pipeline(part.file, createWriteStream(destination, { flags: 'wx', mode: 0o600 }));
    if (part.file.truncated) throw new PublicError(413, '材料须小于 32 MiB。');
    if (project.module === 'practice' && practiceImage(extension) && (await stat(destination)).size > maxPracticeImageBytes) {
      throw new PublicError(413, '课后练习配图须在 12 MiB 以内。');
    }
    const header = Buffer.alloc(12);
    const file = await open(destination, 'r');
    let bytes: number;
    try { ({ bytesRead: bytes } = await file.read(header, 0, header.length, 0)); } finally { await file.close(); }
    if (!matchesMaterialHeader(extension, header.subarray(0, bytes))) throw new PublicError(415, '文件内容与所选格式不一致。');
    db.prepare('INSERT INTO assets (id,project,extension,filename) VALUES (?,?,?,?)').run(id, project_id, extension, filename);
    return reply.code(201).send({ asset_id: id });
  } catch (error) {
    await unlink(destination).catch(() => undefined);
    throw error;
  }
});
app.post(`${prefix}/tasks`, async (request, reply) => {
  const session = auth(request);
  const input = taskInput.parse(request.body);
  const key = z.string().uuid().parse(request.headers['idempotency-key']);
  const project = projectFor(input.project_id, session.owner);
  if (project.module !== input.module) throw new PublicError(400, '项目与任务模块不匹配。');
  const digest = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const existing = db.prepare('SELECT id, digest FROM tasks WHERE owner=? AND idem=?').get(session.owner, key);
  if (existing) {
    if (existing.digest !== digest) throw new PublicError(409, '此提交标识已用于另一项请求。');
    return reply.code(202).send({ task_id: existing.id });
  }
  let asset: Asset | undefined;
  if (input.module === 'classroom' || input.action === 'identify_learning_targets') {
    asset = assetFor(input.asset_ids[0], project.id);
    if (input.module === 'practice' && !practiceMaterial(asset.extension)) throw new PublicError(415, '知识点识别需要可复制文字的教材，图片可在生成练习时添加。');
    if (input.input.pages && asset.extension !== '.pdf') throw new PublicError(400, '页码仅用于 PDF 材料。');
    if (input.module === 'classroom' && project.track && project.track !== input.input.track) throw new PublicError(409, '请使用本项目的课程轨道。');
  }
  let analysisTask: string | undefined;
  if (input.action === 'design_practice_pack') {
    const source = db.prepare(`SELECT t.id, a.card FROM artifacts a JOIN tasks t ON a.task=t.id
      WHERE a.id=? AND t.owner=? AND t.project=? AND json_extract(a.card,'$.kind')='practice_analysis'
      AND json_extract(t.snapshot,'$.status')='succeeded'`).get(input.input.analysis_id, session.owner, project.id);
    if (!source) throw new PublicError(404, '本项目的知识点分析不可用。');
    const available = new Set((JSON.parse(source.card as string) as z.infer<typeof validateAnalysis>).targets.map(target => target.id));
    if (input.input.target_ids.some(id => !available.has(id))) throw new PublicError(400, '请从本项目本次识别的候选中选择知识点。');
    analysisTask = source.id as string;
    const [imageId] = input.asset_ids;
    if (imageId) {
      asset = assetFor(imageId, project.id);
      if (!practiceImage(asset.extension)) throw new PublicError(415, '练习配图请选择 PNG、JPEG 或 WebP 图片。');
    } else if (input.input.image_prompt || input.input.image_alt) {
      throw new PublicError(400, '请先上传配图再填写看图任务或图片说明。');
    }
  }
  if (jobs.size >= 2) throw new PublicError(429, '当前任务正在处理，请稍后重试。');
  const snapshot: Snapshot = { task_id: randomUUID(), revision: 1, status: 'queued', title: project.title,
    summary: '任务已接收。', artifact_ids: [], next_action: null,
    ...(input.module === 'practice' ? { action: input.action, ...(analysisTask ? { analysis_task_id: analysisTask } : {}) } : {}) };
  db.prepare('INSERT INTO tasks VALUES (?,?,?,?,?,?)').run(snapshot.task_id, session.owner, project.id, key, digest, JSON.stringify(snapshot));
  if (input.module === 'classroom' && !project.track) db.prepare('UPDATE projects SET track=? WHERE id=? AND owner=?').run(input.input.track, project.id, session.owner);
  const job = delay(60).then(() => runTask(snapshot, input, asset));
  jobs.add(job);
  void job.catch(() => console.error(JSON.stringify({ code: 'TASK_PERSIST_FAILED' }))).finally(() => {
    jobs.delete(job);
  });
  return reply.code(202).send({ task_id: snapshot.task_id });
});
function artifactFor(id: string, session: Session) {
  const row = db.prepare('SELECT card FROM artifacts JOIN tasks ON artifacts.task=tasks.id WHERE artifacts.id=? AND tasks.owner=?').get(id, session.owner);
  if (!row) throw new PublicError(404, '成果不可用。');
  return JSON.parse(row.card as string);
}
app.get(`${prefix}/artifacts/:id`, async request => artifactFor((request.params as { id: string }).id, auth(request)));
const practiceFormats = z.enum(['student', 'teacher']);
const classroomPreviewPolicy = "sandbox allow-scripts allow-forms; default-src 'none'; img-src data:; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'self'; form-action 'none'; base-uri 'none'";
const practicePreviewPolicy = "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'; frame-ancestors 'self'; form-action 'none'; base-uri 'none'";
app.get(`${prefix}/artifacts/:id/download`, async (request, reply) => {
  const { id } = request.params as { id: string };
  const card = artifactFor(id, auth(request));
  const { format } = z.object({ format: z.enum(['html', 'pptx', ...practiceFormats.options]) }).parse(request.query);
  if (card.kind === 'practice_pack') {
    const selected = practiceFormats.safeParse(format);
    if (!selected.success) throw new PublicError(404, '文件不可用。');
    const file = `${selected.data}.html`;
    return reply.header('Content-Disposition', `attachment; filename="${file}"`).header('Content-Security-Policy', practicePreviewPolicy)
      .type('text/html; charset=utf-8').send(createReadStream(previewPath(id, file)));
  }
  if (card.kind !== 'lesson' || (format !== 'html' && format !== 'pptx')) throw new PublicError(404, '文件不可用。');
  const file = `lesson.${format}`;
  const types = { html: 'text/html; charset=utf-8', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' };
  return reply.header('Content-Disposition', `attachment; filename="${file}"`).type(types[format]).send(createReadStream(previewPath(id, file)));
});
app.get(`${prefix}/artifacts/:id/preview`, async (request, reply) => {
  const { id } = request.params as { id: string };
  const card = artifactFor(id, auth(request));
  if (card.kind === 'practice_pack') {
    const { format } = z.object({ format: practiceFormats.default('student') }).parse(request.query);
    return reply.header('Content-Security-Policy', practicePreviewPolicy)
      .type('text/html; charset=utf-8').send(createReadStream(previewPath(id, `${format}.html`)));
  }
  if (card.kind !== 'lesson') throw new PublicError(404, '预览不可用。');
  return reply.header('Content-Security-Policy', classroomPreviewPolicy)
    .type('text/html; charset=utf-8').send(createReadStream(previewPath(id, 'lesson.html')));
});

registerOperations(app, { db, auth, PublicError });
registerStudents(app, { db, auth, PublicError });
app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: '页面或接口不可用。' }));

origin = await app.listen({ host: '127.0.0.1', port: 0 });
const address = app.server.address();
if (!address || typeof address === 'string') throw new Error('Teaching runtime listener unavailable');
process.send?.({ teachingPort: address.port });
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  try {
    await app.close();
    await Promise.allSettled(jobs);
    db.close();
  } finally {
    if (process.connected) process.disconnect();
  }
}
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());

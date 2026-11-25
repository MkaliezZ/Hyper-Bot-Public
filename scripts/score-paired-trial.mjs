import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { readFrozenTrial } from './launch-paired-trial.mjs';

const FORCED_SECONDS = 300;
const REQUIRED_PAIRS = 6;
const MIN_CORRECT = 5;
const MIN_REDUCTION_PERCENT = 20;
const trialTemplates = new Map([
  ['hyper-bot-m1-dev31-r1', '../docs/配对试用/现场记录-dev.31.json'],
  ['hyper-bot-m1-dev46-r1', '../docs/配对试用/现场记录-dev.46.json']
]);
const yesNo = z.boolean().nullable();
const note = z.string().trim().min(1).max(1000).nullable();
const optionalSeconds = z.number().int().nonnegative().nullable();

const attempt = z.strictObject({
  status: z.enum(['pending', 'completed', 'incomplete']),
  independentBy45: yesNo,
  submissionSeconds: z.number().int().min(1).max(FORCED_SECONDS).nullable(),
  handsOnSeconds: optionalSeconds,
  deliverable: yesNo,
  foundFirstDraft: yesNo,
  spokenReadSeconds: optionalSeconds,
  factMismatch: yesNo,
  intervention: note,
  outcomeReason: note,
  evidence: note
}).superRefine((value, context) => {
  function require(ok, field, message) {
    if (!ok) context.addIssue({ code: 'custom', path: [field], message });
  }
  if (value.status === 'completed') {
    for (const field of [
      'independentBy45', 'submissionSeconds', 'handsOnSeconds', 'deliverable',
      'foundFirstDraft', 'factMismatch', 'intervention', 'evidence'
    ]) {
      require(value[field] !== null, field, '完成项需要该观察。');
    }
    if (value.submissionSeconds !== null && value.handsOnSeconds !== null) {
      require(value.handsOnSeconds >= value.submissionSeconds, 'handsOnSeconds', '人工总时长应包含首轮主动用时。');
    }
  }
  if (value.status === 'incomplete') {
    require(value.outcomeReason !== null, 'outcomeReason', '记录未完成或退出原因。');
  }
  if (value.factMismatch === true) {
    require(value.deliverable === false, 'deliverable', '确认事实错配的稿件按不可交付记录。');
    require(value.evidence !== null, 'evidence', '事实错配需要核查依据。');
  }
});

const input = z.strictObject({
  schema: z.literal(1),
  observations: z.enum(['human', 'synthetic']),
  recruited: z.number().int().min(0).max(8),
  freeze: z.record(z.string(), z.unknown()),
  slots: z.array(z.strictObject({
    id: z.string(),
    order: z.array(z.string()).length(2),
    enrolled: z.boolean(),
    baseline: attempt,
    hyperBot: attempt
  })).length(8)
});

function terminal(slot) {
  return slot.baseline.status !== 'pending' && slot.hyperBot.status !== 'pending';
}

function activeSeconds(arm) {
  return arm.status === 'incomplete' ? FORCED_SECONDS : arm.submissionSeconds;
}

function comparison(pairs) {
  const entries = pairs.map(({id, baseline, hyperBot}) => {
    const base = activeSeconds(baseline);
    const candidate = activeSeconds(hyperBot);
    return {id, baselineSeconds: base, hyperBotSeconds: candidate, savedSeconds: base - candidate};
  });
  const ratios = [...entries].sort((a, b) =>
    a.savedSeconds * b.baselineSeconds - b.savedSeconds * a.baselineSeconds
  );
  const [left, right] = ratios.slice(2, 4);
  const denominator = left.baselineSeconds * right.baselineSeconds;
  const numerator = left.savedSeconds * right.baselineSeconds + right.savedSeconds * left.baselineSeconds;
  const median = numerator / (2 * denominator);
  const count = (arm, key) => pairs.filter(slot => slot[arm][key] === true).length;
  const counts = {
    independentBy45: count('hyperBot', 'independentBy45'),
    deliverable: Object.fromEntries(['baseline', 'hyperBot'].map(arm => [
      arm, pairs.filter(slot => slot[arm].status === 'completed' && slot[arm].deliverable).length
    ])),
    foundFirstDraft: {baseline: count('baseline', 'foundFirstDraft'), hyperBot: count('hyperBot', 'foundFirstDraft')}
  };
  const meets = {
    independentBy45: counts.independentBy45 >= MIN_CORRECT,
    medianReduction: 100 * numerator >= 2 * denominator * MIN_REDUCTION_PERCENT,
    deliverable: counts.deliverable.hyperBot >= MIN_CORRECT && counts.deliverable.hyperBot >= counts.deliverable.baseline,
    foundFirstDraft: counts.foundFirstDraft.hyperBot >= counts.foundFirstDraft.baseline
  };
  return {entries, counts, medianReduction: median, meets};
}

export function scorePairedTrial(raw, frozen) {
  const data = input.parse(raw);
  if (!isDeepStrictEqual(data.freeze, frozen.freeze)) {
    throw new Error('试用的发行包、版本、材料或任务与冻结样表不符。');
  }
  for (const [index, slot] of data.slots.entries()) {
    const expected = frozen.slots[index];
    if (slot.id !== expected.id || !isDeepStrictEqual(slot.order, expected.order)) {
      throw new Error('匿名编号或 A/B 顺序与冻结样表不符。');
    }
    if (!slot.enrolled && [slot.baseline, slot.hyperBot].some(arm => arm.status !== 'pending')) {
      throw new Error(slot.id + ' 未入组，不能登记为终态。');
    }
  }
  const enrolled = data.slots.filter(slot => slot.enrolled);
  if (enrolled.length > data.recruited || data.slots.slice(0, enrolled.length).some(slot => !slot.enrolled)) {
    throw new Error('核对招募人数，并按合格入组顺序从第一号开始分配。');
  }

  const primary = enrolled.slice(0, REQUIRED_PAIRS);
  const mismatches = enrolled.flatMap(slot => ['baseline', 'hyperBot']
    .filter(arm => slot[arm].factMismatch === true)
    .map(arm => ({id: slot.id, arm, evidence: slot[arm].evidence})));
  const recordedPairs = primary.filter(terminal).length;
  const results = recordedPairs === REQUIRED_PAIRS ? comparison(primary) : null;
  const observedOutcome = mismatches.length ? 'fact_correction_needed'
    : !results ? 'unknown'
    : Object.values(results.meets).every(Boolean) ? 'meets_prd_observation_thresholds' : 'below_thresholds';
  return {
    trial: frozen.freeze.trial,
    observations: data.observations,
    recruited: data.recruited,
    enrolled: enrolled.length,
    recordedPairs,
    primary: primary.map(slot => slot.id),
    supplementary: enrolled.slice(REQUIRED_PAIRS).map(slot => slot.id),
    outcome: data.observations === 'human' ? observedOutcome : 'synthetic_only',
    observedOutcome,
    factMismatches: mismatches,
    results
  };
}

async function readTrial(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    if (process.argv.length !== 3) throw new Error('用法 node scripts/score-paired-trial.mjs <填写后的记录.json>');
    const record = await readTrial(process.argv[2]);
    const trial = record?.freeze?.trial;
    const legacy = trialTemplates.get(trial);
    const directory = fileURLToPath(new URL('../docs/配对试用/', import.meta.url));
    const frozen = legacy
      ? await readTrial(new URL(legacy, import.meta.url)) : (await readFrozenTrial(directory, trial)).parsed;
    const result = scorePairedTrial(record, frozen);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.issues?.map(issue => issue.path.join('.') + ' ' + issue.message).join('\n') ?? error.message);
    process.exitCode = 1;
  }
}


import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  LEDGER_TIMEZONE_IMPORTS_CONFLICT_CODE, LEDGER_TIMEZONE_IMPORTS_CONFLICT_MESSAGE,
  importTimezoneConflict, planImportDateRebase, plannedRebaseCount, rebaseImportedEntryDate,
} from '../services/importTimezoneRebase';
import { localDateToInstant } from '../services/importLedger';
import { localDate } from '../services/gl/dates';

/**
 * البند 25 (مراجعة الاستيراد 2026-09-17): استيراد قبل ضبط المنطقة (الرياض افتراضياً) ثم اختيار القاهرة في المعالج
 * يزيح كل تاريخ مستورد يوماً: 2026-01-01 مخزّن 2025-12-31T21:00Z = 2025-12-31 بتوقيت القاهرة.
 */

const RIYADH = 'Asia/Riyadh';
const CAIRO = 'Africa/Cairo';
const ADEN = 'Asia/Aden';

test('إعادة إنتاج الخلل: تاريخ مستورد بالرياض يُقرأ يوماً سابقاً بالقاهرة', () => {
  const stored = localDateToInstant(RIYADH, '2026-01-01');
  assert.equal(stored.toISOString(), '2025-12-31T21:00:00.000Z');
  assert.equal(localDate(stored, CAIRO), '2025-12-31');
});

test('rebaseImportedEntryDate: بداية يوم الرياض ⇒ بداية اليوم نفسه بالقاهرة', () => {
  const next = rebaseImportedEntryDate(new Date('2025-12-31T21:00:00.000Z'), RIYADH, CAIRO);
  assert.ok(next);
  assert.equal(next!.toISOString(), '2025-12-31T22:00:00.000Z');
  assert.equal(localDate(next!, CAIRO), '2026-01-01');
});

test('rebaseImportedEntryDate: لحظة غير محاذية لبداية يوم ⇒ null', () => {
  assert.equal(rebaseImportedEntryDate(new Date('2025-12-31T21:00:00.001Z'), RIYADH, CAIRO), null);
  assert.equal(rebaseImportedEntryDate(new Date('2026-01-01T09:30:00.000Z'), RIYADH, CAIRO), null);
  assert.equal(rebaseImportedEntryDate(new Date('invalid'), RIYADH, CAIRO), null);
});

test('planImportDateRebase: تجميع حسب اللحظة القديمة وتخطي غير المحاذي', () => {
  const d1 = new Date('2025-12-31T21:00:00.000Z');
  const d2 = new Date('2026-01-14T21:00:00.000Z');
  const plan = planImportDateRebase([
    { id: 'a', entryDate: d1 }, { id: 'b', entryDate: d1 }, { id: 'c', entryDate: d2 },
    { id: 'x', entryDate: new Date('2026-01-05T08:00:00.000Z') },
  ], RIYADH, CAIRO);
  assert.equal(plan.length, 2);
  const g1 = plan.find((g) => g.from.getTime() === d1.getTime())!;
  assert.deepEqual(g1.ids, ['a', 'b']);
  assert.equal(g1.to.toISOString(), '2025-12-31T22:00:00.000Z');
  assert.equal(plan.flatMap((g) => g.ids).includes('x'), false);
});

test('importTimezoneConflict: دفعة قائمة مع تغيّر المنطقة ⇒ تفاصيل العقد؛ وإلا null', () => {
  const createdAt = new Date('2026-09-01T10:00:00.000Z');
  const batches = [
    { id: 'b1', kind: 'ledger', count: 12, createdAt },
    { id: 'b0', kind: 'balances', count: 0, createdAt },
    { id: 'p1', kind: 'prices', count: 3, createdAt },
  ];
  const c = importTimezoneConflict({ previousTimezone: RIYADH, timezone: CAIRO, batches, shiftedEntries: 12 });
  assert.deepEqual(c, {
    reason: 'IMPORT_TIMEZONE_CONFLICT', previousTimezone: RIYADH, timezone: CAIRO, field: 'rebaseImportDates',
    shiftedEntries: 12,
    batches: [{ id: 'b1', kind: 'ledger', count: 12, createdAt: createdAt.toISOString() }],
  });
  assert.equal(importTimezoneConflict({ previousTimezone: RIYADH, timezone: RIYADH, batches, shiftedEntries: 12 }), null);
  assert.equal(importTimezoneConflict({ previousTimezone: RIYADH, timezone: CAIRO, batches: [batches[1], batches[2]], shiftedEntries: 12 }), null);
  assert.equal(LEDGER_TIMEZONE_IMPORTS_CONFLICT_CODE, 'LEDGER_TIMEZONE_IMPORTS_CONFLICT');
  assert.equal(
    LEDGER_TIMEZONE_IMPORTS_CONFLICT_MESSAGE,
    'للشركة أرصدة أو كشوف مستوردة بالمنطقة الزمنية السابقة، وتغييرها يزيح تواريخها يوماً. تراجع عن الدفعات أو أكّد إعادة ضبط تواريخها على المنطقة الجديدة',
  );
});

// البند D: التعارض كان يُقاس باسم المنطقة، فالانتقال بين منطقتين بإزاحة واحدة (+03) يُشعل 409 بلا سبب —
// أو LEDGER_IMPORT_IN_PROGRESS في حفظ المسودة لأن القفل كان يُؤخذ قبل الفحص — و`planImportDateRebase` تتخطّى الكل.
test('البند D: Asia/Riyadh ⇄ Asia/Aden إزاحة واحدة ⇒ خطّة فارغة فلا تعارض', () => {
  const entries = [
    { id: 'a', entryDate: localDateToInstant(RIYADH, '2026-01-01') },
    { id: 'b', entryDate: localDateToInstant(RIYADH, '2026-03-15') },
  ];
  assert.equal(localDateToInstant(ADEN, '2026-01-01').getTime(), entries[0].entryDate.getTime(), 'إزاحة واحدة');
  const same = planImportDateRebase(entries, RIYADH, ADEN);
  assert.deepEqual(same, []);
  assert.equal(plannedRebaseCount(same), 0);
  const batches = [{ id: 'b1', kind: 'ledger', count: 2, createdAt: new Date('2026-09-01T10:00:00.000Z') }];
  assert.equal(importTimezoneConflict({ previousTimezone: RIYADH, timezone: ADEN, batches, shiftedEntries: 0 }), null);
  // والعكس: القاهرة تُزيح فعلاً فيبقى التعارض قائماً بعدد القيود المُزاحة
  const shifted = planImportDateRebase(entries, RIYADH, CAIRO);
  assert.equal(plannedRebaseCount(shifted), 2);
  const c = importTimezoneConflict({ previousTimezone: RIYADH, timezone: CAIRO, batches, shiftedEntries: plannedRebaseCount(shifted) });
  assert.equal(c?.shiftedEntries, 2);
});

test('plannedRebaseCount: مجموع معرّفات المجموعات', () => {
  assert.equal(plannedRebaseCount([]), 0);
  assert.equal(plannedRebaseCount([{ ids: ['a', 'b'] }, { ids: ['c'] }]), 3);
});

// ═══ حرّاس ثابتة على routes/ledger/setup.ts ═══

const SRC = fs.readFileSync(path.join(__dirname, '..', 'routes', 'ledger', 'setup.ts'), 'utf8');
const section = (startMarker: string, endMarker: string) => {
  const a = SRC.indexOf(startMarker);
  assert.ok(a >= 0, startMarker);
  const b = SRC.indexOf(endMarker, a + startMarker.length);
  assert.ok(b > a, endMarker);
  return SRC.slice(a, b);
};

test('الحارس (البند D): القياس بالقراءة أولاً، والقفل وفحص الجاري في فرع إعادة الضبط وحده', () => {
  const zone = section('// ═══ المنطقة الزمنية والاستيراد (البند 25) ═══', '// ═══ GET /setup ═══');
  assert.match(zone, /reverted: false, kind: \{ in: \[\.\.\.IMPORT_ENTRY_KINDS\] \}, count: \{ gt: 0 \}/);
  assert.match(zone, /invoiceId: null, receiptId: null/);

  const g = section('export async function guardImportTimezone(', '// ═══ GET /setup ═══');
  assert.match(g, /importTimezone\(before\)/);
  const batches = g.indexOf('loadImportEntryBatches(tx, tenantId)');
  const plan = g.indexOf('planTenantImportRebase(');
  const conflict = g.indexOf('importTimezoneConflict({');
  const thrown = g.indexOf('LEDGER_TIMEZONE_IMPORTS_CONFLICT_CODE');
  const lock = g.indexOf('acquireImportEntriesLock(tx, tenantId)');
  const running = g.indexOf('loadRunningImportBatch(');
  assert.ok(batches >= 0 && plan > batches && conflict > plan, 'الدفعات ثم الخطّة ثم قياس التعارض');
  assert.ok(thrown > conflict, 'الرمز يُرمى بعد القياس');
  assert.ok(lock > thrown && running > lock, 'القفل وفحص الجاري بعد ثبوت الإزاحة لا قبلها');
  assert.match(g, /shiftedEntries: plannedRebaseCount\(plan\)/);
  assert.match(g, /'LEDGER_IMPORT_IN_PROGRESS'/);
  assert.match(g, /updateMany\(\{ where: \{ tenantId, id: \{ in: g\.ids \}, entryDate: g\.from \}, data: \{ entryDate: g\.to \} \}\)/);
  // الخطّة تُعاد قراءتها تحت القفل حين يأخذه الحارس بنفسه
  assert.match(g.slice(running), /finalPlan = await planTenantImportRebase\(/);
});

test('الحارس: /setup/draft ينزع rebaseImportDates قبل draftSchema ويفحص قبل glSettings.update', () => {
  const d = section("router.post('/setup/draft'", '// ═══ السياق والأرصدة اليدوية ═══');
  const strip = d.indexOf('rebaseImportDates: rawRebase');
  const parse = d.indexOf('draftSchema.parse(draftBody)');
  assert.ok(strip >= 0 && parse > strip);
  assert.doesNotMatch(d, /draftSchema\.parse\(req\.body/);
  const guard = d.indexOf('guardImportTimezone(');
  const write = d.indexOf('tx.glSettings.update(');
  const ensure = d.indexOf('ensureSettingsRow(');
  assert.ok(guard > 0 && guard < write && guard < ensure, 'الفحص قبل أي كتابة');
  assert.match(d.slice(guard, guard + 200), /lockHeld: false/);
  assert.match(d, /rebasedImportEntries/);
});

test('الحارس: /setup/commit يفحص بعد قفل الدفعات القائم وقبل حسابات التواريخ والكتابة، بلا قفل ثانٍ', () => {
  const c = section("router.post('/setup/commit'", '// ═══ POST /setup/backfill ═══');
  const lock = c.indexOf('acquireImportEntriesLock(tx, tenantId)');
  const guard = c.indexOf('guardImportTimezone(');
  assert.ok(lock >= 0 && guard > lock);
  assert.equal(c.indexOf('acquireImportEntriesLock(', lock + 1), -1, 'القفل مرة واحدة');
  assert.match(c.slice(guard, guard + 250), /lockHeld: true/);
  assert.match(c.slice(guard, guard + 250), /parsed\.data\.rebaseImportDates/);
  for (const later of ['loadOpeningStockCheck(', 'loadImportedAfterCutover(', 'ensureSettingsRow(', 'tx.glSettings.update(', 'loadOpeningSources(']) {
    assert.ok(c.indexOf(later) > guard, `${later} بعد الفحص`);
  }
  const schema = section('const commitSchema = z.object({', '}).strict();');
  assert.match(schema, /rebaseImportDates: z\.boolean\(\)\.optional\(\)/);
});

// ═══ البند 25: المنفذ الثاني — PUT /ledger/settings (routes/ledger/config.ts) ═══

const CFG = fs.readFileSync(path.join(__dirname, '..', 'routes', 'ledger', 'config.ts'), 'utf8');

test('البند 25: PUT /ledger/settings يمرّ تغيير المنطقة بالحارس نفسه قبل أي كتابة', () => {
  const a = CFG.indexOf("router.put('/settings'");
  assert.ok(a >= 0);
  const b = CFG.indexOf("router.post('/settings/load-template'", a);
  assert.ok(b > a);
  const h = CFG.slice(a, b);
  assert.match(CFG, /import \{ dbNowOf, guardImportTimezone \} from '\.\/setup';/);
  // rebaseImportDates يُنزع قبل المخطّط الصارم فلا يُكتب عموداً ولا يُرفض بـstrict
  const strip = h.indexOf('rebaseImportDates: rawRebase');
  const parse = h.indexOf('settingsUpdateSchema.parse(settingsBody)');
  assert.ok(strip >= 0 && parse > strip);
  assert.doesNotMatch(h, /settingsUpdateSchema\.parse\(req\.body\)/);
  const guard = h.indexOf('guardImportTimezone(tx, tenantId, s, nextImportTimezone');
  const write = h.indexOf('tx.glSettings.update(');
  assert.ok(guard > 0 && write > guard, 'الفحص قبل كتابة الإعدادات');
  assert.match(h, /body\.timezone === undefined/, 'لا استعلام ساعة قاعدة بلا تغيير منطقة');
  // المقياس منطقة الاستيراد بعد الكتابة (المسودة تسبق العمود قبل التفعيل) لا العمود المرسل وحده
  assert.match(h, /importTimezone\(\{ \.\.\.s, timezone: body\.timezone \}\)/);
  assert.match(h.slice(guard, guard + 200), /rebase: rebaseImportDates/);
  assert.match(h.slice(guard, guard + 200), /lockHeld: false/);
  // الرد يحمل rebasedImportEntries كما في المعالج، والتدقيق يذكرها ولو لم يتغيّر عمود
  assert.match(h, /rebasedImportEntries: updated\.rebasedImportEntries/);
  assert.match(h, /d\.changed\.length \|\| rebasedImportEntries !== undefined/);
  // ونافذة ما بعد التفعيل تبقى مغلقة كما كانت
  assert.match(CFG, /const FROZEN_AFTER_ACTIVATION = \['timezone',/);
});

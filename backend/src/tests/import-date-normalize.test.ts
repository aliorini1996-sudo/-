// البند 1 والبند 2(ب) — تطبيع تاريخ الاستيراد في الخادم (routes/import.ts عبر services/importLedger.ts). بلا قاعدة بيانات.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  ImportHttpError, importTimezone, isImportDate, localDateToInstant, resolveImportDates,
} from '../services/importLedger';
import { openingCutoff } from '../services/gl/opening';

const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');
const rejects400 = (fn: () => unknown, code: string) => assert.throws(fn, (e: unknown) => {
  assert.ok(e instanceof ImportHttpError);
  assert.equal(e.status, 400);
  assert.equal(e.code, code);
  return true;
});

test("localDateToInstant('Asia/Riyadh','2026-09-01') يساوي cutoverStart في opening.ts", () => {
  const cut = openingCutoff('2026-09-01', 'Asia/Riyadh', new Date('2026-09-10T00:00:00Z'));
  const at = localDateToInstant('Asia/Riyadh', '2026-09-01');
  assert.equal(at.getTime(), cut.cutoverStart.getTime());
  assert.equal(at.toISOString(), '2026-08-31T21:00:00.000Z');
});

test("'2026-08-31' أصغر من بداية يوم البدء، ويوم البدء نفسه ليس قبله", () => {
  const cutoverStart = localDateToInstant('Asia/Riyadh', '2026-09-01');
  assert.ok(localDateToInstant('Asia/Riyadh', '2026-08-31').getTime() < cutoverStart.getTime());
  assert.ok(!(localDateToInstant('Asia/Riyadh', '2026-09-01').getTime() < cutoverStart.getTime()));
  // new Date('2026-09-01') القديمة = منتصف الليل UTC = 03:00 الرياض — والآن أول لحظة محلية
  assert.ok(localDateToInstant('Asia/Riyadh', '2026-09-01').getTime() < new Date('2026-09-01').getTime());
});

test('الصيغة غير الصالحة تُرفض بـ400 IMPORT_INVALID_DATE', () => {
  for (const bad of ['01/02/2026', '2026-02-31', '2026-13-01', '2026-9-1', '', '2026-09-01T00:00:00Z']) {
    assert.equal(isImportDate(bad), false, bad);
    rejects400(() => localDateToInstant('Asia/Riyadh', bad), 'IMPORT_INVALID_DATE');
  }
  assert.equal(isImportDate('2024-02-29'), true);
  rejects400(() => resolveImportDates([{ date: '2026-09-01' }, { date: '31/12/2025' }], { timezone: 'Asia/Riyadh', activated: false, now: new Date() }), 'IMPORT_INVALID_DATE');
  rejects400(() => resolveImportDates([], { timezone: 'Asia/Riyadh', undatedDate: '2026/08/31', activated: false, now: new Date() }), 'IMPORT_INVALID_DATE');
});

test('كل التواريخ تُفحص قبل أي كتابة: الخطأ يذكر أرقام الأسطر كلها', () => {
  try {
    resolveImportDates([{ date: 'x' }, { date: '2026-01-01' }, { date: '2026-02-30' }], { timezone: 'Asia/Riyadh', activated: false, now: new Date() });
    assert.fail('لم يُرفض');
  } catch (e) {
    assert.ok(e instanceof ImportHttpError);
    assert.deepEqual(e.details.rows, [{ row: 2, date: 'x' }, { row: 4, date: '2026-02-30' }]);
  }
});

test('قبل التفعيل: بلا تاريخ ⇒ لحظة الاستيراد وundatedAsToday بعددها؛ undatedDate يملأ الفارغ فقط', () => {
  const now = new Date('2026-09-17T10:00:00Z');
  const r = resolveImportDates([{ date: '2026-08-31' }, {}, { date: '' }, { date: null }], { timezone: 'Asia/Riyadh', activated: false, now });
  assert.equal(r.undatedAsToday, 3);
  assert.equal(r.dates[0].toISOString(), '2026-08-30T21:00:00.000Z');
  assert.equal(r.dates[1].getTime(), now.getTime());
  const f = resolveImportDates([{ date: '2026-09-05' }, {}], { timezone: 'Asia/Riyadh', undatedDate: '2026-08-31', activated: false, now });
  assert.equal(f.undatedAsToday, 0);
  assert.equal(f.dates[0].toISOString(), '2026-09-04T21:00:00.000Z');
  assert.equal(f.dates[1].toISOString(), '2026-08-30T21:00:00.000Z');
});

test('بعد التفعيل: صفوف بلا تاريخ ولا undatedDate ⇒ 400 UNDATED_ROWS_LEDGER_ACTIVE بعددها؛ ومع undatedDate تمر', () => {
  const opts = { timezone: 'Asia/Riyadh', activated: true, now: new Date() };
  try {
    resolveImportDates([{ date: '2026-08-31' }, {}, {}], opts);
    assert.fail('لم يُرفض');
  } catch (e) {
    assert.ok(e instanceof ImportHttpError);
    assert.equal(e.status, 400);
    assert.equal(e.code, 'UNDATED_ROWS_LEDGER_ACTIVE');
    assert.equal(e.details.count, 2);
  }
  assert.equal(resolveImportDates([{}, {}], { ...opts, undatedDate: '2026-08-31' }).undatedAsToday, 0);
  assert.equal(resolveImportDates([{ date: '2026-09-02' }], opts).undatedAsToday, 0);
});

test('توقيت الشركة: قبل التفعيل مسودة الخطوة 1، وبعده الإعدادات، والافتراضي الرياض', () => {
  assert.equal(importTimezone(null), 'Asia/Riyadh');
  assert.equal(importTimezone({ activatedAt: null, timezone: 'Asia/Riyadh', setupDraft: { step1: { timezone: 'Asia/Dubai' } } }), 'Asia/Dubai');
  assert.equal(importTimezone({ activatedAt: new Date(), timezone: 'Africa/Cairo', setupDraft: { step1: { timezone: 'Asia/Dubai' } } }), 'Africa/Cairo');
  assert.equal(importTimezone({ activatedAt: null, timezone: 'Not/AZone', setupDraft: { step1: { timezone: 'bad' } } }), 'Asia/Riyadh');
  assert.equal(localDateToInstant('Asia/Dubai', '2026-09-01').toISOString(), '2026-08-31T20:00:00.000Z');
});

test('import.ts: حقل date في الأرصدة والكشف YYYY-MM-DD، ولا new Date(ymd)، والتحقق قبل أي معاملة', () => {
  const s = read('routes/import.ts');
  assert.match(s, /const importDate = z\.preprocess\([\s\S]*?regex\(YMD_RE/);
  for (const schema of ['const balanceRow', 'const ledgerRow']) {
    const i = s.indexOf(schema);
    assert.match(s.slice(i, s.indexOf('});', i)), /date: importDate,/, `${schema} بلا importDate`);
  }
  assert.doesNotMatch(s, /new Date\((?:r|e)\.date\)/, 'new Date(ymd) ما زال مستعملاً');
  for (const head of ["router.post('/balances'", "router.post('/ledger'"]) {
    const i = s.indexOf(head);
    const body = s.slice(i, s.indexOf('\n});', i));
    const resolve = body.indexOf('resolveImportDates(');
    assert.ok(resolve > 0, `${head} بلا resolveImportDates`);
    assert.ok(resolve < body.indexOf('prisma.$transaction('), `${head}: التحقق بعد المعاملة`);
    assert.match(body, /undatedDate: body\.undatedDate/);
    assert.match(body, /warnings: \{ undatedAsToday/);
    assert.match(body, /sendImportError\(err, res, next\)/);
  }
});

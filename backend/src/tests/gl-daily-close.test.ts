// الإقفال اليومي للدفاتر اليدوية (أمر المالك، ٨ أكتوبر ٢٠٢٦): التوقيت (11:55 م والمهلة والنوافذ)، وتصنيف دفتر العملاء التشغيلي،
// وبناء قيود الافتتاح واليوم والمخزون متوازنةً ومقبولةً من تحقق النظام على القالب السعودي — وحرّاس التوصيل.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  DAILY_CLOSE_LAG_MS, buildDailySalesMove, buildInventoryCloseMove, buildLinkOpeningMove, dailyBucketOf, dailyCutoff, dueDays,
  linkStart, pickJournal, windowStartOf, type DailyArRow,
} from '../services/gl/dailyClose';
import { saContext } from '../services/gl/testing/fixtures';
import { validateMove } from '../services/gl/validate';
import type { MoveDraft } from '../services/gl/types';

const TZ = 'Asia/Riyadh';
const ctx = saContext();
const base = (systemKey: 'SALES' | 'STOCK' | 'MISC', date = '2026-10-07') =>
  ({ date, currencyCode: 'SAR', currencyDecimals: 2, journal: pickJournal(ctx, systemKey) });
const m = (sar: number) => BigInt(Math.round(sar * 1000));
const sumBy = (d: MoveDraft, key: string) => d.lines.filter((l) => l.accountKey === key).reduce((s, l) => s + l.debitMilli - l.creditMilli, 0n);
const balanced = (d: MoveDraft) => {
  const dr = d.lines.reduce((s, l) => s + l.debitMilli, 0n);
  const cr = d.lines.reduce((s, l) => s + l.creditMilli, 0n);
  assert.equal(dr, cr, 'القيد متوازن');
};

test('التوقيت: الإقفال 11:55 م بتوقيت الشركة، وبداية الربط 1 أكتوبر أو لحظة التفعيل بعده، والنافذة (إقفال الأمس، إقفال اليوم]', () => {
  assert.equal(dailyCutoff('2026-10-07', TZ).toISOString(), '2026-10-07T20:55:00.000Z');
  const early = linkStart(new Date('2026-09-28T17:36:13Z'), TZ);
  assert.equal(early.date, '2026-10-01');
  assert.equal(early.instant.toISOString(), '2026-09-30T21:00:00.000Z');
  const late = linkStart(new Date('2026-11-05T11:00:00Z'), TZ);
  assert.equal(late.date, '2026-11-05');
  assert.equal(late.instant.toISOString(), '2026-11-05T11:00:00.000Z', 'البداية النظيفة: لا شيء قبل لحظة التفعيل');
  assert.deepEqual(windowStartOf('2026-10-01', early, TZ), { at: early.instant, inclusive: true });
  assert.deepEqual(windowStartOf('2026-10-02', early, TZ), { at: dailyCutoff('2026-10-01', TZ), inclusive: false });
  // تفعيلٌ بين 11:55 ومنتصف الليل: نافذة الغد تبدأ من لحظة التفعيل لا من 11:55 (ما قبلها في الافتتاح — لا يُحسب مرتين)
  const night = linkStart(new Date('2026-11-05T20:57:00Z'), TZ); // 11:57 م بالرياض
  assert.equal(night.date, '2026-11-05');
  assert.deepEqual(windowStartOf('2026-11-06', night, TZ), { at: night.instant, inclusive: true });
  assert.deepEqual(windowStartOf('2026-11-07', night, TZ), { at: dailyCutoff('2026-11-06', TZ), inclusive: false });
});

test('الأيام المستحقة: لا يُقفل اليوم قبل 11:55 + مهلة الالتزام المتأخر، ويُلحق بالأيام الماضية بالترتيب وبحدّ للدورة', () => {
  const cut = dailyCutoff('2026-10-07', TZ).getTime();
  assert.deepEqual(dueDays(new Date(cut + DAILY_CLOSE_LAG_MS - 1), TZ, '2026-10-01', null, 40), ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06']);
  assert.equal(dueDays(new Date(cut + DAILY_CLOSE_LAG_MS), TZ, '2026-10-01', null, 40).at(-1), '2026-10-07');
  assert.deepEqual(dueDays(new Date(cut + DAILY_CLOSE_LAG_MS), TZ, '2026-10-01', '2026-10-05', 40), ['2026-10-06', '2026-10-07']);
  assert.deepEqual(dueDays(new Date(cut + DAILY_CLOSE_LAG_MS), TZ, '2026-10-01', '2026-10-07', 40), []);
  assert.equal(dueDays(new Date(cut + DAILY_CLOSE_LAG_MS), TZ, '2026-10-01', null, 3).length, 3);
});

test('تصنيف دفتر العملاء: السند وتحصيل النقدية ⇒ الصندوق، والمرتجع وإلغاؤه ⇒ المردودات، والبيع وإلغاؤه ⇒ المبيعات، وغيرها ⇒ تسوية', () => {
  assert.equal(dailyBucketOf('RECEIPT_CREDIT', null), 'CASH');
  assert.equal(dailyBucketOf('RECEIPT_DEBIT', 'CASH'), 'CASH');
  assert.equal(dailyBucketOf('INVOICE_CREDIT', 'RETURN'), 'RETURNS');
  assert.equal(dailyBucketOf('INVOICE_DEBIT', 'RETURN'), 'RETURNS');
  assert.equal(dailyBucketOf('INVOICE_DEBIT', 'CREDIT'), 'SALES');
  assert.equal(dailyBucketOf('INVOICE_CREDIT', 'CASH'), 'SALES');
  assert.equal(dailyBucketOf('INVOICE_DEBIT', null), 'ADJUST', 'رصيدٌ مستورد بلا فاتورة');
  assert.equal(dailyBucketOf('ADJUSTMENT_CREDIT', null), 'ADJUST');
});

test('قيد اليوم: المبيعات برقم واحد شامل الضريبة، والمردودات والتحصيل والتسويات كلٌّ برقم، والعملاء بصافي كل عميل — متوازن ومقبول', () => {
  const row = (customerId: string, debit: number, credit: number, bucket: DailyArRow['bucket']): DailyArRow =>
    ({ customerId, customerName: `عميل ${customerId}`, debitMilli: m(debit), creditMilli: m(credit), bucket });
  const rows: DailyArRow[] = [
    row('A', 100, 0, 'SALES'),               // آجلة
    row('B', 50, 0, 'SALES'), row('B', 0, 50, 'CASH'), // نقدية: بيع وتحصيل — صافي العميل صفر
    row('A', 0, 30, 'CASH'),                 // سند قبض
    row('C', 20, 0, 'SALES'), row('C', 0, 20, 'SALES'), // بيعٌ أُلغي في يومه
    row('A', 0, 10, 'RETURNS'),              // مرتجع
    row('D', 5, 0, 'ADJUST'),                // تسوية رصيد
  ];
  const d = buildDailySalesMove(base('SALES'), rows)!;
  assert.ok(d);
  balanced(d);
  assert.equal(sumBy(d, 'SALES_REVENUE'), -m(150), 'المبيعات 150 دائنة برقم واحد');
  assert.equal(sumBy(d, 'SALES_RETURNS'), m(10));
  assert.equal(sumBy(d, 'MAIN_CASH'), m(80));
  assert.equal(sumBy(d, 'OPENING_EQUITY'), -m(5));
  const ar = d.lines.filter((l) => l.accountKey === 'AR_CONTROL');
  assert.deepEqual(ar.map((l) => [l.customerId, l.debitMilli - l.creditMilli]), [['A', m(60)], ['D', m(5)]], 'سطرٌ لكل عميلٍ غير صفري');
  assert.ok(ar.every((l) => l.partnerName), 'اسم العميل لقطةً (G6)');
  assert.equal(d.origin, 'AUTO');
  assert.equal(d.sourceKey, 'DAILY_CLOSE:DAY:2026-10-07');
  assert.equal(d.date, '2026-10-07');
  validateMove(d, ctx, { mode: 'SYSTEM' });
  assert.equal(buildDailySalesMove(base('SALES'), []), null, 'يومٌ بلا حركة ⇒ لا قيد');
  assert.equal(buildDailySalesMove(base('SALES'), [row('C', 20, 0, 'SALES'), row('C', 0, 20, 'SALES')]), null, 'ما أُلغي في يومه لا يُرحَّل');
});

test('افتتاح الربط: رصيد كل عميل ومخزون المستودع ناقص ما في الدفاتر قبله، مقابل الأرصدة الافتتاحية — والمطابق لا قيد له', () => {
  const d = buildLinkOpeningMove(base('MISC', '2026-10-01'), [
    { customerId: 'A', name: 'أ', opsMilli: m(500), ledgerMilli: 0n },
    { customerId: 'B', name: 'ب', opsMilli: m(-20), ledgerMilli: 0n },
    { customerId: 'C', name: 'ج', opsMilli: m(70), ledgerMilli: m(70) },
  ], { valueMilli: m(1000), ledgerMilli: m(100) })!;
  balanced(d);
  assert.equal(sumBy(d, 'AR_CONTROL'), m(480));
  assert.equal(sumBy(d, 'INVENTORY_WAREHOUSE'), m(900));
  assert.equal(sumBy(d, 'OPENING_EQUITY'), -m(1380));
  assert.equal(d.lines.filter((l) => l.accountKey === 'AR_CONTROL').length, 2, 'المطابق لا سطر له');
  assert.equal(d.sourceKey, 'DAILY_CLOSE:OPEN:2026-10-01');
  validateMove(d, ctx, { mode: 'SYSTEM' });
  assert.equal(buildLinkOpeningMove(base('MISC'), [{ customerId: 'C', name: 'ج', opsMilli: m(70), ledgerMilli: m(70) }], { valueMilli: 0n, ledgerMilli: 0n }), null);
});

test('مخزون آخر اليوم: الفرق عن رصيد الدفاتر مقابل التغيّر في المخزون، والقيمة في البيان، والمطابق لا قيد له', () => {
  const up = buildInventoryCloseMove(base('STOCK'), { valueMilli: m(1500), ledgerMilli: m(1000) })!;
  balanced(up);
  assert.equal(sumBy(up, 'INVENTORY_WAREHOUSE'), m(500));
  assert.equal(sumBy(up, 'INVENTORY_CHANGE'), -m(500));
  assert.match(up.narration, /1,?500\.00/);
  validateMove(up, ctx, { mode: 'SYSTEM' });
  const down = buildInventoryCloseMove(base('STOCK'), { valueMilli: m(200), ledgerMilli: m(1000) })!;
  assert.equal(sumBy(down, 'INVENTORY_WAREHOUSE'), -m(800));
  assert.equal(sumBy(down, 'INVENTORY_CHANGE'), m(800));
  validateMove(down, ctx, { mode: 'SYSTEM' });
  assert.equal(buildInventoryCloseMove(base('STOCK'), { valueMilli: m(1000), ledgerMilli: m(1000) }), null);
});

test('حارس ثابت: الإقلاع يشغّل المجدول، والشركات ذات البداية النظيفة وحدها، وترتيب الإقفال في معاملة واحدة بعلامة اليوم', () => {
  const src = (...p: string[]) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8').replace(/\r\n/g, '\n');
  assert.match(src('index.ts'), /startLedgerDailyCloseScheduler\(\);/);
  const dc = src('services', 'gl', 'dailyClose.ts');
  assert.match(dc, /setupMethod: 'CLEAN', tenant: \{ accountingSuiteEnabled: true, accountingEnabled: true \}/, 'المربوطة بالمُرحِّل لا تُكرَّر');
  const close = dc.slice(dc.indexOf('export async function closeDay('), dc.indexOf('export async function dailyCloseTenants('));
  const order = ['acquirePostLock(tx, t.tenantId)', 'tx.opsMarker.findUnique(', 'loadBuildContext(tx, t.tenantId)', 'planDay(tx', 'postMove(tx, d', 'tx.opsMarker.create('];
  let last = -1;
  for (const n of order) { const i = close.indexOf(n, last + 1); assert.ok(i > last, n); last = i; }
  assert.match(dc, /process\.env\.LEDGER_DAILY_CLOSE === '0'/);
  assert.match(dc, /process\.env\.LEDGER_WORKER_ENABLED === '0'/);
  // رصيد كل عميل يُطابَق كل ليلة (صفوفٌ حُذفت بالتراجع عن استيراد لا تبقى في الدفاتر)، والخطأ ظاهر بإشعار وعلامة، والعملة تُفحص
  const plan = dc.slice(dc.indexOf('async function planDay('), dc.indexOf('export async function previewDailyCloseRange('));
  assert.match(plan, /dayRows\.push\(\.\.\.await customerResiduals\(/);
  assert.ok(plan.indexOf('customerResiduals(') < plan.indexOf('buildDailySalesMove('), 'الفروق تدخل قيد اليوم');
  assert.match(plan, /company\.currency !== ctx\.settings\.currency/);
  assert.match(dc, /type: 'LEDGER_DAILY_CLOSE_ERROR'/);
  assert.match(dc, /opsMarker\.deleteMany\(\{ where: \{ key: dailyErrorKey\(t\.tenantId\) \} \}\)/);
});

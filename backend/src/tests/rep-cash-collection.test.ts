import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { REP_COLLECTED_CASH_SALE, cashCollectedStamp } from '../services/repCashCollection';
import { COLLECTED_CASH_SALE } from '../services/paymentMethodsReport';

// «البيع النقدي تحصيلٌ لدى المندوب» (طلب المالك ١٠ نوفمبر ٢٠٢٦)
const SRC = path.join(__dirname, '..');
const read = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), 'utf8').replace(/\r\n/g, '\n');

test('الختم: فاتورة بيعٍ نقدي لمندوبٍ مفعَّلٍ له وحدها', () => {
  assert.deepEqual(cashCollectedStamp('CASH', { cashSaleCollected: true }), { cashCollectedByRep: true });
  assert.deepEqual(cashCollectedStamp('CASH', { cashSaleCollected: false }), {});
  assert.deepEqual(cashCollectedStamp('CASH', null), {});
  assert.deepEqual(cashCollectedStamp('CREDIT', { cashSaleCollected: true }), {});
  assert.deepEqual(cashCollectedStamp('RETURN', { cashSaleCollected: true }), {});
});

test('الشرط = النقدية المحصَّلة («طرق الدفع») + الختم — الإلغاء الإداري يُخرجها وما أبطلته الهيئة واحتُفظ بتحصيله يبقى', () => {
  assert.deepEqual(REP_COLLECTED_CASH_SALE, { AND: [COLLECTED_CASH_SALE, { cashCollectedByRep: true }] });
});

test('الختم يُكتب في مساري الإصدار (المرحلة الأولى والثانية)، والإشعار اليدويّ لا يُختم', () => {
  const p1 = read('routes', 'invoices.ts');
  assert.ok(p1.includes('...cashCollectedStamp(body.type, rep),'), 'المرحلة الأولى');
  assert.ok(p1.includes('cashSaleCollected: rep.cashSaleCollected === true,'), 'سياق المرحلة الثانية من صفّ المندوب');
  const p2 = read('routes', 'invoicesZatca.ts');
  assert.ok(p2.includes('...(!manual && cashCollectedStamp(ctx.body.type, { cashSaleCollected: ctx.cashSaleCollected })),'));
});

test('الرصيد في المواضع الثلاثة بالشرط نفسه وبقيد النطاق/الفريق نفسه للسندات', () => {
  const rc = read('routes', 'receipts.ts');
  const bal = rc.slice(rc.indexOf("router.get('/collection-balance'"), rc.indexOf("router.get('/:id'"));
  assert.ok(bal.includes("prisma.receipt.aggregate({ where: { tenantId: tid, salesRepId: repId, status: 'ACTIVE', ...docScope }"));
  assert.ok(bal.includes('prisma.invoice.aggregate({ where: { tenantId: tid, salesRepId: repId, AND: [REP_COLLECTED_CASH_SALE, docScope] }, _sum: { paidAmt: true } })'));
  assert.ok(bal.includes('const c = (collected._sum.amount ?? 0) + cash;'));

  const sr = read('routes', 'salesReps.ts');
  const fn = sr.slice(sr.indexOf('async function repCollection'), sr.indexOf("router.get('/:id/collection'"));
  assert.ok(fn.includes('prisma.invoice.aggregate({ where: { tenantId: tid, salesRepId: repId, AND: [REP_COLLECTED_CASH_SALE, teamWhere] }, _sum: { paidAmt: true } })'), 'repCollection بقيد الفريق');
  assert.ok(fn.includes('const c = (collected._sum.amount ?? 0) + cash;'));
  assert.ok(fn.includes("prisma.invoice.groupBy({ by: ['teamId'], where: { tenantId: tid, salesRepId: repId, teamId: { not: null }, AND: [REP_COLLECTED_CASH_SALE] }, _sum: { paidAmt: true } })"), 'custodyTeamsOf');
  assert.ok(fn.includes('for (const x of cs) if (x.teamId) bal.set(x.teamId, (bal.get(x.teamId) ?? 0) + Number(x._sum.paidAmt ?? 0));'));
});

test('الإعداد مطفأ افتراضاً ومكشوف للإدارة والمزامنة', () => {
  const sch = read('..', 'prisma', 'schema.prisma');
  assert.match(sch, /\n\s+cashSaleCollected Boolean @default\(false\)/);
  assert.match(sch, /\n\s+cashCollectedByRep Boolean @default\(false\)/);
  const sr = read('routes', 'salesReps.ts');
  assert.ok(sr.includes('cashSaleCollected: z.boolean().optional(),') && sr.includes('cashSaleCollected: true,'));
  const sync = read('services', 'apiSync.ts');
  assert.ok(sync.includes("'cashSaleCollected',") && sync.includes("'cashCollectedByRep',"));
});

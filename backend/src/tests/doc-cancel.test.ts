import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { CancelRefused, lockInvoiceForCancel, claimReceiptCancel, restoreAllocations } from '../services/docCancel';

/**
 * إلغاء الفاتورة والسند تحت القفل (مراجعة ٣٠ سبتمبر ٢٠٢٦، MD-5 وL8-1): طلبان متقاربان كانا يمرّان من فحصٍ سابقٍ
 * للمعاملة ويعكس كلٌّ منهما القيد. القسم الأول يختبر الدوالّ بمعاملة وهمية، والثاني حرّاسٌ نصّية على **مكان**
 * القفل في المسارات الثلاثة — فالمعاملات الوهمية لا تُظهر سباقاً، والخلل كان في ترتيب الفحص لا في حسابه.
 */

type Row = Record<string, unknown>;
function fakeTx(opts: { rows?: Row[]; receiptItems?: number; notes?: number; claimCount?: number } = {}) {
  const log: { sql: string[]; updates: Row[]; updateMany: Row[] } = { sql: [], updates: [], updateMany: [] };
  const tx = {
    $queryRaw: async (q: TemplateStringsArray, ..._v: unknown[]) => { log.sql.push(q.join('?')); return opts.rows ?? []; },
    receiptInvoice: { count: async () => opts.receiptItems ?? 0 },
    invoice: {
      count: async () => opts.notes ?? 0,
      update: async (a: Row) => { log.updates.push(a); return a; },
    },
    receipt: { updateMany: async (a: Row) => { log.updateMany.push(a); return { count: opts.claimCount ?? 1 }; } },
  };
  return { tx: tx as never, log };
}

const refuses = async (p: Promise<unknown>, re: RegExp) => {
  await assert.rejects(p, (e: unknown) => e instanceof CancelRefused && re.test((e as Error).message));
};

test('lockInvoiceForCancel: يقفل صفّ الفاتورة بشركتها FOR UPDATE ويمرّ على فاتورةٍ قابلةٍ للإلغاء', async () => {
  const { tx, log } = fakeTx({ rows: [{ status: 'CONFIRMED', type: 'CREDIT', paidAmt: 0 }] });
  await lockInvoiceForCancel(tx, 't1', 'inv-1');
  assert.equal(log.sql.length, 1);
  assert.match(log.sql[0], /FROM invoices WHERE id = \? AND "tenantId" = \? FOR UPDATE/);
});

test('lockInvoiceForCancel: كل فحصٍ يُعاد تحت القفل — ملغاة، أو محصَّلٌ منها، أو عليها سند، أو صدر عليها إشعار', async () => {
  await refuses(lockInvoiceForCancel(fakeTx({ rows: [{ status: 'CANCELLED', type: 'CASH', paidAmt: 0 }] }).tx, 't1', 'i'), /ملغاة مسبقا/);
  await refuses(lockInvoiceForCancel(fakeTx({ rows: [] }).tx, 't1', 'i'), /ملغاة مسبقا/);
  await refuses(lockInvoiceForCancel(fakeTx({ rows: [{ status: 'CONFIRMED', type: 'CREDIT', paidAmt: 5 }] }).tx, 't1', 'i'), /تم تحصيل جزء منها/);
  await refuses(lockInvoiceForCancel(fakeTx({ rows: [{ status: 'CONFIRMED', type: 'CREDIT', paidAmt: 0 }], receiptItems: 1 }).tx, 't1', 'i'), /مرتبطة بسند قبض/);
  await refuses(lockInvoiceForCancel(fakeTx({ rows: [{ status: 'CONFIRMED', type: 'CASH', paidAmt: 0 }], notes: 1 }).tx, 't1', 'i'), /إشعار دائن أو مدين/);
  // وسبب الإشعار موسوم ليعيد المسار ردّ ما قبل المعاملة نفسه (409 وبديل الإلغاء)
  await assert.rejects(lockInvoiceForCancel(fakeTx({ rows: [{ status: 'CONFIRMED', type: 'CASH', paidAmt: 0 }], notes: 1 }).tx, 't1', 'i'),
    (e: unknown) => e instanceof CancelRefused && e.reason === 'HAS_NOTES');
  // النقدية محصَّلة كاملةً بطبيعتها — الشرط على الآجلة وحدها كما في المسار
  await lockInvoiceForCancel(fakeTx({ rows: [{ status: 'CONFIRMED', type: 'CASH', paidAmt: 100 }] }).tx, 't1', 'i');
});

test('claimReceiptCancel: مقارنةٌ وتبديل مشروطان بالشركة وبأنه غير ملغى — الفائز وحده true', async () => {
  const win = fakeTx({ claimCount: 1 });
  assert.equal(await claimReceiptCancel(win.tx, 't1', 'r1'), true);
  assert.deepEqual(win.log.updateMany[0], { where: { id: 'r1', tenantId: 't1', status: { not: 'CANCELLED' } }, data: { status: 'CANCELLED' } });
  assert.equal(await claimReceiptCancel(fakeTx({ claimCount: 0 }).tx, 't1', 'r1'), false);
});

test('restoreAllocations: يقفل الفواتير بترتيب المعرّف ثمّ يكتب تحت القفل، ويجمع تخصيصين على الفاتورة نفسها', async () => {
  const { tx, log } = fakeTx({ rows: [{ id: 'a', paidAmt: 300, remainingAmt: 700 }, { id: 'b', paidAmt: 50.1, remainingAmt: 0 }] });
  await restoreAllocations(tx, 't1', [{ invoiceId: 'b', amount: 50.1 }, { invoiceId: 'a', amount: 100 }, { invoiceId: 'a', amount: 200 }]);
  assert.match(log.sql[0], /WHERE id = ANY\(\?::text\[\]\) AND "tenantId" = \?\s+ORDER BY id\s+FOR UPDATE/);
  const last = new Map(log.updates.map(u => [(u.where as Row).id, u.data as Row]));
  assert.deepEqual(last.get('a'), { paidAmt: 0, remainingAmt: 1000 }, 'التخصيص الثاني على الفاتورة نفسها يُحسب من الأول لا من القراءة');
  assert.deepEqual(last.get('b'), { paidAmt: 0, remainingAmt: 50.1 }, 'غبار الأعداد العائمة يُنظَّف');
});

test('restoreAllocations: بلا تخصيص لا استعلام، وفاتورةٌ غائبة (من شركة أخرى) لا تُكتب', async () => {
  const empty = fakeTx();
  await restoreAllocations(empty.tx, 't1', []);
  assert.equal(empty.log.sql.length, 0);
  const missing = fakeTx({ rows: [] });
  await restoreAllocations(missing.tx, 't1', [{ invoiceId: 'x', amount: 10 }]);
  assert.equal(missing.log.updates.length, 0);
});

// ═══════════ حرّاس نصّية على مكان القفل ═══════════

const read = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), 'src', ...p), 'utf8');
const handler = (src: string, head: string) => {
  const i = src.indexOf(head);
  assert.ok(i >= 0, `مسار غير موجود: ${head}`);
  return src.slice(i, src.indexOf('\n});', i));
};
const txBody = (h: string, open: string) => {
  const i = h.indexOf(open);
  assert.ok(i >= 0, 'لا معاملة');
  return h.slice(i + open.length);
};

test('حارس: إلغاء الفاتورة يقفل صفّها أول ما في المعاملة، قبل تحديث الحالة وعكس القيد، ويردّ الرفض 400', () => {
  const h = handler(read('routes', 'invoices.ts'), "router.patch('/:id/cancel'");
  const tx = txBody(h, 'prisma.$transaction(async tx => {');
  const lock = tx.indexOf('await lockInvoiceForCancel(tx, tid, invoice.id);');
  assert.ok(lock >= 0, 'لا قفل داخل المعاملة');
  assert.equal(tx.slice(0, lock).match(/await /g), null, 'عبارةٌ قبل القفل');
  assert.ok(tx.indexOf('tx.invoice.update(') > lock && tx.indexOf('reverseInvoiceInTx(') > lock);
  assert.match(h, /if \(err instanceof CancelRefused\) \{ res\.status\(400\)/);
  assert.match(h, /err instanceof CancelRefused && err\.reason === 'HAS_NOTES'[\s\S]*ZATCA_CANCEL_NOT_ALLOWED[\s\S]*cancelCreditablePayload/, 'الإشعار تحت القفل بردٍّ غير ردّ الحارس');
});

test('حارس: إلغاء السند يبدّل حالته بمقارنة أول ما في المعاملة، ولا قراءة فاتورة ثمّ كتابة مطلقة', () => {
  const h = handler(read('routes', 'receipts.ts'), "router.patch('/:id/cancel'");
  const tx = txBody(h, 'prisma.$transaction(async tx => {');
  const claim = tx.indexOf('if (!(await claimReceiptCancel(tx, tid, receipt.id))) throw new CancelRefused(');
  assert.ok(claim >= 0, 'لا مقارنة وتبديل');
  assert.equal(tx.slice(0, claim).match(/await /g), null, 'عبارةٌ قبل المقارنة');
  assert.ok(tx.indexOf('restoreAllocations(tx, tid, receipt.invoiceItems)') > claim);
  assert.ok(tx.indexOf('reverseReceiptEntries(') > claim);
  assert.doesNotMatch(tx, /tx\.receipt\.update\(|tx\.invoice\.findUnique\(/, 'بقي تحديثٌ غير مشروط أو قراءةٌ بلا قفل');
  assert.match(h, /if \(err instanceof CancelRefused\) \{ res\.status\(400\)/);
});

test('حارس: عكس دفعة الرابط — webhook مكرّر لا يعكس مرّتين، وقيد الاسترداد في الأمانات لا يسقط إن أُلغي السند يدوياً', () => {
  const p = read('services', 'paylink.ts');
  const fn = p.slice(p.indexOf('export async function reverseLinkPayment'), p.indexOf('export function startPaylinkScheduler'));
  // لا فرعَ قبل المعاملة يعلّم الرابط refunded بلا قيد REFUND (MD-8)
  assert.doesNotMatch(fn.slice(0, fn.indexOf('prisma.$transaction')), /status: 'refunded'/, 'فرعٌ قبل المعاملة يبدّل الرابط');
  const tx = txBody(fn, 'prisma.$transaction(async tx => {');
  const link = tx.indexOf("const linkClaim = await tx.customerPaymentLink.updateMany({ where: { id: link.id, status: 'paid' }, data: { status: 'refunded' } })");
  const refund = tx.indexOf('await postRefundEntry(tx,');
  const rcp = tx.indexOf('const receiptCancelled = await claimReceiptCancel(tx, link.tenantId, receipt.id);');
  assert.ok(link >= 0, 'لا مقارنة على الرابط');
  assert.equal(tx.slice(0, link).match(/await /g), null, 'عبارةٌ قبل المقارنة على الرابط');
  assert.ok(refund > link && refund < rcp, 'قيد REFUND مشروطٌ بإلغاء السند — يسقط إن أُلغي يدوياً فيُورَّد للشركة مالٌ رُدّ');
  const gated = tx.slice(rcp, tx.indexOf('await tx.notification.create'));
  assert.match(gated, /if \(receiptCancelled\) \{\s*await restoreAllocations\(tx, link\.tenantId, receipt\.invoiceItems\);\s*await reverseReceiptEntries\(/, 'عكس الذمّة غير مشروط بإلغاء السند');
  assert.doesNotMatch(tx, /tx\.receipt\.update\(|tx\.invoice\.findUnique\(|tx\.customerPaymentLink\.update\(/, 'بقي تحديثٌ غير مشروط');
});

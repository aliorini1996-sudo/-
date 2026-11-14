// «ربط الدفاتر» L4+L5 — المنفّذ A8 (المسارات التشغيلية بلا gl): الأجزاء الصرفة والنصّية.
//   • services/receiptCancelSource.ts (C11): التصنيف للعهدة يطابق المُرحِّل (receiptCustodyClass وD4)، و«سُلِّم؟»، والمقترح،
//     وقرار الكتابة (الحقل الصريح لكل شركة، والمقترح للمربوطة، والمندوب REP_CUSTODY، والإلكتروني لا شيء).
//   • services/invoiceVoid.ts (§4.4): ردّ متبقّي الأصل عند إبطال الإشعار الدائن بخانات العملة (الدينار الثالثة) لا بمنزلتين.
//   • services/apiSync.ts: عمودا مصدر الردّ ممنوعان من مزامنة السندات بسبب.
//   • الحارس: ملفاتي لا تستورد services/gl، وكتابة المصدر في الإلغاء قبل عكس القيود.
// لا قاعدة ولا شبكة.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  CANCEL_REFUND_SOURCES, CancelRefundRejected, RECEIPT_CANCEL_REFUND_INVALID, RECEIPT_CANCEL_REFUND_USER,
  cancelCustodyClass, cancelRefundDecision, cancelRefundOptionList, cancelRoutingFrom, receiptHandedOver, suggestCancelRefund,
} from '../services/receiptCancelSource';
import { receiptCustodyClass } from '../services/gl/custody';
import { linkedReceiptCustodyClass } from '../services/gl/builders/receipt';
import type { BuildContext, ReceiptRouting } from '../services/gl/types';
import { voidInvoiceInTx, type VoidTx } from '../services/invoiceVoid';
import { syncResource } from '../services/apiSync';

const SRC = path.join(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');

// ═══ التصنيف للعهدة: مرآة المُرحِّل حرفاً ═══

const METHODS = ['CASH', 'BANK_TRANSFER', 'POS', 'CHEQUE', 'ONLINE'] as const;
const ROUTINGS: Array<ReceiptRouting | null> = [
  null,
  {},
  { CASH: 'CUSTODY', BANK_TRANSFER: 'CUSTODY', POS: 'CUSTODY', CHEQUE: 'CUSTODY' },
  { CASH: 'CUSTODY', CHEQUE: 'DIRECT', BANK_TRANSFER: 'DIRECT' },
  { CASH: 'DIRECT', POS: 'CUSTODY', CHEQUE: 'CUSTODY' },
];

test('cancelCustodyClass = receiptCustodyClass لغير المربوطة، وlinkedReceiptCustodyClass (D4) للمربوطة — كل طريقة × مندوب × توجيه × بطاقة', () => {
  let n = 0;
  for (const method of METHODS) {
    for (const rep of ['rep-1', null]) {
      for (const routing of ROUTINGS) {
        // عمود JSON يمرّ بالقارئ نفسه (والقيمة غير المعروفة تُسقط)
        const parsed = cancelRoutingFrom(routing === null ? null : { ...routing, ONLINE: 'CUSTODY', CASH_X: 'CUSTODY' });
        const today = receiptCustodyClass({ paymentMethod: method, salesRepId: rep, routing });
        assert.equal(cancelCustodyClass({ paymentMethod: method, salesRepId: rep, routing: parsed, linked: false }), today, `${method}/${rep}/${JSON.stringify(routing)}`);
        for (const card of [false, true]) {
          const ctx = { settings: { linkedPosting: true, receiptRouting: routing } } as unknown as BuildContext;
          const want = linkedReceiptCustodyClass({ paymentMethod: method, salesRepId: rep, cardPaymentId: card ? 'cp-1' : null }, ctx);
          assert.equal(cancelCustodyClass({ paymentMethod: method, salesRepId: rep, routing: parsed, linked: true, card }), want, `linked ${method}/${rep}/${card}`);
          n++;
        }
      }
    }
  }
  assert.equal(n, METHODS.length * 2 * ROUTINGS.length * 2);
  // D4 صراحةً: التحويل ونقطة البيع لا يدخلان العهدة في المربوطة ولو وُجّها إليها، والبطاقة أبداً
  const all = { CASH: 'CUSTODY', BANK_TRANSFER: 'CUSTODY', POS: 'CUSTODY', CHEQUE: 'CUSTODY' } as const;
  assert.equal(cancelCustodyClass({ paymentMethod: 'BANK_TRANSFER', salesRepId: 'r', routing: all, linked: true }), 'OUTSIDE');
  assert.equal(cancelCustodyClass({ paymentMethod: 'POS', salesRepId: 'r', routing: all, linked: true }), 'OUTSIDE');
  assert.equal(cancelCustodyClass({ paymentMethod: 'CASH', salesRepId: 'r', routing: all, linked: true, card: true }), 'OUTSIDE');
  assert.equal(cancelCustodyClass({ paymentMethod: 'CHEQUE', salesRepId: 'r', routing: all, linked: true }), 'CUSTODY');
});

// ═══ «سُلِّم؟» بالملّي ═══

test('receiptHandedOver: استلامٌ بعد السند ومعلَّق المندوب أقلّ من المبلغ — بالملّي نصف-لأعلى، بلا غبار عائم', () => {
  assert.equal(receiptHandedOver({ laterSettlement: false, repOutstanding: 0, amount: 500 }), false, 'لا استلام بعد السند');
  assert.equal(receiptHandedOver({ laterSettlement: true, repOutstanding: null, amount: 500 }), false);
  // E5.7: سند ٥٠٠ ثم استلامٌ ٥٠٠ ⇒ المعلَّق صفر < ٥٠٠
  assert.equal(receiptHandedOver({ laterSettlement: true, repOutstanding: 0, amount: 500 }), true);
  assert.equal(receiptHandedOver({ laterSettlement: true, repOutstanding: 499.999, amount: 500 }), true);
  assert.equal(receiptHandedOver({ laterSettlement: true, repOutstanding: 500, amount: 500 }), false, 'ما في يده يكفي');
  // 0.1 + 0.2 = 0.30000000000000004 ≥ 0.3 (لا يُحسب «أقل» بغبار عائم)
  assert.equal(receiptHandedOver({ laterSettlement: true, repOutstanding: 0.1 + 0.2, amount: 0.3 }), false);
  // الدينار: الفلس الثالث يُحترم
  assert.equal(receiptHandedOver({ laterSettlement: true, repOutstanding: 1.098, amount: 1.099 }), true);
  assert.equal(receiptHandedOver({ laterSettlement: true, repOutstanding: -20, amount: 5 }), true);
});

// ═══ المقترح ═══

test('suggestCancelRefund: غير مسلَّم ⇒ REP_CUSTODY؛ مسلَّم لمستخدمٍ تكفي عهدته ⇒ USER_CUSTODY؛ تحويلٌ ⇒ BANK؛ وإلا MAIN_CASH؛ OUTSIDE ⇒ METHOD؛ ONLINE ⇒ لا شيء', () => {
  const base = { custodyClass: 'CUSTODY' as const, handedOver: true, lastSettlement: null, receiverOutstanding: null, amount: 500 };
  assert.deepEqual(suggestCancelRefund({ ...base, handedOver: false }), { suggested: 'REP_CUSTODY', userId: null });
  assert.deepEqual(suggestCancelRefund({ ...base, lastSettlement: { receivedByUserId: null, method: 'CASH' } }), { suggested: 'MAIN_CASH', userId: null });
  assert.deepEqual(suggestCancelRefund({ ...base, lastSettlement: { receivedByUserId: 'u-1', method: 'CASH' }, receiverOutstanding: 800 }),
    { suggested: 'USER_CUSTODY', userId: 'u-1' });
  assert.deepEqual(suggestCancelRefund({ ...base, lastSettlement: { receivedByUserId: 'u-1', method: 'CHEQUE' }, receiverOutstanding: 500 }),
    { suggested: 'USER_CUSTODY', userId: 'u-1' }, 'تساوي العهدة والمبلغ يكفي');
  assert.deepEqual(suggestCancelRefund({ ...base, lastSettlement: { receivedByUserId: 'u-1', method: 'CASH' }, receiverOutstanding: 300 }),
    { suggested: 'MAIN_CASH', userId: null }, 'عهدةٌ لا تكفي ⇒ الصندوق');
  assert.deepEqual(suggestCancelRefund({ ...base, lastSettlement: { receivedByUserId: 'u-1', method: 'BANK_TRANSFER' }, receiverOutstanding: 900 }),
    { suggested: 'BANK', userId: null }, 'OD5: التحويل إلى البنك لا إلى يد المستلِم');
  assert.deepEqual(suggestCancelRefund({ ...base, lastSettlement: { receivedByUserId: null, method: 'POS' } }), { suggested: 'BANK', userId: null });
  assert.deepEqual(suggestCancelRefund({ ...base, custodyClass: 'OUTSIDE' }), { suggested: 'METHOD', userId: null });
  assert.deepEqual(suggestCancelRefund({ ...base, custodyClass: 'ONLINE' }), { suggested: null, userId: null });
});

test('cancelRefundOptionList: CUSTODY بعهدة آخر مستلِم إن وُجد، وOUTSIDE بالطريقة، والإلكتروني بلا خيارات — والقيم من المصادر الخمسة وحدها', () => {
  const recv = { userId: 'u-1', name: 'سارة', outstanding: 800 };
  assert.deepEqual(cancelRefundOptionList('CUSTODY', recv).map((o) => o.value), ['REP_CUSTODY', 'USER_CUSTODY', 'MAIN_CASH', 'BANK']);
  assert.deepEqual(cancelRefundOptionList('CUSTODY', recv)[1], { value: 'USER_CUSTODY', label: 'من عهدة مستخدم الشركة', userId: 'u-1', userName: 'سارة', userOutstanding: 800 });
  assert.deepEqual(cancelRefundOptionList('CUSTODY', null).map((o) => o.value), ['REP_CUSTODY', 'MAIN_CASH', 'BANK']);
  assert.deepEqual(cancelRefundOptionList('OUTSIDE', recv).map((o) => o.value), ['METHOD', 'MAIN_CASH', 'BANK']);
  assert.deepEqual(cancelRefundOptionList('ONLINE', recv), []);
  for (const cls of ['CUSTODY', 'OUTSIDE'] as const) {
    for (const o of cancelRefundOptionList(cls, recv)) assert.ok((CANCEL_REFUND_SOURCES as readonly string[]).includes(o.value));
  }
});

// ═══ قرار الكتابة ═══

test('cancelRefundDecision: بلا جسم وغير مربوطة ⇒ لا كتابة (كاليوم)؛ مربوطة ⇒ المقترح؛ الحقل الصريح لكل شركة؛ المندوب REP_CUSTODY؛ الإلكتروني لا شيء', () => {
  const d = (body: unknown, linked: boolean, role = 'ADMIN', paymentMethod = 'CASH') => cancelRefundDecision({ body, role, paymentMethod, linked });
  for (const body of [undefined, null, {}, { refundFrom: null }, { refundFrom: '' }, { other: 1 }, [], 'x']) {
    assert.deepEqual(d(body, false), { kind: 'NONE' }, JSON.stringify(body));
    assert.deepEqual(d(body, true), { kind: 'SUGGEST' }, JSON.stringify(body));
  }
  // الحقل الصريح — لكل شركة (الاستثناء (ج))
  for (const linked of [false, true]) {
    assert.deepEqual(d({ refundFrom: 'MAIN_CASH' }, linked), { kind: 'WRITE', write: { cancelRefundFrom: 'MAIN_CASH', cancelRefundUserId: null } });
    assert.deepEqual(d({ refundFrom: 'BANK', refundFromUserId: 'u-9' }, linked), { kind: 'WRITE', write: { cancelRefundFrom: 'BANK', cancelRefundUserId: null } }, 'المستخدم لغير USER_CUSTODY يُهمل');
    assert.deepEqual(d({ refundFrom: 'USER_CUSTODY', refundFromUserId: ' u-1 ' }, linked), { kind: 'WRITE', write: { cancelRefundFrom: 'USER_CUSTODY', cancelRefundUserId: 'u-1' } });
    assert.throws(() => d({ refundFrom: 'USER_CUSTODY' }, linked), (e: unknown) => e instanceof CancelRefundRejected && e.code === RECEIPT_CANCEL_REFUND_USER && e.status === 400);
    assert.throws(() => d({ refundFrom: 'USER_CUSTODY', refundFromUserId: '  ' }, linked), (e: unknown) => e instanceof CancelRefundRejected && e.code === RECEIPT_CANCEL_REFUND_USER);
    assert.throws(() => d({ refundFrom: 'SAFE' }, linked), (e: unknown) => e instanceof CancelRefundRejected && e.code === RECEIPT_CANCEL_REFUND_INVALID);
  }
  // المندوب: عهدته دائماً — يُكتب حين يأتي الحقل أو الشركة مربوطة
  assert.deepEqual(d({ refundFrom: 'MAIN_CASH' }, false, 'SALES_REP'), { kind: 'WRITE', write: { cancelRefundFrom: 'REP_CUSTODY', cancelRefundUserId: null } });
  assert.deepEqual(d(undefined, true, 'SALES_REP'), { kind: 'WRITE', write: { cancelRefundFrom: 'REP_CUSTODY', cancelRefundUserId: null } });
  assert.deepEqual(d(undefined, false, 'SALES_REP'), { kind: 'NONE' });
  // الإلكتروني: لا يقبل مصدراً ولو صريحاً أو مربوطاً
  for (const linked of [false, true]) {
    assert.deepEqual(d({ refundFrom: 'MAIN_CASH' }, linked, 'ADMIN', 'ONLINE'), { kind: 'NONE' });
    assert.deepEqual(d({ refundFrom: 'SAFE' }, linked, 'ADMIN', 'ONLINE'), { kind: 'NONE' });
  }
});

// ═══ §4.4: invoiceVoid بخانات العملة ═══

interface VoidFake { tx: VoidTx; executes: unknown[][]; updates: Array<{ where: unknown; data: Record<string, unknown> }> }

/** إشعار دائن (المرحلة الثانية) على أصلٍ آجل — معاملة مزيّفة: $queryRaw يقرأ الإشعار، و$executeRaw اختياري (مسار SQL أو مسار القراءة) */
function voidFake(o: { noteTotal: number; original: { total: number; paidAmt: number; remainingAmt: number }; withExecute: boolean }): VoidFake {
  const executes: unknown[][] = [];
  const updates: VoidFake['updates'] = [];
  const note = {
    id: 'cn-1', tenantId: 't1', number: 'CN-1', status: 'CONFIRMED', type: 'RETURN', zatcaPhase: 2, invoiceSubtype: '01',
    einvoiceStatus: null, customerId: 'c-1', total: o.noteTotal, documentKind: 'CREDIT_NOTE', originalInvoiceId: 'inv-1',
  };
  const tx: Record<string, unknown> = {
    $queryRaw: async (strings: TemplateStringsArray) => ([...strings].join('?').includes('FROM invoices') ? [note] : []),
    invoice: {
      findUnique: async (a: { where: { id: string } }) => (a.where.id === 'inv-1' ? { id: 'inv-1', ...o.original } : null),
      update: async (a: { where: unknown; data: Record<string, unknown> }) => { updates.push(a); return {}; },
    },
    accountEntry: { aggregate: async () => ({ _sum: { debit: 0, credit: 0 } }), create: async () => ({}) },
    customer: { update: async () => ({}) },
    notification: { create: async () => ({}) },
  };
  if (o.withExecute) tx.$executeRaw = async (_s: TemplateStringsArray, ...vals: unknown[]) => { executes.push(vals); return 1; };
  return { tx: tx as unknown as VoidTx, executes, updates };
}

const voidInput = { tenantId: 't1', invoiceId: 'cn-1', subtype: '01' as const, reason: 'REJECTED' as const, documentId: 'd-1', at: new Date('2026-11-14T10:00:00Z') };

test('§4.4 invoiceVoid: إبطال إشعار دائن بالدينار (١٠٫١٢٥) يردّ ١٠٫١٢٥ لا ١٠٫١٣ — في مسار SQL وفي مسار القراءة', async () => {
  const sql = voidFake({ noteTotal: 10.125, original: { total: 50, paidAmt: 0, remainingAmt: 39.875 }, withExecute: true });
  const out = await voidInvoiceInTx(sql.tx, voidInput);
  assert.equal(out.voided, true);
  assert.equal(sql.executes.length, 1, 'تحديث المتبقّي بـSQL واحد');
  assert.ok(sql.executes[0].includes(10.125), `المبلغ الممرَّر: ${JSON.stringify(sql.executes[0])}`);
  assert.ok(!sql.executes[0].includes(10.13), 'تقريبٌ لمنزلتين يُسقط الفلس الثالث');

  const fake = voidFake({ noteTotal: 10.125, original: { total: 50, paidAmt: 0, remainingAmt: 39.875 }, withExecute: false });
  await voidInvoiceInTx(fake.tx, voidInput);
  const rem = fake.updates.find((u) => (u.where as { id?: string }).id === 'inv-1');
  assert.ok(rem, 'لم يُحدَّث متبقّي الأصل');
  assert.equal(rem!.data.remainingAmt, 50, '39.875 + 10.125 = 50 تماماً (والسقف total − paidAmt)');
  // ومبلغٌ لا يصل السقف: الخانة الثالثة باقية في الكتابة (التقريب القديم لمنزلتين: 1.00 ثم 21.00 — يضيع ٧ فلوس)
  const partial = voidFake({ noteTotal: 1.003, original: { total: 50, paidAmt: 10, remainingAmt: 20.004 }, withExecute: false });
  await voidInvoiceInTx(partial.tx, voidInput);
  assert.equal(partial.updates.find((u) => (u.where as { id?: string }).id === 'inv-1')!.data.remainingAmt, 21.007);
});

test('§4.4 invoiceVoid: الريال لا يتغيّر (١١٥٫٠٠ ⇒ ١١٥)، والسقف وصفر الإشعار كما كانا', async () => {
  const sar = voidFake({ noteTotal: 115, original: { total: 230, paidAmt: 0, remainingAmt: 115 }, withExecute: false });
  await voidInvoiceInTx(sar.tx, voidInput);
  assert.equal(sar.updates.find((u) => (u.where as { id?: string }).id === 'inv-1')!.data.remainingAmt, 230);
  // السقف: لا يتجاوز total − paidAmt (سندٌ التُزم بينهما)
  const capped = voidFake({ noteTotal: 115, original: { total: 230, paidAmt: 200, remainingAmt: 0 }, withExecute: false });
  await voidInvoiceInTx(capped.tx, voidInput);
  assert.equal(capped.updates.find((u) => (u.where as { id?: string }).id === 'inv-1')!.data.remainingAmt, 30);
  // إشعارٌ صفري لا يردّ شيئاً
  const zero = voidFake({ noteTotal: 0, original: { total: 230, paidAmt: 0, remainingAmt: 115 }, withExecute: true });
  await voidInvoiceInTx(zero.tx, voidInput);
  assert.equal(zero.executes.length, 0);
  const src = read('services/invoiceVoid.ts');
  const fn = src.slice(src.indexOf('async function restoreOriginalRemaining'), src.indexOf('export interface VoidInvoiceInput'));
  assert.doesNotMatch(fn, /Math\.round\(/, 'تقريبٌ لمنزلتين باقٍ في ردّ المتبقّي');
  assert.equal((fn.match(/clean\(/g) ?? []).length, 2, 'clean في الموضعين: amount وnext');
});

// ═══ apiSync ═══

test('apiSync: cancelRefundFrom وcancelRefundUserId ممنوعان من مزامنة السندات بسببٍ مكتوب، وغير مسموحين في select', () => {
  const r = syncResource('receipts')!;
  for (const c of ['cancelRefundFrom', 'cancelRefundUserId']) {
    assert.ok(c in r.denied, `${c} غير مصنَّف`);
    assert.ok(r.denied[c].length > 5, `${c} بلا سبب`);
    assert.equal(c in r.select, false, `${c} مسموح وممنوع معاً`);
  }
  assert.equal(r.denied.cancelRefundFrom, 'داخلي للدفاتر المربوطة: مصدر ردّ المال عند إلغاء السند');
  assert.equal(r.denied.cancelRefundUserId, 'داخلي للدفاتر المربوطة');
  // تغطية أعمدة Receipt كما يفحصها api-sync.test.ts — ما يبقى غير مصنَّف أعمدة L1 وحدها (deletedSalesRepId، يصنّفها دمج L1)
  const s = read('../prisma/schema.prisma');
  const start = s.indexOf('model Receipt {');
  const scalar = new Set(['String', 'Int', 'Float', 'Boolean', 'DateTime', 'Json', 'BigInt', 'Decimal', 'Bytes']);
  const cols = s.slice(start, s.indexOf('\n}', start)).split('\n').slice(1)
    .map((l) => /^\s+(\w+)\s+(\w+)(\[\])?\??/.exec(l)).filter((m): m is RegExpExecArray => !!m && scalar.has(m[2])).map((m) => m[1]);
  assert.ok(cols.includes('cancelRefundFrom') && cols.includes('cancelRefundUserId'));
  const unclassified = cols.filter((c) => !(c in r.select) && !(c in r.denied));
  assert.deepEqual(unclassified.filter((c) => c !== 'deletedSalesRepId'), [], 'أعمدة سندٍ غير مصنّفة');
});

// ═══ الحارس النصّي ═══

test('ملفات A8 لا تستورد services/gl ولا تلمس جداوله، والمسارات تستورد services/booksMode', () => {
  for (const f of ['routes/invoices.ts', 'routes/receipts.ts', 'services/invoiceVoid.ts', 'services/receiptCancelSource.ts', 'services/apiSync.ts']) {
    const s = read(f);
    assert.doesNotMatch(s, /from\s+['"][^'"]*services\/gl[^'"]*['"]/, `${f} يستورد services/gl`);
    assert.doesNotMatch(s, /from\s+['"]\.\.?\/gl[/'"]/, `${f} يستورد gl نسبياً`);
    assert.doesNotMatch(s, /glSourceEvent|glMove|glSyncCursor/, `${f} يلمس جداول الدفاتر`);
  }
  assert.match(read('routes/receipts.ts'), /from '\.\.\/services\/booksMode'/);
  assert.match(read('routes/invoices.ts'), /from '\.\.\/services\/booksMode'/);
  assert.match(read('services/receiptCancelSource.ts'), /from '\.\/booksMode'/);
});

test('PATCH /:id/cancel: المطالبة بالسند ثم كتابة مصدر الردّ ثم إعادة التخصيص ثم عكس القيود — في معاملة واحدة، والقرار قبلها', () => {
  const src = read('routes/receipts.ts');
  const i = src.indexOf("router.patch('/:id/cancel'");
  const body = src.slice(i, src.indexOf('\n});', i));
  const tx = body.indexOf('prisma.$transaction(async tx =>');
  assert.ok(tx > 0);
  const resolve = body.indexOf('resolveCancelRefund(');
  assert.ok(resolve > 0 && resolve < tx, 'القرار (والقراءات) قبل المعاملة');
  const order = ['claimReceiptCancel(tx', 'applyCancelRefundInTx(tx', 'restoreAllocations(tx', 'reverseReceiptEntries(tx'];
  let pos = tx;
  for (const n of order) {
    const at = body.indexOf(n, pos);
    assert.ok(at > pos, `«${n}» مفقود أو خارج الترتيب`);
    pos = at;
  }
  assert.match(body, /CancelRefundRejected/, 'الرفض برمزه لا 500');
});

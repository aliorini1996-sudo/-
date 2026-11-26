// «أرشيف العميل — السجل الزمني» (طلب المالك ٢٦ نوفمبر ٢٠٢٦): أحداث المستندات المالية للعميل.
//
// يُثبت هنا: ١) بُناة الأحداث (الإصدار بنوعه، الحدث على مستند قائم، السند وتخصيصه، البطاقة، رابط الدفع) — حدثٌ دلاليّ واحد
// بمرجعه ورقمه ومبلغه وبلا أسرار. ٢) الكتابة بمقبض المعاملة نفسها، وتخطّي المقابض المزيّفة القديمة بلا جدول السجل، وإسقاط الحدث
// بلا عميل. ٣) الفاعل من الطلب لا يرمي أبداً. ٤) إبطال الفاتورة (رفض الهيئة/السحب) يكتب حدثه داخل معاملة الإبطال نفسها، بفاعل
// النظام افتراضاً وبفاعل الطلب للسحب. ٥) حرّاس نصّية: كل مسار مالي يكتب حدثه داخل معاملته — لا بعد الالتزام.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  cardPaymentEventInput, cardPaymentMeta, customerMeta, docActivityMeta, invoiceEventInput, invoiceIssuedInput, issuedActionOf,
  paylinkEventInput, receiptEventInput, recordDocActivity, SYSTEM_META,
} from '../services/customerActivityDocs';
import type { AuthRequest } from '../types';

const SRC = path.join(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');

// لا عميل Prisma حقيقي: خدمة الإبطال تُحمَّل ديناميكياً بعد حقن بديلٍ خامل (المعاملة تُمرَّر إليها صراحةً)
{
  const id = require.resolve(path.join(SRC, 'config/database'));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, default: {} }, children: [], paths: [] } as unknown as NodeJS.Module;
}

const reqOf = (user: Record<string, unknown> | undefined, headers: Record<string, string> = {}): AuthRequest =>
  ({ user, headers } as unknown as AuthRequest);

/** مقبضٌ يحمل جدول السجل ويسجّل ما كُتب */
function activityDb() {
  const rows: Record<string, unknown>[][] = [];
  return { rows, db: { customerActivity: { createMany: async (a: { data: Record<string, unknown>[] }) => { rows.push(a.data); return { count: a.data.length }; } } } };
}

// ═══ (١) البُناة ═══

test('issuedActionOf: الإشعاران بنوعهما، والمرتجع، وما سواه فاتورة بيع', () => {
  assert.equal(issuedActionOf({ type: 'CASH' }), 'INVOICE_ISSUED');
  assert.equal(issuedActionOf({ type: 'CREDIT', documentKind: 'INVOICE' }), 'INVOICE_ISSUED');
  assert.equal(issuedActionOf({ type: 'RETURN' }), 'RETURN_ISSUED');
  assert.equal(issuedActionOf({ type: 'RETURN', documentKind: 'CREDIT_NOTE' }), 'CREDIT_NOTE_ISSUED');
  assert.equal(issuedActionOf({ type: 'CREDIT', documentKind: 'DEBIT_NOTE' }), 'DEBIT_NOTE_ISSUED');
});

test('invoiceIssuedInput: المرجع ورقمه ومبلغه، ونوع الدفع وعدد البنود والضريبة — والحدث يغلبه المستدعي', () => {
  const meta = { actor: { kind: 'REP' as const, id: 'rep-1', name: 'أحمد' }, source: 'rep' };
  const inv = { id: 'inv-1', number: 'INV-2611-0001', customerId: 'c-1', type: 'CREDIT', total: 115, taxAmt: 15, items: [{}, {}], paymentPlan: 'INSTALLMENT', installments: [{}, {}, {}] };
  const at = new Date('2026-11-26T08:00:00Z');
  const a = invoiceIssuedInput({ tenantId: 't-1', meta, invoice: inv, at, data: { offline: true, empty: '', nil: null } });
  assert.equal(a.action, 'INVOICE_ISSUED');
  assert.deepEqual([a.tenantId, a.customerId, a.refType, a.refId, a.refNo, a.amount, a.source], ['t-1', 'c-1', 'INVOICE', 'inv-1', 'INV-2611-0001', 115, 'rep']);
  assert.deepEqual(a.actor, meta.actor);
  assert.equal(a.at, at);
  assert.deepEqual(a.data, { paymentType: 'CREDIT', total: 115, taxTotal: 15, itemsCount: 2, paymentPlan: 'INSTALLMENT', installmentsCount: 3, offline: true });
  // المرتجع: سببه وعودته للمخزون، ولا «نوع دفع»
  const r = invoiceIssuedInput({ tenantId: 't-1', meta, invoice: { id: 'r-1', number: 'RET-1', customerId: 'c-1', type: 'RETURN', total: 20, returnReason: 'DAMAGED', returnToStock: false } });
  assert.equal(r.action, 'RETURN_ISSUED');
  assert.deepEqual(r.data, { total: 20, returnReason: 'DAMAGED', returnToStock: false });
  assert.equal('at' in r, false, 'بلا لحظة جهاز ⇒ لحظة الكتابة (افتراضيّ الجدول)');
  // مرتجعٌ صدر إشعاراً دائناً في المرحلة الثانية: «مرتجع» في السجل بقرار المستدعي
  const n = invoiceIssuedInput({ tenantId: 't-1', meta: { ...meta, action: 'RETURN_ISSUED' }, invoice: { id: 'n-1', customerId: 'c-1', type: 'RETURN', documentKind: 'CREDIT_NOTE', total: 5, noteReason: 'تالف', billingReference: 'INV-9' } });
  assert.equal(n.action, 'RETURN_ISSUED');
  assert.deepEqual(n.data, { documentKind: 'CREDIT_NOTE', total: 5, reason: 'تالف', originalInvoiceNo: 'INV-9' });
});

test('invoiceEventInput وreceiptEventInput: حدثٌ على مستند قائم، والسند بتخصيصه وما سدّده كاملاً — بلا صور', () => {
  const e = invoiceEventInput({ tenantId: 't', action: 'INVOICE_CANCELLED', meta: SYSTEM_META, invoice: { id: 'i', number: 'INV-1', customerId: 'c', type: 'CASH', total: 10 }, data: { reason: 'خطأ' } });
  assert.deepEqual([e.action, e.refType, e.refId, e.refNo, e.amount, e.actor.kind, e.source], ['INVOICE_CANCELLED', 'INVOICE', 'i', 'INV-1', 10, 'SYSTEM', 'system']);
  assert.deepEqual(e.data, { invoiceType: 'CASH', reason: 'خطأ' });
  const r = receiptEventInput({
    tenantId: 't', action: 'RECEIPT_ISSUED', meta: SYSTEM_META,
    receipt: { id: 'r', number: 'RC-1', customerId: 'c', amount: 300, paymentMethod: 'CHEQUE', chequeNumber: '778', bankName: 'الراجحي', notes: 'دفعة' },
    allocations: [{ invoiceId: 'i1', amount: 100, settled: true }, { invoiceId: 'i2', amount: 200, settled: false }],
    data: { photosCount: 2 },
  });
  assert.deepEqual([r.refType, r.refId, r.refNo, r.amount], ['RECEIPT', 'r', 'RC-1', 300]);
  assert.deepEqual(r.data, {
    paymentMethod: 'CHEQUE', chequeNumber: '778', bankName: 'الراجحي', note: 'دفعة',
    allocations: [{ invoiceId: 'i1', amount: 100, settled: true }, { invoiceId: 'i2', amount: 200 }], invoicesCount: 2, photosCount: 2,
  });
});

test('البطاقة ورابط الدفع: المرجع العملية/الرابط ورقمه رقم الفاتورة، والفاعل من بدأها، والعميل الدافع باسمه', () => {
  assert.deepEqual(cardPaymentMeta({ createdById: 'adm', salesRepId: 'rep' }).actor, { kind: 'ADMIN', id: 'adm', name: null });
  assert.deepEqual(cardPaymentMeta({ salesRepId: 'rep', salesRep: { name: 'سالم' } }).actor, { kind: 'REP', id: 'rep', name: 'سالم' });
  assert.equal(cardPaymentMeta({}).actor.kind, 'SYSTEM');
  const c = cardPaymentEventInput({
    action: 'CARD_PAYMENT_FAILED', meta: SYSTEM_META,
    payment: { id: 'cp', tenantId: 't', customerId: 'c', invoiceId: 'i', amount: 50, reference: 'INV-7' }, data: { status: 'declined', reason: 'x'.repeat(400) },
  });
  assert.deepEqual([c.refType, c.refId, c.refNo, c.amount], ['CARD_PAYMENT', 'cp', 'INV-7', 50]);
  assert.equal((c.data as { reason: string }).reason.length, 300, 'السبب مقصوص');
  const p = paylinkEventInput({
    action: 'PAYLINK_PAID', meta: customerMeta('مؤسسة النور'), link: { id: 'pl', tenantId: 't', customerId: 'c', invoiceId: 'i', amount: 99 },
    invoiceNo: 'INV-8', amount: 100, data: { receiptNo: 'RC-9' },
  });
  assert.deepEqual([p.refType, p.refId, p.refNo, p.amount, p.actor.kind, p.actor.name, p.source], ['PAYLINK', 'pl', 'INV-8', 100, 'CUSTOMER', 'مؤسسة النور', 'public']);
  assert.deepEqual(p.data, { invoiceId: 'i', invoiceNo: 'INV-8', receiptNo: 'RC-9' });
});

// ═══ (٢) الكتابة ═══

test('recordDocActivity: يكتب بمقبض المعاملة، ويتخطّى المقبض المزيّف بلا جدول السجل، ويُسقط الحدث بلا عميل', async () => {
  const { rows, db } = activityDb();
  const ok = invoiceEventInput({ tenantId: 't', action: 'INVOICE_UPDATED', meta: SYSTEM_META, invoice: { id: 'i', customerId: 'c', total: 1 } });
  await recordDocActivity(db, [ok, null, { ...ok, customerId: '' }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].length, 1);
  assert.equal(rows[0][0].action, 'INVOICE_UPDATED');
  assert.equal(rows[0][0].actorKind, 'SYSTEM');
  assert.equal(rows[0][0].refType, 'INVOICE');
  // مقبضٌ قديم بلا الجدول (معاملات الاختبارات المزيّفة) — لا رمي ولا كتابة
  await recordDocActivity({ invoice: {} }, ok);
  await recordDocActivity(null, ok);
  await recordDocActivity(db, []);
  assert.equal(rows.length, 1);
  // خطأ القاعدة يصعد فيُلغي معاملة المستند (لا مستند بلا أثره)
  const failing = { customerActivity: { createMany: async () => { throw new Error('db down'); } } };
  await assert.rejects(recordDocActivity(failing, ok), /db down/);
});

// ═══ (٣) الفاعل ═══

test('docActivityMeta: المندوب والإداري والمفتاح وجلسة المالك والموظف — ولا يرمي لطلبٍ بلا هوية', () => {
  assert.deepEqual(docActivityMeta(reqOf({ id: 'r1', role: 'SALES_REP', name: 'أحمد' })), { actor: { kind: 'REP', id: 'r1', name: 'أحمد' }, source: 'rep' });
  assert.deepEqual(docActivityMeta(reqOf({ id: 'a1', role: 'ADMIN', name: 'منى' })).actor, { kind: 'ADMIN', id: 'a1', name: 'منى' });
  assert.equal(docActivityMeta(reqOf({ id: 'a1', role: 'ADMIN', name: 'منى' }, { 'x-fs-client': 'm' })).source, 'm');
  const api = docActivityMeta(reqOf({ id: 'a1', role: 'ADMIN', name: 'منى', apiKeyId: 'k1' }));
  assert.equal(api.actor.kind, 'API');
  assert.equal(api.actor.id, 'k1');
  assert.equal(api.source, 'api');
  assert.equal(docActivityMeta(reqOf({ id: 'a1', role: 'ADMIN', name: 'مدير الشركة', impersonated: true, by: 'own-1', byKind: 'OWNER' })).actor.kind, 'OWNER');
  assert.equal(docActivityMeta(reqOf({ id: 'a1', role: 'ADMIN', name: 'x', impersonated: true, by: 'st-1', byKind: 'STAFF' })).actor.kind, 'STAFF');
  assert.equal(docActivityMeta(reqOf(undefined)).actor.kind, 'SYSTEM');
  assert.equal(docActivityMeta(null as unknown as AuthRequest).actor.kind, 'SYSTEM');
  assert.equal(docActivityMeta(reqOf({ id: 'r1', role: 'SALES_REP', name: 'x' }), 'RETURN_ISSUED').action, 'RETURN_ISSUED');
});

// ═══ (٤) الإبطال داخل معاملته ═══

test('voidInvoiceInTx: الإبطال يكتب INVOICE_VOIDED في معاملة الإبطال — النظام لرفض الهيئة، وفاعل الطلب للسحب', async () => {
  const { voidInvoiceInTx } = await import('../services/invoiceVoid');
  const order: string[] = [];
  const rows: Record<string, unknown>[] = [];
  const invoiceRow = {
    id: 'inv-1', tenantId: 't-1', number: 'INV-2611-0009', status: 'CONFIRMED', type: 'CREDIT', zatcaPhase: 2, invoiceSubtype: '01',
    einvoiceStatus: 'clearance_pending', customerId: 'c-1', total: 230, documentKind: 'INVOICE', originalInvoiceId: null,
  };
  const tx = {
    $queryRaw: async (s: TemplateStringsArray) => {
      const sql = s.join('?');
      order.push(sql.includes('FROM invoices') ? 'lock-invoice' : 'raw');
      if (sql.includes('FROM invoices')) return [invoiceRow];
      if (sql.includes('accountEntry') || sql.includes('account_entries')) return [{ balance: 0 }];
      return [];
    },
    $executeRaw: async () => 1,
    invoice: { update: async () => { order.push('invoice.update'); return invoiceRow; }, findUnique: async () => invoiceRow },
    notification: { create: async () => { order.push('notification.create'); return {}; } },
    customer: { update: async () => ({}), findUnique: async () => ({ balance: 230 }) },
    accountEntry: { create: async () => ({}), aggregate: async () => ({ _sum: { debit: 230, credit: 0 } }), findFirst: async () => ({ balance: 230 }) },
    customerActivity: { createMany: async (a: { data: Record<string, unknown>[] }) => { order.push('activity'); rows.push(...a.data); return {}; } },
  };
  const out = await voidInvoiceInTx(tx as never, {
    tenantId: 't-1', invoiceId: 'inv-1', subtype: '01', reason: 'REJECTED', documentId: 'd-1', at: new Date(),
    errors: [{ code: 'BR-KSA-01', message: 'رفض' }],
  });
  assert.equal(out.voided, true);
  assert.equal(rows.length, 1);
  assert.deepEqual(
    [rows[0].action, rows[0].actorKind, rows[0].refType, rows[0].refId, rows[0].refNo, rows[0].customerId],
    ['INVOICE_VOIDED', 'SYSTEM', 'INVOICE', 'inv-1', 'INV-2611-0009', 'c-1'],
  );
  assert.equal((rows[0].data as { reason: string }).reason, 'REJECTED');
  assert.ok(order.indexOf('activity') > order.indexOf('invoice.update'), 'الحدث بعد الإبطال وفي المعاملة نفسها');

  rows.length = 0;
  await voidInvoiceInTx(tx as never, {
    tenantId: 't-1', invoiceId: 'inv-1', subtype: '01', reason: 'WITHDRAWN', documentId: 'd-1', at: new Date(), mirror: 'withdrawn',
    activity: { actor: { kind: 'ADMIN', id: 'adm-1', name: 'منى' }, source: 'web' },
  });
  assert.deepEqual([rows[0].actorKind, rows[0].actorId, rows[0].actorName], ['ADMIN', 'adm-1', 'منى']);
});

// ═══ (٥) حرّاس نصّية: الحدث داخل معاملة كل مسار ═══

/** نصّ الدالة/المعالج من علامته حتى العلامة التالية */
const between = (s: string, start: string, end: string): string => {
  const i = s.indexOf(start);
  assert.ok(i >= 0, `العلامة مفقودة: ${start}`);
  const j = s.indexOf(end, i + start.length);
  return s.slice(i, j > i ? j : undefined);
};

test('حرّاس: كل مسار مالي يكتب حدثه بمقبض معاملته (recordDocActivity(tx|t, …)) قبل الالتزام', () => {
  const inv = read('routes/invoices.ts');
  const post = between(inv, "router.post('/',", "router.patch('/:id/cancel'");
  assert.match(post, /await recordDocActivity\(tx, invoiceIssuedInput\(/, 'إصدار المرحلة الأولى بلا حدث داخل المعاملة');
  assert.ok(post.indexOf('await recordDocActivity(tx, invoiceIssuedInput(') < post.indexOf('return inv;'), 'الحدث بعد ردّ المعاملة');
  assert.match(post, /activity: docActivityMeta\(req, body\.type === 'RETURN' \? 'RETURN_ISSUED' : undefined\)/, 'سياق المرحلة الثانية بلا فاعل');
  const cancel = between(inv, "router.patch('/:id/cancel'", '// ═══ ZATCA المرحلة الثانية (Z5.5)');
  assert.ok(cancel.indexOf("action: 'INVOICE_CANCELLED'") < cancel.indexOf('}, lotCancel.length ? LOT_TX_OPTIONS : undefined);'), 'الإلغاء خارج معاملته');
  assert.equal((between(inv, "router.patch('/:id/restock'", 'export default').match(/if \(flipped\) await recordRestockActivity\(tx,/g) ?? []).length, 4, 'فروع التبديل الأربعة');

  const z = read('routes/invoicesZatca.ts');
  assert.match(between(z, 'createInvoice: async (t, record) => {', 'afterDocument:'), /if \(ctx\.activity\) await recordDocActivity\(t, invoiceIssuedInput\(/);
  const notes = read('routes/invoicesNotes.ts');
  assert.match(between(notes, 'async function stampNote(', 'export function issueCreditNote('), /await recordDocActivity\(t, invoiceIssuedInput\(/);

  const rc = read('routes/receipts.ts');
  const rpost = between(rc, "router.post('/',", "router.get('/:id/cancel-options'");
  assert.ok(rpost.indexOf("action: 'RECEIPT_ISSUED'") > rpost.indexOf('await postReceiptEntries(') && rpost.indexOf("action: 'RECEIPT_ISSUED'") < rpost.indexOf('return rcp;'));
  const rcancel = between(rc, "router.patch('/:id/cancel'", 'export default');
  assert.ok(rcancel.indexOf("action: 'RECEIPT_CANCELLED'") < rcancel.indexOf('return rcp;'));

  const pl = read('services/paylink.ts');
  const confirm = between(pl, 'export async function confirmLinkPayment', 'export async function reverseLinkPayment');
  assert.ok(confirm.indexOf("action: 'PAYLINK_PAID'") > confirm.indexOf("status: 'paid', paidAt: new Date(), receiptId: rcp.id") && confirm.indexOf("action: 'PAYLINK_PAID'") < confirm.indexOf('return rcp;'));
  const card = read('services/cardPayment.ts');
  const book = between(card, 'async function bookApproved(', 'export async function reverseCardPayment(');
  assert.ok(book.indexOf("action: 'CARD_PAYMENT_COMPLETED'") > book.indexOf('await tx.cardPayment.update({ where: { id: row.id }, data: { receiptId: rcp.id } });') && book.indexOf("action: 'CARD_PAYMENT_COMPLETED'") < book.indexOf('return rcp;'));
  // ملاحظة سند البطاقة تحمل البطاقة المقنّعة — لا تُنقل إلى السجل
  assert.match(book, /receipt: \{ \.\.\.rcp, notes: null \}/);

  const adj = read('routes/ledger/customerAdjustments.ts');
  assert.match(between(adj, 'export async function executeCreateAdjustment(', 'export function adjustmentEventPayload('), /await recordDocActivity\(tx, \{[\s\S]*action: 'ADJUSTMENT_CREATED'/);
  assert.match(between(adj, 'export async function executeCancelAdjustment(', '// ═══ القراءة: العرض ═══'), /await recordDocActivity\(tx, \{[\s\S]*action: 'ADJUSTMENT_UPDATED'/);
  assert.match(read('routes/ledger/setup.ts'), /action: 'OPENING_BALANCE_SET' as const/);
});

test('حارس: السجل للإلحاق وحده — لا تعديل ولا حذف لصفّ منه في ملفات المستندات المالية', () => {
  const files = [
    'services/customerActivityDocs.ts', 'routes/invoices.ts', 'routes/invoicesNotes.ts', 'routes/invoicesZatca.ts', 'routes/receipts.ts',
    'services/invoiceVoid.ts', 'services/invoiceReissue.ts', 'services/cardPayment.ts', 'routes/cardPayments.ts', 'services/paylink.ts',
    'routes/paylink.ts', 'routes/ledger/customerAdjustments.ts', 'routes/ledger/setup.ts',
  ];
  for (const f of files) {
    assert.doesNotMatch(read(f), /customerActivity\.(update|updateMany|delete|deleteMany|upsert)\(/, `${f} يعدّل السجل أو يحذف منه`);
    assert.doesNotMatch(read(f), /(UPDATE|DELETE FROM)\s+"?customer_activities/i, `${f} يعدّل السجل بـSQL`);
  }
});

// «سجلّ العميل» (طلب المالك ٢٦ نوفمبر ٢٠٢٦) — انحدار إصلاحات الكُتّاب الماليين (المُصلِح B)، لكل عنقودٍ اختباره:
//   C5  إماتة روابط الدفع: تبديلٌ مشروط من «بانتظار الدفع» وحدثٌ لمن فاز وحده، والمسدَّد بعد القراءة لا يُدهس ولا يُلغى لدى المزوّد.
//   C6  البطاقة والرابط: العكس CARD_PAYMENT_REVERSED، والإيقاف للمراجعة CARD_PAYMENT_HELD، والاسترداد PAYLINK_REFUNDED، وفشلٌ واحد
//       للمحاولة، وقرار المزوّد/المجدول بفاعل النظام.
//   C7  رقم الفاتورة في توزيع السند (الإصدار والإلغاء واسترداد الرابط وعكس البطاقة)، ورقم فاتورة البيع في المرتجع المرتبط.
//   C8  ملاحظة السند بلا بيانات بطاقة (safeReceiptNote) — في الكتابة وفي الإلغاء اليدوي لسند البطاقة.
//   C9  الحذف النهائي: INVOICE_DELETED/RECEIPT_DELETED لكل مستندٍ في الخطة بتوزيعه، وحدثٌ لكل نموذجٍ مرتبطٍ بعميل — وحارس تغطية.
//   C10 القيد اليدوي على عملاء: LEDGER_JOURNAL_POSTED/REVERSED لكل عميلٍ بصافي أثره في معاملة الترحيل/العكس، والمجدول بفاعل النظام.
//   C15 عُرف المبلغ: أثر التسوية الموقَّع على رصيد العميل (مدين − دائن).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.join(__dirname, '..');
const BACKEND = path.join(SRC, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};
const loaded = (rel: string): boolean => !!require.cache[require.resolve(path.join(SRC, rel))];
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires */
type Row = Record<string, any>;

// ═══════════════════ Prisma مزيّف بمعاملاتٍ تُلتزم أو تُتراجع ═══════════════════

type Call = { op: string; args: any; tx: number | null };
let calls: Call[] = [];
let scripted: Record<string, (args: any, tx: number | null) => unknown> = {};
let raw: (sql: string, values: unknown[]) => unknown = () => undefined;
/** أسطر السجلّ الملتزمة — ومعها رقم معاملتها (__tx) */
let committed: Row[] = [];
let txSeq = 0;

function defaultFor(method: string): unknown {
  if (method === 'findMany' || method === 'groupBy') return [];
  if (method === 'count') return 0;
  if (method === 'aggregate') return { _sum: { debit: 0, credit: 0, amount: 0 }, _count: { _all: 0 } };
  if (method === 'updateMany' || method === 'deleteMany' || method === 'createMany') return { count: 0 };
  return null;
}

const plain = (v: unknown): v is Row => !!v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);
function whereMatches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, w]) => {
    if (plain(w)) {
      if (Array.isArray(w.in)) return w.in.includes(row[k]);
      if ('not' in w) return row[k] !== w.not;
      return true;
    }
    return row[k] === w;
  });
}

function delegate(model: string, tx: number | null, buf: Row[] | null): unknown {
  return new Proxy({}, {
    get: (_t, method: string) => {
      if (method === 'then') return undefined;
      return async (args: any) => {
        calls.push({ op: `${model}.${method}`, args, tx });
        if (model === 'customerActivity' && method === 'createMany') {
          const rows = (args?.data ?? []).map((d: Row) => ({ ...d, __tx: tx }));
          (buf ?? committed).push(...rows);
          return { count: rows.length };
        }
        if (model === 'customerActivity' && (method === 'findFirst' || method === 'findMany')) {
          const pool = [...committed, ...(buf ?? [])].filter((r) => whereMatches(r, args?.where));
          return method === 'findFirst' ? (pool[0] ?? null) : pool;
        }
        const fn = scripted[`${model}.${method}`];
        return fn ? fn(args, tx) : defaultFor(method);
      };
    },
  });
}

function sqlOf(strings: unknown): string {
  if (Array.isArray(strings)) return (strings as string[]).join('?');
  const s = strings as { sql?: string; strings?: string[] } | string;
  if (typeof s === 'string') return s;
  return s?.sql ?? (Array.isArray(s?.strings) ? s.strings.join('?') : String(s));
}

function client(tx: number | null, buf: Row[] | null): Row {
  return new Proxy({}, {
    get: (_t, key: string) => {
      if (key === 'then') return undefined;
      if (key === '$transaction') {
        return async (arg: unknown, opts?: unknown) => {
          if (typeof arg !== 'function') return Promise.all(arg as Promise<unknown>[]);
          if (tx !== null) return (arg as (t: unknown) => Promise<unknown>)(client(tx, buf));
          const id = ++txSeq;
          const mine: Row[] = [];
          calls.push({ op: '$transaction', args: opts ?? null, tx: id });
          try {
            const out = await (arg as (t: unknown) => Promise<unknown>)(client(id, mine));
            committed.push(...mine);
            calls.push({ op: '$commit', args: null, tx: id });
            return out;
          } catch (e) {
            calls.push({ op: '$rollback', args: (e as Error)?.message ?? null, tx: id });
            throw e;
          }
        };
      }
      if (key === '$queryRaw' || key === '$executeRaw' || key === '$queryRawUnsafe' || key === '$executeRawUnsafe') {
        return async (strings: unknown, ...values: unknown[]) => {
          const sql = sqlOf(strings).replace(/\s+/g, ' ');
          calls.push({ op: key, args: { sql, values }, tx });
          const out = raw(sql, values);
          if (out !== undefined) return out;
          return key.startsWith('$query') ? [] : 0;
        };
      }
      return delegate(key, tx, buf);
    },
  });
}
const prismaFake = client(null, null);

function reset(): void {
  calls = []; scripted = {}; committed = []; raw = () => undefined; cancels.length = 0;
}
const events = (): Row[] => committed;
const eventsOf = (action: string): Row[] => committed.filter((r) => r.action === action);

// ═══════════════════ الحقن قبل تحميل ما يُختبر ═══════════════════

const pass = (_req: unknown, _res: unknown, next: () => void): void => next();
stub('config/database', { default: prismaFake });
const realAuth = require('../middleware/auth') as Row;
stub('middleware/auth', {
  ...realAuth,
  authenticate: pass, requireAdmin: pass, requireAdminPermission: () => pass, requireSalesRep: pass, requireSuperAdmin: pass,
  requireDailyReport: pass, requirePaymentMethods: pass, requireLocations: pass, requireLots: pass, requireAiAccountant: pass,
  requireAccounting: pass, requireAccountingSuite: pass, requireLedgerPermission: () => pass,
  tenantId: (req: { user?: { tenantId?: string } }) => req.user?.tenantId ?? '',
});
const realAdminScope = require('../services/adminScope') as Row;
stub('services/adminScope', {
  ...realAdminScope,
  adminScopeEnabled: async () => false, adminCustomerFilter: async () => ({}), adminRepFilter: async () => ({}),
  scopedRecordWhere: async () => ({}), scopedRepRecordWhere: async () => ({}), canAccessRep: async () => true,
  canAccessCustomerAsAdmin: async () => true, existingInScope: async () => true,
});
const cancels: string[] = [];
stub('services/moyasar', {
  moyasarConfigured: () => true,
  fetchInvoice: async () => ({ status: 'initiated', amount: 0, currency: 'SAR' }),
  fetchPayment: async () => ({}),
  createInvoice: async () => ({ id: 'moy-x', url: 'https://example.invalid/x' }),
  cancelInvoice: async (id: string) => { cancels.push(id); return {}; },
  sarToHalalas: (s: number) => Math.round(s * 100),
});
const realWebPush = require('../services/webPush') as Row;
stub('services/webPush', { ...realWebPush, sendPushToRep: async () => 0, sendPushToAdmins: async () => 0, sendPush: async () => 'sent' });
let snap: Row | null = null;
const realNear = require('../services/nearpay') as Row;
stub('services/nearpay', { ...realNear, fetchIntent: async () => snap });

// محرّكا الترحيل والعكس: نسخٌ مسجَّلة (المسار والمجدول يُختبران بأحداثهما لا بالمحرّك الذي له اختباراته)
assert.equal(loaded('services/gl/autoPost.ts'), false, 'المجدول حُمّل قبل حقن محرّك الترحيل');
assert.equal(loaded('routes/ledger/moves.ts'), false, 'مسار القيود حُمّل قبل حقن محرّك الترحيل');
const realPost = require('../services/gl/post') as Row;
stub('services/gl/post', {
  ...realPost,
  postDraftMove: async (tx: Row, o: Row) => {
    await tx.glMove.updateMany({ where: { id: o.moveId, state: 'DRAFT' }, data: { state: 'POSTED' } }); // أثرٌ في المعاملة نفسها
    return { id: o.moveId, number: `JV/2026/${o.moveId}`, journalId: 'j-1', date: '2026-11-20', originalDate: null, lateArrival: false, totalMilli: 500_000n };
  },
});
let reverseResult: Row = {};
const realReverse = require('../services/gl/reverse') as Row;
stub('services/gl/reverse', {
  ...realReverse,
  assertManualOwned: async () => ({}),
  reverseMove: async (tx: Row, o: Row) => { await tx.glMove.create({ data: { reversedMoveId: o.moveId } }); return { ...reverseResult }; },
  resetDraft: async (tx: Row, o: Row) => { await tx.glMove.updateMany({ where: { id: o.moveId }, data: { state: 'DRAFT' } }); return { draft: { id: o.moveId, number: `JV/2026/${o.moveId}` } }; },
});
let purgePlan: Row = { invoiceIds: [], receiptIds: [], batches: [] };
const realPurge = require('../services/ownerPurge') as Row;
stub('services/ownerPurge', {
  ...realPurge,
  purgeInTx: async (tx: Row, _tid: string, model: string, ids: string[], opts?: { beforeWrite?: (p: Row) => Promise<void> }) => {
    if (opts?.beforeWrite) await opts.beforeWrite({ model, ...purgePlan });
    await tx.invoice.deleteMany({ where: { id: { in: ids } } }); // الحذف نفسه بعد الحدث وفي معاملته
    return { counts: {}, nullCounts: {} };
  },
});

const docs = require('../services/customerActivityDocs') as typeof import('../services/customerActivityDocs');
const { expireStaleLinks, reverseLinkPayment } = require('../services/paylink') as typeof import('../services/paylink');
const { checkCardPayment, reverseCardPayment } = require('../services/cardPayment') as typeof import('../services/cardPayment');
const cardPaymentsRouter = require('../routes/cardPayments').default;
const receiptsRouter = require('../routes/receipts').default;
const ownerPurgeRoute = require('../routes/ownerPurge') as typeof import('../routes/ownerPurge');
const movesRouter = require('../routes/ledger/moves').default;
const { runAutoPostTick } = require('../services/gl/autoPost') as typeof import('../services/gl/autoPost');
const { adjustmentBalanceEffect } = require('../routes/ledger/customerAdjustments') as typeof import('../routes/ledger/customerAdjustments');

// ═══════════════════ تشغيل مكدّس المسار ═══════════════════

type Reply = { status: number; body: any; error: unknown };
async function call(router: unknown, method: string, p: string, req: Row, opts: { lastOnly?: boolean; locals?: Row } = {}): Promise<Reply> {
  const layer = (router as { stack: Row[] }).stack.find((l) => l.route?.path === p && l.route.methods?.[method]);
  assert.ok(layer, `${method.toUpperCase()} ${p} missing`);
  let done!: () => void;
  const finished = new Promise<void>((r) => { done = r; });
  const res: Row = { statusCode: 200, body: undefined, headers: {}, locals: opts.locals ?? {} };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; done(); return res; };
  res.send = res.json;
  res.setHeader = (k: string, v: unknown) => { res.headers[k.toLowerCase()] = v; return res; };
  res.set = res.setHeader;
  const full = { method: method.toUpperCase(), url: p, query: {}, params: {}, body: {}, headers: {}, ip: '127.0.0.1', ...req };
  const stack: Row[] = opts.lastOnly ? [layer!.route.stack.at(-1)] : layer!.route.stack;
  let err: unknown = null;
  for (const h of stack) {
    let passed = false;
    await new Promise<void>((resolve) => {
      finished.then(() => resolve());
      const ret = h.handle(full, res, (e?: unknown) => { if (e) err = e; else passed = true; resolve(); });
      if (ret && typeof ret.then === 'function') ret.then(() => resolve(), (e: unknown) => { err = e; resolve(); });
    });
    if (err || !passed) break;
  }
  return { status: err ? 500 : res.statusCode, body: res.body, error: err };
}
const why = (r: Reply): string => (r.error ? String((r.error as Error)?.stack ?? r.error) : JSON.stringify(r.body));
async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const e = console.error; const w = console.warn;
  console.error = () => {}; console.warn = () => {};
  try { return await fn(); } finally { console.error = e; console.warn = w; }
}

const T = 'T1';
const ADMIN = { id: 'admin-1', role: 'ADMIN', tenantId: T, name: 'سارة' };
const REP = { id: 'rep-1', role: 'SALES_REP', tenantId: T, name: 'خالد' };
const OWNER_SESSION = { id: 'admin-1', role: 'ADMIN', tenantId: T, name: 'مدير الشركة', impersonated: true, by: 'owner-1', byKind: 'OWNER' };
const PAN_NOTE = 'تحصيل بالبطاقة VISA 411111******1111 — فاتورة INV-0001 — RRN 123456789012';

// ═══════════════════ C8: ملاحظة السند بلا بيانات بطاقة ═══════════════════

test('C8 safeReceiptNote: سند البطاقة/الدفع الإلكتروني بلا ملاحظة، وغيره بلا ما يشبه البطاقة المقنّعة وRRN', () => {
  assert.equal(docs.safeReceiptNote(PAN_NOTE, { paymentMethod: 'POS' }), null);
  assert.equal(docs.safeReceiptNote('دفع الكتروني — فاتورة INV-1', { paymentMethod: 'ONLINE' }), null);
  assert.equal(docs.safeReceiptNote(PAN_NOTE, { paymentMethod: 'CASH', clientRef: 'cardpay:cp-1' }), null, 'سند البطاقة بمفتاحه');
  assert.equal(docs.safeReceiptNote('x', { clientRef: 'paylink:moy-1' }), null);
  // مستخدمٌ نسخ بيانات البطاقة يدوياً في سندٍ نقدي: تُنزع وحدها ويبقى كلامه
  assert.equal(docs.safeReceiptNote(PAN_NOTE, { paymentMethod: 'CASH' }), 'تحصيل بالبطاقة VISA — فاتورة INV-0001');
  assert.equal(docs.safeReceiptNote('دفعة عن أكتوبر 4111XXXXXXXX1111', { paymentMethod: 'BANK_TRANSFER' }), 'دفعة عن أكتوبر');
  assert.equal(docs.safeReceiptNote('دفعة أولى', { paymentMethod: 'CASH', clientRef: 'r-1' }), 'دفعة أولى');
  assert.equal(docs.safeReceiptNote('RRN 998877665544', {}), null, 'ما يفرغ بالنزع ⇒ null');
  assert.equal(docs.safeReceiptNote('   ', {}), null);
  assert.equal(docs.safeReceiptNote(null, {}), null);
});

test('C8 receiptEventInput: الملاحظة تمرّ بـsafeReceiptNote — ولا شيء من البطاقة في صفّ السجلّ', () => {
  const meta = { actor: { kind: 'ADMIN' as const, id: 'a1', name: 'A' }, source: 'web' };
  const pos = docs.receiptEventInput({ tenantId: T, action: 'RECEIPT_CANCELLED', meta, receipt: { id: 'r1', customerId: 'c-1', amount: 5, paymentMethod: 'POS', notes: PAN_NOTE } });
  assert.equal('note' in (pos.data ?? {}), false);
  const cash = docs.receiptEventInput({ tenantId: T, action: 'RECEIPT_ISSUED', meta, receipt: { id: 'r2', customerId: 'c-1', amount: 5, paymentMethod: 'CASH', notes: PAN_NOTE } });
  assert.equal((cash.data as Row).note, 'تحصيل بالبطاقة VISA — فاتورة INV-0001');
  assert.doesNotMatch(JSON.stringify(cash.data), /411111|123456789012/);
  // والحذف النهائي: restored لما يعود مبلغه إلى فاتورةٍ باقية
  const del = docs.receiptEventInput({
    tenantId: T, action: 'RECEIPT_DELETED', meta, receipt: { id: 'r3', customerId: 'c-1', amount: 9 },
    allocations: [{ invoiceId: 'i1', invoiceNo: 'INV-1', amount: 4, restored: true }, { invoiceId: 'i2', amount: 5, restored: false }],
  });
  assert.deepEqual((del.data as Row).allocations, [{ invoiceId: 'i1', invoiceNo: 'INV-1', amount: 4, restored: true }, { invoiceId: 'i2', amount: 5 }]);
});

// ═══════════════════ C5: إماتة روابط الدفع ═══════════════════

function scriptStaleLink(link: Row): void {
  scripted['customerPaymentLink.findMany'] = () => [{
    id: link.id, moyasarInvoiceId: link.moyasarInvoiceId, tenantId: T, customerId: 'c-1', invoiceId: 'inv-1', amount: 100, invoice: { number: 'INV-0001' },
  }];
  scripted['customerPaymentLink.updateMany'] = (a: Row) => {
    const ok = a.where.id === link.id && (a.where.status === undefined || a.where.status === link.status);
    if (ok) Object.assign(link, a.data);
    return { count: ok ? 1 : 0 };
  };
  scripted['customerPaymentLink.update'] = (a: Row) => { Object.assign(link, a.data); return { ...link }; };
}

test('C5 إماتتان متزامنتان على اللقطة نفسها: حدث إلغاءٍ واحد وإلغاءٌ واحد لدى المزوّد — لمن فاز بالتبديل', async () => {
  reset();
  const link = { id: 'L1', status: 'initiated', moyasarInvoiceId: 'moy-1' };
  scriptStaleLink(link);
  await Promise.all([
    expireStaleLinks(T, 'inv-1', 50, { reason: 'REPLACED' }),
    expireStaleLinks(T, 'inv-1', 50, { reason: 'REPLACED' }),
  ]);
  assert.equal(link.status, 'canceled');
  assert.deepEqual(eventsOf('PAYLINK_CANCELLED').map((e) => [e.refId, e.actorKind, e.data.reason]), [['L1', 'SYSTEM', 'REPLACED']]);
  assert.deepEqual(cancels, ['moy-1'], 'فاتورة المزوّد تُلغى مرّة واحدة');
  // والتبديل مشروطٌ بـ«بانتظار الدفع» — لا update مطلق
  assert.ok(calls.filter((c) => c.op === 'customerPaymentLink.updateMany').every((c) => c.args.where.status === 'initiated'));
  assert.equal(calls.some((c) => c.op === 'customerPaymentLink.update'), false);
});

test('C5 رابطٌ سُدّد بعد القراءة: يبقى «مدفوع» بلا حدث إلغاء ولا إلغاء لدى المزوّد', async () => {
  reset();
  const link = { id: 'L1', status: 'paid', moyasarInvoiceId: 'moy-1' };
  scriptStaleLink(link);
  await expireStaleLinks(T, 'inv-1');
  assert.equal(link.status, 'paid');
  assert.equal(events().length, 0);
  assert.deepEqual(cancels, []);
});

test('C5 الإماتة العادية: حدثٌ بفاعل من أماته (السند) وسببه — في معاملة التبديل نفسها', async () => {
  reset();
  const link = { id: 'L1', status: 'initiated', moyasarInvoiceId: null };
  scriptStaleLink(link);
  await expireStaleLinks(T, 'inv-1', undefined, { activity: { actor: { kind: 'REP', id: 'rep-1', name: 'خالد' }, source: 'rep' }, reason: 'COLLECTED' });
  const [e] = events();
  assert.deepEqual([e.action, e.actorKind, e.actorId, e.refNo, e.data.reason], ['PAYLINK_CANCELLED', 'REP', 'rep-1', 'INV-0001', 'COLLECTED']);
  const upd = calls.find((c) => c.op === 'customerPaymentLink.updateMany')!;
  assert.equal(upd.tx, e.__tx);
});

// ═══════════════════ C6/C7: استرداد رابط الدفع ═══════════════════

test('C6/C7 استرداد دفعة الرابط: PAYLINK_REFUNDED (لا «إلغاء رابط») بفاعل النظام، وإلغاء سنده برقم فاتورة توزيعه وبلا ملاحظته', async () => {
  reset();
  scripted['customerPaymentLink.findUnique'] = () => ({
    id: 'L2', tenantId: T, customerId: 'c-1', invoiceId: 'inv-1', amount: 115, status: 'paid', receiptId: 'rc-9', invoice: { number: 'INV-0001' },
  });
  scripted['receipt.findUnique'] = () => ({
    id: 'rc-9', number: 'RCP-9', customerId: 'c-1', amount: 115, paymentMethod: 'ONLINE', clientRef: 'paylink:moy-1',
    notes: 'دفع الكتروني — فاتورة INV-0001', invoiceItems: [{ invoiceId: 'inv-1', amount: 115, invoice: { number: 'INV-0001' } }],
  });
  scripted['customerPaymentLink.updateMany'] = () => ({ count: 1 });
  scripted['receipt.updateMany'] = () => ({ count: 1 });
  raw = (sql) => (/FROM invoices/.test(sql) ? [{ id: 'inv-1', paidAmt: 115, remainingAmt: 0 }] : undefined);
  const out = await quiet(() => reverseLinkPayment('L2', 'chargeback'));
  assert.equal(out.state, 'refunded');
  assert.deepEqual(events().map((e) => e.action), ['PAYLINK_REFUNDED', 'RECEIPT_CANCELLED']);
  const [r, c] = events();
  assert.deepEqual([r.actorKind, r.refType, r.refId, r.refNo, Number(r.amount), r.data.status, r.data.receiptNo], ['SYSTEM', 'PAYLINK', 'L2', 'INV-0001', 115, 'refunded', 'RCP-9']);
  assert.deepEqual(c.data.allocations, [{ invoiceId: 'inv-1', invoiceNo: 'INV-0001', amount: 115 }]);
  assert.equal('note' in c.data, false);
  assert.equal(eventsOf('PAYLINK_CANCELLED').length, 0);

  // تكرار الويب هوك: لا تبديل ⇒ لا حدث
  reset();
  scripted['customerPaymentLink.findUnique'] = () => ({ id: 'L2', tenantId: T, customerId: 'c-1', invoiceId: 'inv-1', amount: 115, status: 'paid', receiptId: 'rc-9', invoice: { number: 'INV-0001' } });
  scripted['receipt.findUnique'] = () => ({ id: 'rc-9', number: 'RCP-9', customerId: 'c-1', amount: 115, invoiceItems: [] });
  scripted['customerPaymentLink.updateMany'] = () => ({ count: 0 });
  assert.equal((await reverseLinkPayment('L2', 'chargeback')).state, 'already-refunded');
  assert.equal(events().length, 0);
});

// ═══════════════════ C6/C7/C8: التحصيل بالبطاقة ═══════════════════

const SNAP: Row = {
  found: true, id: 'cp1', status: 'new', amountHalalas: 11500, approved: false, reversed: false, tid: '12345678', transactionUuid: null,
  rrn: null, stan: null, approvalCode: null, cardScheme: null, maskedPan: null, statusMessage: null, effectiveCount: 0, authorizedHalalas: null,
  refund: 'none',
};
function scriptCard(over: Row = {}): Row {
  const card: Row = {
    id: 'cp1', tenantId: T, customerId: 'c-1', invoiceId: 'inv-1', amount: 115, amountHalalas: 11500, reference: 'INV-0001', tid: '12345678',
    status: 'pending', statusDetail: null, receiptId: null, createdAt: new Date(Date.now() - 2 * 3600_000), launchedAt: new Date(Date.now() - 2 * 3600_000),
    salesRepId: 'rep-1', createdById: null, transactionUuid: null, salesRep: { name: 'خالد' }, invoice: { number: 'INV-0001', teamId: null, einvoiceStatus: null },
    ...over,
  };
  scripted['cardPayment.findUnique'] = () => ({ ...card });
  scripted['cardPayment.findFirst'] = () => ({ ...card });
  scripted['cardPayment.update'] = () => ({ ...card });
  scripted['cardPayment.updateMany'] = (a: Row) => {
    const w = a.where;
    const okStatus = w.status === undefined || (typeof w.status === 'string' ? card.status === w.status : (w.status.in as string[]).includes(card.status));
    const okReceipt = !('receiptId' in w) || card.receiptId === w.receiptId;
    const okNot = !w.NOT || !Object.entries(w.NOT as Row).every(([k, v]) => card[k] === v);
    if (w.id !== card.id || !okStatus || !okReceipt || !okNot) return { count: 0 };
    Object.assign(card, a.data);
    return { count: 1 };
  };
  return card;
}
const closeReview = (note = 'عولجت يدوياً مع التاجر') =>
  call(cardPaymentsRouter, 'post', '/:id/close', { user: ADMIN, params: { id: 'cp1' }, body: { note } }, { lastOnly: true });

test('C6 محاولةٌ تنتهي ثم يُرفض ثم تُوقف للمراجعة ثم تُغلق: فشلٌ واحد بفاعل النظام، وHELD للإيقاف، والإغلاق حسمٌ لا فشلٌ ثانٍ', async () => {
  reset();
  const card = scriptCard();
  snap = null; // لم تظهر لدى المزوّد بعد مهلتها ⇒ انتهاء
  await checkCardPayment('cp1');
  assert.equal(card.status, 'expired');
  snap = { ...SNAP, reversed: true }; // المزوّد يقول رُفضت ⇒ مرفوضة — تبديلٌ بلا حدثٍ ثانٍ
  await checkCardPayment('cp1');
  assert.equal(card.status, 'declined');
  snap = { ...SNAP, effectiveCount: 2 }; // خصمٌ مكرّر محتمل ⇒ مراجعة
  await quiet(() => checkCardPayment('cp1'));
  assert.equal(card.status, 'review');
  const r = await closeReview();
  assert.equal(r.status, 200, why(r));
  assert.equal(card.status, 'failed');
  assert.deepEqual(events().map((e) => [e.action, e.actorKind, e.data.status]), [
    ['CARD_PAYMENT_FAILED', 'SYSTEM', 'expired'],
    ['CARD_PAYMENT_HELD', 'SYSTEM', 'review'],
    ['CARD_PAYMENT_HELD', 'ADMIN', 'failed'],
  ]);
  assert.equal(events().at(-1)!.data.closedAfterReview, true);
  assert.equal(events().at(-1)!.data.note, 'عولجت يدوياً مع التاجر');
  assert.ok(events().every((e) => e.refType === 'CARD_PAYMENT' && e.refId === 'cp1'));
});

test('C6 محاولةٌ تدخل المراجعة من «قيد الانتظار» مباشرة ثم تُغلق: الإغلاق هو فشلها الوحيد (بفاعل الإدارة)', async () => {
  reset();
  scriptCard();
  snap = { ...SNAP, effectiveCount: 2 };
  await quiet(() => checkCardPayment('cp1'));
  const r = await closeReview();
  assert.equal(r.status, 200, why(r));
  assert.deepEqual(events().map((e) => [e.action, e.actorKind]), [['CARD_PAYMENT_HELD', 'SYSTEM'], ['CARD_PAYMENT_FAILED', 'ADMIN']]);
  // إغلاقٌ ثانٍ: ليست قيد المراجعة ⇒ ٤٠٩ ولا حدث
  const again = await closeReview();
  assert.equal(again.status, 409);
  assert.equal(events().length, 2);
});

test('C6 عكسٌ لدى المزوّد لمحاولةٍ موقوفة بلا سند: CARD_PAYMENT_REVERSED بفاعل النظام — لا «فشل»', async () => {
  reset();
  scriptCard({ status: 'review' });
  await quiet(() => reverseCardPayment('cp1', 'عُكست العملية لدى مزوّد الدفع'));
  assert.deepEqual(events().map((e) => [e.action, e.actorKind, e.data.status, e.data.fromStatus]), [['CARD_PAYMENT_REVERSED', 'SYSTEM', 'reversed', 'review']]);
});

test('C6/C7/C8 عكس تحصيلٍ مقيَّد: REVERSED وإلغاء سنده برقم فاتورة توزيعه وبلا بيانات البطاقة — في معاملة العكس', async () => {
  reset();
  scriptCard({ status: 'approved', receiptId: 'rc-c' });
  scripted['receipt.findUnique'] = () => ({
    id: 'rc-c', number: 'RCP-C', customerId: 'c-1', amount: 115, paymentMethod: 'POS', clientRef: 'cardpay:cp1', notes: PAN_NOTE,
    invoiceItems: [{ invoiceId: 'inv-1', amount: 115, invoice: { number: 'INV-0001' } }],
  });
  scripted['receipt.updateMany'] = () => ({ count: 1 });
  raw = (sql) => (/FROM invoices/.test(sql) ? [{ id: 'inv-1', paidAmt: 115, remainingAmt: 0 }] : undefined);
  await quiet(() => reverseCardPayment('cp1', 'استُرد المبلغ لدى مزوّد الدفع'));
  assert.deepEqual(events().map((e) => e.action), ['CARD_PAYMENT_REVERSED', 'RECEIPT_CANCELLED']);
  const [rev, rc] = events();
  assert.deepEqual([rev.actorKind, rev.data.receiptNo, rev.data.fromStatus], ['SYSTEM', 'RCP-C', 'approved']);
  assert.deepEqual(rc.data.allocations, [{ invoiceId: 'inv-1', invoiceNo: 'INV-0001', amount: 115 }]);
  assert.doesNotMatch(JSON.stringify(events()), /411111|123456789012/);
  assert.equal(rev.__tx, rc.__tx);
  assert.equal(eventsOf('CARD_PAYMENT_FAILED').length, 0);
});

// ═══════════════════ C7/C8: مسارا السند ═══════════════════

const CUSTOMER = { id: 'c-1', tenantId: T, name: 'بقالة الأمل', status: 'ACTIVE', balance: 0, creditLimit: 0, totalSales: 0, priceListId: null, phone: '0501234567' };
const REP_ROW: Row = {
  id: 'rep-1', tenantId: T, name: 'خالد', canCreateInvoice: true, canSellOnCredit: true, canSellInCash: true, canSellOnInstallment: true,
  canChangePrice: true, canSellBelowPrice: true, canSellWithoutStock: true, canCancelInvoice: true, canCreateReceipt: true,
  canCancelReceipt: true, canAddCustomer: true, canEditCustomer: true, maxDiscountPct: 100, requireLocationOn: false,
  tenant: { settings: { teamsEnabled: false, paymentMethodsConfig: null } }, teamMemberships: [],
};

test('C7 إصدار السند: كل تخصيصٍ برقم فاتورته (من قراءة الفواتير المفتوحة نفسها)', async () => {
  reset();
  scripted = {
    'receipt.findUnique': () => null,
    'salesRep.findFirst': () => REP_ROW,
    'customer.findFirst': () => CUSTOMER,
    'invoice.findMany': () => [{ id: 'inv-open', remainingAmt: 100, invoiceDate: new Date('2026-11-01T00:00:00Z'), number: 'INV-0007' }],
    'receipt.create': (a: Row) => ({ id: 'rc-1', ...a.data }),
  };
  raw = (sql) => (/FROM invoices/.test(sql) && /FOR UPDATE/.test(sql) ? [{ id: 'inv-open', remainingAmt: 100, paidAmt: 0, zatcaPhase: null, einvoiceStatus: null }] : undefined);
  const r = await call(receiptsRouter, 'post', '/', { user: REP, body: { customerId: 'c-1', amount: 100, paymentMethod: 'CASH', invoiceAllocations: [{ invoiceId: 'inv-open', amount: 100 }] } });
  assert.equal(r.status, 201, why(r));
  const [e] = eventsOf('RECEIPT_ISSUED');
  assert.deepEqual(e.data.allocations, [{ invoiceId: 'inv-open', invoiceNo: 'INV-0007', amount: 100, settled: true }]);
  const read = calls.find((c) => c.op === 'invoice.findMany')!;
  assert.equal(read.args.select.number, true);
});

test('C7/C8 الإلغاء اليدوي لسند بطاقة: توزيعه برقم كل فاتورة، وملاحظته (البطاقة المقنّعة وRRN) لا تدخل السجلّ', async () => {
  reset();
  const rc = {
    id: 'rc-7', tenantId: T, number: 'RCP-0007', status: 'ACTIVE', customerId: 'c-1', salesRepId: 'rep-1', amount: 80, paymentMethod: 'POS',
    clientRef: 'cardpay:cp9', notes: PAN_NOTE, invoiceItems: [{ invoiceId: 'inv-a', amount: 80, invoice: { number: 'INV-000A' } }],
  };
  scripted = {
    'receipt.findFirst': () => ({ ...rc }),
    'receipt.updateMany': () => ({ count: 1 }),
    'receipt.findUniqueOrThrow': () => ({ ...rc, status: 'CANCELLED' }),
    'salesRep.findFirst': () => REP_ROW,
  };
  raw = (sql) => (/FROM invoices/.test(sql) && /FOR UPDATE/.test(sql) ? [{ id: 'inv-a', paidAmt: 80, remainingAmt: 0 }] : undefined);
  const r = await call(receiptsRouter, 'patch', '/:id/cancel', { user: ADMIN, params: { id: 'rc-7' }, body: { reason: 'سند مكرر' } });
  assert.equal(r.status, 200, why(r));
  const [e] = eventsOf('RECEIPT_CANCELLED');
  assert.deepEqual(e.data.allocations, [{ invoiceId: 'inv-a', invoiceNo: 'INV-000A', amount: 80 }]);
  assert.equal('note' in e.data, false);
  assert.doesNotMatch(JSON.stringify(e), /411111|123456789012/);
  const q = calls.find((c) => c.op === 'receipt.findFirst')!;
  assert.deepEqual(q.args.include, { invoiceItems: { include: { invoice: { select: { number: true } } } } });
});

test('C7 المرتجع المرتبط (المرحلة الأولى): رقم فاتورة البيع من قراءتها المقفلة نفسها في originalInvoiceNo', () => {
  const inv = read('routes/invoices.ts');
  assert.match(inv, /select: \{ type: true, status: true, remainingAmt: true, number: true \},\n\s*\}\);\n\s*saleInvoiceNo = saleDue\?\.number \?\? null;/);
  assert.match(inv, /\.\.\.\(saleForReturn && \{ saleInvoiceId: saleForReturn \}\),\n\s*\.\.\.\(saleForReturn && saleInvoiceNo && \{ originalInvoiceNo: saleInvoiceNo \}\),/);
});

// ═══════════════════ C9: الحذف النهائي ═══════════════════

const OWNER_META = { actor: { kind: 'OWNER' as const, id: 'owner-1', name: null }, source: 'web' };
const purge = (model: string, ids: string[], plan: Row = { invoiceIds: [], receiptIds: [], batches: [] }) =>
  ownerPurgeRoute.purgeActivityEvents(prismaFake as never, T, model, ids, OWNER_META, plan as never);

test('C9 حذف فاتورة: INVOICE_DELETED برقمها ومبلغها، وRECEIPT_DELETED لكل سندٍ سحبته بتوزيعه (restored لما يعود لفاتورةٍ باقية)', async () => {
  reset();
  scripted['invoice.findMany'] = () => [{ id: 'inv-a', customerId: 'c-1', number: 'INV-A', type: 'CREDIT', documentKind: 'INVOICE', total: 600, status: 'CONFIRMED' }];
  scripted['receipt.findMany'] = () => [
    { id: 'rc-1', customerId: 'c-1', number: 'RCP-1', amount: 500, status: 'ACTIVE', paymentMethod: 'CASH', clientRef: null,
      invoiceItems: [{ invoiceId: 'inv-a', amount: 300, invoice: { number: 'INV-A' } }, { invoiceId: 'inv-b', amount: 200, invoice: { number: 'INV-B' } }] },
    { id: 'rc-2', customerId: 'c-1', number: 'RCP-2', amount: 100, status: 'CANCELLED', paymentMethod: 'CASH', clientRef: null,
      invoiceItems: [{ invoiceId: 'inv-b', amount: 100, invoice: { number: 'INV-B' } }] },
  ];
  const out = await purge('Invoice', ['inv-a'], { invoiceIds: ['inv-a'], receiptIds: ['rc-1', 'rc-2'], batches: [{ model: 'Invoice', keys: [{ id: 'inv-a' }] }] });
  assert.deepEqual(out.map((e) => [e.action, e.refType, e.refId, e.refNo, e.amount, e.actor.kind]), [
    ['INVOICE_DELETED', 'INVOICE', 'inv-a', 'INV-A', 600, 'OWNER'],
    ['RECEIPT_DELETED', 'RECEIPT', 'rc-1', 'RCP-1', 500, 'OWNER'],
    ['RECEIPT_DELETED', 'RECEIPT', 'rc-2', 'RCP-2', 100, 'OWNER'],
  ]);
  assert.equal(out[0].data!.reason, 'OWNER_PURGE');
  assert.equal(out[0].data!.cascade, undefined, 'الهدف نفسه');
  assert.equal(out[1].data!.cascade, true, 'سُحب مع فاتورته');
  assert.deepEqual(out[1].data!.allocations, [
    { invoiceId: 'inv-a', invoiceNo: 'INV-A', amount: 300 },
    { invoiceId: 'inv-b', invoiceNo: 'INV-B', amount: 200, restored: true },
  ]);
  assert.deepEqual(out[2].data!.allocations, [{ invoiceId: 'inv-b', invoiceNo: 'INV-B', amount: 100 }], 'الملغى لا يُعاد مبلغه');
});

test('C9 مسار الحذف: الأحداث بالخطة نفسها داخل معاملة الحذف وقبل الحذف — ويلتزمان معاً', async () => {
  reset();
  purgePlan = { invoiceIds: ['inv-a'], receiptIds: [], batches: [{ model: 'Invoice', keys: [{ id: 'inv-a' }] }] };
  scripted['invoice.findMany'] = () => [{ id: 'inv-a', customerId: 'c-1', number: 'INV-A', type: 'CASH', documentKind: 'INVOICE', total: 50, status: 'CONFIRMED' }];
  const r = await call(ownerPurgeRoute.default, 'post', '/delete', { user: OWNER_SESSION, body: { model: 'Invoice', ids: ['inv-a'] } });
  assert.equal(r.status, 200, why(r));
  purgePlan = { invoiceIds: [], receiptIds: [], batches: [] };
  const [e] = eventsOf('INVOICE_DELETED');
  assert.deepEqual([e.actorKind, e.actorId, e.refNo, e.data.reason], ['OWNER', 'owner-1', 'INV-A', 'OWNER_PURGE']);
  const write = calls.findIndex((c) => c.op === 'customerActivity.createMany');
  const del = calls.findIndex((c) => c.op === 'invoice.deleteMany');
  assert.ok(write >= 0 && write < del, 'الحدث قبل الحذف');
  assert.equal(calls[write].tx, calls[del].tx, 'في معاملة الحذف نفسها');
});

test('C9 حذف العميل: لا حدث له ولا لمستنداته المحذوفة معه — سجلّه كله يُحذف معه (قرار المالك ٢٧ نوفمبر ٢٠٢٦)', async () => {
  reset();
  scripted['customer.findMany'] = () => [{ id: 'c-9', name: 'محل النخيل', number: 9, code: 'N9' }, { id: 'c-8', name: 'بلا مستندات', number: 8, code: 'N8' }];
  scripted['invoice.groupBy'] = () => [{ customerId: 'c-9', _count: { _all: 4 } }];
  scripted['receipt.groupBy'] = () => [{ customerId: 'c-9', _count: { _all: 2 } }];
  const out = await purge('Customer', ['c-9', 'c-8'], { invoiceIds: ['i1', 'i2', 'i3', 'i4'], receiptIds: ['r1', 'r2'], batches: [{ model: 'Customer', keys: [{ id: 'c-9' }, { id: 'c-8' }] }] });
  assert.deepEqual(out, [], 'لا CUSTOMER_DELETED ولا أحداث مستندات — الحذف يحذف السجلّ (customer-activity-delete.test.ts)');
  assert.equal(calls.some((c) => c.op === 'invoice.findMany' || c.op === 'receipt.findMany'), false);
});

test('C9 كل نموذجٍ مرتبطٍ بعميل له حدثه: الإسناد والنطاق والمستخدم والمحطّة والطلب ونوع السعر والموقع والفريق والقيد والتسوية والرابط والمراجعة', async () => {
  reset();
  scripted['customerAssignment.findMany'] = () => [{ customerId: 'c-1', salesRepId: 'rep-1', salesRep: { name: 'خالد' } }];
  let out = await purge('CustomerAssignment', ['as-1']);
  assert.deepEqual(out.map((e) => [e.action, e.refType, e.refId, e.data!.reason]), [['CUSTOMER_UNASSIGNED', 'ASSIGNMENT', 'rep-1', 'OWNER_PURGE']]);

  scripted['adminCustomerScope.findMany'] = (a: Row) => {
    assert.deepEqual(a.where, { tenantId: T, adminId: { in: ['ad-1'] } }, 'نطاق المستخدم المحذوف كله');
    return [{ customerId: 'c-1', adminId: 'ad-1', admin: { name: 'منى' } }, { customerId: 'c-2', adminId: 'ad-1', admin: { name: 'منى' } }];
  };
  out = await purge('Admin', ['ad-1']);
  assert.deepEqual(out.map((e) => [e.action, e.customerId, e.data!.kind, e.data!.adminName]), [
    ['CUSTOMER_UNASSIGNED', 'c-1', 'ADMIN_SCOPE', 'منى'], ['CUSTOMER_UNASSIGNED', 'c-2', 'ADMIN_SCOPE', 'منى'],
  ]);
  scripted['adminCustomerScope.findMany'] = () => [{ customerId: 'c-3', adminId: 'ad-2', admin: { name: 'فهد' } }];
  assert.deepEqual((await purge('AdminCustomerScope', ['sc-1'])).map((e) => [e.action, e.customerId]), [['CUSTOMER_UNASSIGNED', 'c-3']]);

  scripted['repRouteStop.findMany'] = () => [{ customerId: 'c-1', routeId: 'rt-1', route: { name: 'خط الأحد', salesRepId: 'rep-1' } }];
  assert.deepEqual((await purge('RepRouteStop', ['st-1'])).map((e) => [e.action, e.refType, e.refId]), [['ROUTE_STOP_REMOVED', 'ROUTE', 'rt-1']]);

  scripted['priceList.findMany'] = () => [{ id: 'pl-1', name: 'جملة' }];
  scripted['customer.findMany'] = () => [{ id: 'c-1', priceListId: 'pl-1' }];
  out = await purge('PriceList', ['pl-1']);
  assert.deepEqual(out.map((e) => [e.action, e.customerId, e.data!.from, e.data!.fromName, e.data!.to]), [['CUSTOMER_PRICE_LIST_CHANGED', 'c-1', 'pl-1', 'جملة', null]]);

  scripted['salesLocation.findMany'] = () => [{ id: 'loc-1', name: 'الرياض' }];
  scripted['invoice.groupBy'] = () => [{ customerId: 'c-1', _count: { _all: 3 } }];
  out = await purge('SalesLocation', ['loc-1']);
  assert.deepEqual(out.map((e) => [e.action, e.customerId, e.data!.kind, e.data!.count]), [['INVOICE_UPDATED', 'c-1', 'LOCATION_UNLINKED', 3]]);

  scripted['team.findMany'] = () => [{ id: 'tm-1', name: 'الشمال' }];
  scripted['invoice.groupBy'] = () => [{ customerId: 'c-1', _count: { _all: 2 } }];
  scripted['receipt.groupBy'] = () => [{ customerId: 'c-2', _count: { _all: 1 } }];
  scripted['repVisit.groupBy'] = () => [];
  out = await purge('Team', ['tm-1']);
  assert.deepEqual(out.map((e) => [e.action, e.customerId, e.data!.count]), [['INVOICE_REASSIGNED', 'c-1', 2], ['RECEIPT_REASSIGNED', 'c-2', 1]]);

  // قيد كشف الحساب: أثر حذفه سالب (مدين − دائن) — حذف قيدٍ دائن ٢٥٠ يرفع الرصيد +٢٥٠
  scripted['accountEntry.findMany'] = () => [{ id: 'ae-1', customerId: 'c-1', debit: 0, credit: 250, type: 'ADJUSTMENT_CREDIT', description: 'رصيد افتتاحي' }];
  out = await purge('AccountEntry', ['ae-1']);
  assert.deepEqual(out.map((e) => [e.action, e.refType, e.refId, e.amount, e.data!.newStatus]), [['ADJUSTMENT_UPDATED', 'ADJUSTMENT', 'ae-1', 250, 'DELETED']]);

  scripted['customerAdjustment.findMany'] = () => [{ id: 'adj-1', customerId: 'c-1', kind: 'BAD_DEBT_WRITEOFF', amount: 90, status: 'ACTIVE' }];
  out = await purge('CustomerAdjustment', ['adj-1']);
  assert.deepEqual(out.map((e) => [e.action, e.refId, e.amount, e.data!.amount]), [['ADJUSTMENT_UPDATED', 'adj-1', undefined, 90]]);

  scripted['customerPaymentLink.findMany'] = () => [{ id: 'L9', tenantId: T, customerId: 'c-1', invoiceId: 'inv-1', amount: 70, status: 'initiated', invoice: { number: 'INV-0001' } }];
  out = await purge('CustomerPaymentLink', ['L9']);
  assert.deepEqual(out.map((e) => [e.action, e.refId, e.refNo, e.data!.previousStatus, e.data!.reason]), [['PAYLINK_CANCELLED', 'L9', 'INV-0001', 'initiated', 'OWNER_PURGE']]);

  scripted['zatcaCutoverReview.findMany'] = () => [{ id: 'zr-1', customerId: 'c-1', status: 'PENDING', reason: 'WINDOW_EXPIRED', amount: 33 }, { id: 'zr-2', customerId: null, status: 'PENDING', reason: 'TOO_OLD', amount: 1 }];
  out = await purge('ZatcaCutoverReview', ['zr-1', 'zr-2']);
  assert.deepEqual(out.map((e) => [e.action, e.customerId, e.refId, e.data!.kind]), [['OTHER', 'c-1', 'zr-1', 'OWNER_PURGE']]);
});

test('C9 طلب المنيو: عميله من سطر طلبه في السجلّ أولاً، ثم عميل فاتورة إغلاقه — وطلبٌ بلا عميل لا حدث له', async () => {
  reset();
  committed.push({ tenantId: T, customerId: 'c-logged', action: 'CATALOG_ORDER_PLACED', refType: 'CATALOG_ORDER', refId: 'o-1' });
  scripted['catalogOrder.findMany'] = () => [
    { id: 'o-1', status: 'NEW', phoneKey: null, customerName: 'أبو محمد', invoiceId: null },
    { id: 'o-2', status: 'DONE', phoneKey: null, customerName: 'أم علي', invoiceId: 'inv-7' },
    { id: 'o-3', status: 'NEW', phoneKey: null, customerName: 'زائر', invoiceId: null },
  ];
  scripted['invoice.findFirst'] = () => ({ customerId: 'c-inv' });
  const out = await purge('CatalogOrder', ['o-1', 'o-2', 'o-3']);
  assert.deepEqual(out.map((e) => [e.action, e.customerId, e.refId, e.data!.oldStatus, e.data!.newStatus]), [
    ['CATALOG_ORDER_UPDATED', 'c-logged', 'o-1', 'NEW', 'DELETED'],
    ['CATALOG_ORDER_UPDATED', 'c-inv', 'o-2', 'DONE', 'DELETED'],
  ]);
});

test('C9 حارس التغطية: كل نموذجٍ قابلٍ للحذف النهائي يحمل عميلاً (أو أبٌ إلزاميٌّ له، أو يشير إليه العميل) له حالةٌ أو سببٌ صريح', () => {
  const text = fs.readFileSync(path.join(BACKEND, 'prisma', 'schema.prisma'), 'utf8').replace(/\r\n/g, '\n');
  const models = new Map([...text.matchAll(/^model (\w+) \{\n([\s\S]*?)^\}/gm)].map((m) => [m[1], m[2]]));
  type F = { name: string; type: string; optional: boolean; rest: string };
  const fieldsOf = (body: string): F[] => body.split('\n').map((l) => l.trim())
    .filter((t) => t && !t.startsWith('//') && !t.startsWith('@@'))
    .map((t) => /^(\w+)\s+(\w+)(\[\])?(\?)?(.*)$/.exec(t)).filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ name: m[1], type: m[2], optional: !!m[4], rest: m[5] }));
  // ما لا يُستهدف أبداً (services/ownerPurge.ts NOT_TARGETABLE): الشركة وجداول الدفاتر وسجلّات المورّد الإلحاقية وإدارة المبيعات والسجلّ نفسه
  const notTargetable = new Set(['Tenant', 'SupplierLedgerEntry', 'SupplierPaymentAllocation', 'InvoiceRestockLog', 'SalesContact', 'CustomerActivity']);
  const engine = read('services/ownerPurge.ts');
  for (const n of notTargetable) assert.ok(engine.includes(`'${n}'`), `NOT_TARGETABLE تغيّر: ${n}`);
  const targetable = (n: string) => models.has(n) && fieldsOf(models.get(n)!).some((f) => f.name === 'tenantId') && !/^Gl[A-Z]/.test(n) && !notTargetable.has(n);

  const linked = [...models.keys()].filter((n) => targetable(n) && fieldsOf(models.get(n)!).some((f) => f.name === 'customerId'));
  const required = new Set<string>(['Customer', 'CatalogOrder' /* بلا customerId: يُنسب بجواله */, ...linked]);
  for (const n of linked) {
    for (const f of fieldsOf(models.get(n)!)) {
      const fk = /@relation\([^)]*fields:\s*\[(\w+)\]/.exec(f.rest)?.[1];
      if (!fk || f.type === 'Customer' || f.type === 'Tenant') continue;
      const fkField = fieldsOf(models.get(n)!).find((x) => x.name === fk);
      // أبٌ إلزاميّ: حذفه يسحب صفّ العميل معه. وأبٌ اختياريّ لمستندات العميل (الموقع والفريق ونوع السعر) يُفرَّغ وسمه عنها
      if (targetable(f.type) && (!fkField?.optional || ['Invoice', 'Receipt', 'RepVisit'].includes(n))) required.add(f.type);
    }
  }
  // ما يشير إليه العميل نفسه (نوع سعره)
  for (const f of fieldsOf(models.get('Customer')!)) if (/@relation\(/.test(f.rest) && targetable(f.type)) required.add(f.type);

  const route = read('routes/ownerPurge.ts');
  const exempt = ownerPurgeRoute.PURGE_WITHOUT_CUSTOMER_EVENT;
  const missing = [...required].filter((n) => !route.includes(`case '${n}':`) && !exempt[n]);
  assert.deepEqual(missing, [], 'نماذج يمسّ حذفها عميلاً بلا حدثٍ في purgeActivityEvents ولا سببٍ في PURGE_WITHOUT_CUSTOMER_EVENT');
  for (const [n, why] of Object.entries(exempt)) {
    assert.ok(linked.includes(n), `استثناءٌ لنموذجٍ لا يحمل عميلاً: ${n}`);
    assert.ok(why.length > 10);
    assert.equal(route.includes(`case '${n}':`), false, `${n} له حالةٌ واستثناءٌ معاً`);
  }
  // الأصول الإلزامية المعروفة اليوم مشمولة (حارسٌ على المحلّل نفسه)
  for (const n of ['Admin', 'SalesRep', 'RepRoute', 'Invoice', 'Team', 'SalesLocation', 'PriceList']) assert.ok(required.has(n), n);
});

// ═══════════════════ C10: القيد اليدوي على عملاء ═══════════════════

const moveRow = (id: string, over: Row = {}): Row => ({
  id, number: `JV/2026/${id}`, ref: 'شطب', narration: 'قيد يدوي', date: new Date('2026-11-20T00:00:00Z'), origin: 'MANUAL', sourceType: null,
  lines: [
    { customerId: 'c-1', debitMilli: 500_000n, creditMilli: 0n, account: { code: '611001' } },
    { customerId: 'c-1', debitMilli: 0n, creditMilli: 200_000n, account: { code: '411001' } },
    { customerId: 'c-2', debitMilli: 0n, creditMilli: 300_000n, account: { code: '611001' } },
  ],
  ...over,
});
const LEDGER_LOCALS = { ledger: { tenantId: T, actorId: 'admin-1', impersonated: false } };

test('C10 ledgerJournalEvents: حدثٌ لكل عميلٍ بصافي (مدين − دائن) سطوره، والعكس سالبه — والسطر بلا عميل لا شيء', () => {
  const meta = { actor: { kind: 'ADMIN' as const, id: 'a1', name: 'A' }, source: 'web' };
  const m = moveRow('m1');
  m.lines.push({ customerId: null, debitMilli: 1_000n, creditMilli: 0n, account: { code: '111001' } });
  const posted = docs.ledgerJournalEvents({ tenantId: T, action: 'LEDGER_JOURNAL_POSTED', meta, move: m as never });
  assert.deepEqual(posted.map((e) => [e.customerId, e.amount, e.refType, e.refId, e.refNo]), [
    ['c-1', 300, 'ADJUSTMENT', 'm1', 'JV/2026/m1'], ['c-2', -300, 'ADJUSTMENT', 'm1', 'JV/2026/m1'],
  ]);
  assert.deepEqual(posted[0].data, {
    kind: 'GL_JOURNAL', moveNo: 'JV/2026/m1', reference: 'شطب', narration: 'قيد يدوي', docDate: '2026-11-20', linesCount: 2, debit: 500, credit: 200,
    accountCodes: ['411001', '611001'],
  });
  const rev = docs.ledgerJournalEvents({ tenantId: T, action: 'LEDGER_JOURNAL_REVERSED', meta, move: m as never, sign: -1 });
  assert.deepEqual(rev.map((e) => [e.customerId, e.amount]), [['c-1', -300], ['c-2', 300]]);
});

test('C10 recordLedgerJournalActivity: القيد الآلي أو المملوك لمستند لا حدث له هنا (مستنده يُسجّله مساره)', async () => {
  reset();
  scripted['glMove.findFirst'] = () => moveRow('m-auto', { origin: 'AUTO' });
  const meta = { actor: { kind: 'ADMIN' as const, id: 'a1', name: 'A' }, source: 'web' };
  assert.equal(await docs.recordLedgerJournalActivity(prismaFake, { tenantId: T, moveId: 'm-auto', action: 'LEDGER_JOURNAL_POSTED', meta }), 0);
  scripted['glMove.findFirst'] = () => moveRow('m-src', { sourceType: 'CUSTOMER_ADJUSTMENT' });
  assert.equal(await docs.recordLedgerJournalActivity(prismaFake, { tenantId: T, moveId: 'm-src', action: 'LEDGER_JOURNAL_POSTED', meta }), 0);
  scripted['glMove.findFirst'] = () => null;
  assert.equal(await docs.recordLedgerJournalActivity(prismaFake, { tenantId: T, moveId: 'gone', action: 'LEDGER_JOURNAL_POSTED', meta }), 0);
  assert.equal(events().length, 0);
  // مقبضٌ بلا جدول السجل (المزيّف القديم) لا يُقرأ له شيء
  assert.equal(await docs.recordLedgerJournalActivity({ glMove: { findFirst: async () => { throw new Error('must not read'); } } }, { tenantId: T, moveId: 'x', action: 'LEDGER_JOURNAL_POSTED', meta }), 0);
});

test('C10 ترحيل القيد اليدوي (مفرداً وجماعياً): حدثٌ لكل عميلٍ بفاعل الطلب في معاملة الترحيل نفسها', async () => {
  reset();
  scripted['glSettings.findUnique'] = () => ({ activatedAt: new Date('2026-01-01T00:00:00Z') });
  scripted['glMove.findFirst'] = (a: Row) => moveRow(a.where.id);
  let r = await call(movesRouter, 'post', '/moves/:id/post', { user: ADMIN, params: { id: 'm1' } }, { locals: LEDGER_LOCALS });
  assert.equal(r.status, 200, why(r));
  assert.deepEqual(events().map((e) => [e.action, e.customerId, Number(e.amount), e.actorKind, e.actorId, e.refId]), [
    ['LEDGER_JOURNAL_POSTED', 'c-1', 300, 'ADMIN', 'admin-1', 'm1'], ['LEDGER_JOURNAL_POSTED', 'c-2', -300, 'ADMIN', 'admin-1', 'm1'],
  ]);
  const post = calls.find((c) => c.op === 'glMove.updateMany')!;
  assert.ok(events().every((e) => e.__tx === post.tx), 'في معاملة الترحيل نفسها');

  reset();
  scripted['glSettings.findUnique'] = () => ({ activatedAt: new Date('2026-01-01T00:00:00Z') });
  scripted['glMove.findFirst'] = (a: Row) => moveRow(a.where.id, a.where.id === 'm3' ? { lines: [] } : {});
  r = await call(movesRouter, 'post', '/moves/post-drafts', { user: ADMIN, body: { ids: ['m2', 'm3'] } }, { locals: LEDGER_LOCALS });
  assert.equal(r.status, 200, why(r));
  assert.deepEqual(r.body.data.posted.map((p: Row) => p.id), ['m2', 'm3']);
  assert.deepEqual(events().map((e) => [e.refId, e.customerId]), [['m2', 'c-1'], ['m2', 'c-2']], 'القيد بلا عميل لا حدث له');
});

test('C10 عكس القيد اليدوي و«إعادته إلى مسودة»: حدثٌ لكل عميلٍ بسالب أثره وسببه — والعكس المكرّر بلا حدث', async () => {
  reset();
  scripted['glSettings.findUnique'] = () => ({ activatedAt: new Date('2026-01-01T00:00:00Z') });
  scripted['glMove.findFirst'] = (a: Row) => moveRow(a.where.id);
  reverseResult = { alreadyReversed: false, original: { id: 'm1', number: 'JV/2026/m1' }, reversal: { id: 'm1r', number: 'JV/2026/m1r', date: '2026-11-21' } };
  let r = await call(movesRouter, 'post', '/moves/:id/reverse', { user: ADMIN, params: { id: 'm1' }, body: { reason: 'قيد خاطئ' } }, { locals: LEDGER_LOCALS });
  assert.equal(r.status, 200, why(r));
  assert.deepEqual(events().map((e) => [e.action, e.customerId, Number(e.amount), e.data.mode, e.data.reason, e.data.reversalNo]), [
    ['LEDGER_JOURNAL_REVERSED', 'c-1', -300, 'REVERSAL', 'قيد خاطئ', 'JV/2026/m1r'],
    ['LEDGER_JOURNAL_REVERSED', 'c-2', 300, 'REVERSAL', 'قيد خاطئ', 'JV/2026/m1r'],
  ]);
  const rev = calls.find((c) => c.op === 'glMove.create')!;
  assert.ok(events().every((e) => e.__tx === rev.tx));

  reset();
  scripted['glSettings.findUnique'] = () => ({ activatedAt: new Date('2026-01-01T00:00:00Z') });
  scripted['glMove.findFirst'] = (a: Row) => moveRow(a.where.id);
  reverseResult = { alreadyReversed: true, original: { id: 'm1', number: 'JV/2026/m1' }, reversal: { id: 'm1r', number: 'JV/2026/m1r', date: '2026-11-21' } };
  r = await call(movesRouter, 'post', '/moves/:id/reverse', { user: ADMIN, params: { id: 'm1' }, body: { reason: 'قيد خاطئ' } }, { locals: LEDGER_LOCALS });
  assert.equal(r.status, 200, why(r));
  assert.equal(events().length, 0);

  reset();
  scripted['glSettings.findUnique'] = () => ({ activatedAt: new Date('2026-01-01T00:00:00Z') });
  scripted['glMove.findFirst'] = (a: Row) => moveRow(a.where.id);
  r = await call(movesRouter, 'post', '/moves/:id/reset-draft', { user: ADMIN, params: { id: 'm1' }, body: { reason: 'تعديل المبلغ' } }, { locals: LEDGER_LOCALS });
  assert.equal(r.status, 200, why(r));
  assert.deepEqual(events().map((e) => [e.action, e.customerId, Number(e.amount), e.data.mode]), [
    ['LEDGER_JOURNAL_REVERSED', 'c-1', -300, 'RESET_DRAFT'], ['LEDGER_JOURNAL_REVERSED', 'c-2', 300, 'RESET_DRAFT'],
  ]);
});

test('C10 المجدول (autoPostOn): ترحيل المسودة اليدوية على عملاء حدثٌ بفاعل النظام في معاملة الترحيل نفسها', async () => {
  reset();
  scripted['glMove.findMany'] = () => [{ id: 'm-sched', tenantId: T, autoPostOn: new Date('2026-11-01T00:00:00Z'), number: null }];
  scripted['glSettings.findMany'] = () => [{ tenantId: T, activatedAt: new Date('2026-01-01T00:00:00Z'), timezone: 'Asia/Riyadh', tenant: { accountingSuiteEnabled: true, accountingEnabled: true } }];
  scripted['glMove.findFirst'] = (a: Row) => moveRow(a.where.id);
  const out = await runAutoPostTick(prismaFake as never, { now: new Date('2026-11-27T10:00:00Z') });
  assert.deepEqual(out.posted.map((p) => p.id), ['m-sched']);
  assert.deepEqual(events().map((e) => [e.action, e.customerId, e.actorKind, e.source, e.data.scheduled]), [
    ['LEDGER_JOURNAL_POSTED', 'c-1', 'SYSTEM', 'system', true], ['LEDGER_JOURNAL_POSTED', 'c-2', 'SYSTEM', 'system', true],
  ]);
});

test('C10 حرّاس نصّية: كل مسار ترحيلٍ/عكسٍ يدوي يُسجّل داخل معاملته، والتسوية الموجّهة لا تمسّ سطور العملاء', () => {
  const moves = read('routes/ledger/moves.ts');
  const body = (start: string) => moves.slice(moves.indexOf(start), moves.indexOf('}));', moves.indexOf(start)));
  assert.match(body("router.post('/moves/:id/post'"), /postDraftMove\(tx[\s\S]*recordLedgerJournalActivity\(tx, \{ tenantId, moveId, action: 'LEDGER_JOURNAL_POSTED'/);
  assert.match(body("router.post('/moves/post-drafts'"), /post: postDraftWithCustomerActivity\(docActivityMeta\(req\)\)/);
  assert.match(body("router.post('/moves/:id/reverse'"), /if \(!rev\.alreadyReversed\) \{\s*await recordLedgerJournalActivity\(tx, \{[\s\S]*sign: -1/);
  assert.match(body("router.post('/moves/:id/reset-draft'"), /resetDraft\(tx[\s\S]*recordLedgerJournalActivity\(tx, \{[\s\S]*sign: -1/);
  assert.match(read('services/gl/autoPost.ts'), /const post = opts\.post \?\? postScheduledDraft;/);
  // التسوية الموجّهة (routes/ledger/clearing.ts) تصفّي الحسابات الوسيطة بلا عميلٍ على سطورها — لا بند مفتوحاً لعميلٍ يتغيّر
  assert.doesNotMatch(read('routes/ledger/clearing.ts'), /customerId/);
  assert.doesNotMatch(read('services/gl/builders/clearing.ts'), /customerId/);
});

// ═══════════════════ C15: عُرف المبلغ ═══════════════════

test('C15 أثر التسوية على رصيد العميل (مدين − دائن): الشطب سالب، والردّ موجب، وإلغاء كلٍّ سالب أثره', () => {
  assert.equal(adjustmentBalanceEffect('BAD_DEBT_WRITEOFF', 500), -500);
  assert.equal(adjustmentBalanceEffect('CREDIT_REFUND', 500), 500);
  assert.equal(docs.balanceEffect(100.1, 0.1), 100);
  assert.ok(Object.is(docs.balanceEffect(0, 0), 0), 'لا −٠');
  const adj = read('routes/ledger/customerAdjustments.ts');
  const create = adj.slice(adj.indexOf('export async function executeCreateAdjustment('), adj.indexOf('export function adjustmentEventPayload('));
  assert.match(create, /action: 'ADJUSTMENT_CREATED'[\s\S]*amount: adjustmentBalanceEffect\(kind, amount\)/);
  const cancel = adj.slice(adj.indexOf('export async function executeCancelAdjustment('));
  assert.match(cancel, /action: 'ADJUSTMENT_UPDATED'[\s\S]*amount: -adjustmentBalanceEffect\(adj\.kind, amount\)/);
  // العُرف موثّقٌ في خدمة أحداث المستندات
  assert.match(read('services/customerActivityDocs.ts'), /أثره الموقَّع على رصيد العميل\*\* = مدين − دائن/);
});

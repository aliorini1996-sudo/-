// ZATCA المرحلة الثانية (Z5.4) — إبطال الفاتورة المرفوضة وسحب المعلّقة على مستوى الخدمة (بلا قاعدة بيانات ولا شبكة).
//
// عميل Prisma **مزيّف** يُحقن في ذاكرة الوحدات قبل تحميل الخدمة، فيُنفَّذ منطقها الحقيقي كاملاً: القفل، وترتيبه،
// وعكس القيود، والإشعار. المطلوب إثباته:
//   ١) قرار المالك Q1: النقدية المرفوضة يُعكس شقّ الفاتورة وحده — `totalCollected` لا يُمسّ، ويصير المحصَّل رصيداً
//      دائناً للعميل يُسدَّد به البديل. والآجلة يُعكس مدينها كاملاً كما كان الإلغاء يفعل.
//   ٢) الوضع 'CANCEL' (مسار الإلغاء القديم) لم يتغيّر حرفاً: النقدية تُعكس بشقّيها كما كانت.
//   ٣) ترتيب القفل: الفاتورة (FOR UPDATE) قبل صفّ العميل — وهو الترتيب نفسه في مسار الإصدار.
//   ٤) نقد 11: السحب يُحسم المستند ثمّ يُبطل الفاتورة في **معاملة واحدة**، ولا يمرّ بلا دليل.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

// ═══ العميل المزيّف ═══

interface Recorded { model: string; op: string; args: unknown }

let calls: Recorded[] = [];
let scripted: Record<string, (args: unknown) => unknown> = {};
/** نصوص SQL الخام التي مرّت (لإثبات القفل وترتيبه). */
let raws: string[] = [];
let executeResult = 1;

function defaultFor(op: string): unknown {
  if (op === 'findMany') return [];
  if (op === 'count') return 0;
  if (op === 'aggregate') return { _sum: { debit: 0, credit: 0 } };
  if (op === 'updateMany' || op === 'deleteMany') return { count: 0 };
  return null;
}

const modelProxy = (model: string): unknown => new Proxy({}, {
  get: (_t, op: string) => async (args: unknown) => {
    calls.push({ model, op, args });
    const fn = scripted[`${model}.${op}`];
    return fn ? fn(args) : defaultFor(op);
  },
});

const sqlOf = (strings: TemplateStringsArray | string[]): string => [...strings].join('?').replace(/\s+/g, ' ').trim();

const prismaFake: Record<string, unknown> = new Proxy({}, {
  get: (_t, key: string) => {
    if (key === '$transaction') {
      return async (arg: unknown) => {
        calls.push({ model: '$transaction', op: 'begin', args: null });
        return typeof arg === 'function' ? (arg as (tx: unknown) => Promise<unknown>)(prismaFake) : arg;
      };
    }
    if (key === '$queryRaw') {
      return async (strings: TemplateStringsArray, ...vals: unknown[]) => {
        const sql = sqlOf(strings);
        raws.push(sql);
        calls.push({ model: '$queryRaw', op: sql.slice(0, 40), args: vals });
        const fn = scripted[`$queryRaw:${sql.includes('FROM invoices') ? 'invoice' : 'customer'}`];
        return fn ? fn(vals) : [];
      };
    }
    if (key === '$executeRaw') {
      return async (strings: TemplateStringsArray, ...vals: unknown[]) => {
        const sql = sqlOf(strings);
        raws.push(sql);
        calls.push({ model: '$executeRaw', op: sql.slice(0, 40), args: vals });
        return executeResult;
      };
    }
    if (key === 'then') return undefined;
    return modelProxy(key);
  },
});

stub('config/database', { default: prismaFake });

// eslint-disable-next-line @typescript-eslint/no-var-requires
const service = require('../services/invoiceVoid') as typeof import('../services/invoiceVoid');
const { reverseInvoiceInTx, voidInvoiceInTx, withdrawPhase2Invoice } = service;

const TENANT = 't-void';
const NOW = new Date('2026-12-01T12:00:00.000Z');

const INVOICE_ROW = {
  id: 'inv-1', tenantId: TENANT, number: 'INV-2612-000004', status: 'CONFIRMED', type: 'CREDIT', zatcaPhase: 2,
  invoiceSubtype: '01', einvoiceStatus: 'rejected', customerId: 'c-1', total: 115,
};

function reset(o: { invoice?: Record<string, unknown> | null; balance?: number } = {}): void {
  calls = [];
  raws = [];
  executeResult = 1;
  const row = o.invoice === undefined ? INVOICE_ROW : o.invoice;
  scripted = {
    '$queryRaw:invoice': () => (row ? [row] : []),
    '$queryRaw:customer': () => [{ id: 'c-1' }],
    'accountEntry.aggregate': () => ({ _sum: { debit: o.balance ?? 115, credit: 0 } }),
    'invoice.update': (args: unknown) => ({ ...row, ...((args as { data?: Record<string, unknown> }).data ?? {}) }),
  };
}

const entries = () => calls.filter(c => c.model === 'accountEntry' && c.op === 'create')
  .map(c => (c.args as { data: { type: string; debit: number; credit: number; description: string } }).data);
const customerUpdates = () => calls.filter(c => c.model === 'customer' && c.op === 'update')
  .map(c => (c.args as { data: Record<string, unknown> }).data);

// ═══ عكس القيود ═══

test('الوضع CANCEL يبقى سلوك الإلغاء القديم حرفاً: النقدية تُعكس بشقّيها', async () => {
  reset();
  await reverseInvoiceInTx(prismaFake as never, { id: 'inv-1', tenantId: TENANT, type: 'CASH', customerId: 'c-1', total: 115 }, 'CANCEL');
  const e = entries();
  assert.deepEqual(e.map(x => x.type), ['INVOICE_CREDIT', 'RECEIPT_DEBIT']);
  assert.deepEqual(customerUpdates()[0], { totalSales: { decrement: 115 }, totalCollected: { decrement: 115 } });
});

test('قرار المالك Q1: النقدية المرفوضة يُعكس شقّ الفاتورة وحده، والتحصيل يبقى رصيداً دائناً', async () => {
  reset();
  await reverseInvoiceInTx(prismaFake as never, { id: 'inv-1', tenantId: TENANT, type: 'CASH', customerId: 'c-1', total: 115 }, 'ZATCA_VOID');
  const e = entries();
  assert.deepEqual(e.map(x => x.type), ['INVOICE_CREDIT'], 'عُكس التحصيل — وهو ما نهى عنه القرار');
  assert.equal(e[0].credit, 115);
  assert.ok(e[0].description.includes('رصيد دائن'), 'الوصف لا يشرح للمحاسب لماذا بقي المحصَّل');
  const u = customerUpdates()[0];
  assert.equal(u.totalSales !== undefined, true);
  assert.equal(u.totalCollected, undefined, 'نقص المحصَّل من العميل — أي أنّ تحصيل المندوب عُكس');
  assert.equal(u.balance, 0, 'الرصيد لم يُضبط بالمجموع');
});

test('الآجلة والمرتجع لا يتغيّر عكسهما بين الوضعين', async () => {
  for (const mode of ['CANCEL', 'ZATCA_VOID'] as const) {
    reset();
    await reverseInvoiceInTx(prismaFake as never, { id: 'inv-1', tenantId: TENANT, type: 'CREDIT', customerId: 'c-1', total: 115 }, mode);
    assert.deepEqual(entries().map(x => x.type), ['INVOICE_CREDIT'], mode);
    reset();
    await reverseInvoiceInTx(prismaFake as never, { id: 'inv-1', tenantId: TENANT, type: 'RETURN', customerId: 'c-1', total: 115 }, mode);
    assert.deepEqual(entries().map(x => x.type), ['INVOICE_DEBIT'], mode);
  }
});

// ═══ الإبطال داخل المعاملة ═══

test('الإبطال: قفل الفاتورة ثم العميل، ثم CANCELLED وعكسٌ وإشعار', async () => {
  reset();
  const out = await voidInvoiceInTx(prismaFake as never, {
    tenantId: TENANT, invoiceId: 'inv-1', subtype: '01', reason: 'REJECTED', documentId: 'doc-1',
    errors: [{ code: 'BR-KSA-01', message: 'الرقم الضريبي غير صالح' }], at: NOW,
  });
  assert.deepEqual(out, { voided: true, refusal: null, number: 'INV-2612-000004', reversal: 'CREDIT' });

  // ترتيب القفل: invoices قبل customers
  const inv = raws.findIndex(s => s.includes('FROM invoices') && s.includes('FOR UPDATE'));
  const cust = raws.findIndex(s => s.includes('FROM customers') && s.includes('FOR UPDATE'));
  assert.ok(inv >= 0, 'صفّ الفاتورة لم يُقفل');
  assert.ok(cust > inv, 'قُفل العميل قبل الفاتورة — ترتيبٌ يخالف مسار الإصدار فيتشابك القفلان');

  const upd = calls.find(c => c.model === 'invoice' && c.op === 'update');
  assert.deepEqual((upd?.args as { data: unknown }).data, { status: 'CANCELLED' }, 'المرآة تُكتب هنا رغم أنّ المحرّك كتبها');
  const note = calls.find(c => c.model === 'notification' && c.op === 'create');
  const data = (note?.args as { data: { type: string; body: string; data: string } }).data;
  assert.equal(data.type, 'ZATCA_INVOICE_REJECTED');
  assert.ok(data.body.includes('INV-2612-000004'));
  assert.ok(JSON.parse(data.data).errors[0].message.includes('الرقم الضريبي'), 'رسالة الهيئة لم تصل الإدارة');
});

test('المبسّطة لا تُبطل ولو مرّت من الخطّاف (ورقتها مع المشتري)', async () => {
  reset({ invoice: { ...INVOICE_ROW, invoiceSubtype: '02' } });
  const out = await voidInvoiceInTx(prismaFake as never, {
    tenantId: TENANT, invoiceId: 'inv-1', subtype: '02', reason: 'REJECTED', documentId: 'doc-1', at: NOW,
  });
  assert.deepEqual(out, { voided: false, refusal: 'SIMPLIFIED_KEPT', number: 'INV-2612-000004', reversal: null });
  assert.equal(calls.some(c => c.model === 'invoice' && c.op === 'update'), false, 'كُتب شيء رغم الرفض');
  assert.equal(entries().length, 0);
});

test('صفّ غير متوقَّع (شركة أخرى، ملغاة سلفاً) يُرفض بلا رمي — نتيجة الهيئة لا تُلغى لأجله', async () => {
  for (const [row, refusal] of [
    [{ ...INVOICE_ROW, tenantId: 'other' }, 'TENANT_MISMATCH'],
    [{ ...INVOICE_ROW, status: 'CANCELLED' }, 'NOT_CONFIRMED'],
    [null, 'NOT_FOUND'],
  ] as const) {
    reset({ invoice: row });
    const out = await voidInvoiceInTx(prismaFake as never, {
      tenantId: TENANT, invoiceId: 'inv-1', subtype: '01', reason: 'REJECTED', documentId: 'doc-1', at: NOW,
    });
    assert.equal(out.voided, false, refusal);
    assert.equal(out.refusal, refusal);
  }
});

test('السحب يكتب المرآة withdrawn بنفسه (المحرّك لم يكتبها — لا نتيجة هيئة هنا)', async () => {
  reset();
  await voidInvoiceInTx(prismaFake as never, {
    tenantId: TENANT, invoiceId: 'inv-1', subtype: '01', reason: 'WITHDRAWN', documentId: 'doc-1', at: NOW, mirror: 'withdrawn',
  });
  const upd = calls.find(c => c.model === 'invoice' && c.op === 'update');
  assert.deepEqual((upd?.args as { data: unknown }).data, { status: 'CANCELLED', einvoiceStatus: 'withdrawn' });
  const note = calls.find(c => c.model === 'notification' && c.op === 'create');
  assert.equal((note?.args as { data: { type: string } }).data.type, 'ZATCA_INVOICE_WITHDRAWN');
});

// ═══ السحب الإداريّ (نقد 11) ═══

const PROJECTION = {
  id: 'doc-1', egsUnitId: 'u-1', attemptNo: 1, icv: 5, uuid: 'U', pih: 'P', invoiceHash: 'H', typeCode: '388',
  typeName: '0100000', issueDate: '2026-12-01', issueTime: '12:00:00', flow: 'CLEARANCE', qr: 'Q', clearedQr: null,
  status: 'CONFIG_ERROR', httpStatus: null, validation: null, attempts: 0, sentAttempts: 0, nextAttemptAt: null, leaseUntil: null,
  firstSubmitAt: null,
  finalizedAt: null, reportDeadline: null, keyVersion: 1, createdAt: NOW, updatedAt: NOW, egsUnit: { environment: 'production' },
};

/** عدّ سجلّ الطلبات: الاستعلام بشرط OR هو «قد وصلت»، والمجرَّد هو عدد المحاولات المسجَّلة. */
const isDeliveredCount = (args: unknown): boolean =>
  Array.isArray((args as { where?: { OR?: unknown[] } } | null)?.where?.OR);

function scriptWithdraw(o: {
  invoice?: Record<string, unknown> | null; doc?: Record<string, unknown> | null; delivered?: number; logged?: number;
} = {}): void {
  reset({ invoice: { ...INVOICE_ROW, einvoiceStatus: 'clearance_blocked' } });
  scripted['invoice.findFirst'] = () => (o.invoice === undefined ? { ...INVOICE_ROW, einvoiceStatus: 'clearance_blocked' } : o.invoice);
  scripted['zatcaDocument.findFirst'] = () => (o.doc === undefined ? PROJECTION : o.doc);
  scripted['zatcaApiLog.count'] = (args: unknown) => (isDeliveredCount(args) ? (o.delivered ?? 0) : (o.logged ?? 0));
}

test('سحبٌ مؤهَّل: المستند WITHDRAWN والفاتورة مُبطلة في معاملة واحدة', async () => {
  scriptWithdraw();
  const r = await withdrawPhase2Invoice({ tenantId: TENANT, invoiceId: 'inv-1', now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.decision.ok === true && r.decision.proof, 'NEVER_SENT');
  assert.equal(r.outcome?.voided, true);
  // معاملة واحدة تضمّ حسم المستند وإبطال الفاتورة
  const tx = calls.findIndex(c => c.model === '$transaction');
  const cas = calls.findIndex(c => c.model === '$executeRaw');
  const upd = calls.findIndex(c => c.model === 'invoice' && c.op === 'update');
  assert.ok(tx >= 0 && cas > tx && upd > cas, 'حسم المستند وإبطال الفاتورة ليسا في معاملة واحدة بهذا الترتيب');
  assert.ok(raws.some(s => s.includes('WITHDRAWN') || s.includes('UPDATE zatca_documents')), 'لم يُحسم المستند');
});

test('محاولة قد تكون وصلت الهيئة ⇒ لا سحب ولا كتابة', async () => {
  scriptWithdraw({ doc: { ...PROJECTION, firstSubmitAt: new Date(NOW.getTime() - 60_000) }, delivered: 1 });
  const r = await withdrawPhase2Invoice({ tenantId: TENANT, invoiceId: 'inv-1', now: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.decision.ok === false && r.decision.refusal, 'MAY_HAVE_BEEN_RECEIVED');
  assert.equal(calls.some(c => c.model === 'invoice' && c.op === 'update'), false);
  assert.equal(calls.some(c => c.model === '$transaction'), false, 'فُتحت معاملة رغم رفض القرار');
});

test('سباق: عاملٌ استولى على المستند بين القرار والمعاملة ⇒ لا سحب ورسالةٌ مفهومة', async () => {
  scriptWithdraw();
  executeResult = 0; // شرط الحالة/العقد لم يتحقّق
  const r = await withdrawPhase2Invoice({ tenantId: TENANT, invoiceId: 'inv-1', now: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.decision.ok === false && r.decision.refusal, 'IN_FLIGHT');
  assert.equal(calls.some(c => c.model === 'invoice' && c.op === 'update'), false, 'أُبطلت الفاتورة ومستندها لم يُحسم');
});

test('فاتورة غير موجودة أو من المرحلة الأولى ⇒ رفضٌ بلا أيّ قراءة للمستند', async () => {
  scriptWithdraw({ invoice: null });
  const r = await withdrawPhase2Invoice({ tenantId: TENANT, invoiceId: 'inv-x', now: NOW });
  assert.equal(r.ok, false);
  assert.equal(calls.some(c => c.model === 'zatcaDocument'), false, 'قُرئ المستند لفاتورة غير موجودة');
});

test('بلا مستند ضريبي ⇒ رفض NO_DOCUMENT (لا سحب لما لا وجود له)', async () => {
  scriptWithdraw({ doc: null });
  const r = await withdrawPhase2Invoice({ tenantId: TENANT, invoiceId: 'inv-1', now: NOW });
  assert.equal(r.decision.ok === false && r.decision.refusal, 'NO_DOCUMENT');
});

/* مراجعة عدائية: صفّ السجلّ يُكتب بعد انتهاء التبادل و«لا يُفشل الإرسال» إن سقط — فمحاولةٌ **غادرت** بلا سجلّ تعني
 * بايتات مصيرها مجهول (موت العملية عند نشر Render). الدليل عدّاد الإرسال الفعليّ لا عدّاد المطالبة. */
/* مراجعة عدائية: Q1 قرارُ **رفض الهيئة** (البضاعة سُلّمت والمال حُصّل والبديل قادم). أمّا السحب الإداريّ فمخرجُ
 * فاتورةٍ لم تصل الهيئة أصلاً — غالبه رفض العميل للبضاعة وردّ النقد له، فيُعكس التحصيل كاملاً كالإلغاء اليدويّ،
 * وإلّا بقي في الدفاتر رصيدٌ دائن وهميّ لعميلٍ استردّ ماله. */
test('السحب على فاتورة نقدية يعكس التحصيل أيضاً (لا يطبّق Q1)، والرفض وحده يُبقيه رصيداً دائناً', async () => {
  const cash = { ...INVOICE_ROW, type: 'CASH', einvoiceStatus: 'clearance_blocked' };
  scriptWithdraw({ invoice: cash });
  scripted['$queryRaw:invoice'] = () => [cash];
  const r = await withdrawPhase2Invoice({ tenantId: TENANT, invoiceId: 'inv-1', now: NOW });
  assert.equal(r.ok, true);
  assert.deepEqual(entries().map(x => x.type), ['INVOICE_CREDIT', 'RECEIPT_DEBIT'], 'السحب أبقى تحصيلاً لم يبقَ بيد المندوب');
  assert.equal(customerUpdates()[0].totalCollected !== undefined, true, 'المحصَّل لم يُعكس مع السحب');

  // الرفض على الفاتورة نفسها: شقّ الفاتورة وحده (Q1)
  reset({ invoice: cash });
  await voidInvoiceInTx(prismaFake as never, {
    tenantId: TENANT, invoiceId: 'inv-1', subtype: '01', reason: 'REJECTED', documentId: 'doc-1', at: NOW,
  });
  assert.deepEqual(entries().map(x => x.type), ['INVOICE_CREDIT']);
  const note = calls.find(c => c.model === 'notification' && c.op === 'create');
  const body = String(((note?.args as { data?: { body?: string } })?.data?.body) ?? '');
  assert.ok(body.includes('رصيداً دائناً'), 'الإشعار لا يذكر الرصيد الدائن للمدير');
  assert.ok(body.includes('115.00'), 'الإشعار لا يذكر مبلغ الرصيد');
  assert.ok(body.includes('مخزون السيارة'), 'الإشعار لا ينبّه أنّ الكمّيات عادت إلى رصيد السيارة');
});

test('محاولةٌ غادرت ولم تخلّف سجلّاً ⇒ لا سحب ولا كتابة (عدّ «قد وصلت» صفر لا يكفي)', async () => {
  scriptWithdraw({ doc: { ...PROJECTION, attempts: 1, sentAttempts: 1, firstSubmitAt: new Date(NOW.getTime() - 120_000) }, delivered: 0, logged: 0 });
  const r = await withdrawPhase2Invoice({ tenantId: TENANT, invoiceId: 'inv-1', now: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.decision.ok === false && r.decision.refusal, 'MAY_HAVE_BEEN_RECEIVED');
  assert.equal(calls.some(c => c.model === '$transaction'), false, 'فُتحت معاملة رغم غياب الدليل');
});

/* مراجعة عدائية ٢ (النتائج 3/4/8): `attempts` يرفعه الاستيلاء قبل أيّ فحص، فالمستند المحسوم محلياً (شهادة مجدَّدة،
 * بيانات اعتماد ناقصة، إيقاف 429) كان يبدو «ربّما وصل» فيُحبس أبداً: لا سحب، ولا موعد استرداد للاعتماد، ولا إعادة
 * إصدار لقياسية. عدّاد الإرسال الفعليّ يفكّ الحبس. */
test('استيلاءات بلا نداء (attempts>0 وsentAttempts=0) ⇒ سحبٌ بدليل NEVER_SENT وحسمٌ مُسيَّج', async () => {
  scriptWithdraw({
    doc: { ...PROJECTION, attempts: 3, sentAttempts: 0, firstSubmitAt: new Date(NOW.getTime() - 3_600_000) },
    delivered: 0, logged: 0,
  });
  const r = await withdrawPhase2Invoice({ tenantId: TENANT, invoiceId: 'inv-1', now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.decision.ok === true && r.decision.proof, 'NEVER_SENT');
  const cas = calls.find(c => c.model === '$executeRaw' && String(c.op).includes('UPDATE zatca_documents'));
  assert.ok(cas, 'لم يُحسم المستند');
  assert.ok((cas.args as unknown[]).includes(3), 'جملة الحسم غير مُسيَّجة بعدّاد المطالبة المقروء');
});

test('كل محاولة لها سجلّها وكلّها 401 ⇒ سحبٌ بدليل ALL_ATTEMPTS_REFUSED، وتسييج المعاملة بعدّاد المحاولات', async () => {
  scriptWithdraw({ doc: { ...PROJECTION, attempts: 2, sentAttempts: 2, firstSubmitAt: new Date(NOW.getTime() - 120_000) }, delivered: 0, logged: 2 });
  const r = await withdrawPhase2Invoice({ tenantId: TENANT, invoiceId: 'inv-1', now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.decision.ok === true && r.decision.proof, 'ALL_ATTEMPTS_REFUSED');
  const cas = calls.find(c => c.model === '$executeRaw' && String(c.op).includes('UPDATE zatca_documents'));
  assert.ok(cas, 'لم يُحسم المستند');
  assert.ok((cas.args as unknown[]).includes(2), 'جملة الحسم غير مُسيَّجة بعدّاد المحاولات المقروء');
});

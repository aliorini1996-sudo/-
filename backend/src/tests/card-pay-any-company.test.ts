// «التحصيل بالبطاقة لأي شركة» (طلب المالك ١ نوفمبر ٢٠٢٦) — بعميل Prisma مزيّف (بلا قاعدة) عبر الموجّه والخدمة الحقيقيين:
//   • «لوحة المالك تكفي»: الشركة التي فعّلها المالك وربط تاجرها تُحصّل على بيئة الاختبار بلا NEARPAY_SANDBOX_TENANTS، والقائمة
//     تبقى سماحاً إضافياً اختيارياً؛ غير المفعّلة أو بلا تاجر محجوبة كما كانت، وبيئة الإنتاج كما هي.
//   • cardPayTest في GET /api/company صادقٌ على بيئة الاختبار وحدها، بلا اسم مزوّد الدفع ولا معرّف التاجر في الرد.
//   • لا يظهر اسم مزوّد الدفع لمستخدمي الشركة ولا للمندوب: ردود الإصدار والتسليم، والسند والإشعار، وتفاصيل العمليات —
//     وحارسٌ نصّي يمسح نصوص الملفات التي تصل الشركة (والمسموح للمالك وحده مسمّى صراحة).
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';

const SRC = path.join(__dirname, '..');
const BRAND = /near[\s_-]*pay|نير[\s_-]*باي/i;

// ═══ Prisma مزيّف: كل نداءٍ يُسجَّل، والردود مبرمجة بالمفتاح «جدول.طريقة» ═══
/* eslint-disable @typescript-eslint/no-explicit-any */
type Call = { op: string; args: any };
let calls: Call[] = [];
let scripted: Record<string, (args: any) => unknown> = {};
let rawScript: (sql: string) => unknown = () => undefined;
function defaultFor(method: string): unknown {
  if (method === 'findMany' || method === 'groupBy') return [];
  if (method === 'count') return 0;
  if (method === 'aggregate') return { _sum: {} };
  if (method === 'updateMany' || method === 'deleteMany' || method === 'createMany') return { count: 0 };
  return null;
}
const prismaFake: any = new Proxy({}, {
  get: (_t, key: string) => {
    if (key === '$transaction') {
      return async (arg: unknown) => (typeof arg === 'function' ? (arg as (tx: unknown) => Promise<unknown>)(prismaFake) : Promise.all(arg as Promise<unknown>[]));
    }
    if (key === '$queryRaw' || key === '$executeRaw') {
      return async (strings: TemplateStringsArray) => {
        const sql = strings.join('?');
        calls.push({ op: key, args: sql });
        const out = rawScript(sql);
        return out !== undefined ? out : (key === '$queryRaw' ? [] : 0);
      };
    }
    if (key === 'then') return undefined;
    return new Proxy({}, {
      get: (_m, method: string) => async (args: unknown) => {
        calls.push({ op: `${key}.${method}`, args });
        const fn = scripted[`${key}.${method}`];
        return fn ? fn(args) : defaultFor(method);
      },
    });
  },
});
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};
stub('config/database', { default: prismaFake });
stub('services/mailer', { async sendMail() { return true; }, mailLayout: () => '' });

const TENANT = 'T1';
let currentUser: Record<string, unknown> = { id: 'rep-1', role: 'SALES_REP', name: 'مندوب', tenantId: TENANT };
const pass = (_req: unknown, _res: unknown, next: () => void): void => next();
/* eslint-disable @typescript-eslint/no-var-requires */
const realAuth = require('../middleware/auth') as Record<string, unknown>;
stub('middleware/auth', {
  ...realAuth,
  authenticate: (req: { user?: unknown }, _res: unknown, next: () => void) => { req.user = currentUser; next(); },
  requireAdmin: pass, requireAccounting: pass, requireAdminPermission: () => pass,
  tenantId: (req: { user?: { tenantId?: string } }) => req.user?.tenantId ?? '',
});
const companyModule = require('../routes/company') as typeof import('../routes/company');
const cardPaymentsModule = require('../routes/cardPayments') as typeof import('../routes/cardPayments');
const svc = require('../services/cardPayment') as typeof import('../services/cardPayment');
/* eslint-enable @typescript-eslint/no-var-requires */

let server: { port: number; close: () => Promise<void> } | null = null;
after(async () => { await server?.close(); server = null; });
// fetch الحقيقي محفوظٌ قبل أي استبدال — الاختبارات التي تزيّف ردود المزوّد تستبدل globalThis.fetch والطلب إلى خادمنا لا يمرّ به
const realFetch = globalThis.fetch;
async function call(method: string, url: string, body?: unknown): Promise<{ status: number; body: Record<string, any> }> {
  if (!server) {
    const app = express();
    app.use(express.json());
    app.use('/api/company', companyModule.default);
    app.use('/api/card-payments', cardPaymentsModule.default);
    app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(500).json({ success: false, message: err.message }); });
    const s = http.createServer(app);
    await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
    server = { port: (s.address() as AddressInfo).port, close: () => new Promise<void>((r) => { s.closeAllConnections?.(); s.close(() => r()); }) };
  }
  const r = await realFetch(`http://127.0.0.1:${server.port}${url}`, {
    method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const t = await r.text();
  return { status: r.status, body: t ? JSON.parse(t) as Record<string, any> : {} };
}
const getCompany = (): Promise<{ status: number; body: Record<string, any> }> => call('GET', '/api/company');

// ═══ البيئة: خادم إنتاج على بيئة اختبار المزوّد — كما على Render اليوم، بلا قائمة شركات ═══
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const ENV_KEYS = [
  'NEARPAY_ENV', 'NODE_ENV', 'NEARPAY_SANDBOX_TENANTS', 'NEARPAY_API_KEY', 'NEARPAY_API_BASE', 'CARD_PAY_APP_READY',
  'NEARPAY_JWT_PRIVATE_KEY', 'NEARPAY_CLIENT_UUID', 'NEARPAY_GCP_PROJECT_NUMBER',
] as const;
async function withEnv(over: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>, fn: () => Promise<void> | void): Promise<void> {
  const prev = ENV_KEYS.map((k) => process.env[k]);
  const base: Record<string, string | undefined> = {
    NEARPAY_ENV: 'sandbox', NODE_ENV: 'production', NEARPAY_SANDBOX_TENANTS: undefined, NEARPAY_API_KEY: 'test-key',
    NEARPAY_API_BASE: undefined, CARD_PAY_APP_READY: '1',
    NEARPAY_JWT_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), NEARPAY_CLIENT_UUID: 'test-client',
    NEARPAY_GCP_PROJECT_NUMBER: '123456789012', ...over,
  };
  for (const k of ENV_KEYS) { if (base[k] === undefined) delete process.env[k]; else process.env[k] = base[k]; }
  try { await fn(); } finally {
    ENV_KEYS.forEach((k, i) => { if (prev[i] === undefined) delete process.env[k]; else process.env[k] = prev[i]; });
  }
}
const PROD = { NEARPAY_ENV: 'production', NEARPAY_API_BASE: 'https://api.example.test/v1' };
const MERCHANT = '7d0b1c2e-3f40-4a5b-8c6d-7e8f90a1b2c3';

function reset(): void {
  calls = [];
  rawScript = () => undefined;
  currentUser = { id: 'rep-1', role: 'SALES_REP', name: 'مندوب', tenantId: TENANT };
  scripted = {};
}

test('GET /api/company: تفعيل المالك وتاجر الشركة يكفيان على بيئة الاختبار — وcardPayTest صادق بلا اسم المزوّد ولا معرّف التاجر', async () => {
  reset();
  currentUser = { id: 'admin-1', role: 'ADMIN', name: 'مدير', tenantId: TENANT };
  let tenantRow: Record<string, unknown> = {};
  scripted['companySettings.findUnique'] = () => ({ tenantId: TENANT, name: 'شركة', currency: 'SAR' });
  scripted['tenant.findUnique'] = () => tenantRow;
  const flags = async () => {
    const r = await getCompany();
    assert.equal(r.status, 200);
    assert.doesNotMatch(JSON.stringify(r.body), BRAND);
    assert.equal('nearpayMerchantId' in r.body.data, false);
    return { available: r.body.data.cardPayAvailable, test: r.body.data.cardPayTest };
  };
  await withEnv({}, async () => {
    // الحال على Render اليوم بلا قائمة: الشركة المفعّلة بتاجرها متاحة — في وضع الاختبار
    tenantRow = { cardPayEnabled: true, nearpayMerchantId: MERCHANT };
    assert.deepEqual(await flags(), { available: true, test: true });
    // مفعّلة بلا تاجر، أو تاجرٌ بلا تفعيل: محجوبة كما كانت
    tenantRow = { cardPayEnabled: true, nearpayMerchantId: null };
    assert.deepEqual(await flags(), { available: false, test: false });
    tenantRow = { cardPayEnabled: false, nearpayMerchantId: MERCHANT };
    assert.deepEqual(await flags(), { available: false, test: false });
  });
  // القائمة القديمة سماحٌ إضافي اختياري (توافق)
  await withEnv({ NEARPAY_SANDBOX_TENANTS: ` x , ${TENANT} ` }, async () => {
    tenantRow = { cardPayEnabled: true, nearpayMerchantId: null };
    assert.deepEqual(await flags(), { available: true, test: true });
  });
  // بيئة الإنتاج كما كانت: لا وضع اختبار، والإتاحة بالتفعيل وحده كما قبل
  await withEnv(PROD, async () => {
    tenantRow = { cardPayEnabled: true, nearpayMerchantId: MERCHANT };
    assert.deepEqual(await flags(), { available: true, test: false });
    tenantRow = { cardPayEnabled: true, nearpayMerchantId: null };
    assert.deepEqual(await flags(), { available: true, test: false });
    tenantRow = { cardPayEnabled: false, nearpayMerchantId: MERCHANT };
    assert.deepEqual(await flags(), { available: false, test: false });
  });
  // خارج الإنتاج (تطوير) حرّة كما كانت — ووضع الاختبار يُعرض
  await withEnv({ NODE_ENV: 'development' }, async () => {
    tenantRow = { cardPayEnabled: true, nearpayMerchantId: null };
    assert.deepEqual(await flags(), { available: true, test: true });
  });
});

const INVOICE_ID = '0b5c8a1e-1111-4a2b-9c3d-4e5f6a7b8c9d';
function scriptIssue(tenant: Record<string, unknown>): void {
  scripted['invoice.findFirst'] = () => ({ id: INVOICE_ID, number: 'INV-2026-0042', status: 'CONFIRMED', type: 'SALE', customerId: 'c1', remainingAmt: 115, einvoiceStatus: null });
  scripted['salesRep.findFirst'] = () => ({ id: 'rep-1', isActive: true, nearpayTid: '0212184900121849' });
  scripted['companySettings.findUnique'] = () => ({ currency: 'SAR' });
  scripted['tenant.findUnique'] = () => tenant;
  scripted['cardPayment.create'] = ({ data }) => ({ id: 'cp-1', ...data });
}

test('الإصدار: الشركة المفعّلة بتاجرها تُصدر على بيئة الاختبار بلا قائمة — والرد يقول «اختبار» ولا يسمّي المزوّد', async () => {
  reset();
  await withEnv({}, async () => {
    scriptIssue({ cardPayEnabled: true, nearpayMerchantId: MERCHANT });
    const out = await svc.createCardPayment({ tenantId: TENANT, invoiceId: INVOICE_ID, salesRepId: 'rep-1' });
    assert.equal(out.amountHalalas, 11500);
    assert.equal(out.test, true);
    assert.doesNotMatch(JSON.stringify(out), BRAND);
    assert.ok(calls.some((c) => c.op === 'cardPayment.create'));

    // تاجرٌ بلا تفعيل المالك: محجوبة على بيئة الاختبار برسالة محايدة
    reset();
    scriptIssue({ cardPayEnabled: false, nearpayMerchantId: MERCHANT });
    await assert.rejects(svc.createCardPayment({ tenantId: TENANT, invoiceId: INVOICE_ID, salesRepId: 'rep-1' }), (e: any) => {
      assert.equal(e.code, 'CARD_PAY_SANDBOX');
      assert.doesNotMatch(e.message, BRAND);
      return true;
    });
    assert.ok(!calls.some((c) => c.op === 'cardPayment.create'));

    // بلا تاجر: الرمز كما كان والرسالة محايدة
    reset();
    scriptIssue({ cardPayEnabled: true, nearpayMerchantId: null });
    await assert.rejects(svc.createCardPayment({ tenantId: TENANT, invoiceId: INVOICE_ID, salesRepId: 'rep-1' }), (e: any) => {
      assert.equal(e.code, 'CARD_PAY_NO_MERCHANT');
      assert.doesNotMatch(e.message, BRAND);
      return true;
    });
  });
  await withEnv(PROD, async () => {
    reset();
    scriptIssue({ cardPayEnabled: true, nearpayMerchantId: MERCHANT });
    const out = await svc.createCardPayment({ tenantId: TENANT, invoiceId: INVOICE_ID, salesRepId: 'rep-1' });
    assert.equal(out.test, false);
  });
});

test('التسليم: رمز الشركة المفعّلة بتاجرها يُستبدل على بيئة الاختبار بلا قائمة — وغير المفعّلة يسقط', async () => {
  reset();
  const launchRow = (tenant: Record<string, unknown>) => ({
    id: 'cp-1', tenantId: TENANT, status: 'pending', launchedAt: null, launchExpiresAt: new Date(Date.now() + 5 * 60_000),
    amount: 115, amountHalalas: 11500, reference: 'INV-2026-0042', tid: '0212184900121849',
    customer: { name: 'عميل' }, tenant: { name: 'شركة', ...tenant },
    invoice: { status: 'CONFIRMED', type: 'SALE', remainingAmt: 115, einvoiceStatus: null },
    salesRep: { isActive: true, nearpayTid: '0212184900121849', name: 'مندوب' },
  });
  await withEnv({}, async () => {
    scripted['cardPayment.findUnique'] = () => launchRow({ cardPayEnabled: true, nearpayMerchantId: MERCHANT });
    scripted['cardPayment.updateMany'] = () => ({ count: 1 });
    const p = await svc.redeemLaunchToken('t'.repeat(32));
    assert.equal(p.environment, 'SANDBOX');
    assert.equal(p.amountHalalas, 11500);
    const { jwt: _jwt, ...shown } = p;
    void _jwt;
    assert.doesNotMatch(JSON.stringify(shown), BRAND);

    reset();
    scripted['cardPayment.findUnique'] = () => launchRow({ cardPayEnabled: false, nearpayMerchantId: MERCHANT });
    await assert.rejects(svc.redeemLaunchToken('t'.repeat(32)), (e: any) => e.code === 'CARD_PAY_STALE' && !BRAND.test(e.message));
  });
});

// ═══ القيد على بيئة الاختبار: السند والإشعار موسومان «اختبار» ولا يسمّيان المزوّد ═══
const INTENT = 'c1b2a3d4-0000-4000-8000-000000000001';
const approvedIntent = {
  details: {
    intenet_id: INTENT, reference_id: 'INV-2026-0042', type: 'purchase', status: 'approved', amount: '11500',
    transactions: [{
      id: 'tx-1', status: 'approved', card: { pan: '4111********1111' }, amount: '11500',
      events: [{
        rrn: '630115000123', stan: '000123', type: 'purchase', status: 'approved',
        receipt: {
          standard: 'mada', id: 'rc-1',
          data: {
            tid: '0212184900121849', pan: '4111********1111', card_scheme: { name: { english: 'VISA' } }, is_approved: true,
            approval_code: { value: '474747' }, transaction_type: { name: { english: 'PURCHASE' } },
            transaction_uuid: 'b6e5d4c3-1111-4222-8333-444455556666', amount_authorized: { value: '115.00' },
            system_trace_audit_number: '000123', retrieval_reference_number: '630115000123',
          },
        },
      }],
    }],
  },
};

test('القيد على بيئة الاختبار: السند «نقطة البيع» وملاحظته والإشعار موسومة «اختبار» — بلا اسم المزوّد', async () => {
  reset();
  const prevFetch = globalThis.fetch;
  const payRow = {
    id: INTENT, tenantId: TENANT, invoiceId: INVOICE_ID, customerId: 'c1', salesRepId: 'rep-1', status: 'pending', amount: 115,
    amountHalalas: 11500, tid: '0212184900121849', reference: 'INV-2026-0042', createdAt: new Date(Date.now() - 60_000),
    transactionUuid: null, receiptId: null, statusDetail: null,
  };
  try {
    globalThis.fetch = (async () => new Response(JSON.stringify(approvedIntent), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
    await withEnv({}, async () => {
      scripted['cardPayment.findUnique'] = ({ include }) => (include ? { ...payRow, invoice: { number: 'INV-2026-0042', teamId: null, einvoiceStatus: null } } : payRow);
      scripted['cardPayment.updateMany'] = () => ({ count: 1 });
      scripted['receipt.create'] = ({ data }) => ({ id: 'r-1', ...data });
      rawScript = (sql) => (sql.includes('FROM invoices') ? [{ paidAmt: 0, remainingAmt: 115, einvoiceStatus: null, status: 'CONFIRMED', type: 'SALE' }] : undefined);
      await svc.checkCardPayment(INTENT);
      const receipt = calls.find((c) => c.op === 'receipt.create')?.args.data;
      assert.ok(receipt, 'السند قُيد');
      assert.equal(receipt.paymentMethod, 'POS');
      assert.doesNotMatch(String(receipt.bankName), BRAND);
      assert.doesNotMatch(String(receipt.notes), BRAND);
      assert.match(String(receipt.notes), /اختبار/);
      const note = calls.find((c) => c.op === 'notification.create' && c.args.data.type === 'CARDPAY_PAID')?.args.data;
      assert.ok(note);
      assert.doesNotMatch(`${note.title} ${note.body}`, BRAND);
      assert.match(String(note.body), /اختبار/);
    });
    // الإنتاج: لا وسم اختبار
    reset();
    await withEnv(PROD, async () => {
      scripted['cardPayment.findUnique'] = ({ include }) => (include ? { ...payRow, invoice: { number: 'INV-2026-0042', teamId: null, einvoiceStatus: null } } : payRow);
      scripted['cardPayment.updateMany'] = () => ({ count: 1 });
      scripted['receipt.create'] = ({ data }) => ({ id: 'r-1', ...data });
      rawScript = (sql) => (sql.includes('FROM invoices') ? [{ paidAmt: 0, remainingAmt: 115, einvoiceStatus: null, status: 'CONFIRMED', type: 'SALE' }] : undefined);
      await svc.checkCardPayment(INTENT);
      const receipt = calls.find((c) => c.op === 'receipt.create')?.args.data;
      assert.ok(receipt);
      assert.doesNotMatch(String(receipt.notes), /اختبار/);
      assert.doesNotMatch(String(receipt.bankName), BRAND);
    });
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test('تفصيلٌ قديم محفوظ باسم المزوّد يُعرض محايداً — ونصوص المزوّد نفسه كذلك', async () => {
  assert.equal(svc.neutralProviderText('الحالة لدى NearPay declined'), 'الحالة لدى مزوّد الدفع declined');
  for (const s of ['NearPay', 'nearpay', 'Near Pay', 'NEAR-PAY', 'near_pay', 'نيرباي', 'نير باي']) {
    assert.doesNotMatch(svc.neutralProviderText(`x ${s} y`), BRAND, s);
  }
  assert.equal(svc.neutralProviderText(null), null);
  reset();
  scripted['cardPayment.findUnique'] = () => ({ id: 'cp-9', status: 'failed', createdAt: new Date(), receiptId: null, statusDetail: 'عُكست العملية لدى NearPay', amount: 5, reference: 'INV-1' });
  const v = await svc.checkCardPayment('cp-9');
  assert.equal(v.detail, 'عُكست العملية لدى مزوّد الدفع');
});

// ═══ حارسٌ نصّي: لا نصّ يصل الشركة أو المندوب يسمّي المزوّد ═══

/** النصوص الحرفية في ملف TS بمواضعها — يتخطّى التعليقات، ويُسقط تعبيرات ${…} من القوالب (معرّفاتٌ لا نصوص) */
function stringLiterals(src: string): { text: string; line: number; lineText: string }[] {
  const out: { text: string; line: number; lineText: string }[] = [];
  const lines = src.split('\n');
  const lineAt = (i: number) => src.slice(0, i).split('\n').length;
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '/') { i = src.indexOf('\n', i); if (i < 0) break; continue; }
    if (c === '/' && n === '*') { i = src.indexOf('*/', i + 2) + 2; continue; }
    if (c === '\'' || c === '"' || c === '`') {
      const start = i;
      let text = '';
      i++;
      while (i < src.length && src[i] !== c) {
        if (src[i] === '\\') { text += src.slice(i, i + 2); i += 2; continue; }
        if (c === '`' && src[i] === '$' && src[i + 1] === '{') {
          let depth = 1;
          i += 2;
          while (i < src.length && depth > 0) { if (src[i] === '{') depth++; else if (src[i] === '}') depth--; i++; }
          text += '…';
          continue;
        }
        text += src[i];
        i++;
      }
      i++;
      const line = lineAt(start);
      out.push({ text, line, lineText: lines[line - 1] });
      continue;
    }
    i++;
  }
  return out;
}

test('حارس نصّي: لا اسم لمزوّد الدفع في نصٍّ يصل الشركة أو المندوب — والمسموح للمالك وحده مسمّى', () => {
  // ما يبقى باسم المزوّد عمداً: رسائل لا تصل إلا مالك المنصة (ربط تاجر الشركة) — لا موظف المنصة ولا الشركة
  const OWNER_ONLY: Record<string, string[]> = {
    'routes/tenants.ts': [
      'تعذر التحقق من التاجر لدى NearPay حاول بعد لحظات', // التحقق من تاجرٍ جديد — المالك وحده يغيّر التاجر (STAFF_CARDPAY_FORBIDDEN قبله)
      'التاجر غير موجود لدى NearPay', // كذلك
      'تاجر NearPay مربوط بشركة أخرى (…)', // كذلك — قاعدة «تاجر واحد لكل شركة»
      'NEARPAY_UNAVAILABLE', 'NEARPAY_MERCHANT_UNKNOWN', // رموز الرسالتين الأوليين — للمالك وحده كذلك
    ],
  };
  const FILES = ['services/cardPayment.ts', 'services/nearpay.ts', 'routes/cardPayments.ts', 'routes/company.ts', 'routes/tenants.ts'];
  const offenders: string[] = [];
  const seenOwnerOnly: string[] = [];
  for (const rel of FILES) {
    const src = fs.readFileSync(path.join(SRC, rel), 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');
    for (const s of stringLiterals(src)) {
      if (!BRAND.test(s.text)) continue;
      // داخليّ: سجلّ الخادم، وأخطاء عميل المزوّد (يحوّلها sendError إلى رسالة محايدة)، وعناوين واجهته البرمجية
      if (/^import /.test(s.lineText)) continue; // مسار وحدةٍ لا نصّ
      if (/console\.(log|error|warn|info)\(/.test(s.lineText)) continue;
      if (/new NearpayError\(/.test(s.lineText)) continue;
      if (/^https:\/\/[a-z.-]*nearpay\.io\//.test(s.text)) continue;
      if ((OWNER_ONLY[rel] || []).includes(s.text)) { seenOwnerOnly.push(s.text); continue; }
      offenders.push(`${rel}:${s.line} «${s.text}»`);
    }
  }
  assert.deepEqual(offenders, [], `نصوصٌ تسمّي مزوّد الدفع:\n${offenders.join('\n')}`);
  // القائمة المسموحة ليست ميتة: كل بندٍ فيها ما زال في مكانه (وإلا فلتُحذف)
  assert.deepEqual([...new Set(seenOwnerOnly)].sort(), [...OWNER_ONLY['routes/tenants.ts']].sort());
  // رسالة موظف المنصة (STAFF_CARDPAY_FORBIDDEN) محايدة: الموظف يحادث الشركات
  const tenants = fs.readFileSync(path.join(SRC, 'routes/tenants.ts'), 'utf8');
  const staffLine = tenants.split('\n').find((l) => l.includes("'STAFF_CARDPAY_FORBIDDEN'"));
  assert.ok(staffLine);
  assert.doesNotMatch(staffLine!, BRAND);
});

// ═══ مراجعة ١ نوفمبر ٢٠٢٦: ما تقرؤه الشركة من مسارات البطاقة نفسها — لا من الخدمة وحدها ═══

test('GET /api/company لشركةٍ بلا تحصيل بالبطاقة: الحقول نفسها والقيم مطفأة — لا حقل جديد غير cardPayTest ولا معرّف التاجر', async () => {
  reset();
  currentUser = { id: 'admin-1', role: 'ADMIN', name: 'مدير', tenantId: TENANT };
  let tenantRow: Record<string, unknown> = {};
  scripted['companySettings.findUnique'] = () => ({ tenantId: TENANT, name: 'شركة', currency: 'SAR' });
  scripted['tenant.findUnique'] = () => tenantRow;
  await withEnv({}, async () => {
    tenantRow = { cardPayEnabled: false, nearpayMerchantId: null };
    const off = (await getCompany()).body.data;
    tenantRow = { cardPayEnabled: true, nearpayMerchantId: MERCHANT };
    const on = (await getCompany()).body.data;
    // الحقول نفسها في الحالين، وحقول البطاقة ثلاثة لا غير (والتاجر يُقرأ ولا يخرج)
    assert.deepEqual(Object.keys(off).sort(), Object.keys(on).sort());
    assert.deepEqual(Object.keys(off).filter((k) => /card|merchant|nearpay/i.test(k)).sort(), ['cardPayAvailable', 'cardPayEnabled', 'cardPayTest']);
    assert.deepEqual([off.cardPayEnabled, off.cardPayAvailable, off.cardPayTest], [false, false, false]);
    // ما عدا حقول البطاقة لا يتأثر بها
    const rest = (d: Record<string, unknown>) => Object.fromEntries(Object.entries(d).filter(([k]) => !k.startsWith('cardPay')));
    assert.deepEqual(rest(off), rest(on));
  });
});

/** ردٌّ مزيّف من واجهة المزوّد بالمسار — والطلب إلى خادمنا يمرّ بـrealFetch */
function providerFetch(routes: Record<string, () => Response>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    const hit = Object.keys(routes).find((p) => url.includes(p));
    return hit ? routes[hit]() : new Response('{}', { status: 404 });
  }) as typeof fetch;
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('مسارات الشركة: تفصيلٌ قديم باسم المزوّد واسم تاجر الاختبار يُعرضان محايدين، والإغلاق يحفظ المحايد، وعطل المزوّد 502 بلا اسمه', async () => {
  const prevFetch = globalThis.fetch;
  try {
    await withEnv({}, async () => {
      // (١) قائمة العمليات (الإدارة والمندوب): statusDetail قديم محفوظ باسم المزوّد
      reset();
      currentUser = { id: 'admin-1', role: 'ADMIN', name: 'مدير', tenantId: TENANT };
      scripted['tenant.findUnique'] = () => ({ cardPayEnabled: true, accountingEnabled: true, nearpayMerchantId: MERCHANT });
      scripted['cardPayment.findMany'] = () => [
        { id: 'cp-1', status: 'review', statusDetail: 'المبلغ لدى NearPay 100 هللة لا 11500', reference: 'INV-1', amount: 115 },
        { id: 'cp-2', status: 'declined', statusDetail: null, reference: 'INV-2', amount: 5 },
      ];
      const list = await call('GET', '/api/card-payments?status=review');
      assert.equal(list.status, 200, JSON.stringify(list.body));
      assert.equal(list.body.data[0].statusDetail, 'المبلغ لدى مزوّد الدفع 100 هللة لا 11500');
      assert.equal(list.body.data[1].statusDetail, null);
      assert.doesNotMatch(JSON.stringify(list.body), BRAND);

      // (٢) نقاط البيع: تاجر بيئة الاختبار يحمل اسم المزوّد
      reset();
      currentUser = { id: 'admin-1', role: 'ADMIN', name: 'مدير', tenantId: TENANT };
      scripted['tenant.findUnique'] = () => ({ cardPayEnabled: true, accountingEnabled: true, nearpayMerchantId: MERCHANT });
      scripted['salesRep.findMany'] = () => [{ id: 'rep-1', name: 'مندوب', isActive: true, nearpayTid: null }];
      globalThis.fetch = providerFetch({
        '/terminals?page=1': () => json({
          terminals: [{ id: 'term-1', tid: '0212184900121849', merchant: { id: MERCHANT, name: 'NearPay Sandbox Merchant' }, is_connected: true }],
          pages: { total: 1 },
        }),
      });
      const terms = await call('GET', '/api/card-payments/terminals');
      assert.equal(terms.status, 200, JSON.stringify(terms.body));
      assert.equal(terms.body.data.terminals.length, 1);
      assert.equal(terms.body.data.terminals[0].merchantName, 'مزوّد الدفع Sandbox Merchant');
      assert.doesNotMatch(JSON.stringify(terms.body.data.terminals), BRAND);

      // (٣) عطل المزوّد عند الفحص: 502 برمزٍ ورسالة بلا اسمه
      reset();
      currentUser = { id: 'rep-1', role: 'SALES_REP', name: 'مندوب', tenantId: TENANT };
      scripted['tenant.findUnique'] = () => ({ cardPayEnabled: true, accountingEnabled: true });
      scripted['cardPayment.findFirst'] = () => ({ id: INTENT });
      scripted['cardPayment.findUnique'] = () => ({ id: INTENT, status: 'pending', createdAt: new Date(), amountHalalas: 11500, tid: '0212184900121849' });
      globalThis.fetch = providerFetch({ '/intents/': () => json({ code: 5000, code_text: 'NearPay internal error' }, 500) });
      const down = await call('POST', `/api/card-payments/${INTENT}/check`);
      assert.equal(down.status, 502, JSON.stringify(down.body));
      assert.equal(down.body.code, 'CARD_PAY_PROVIDER_UNAVAILABLE');
      assert.doesNotMatch(JSON.stringify(down.body), BRAND);

      // (٤) إغلاق المراجعة: التفصيل القديم يُحفظ في الملاحظة بعبارة محايدة
      reset();
      currentUser = { id: 'admin-1', role: 'ADMIN', name: 'مدير', tenantId: TENANT };
      scripted['tenant.findUnique'] = () => ({ cardPayEnabled: true, accountingEnabled: true });
      scripted['cardPayment.findFirst'] = () => ({ id: 'cp-1', statusDetail: 'نقطة البيع لدى NearPay غير مقروءة لا 0212184900121849' });
      scripted['cardPayment.updateMany'] = () => ({ count: 1 });
      const closed = await call('POST', '/api/card-payments/cp-1/close', { note: 'سند قبض يدوي 55' });
      assert.equal(closed.status, 200, JSON.stringify(closed.body));
      const saved = calls.find((c) => c.op === 'cardPayment.updateMany')!.args.data.statusDetail as string;
      assert.match(saved, /سند قبض يدوي 55 — كان: نقطة البيع لدى مزوّد الدفع غير مقروءة/);
      assert.doesNotMatch(saved, BRAND);
    });
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test('رفض البطاقة: رسالة المزوّد نفسه (status_message) تُحفظ وتُعرض بلا اسمه', async () => {
  reset();
  const prevFetch = globalThis.fetch;
  const payRow = {
    id: INTENT, tenantId: TENANT, invoiceId: INVOICE_ID, customerId: 'c1', salesRepId: 'rep-1', status: 'pending', amount: 115,
    amountHalalas: 11500, tid: '0212184900121849', reference: 'INV-2026-0042', createdAt: new Date(Date.now() - 60_000),
    transactionUuid: null, receiptId: null, statusDetail: null,
  };
  const declined = {
    details: {
      intenet_id: INTENT, reference_id: 'INV-2026-0042', type: 'purchase', status: 'declined', amount: '11500',
      transactions: [{
        id: 'tx-1', status: 'declined', amount: '11500',
        events: [{ type: 'purchase', status: 'declined', receipt: { data: { is_approved: false, status_message: 'Declined by NearPay host (51)' } } }],
      }],
    },
  };
  try {
    globalThis.fetch = providerFetch({ '/intents/': () => json(declined) });
    await withEnv({}, async () => {
      scripted['cardPayment.findUnique'] = () => payRow;
      scripted['cardPayment.updateMany'] = () => ({ count: 1 });
      await svc.checkCardPayment(INTENT);
      const upd = calls.find((c) => c.op === 'cardPayment.updateMany' && c.args.data.status === 'declined');
      assert.ok(upd, 'رُفضت العملية');
      assert.equal(upd!.args.data.statusDetail, 'Declined by مزوّد الدفع host (51)');
      assert.ok(!calls.some((c) => c.op === 'receipt.create'), 'لا سند');
    });
  } finally {
    globalThis.fetch = prevFetch;
  }
});

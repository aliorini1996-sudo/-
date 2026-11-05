// «أنواع الأسعار على مستوى المندوب» (طلب المالك ٢ نوفمبر ٢٠٢٦) — المعالجات الحقيقية (/api/sales-reps و/api/price-lists و/auth/me)
// فوق Prisma مزيّف (بلا قاعدة بيانات)، وحرّاس middleware/auth الحقيقيون عدا authenticate. يثبت:
//   • القواعد الصرفة المشتركة: الافتراضي = نوع العميل ?? نوع المندوب ?? الأساسي، والمسموح من JSON بلا تكرار و'base' = null،
//     والتبديل ضمن المسموح أو إلى الافتراضي، وقائمة الرقائق بترتيبها — ونسخة الويب مطابقة حرفاً.
//   • إنشاء المندوب وتعديله: نوعٌ ليس من الشركة 400 PRICE_LIST_INVALID، وافتراضيٌّ خارج المسموح 400 PRICE_TYPE_DEFAULT_NOT_ALLOWED
//     (والمرسل يُفحص مع المحفوظ)، وبلا تكرار و'base' رمزاً، والفارغ = بلا قيد (DbNull)، والفحص والكتابة في معاملةٍ بقفل
//     FOR KEY SHARE، والتعديل يعيد الفحص على صفّ المندوب تحت قفله FOR UPDATE (تعديلان جزئيان متزامنان)، وبلا الحقلين مسار
//     اليوم حرفياً. والمندوب لا يصل الموجّه (requireAdmin) فلا يضبطهما لنفسه.
//   • /auth/me وقائمة المناديب يحملان الحقلين، و/price-lists/prices للمندوب بلا التبديل يضمّ نوعه الافتراضي لا أنواعه المسموحة.
//   • حذف النوع: 409 PRICE_LIST_IN_USE ما دام افتراضيَّ مندوبٍ أو ضمن مسموحه — repsCount مع customersCount، تحت القفل نفسه.
//   • المزامنة تكشف الحقلين، وحمولة ERP لا تحملهما (المندوب فيها id/name/phone وحدها)، والمخطّط إضافيّ بـSetNull.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { Prisma } from '@prisma/client';
import {
  BASE_PRICE_TYPE, PRICE_LIST_IN_USE_BY, PRICE_LIST_MESSAGES, allowedPriceTypesOf, defaultPriceTypeOf, priceTypeAllowed, switchablePriceTypesOf,
} from '../services/priceLists';
import { invoicePayloadRow } from '../services/erpPayload';

// ═══ حقن البدائل قبل تحميل الموجّهات (نمط price-lists.test.ts وconvert-base-access.test.ts) ═══

process.env.JWT_SECRET = process.env.JWT_SECRET || 'price-lists-reps-test-secret';
const SRC = path.join(__dirname, '..');
const read = (...p: string[]): string => fs.readFileSync(path.join(SRC, ...p), 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

/* eslint-disable @typescript-eslint/no-explicit-any */
type Raw = { sql: string; values: unknown[]; inTx: boolean };
let calls: string[] = [];
let raws: Raw[] = [];
let inTx = false;
let scripted: Record<string, (args: any) => unknown> = {};
let rawScript: (r: Raw) => unknown = () => undefined;

function defaultFor(method: string): unknown {
  if (method === 'findMany' || method === 'groupBy') return [];
  if (method === 'count') return 0;
  if (method === 'updateMany' || method === 'deleteMany') return { count: 0 };
  return null;
}
const prismaFake: Record<string, unknown> = new Proxy({}, {
  get: (_t, key: string) => {
    if (key === '$transaction') {
      return async (arg: unknown) => {
        calls.push(typeof arg === 'function' ? '$transaction(fn)' : '$transaction([])');
        if (typeof arg !== 'function') return Promise.all(arg as Promise<unknown>[]);
        inTx = true;
        try { return await (arg as (tx: unknown) => Promise<unknown>)(prismaFake); } finally { inTx = false; }
      };
    }
    if (key === '$queryRaw' || key === '$executeRaw') {
      return async (strings: TemplateStringsArray, ...values: unknown[]) => {
        calls.push(key);
        const r: Raw = { sql: strings.join('?'), values, inTx };
        raws.push(r);
        const out = rawScript(r);
        return out !== undefined ? out : (key === '$queryRaw' ? [] : 0);
      };
    }
    if (key === 'then') return undefined;
    return new Proxy({}, {
      get: (_m, method: string) => async (args: unknown) => {
        calls.push(`${key}.${method}${inTx ? '@tx' : ''}`);
        const fn = scripted[`${key}.${method}`];
        return fn ? fn(args) : defaultFor(method);
      },
    });
  },
});

const TENANT = 'T1';
type User = { id: string; role: string; tenantId: string; name?: string };
const ADMIN: User = { id: 'admin-1', role: 'ADMIN', tenantId: TENANT, name: 'مدير' };
const REP_USER: User = { id: 'rep-1', role: 'SALES_REP', tenantId: TENANT, name: 'خالد' };
let currentUser: User = ADMIN;

stub('config/database', { default: prismaFake });
stub('services/mailer', { async sendMail() { return true; }, mailLayout: () => '' });
/* eslint-disable @typescript-eslint/no-var-requires */
const realAuth = require('../middleware/auth') as Record<string, unknown>;
// الحرّاس الحقيقيون (requireAdmin يردّ المندوب 403، وrequireAdminPermission يقرأ صفّ المستخدم) — عدا authenticate، والمحاسبة مفتوحة
stub('middleware/auth', {
  ...realAuth,
  authenticate: (req: { user?: unknown }, _res: unknown, next: () => void) => { req.user = currentUser; next(); },
  requireAccounting: (_req: unknown, _res: unknown, next: () => void) => next(),
});
const salesRepsRouter = (require('../routes/salesReps') as typeof import('../routes/salesReps')).default;
const priceListsRouter = (require('../routes/priceLists') as typeof import('../routes/priceLists')).default;
const authRouter = (require('../routes/auth') as typeof import('../routes/auth')).default;
const { errorHandler } = require('../middleware/errorHandler') as typeof import('../middleware/errorHandler');
/* eslint-enable @typescript-eslint/no-var-requires */

// ═══ العُدّة ═══

let server: { port: number; close: () => Promise<void> } | null = null;
async function startServer() {
  if (server) return server;
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/sales-reps', salesRepsRouter);
  app.use('/api/price-lists', priceListsRouter);
  app.use('/api/auth', authRouter);
  app.use(errorHandler);
  const s = http.createServer(app);
  await new Promise<void>(resolve => s.listen(0, '127.0.0.1', resolve));
  server = { port: (s.address() as AddressInfo).port, close: () => new Promise<void>(r => { s.closeAllConnections?.(); s.close(() => r()); }) };
  return server;
}
after(async () => { await server?.close(); server = null; });

type Reply = { status: number; body: Record<string, any> };
async function call(method: 'POST' | 'GET' | 'PUT' | 'DELETE', url: string, body?: unknown): Promise<Reply> {
  const s = await startServer();
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
  return new Promise<Reply>((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: s.port, method, path: url, agent: false,
      headers: { connection: 'close', ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': String(payload.length) } : {}) },
    }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c as Buffer));
      res.on('end', () => { const t = Buffer.concat(chunks).toString('utf8'); resolve({ status: res.statusCode ?? 0, body: t ? JSON.parse(t) : {} }); });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** الأنواع الموجودة في الشركة — قفل FOR KEY SHARE يعيد ما وُجد منها بشرط الشركة */
const COMPANY_LISTS = ['L-W', 'L-R', 'L-X'];
const isLockOf = (r: Raw) => /FROM price_lists WHERE "tenantId" = \? AND id IN \(\?\) FOR KEY SHARE/.test(r.sql);
function reset(user: User = ADMIN): void {
  calls = []; raws = []; inTx = false; currentUser = user;
  scripted = {
    // صفّ مستخدم الشركة لحارس الصلاحية (نشطٌ بلا نطاق)
    'admin.findUnique': () => ({ id: user.id, isActive: true, scopeEnabled: false }),
  };
  rawScript = (r) => {
    if (!isLockOf(r)) return undefined;
    const [tid, ids] = r.values as [string, { values: string[] }];
    return tid === TENANT ? ids.values.filter((id) => COMPANY_LISTS.includes(id)).map((id) => ({ id })) : [];
  };
}
const locks = () => raws.filter(isLockOf);
const lockedIds = (r: Raw) => (r.values[1] as { values: string[] }).values;

const NEW_REP = { name: 'خالد', phone: '0551234567', username: 'khalid.rep', password: 'Rep2026secure' };
const CURRENT_REP = {
  id: 'rep-1', tenantId: TENANT, name: 'خالد', phone: '0551234567', email: null, username: 'khalid.rep',
  boundDeviceId: null, boundDeviceName: null, boundDeviceAt: null, defaultPriceListId: null as string | null, allowedPriceTypes: null as unknown,
};
/** قفل صفّ المندوب في معاملة تعديل أنواعه (FOR UPDATE) — يعيد حقلي الأنواع المحفوظين تحته */
const isRepLockOf = (r: Raw) => /FROM sales_reps WHERE id = \? AND "tenantId" = \? FOR UPDATE/.test(r.sql);
const repLocks = () => raws.filter(isRepLockOf);
/**
 * المندوب القائم لـPUT — وفحص التكرار (username/phone/email) بلا تعارض. `locked` صفّه تحت القفل في المعاملة (غيابه = المقروء
 * قبلها نفسه؛ null = حُذف بين القراءتين): به يُمثَّل تعديلٌ متزامن التزم بين القراءة الأولى والقفل
 */
function repWorld(
  o: Partial<typeof CURRENT_REP> = {}, locked?: { defaultPriceListId: string | null; allowedPriceTypes: unknown } | null,
): { creates: any[]; updates: any[]; audits: any[] } {
  const seen = { creates: [] as any[], updates: [] as any[], audits: [] as any[] };
  const row = { ...CURRENT_REP, ...o };
  const prevRaw = rawScript;
  rawScript = (r) => {
    if (!isRepLockOf(r)) return prevRaw(r);
    const [id, tid] = r.values as [string, string];
    if (id !== row.id || tid !== TENANT || locked === null) return [];
    return [locked ?? { defaultPriceListId: row.defaultPriceListId, allowedPriceTypes: row.allowedPriceTypes }];
  };
  scripted['salesRep.findFirst'] = (args) => ('username' in args.where || 'phone' in args.where || 'email' in args.where ? null : row);
  scripted['salesRep.create'] = (args) => { seen.creates.push({ ...args, inTx }); return { id: 'rep-new', name: args.data.name, phone: args.data.phone, username: args.data.username, isActive: true }; };
  scripted['salesRep.update'] = (args) => { seen.updates.push({ ...args, inTx }); return { id: 'rep-1', name: 'خالد', phone: '0551234567', username: 'khalid.rep', isActive: true }; };
  scripted['attendanceAudit.create'] = (args) => { seen.audits.push({ ...args, inTx }); return { id: 'au-1' }; };
  return seen;
}

// ═══ (١) القواعد الصرفة المشتركة ═══

test('القواعد: الافتراضي نوع العميل ثم نوع المندوب ثم الأساسي، والمسموح من JSON بلا تكرار و«base» = null', () => {
  assert.equal(BASE_PRICE_TYPE, 'base');
  assert.equal(defaultPriceTypeOf('L-W', 'L-R'), 'L-W', 'نوع العميل يغلب');
  assert.equal(defaultPriceTypeOf(null, 'L-R'), 'L-R');
  assert.equal(defaultPriceTypeOf(undefined, undefined), null);
  assert.equal(defaultPriceTypeOf('', null), null, 'الفارغ = بلا نوع');
  // null أو غير المصفوفة = بلا قيد (كاليوم)، والفارغة تبقى فارغة، وما ليس نصاً يُهمل
  assert.equal(allowedPriceTypesOf(null), null);
  assert.equal(allowedPriceTypesOf(undefined), null);
  assert.equal(allowedPriceTypesOf({ a: 1 }), null);
  assert.deepEqual(allowedPriceTypesOf([]), []);
  assert.deepEqual(allowedPriceTypesOf(['L-W', 'base', 'L-W', 7, '', null, 'base', 'L-R']), ['L-W', null, 'L-R']);
});

test('القواعد: التبديل ضمن المسموح أو إلى الافتراضي، وبلا قيد كله — والرقائق بترتيبها: الافتراضي أولاً ثم المسموح الموجود', () => {
  assert.equal(priceTypeAllowed('L-X', null, 'L-W'), true, 'بلا قيد');
  assert.equal(priceTypeAllowed(null, null, 'L-W'), true);
  assert.equal(priceTypeAllowed('L-W', ['L-R'], 'L-W'), true, 'نوع العميل (الافتراضي) مسموح دائماً');
  assert.equal(priceTypeAllowed('L-R', ['L-R'], 'L-W'), true);
  assert.equal(priceTypeAllowed('L-X', ['L-R'], 'L-W'), false);
  assert.equal(priceTypeAllowed(null, ['L-R'], 'L-W'), false, 'الأساسي خارج المسموح');
  assert.equal(priceTypeAllowed(null, [null], 'L-W'), true);
  assert.equal(priceTypeAllowed(null, [], null), true, 'المسموح الفارغ: الافتراضي وحده');
  assert.equal(priceTypeAllowed('L-W', [], null), false);
  const all = ['L-W', 'L-R', 'L-X'];
  assert.deepEqual(switchablePriceTypesOf(null, 'L-R', all), ['L-R', null, 'L-W', 'L-X'], 'بلا قيد: الافتراضي ثم الأساسي ثم الأنواع');
  assert.deepEqual(switchablePriceTypesOf(null, null, all), [null, 'L-W', 'L-R', 'L-X']);
  assert.deepEqual(switchablePriceTypesOf(['L-X', null], 'L-W', all), ['L-W', 'L-X', null]);
  assert.deepEqual(switchablePriceTypesOf(['L-GONE', 'L-R', 'L-R'], 'L-R', all), ['L-R'], 'المحذوف يُسقط والمكرر مرة');
  assert.deepEqual(switchablePriceTypesOf([], null, all), [null]);
});

test('نسخة الويب من القواعد المشتركة مطابقة حرفاً لنسخة الخادم (BASE_PRICE_TYPE والدوال الأربع)', () => {
  const server = read('services', 'priceLists.ts');
  const web = fs.readFileSync(path.join(SRC, '..', '..', 'web-admin', 'src', 'lib', 'priceLists.ts'), 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const block = (src: string, head: string): string => {
    const i = src.indexOf(head);
    assert.ok(i >= 0, `مفقود: ${head}`);
    return src.slice(i, head.startsWith('export const') ? src.indexOf(';', i) + 1 : src.indexOf('\n}\n', i) + 2);
  };
  for (const head of [
    "export const BASE_PRICE_TYPE = 'base'", 'export function defaultPriceTypeOf(', 'export function allowedPriceTypesOf(',
    'export function priceTypeAllowed(', 'export function switchablePriceTypesOf(',
  ]) assert.equal(block(web, head), block(server, head), head);
});

test('«قوائم الأسعار» (طلب المالك ٥ نوفمبر ٢٠٢٦): رسائل الخادم بالاسم الجديد حرفاً كما في العقد — والرموز كما هي، ولا «نوع سعر» في رسالة', () => {
  assert.deepEqual(
    [PRICE_LIST_MESSAGES.PRICE_LIST_INVALID, PRICE_LIST_MESSAGES.PRICE_LIST_FORBIDDEN, PRICE_LIST_MESSAGES.PRICE_LIST_NAME_TAKEN,
      PRICE_LIST_MESSAGES.PRICE_LIST_NAME_INVALID, PRICE_LIST_MESSAGES.PRICE_TYPE_DEFAULT_NOT_ALLOWED, PRICE_LIST_MESSAGES.PRICE_TYPE_NOT_ALLOWED],
    ['قائمة الأسعار غير موجودة', 'لا تملك صلاحية تبديل قائمة الأسعار', 'توجد قائمة أسعار بهذا الاسم', 'اسم قائمة الأسعار من حرف إلى 40 حرفاً',
      'القائمة الافتراضية للمندوب يجب أن تكون من القوائم المسموحة له', 'قائمة الأسعار غير مسموحة لك'],
  );
  for (const m of [...Object.values(PRICE_LIST_MESSAGES), ...Object.values(PRICE_LIST_IN_USE_BY)]) {
    assert.doesNotMatch(m, /نوع|أنواع|الأنواع/, m);
  }
  // رسائل المسارات الجديدة بلا تشكيل (مفاتيح ترجمة الواجهة بلا تشكيل)
  for (const k of ['PRICE_RULE_INVALID', 'PRICE_RULE_LIMIT', 'PRICE_RULE_NOT_FOUND', 'PRODUCT_NOT_FOUND', 'CATEGORY_NOT_FOUND', 'BASE_UNIT_REQUIRED', 'BASE_UNIT_CHANGED', 'PRIMARY_UNIT_CHANGED'] as const) {
    assert.doesNotMatch(PRICE_LIST_MESSAGES[k], /[ً-ْ]/, k);
  }
});

// ═══ (٢) إنشاء المندوب ═══

test('POST /sales-reps: الأنواع بلا تكرار و«base» رمزاً، والافتراضي منها، والفحص والإنشاء في معاملةٍ واحدة بقفل FOR KEY SHARE', async () => {
  reset();
  const seen = repWorld();
  const r = await call('POST', '/api/sales-reps', { ...NEW_REP, defaultPriceListId: 'L-W', allowedPriceTypes: ['L-W', 'base', 'L-W', 'L-R'] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(seen.creates.length, 1);
  const c = seen.creates[0];
  assert.equal(c.inTx, true, 'الإنشاء داخل معاملة القفل');
  assert.equal(c.data.defaultPriceListId, 'L-W');
  assert.deepEqual(c.data.allowedPriceTypes, ['L-W', 'base', 'L-R'], 'بلا تكرار بترتيبه و«base» كما يُخزَّن');
  assert.equal(c.data.tenantId, TENANT);
  assert.deepEqual(locks().map((l) => [l.values[0], lockedIds(l), l.inTx]), [[TENANT, ['L-W', 'L-R'], true]], 'معرّفات الأنواع وحدها مرةً واحدة');
  assert.ok(calls.indexOf('$queryRaw') < calls.indexOf('salesRep.create@tx'), 'القفل قبل الكتابة');
});

test('POST /sales-reps: نوعٌ ليس من الشركة ⇒ 400 PRICE_LIST_INVALID بلا إنشاء، وافتراضيٌّ خارج المسموح ⇒ 400 PRICE_TYPE_DEFAULT_NOT_ALLOWED بلا استعلام', async () => {
  for (const body of [{ defaultPriceListId: 'L-FOREIGN' }, { allowedPriceTypes: ['base', 'L-FOREIGN'] }, { defaultPriceListId: 'L-W', allowedPriceTypes: ['L-W', 'L-FOREIGN'] }]) {
    reset();
    const seen = repWorld();
    const r = await call('POST', '/api/sales-reps', { ...NEW_REP, ...body });
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.deepEqual([r.body.code, r.body.message], ['PRICE_LIST_INVALID', PRICE_LIST_MESSAGES.PRICE_LIST_INVALID]);
    assert.equal(seen.creates.length, 0, 'لا إنشاء');
    assert.equal(locks().length, 1);
  }
  for (const body of [
    { defaultPriceListId: 'L-W', allowedPriceTypes: ['base', 'L-R'] },
    { allowedPriceTypes: ['L-R'] }, // الافتراضي الغائب = السعر الأساسي، وليس في المسموح
    { defaultPriceListId: null, allowedPriceTypes: ['L-W'] },
  ]) {
    reset();
    const seen = repWorld();
    const r = await call('POST', '/api/sales-reps', { ...NEW_REP, ...body });
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.deepEqual([r.body.code, r.body.message], ['PRICE_TYPE_DEFAULT_NOT_ALLOWED', PRICE_LIST_MESSAGES.PRICE_TYPE_DEFAULT_NOT_ALLOWED]);
    assert.equal(seen.creates.length, 0);
    assert.equal(raws.length, 0, 'فحصٌ صرف قبل أي استعلام');
    assert.equal(calls.includes('tenant.findUnique'), false, 'قبل حدّ المناديب وفحص التكرار');
  }
});

test('POST /sales-reps: بلا الحقلين مسار اليوم حرفياً (لا معاملة ولا قفل)، والفارغ و«base» = السعر الأساسي، و[] أو null = بلا قيد (DbNull)', async () => {
  reset();
  let seen = repWorld();
  assert.equal((await call('POST', '/api/sales-reps', NEW_REP)).status, 201);
  assert.equal(seen.creates.length, 1);
  assert.equal(seen.creates[0].inTx, false);
  assert.equal('defaultPriceListId' in seen.creates[0].data || 'allowedPriceTypes' in seen.creates[0].data, false, 'لا مفتاح يُكتب');
  assert.equal(calls.some((c) => c.startsWith('$transaction')), false);
  assert.equal(raws.length, 0);
  for (const [body, def] of [[{ defaultPriceListId: '', allowedPriceTypes: [] }, null], [{ defaultPriceListId: 'base', allowedPriceTypes: null }, null]] as const) {
    reset();
    seen = repWorld();
    const r = await call('POST', '/api/sales-reps', { ...NEW_REP, ...body });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(seen.creates[0].data.defaultPriceListId, def);
    assert.equal(seen.creates[0].data.allowedPriceTypes, Prisma.DbNull, 'عمودٌ فارغ في القاعدة (لا JSON null)');
    assert.equal(raws.length, 0, 'لا معرّفات تُفحص');
  }
  // «base» وحده في المسموح مع الافتراضي الأساسي: يُحفظ ولا يُقفل شيء
  reset();
  seen = repWorld();
  assert.equal((await call('POST', '/api/sales-reps', { ...NEW_REP, allowedPriceTypes: ['base'] })).status, 201);
  assert.deepEqual(seen.creates[0].data.allowedPriceTypes, ['base']);
  assert.equal(raws.length, 0);
  // مخطّط zod: ليست مصفوفة نصوص ⇒ 400 بلا إنشاء
  reset();
  seen = repWorld();
  assert.equal((await call('POST', '/api/sales-reps', { ...NEW_REP, allowedPriceTypes: 'L-W' })).status, 400);
  assert.equal(seen.creates.length, 0);
});

// ═══ (٣) تعديل المندوب ═══

test('PUT /sales-reps/:id: المرسل يُفحص مع المحفوظ — مسموحٌ جديد بلا الافتراضي المحفوظ، أو افتراضيٌّ جديد خارج المسموح المحفوظ ⇒ 400 بلا كتابة', async () => {
  const cases: Array<[Partial<typeof CURRENT_REP>, Record<string, unknown>]> = [
    [{ defaultPriceListId: 'L-W' }, { allowedPriceTypes: ['L-R', 'base'] }],
    [{ allowedPriceTypes: ['base'] }, { defaultPriceListId: 'L-R' }],
    [{ allowedPriceTypes: ['L-W'], defaultPriceListId: 'L-W' }, { defaultPriceListId: null }],
    [{ allowedPriceTypes: ['L-W'], defaultPriceListId: 'L-W' }, { defaultPriceListId: '' }],
  ];
  for (const [stored, body] of cases) {
    reset();
    const seen = repWorld(stored);
    const r = await call('PUT', '/api/sales-reps/rep-1', { ...body, email: '' });
    assert.equal(r.status, 400, JSON.stringify({ stored, body }));
    assert.equal(r.body.code, 'PRICE_TYPE_DEFAULT_NOT_ALLOWED');
    assert.equal(seen.updates.length, 0);
    assert.equal(raws.length, 0);
  }
});

test('PUT /sales-reps/:id: افتراضيٌّ من المسموح المحفوظ يُكتب وحده (المسموح لا يُلمس)، ونوعٌ ليس من الشركة 400 بلا كتابة، والقفل للمرسل وحده', async () => {
  reset();
  let seen = repWorld({ allowedPriceTypes: ['L-R', 'base'], defaultPriceListId: null });
  const ok = await call('PUT', '/api/sales-reps/rep-1', { defaultPriceListId: 'L-R', email: '' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(seen.updates.length, 1);
  assert.equal(seen.updates[0].inTx, true);
  assert.equal(seen.updates[0].data.defaultPriceListId, 'L-R');
  assert.equal('allowedPriceTypes' in seen.updates[0].data, false, 'المحفوظ لا يُعاد كتابته');
  assert.deepEqual(locks().map(lockedIds), [['L-R']]);
  // المسموح وحده يُكتب، والمحفوظ الافتراضي منه ⇒ يمرّ — ونوعٌ ليس من الشركة فيه ⇒ 400
  reset();
  seen = repWorld({ defaultPriceListId: 'L-W' });
  assert.equal((await call('PUT', '/api/sales-reps/rep-1', { allowedPriceTypes: ['L-W', 'L-X'], email: '' })).status, 200);
  assert.deepEqual(seen.updates[0].data.allowedPriceTypes, ['L-W', 'L-X']);
  assert.equal('defaultPriceListId' in seen.updates[0].data, false);
  reset();
  seen = repWorld({ defaultPriceListId: 'L-W' });
  const bad = await call('PUT', '/api/sales-reps/rep-1', { allowedPriceTypes: ['L-W', 'L-OTHER-TENANT'], email: '' });
  assert.equal(bad.status, 400, JSON.stringify(bad.body));
  assert.equal(bad.body.code, 'PRICE_LIST_INVALID');
  assert.equal(seen.updates.length, 0);
  // إلغاء القيد: null أو [] ⇒ DbNull بلا قفل أنواع (لا معرّفات) — وصفّ المندوب يُقفل في معاملته، والافتراضي المحفوظ يبقى
  for (const allowed of [null, []]) {
    reset();
    seen = repWorld({ defaultPriceListId: 'L-W', allowedPriceTypes: ['L-W'] });
    assert.equal((await call('PUT', '/api/sales-reps/rep-1', { allowedPriceTypes: allowed, email: '' })).status, 200);
    assert.equal(seen.updates[0].data.allowedPriceTypes, Prisma.DbNull);
    assert.equal(seen.updates[0].inTx, true);
    assert.equal(locks().length, 0);
    assert.deepEqual(repLocks().map((l) => [l.values, l.inTx]), [[['rep-1', TENANT], true]]);
  }
});

test('PUT /sales-reps/:id: تعديلان جزئيان متزامنان لا يخزّنان افتراضيّاً خارج المسموح — الفحص يُعاد على صفّ المندوب تحت قفله FOR UPDATE', async () => {
  // المقروء قبل المعاملة: افتراضيّ L-W بلا قيد، فيمرّ {allowedPriceTypes:['L-W']} فحصه الأوّل؛ وتحت القفل التزم تعديلٌ آخر
  // جعل الافتراضي L-R ⇒ 400 PRICE_TYPE_DEFAULT_NOT_ALLOWED بلا كتابة، والقفل قبل كل شيء في المعاملة
  reset();
  let seen = repWorld({ defaultPriceListId: 'L-W', allowedPriceTypes: null }, { defaultPriceListId: 'L-R', allowedPriceTypes: null });
  let r = await call('PUT', '/api/sales-reps/rep-1', { allowedPriceTypes: ['L-W'], email: '' });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.deepEqual([r.body.code, r.body.message], ['PRICE_TYPE_DEFAULT_NOT_ALLOWED', PRICE_LIST_MESSAGES.PRICE_TYPE_DEFAULT_NOT_ALLOWED]);
  assert.equal(seen.updates.length, 0, 'لا كتابة');
  assert.deepEqual(calls.filter((c) => /^\$|@tx$/.test(c)), ['$transaction(fn)', '$queryRaw'], 'قفل صفّ المندوب ثم الرفض — لا قفل أنواع ولا تعديل');
  assert.equal(repLocks()[0]?.inTx, true);
  // والعكس: المقروء بلا قيد، وتحت القفل صار المسموح ['L-W'] ⇒ افتراضيٌّ جديد L-R يُرفض
  reset();
  seen = repWorld({ defaultPriceListId: 'L-W', allowedPriceTypes: null }, { defaultPriceListId: 'L-W', allowedPriceTypes: ['L-W'] });
  r = await call('PUT', '/api/sales-reps/rep-1', { defaultPriceListId: 'L-R', email: '' });
  assert.deepEqual([r.status, r.body.code], [400, 'PRICE_TYPE_DEFAULT_NOT_ALLOWED']);
  assert.equal(seen.updates.length, 0);
  // والمحفوظ تحت القفل يجيزه ⇒ يُكتب: قفل المندوب ثم قفل الأنواع ثم التعديل
  reset();
  seen = repWorld({ defaultPriceListId: null, allowedPriceTypes: ['base'] }, { defaultPriceListId: null, allowedPriceTypes: null });
  r = await call('PUT', '/api/sales-reps/rep-1', { defaultPriceListId: 'L-R', email: '' });
  assert.equal(r.status, 400, 'الفحص الأوّل على المقروء يبقى (رفضٌ سريع بلا معاملة)');
  assert.equal(calls.some((c) => c.startsWith('$transaction')), false);
  reset();
  seen = repWorld({ defaultPriceListId: null, allowedPriceTypes: null }, { defaultPriceListId: null, allowedPriceTypes: ['L-R', 'base'] });
  r = await call('PUT', '/api/sales-reps/rep-1', { defaultPriceListId: 'L-R', email: '' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(calls.filter((c) => /^\$|@tx$/.test(c)), ['$transaction(fn)', '$queryRaw', '$queryRaw', 'salesRep.update@tx']);
  assert.ok(isRepLockOf(raws[0]!) && isLockOf(raws[1]!), 'قفل المندوب قبل قفل الأنواع');
  assert.equal(seen.updates[0].data.defaultPriceListId, 'L-R');
  // حُذف المندوب بين القراءة والقفل ⇒ 404 بلا كتابة (لا 500 من تعديل صفٍّ غائب)
  reset();
  seen = repWorld({}, null);
  r = await call('PUT', '/api/sales-reps/rep-1', { defaultPriceListId: 'L-W', email: '' });
  assert.equal(r.status, 404, JSON.stringify(r.body));
  assert.equal(seen.updates.length, 0);
  // بلا الحقلين لا قفل لصفّ المندوب (مسار اليوم)
  reset();
  repWorld();
  assert.equal((await call('PUT', '/api/sales-reps/rep-1', { name: 'خالد ع', email: '' })).status, 200);
  assert.equal(repLocks().length, 0);
});

test('PUT /sales-reps/:id: بلا الحقلين مسار اليوم حرفياً، وفكّ الجهاز مع الأنواع في معاملة القفل نفسها، وP2003 على الافتراضي ⇒ 400 لا 500', async () => {
  reset();
  let seen = repWorld();
  assert.equal((await call('PUT', '/api/sales-reps/rep-1', { isActive: false, email: '' })).status, 200);
  assert.equal(seen.updates.length, 1);
  assert.equal(seen.updates[0].inTx, false);
  assert.equal(calls.some((c) => c.startsWith('$transaction')), false);
  assert.equal('defaultPriceListId' in seen.updates[0].data || 'allowedPriceTypes' in seen.updates[0].data, false);
  // فكّ الجهاز وحده: المعاملة المصفوفة كما كانت
  reset();
  seen = repWorld({ boundDeviceId: 'dev-1', boundDeviceName: 'جوال' });
  assert.equal((await call('PUT', '/api/sales-reps/rep-1', { requireBoundDevice: false, email: '' })).status, 200);
  assert.ok(calls.includes('$transaction([])'));
  assert.equal(seen.audits.length, 1);
  // فكّ الجهاز مع الأنواع: القفل ثم التعديل ثم سطر التدقيق في معاملةٍ تفاعلية واحدة
  reset();
  seen = repWorld({ boundDeviceId: 'dev-1', boundDeviceName: 'جوال' });
  const both = await call('PUT', '/api/sales-reps/rep-1', { requireBoundDevice: false, defaultPriceListId: 'L-X', email: '' });
  assert.equal(both.status, 200, JSON.stringify(both.body));
  assert.deepEqual(calls.filter((c) => /^\$|@tx$/.test(c)), ['$transaction(fn)', '$queryRaw', '$queryRaw', 'salesRep.update@tx', 'attendanceAudit.create@tx']);
  assert.equal(seen.updates[0].data.boundDeviceId, null);
  assert.equal(seen.updates[0].data.defaultPriceListId, 'L-X');
  assert.equal(seen.audits[0].data.action, 'UNBIND_DEVICE');
  // نوعٌ ليس من الشركة مع فكّ الجهاز: لا تعديل ولا سطر تدقيق
  reset();
  seen = repWorld({ boundDeviceId: 'dev-1' });
  assert.equal((await call('PUT', '/api/sales-reps/rep-1', { requireBoundDevice: false, defaultPriceListId: 'L-NOPE', email: '' })).status, 400);
  assert.deepEqual([seen.updates.length, seen.audits.length], [0, 0]);
  // مفتاح الافتراضي الأجنبي يفشل بعد الفحص (حذفٌ التزم بينهما) ⇒ 400 PRICE_LIST_INVALID — وP2003 على مفتاحٍ آخر يبقى 500
  reset();
  repWorld();
  scripted['salesRep.update'] = () => { throw Object.assign(new Error('Foreign key constraint failed'), { code: 'P2003', meta: { field_name: 'sales_reps_defaultPriceListId_fkey (index)' } }); };
  const fk = await call('PUT', '/api/sales-reps/rep-1', { defaultPriceListId: 'L-W', email: '' });
  assert.deepEqual([fk.status, fk.body.code], [400, 'PRICE_LIST_INVALID']);
  scripted['salesRep.update'] = () => { throw Object.assign(new Error('Foreign key constraint failed'), { code: 'P2003', meta: { field_name: 'sales_reps_locationId_fkey (index)' } }); };
  assert.equal((await call('PUT', '/api/sales-reps/rep-1', { isActive: true, email: '' })).status, 500);
});

test('المندوب لا يضبط أنواعه: الموجّه كله requireAdmin (403 بلا قراءة ولا كتابة)، ومسارات المندوب على صفّه لا تكتب الحقلين', async () => {
  reset(REP_USER);
  const seen = repWorld();
  for (const [m, url, body] of [
    ['PUT', '/api/sales-reps/rep-1', { defaultPriceListId: 'L-W', allowedPriceTypes: ['L-W', 'base'] }],
    ['POST', '/api/sales-reps', { ...NEW_REP, defaultPriceListId: 'L-W' }],
  ] as const) {
    const r = await call(m, url, body);
    assert.equal(r.status, 403, `${m} ${url}`);
  }
  assert.deepEqual([seen.updates.length, seen.creates.length], [0, 0]);
  assert.equal(calls.some((c) => c.startsWith('salesRep.')), false, 'لا قراءة صفّ مندوب');
  const reps = read('routes', 'salesReps.ts');
  assert.match(reps, /router\.use\(authenticate, requireAdmin, requireAdminPermission\('canManageSalesReps'\)\);/);
  // auth.ts يذكرهما في اختيار /me وحده — تحديث رمز الإشعارات وكلمة المرور لا يلمسانهما
  const auth = read('routes', 'auth.ts');
  for (const k of ['defaultPriceListId', 'allowedPriceTypes']) assert.equal(auth.split(k).length - 1, 1, `auth.ts: ${k}`);
});

// ═══ (٤) القراءة: قائمة المناديب و/auth/me ═══

test('GET /sales-reps و/:id يحملان defaultPriceListId وallowedPriceTypes، و/auth/me للمندوب كذلك (يدخلان rep_user)', async () => {
  reset();
  const selects: any[] = [];
  scripted['salesRep.findMany'] = (args) => { selects.push(args.select); return [{ id: 'rep-1', defaultPriceListId: 'L-W', allowedPriceTypes: ['L-W', 'base'] }]; };
  scripted['salesRep.findFirst'] = (args) => { selects.push(args.select); return { id: 'rep-1', defaultPriceListId: null, allowedPriceTypes: null }; };
  const list = await call('GET', '/api/sales-reps');
  assert.equal(list.status, 200, JSON.stringify(list.body));
  assert.deepEqual(list.body.data[0].allowedPriceTypes, ['L-W', 'base']);
  assert.equal((await call('GET', '/api/sales-reps/rep-1')).status, 200);
  assert.equal(selects.length, 2);
  for (const s of selects) assert.deepEqual([s.defaultPriceListId, s.allowedPriceTypes, s.canChangePriceList], [true, true, true]);

  reset(REP_USER);
  let meSelect: any = null;
  scripted['salesRep.findUnique'] = (args) => {
    meSelect = args.select;
    return {
      id: 'rep-1', name: 'خالد', tenantId: TENANT, canChangePriceList: true, defaultPriceListId: 'L-R', allowedPriceTypes: ['L-R', 'base'],
      tenant: { settings: { teamsEnabled: false } }, teamMemberships: [],
    };
  };
  const me = await call('GET', '/api/auth/me');
  assert.equal(me.status, 200, JSON.stringify(me.body));
  assert.deepEqual([meSelect.defaultPriceListId, meSelect.allowedPriceTypes], [true, true]);
  assert.deepEqual(
    [me.body.data.role, me.body.data.canChangePriceList, me.body.data.defaultPriceListId, me.body.data.allowedPriceTypes],
    ['SALES_REP', true, 'L-R', ['L-R', 'base']],
  );
  assert.equal('tenant' in me.body.data, false);
});

// ═══ (٥) /api/price-lists ═══

test('GET /price-lists/prices: المندوب بلا التبديل يرى أنواع عملائه ونوعه الافتراضي لا أنواعه المسموحة — وبه كلها، وبلا إعدادٍ كما كان', async () => {
  const world = (rep: { canChangePriceList: boolean; defaultPriceListId?: string | null; allowedPriceTypes?: unknown }, usedLists: string[]) => {
    const seen: Record<string, any> = {};
    scripted['priceList.findMany'] = () => [{ id: 'L-W', name: 'سعر الجملة' }, { id: 'L-R', name: 'سعر التجزئة' }, { id: 'L-X', name: 'سعر المؤسسات' }];
    scripted['salesRep.findFirst'] = (args) => { seen.rep = args; return { defaultPriceListId: null, allowedPriceTypes: null, ...rep }; };
    scripted['customer.findMany'] = () => usedLists.map((priceListId) => ({ priceListId }));
    rawScript = (r) => {
      if (!/FROM price_list_items/.test(r.sql)) return undefined;
      seen.ids = (r.values[2] as { values: string[] }).values;
      return [];
    };
    return seen;
  };
  const ids = (r: Reply) => r.body.data.map((l: { id: string }) => l.id);
  reset(REP_USER);
  let seen = world({ canChangePriceList: false, defaultPriceListId: 'L-X', allowedPriceTypes: ['base', 'L-R'] }, ['L-W']);
  let r = await call('GET', '/api/price-lists/prices');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(ids(r), ['L-W', 'L-X'], 'بترتيب الشركة — والمسموح وحده (L-R) لا يدخل كاش من لا يبدّل إليه');
  assert.deepEqual(seen.rep.where, { id: 'rep-1', tenantId: TENANT });
  assert.deepEqual(seen.rep.select, { canChangePriceList: true, defaultPriceListId: true });
  assert.deepEqual(seen.ids, ['L-W', 'L-X']);
  // الافتراضي وحده (لا عملاء على أنواع، ولا قيد)
  reset(REP_USER);
  world({ canChangePriceList: false, defaultPriceListId: 'L-R' }, []);
  assert.deepEqual(ids(await call('GET', '/api/price-lists/prices')), ['L-R']);
  // أنواعٌ مسموحة بلا عملاء عليها ولا افتراضي: لا شيء (لا قائمة جملةٍ كاملة في كاش جوالٍ لا يسعّر بها — 403 لو أرسلها)
  reset(REP_USER);
  world({ canChangePriceList: false, allowedPriceTypes: ['L-W', 'L-R', 'base'] }, []);
  r = await call('GET', '/api/price-lists/prices');
  assert.deepEqual(r.body.data, []);
  assert.equal(raws.length, 0, 'لا أسعار تُقرأ');
  // بلا إعداد المندوب: أنواع عملائه وحدها كما كان
  reset(REP_USER);
  world({ canChangePriceList: false }, ['L-R']);
  assert.deepEqual(ids(await call('GET', '/api/price-lists/prices')), ['L-R']);
  // بالتبديل: كل الأنواع ولو قُيّد مسموحه (القائمة بلا سؤال العملاء)
  reset(REP_USER);
  world({ canChangePriceList: true, allowedPriceTypes: ['L-R'] }, []);
  assert.deepEqual(ids(await call('GET', '/api/price-lists/prices')), ['L-W', 'L-R', 'L-X']);
  assert.equal(calls.includes('customer.findMany'), false);
  // الإدارة: كلها بلا صفّ مندوب
  reset();
  seen = world({ canChangePriceList: false }, []);
  assert.equal((await call('GET', '/api/price-lists/prices')).body.data.length, 3);
  assert.equal(seen.rep, undefined);
});

test('DELETE /price-lists/:id: افتراضيُّ مندوبٍ أو ضمن مسموحه ⇒ 409 PRICE_LIST_IN_USE بـrepsCount مع customersCount، تحت قفل النوع في المعاملة', async () => {
  const world = (customers: number, reps: number) => {
    const seen: Record<string, any> = { seq: [] as Array<[string, boolean]>, writes: [] as string[] };
    rawScript = (r) => {
      if (!/FROM price_lists WHERE id = \? AND "tenantId" = \? FOR UPDATE/.test(r.sql)) return undefined;
      seen.seq.push(['lock', r.inTx]);
      return r.values[0] === 'L-W' && r.values[1] === TENANT ? [{ id: 'L-W' }] : [];
    };
    scripted['customer.count'] = () => { seen.seq.push(['customers', inTx]); return customers; };
    scripted['salesRep.count'] = (args) => { seen.seq.push(['reps', inTx]); seen.repsWhere = args.where; return reps; };
    for (const k of ['invoice.updateMany', 'customer.updateMany', 'priceList.deleteMany']) scripted[k] = () => { seen.writes.push(k); return { count: 1 }; };
    return seen;
  };
  for (const [customers, reps, message] of [
    [0, 3, PRICE_LIST_IN_USE_BY.reps], [2, 1, PRICE_LIST_IN_USE_BY.both], [2, 0, PRICE_LIST_IN_USE_BY.customers],
  ] as const) {
    reset();
    const seen = world(customers, reps);
    const r = await call('DELETE', '/api/price-lists/L-W');
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.deepEqual(
      [r.body.code, r.body.customersCount, r.body.repsCount, r.body.message],
      ['PRICE_LIST_IN_USE', customers, reps, message],
    );
    assert.deepEqual(seen.seq, [['lock', true], ['customers', true], ['reps', true]], 'العدّان بعد القفل في المعاملة نفسها');
    assert.deepEqual(seen.repsWhere, { tenantId: TENANT, OR: [{ defaultPriceListId: 'L-W' }, { allowedPriceTypes: { array_contains: ['L-W'] } }] });
    assert.deepEqual(seen.writes, [], 'لا تفريغ ولا حذف');
  }
  assert.equal(PRICE_LIST_IN_USE_BY.customers, PRICE_LIST_MESSAGES.PRICE_LIST_IN_USE, 'رسالة العملاء وحدهم كما كانت');
  assert.match(PRICE_LIST_IN_USE_BY.reps, /مناديب/);
  assert.match(PRICE_LIST_IN_USE_BY.both, /عملاء ومناديب/);
  // «قوائم الأسعار» (٥ نوفمبر ٢٠٢٦): الرسائل الثلاث بالاسم الجديد — المعنى والرمز والعددان كما كانت
  for (const m of Object.values(PRICE_LIST_IN_USE_BY)) assert.ok(m.startsWith('قائمة الأسعار مستخدمة ل'), m);
  // لا عملاء ولا مناديب: الحذف يمضي كما كان
  reset();
  const seen = world(0, 0);
  assert.equal((await call('DELETE', '/api/price-lists/L-W')).status, 200);
  assert.deepEqual(seen.writes, ['invoice.updateMany', 'customer.updateMany', 'priceList.deleteMany']);
  // نوع شركةٍ أخرى: 404 قبل أي عدّ
  reset();
  const other = world(0, 5);
  assert.equal((await call('DELETE', '/api/price-lists/L-OTHER')).status, 404);
  assert.deepEqual(other.seq, [['lock', true]]);
});

// ═══ (٦) المزامنة وحمولة ERP والمخطّط ═══

test('المزامنة: defaultPriceListId وallowedPriceTypes مكشوفان في مورد sales-reps لا ممنوعان', () => {
  /* eslint-disable-next-line @typescript-eslint/no-var-requires */
  const { syncResource } = require('../services/apiSync') as typeof import('../services/apiSync');
  const def = syncResource('sales-reps')!;
  for (const c of ['defaultPriceListId', 'allowedPriceTypes', 'canChangePriceList']) {
    assert.equal((def.select as Record<string, unknown>)[c], true, c);
    assert.ok(!(c in def.denied), `${c} ممنوع`);
  }
});

test('ERP (payloadVersion 3): المندوب في الحمولة id وname وphone وحدها — حقلا الأنواع لا يدخلانها، والصفّ يمرّ كما هو', () => {
  const erp = read('services', 'erp.ts');
  const selects = [...erp.matchAll(/salesRep: \{ select: (\{[^}]*\}) \}/g)].map((m) => m[1]);
  assert.ok(selects.length >= 2, 'اختيار المندوب في الفواتير والسندات');
  for (const s of selects) assert.equal(s, '{ id: true, name: true, phone: true }');
  assert.ok(!/defaultPriceListId|allowedPriceTypes/.test(erp + read('services', 'erpPayload.ts')));
  const row = invoicePayloadRow({
    id: 'i', invoiceDate: '2026-11-02T10:00:00Z', total: 10, taxAmt: 0, priceListId: 'L-W', items: [],
    salesRep: { id: 'rep-1', name: 'خالد', phone: '0551234567' },
  }, 'Asia/Riyadh');
  assert.deepEqual(row.salesRep, { id: 'rep-1', name: 'خالد', phone: '0551234567' });
  assert.equal('priceListId' in row, false);
  assert.equal(row.payloadVersion, 3);
});

test('المخطّط إضافيٌّ لـdb push: الافتراضي اختياريٌّ بـSetNull على علاقةٍ مسمّاة، والمسموح Json اختياري، والعلاقة العكسية على النوع', () => {
  const s = fs.readFileSync(path.join(process.cwd(), 'prisma', 'schema.prisma'), 'utf8');
  const model = (name: string) => s.slice(s.indexOf(`model ${name} {`), s.indexOf('\n}', s.indexOf(`model ${name} {`)));
  assert.match(model('SalesRep'), /defaultPriceListId String\?/);
  assert.match(model('SalesRep'), /defaultPriceList\s+PriceList\?\s+@relation\("RepDefaultPriceList", fields: \[defaultPriceListId\], references: \[id\], onDelete: SetNull\)/);
  assert.match(model('SalesRep'), /allowedPriceTypes\s+Json\?/);
  assert.match(model('PriceList'), /repsDefault\s+SalesRep\[\]\s+@relation\("RepDefaultPriceList"\)/);
});

// «منع تكرار العملاء عند فتح عميل جديد» — قيدٌ في إعدادات المندوب (طلب المالك ٢٣ نوفمبر ٢٠٢٦). المعالجات الحقيقية (/api/customers
// و/api/sales-reps و/api/auth/me) فوق Prisma مزيّف بلا قاعدة بيانات، و$queryRaw يُنفَّذ بمحاكاة SQL الخدمة نفسها على صفوف العالم
// (مسحٌ واحد بشروطٍ مربوطة بـOR ورتبة الحقل، وحارس الطول، وtranslate بالوسيطين المرسلَين، وضمّ المسافات، وقيد الشركة والمحذوف والعميل
// نفسه حين يحملها نصّ الاستعلام). يثبت:
//   • التطبيع: الهمزات والتاء المربوطة والياءات والتشكيل والتطويل والمسافات وعلامات الاتجاه والأرقام الهندية واللاتينية الكبيرة،
//     والجوال بـnormImportPhone (+966/00966/05/الهندية)، والفارغ والتافه لا يُطابَق — وجدول SQL يطابق foldText حرفياً.
//   • كل عَلَم وحده والتركيبة (الترتيب: الجوال ثم الاسم ثم العنوان)، والنطاق الشركة كلها لا عملاء المندوب، والمحذوف لا يُعدّ،
//     وشركة أخرى لا تُعدّ.
//   • التعديل: الحقل بلا تغيير (ولو اختلف شكله) لا يُفحص، والمتغيّر يُفحص مستثنياً العميل نفسه.
//   • الإدارة ومفتاح API وإعادة رفع صندوق المندوب معفيّة، والمندوب بلا عَلَم كاليوم حرفياً (لا استعلام).
//   • اسم العميل الآخر ومعرّفه لمن يراه وحده (canAccessCustomer).
//   • «الموقع ضمن ٣٠ متراً» قاعدة الشركة كما هي للجميع.
//   • الإعدادات: الحقول الثلاثة في إنشاء المندوب وتعديله وقراءته و/auth/me والمزامنة، والمخطّط إضافيّ بـfalse بلا @@unique.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { Prisma } from '@prisma/client';

// ═══ حقن البدائل قبل تحميل الموجّهات (نمط customer-put-upsert.test.ts وprice-lists-reps.test.ts) ═══

process.env.JWT_SECRET = process.env.JWT_SECRET || 'rep-customer-dedup-test-secret';
const SRC = path.join(__dirname, '..');
const read = (...p: string[]): string => fs.readFileSync(path.join(SRC, ...p), 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

/* eslint-disable @typescript-eslint/no-explicit-any */
type Raw = { sql: string; values: unknown[] };
let calls: { op: string; args: any }[] = [];
let raws: Raw[] = [];
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
      return async (arg: unknown) => (typeof arg === 'function' ? (arg as (tx: unknown) => Promise<unknown>)(prismaFake) : Promise.all(arg as Promise<unknown>[]));
    }
    if (key === '$queryRaw' || key === '$executeRaw') {
      return async (strings: TemplateStringsArray, ...values: unknown[]) => {
        // تسطيح القطع المتداخلة (Prisma.sql/Prisma.empty) كما تفعل Prisma: نصٌّ بعلامات ? وقيمٌ مرتّبة
        const q = Prisma.sql(strings, ...values);
        const r: Raw = { sql: q.sql.replace(/\s+/g, ' '), values: q.values };
        raws.push(r);
        calls.push({ op: key, args: r });
        const out = rawScript(r);
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

const TENANT = 'T1';
type User = { id: string; role: string; tenantId: string; name?: string; apiKeyId?: string };
const ADMIN: User = { id: 'admin-1', role: 'ADMIN', tenantId: TENANT, name: 'مدير' };
const API_KEY: User = { id: 'admin-1', role: 'ADMIN', tenantId: TENANT, apiKeyId: 'key-1' };
const REP: User = { id: 'rep-1', role: 'SALES_REP', tenantId: TENANT, name: 'خالد' };
let currentUser: User = ADMIN;
const pass = (_req: unknown, _res: unknown, next: () => void): void => next();

stub('config/database', { default: prismaFake });
stub('services/mailer', { async sendMail() { return true; }, mailLayout: () => '' });
/* eslint-disable @typescript-eslint/no-var-requires */
const realAuth = require('../middleware/auth') as Record<string, unknown>;
stub('middleware/auth', {
  ...realAuth,
  authenticate: (req: { user?: unknown }, _res: unknown, next: () => void) => { req.user = currentUser; next(); },
  requireAdmin: pass, requireAccounting: pass, requireAdminPermission: () => pass,
});
const dedupSvc = require('../services/customerDedup') as typeof import('../services/customerDedup');
const { normImportPhone } = require('../services/importMatch') as typeof import('../services/importMatch');
const { SYNC_RESOURCES } = require('../services/apiSync') as typeof import('../services/apiSync');
const customersRouter = (require('../routes/customers') as typeof import('../routes/customers')).default;
const salesRepsRouter = (require('../routes/salesReps') as typeof import('../routes/salesReps')).default;
const authRouter = (require('../routes/auth') as typeof import('../routes/auth')).default;
const { errorHandler } = require('../middleware/errorHandler') as typeof import('../middleware/errorHandler');
/* eslint-enable @typescript-eslint/no-var-requires */
const {
  CUSTOMER_DUPLICATE, SQL_FOLD_FROM, SQL_FOLD_TO, foldText, normalizeName, normalizeAddress, repDedupChecks, changedDedupChecks, customerDupBody,
} = dedupSvc;

// ═══ العُدّة ═══

let server: { port: number; close: () => Promise<void> } | null = null;
async function startServer() {
  if (server) return server;
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/customers', customersRouter);
  app.use('/api/sales-reps', salesRepsRouter);
  app.use('/api/auth', authRouter);
  app.use(errorHandler);
  const s = http.createServer(app);
  await new Promise<void>(resolve => s.listen(0, '127.0.0.1', resolve));
  server = { port: (s.address() as AddressInfo).port, close: () => new Promise<void>(r => { s.closeAllConnections?.(); s.close(() => r()); }) };
  return server;
}
after(async () => { await server?.close(); server = null; });

type Reply = { status: number; body: Record<string, any> };
async function call(method: 'POST' | 'PUT' | 'GET', url: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  const s = await startServer();
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
  return new Promise<Reply>((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: s.port, method, path: url, agent: false,
      headers: { connection: 'close', ...headers, ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': String(payload.length) } : {}) },
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

// ═══ محاكاة SQL الخدمة (دلالة PostgreSQL) ═══

/** translate(): كل حرف في from يقابل نظيره في to، والزائد عن طول to يُحذف، وغيرهما كما هو */
function pgTranslate(s: string, from: string, to: string): string {
  const f = Array.from(from);
  const t = Array.from(to);
  let out = '';
  for (const ch of s) {
    const i = f.indexOf(ch);
    if (i < 0) out += ch;
    else if (i < t.length) out += t[i];
  }
  return out;
}
/** btrim(regexp_replace(x, '[[:space:]]+', ' ', 'g')) — [[:space:]] المحارف اللاتينية البيضاء */
const pgCollapse = (s: string): string => s.replace(/[\t\n\v\f\r ]+/g, ' ').replace(/^ +| +$/g, '');
const pgPhoneDigits = (s: string): string => pgTranslate(s, '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789').replace(/[^0-9]/g, '');

type Row = {
  id: string; tenantId: string; name: string; phone: string; address?: string | null; status?: string;
  lat?: number | null; lng?: number | null; createdAt: number; assignments?: string[];
};

/** length() في PostgreSQL: نقاط الترميز، وNULL لـNULL */
const pgLength = (s: string | null | undefined): number | null => (s == null ? null : Array.from(s).length);

/** شرطٌ في استعلام الخدمة: العمود وقيمه (فهارسها في values) ومقيّمه على الصفّ بدلالة PostgreSQL (NULL ⇒ لا يطابق) */
type Pred = { col: 'phone' | 'name' | 'address'; sig: string; test: (x: Row) => boolean };
const PHONE_PRED_RE = /\(strpos\(regexp_replace\(translate\(coalesce\(phone, ''\), '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789'\), '\[\^0-9\]', '', 'g'\), \$(\d+)\) > 0\)/y;
const TEXT_PRED_RE = /\(length\((name|address)\) >= \$(\d+)::int AND btrim\(regexp_replace\(translate\(coalesce\(\1, ''\), \$(\d+), \$(\d+)\), '\[\[:space:\]\]\+', ' ', 'g'\)\) = \$(\d+)\)/y;

/**
 * استعلام الخدمة على صفوف العالم: مسحٌ واحد بشروطٍ مربوطة بـOR، مرتَّبٌ برتبة أوّل شرطٍ يطابقه الصفّ (CASE) ثم الأقدم، بحدٍّ.
 * كل قيدٍ يُطبَّق فقط إن حمله نصّ الاستعلام (فحذفه من SQL يُفشل الاختبار)، وكل قيمةٍ يجب أن تُستهلك، وحارس الطول يُقيَّم كما في
 * PostgreSQL قبل الطيّ — فحارسٌ خاطئ (أطول من الخام المطابق) يُسقط تكراراً حقيقياً ويُفشل الاختبار
 */
function emulateDedupSql(rows: Row[], r: Raw): unknown {
  if (!/FROM customers/.test(r.sql)) return undefined;
  let n = 0;
  const sql = r.sql.trim().replace(/\?/g, () => `$${n++}`);
  assert.equal(n, r.values.length, 'علامات ? بعدد القيم');
  const used = new Set<number>();
  const val = (i: string): unknown => { used.add(Number(i)); return r.values[Number(i)]; };
  const m = /^SELECT id, name, phone, address FROM customers WHERE "tenantId" = \$(\d+) AND status <> 'DELETED' (?:AND id <> \$(\d+) )?AND \((.*)\) ORDER BY (?:CASE (.*) END, )?"createdAt" ASC, id ASC LIMIT (\d+)$/.exec(sql);
  assert.ok(m, `استعلامٌ غير معروف: ${sql}`);
  const [, tidAt, exceptAt, where, rankSql, limit] = m;
  /** شروط نصٍّ متتالية مفصولة بفاصلٍ ثابت — لا نصّ غيرها */
  const parsePreds = (text: string, sep: RegExp): Pred[] => {
    const out: Pred[] = [];
    let at = 0;
    while (at < text.length) {
      if (out.length) { sep.lastIndex = at; const s = sep.exec(text); assert.ok(s, `فاصلٌ متوقَّع في: ${text.slice(at)}`); at = sep.lastIndex; }
      PHONE_PRED_RE.lastIndex = at; TEXT_PRED_RE.lastIndex = at;
      const p = PHONE_PRED_RE.exec(text);
      if (p) {
        const tail = String(val(p[1]));
        out.push({ col: 'phone', sig: `phone:${tail}`, test: x => pgPhoneDigits(x.phone ?? '').includes(tail) });
        at = PHONE_PRED_RE.lastIndex;
        continue;
      }
      const t = TEXT_PRED_RE.exec(text);
      assert.ok(t, `شرطٌ غير معروف: ${text.slice(at)}`);
      const col = t[1] as 'name' | 'address';
      const [minLen, from, to, key] = [Number(val(t[2])), String(val(t[3])), String(val(t[4])), String(val(t[5]))];
      out.push({
        col, sig: `${col}:${minLen}:${key}:${from === SQL_FOLD_FROM && to === SQL_FOLD_TO}`,
        test: x => { const raw = x[col] ?? null; const len = pgLength(raw); return len !== null && len >= minLen && pgCollapse(pgTranslate(raw!, from, to)) === key; },
      });
      at = TEXT_PRED_RE.lastIndex;
    }
    return out;
  };
  const preds = parsePreds(where, / OR /y);
  assert.ok(preds.length >= 1, 'شرطٌ واحدٌ على الأقل');
  // الرتبة: CASE WHEN p0 THEN 0 WHEN p1 THEN 1 … ELSE n-1 — الشروط نفسها بترتيب WHERE (والشرط الواحد بلا CASE)
  let rankOf = (_x: Row): number => 0;
  if (preds.length > 1) {
    assert.ok(rankSql, 'عدّة شروط ⇒ ترتيبٌ بالرتبة');
    const body = /^((?:WHEN .*? THEN \d+ ?)+)ELSE (\d+)$/.exec(rankSql!);
    assert.ok(body, `CASE غير معروف: ${rankSql}`);
    const whens = [...body[1].matchAll(/WHEN (.*?) THEN (\d+)(?= WHEN | ?$)/g)];
    const casePreds = whens.map(w => parsePreds(w[1], / /y)[0]);
    assert.deepEqual(whens.map(w => Number(w[2])), casePreds.map((_, i) => i), 'رتبٌ متتالية');
    assert.equal(Number(body[2]), preds.length - 1, 'ELSE الرتبة الأخيرة');
    assert.deepEqual(casePreds.map(p => p.sig), preds.slice(0, -1).map(p => p.sig), 'CASE بشروط WHERE نفسها وترتيبها');
    rankOf = x => { const i = casePreds.findIndex(p => p.test(x)); return i < 0 ? preds.length - 1 : i; };
  } else {
    assert.equal(rankSql, undefined, 'الشرط الواحد بلا CASE');
  }
  const tid = val(tidAt);
  const except = exceptAt !== undefined ? val(exceptAt) : undefined;
  assert.equal(used.size, r.values.length, `قيمٌ غير مستهلكة في الاستعلام: ${JSON.stringify(r.values.filter((_, i) => !used.has(i)))}`);
  const list = rows
    .filter(x => x.tenantId === tid && (x.status ?? 'ACTIVE') !== 'DELETED' && (except === undefined || x.id !== except))
    .filter(x => preds.some(p => p.test(x)))
    .sort((a, b) => rankOf(a) - rankOf(b) || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  return list.slice(0, Number(limit)).map(x => ({ id: x.id, name: x.name, phone: x.phone, address: x.address ?? null }));
}

type Flags = { dedupCustomerPhone?: boolean; dedupCustomerName?: boolean; dedupCustomerAddress?: boolean };

/**
 * عالمٌ في الشركة T1: c1 عميل المندوب (مُسنَد له)، وc2 عميل مندوبٍ آخر (غير مُسنَد)، وc-del محذوف، وc-t2 في شركة أخرى.
 * isolation = عزل عملاء المناديب (canAccessCustomer يمنع غير المُسنَد)
 */
function world(o: { user?: User; flags?: Flags; isolation?: boolean } = {}) {
  currentUser = o.user ?? REP;
  calls = []; raws = [];
  const rows: Row[] = [
    { id: 'c1', tenantId: TENANT, name: 'بقالة الحي', phone: '0501111111', address: 'حي الملز، شارع ١٠', createdAt: 1, assignments: ['rep-1'], lat: 24.70, lng: 46.70 },
    { id: 'c2', tenantId: TENANT, name: 'مؤسسة أحمد للتجارة', phone: '+966 55 123 4567', address: 'حي النسيم - شارع الأمير ماجد', createdAt: 2, assignments: ['rep-2'], lat: 24.80, lng: 46.80 },
    { id: 'c-del', tenantId: TENANT, name: 'سوبرماركت الواحة', phone: '0562222222', address: 'طريق الملك فهد', status: 'DELETED', createdAt: 3, assignments: ['rep-1'] },
    { id: 'c-t2', tenantId: 'T2', name: 'محلات الريان', phone: '0573333333', address: 'شارع التحلية', createdAt: 4, assignments: [] },
  ];
  const created: Record<string, any>[] = [];
  const updated: Record<string, any>[] = [];
  scripted = {
    'salesRep.findUnique': () => ({ canAddCustomer: true, canEditCustomer: true, requireCustomerProximity: false, ...o.flags }),
    'admin.findUnique': () => ({ scopeEnabled: false, isActive: true }),
    'companySettings.findUnique': () => ({ customerIsolationEnabled: o.isolation === true }),
    'tenant.findUnique': () => ({ zatcaPhase2Enabled: false, settings: { countryCode: 'SA', zatcaPhase2StartedAt: null } }),
    'customer.findFirst': (args) => {
      const w = args?.where ?? {};
      if (w.clientRef || !w.id) return null;
      const r = rows.find(x => x.id === w.id && x.tenantId === w.tenantId
        && (!w.assignments || (x.assignments ?? []).includes(w.assignments.some.salesRepId)));
      return r ? { id: r.id, phone: r.phone, name: r.name, address: r.address ?? null } : null;
    },
    'customer.findUnique': (args) => {
      const r = rows.find(x => x.id === args?.where?.id);
      return r ? { tenantId: r.tenantId } : null;
    },
    'customer.findMany': (args) => {
      const w = args?.where ?? {};
      if (!w.lat) return [];
      return rows.filter(x => x.tenantId === w.tenantId && (x.status ?? 'ACTIVE') !== 'DELETED' && x.lat != null && x.lng != null
        && x.lat >= w.lat.gte && x.lat <= w.lat.lte && x.lng >= w.lng.gte && x.lng <= w.lng.lte)
        .map(x => ({ id: x.id, name: x.name, lat: x.lat, lng: x.lng }));
    },
    'customer.create': (args) => {
      const row = { id: args.data.id ?? `c-new-${created.length + 1}`, ...args.data };
      created.push(args.data);
      return row;
    },
    'customer.update': (args) => { updated.push(args.data); return { id: args.where.id, ...args.data }; },
  };
  rawScript = (r) => emulateDedupSql(rows, r);
  const dedupQueries = () => raws.filter(r => /FROM customers/.test(r.sql));
  return { rows, created, updated, dedupQueries };
}

const ALL: Flags = { dedupCustomerPhone: true, dedupCustomerName: true, dedupCustomerAddress: true };

// ═══ (١) التطبيع ═══

test('تطبيع الاسم والعنوان: الهمزات والتاء المربوطة والياءات والتشكيل والتطويل والمسافات والاتجاه والأرقام واللاتينية الكبيرة شكلٌ واحد', () => {
  const same: [string, string][] = [
    ['أحمد', 'احمد'], ['إبراهيم', 'ابراهيم'], ['آمنة', 'امنه'], ['ٱلنور', 'النور'],
    ['بقالة النور', 'بقاله النور'], ['مستشفى', 'مستشفي'], ['کرم علی', 'كرم علي'],
    ['مُحَمَّد', 'محمد'], ['بقـــالة', 'بقاله'], ['اللّٰه', 'الله'],
    ['  بقالة   النور  ', 'بقالة النور'], ['بقالة\u00A0النور', 'بقالة النور'], ['بقالة\tالنور\n', 'بقالة النور'],
    ['\u200Fبقالة النور\u200E', 'بقالة النور'], ['بقالة\u200Cالنور', 'بقالةالنور'],
    ['شارع ١٥', 'شارع 15'], ['شارع ۱۵', 'شارع 15'],
    ['ABC Market', 'abc market'], ['CAFÉ', 'café'],
  ];
  for (const [a, b] of same) {
    assert.equal(foldText(a), foldText(b), `${a} = ${b}`);
    assert.equal(normalizeName(a), normalizeName(b), `normalizeName: ${a}`);
    assert.equal(normalizeAddress(a), normalizeAddress(b), `normalizeAddress: ${a}`);
  }
  assert.equal(foldText('  مُؤسَّسة   أحمد للتجارة '), 'مؤسسه احمد للتجاره');
  // المختلف يبقى مختلفاً
  for (const [a, b] of [['بقالة النور', 'بقالة النوري'], ['بقالة النور', 'بقالة نور'], ['شارع 15', 'شارع 16'], ['علي', 'عالي']]) {
    assert.notEqual(normalizeName(a), normalizeName(b), `${a} ≠ ${b}`);
  }
});

test('الفارغ والتافه لا يُطابَق أبداً: الفارغ والمسافات والرموز وحرفٌ واحد والاسم البديل «عميل» وعبارات «لا شيء»', () => {
  for (const v of [undefined, null, '', '   ', '-', '—', '.', '...', 'ا', '٥', 'عميل', ' عَميل ', 'لا يوجد', 'لايوجد', 'بدون عنوان', 'غير معروف', 'N/A', 'none', '\u200F-\u200F']) {
    assert.equal(normalizeName(v), null, JSON.stringify(v));
    assert.equal(normalizeAddress(v), null, JSON.stringify(v));
  }
  for (const v of ['علي', 'AB', '12', 'حي الملز']) assert.notEqual(normalizeName(v), null, v);
});

test('الجوال بـnormImportPhone: +966 و00966 و966 و05 و5 والأرقام الهندية رقمٌ واحد، والتافه لا يُطابَق', () => {
  const k = normImportPhone('0551234567');
  for (const v of ['+966 55 123 4567', '00966551234567', '966551234567', '٠٥٥١٢٣٤٥٦٧', '۰۵۵۱۲۳۴۵۶۷', '551234567', '055-123-4567', '0551234567.0']) {
    assert.equal(normImportPhone(v), k, v);
  }
  for (const v of ['', '   ', '0000000000', '123', '-']) assert.equal(normImportPhone(v), null, v);
});

test('جدول الطيّ في SQL يطابق foldText حرفياً: translate بالوسيطين ثم ضمّ [[:space:]] ثم btrim', () => {
  const from = Array.from(SQL_FOLD_FROM);
  assert.equal(new Set(from).size, from.length, 'حرفٌ مكرّر في FROM (translate يأخذ أوّله)');
  assert.ok(Array.from(SQL_FOLD_TO).length < from.length, 'محارف الحذف بعد المقابلات');
  for (const ch of Array.from(SQL_FOLD_TO)) assert.ok(ch.length === 1, 'المقابل حرفٌ واحد');
  const corpus = [
    'مُؤسَّسة   أحمد للتجارة', 'إبراهيم آل سعود', 'بقـــالة النور\u00A0الجديدة', '\u200Fحي النسيم، شارع ١٥\u200E', 'ABC Market\t#2',
    'CAFÉ Ünïcode', 'کرم علی', 'مستشفى الأمل', '\uFEFFعنوان', '  ', '', 'Riyadh\u2003Olaya\u3000St', 'لا يوجد',
  ];
  for (const s of corpus) assert.equal(pgCollapse(pgTranslate(s, SQL_FOLD_FROM, SQL_FOLD_TO)), foldText(s), JSON.stringify(s));
  // الخدمة ترسل الجدولين وسيطين — لا نصّاً منسوخاً يفترق عنهما
  const svc = read('services', 'customerDedup.ts');
  assert.match(svc, /translate\(coalesce\(\$\{col\}, ''\), \$\{SQL_FOLD_FROM\}, \$\{SQL_FOLD_TO\}\), '\[\[:space:\]\]\+', ' ', 'g'\)\) = \$\{key\}/);
});

// ═══ (٢) من يُفحص ومتى ═══

test('repDedupChecks: المندوب الحيّ بأعلامه وحده — الإدارة ومفتاح API وإعادة رفع الصندوق والمندوب بلا عَلَم ⇒ لا فحص', () => {
  const rep = { role: 'SALES_REP' };
  assert.deepEqual(repDedupChecks({ headers: {}, user: rep }, { dedupCustomerName: true }), { phone: false, name: true, address: false });
  assert.deepEqual(repDedupChecks({ headers: {}, user: rep }, ALL), { phone: true, name: true, address: true });
  assert.equal(repDedupChecks({ headers: {}, user: rep }, {}), null, 'بلا عَلَم');
  assert.equal(repDedupChecks({ headers: {}, user: rep }, null), null);
  assert.equal(repDedupChecks({ headers: {}, user: { role: 'ADMIN' } }, ALL), null, 'الإدارة');
  assert.equal(repDedupChecks({ headers: {}, user: { role: 'SALES_REP', apiKeyId: 'k' } }, ALL), null, 'مفتاح API');
  assert.equal(repDedupChecks({ headers: { 'x-fs-replay': '1' }, user: rep }, ALL), null, 'إعادة رفع الصندوق');
  assert.notEqual(repDedupChecks({ headers: { 'x-fs-replay': '0' }, user: rep }, ALL), null);
});

test('changedDedupChecks: المتغيّر المطبَّع وحده — الشكل الآخر للقيمة نفسها والغائب والممسوح لا يُفحص', () => {
  const all = { phone: true, name: true, address: true };
  const stored = { phone: '0551234567', name: 'بقالة النور', address: 'حي الملز' };
  assert.equal(changedDedupChecks(all, { phone: '+966551234567', name: 'بقاله  النور', address: ' حي الملز ' }, stored), null, 'الشكل الآخر للقيمة نفسها');
  assert.equal(changedDedupChecks(all, {}, stored), null, 'الغائب');
  assert.equal(changedDedupChecks(all, { phone: null, name: null, address: '' }, stored), null, 'الممسوح');
  assert.deepEqual(changedDedupChecks(all, { name: 'بقالة الحي', phone: '0551234567' }, stored), { phone: false, name: true, address: false });
  assert.deepEqual(changedDedupChecks({ phone: false, name: false, address: true }, { name: 'آخر', address: 'حي النسيم' }, stored), { phone: false, name: false, address: true });
  assert.equal(changedDedupChecks(null, { name: 'آخر' }, stored), null);
});

test('ردّ 409 CUSTOMER_DUPLICATE: الحقل والرسالة لكل حقل، واسم الآخر ومعرّفه لمن يراه وحده', () => {
  const cases: [any, RegExp, string][] = [
    ['phone', /^رقم الجوال مسجل للعميل «بقالة النور»$/, 'رقم الجوال مسجل لعميل آخر في الشركة'],
    ['name', /^اسم العميل مسجل للعميل «بقالة النور»$/, 'يوجد عميل آخر بالاسم نفسه في الشركة'],
    ['address', /^العنوان مسجل للعميل «بقالة النور»$/, 'يوجد عميل آخر بالعنوان نفسه في الشركة'],
  ];
  for (const [field, seenRe, hiddenMsg] of cases) {
    const seen = customerDupBody({ field, id: 'c9', name: 'بقالة النور' }, true);
    assert.deepEqual([seen.success, seen.code, seen.field, (seen as any).existingId, (seen as any).existingName], [false, CUSTOMER_DUPLICATE, field, 'c9', 'بقالة النور']);
    assert.match(seen.message, seenRe);
    const hidden = customerDupBody({ field, id: 'c9', name: 'بقالة النور' }, false);
    assert.equal(hidden.message, hiddenMsg);
    assert.equal(hidden.field, field);
    assert.equal('existingId' in hidden || 'existingName' in hidden, false, 'لا يُكشف عميلٌ غير مُسنَد');
  }
});

// ═══ (٣) الإنشاء من المندوب ═══

test('المندوب بلا عَلَم: يفتح عميلاً بجوال واسم وعنوان مكرَّرة كاليوم حرفياً — ولا استعلام تكرار', async () => {
  const w = world({ user: REP });
  const r = await call('POST', '/api/customers', { name: 'مؤسسة أحمد للتجارة', phone: '0551234567', address: 'حي النسيم - شارع الأمير ماجد' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(w.created.length, 1);
  assert.equal(w.dedupQueries().length, 0, 'لا استعلام');
});

test('كل عَلَم وحده: الجوال يمنع الجوال وحده، والاسم الاسم، والعنوان العنوان — بالتطبيع', async () => {
  const dupBody = { name: 'مؤسسه احمد  للتجاره', phone: '٠٥٥١٢٣٤٥٦٧', address: 'حي النسيم - شارع الامير ماجد' };
  for (const [flag, field] of [['dedupCustomerPhone', 'phone'], ['dedupCustomerName', 'name'], ['dedupCustomerAddress', 'address']] as const) {
    const w = world({ user: REP, flags: { [flag]: true } });
    const r = await call('POST', '/api/customers', dupBody);
    assert.equal(r.status, 409, `${flag}: ${JSON.stringify(r.body)}`);
    assert.deepEqual([r.body.code, r.body.field], [CUSTOMER_DUPLICATE, field]);
    assert.equal(w.created.length, 0, 'لا كتابة');
    assert.equal(w.dedupQueries().length, 1, `${flag}: استعلامٌ واحد للحقل المفعّل وحده`);
    // والحقلان الآخران مكرّران لا يمنعان: الحقل المفعّل وحده بقيمةٍ جديدة
    const fresh = { phone: '0598888888', name: 'اسم جديد تماماً', address: 'عنوان جديد تماماً' }[field];
    const w2 = world({ user: REP, flags: { [flag]: true } });
    const r2 = await call('POST', '/api/customers', { ...dupBody, [field]: fresh });
    assert.equal(r2.status, 201, `${flag}: الحقلان الآخران لا يُفحصان — ${JSON.stringify(r2.body)}`);
    assert.equal(w2.created.length, 1);
  }
});

test('التركيبة: الأعلام الثلاثة — أوّل تكرارٍ بالترتيب (الجوال ثم الاسم ثم العنوان)، والسليم يُفتح', async () => {
  let w = world({ user: REP, flags: ALL });
  let r = await call('POST', '/api/customers', { name: 'مؤسسة أحمد للتجارة', phone: '0599999999', address: 'حي النسيم - شارع الأمير ماجد' });
  assert.deepEqual([r.status, r.body.field], [409, 'name'], 'الجوال سليم ⇒ الاسم أوّلاً');
  r = await call('POST', '/api/customers', { name: 'جديد', phone: '00966551234567', address: 'حي النسيم - شارع الأمير ماجد' });
  assert.deepEqual([r.status, r.body.field], [409, 'phone']);
  r = await call('POST', '/api/customers', { name: 'جديد', phone: '0599999999', address: '  حي النسيم -  شارع الأمير ماجد ' });
  assert.deepEqual([r.status, r.body.field], [409, 'address']);
  w = world({ user: REP, flags: ALL });
  r = await call('POST', '/api/customers', { name: 'بقالة جديدة', phone: '0599999999', address: 'حي الروضة' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(w.created[0].createdBySalesRepId, 'rep-1');
  assert.equal(w.dedupQueries().length, 1, 'مسحٌ واحد للحقول الثلاثة لا ثلاثة متتالية');
  const q = w.dedupQueries()[0];
  assert.match(q.sql, /WHERE "tenantId" = \? AND status <> 'DELETED'/, 'الشركة وغير المحذوف');
  assert.match(q.sql, /LIMIT \d+$/, 'مرشّحون معدودون');
  assert.equal((q.sql.match(/ OR /g) ?? []).length, 2, 'الشروط الثلاثة بـOR في المسح نفسه');
  assert.match(q.sql, /ORDER BY CASE WHEN .* THEN 0 WHEN .* THEN 1 ELSE 2 END, "createdAt" ASC, id ASC/, 'أولوية الحقل ثم الأقدم');
  // حارس الطول الرخيص قبل الطيّ في كل شرطٍ نصّي (AND من اليسار)
  for (const col of ['name', 'address']) {
    assert.match(q.sql, new RegExp(`\\(length\\(${col}\\) >= \\?::int AND btrim\\(regexp_replace\\(translate\\(coalesce\\(${col}, ''\\)`), `${col}: الحارس أوّلاً`);
  }
});

test('المسح الواحد: أولوية الحقل لا يزيحها مئات العملاء بالاسم نفسه (فروع سلسلة) — والحقل المفعّل وحده شرطٌ بلا CASE', async () => {
  const w = world({ user: REP, flags: ALL });
  // ٢٥٠ فرعاً قديماً بالاسم نفسه، وعميلٌ أحدث منها كلها بالجوال المكرّر
  for (let i = 0; i < 250; i++) w.rows.push({ id: `chain-${String(i).padStart(3, '0')}`, tenantId: TENANT, name: 'صيدلية الشفاء', phone: '', address: `فرع ${i}`, createdAt: 10 + i });
  w.rows.push({ id: 'c-late-phone', tenantId: TENANT, name: 'محل متأخر', phone: '0591234321', address: null, createdAt: 9999 });
  let r = await call('POST', '/api/customers', { name: 'صيدليه الشفاء', phone: '+966591234321' });
  assert.deepEqual([r.status, r.body.field, r.body.existingId], [409, 'phone', 'c-late-phone'], JSON.stringify(r.body));
  // الاسم وحده مكرّرٌ ⇒ أقدم فرع
  r = await call('POST', '/api/customers', { name: 'صيدلية الشفاء', phone: '0590000001' });
  assert.deepEqual([r.status, r.body.field, r.body.existingId], [409, 'name', 'chain-000']);
  assert.equal(w.dedupQueries().length, 2, 'مسحٌ واحد لكل طلب');
  // عَلَمٌ واحد ⇒ شرطٌ واحد بلا CASE
  const w2 = world({ user: REP, flags: { dedupCustomerAddress: true } });
  r = await call('POST', '/api/customers', { name: 'جديد', phone: '0551234567', address: 'حي الروضة' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(w2.dedupQueries().length, 1);
  assert.doesNotMatch(w2.dedupQueries()[0].sql, /CASE| OR |coalesce\(phone|coalesce\(name/);
});

test('حارس الطول: طول PostgreSQL بنقاط الترميز (لا UTF-16) والخام الأطول بالتشكيل والمسافات يطابق — والحارس لا يُسقط تكراراً حقيقياً', async () => {
  const w = world({ user: REP, flags: { dedupCustomerName: true, dedupCustomerAddress: true } });
  w.rows.push(
    { id: 'c-astral', tenantId: TENANT, name: '𝔸𝔹 Store', phone: '', address: null, createdAt: 5 },
    { id: 'c-diac', tenantId: TENANT, name: 'جديد', phone: '', address: '  مُجَمَّعُ   الـــنُّور  ', createdAt: 6 },
  );
  let r = await call('POST', '/api/customers', { name: '𝔸𝔹 store' });
  assert.deepEqual([r.status, r.body.field, r.body.existingId], [409, 'name', 'c-astral'], `محارف خارج BMP: ${JSON.stringify(r.body)}`);
  const q = w.dedupQueries()[0];
  const guardAt = q.sql.indexOf('length(name) >= ?') + 'length(name) >= '.length;
  assert.equal(q.values[(q.sql.slice(0, guardAt).match(/\?/g) ?? []).length], 8, 'طول المفتاح بنقاط الترميز (لا 10 وحدات UTF-16)');
  // الخام بتشكيله وتطويله ومسافاته أطول من مفتاحه المطبَّع — والحارس «الخام ≥ المفتاح» يمرّره
  r = await call('POST', '/api/customers', { name: 'آخر تماماً', address: 'مجمع النور' });
  assert.deepEqual([r.status, r.body.field, r.body.existingId], [409, 'address', 'c-diac']);
  // وعنوانٌ آخر لا يطابق
  r = await call('POST', '/api/customers', { name: 'آخر تماماً ٢', address: 'مجمع النور الكبير' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
});

test('النطاق الشركة كلها: عميل مندوبٍ آخر يمنع — وشركةٌ أخرى والمحذوف لا يُعدّان', async () => {
  const w = world({ user: REP, flags: ALL });
  // c2 لمندوبٍ آخر (غير مُسنَد لـrep-1)
  assert.equal((await call('POST', '/api/customers', { name: 'مؤسسة أحمد للتجارة' })).status, 409);
  // c-t2 في شركة أخرى بالقيم نفسها
  let r = await call('POST', '/api/customers', { name: 'محلات الريان', phone: '0573333333', address: 'شارع التحلية' });
  assert.equal(r.status, 201, `شركة أخرى: ${JSON.stringify(r.body)}`);
  // c-del محذوف بالقيم نفسها
  r = await call('POST', '/api/customers', { name: 'سوبرماركت الواحة', phone: '0562222222', address: 'طريق الملك فهد' });
  assert.equal(r.status, 201, `المحذوف: ${JSON.stringify(r.body)}`);
  assert.equal(w.created.length, 2);
});

test('الكشف: اسم العميل الآخر ومعرّفه لمن يراه وحده — العزل مفعّلٌ وغير مُسنَد ⇒ رسالة عامة، ومُسنَدٌ أو بلا عزل ⇒ الاسم', async () => {
  world({ user: REP, flags: ALL, isolation: true });
  let r = await call('POST', '/api/customers', { name: 'مؤسسة احمد للتجارة' });
  assert.equal(r.status, 409);
  assert.deepEqual([r.body.message, r.body.existingId, r.body.existingName], ['يوجد عميل آخر بالاسم نفسه في الشركة', undefined, undefined]);
  r = await call('POST', '/api/customers', { name: 'جديد', phone: '966551234567' });
  assert.deepEqual([r.body.field, r.body.message, 'existingId' in r.body], ['phone', 'رقم الجوال مسجل لعميل آخر في الشركة', false]);
  // c1 مُسنَدٌ للمندوب نفسه ⇒ يُسمّى
  r = await call('POST', '/api/customers', { name: 'جديد', address: 'حي الملز، شارع 10' });
  assert.deepEqual([r.status, r.body.field, r.body.message, r.body.existingId, r.body.existingName], [409, 'address', 'العنوان مسجل للعميل «بقالة الحي»', 'c1', 'بقالة الحي']);
  // بلا عزل: المندوب يرى عملاء الشركة كلهم ⇒ يُسمّى
  world({ user: REP, flags: ALL, isolation: false });
  r = await call('POST', '/api/customers', { name: 'مؤسسة احمد للتجارة' });
  assert.deepEqual([r.body.message, r.body.existingId], ['اسم العميل مسجل للعميل «مؤسسة أحمد للتجارة»', 'c2']);
});

test('الإعفاء: الإدارة ومفتاح API وإعادة رفع صندوق المندوب (X-FS-Replay) تفتح المكرَّر — ولا استعلام تكرار', async () => {
  const dup = { name: 'مؤسسة أحمد للتجارة', phone: '0551234567', address: 'حي النسيم - شارع الأمير ماجد' };
  for (const [user, headers, label] of [[ADMIN, {}, 'الإدارة'], [API_KEY, {}, 'مفتاح API'], [REP, { 'X-FS-Replay': '1' }, 'صندوق المندوب']] as const) {
    const w = world({ user, flags: ALL });
    const r = await call('POST', '/api/customers', dup, headers);
    assert.equal(r.status, 201, `${label}: ${JSON.stringify(r.body)}`);
    assert.equal(w.dedupQueries().length, 0, `${label}: لا استعلام`);
  }
});

test('الاسم البديل والقيم التافهة: عميلٌ بلا اسم ولا جوال («عميل») وعنوان «-» لا يُمنع', async () => {
  const w = world({ user: REP, flags: ALL });
  w.rows.push({ id: 'c-blank', tenantId: TENANT, name: 'عميل', phone: '', address: '-', createdAt: 5 });
  const r = await call('POST', '/api/customers', { name: '', phone: '', address: '-' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(w.created[0].name, 'عميل');
  assert.equal(w.dedupQueries().length, 0, 'لا بحث بقيمة تافهة');
});

test('الاسم المفحوص المكتوبُ أو اسم المنشأة — لا بديل الجوال: عَلَم الاسم وحده لا يمنع عميلاً بلا اسم بجوالٍ مكرّر', async () => {
  // عميلٌ قديم بلا اسم حُفظ اسمه جوالَه (customerNameFallback)
  const w = world({ user: REP, flags: { dedupCustomerName: true } });
  w.rows.push({ id: 'c-phone-named', tenantId: TENANT, name: '0598765432', phone: '0598765432', address: null, createdAt: 5 });
  let r = await call('POST', '/api/customers', { phone: '0598765432' });
  assert.equal(r.status, 201, `الجوال غير مختار: ${JSON.stringify(r.body)}`);
  assert.equal(w.created[0].name, '0598765432', 'الاسم المحفوظ بديله كما كان');
  assert.equal(w.dedupQueries().length, 0, 'لا بحث بالاسم البديل من الجوال');
  // واسم المنشأة بديلاً للاسم الفارغ يُفحص (هو الاسم الظاهر)
  r = await call('POST', '/api/customers', { businessName: 'مؤسسة احمد للتجارة', phone: '0591112222' });
  assert.deepEqual([r.status, r.body.field], [409, 'name'], JSON.stringify(r.body));
  // والإنشاء بالمعرّف (PUT) كـPOST
  r = await call('PUT', '/api/customers/erp-phone-only', { phone: '0598765432' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  // ومع عَلَم الجوال يُمنع بالجوال نفسه
  world({ user: REP, flags: { dedupCustomerPhone: true, dedupCustomerName: true } }).rows.push({ id: 'c-phone-named', tenantId: TENANT, name: '0598765432', phone: '0598765432', address: null, createdAt: 5 });
  r = await call('POST', '/api/customers', { phone: '+966598765432' });
  assert.deepEqual([r.status, r.body.field], [409, 'phone'], JSON.stringify(r.body));
});

test('الإنشاء بالمعرّف عبر PUT (createMissingOnPut) فتحُ عميلٍ كـPOST: المكرّر 409 بلا كتابة', async () => {
  const w = world({ user: REP, flags: { dedupCustomerName: true } });
  const r = await call('PUT', '/api/customers/erp-new', { name: 'مؤسسة أحمد للتجارة' });
  assert.deepEqual([r.status, r.body.code, r.body.field], [409, CUSTOMER_DUPLICATE, 'name']);
  assert.equal(w.created.length, 0);
  const ok = await call('PUT', '/api/customers/erp-new', { name: 'اسم جديد' });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
});

// ═══ (٤) التعديل من المندوب ═══

test('التعديل: الحقل بلا تغيير (ولو بشكلٍ آخر) لا يُفحص — تكرارٌ قديم لا يمنع تعديل غيره', async () => {
  const w = world({ user: REP, flags: ALL });
  // c1 صار يحمل اسم c2 (تكرارٌ قديم سبق القيد) — تعديل عنوانه مع صدى الاسم والجوال لا يُمنع
  w.rows[0].name = 'مؤسسة أحمد للتجارة';
  let r = await call('PUT', '/api/customers/c1', { name: 'مؤسسة أحمد للتجارة', phone: '+966501111111', address: 'حي الملز، شارع ١١' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(w.dedupQueries().length, 1, 'العنوان المتغيّر وحده يُفحص');
  assert.match(w.dedupQueries()[0].sql, /coalesce\(address, ''\)/);
  assert.doesNotMatch(w.dedupQueries()[0].sql, /coalesce\((name|phone), ''\)/, 'الاسم والجوال بلا تغيير لا شرط لهما');
  assert.match(w.dedupQueries()[0].sql, /AND id <> \?/, 'العميل نفسه مستثنى');
  // تعديلٌ بلا الحقول المفحوصة لا يسأل أصلاً
  raws = [];
  r = await call('PUT', '/api/customers/c1', { city: 'الرياض' });
  assert.equal(r.status, 200);
  assert.equal(w.dedupQueries().length, 0);
});

test('التعديل: الحقل المتغيّر إلى قيمة عميلٍ آخر ⇒ 409 بلا كتابة، وإلى قيمته هو (العميل نفسه) يمرّ', async () => {
  const w = world({ user: REP, flags: ALL });
  let r = await call('PUT', '/api/customers/c1', { phone: '0551234567' });
  assert.deepEqual([r.status, r.body.field, r.body.message], [409, 'phone', 'رقم الجوال مسجل للعميل «مؤسسة أحمد للتجارة»']);
  r = await call('PUT', '/api/customers/c1', { name: 'مؤسسه احمد للتجاره' });
  assert.deepEqual([r.status, r.body.field], [409, 'name']);
  r = await call('PUT', '/api/customers/c1', { address: 'حي النسيم - شارع الأمير ماجد' });
  assert.deepEqual([r.status, r.body.field], [409, 'address']);
  assert.equal(w.updated.length, 0, 'لا كتابة');
  // اسمٌ جديد لا يحمله غيره يمرّ — والمحذوف بالاسم نفسه لا يُعدّ
  r = await call('PUT', '/api/customers/c1', { name: 'سوبرماركت الواحة' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(w.updated.length, 1);
});

test('التعديل: الإدارة لا يمسّها القيد، والمندوب بلا عَلَم كاليوم', async () => {
  for (const [user, flags] of [[ADMIN, ALL], [REP, {}]] as const) {
    const w = world({ user, flags });
    const r = await call('PUT', '/api/customers/c1', { name: 'مؤسسة أحمد للتجارة', phone: '0551234567' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(w.dedupQueries().length, 0);
  }
});

// ═══ (٥) قاعدة الموقع للشركة كلها كما هي ═══

test('«الموقع ضمن ٣٠ متراً» باقٍ للجميع كما هو: المندوب بلا عَلَم والإدارة ⇒ 409 CUSTOMER_LOCATION_EXISTS', async () => {
  for (const [user, flags] of [[REP, {}], [ADMIN, {}], [REP, ALL]] as const) {
    const w = world({ user, flags });
    const r = await call('POST', '/api/customers', { name: 'محل جديد كلياً', lat: 24.70005, lng: 46.70005 });
    assert.deepEqual([r.status, r.body.code], [409, 'CUSTOMER_LOCATION_EXISTS'], JSON.stringify(r.body));
    assert.equal(w.created.length, 0);
  }
  const s = read('routes', 'customers.ts');
  const loc = s.indexOf('const near = await findLocationDuplicate(tid, rest.lat, rest.lng);');
  const dd = s.indexOf('const dup = await findCustomerDuplicate(tid, { phone: rest.phone, name: dedupName, address: rest.address }, { checks: dedup });');
  assert.ok(loc > 0 && dd > loc && dd < s.indexOf('const customer = await prisma.customer.create({', dd), 'الموقع أوّلاً، ثم التكرار، ثم الإنشاء');
});

// ═══ (٦) الإعدادات ═══

test('إعدادات المندوب: الحقول الثلاثة تُكتب إنشاءً وتعديلاً، وتُقرأ في القائمة والتفاصيل و/auth/me', async () => {
  world({ user: ADMIN });
  const creates: any[] = []; const updates: any[] = []; const selects: any[] = [];
  scripted['salesRep.findFirst'] = (args) => {
    const w = args?.where ?? {};
    if (w.username || w.phone || w.email) return null;
    if (args?.select) selects.push(args.select);
    return { id: 'rep-1', tenantId: TENANT, username: 'khalid', phone: '0551234567', email: null, defaultPriceListId: null, allowedPriceTypes: null, idlePunchOutEnabled: false, boundDeviceId: null };
  };
  scripted['salesRep.create'] = (args) => { creates.push(args); return { id: 'rep-9', name: args.data.name }; };
  scripted['salesRep.update'] = (args) => { updates.push(args); return { id: 'rep-1' }; };
  scripted['salesRep.findMany'] = (args) => { selects.push(args.select); return []; };
  const NEW_REP = { name: 'خالد', phone: '0557654321', username: 'khalid.rep', password: 'Rep2026secure' };
  const c = await call('POST', '/api/sales-reps', { ...NEW_REP, dedupCustomerPhone: true, dedupCustomerAddress: true });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  assert.deepEqual([creates[0].data.dedupCustomerPhone, creates[0].data.dedupCustomerName, creates[0].data.dedupCustomerAddress], [true, undefined, true]);
  const u = await call('PUT', '/api/sales-reps/rep-1', { dedupCustomerName: true, dedupCustomerPhone: false });
  assert.equal(u.status, 200, JSON.stringify(u.body));
  assert.deepEqual([updates[0].data.dedupCustomerPhone, updates[0].data.dedupCustomerName, 'dedupCustomerAddress' in updates[0].data], [false, true, false]);
  const bad = await call('PUT', '/api/sales-reps/rep-1', { dedupCustomerName: 'yes' });
  assert.equal(bad.status, 400, 'قيمةٌ غير منطقية تُرفض');
  assert.equal((await call('GET', '/api/sales-reps')).status, 200);
  assert.equal((await call('GET', '/api/sales-reps/rep-1')).status, 200);
  assert.ok(selects.length >= 2);
  for (const s of selects.slice(-2)) assert.deepEqual([s.dedupCustomerPhone, s.dedupCustomerName, s.dedupCustomerAddress], [true, true, true]);

  world({ user: REP });
  let meSelect: any = null;
  scripted['salesRep.findUnique'] = (args) => {
    meSelect = args.select;
    return { id: 'rep-1', name: 'خالد', tenantId: TENANT, dedupCustomerPhone: true, dedupCustomerName: false, dedupCustomerAddress: true, tenant: { settings: { teamsEnabled: false } }, teamMemberships: [] };
  };
  const me = await call('GET', '/api/auth/me');
  assert.equal(me.status, 200, JSON.stringify(me.body));
  assert.deepEqual([meSelect.dedupCustomerPhone, meSelect.dedupCustomerName, meSelect.dedupCustomerAddress], [true, true, true]);
  assert.deepEqual([me.body.data.dedupCustomerPhone, me.body.data.dedupCustomerName, me.body.data.dedupCustomerAddress], [true, false, true]);
});

test('المخطّط إضافيّ بـfalse بلا قيد فريد جديد، والمزامنة تكشف الحقول، ومسارات العملاء تقرأ الأعلام من صفّ المندوب', () => {
  const schema = read('..', 'prisma', 'schema.prisma');
  const model = schema.slice(schema.indexOf('model SalesRep {'), schema.indexOf('\n}', schema.indexOf('model SalesRep {')));
  for (const k of ['dedupCustomerPhone', 'dedupCustomerName', 'dedupCustomerAddress']) {
    assert.match(model, new RegExp(`\\n  ${k}\\s+Boolean @default\\(false\\)\\n`), k);
  }
  const custModel = schema.slice(schema.indexOf('model Customer {'), schema.indexOf('\n}', schema.indexOf('model Customer {')));
  assert.deepEqual(custModel.match(/^\s*@@unique.*$/gm)?.map(l => l.trim()), ['@@unique([tenantId, code])'], 'لا قيد فريد جديد على العملاء');
  assert.equal(/^\s*@@unique/m.test(model), false, 'ولا على المناديب');
  const reps = SYNC_RESOURCES.find(r => r.model === 'salesRep');
  assert.ok(reps, 'مورد المناديب');
  const sel = reps!.select as Record<string, unknown>;
  for (const k of ['dedupCustomerPhone', 'dedupCustomerName', 'dedupCustomerAddress']) assert.equal(sel[k], true, `المزامنة: ${k}`);
  const s = read('routes', 'customers.ts');
  assert.equal((s.match(/\.\.\.DEDUP_REP_SELECT/g) ?? []).length, 2, 'الإنشاء والتعديل يقرآن الأعلام');
  assert.equal((s.match(/customerDupBody\(dup, await canAccessCustomer\(req, tid, dup\.id\)\)/g) ?? []).length, 3, 'الإنشاء والإنشاء بالمعرّف والتعديل');
});

// «المحاسب الذكي AI» — مستندات المحادثة: التخزين والمسارات (الحزمة P1، طلب المالك ١٨ نوفمبر ٢٠٢٦).
// النوع من البايتات والسقوف ومفاتيح البيئة، الرفع تحت قفل الحصة (جمع المهمَل ثم عدم التكرار ثم الحصة)، مسار QR (محرّك مزيّف
// ومحرّك facts.ts الحقيقي برمز زكوي حقيقي)، التصحيح والحذف وقواعدهما (409 لمستند في قيد حيّ)، جمع المهمَل لا يمسّ المرتبط
// بقيد، عزل الشركة والرافع، إعادة توجيه المرفق داخل معاملة الترحيل، ثم المسارات بحرّاسها الحقيقيين فوق Prisma مزيّف.
// بلا قاعدة ولا شبكة ولا نموذج.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { Router } from 'express';
import { Prisma } from '@prisma/client';

const SRC = path.join(__dirname, '..');
type Row = Record<string, any>;

// ═══ Prisma مزيّف (قبل تحميل أي وحدة تستورد القاعدة) ═══

const T = 'T1';
const T2 = 'T2';
let clock = new Date('2026-11-18T10:00:00Z').getTime();
const now = () => new Date(clock);
let seq = 0;
const uuid = () => crypto.randomUUID();

const isDbNull = (v: unknown) => v === Prisma.DbNull || v === Prisma.JsonNull;
const norm = (data: Row): Row => Object.fromEntries(Object.entries(data).map(([k, v]) => [k, isDbNull(v) ? null : v]));

function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  for (const [k, cond] of Object.entries(where)) {
    if (k === 'OR') { if (!(cond as Row[]).some((w) => matches(row, w))) return false; continue; }
    if (k === 'NOT') { if (matches(row, cond as Row)) return false; continue; }
    const v = row[k];
    if (cond === null) { if (v !== null && v !== undefined) return false; continue; }
    if (cond instanceof Date) { if (!(v instanceof Date) || v.getTime() !== cond.getTime()) return false; continue; }
    if (typeof cond === 'object') {
      const c = cond as Row;
      if ('in' in c && !(c.in as unknown[]).includes(v)) return false;
      if ('not' in c && (c.not === null ? (v !== null && v !== undefined) === false : v === c.not)) return false;
      if ('lt' in c && !(v < c.lt)) return false;
      if ('gte' in c && !(v >= c.gte)) return false;
      if ('startsWith' in c && !(typeof v === 'string' && v.startsWith(c.startsWith))) return false;
      if ('path' in c) {
        const x = (c.path as string[]).reduce((o: any, p) => (o == null ? undefined : o[p]), v);
        if (x !== c.equals) return false;
      }
      continue;
    }
    if (v !== cond) return false;
  }
  return true;
}

let st: {
  docs: Row[]; atts: Row[]; moves: Row[]; posts: Row[]; audits: Row[];
  tenant: Row | null; admin: Row | null; company: Row | null; gl: Row | null; accounts: Row[];
};
let log: string[] = [];
let locks: string[] = [];
let aggWhere: Row[] = [];

function reset(): void {
  clock = new Date('2026-11-18T10:00:00Z').getTime();
  log = [];
  locks = [];
  aggWhere = [];
  st = {
    docs: [], atts: [], moves: [], posts: [], audits: [],
    tenant: { name: 'شركة الأمل', aiAccountantEnabled: true, accountingEnabled: true, accountingSuiteEnabled: true, warehouseEnabled: true },
    admin: {
      id: 'A1', name: 'سارة', isActive: true, tenantId: T, role: 'ADMIN', canManageCompanyUsers: true, scopeEnabled: false, scopeMode: 'LISTS',
      canViewReports: true, canDelete: true, lastSeenAt: new Date(),
      canViewLedger: false, canPostJournals: false, canManagePayables: false, canManageBank: false, canCloseLedgerPeriods: false, canConfigureLedger: false,
    },
    company: { name: 'شركة الأمل للتوزيع', currency: 'SAR', countryCode: 'SA', taxDisabled: false, taxNumber: '300000000000003' },
    gl: {
      setupMethod: 'CLEAN', activatedAt: new Date('2026-10-01T00:00:00Z'), timezone: 'Asia/Riyadh', currency: 'SAR',
      templateKey: 'SA_6D', currencyDecimals: 2,
    },
    accounts: [
      { code: '111001', name: 'الصندوق الرئيسي', type: 'asset_cash', isActive: true, controlKind: null },
      { code: '111101', name: 'البنك الرئيسي', type: 'asset_cash', isActive: true, controlKind: null },
      { code: '213002', name: 'مصروفات مستحقة', type: 'liability_current', isActive: true, controlKind: null },
      { code: '621010', name: 'الصيانة والإصلاحات', type: 'expense', isActive: true, controlKind: null },
      { code: '621016', name: 'مصروفات متنوعة', type: 'expense', isActive: true, controlKind: null },
    ],
  };
}
reset();

const sortBy = (rows: Row[], orderBy?: Row) => {
  if (!orderBy) return rows;
  const [k, dir] = Object.entries(orderBy)[0] as [string, string];
  return [...rows].sort((a, b) => (a[k] < b[k] ? -1 : a[k] > b[k] ? 1 : 0) * (dir === 'desc' ? -1 : 1));
};
const pick = (rows: Row[], a: Row) => {
  let out = sortBy(rows.filter((r) => matches(r, a.where)), a.orderBy);
  if (a.distinct) {
    const seen = new Set<string>();
    out = out.filter((r) => { const key = (a.distinct as string[]).map((d) => r[d]).join('|'); if (seen.has(key)) return false; seen.add(key); return true; });
  }
  return typeof a.take === 'number' ? out.slice(0, a.take) : out;
};
const copy = (r: Row | undefined) => (r ? { ...r } : null);

const db: Row = {
  async $executeRaw(strings: TemplateStringsArray, ...values: unknown[]) {
    const sql = strings.join('?');
    if (/pg_advisory_xact_lock/.test(sql)) { locks.push(String(values[0])); log.push(`lock:${values[0]}`); }
    return 1;
  },
  async $transaction(fn: (tx: Row) => Promise<unknown>) {
    log.push('tx');
    // كـPostgres: الرمي يُسقط ما كُتب داخل المعاملة
    const snap = { docs: st.docs.map((r) => ({ ...r })), atts: st.atts.map((r) => ({ ...r })) };
    try { return await fn(db); } catch (e) { st.docs = snap.docs; st.atts = snap.atts; log.push('tx:rollback'); throw e; }
  },
  tenant: { async findUnique() { return st.tenant; } },
  admin: { async findUnique() { return st.admin; }, async updateMany() { return { count: 0 }; } },
  companySettings: { async findUnique() { return st.company; } },
  glSettings: { async findUnique() { return st.gl; } },
  glAccount: { async findMany(a: Row) { log.push('glAccount.findMany'); return st.accounts.filter((r) => matches(r, a.where.OR ? { OR: a.where.OR } : undefined)).map((r) => ({ ...r })); } },
  glMove: { async findMany(a: Row) { return pick(st.moves, a).map((r) => ({ ...r })); } },
  aiAccountantPost: { async findMany(a: Row) { return pick(st.posts, a).map((r) => ({ ...r })); } },
  glAuditLog: { async findFirst() { return null; }, async create(a: Row) { st.audits.push(a.data); return a.data; } },
  aiAccountantDocument: {
    async findFirst(a: Row) { return copy(pick(st.docs, a)[0]); },
    async findMany(a: Row) { return pick(st.docs, a).map((r) => ({ ...r })); },
    async create(a: Row) {
      log.push('doc.create');
      const row = { id: uuid(), moveId: null, postId: null, qrRaw: null, factsSource: null, facts: null, suggestion: null, ...norm(a.data), createdAt: now(), updatedAt: now() };
      st.docs.push(row);
      return { ...row };
    },
    async updateMany(a: Row) {
      const hit = st.docs.filter((r) => matches(r, a.where));
      for (const r of hit) Object.assign(r, norm(a.data), { updatedAt: new Date(clock + (++seq)) });
      return { count: hit.length };
    },
    async deleteMany(a: Row) {
      const before = st.docs.length;
      st.docs = st.docs.filter((r) => !matches(r, a.where));
      log.push(`doc.deleteMany:${before - st.docs.length}`);
      return { count: before - st.docs.length };
    },
  },
  glAttachment: {
    async findFirst(a: Row) { return copy(pick(st.atts, a)[0]); },
    async findMany(a: Row) { return pick(st.atts, a).map((r) => ({ ...r })); },
    async create(a: Row) {
      log.push('att.create');
      const { blob, ...rest } = a.data;
      const row = { id: uuid(), ...rest, createdAt: now(), blob: { bytes: blob.create.bytes } };
      st.atts.push(row);
      return { ...row };
    },
    async updateMany(a: Row) {
      const hit = st.atts.filter((r) => matches(r, a.where));
      for (const r of hit) Object.assign(r, a.data);
      return { count: hit.length };
    },
    async deleteMany(a: Row) {
      const before = st.atts.length;
      st.atts = st.atts.filter((r) => !matches(r, a.where));
      log.push(`att.deleteMany:${before - st.atts.length}`);
      return { count: before - st.atts.length };
    },
    async aggregate(a: Row) {
      log.push('att.aggregate');
      aggWhere.push(a.where);
      const sum = st.atts.filter((r) => matches(r, a.where)).reduce((s, r) => s + r.sizeBytes, 0);
      return { _sum: { sizeBytes: sum || null } };
    },
  },
};

const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};
stub('config/database', { default: db });

process.env.JWT_SECRET = 'test-secret-ai-accountant-docs';
for (const k of ['AI_ACCOUNTANT_DOCS', 'AI_ACCOUNTANT_WRITE', 'AI_ACCOUNTANT_DOC_PDF_MB', 'AI_ACCOUNTANT_DOC_RETENTION_DAYS', 'AI_ACCOUNTANT_ASSET_THRESHOLD', 'AI_ACCOUNTANT_LLM', 'AI_REP_LLM_BASE_URL', 'AI_REP_LLM_API_KEY', 'AI_REP_LLM_MODEL']) delete process.env[k];
// نموذجٌ مُعدّ (قراءة الإعداد وحدها — لا نداء شبكة هنا): المستندات تتبع المحادثة
process.env.GROQ_API_KEY = 'gsk_test_docs';
/** بيئة المحادثة المُعدّة للدوال الصرفة */
const LLM_ENV = { GROQ_API_KEY: 'gsk_test_docs' } as NodeJS.ProcessEnv;

/* eslint-disable @typescript-eslint/no-var-requires */
const caps = require('../services/aiAccountant/documents/caps') as typeof import('../services/aiAccountant/documents/caps');
const store = require('../services/aiAccountant/documents/store') as typeof import('../services/aiAccountant/documents/store');
const gc = require('../services/aiAccountant/documents/gc') as typeof import('../services/aiAccountant/documents/gc');
const view = require('../services/aiAccountant/documents/view') as typeof import('../services/aiAccountant/documents/view');
const types = require('../services/aiAccountant/documents/types') as typeof import('../services/aiAccountant/documents/types');
const factsMod = require('../services/aiAccountant/documents/facts') as typeof import('../services/aiAccountant/documents/facts');
const posting = require('../services/aiAccountant/posting') as typeof import('../services/aiAccountant/posting');
const zqr = require('../compliance/zatca/qr') as typeof import('../compliance/zatca/qr');
const routeMod = require('../routes/aiAccountant') as typeof import('../routes/aiAccountant');
/* eslint-enable @typescript-eslint/no-var-requires */
const router = routeMod.default as unknown as Router;

import type { AcctDocEnv, AcctDocFacts } from '../services/aiAccountant/documents/types';
import type { DocFactsEngine, DocRow, DocsDb } from '../services/aiAccountant/documents/store';

const DB = db as unknown as DocsDb;
const KB = 1024;
const MB = 1024 * KB;

// ═══ بايتات ═══

let fill = 1;
const png = (size = 200) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(Math.max(0, size - 8), fill++ % 250)]);
const jpeg = (size = 200) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(Math.max(0, size - 4), fill++ % 250)]);
const pdf = (size = 200) => Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(Math.max(0, size - 9), 0x20 + (fill++ % 90))]);

const ENV: AcctDocEnv = {
  tenantId: T, currency: 'SAR', currencyDecimals: 2, taxDisabled: false, companyVat: '300000000000003', todayLocal: '2026-11-18',
  tz: 'Asia/Riyadh', vatBox: true, assetThresholdMilli: 2_000_000n,
  accounts: [
    { code: '111001', name: 'الصندوق الرئيسي', type: 'asset_cash', isActive: true, controlKind: null },
    { code: '111101', name: 'البنك الرئيسي', type: 'asset_cash', isActive: true, controlKind: null },
    { code: '213002', name: 'مصروفات مستحقة', type: 'liability_current', isActive: true, controlKind: null },
    { code: '621010', name: 'الصيانة والإصلاحات', type: 'expense', isActive: true, controlKind: null },
    { code: '621016', name: 'مصروفات متنوعة', type: 'expense', isActive: true, controlKind: null },
  ],
};

const GOOD_QR = 'R09PRC1RUg==';

/** محرّك حقائق مزيّف (facts.ts تختبره حزمته): يسجّل نداءاته */
function fakeEngine(calls: unknown[][] = []): DocFactsEngine {
  return {
    fromQr(qr) {
      calls.push(['fromQr', qr]);
      if (qr !== GOOD_QR) return { facts: types.emptyFacts(), qrVerified: false };
      return { facts: { ...types.emptyFacts(), docType: 'TAX_INVOICE', vendorName: 'مؤسسة الإتقان', vendorVat: '310123456700003', issueDate: '2026-11-10', currency: 'SAR', subtotal: '1000.00', vatAmount: '150.00', total: '1150.00' }, qrVerified: true };
    },
    applyPatch(facts, patch) {
      calls.push(['applyPatch', patch]);
      if ((patch as Row).total === 'bad') throw new factsMod.AcctDocPatchError('total', 'POSITIVE_DECIMAL');
      return { ...(facts ?? types.emptyFacts()), ...(patch as Partial<AcctDocFacts>) };
    },
    recheck(facts, _env, state) {
      calls.push(['recheck', state]);
      if (!facts) return { checks: [{ code: 'TOTAL_MISSING', severity: 'block' }, { code: 'DATE_MISSING', severity: 'block' }], status: 'NEEDS_REVIEW', suggestion: null };
      const checks = facts.total ? [] : [{ code: 'TOTAL_MISSING' as const, severity: 'block' as const }];
      return {
        checks, status: checks.length ? 'NEEDS_REVIEW' : 'EXTRACTED',
        suggestion: facts.total ? { treatment: 'EXPENSE', accountCode: '621010', accountName: 'الصيانة والإصلاحات', vatMode: 'DEDUCTIBLE', months: null, paidFrom: null } : null,
      };
    },
    options() { return { accountOptions: [{ code: '621010', name: 'الصيانة والإصلاحات', treatment: 'EXPENSE' }], payOptions: [{ paidFrom: 'cash', code: '111001', name: 'الصندوق الرئيسي' }] }; },
  };
}

const up = (over: Partial<import('../services/aiAccountant/documents/store').UploadInput> = {}, engine: DocFactsEngine = fakeEngine(), capsArg = caps.docCaps()) =>
  store.uploadDocument(DB, { tenantId: T, actorRef: 'A1', bytes: png(), contentType: 'image/png', fileNameHeader: encodeURIComponent('فاتورة صيانة.png'), qrHeader: undefined, now: now(), ...over }, ENV, engine, capsArg);

const okDoc = async (p: ReturnType<typeof up>) => {
  const r = await p;
  assert.equal(r.ok, true, JSON.stringify(r));
  return (r as { ok: true; doc: Row; deduped: boolean });
};

/** صفّ مستند جاهز في المخزن المزيّف (مع مرفقه) */
function seedDoc(over: Row = {}, att: Row = {}): DocRow & Row {
  const id = over.id ?? uuid();
  const attId = over.attachmentId ?? uuid();
  const createdAt = over.createdAt ?? now();
  st.atts.push({ id: attId, tenantId: over.tenantId ?? T, entityType: 'AI_DOC', entityId: id, fileName: 'x.png', mimeType: 'image/png', sizeBytes: over.sizeBytes ?? 100, sha256: over.sha256 ?? crypto.randomBytes(8).toString('hex'), uploadedBy: over.actorRef ?? 'A1', createdAt, blob: { bytes: png(100) }, ...att });
  const row = {
    id, tenantId: T, actorRef: 'A1', attachmentId: attId, sha256: crypto.randomBytes(8).toString('hex'), fileName: 'x.png', mimeType: 'image/png', sizeBytes: 100,
    status: 'NEEDS_REVIEW', manualEntry: true, factsSource: null, facts: null, qrRaw: null, qrVerified: false, checks: [], suggestion: null,
    moveId: null, postId: null, createdAt, updatedAt: createdAt, ...over,
  };
  st.docs.push(row);
  return row as DocRow & Row;
}

// ═══ السقوف ومفاتيح البيئة ═══

test('مفتاح AI_ACCOUNTANT_DOCS: مفعّل افتراضياً، و0 وoff وحدهما يطفئان', () => {
  for (const v of [undefined, '', '1', 'on', 'yes', 'true']) assert.equal(caps.docsEnvEnabled({ AI_ACCOUNTANT_DOCS: v } as NodeJS.ProcessEnv), true, String(v));
  for (const v of ['0', 'off', ' OFF ', 'Off']) assert.equal(caps.docsEnvEnabled({ AI_ACCOUNTANT_DOCS: v } as NodeJS.ProcessEnv), false, v);
});

test('الإتاحة = المفتاح + AI_ACCOUNTANT_WRITE + المحادثة تعمل + الترحيل متاح؛ وكتلة /status بسقوفها', () => {
  assert.equal(caps.docsEnabledFor({ canPost: true }, LLM_ENV), true);
  assert.equal(caps.docsEnabledFor({ canPost: false }, LLM_ENV), false);
  assert.equal(caps.docsEnabledFor({ canPost: true }, { ...LLM_ENV, AI_ACCOUNTANT_WRITE: '0' } as NodeJS.ProcessEnv), false);
  assert.equal(caps.docsEnabledFor({ canPost: true }, { ...LLM_ENV, AI_ACCOUNTANT_DOCS: 'off' } as NodeJS.ProcessEnv), false);
  // «سجّل القيد» دورة محادثة: مفتاحها مطفأ أو نموذجٌ غير مُعدّ ⇒ لا رفع ولا زرّ (لا مستندٌ يستهلك الحصة ثم لا يُرحَّل)
  assert.equal(caps.docsEnabledFor({ canPost: true }, { ...LLM_ENV, AI_ACCOUNTANT_LLM: '0' } as NodeJS.ProcessEnv), false);
  assert.equal(caps.docsEnabledFor({ canPost: true }, {}), false, 'بلا نموذج مُعدّ');
  assert.equal(caps.docsEnabledFor({ canPost: true }, {}, true), true, 'من اجتاز حرّاس المحادثة يمرّر chatReady');
  assert.deepEqual([caps.docsChatReady(LLM_ENV), caps.docsChatReady({}), caps.docsChatReady({ ...LLM_ENV, AI_ACCOUNTANT_LLM: ' 0 ' } as NodeJS.ProcessEnv)], [true, false, false]);
  assert.deepEqual([caps.docsPlatformEnabled(LLM_ENV), caps.docsPlatformEnabled({ ...LLM_ENV, AI_ACCOUNTANT_DOCS: '0' } as NodeJS.ProcessEnv), caps.docsPlatformEnabled({})], [true, false, false]);
  assert.deepEqual(caps.docsStatusOf({ canPost: true }, LLM_ENV), {
    enabled: true, canUpload: true, caps: { imageBytes: 400 * KB, pdfBytes: 3 * MB, perMessage: 3 }, assetThreshold: 2000, retentionDays: 30,
  });
  assert.deepEqual([caps.docsStatusOf({ canPost: true }, {}).enabled, caps.docsStatusOf({ canPost: true }, {}).canUpload], [false, false]);
  const e = { ...LLM_ENV, AI_ACCOUNTANT_DOC_PDF_MB: '1.5', AI_ACCOUNTANT_ASSET_THRESHOLD: '5000', AI_ACCOUNTANT_DOC_RETENTION_DAYS: '7' } as NodeJS.ProcessEnv;
  const s = caps.docsStatusOf({ canPost: false }, e);
  assert.deepEqual([s.enabled, s.caps.pdfBytes, s.assetThreshold, s.retentionDays], [false, Math.floor(1.5 * MB), 5000, 7]);
});

test('السقوف من البيئة: PDF افتراض ٣ ميغابايت وبحدّ ١٠، والفاسد يعود للافتراض؛ الأيام ١..٣٦٥؛ حدّ الرسملة بالملّي', () => {
  assert.equal(caps.docPdfCapBytes({}), 3 * MB);
  assert.equal(caps.docPdfCapBytes({ AI_ACCOUNTANT_DOC_PDF_MB: '50' } as NodeJS.ProcessEnv), 10 * MB);
  for (const v of ['0', '-1', 'abc', '']) assert.equal(caps.docPdfCapBytes({ AI_ACCOUNTANT_DOC_PDF_MB: v } as NodeJS.ProcessEnv), 3 * MB, v);
  assert.equal(caps.docRetentionDays({ AI_ACCOUNTANT_DOC_RETENTION_DAYS: '0' } as NodeJS.ProcessEnv), 30);
  assert.equal(caps.docRetentionDays({ AI_ACCOUNTANT_DOC_RETENTION_DAYS: '400' } as NodeJS.ProcessEnv), 30);
  assert.equal(caps.docRetentionDays({ AI_ACCOUNTANT_DOC_RETENTION_DAYS: '2.5' } as NodeJS.ProcessEnv), 30);
  assert.equal(caps.assetThresholdMilli({}), 2_000_000n);
  assert.equal(caps.assetThresholdMilli({ AI_ACCOUNTANT_ASSET_THRESHOLD: '2500.5' } as NodeJS.ProcessEnv), 2_500_500n);
  assert.equal(caps.assetThreshold({ AI_ACCOUNTANT_ASSET_THRESHOLD: '-3' } as NodeJS.ProcessEnv), 2000);
  assert.equal(caps.rawBodyLimitBytes({}), 3 * MB + 64 * KB);
  // الحصة مشتركة مع مرفقات الدفاتر (الأرقام نفسها)
  const c = caps.docCaps({});
  assert.deepEqual([c.monthlyBytes, c.totalBytes, c.imageBytes], [50 * MB, 500 * MB, 400 * KB]);
});

test('فحص الملف: النوع من البايتات ويطابق المعلَن، والسقف بنوعه، ثم الشهر ثم الإجمالي', () => {
  assert.equal(caps.sniffDocMime(png(), 'image/png').mime, 'image/png');
  assert.equal(caps.sniffDocMime(jpeg(), 'image/jpeg; charset=x').mime, 'image/jpeg');
  assert.equal(caps.sniffDocMime(pdf(), 'Application/PDF').mime, 'application/pdf');
  assert.equal(caps.sniffDocMime(pdf(), 'image/png').mime, null, 'المعلَن يخالف البايتات');
  assert.equal(caps.sniffDocMime(Buffer.from('GIF89a........'), 'image/gif').mime, null);
  assert.equal(caps.sniffDocMime(Buffer.from('<html><script>'), 'application/pdf').mime, null, 'HTML متنكّر');
  const cc = caps.docCaps({});
  assert.equal(caps.docFileCapViolation('image/png', 400 * KB, cc), null);
  assert.equal(caps.docFileCapViolation('image/png', 400 * KB + 1, cc)?.reason, 'FILE_TOO_LARGE');
  assert.equal(caps.docFileCapViolation('application/pdf', 3 * MB, cc), null);
  assert.equal(caps.docFileCapViolation('application/pdf', 3 * MB + 1, cc)?.reason, 'FILE_TOO_LARGE');
  assert.equal(caps.docFileCapViolation('image/jpeg', 0, cc)?.reason, 'EMPTY_FILE');
  assert.equal(caps.docCapViolation({ mimeType: 'image/png', sizeBytes: 100, monthUsedBytes: 50 * MB - 100, totalUsedBytes: 0 }, cc), null, 'حتى السقف بالضبط');
  assert.equal(caps.docCapViolation({ mimeType: 'image/png', sizeBytes: 101, monthUsedBytes: 50 * MB - 100, totalUsedBytes: 0 }, cc)?.reason, 'MONTHLY_QUOTA');
  assert.equal(caps.docCapViolation({ mimeType: 'image/png', sizeBytes: 101, monthUsedBytes: 0, totalUsedBytes: 500 * MB - 100 }, cc)?.reason, 'TOTAL_QUOTA');
});

test('اسم الملف وترويسة QR: فكّ URI وتنظيف المسار ومحارف الاتجاه، والـQR base64 بحدّ ١٠٠٠', () => {
  assert.equal(caps.docFileNameOf(encodeURIComponent('C:\\fake\\فاتورة ٢٢٣١.pdf'), 'application/pdf'), 'فاتورة ٢٢٣١.pdf');
  assert.equal(caps.docFileNameOf('%E0%A4%A', 'image/png'), '%E0%A4%A', 'ترميز معطوب يبقى كما هو');
  assert.equal(caps.docFileNameOf(encodeURIComponent('invoice\u202Egnp.exe'), 'image/png'), 'invoicegnp.exe', 'لا انعكاس اتجاه');
  assert.equal(caps.docFileNameOf(undefined, 'application/pdf'), 'attachment.pdf');
  assert.equal(caps.docFileNameOf('<script>.png', 'image/png'), 'script.png');
  assert.equal(caps.qrHeaderOf(undefined), null);
  assert.equal(caps.qrHeaderOf('   '), null);
  assert.equal(caps.qrHeaderOf(' AQID\r\nBA== '), 'AQIDBA==');
  assert.equal(caps.qrHeaderOf('AQ%2BD'), 'AQ+D');
  // السقف سقف الفكّ نفسه (٢٠٤٨) ومرآته في الويب — ما يقرؤه الجهاز لا يُرفض قبل الفكّ
  assert.equal(caps.MAX_QR_HEADER_LENGTH, 2048);
  assert.equal(caps.qrHeaderOf('A'.repeat(2048)), 'A'.repeat(2048));
  assert.equal(caps.qrHeaderOf('A'.repeat(2049)), 'INVALID');
  assert.equal(caps.qrHeaderOf('not base64!'), 'INVALID');
  assert.equal(caps.qrHeaderOf(['AQID', 'x']), 'AQID');
});

// ═══ الرفع ═══

test('رفع صورة بلا QR: إدخال يدوي NEEDS_REVIEW، والمرفق AI_DOC بمعرّف المستند، والقفل قبل الحصة والكتابة', async () => {
  reset();
  const calls: unknown[][] = [];
  const r = await okDoc(up({}, fakeEngine(calls)));
  assert.equal(r.deduped, false);
  const d = r.doc;
  assert.deepEqual([d.status, d.manualEntry, d.factsSource, d.facts, d.qrRaw, d.qrVerified], ['NEEDS_REVIEW', true, null, null, null, false]);
  assert.deepEqual(d.checks.map((c: Row) => c.code), ['TOTAL_MISSING', 'DATE_MISSING']);
  assert.equal(d.fileName, 'فاتورة صيانة.png');
  assert.equal(d.mimeType, 'image/png');
  assert.equal(d.actorRef, 'A1');
  assert.equal(d.sha256, crypto.createHash('sha256').update(st.atts[0].blob.bytes).digest('hex'));
  assert.equal(st.atts.length, 1);
  assert.deepEqual([st.atts[0].entityType, st.atts[0].entityId, st.atts[0].tenantId, st.atts[0].uploadedBy], ['AI_DOC', d.id, T, 'A1']);
  assert.equal(d.attachmentId, st.atts[0].id);
  assert.ok(!calls.some((c) => c[0] === 'fromQr'), 'بلا ترويسة لا قراءة QR');
  assert.deepEqual(locks, [`gl-attach:${T}`]);
  const i = (s: string) => log.indexOf(s);
  assert.ok(i(`lock:gl-attach:${T}`) < i('att.aggregate') && i('att.aggregate') < i('att.create') && i('att.create') < i('doc.create'), log.join(' '));
  // الشهر بتوقيت الشركة (الرياض): 1 نوفمبر 00:00 = 31 أكتوبر 21:00Z — حساب moves.ts نفسه
  assert.equal((aggWhere[0].createdAt.gte as Date).toISOString(), '2026-10-31T21:00:00.000Z');
  assert.deepEqual(Object.keys(aggWhere[1]), ['tenantId']);
});

test('رفع بـQR (محرّك مزيّف): الحقائق من QR وmanualEntry=false وqrRaw مخزّن؛ وQR لا يُقرأ ⇒ إدخال يدوي بتنبيه QR_INVALID', async () => {
  reset();
  const calls: unknown[][] = [];
  const good = (await okDoc(up({ qrHeader: GOOD_QR }, fakeEngine(calls)))).doc;
  assert.deepEqual([good.factsSource, good.manualEntry, good.qrVerified, good.qrRaw, good.status], ['QR', false, true, GOOD_QR, 'EXTRACTED']);
  assert.equal(good.facts.total, '1150.00');
  assert.equal(good.suggestion.accountCode, '621010');
  assert.deepEqual(calls[0], ['fromQr', GOOD_QR]);

  const bad = (await okDoc(up({ qrHeader: 'AAAA' }))).doc;
  assert.deepEqual([bad.factsSource, bad.manualEntry, bad.qrVerified, bad.facts, bad.status], [null, true, false, null, 'NEEDS_REVIEW']);
  assert.equal(bad.qrRaw, 'AAAA', 'النص المخزَّن يعيد الفحص تنبيهه');
  assert.ok(bad.checks.some((c: Row) => c.code === 'QR_INVALID' && c.severity === 'warn'));

  const junk = (await okDoc(up({ qrHeader: 'x'.repeat(5000) }))).doc;
  assert.deepEqual([junk.qrRaw, junk.manualEntry], [null, true]);
  assert.ok(junk.checks.some((c: Row) => c.code === 'QR_INVALID'), 'ترويسة غير صالحة لا تُرفض بها الصورة');
});

test('PDF: لا قراءة QR في الإصدار الأول — الترويسة تُهمل والبطاقة للإدخال', async () => {
  reset();
  const calls: unknown[][] = [];
  const d = (await okDoc(up({ bytes: pdf(2 * MB), contentType: 'application/pdf', qrHeader: GOOD_QR }, fakeEngine(calls)))).doc;
  assert.deepEqual([d.mimeType, d.manualEntry, d.qrRaw, d.factsSource], ['application/pdf', true, null, null]);
  assert.ok(!calls.some((c) => c[0] === 'fromQr'));
  assert.ok(!d.checks.some((c: Row) => c.code === 'QR_INVALID'));
});

test('رمز QR زكوي حقيقي عبر facts.ts: البائع ورقمه والتاريخ الميلادي والمبالغ، ثم تصحيحٌ يناقضه ⇒ QR_MISMATCH وQR+USER', async () => {
  reset();
  const enc = (s: string) => new TextEncoder().encode(s);
  const qr = Buffer.from(zqr.tlv([[1, enc('مؤسسة الإتقان للصيانة')], [2, enc('310123456700003')], [3, enc('2026-11-10T10:30:00Z')], [4, enc('1150.00')], [5, enc('150.00')]])).toString('base64');
  const d = (await okDoc(up({ qrHeader: qr }, store.defaultDocEngine))).doc;
  assert.deepEqual([d.factsSource, d.manualEntry, d.qrVerified], ['QR', false, true]);
  assert.equal(d.facts.vendorName, 'مؤسسة الإتقان للصيانة');
  assert.equal(d.facts.vendorVat, '310123456700003');
  assert.equal(d.facts.issueDate, '2026-11-10');
  assert.deepEqual([d.facts.total, d.facts.vatAmount, d.facts.subtotal], ['1150.00', '150.00', '1000.00']);
  assert.ok(!d.checks.some((c: Row) => c.severity === 'block'), JSON.stringify(d.checks));
  assert.ok(d.suggestion && typeof d.suggestion.accountCode === 'string');

  const p = await store.patchDocument(DB, { tenantId: T, actorRef: 'A1', id: d.id, patch: { total: '1200.00' } }, ENV);
  assert.equal(p.ok, true, JSON.stringify(p));
  const after = (p as { doc: Row }).doc;
  assert.equal(after.factsSource, 'QR+USER');
  assert.ok(after.checks.some((c: Row) => c.code === 'QR_MISMATCH' && c.severity === 'block'), JSON.stringify(after.checks));
  assert.equal(after.status, 'NEEDS_REVIEW');
});

test('الرفض قبل المعاملة: نوعٌ يخالف البايتات 415، والفارغ 400، وفوق السقف 413 — بلا قفل ولا كتابة', async () => {
  reset();
  const bad = await up({ bytes: pdf(), contentType: 'image/png' });
  assert.deepEqual(bad.ok ? null : [bad.status, bad.code], [415, 'ATTACHMENT_TYPE_NOT_ALLOWED']);
  const gif = await up({ bytes: Buffer.from('GIF89a......'), contentType: 'image/gif' });
  assert.deepEqual(gif.ok ? null : [gif.status, gif.code], [415, 'ATTACHMENT_TYPE_NOT_ALLOWED']);
  const empty = await up({ bytes: Buffer.alloc(0) });
  assert.deepEqual(empty.ok ? null : [empty.status, empty.code], [400, 'EMPTY_FILE']);
  const big = await up({ bytes: jpeg(400 * KB + 1), contentType: 'image/jpeg' });
  assert.deepEqual(big.ok ? null : [big.status, big.code], [413, 'FILE_TOO_LARGE']);
  const bigPdf = await up({ bytes: pdf(2 * MB), contentType: 'application/pdf' }, fakeEngine(), caps.docCaps({ AI_ACCOUNTANT_DOC_PDF_MB: '1' } as NodeJS.ProcessEnv));
  assert.deepEqual(bigPdf.ok ? null : [bigPdf.status, bigPdf.code], [413, 'FILE_TOO_LARGE']);
  assert.deepEqual([locks.length, st.atts.length, st.docs.length], [0, 0, 0]);
});

test('الحصة المشتركة مع مرفقات الدفاتر تحت القفل: الشهر بتوقيت الشركة ثم الإجمالي ⇒ 429 بلا كتابة', async () => {
  reset();
  // مرفق قيد يدوي هذا الشهر: ٥٠ ميغابايت إلا ١٠٠ بايت
  st.atts.push({ id: 'M-ATT', tenantId: T, entityType: 'MOVE', entityId: 'MV1', sizeBytes: 50 * MB - 100, createdAt: new Date('2026-11-02T00:00:00Z') });
  // وشركة أخرى ممتلئة لا تُحسب
  st.atts.push({ id: 'X-ATT', tenantId: T2, entityType: 'MOVE', entityId: 'MV9', sizeBytes: 499 * MB, createdAt: new Date('2026-11-02T00:00:00Z') });
  const r = await up({ bytes: png(200) });
  assert.deepEqual(r.ok ? null : [r.status, r.code], [429, 'MONTHLY_QUOTA']);
  assert.equal(st.docs.length, 0);
  // الشهر الماضي لا يُعدّ في الشهري ويُعدّ في الإجمالي
  st.atts[0].createdAt = new Date('2026-10-31T20:59:59Z');
  const ok = await up({ bytes: png(200) });
  assert.equal(ok.ok, true);
  st.atts.push({ id: 'OLD', tenantId: T, entityType: 'MOVE', entityId: 'MV2', sizeBytes: 450 * MB, createdAt: new Date('2026-01-01T00:00:00Z') });
  const tot = await up({ bytes: png(200) });
  assert.deepEqual(tot.ok ? null : [tot.status, tot.code], [429, 'TOTAL_QUOTA']);
  assert.equal(st.docs.length, 1);
});

test('عدم التكرار: الملف نفسه للرافع نفسه ⇒ الصفّ القائم deduped ولو بلغت الحصة؛ ورافعٌ آخر ⇒ مستند جديد', async () => {
  reset();
  const bytes = png(300);
  const first = (await okDoc(up({ bytes }))).doc;
  st.atts.push({ id: 'FULL', tenantId: T, entityType: 'MOVE', entityId: 'MV1', sizeBytes: 500 * MB, createdAt: now() });
  const again = await okDoc(up({ bytes: Buffer.from(bytes) }));
  assert.deepEqual([again.deduped, again.doc.id], [true, first.id]);
  assert.equal(st.atts.filter((a) => a.entityType === 'AI_DOC').length, 1, 'بلا مرفق ثانٍ');
  assert.ok(again.doc.updatedAt.getTime() > first.updatedAt.getTime(), 'إعادة الرفع تلمس المستند (نشاط)');
  st.atts = st.atts.filter((a) => a.id !== 'FULL');
  const other = await okDoc(up({ bytes: Buffer.from(bytes), actorRef: 'OWNER:A1' }));
  assert.equal(other.deduped, false);
  assert.notEqual(other.doc.id, first.id);
  assert.equal(other.doc.actorRef, 'OWNER:A1', 'جلسة المالك رافعٌ مستقل');
});

test('عدم التكرار وملفه مفقود (تصفير الدفاتر): غير المرحّل يُستبدل، والمرتبط بقيد يُعاد كما هو', async () => {
  reset();
  const bytes = png(300);
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  const orphan = seedDoc({ sha256: sha });
  st.atts = [];
  const fresh = await okDoc(up({ bytes }));
  assert.equal(fresh.deduped, false);
  assert.notEqual(fresh.doc.id, orphan.id);
  assert.ok(!st.docs.some((d) => d.id === orphan.id));

  reset();
  const linked = seedDoc({ sha256: sha, moveId: 'MV1' });
  st.atts = [];
  const back = await okDoc(up({ bytes }));
  assert.deepEqual([back.deduped, back.doc.id], [true, linked.id]);
  assert.ok(st.docs.some((d) => d.id === linked.id), 'لا يُحذف مستندٌ مرتبط بقيد');
});

test('جمع المهمَل الكسول عند الرفع: القديم غير المرحّل يُحذف مع مرفقه AI_DOC، ولا يُمسّ المرتبط بقيد ولا مرفق صار على قيد', async () => {
  reset();
  const old = new Date(clock - 31 * 24 * 3600 * 1000);
  const stale = seedDoc({ createdAt: old });
  const young = seedDoc({ createdAt: new Date(clock - 29 * 24 * 3600 * 1000) });
  const posted = seedDoc({ createdAt: old, moveId: 'MV1' }, { entityType: 'MOVE', entityId: 'MV1' });
  // صفٌّ بلا قيد ومرفقه على قيد (حالة غير متّسقة): الصفّ يُجمع ومرفق القيد يبقى
  const odd = seedDoc({ createdAt: old }, { entityType: 'MOVE', entityId: 'MV2' });
  const otherTenant = seedDoc({ createdAt: old, tenantId: T2 }, { tenantId: T2 });
  await okDoc(up());
  const ids = new Set(st.docs.map((d) => d.id));
  assert.equal(ids.has(stale.id), false);
  assert.equal(ids.has(odd.id), false);
  assert.ok(ids.has(young.id) && ids.has(posted.id) && ids.has(otherTenant.id));
  const attIds = new Set(st.atts.map((a) => a.id));
  assert.equal(attIds.has(stale.attachmentId), false);
  assert.ok(attIds.has(posted.attachmentId) && attIds.has(odd.attachmentId) && attIds.has(otherTenant.attachmentId) && attIds.has(young.attachmentId));
  // تحت قفل الحصة وقبل حسابها
  assert.ok(log.indexOf(`lock:gl-attach:${T}`) < log.indexOf('att.deleteMany:1') && log.indexOf('att.deleteMany:1') < log.indexOf('att.aggregate'), log.join(' '));
});

test('البقاء بالنشاط: مستندٌ أُنشئ قبل ٣٥ يوماً وصُحّح أمس لا يُجمع، وإعادة رفع ملفٍ عمره ٢٩٫٥ يوماً تمدّه فلا يجمعه كنس الغد', async () => {
  reset();
  const DAY = 24 * 3600 * 1000;
  const touched = seedDoc({ createdAt: new Date(clock - 35 * DAY), updatedAt: new Date(clock - DAY) });
  const idle = seedDoc({ createdAt: new Date(clock - 35 * DAY) });
  assert.equal(await gc.gcTenantDocs(db as never, T, now()), 1);
  assert.deepEqual(st.docs.map((d) => d.id), [touched.id], 'الجمع على آخر نشاط (updatedAt) لا الإنشاء');
  assert.ok(!st.docs.some((d) => d.id === idle.id));

  // مستندٌ عمره ٢٩٫٥ يوماً يُعاد رفع ملفه (deduped) ⇒ يُلمس، فكنس الغد (بعد ٣٠ يوماً من إنشائه) لا يحذفه والبطاقة باقية
  reset();
  const bytes = png(300);
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  const old = seedDoc({ sha256: sha, createdAt: new Date(clock - 29.5 * DAY) });
  const again = await okDoc(up({ bytes }));
  assert.deepEqual([again.deduped, again.doc.id], [true, old.id]);
  clock += DAY;
  assert.equal((await gc.runDocsGc(db as never, { now: now() })).deleted, 0);
  assert.ok(st.docs.some((d) => d.id === old.id) && st.atts.some((a) => a.id === old.attachmentId), 'المستند وملفه باقيان');
  // مستندٌ مرتبط بقيد لا يُلمس بإعادة الرفع (لا كتابة على صفٍّ في الدفاتر)
  reset();
  const linked = seedDoc({ sha256: sha, moveId: 'MV1', createdAt: new Date(clock - 40 * DAY) }, { entityType: 'MOVE', entityId: 'MV1' });
  const back = await okDoc(up({ bytes }));
  assert.deepEqual([back.deduped, back.doc.id, back.doc.updatedAt.getTime()], [true, linked.id, linked.updatedAt.getTime()]);
});

test('جمع المهمَل: بحدّ ٥٠ للدورة، والكنس اليومي لكل الشركات بقفل كلٍّ منها حتى تفرغ', async () => {
  reset();
  const old = new Date(clock - 40 * 24 * 3600 * 1000);
  for (let i = 0; i < 60; i++) seedDoc({ createdAt: new Date(old.getTime() + i) });
  for (let i = 0; i < 3; i++) seedDoc({ createdAt: old, tenantId: T2 }, { tenantId: T2 });
  seedDoc({ createdAt: old, tenantId: T2, moveId: 'MVX' }, { tenantId: T2, entityType: 'MOVE', entityId: 'MVX' });
  assert.equal(await gc.gcTenantDocs(db as never, T, now()), 50);
  assert.equal(st.docs.filter((d) => d.tenantId === T).length, 10);
  const r = await gc.runDocsGc(db as never, { now: now() });
  assert.deepEqual(r, { tenants: 2, deleted: 13, failed: 0 });
  assert.deepEqual(st.docs.map((d) => d.moveId), ['MVX']);
  assert.ok(locks.includes(`gl-attach:${T}`) && locks.includes(`gl-attach:${T2}`));
  assert.equal(st.atts.length, 1);
  // البيئة تضبط المدة: ٧ أيام
  reset();
  seedDoc({ createdAt: new Date(clock - 8 * 24 * 3600 * 1000) });
  assert.equal(await gc.gcTenantDocs(db as never, T, now(), { retentionDays: 7 }), 1);
});

// ═══ التصحيح والحذف ═══

test('التصحيح: رافعه وحده، والمصدر USER أو QR+USER، وإعادة الفحص؛ القيمة غير الصالحة 400 باسم الحقل', async () => {
  reset();
  const calls: unknown[][] = [];
  const eng = fakeEngine(calls);
  const d = (await okDoc(up({}, eng))).doc;
  const p = await store.patchDocument(DB, { tenantId: T, actorRef: 'A1', id: d.id, patch: { total: '115.00', issueDate: '2026-11-10' } }, ENV, eng);
  assert.equal(p.ok, true, JSON.stringify(p));
  const after = (p as { doc: Row }).doc;
  assert.deepEqual([after.factsSource, after.status, after.facts.total, after.manualEntry], ['USER', 'EXTRACTED', '115.00', true]);
  assert.equal(after.suggestion.accountCode, '621010');
  assert.deepEqual((calls.find((c) => c[0] === 'recheck' && (c[1] as Row).manualEntry === true) ?? [])[0], 'recheck');

  for (const who of [{ actorRef: 'A2', tenantId: T }, { actorRef: 'A1', tenantId: T2 }, { actorRef: 'OWNER:A1', tenantId: T }]) {
    const x = await store.patchDocument(DB, { ...who, id: d.id, patch: { total: '1' } }, ENV, eng);
    assert.deepEqual(x.ok ? null : [x.status, x.code], [404, 'DOC_NOT_FOUND'], JSON.stringify(who));
  }
  const invalid = await store.patchDocument(DB, { tenantId: T, actorRef: 'A1', id: d.id, patch: { total: 'bad' } }, ENV, eng);
  assert.deepEqual(invalid.ok ? null : [invalid.status, invalid.code, invalid.details], [400, 'DOC_PATCH_INVALID', { field: 'total', reason: 'POSITIVE_DECIMAL' }]);

  const q = (await okDoc(up({ qrHeader: GOOD_QR }, eng))).doc;
  const pq = await store.patchDocument(DB, { tenantId: T, actorRef: 'A1', id: q.id, patch: { vendorName: 'الإتقان' } }, ENV, eng);
  assert.equal((pq as { doc: Row }).doc.factsSource, 'QR+USER');
});

test('التصحيح: QR_INVALID يبقى بعد التصحيح ما لم يُتحقَّق QR، ومستندٌ في قيد حيّ 409 ومعكوسٌ يُصحَّح، والسباق 409', async () => {
  reset();
  const eng = fakeEngine();
  const d = (await okDoc(up({ qrHeader: 'x'.repeat(2000) }, eng))).doc;
  const p = await store.patchDocument(DB, { tenantId: T, actorRef: 'A1', id: d.id, patch: { total: '50.00' } }, ENV, eng);
  const after = (p as { doc: Row }).doc;
  assert.ok(after.checks.some((c: Row) => c.code === 'QR_INVALID'), 'محمول');
  assert.equal(after.status, 'NEEDS_REVIEW', 'فحصٌ محمول فوق نتيجة خضراء');

  st.moves.push({ id: 'MV1', tenantId: T, number: 'JV-0007', state: 'POSTED', reversedMoveId: null });
  st.docs[0].moveId = 'MV1';
  const live = await store.patchDocument(DB, { tenantId: T, actorRef: 'A1', id: d.id, patch: { total: '60.00' } }, ENV, eng);
  assert.deepEqual(live.ok ? null : [live.status, live.code, live.details], [409, 'DOC_ALREADY_POSTED', { moveNumber: 'JV-0007' }]);
  st.moves.push({ id: 'MV1R', tenantId: T, number: 'JV-0008', state: 'POSTED', reversedMoveId: 'MV1' });
  const rev = await store.patchDocument(DB, { tenantId: T, actorRef: 'A1', id: d.id, patch: { total: '60.00' } }, ENV, eng);
  assert.equal(rev.ok, true, 'المعكوس يُصحَّح ثم يُعاد ترحيله');

  // سباق: صفٌّ تغيّر بين القراءة والكتابة (ترحيلٌ متزامن غيّر moveId) ⇒ 409 بلا كتابة
  const racy: DocFactsEngine = { ...eng, applyPatch(f, patch, env) { st.docs[0].moveId = 'MV9'; return eng.applyPatch(f, patch, env); } };
  const race = await store.patchDocument(DB, { tenantId: T, actorRef: 'A1', id: d.id, patch: { total: '70.00' } }, ENV, racy);
  assert.deepEqual(race.ok ? null : [race.status, race.code], [409, 'DOC_CHANGED']);
  assert.equal(st.docs[0].facts.total, '60.00');
});

test('الحذف: غير المرحّل يُحذف مع مرفقه ويحرّر الحصة تحت القفل؛ الحيّ 409؛ المعكوس يبقى ملفه على قيده؛ وغير الرافع 404', async () => {
  reset();
  const d = (await okDoc(up({ bytes: png(500) }))).doc;
  locks = [];
  log = [];
  const del = await store.deleteDocument(DB, { tenantId: T, actorRef: 'A1', id: d.id });
  assert.deepEqual(del, { ok: true, freedBytes: 500 });
  assert.deepEqual([st.docs.length, st.atts.length, locks], [0, 0, [`gl-attach:${T}`]]);
  // ترتيب أقفال الترحيل والجمع نفسه: صفّ المرفق ثم صفّ المستند (لا تعارض أقفال مع «سجّل القيد» من نافذة أخرى)
  assert.ok(log.indexOf('att.deleteMany:1') >= 0 && log.indexOf('att.deleteMany:1') < log.indexOf('doc.deleteMany:1'), log.join(' '));

  const live = seedDoc({ moveId: 'MV1' }, { entityType: 'MOVE', entityId: 'MV1' });
  st.moves.push({ id: 'MV1', tenantId: T, number: 'JV-0001', state: 'POSTED', reversedMoveId: null });
  const x = await store.deleteDocument(DB, { tenantId: T, actorRef: 'A1', id: live.id });
  assert.deepEqual(x.ok ? null : [x.status, x.code], [409, 'DOC_ALREADY_POSTED']);
  assert.equal(st.docs.length, 1);

  st.moves.push({ id: 'MV1R', tenantId: T, number: 'JV-0002', state: 'POSTED', reversedMoveId: 'MV1' });
  const rev = await store.deleteDocument(DB, { tenantId: T, actorRef: 'A1', id: live.id });
  assert.deepEqual(rev, { ok: true, freedBytes: 0 });
  assert.deepEqual([st.docs.length, st.atts.length, st.atts[0].entityType], [0, 1, 'MOVE'], 'مرفق القيد المعكوس دليلٌ يبقى');

  const mine = seedDoc();
  for (const who of [{ actorRef: 'A2', tenantId: T }, { actorRef: 'A1', tenantId: T2 }]) {
    const y = await store.deleteDocument(DB, { ...who, id: mine.id });
    assert.deepEqual(y.ok ? null : [y.status, y.code], [404, 'DOC_NOT_FOUND']);
  }
  // سباق: رُحّل بين القراءة والحذف ⇒ 409 والملف باقٍ
  const racy = seedDoc();
  const orig = db.aiAccountantDocument.deleteMany;
  db.aiAccountantDocument.deleteMany = async (a: Row) => { st.docs.find((r) => r.id === racy.id)!.moveId = 'MVZ'; return orig(a); };
  try {
    const z = await store.deleteDocument(DB, { tenantId: T, actorRef: 'A1', id: racy.id });
    assert.deepEqual(z.ok ? null : [z.status, z.code], [409, 'DOC_ALREADY_POSTED']);
    assert.ok(st.atts.some((a) => a.id === racy.attachmentId), 'المعاملة سقطت: الملف المحذوف أولاً عاد');
    assert.ok(st.docs.some((r) => r.id === racy.id));
    assert.ok(log.includes('tx:rollback'));
  } finally { db.aiAccountantDocument.deleteMany = orig; }
});

// ═══ القراءة والعزل ═══

test('loadDocsForCtx: شركة الجلسة والرافع وحدهما بترتيب الظهور بلا تكرار، والمعرّف الغريب يسقط بصمت', async () => {
  reset();
  const a = seedDoc();
  const b = seedDoc();
  const foreignTenant = seedDoc({ tenantId: T2 });
  const otherActor = seedDoc({ actorRef: 'A2' });
  const owner = seedDoc({ actorRef: 'OWNER:A1' });
  const rows = await store.loadDocsForCtx(DB, { tenantId: T, actorRef: 'A1', ids: [b.id, foreignTenant.id, a.id, b.id, otherActor.id, owner.id, 'not-a-uuid', 42] });
  assert.deepEqual(rows.map((r) => r.id), [b.id, a.id]);
  assert.deepEqual((await store.loadDocsForCtx(DB, { tenantId: T, actorRef: 'OWNER:A1', ids: [a.id, owner.id] })).map((r) => r.id), [owner.id]);
  assert.deepEqual(await store.loadDocsForCtx(DB, { tenantId: T, actorRef: '', ids: [a.id] }), []);
  const many = Array.from({ length: 50 }, () => seedDoc().id);
  assert.equal((await store.loadDocsForCtx(DB, { tenantId: T, actorRef: 'A1', ids: many })).length, store.MAX_CTX_DOCS);
});

test('القراءة: غير المرحّل لرافعه وحده، والمرتبط بقيد لمن يرى الدفاتر في الشركة، وشركة أخرى لا شيء', async () => {
  reset();
  const open = seedDoc({ actorRef: 'A2' });
  const linked = seedDoc({ actorRef: 'A2', moveId: 'MV1' });
  assert.equal(await store.findDocForViewer(DB, { tenantId: T, actorRef: 'A1', id: open.id }), null);
  assert.equal((await store.findDocForViewer(DB, { tenantId: T, actorRef: 'A2', id: open.id }))?.id, open.id);
  assert.equal((await store.findDocForViewer(DB, { tenantId: T, actorRef: 'A1', id: linked.id }))?.id, linked.id);
  assert.equal(await store.findDocForViewer(DB, { tenantId: T2, actorRef: 'A2', id: linked.id }), null);
  const file = await store.docContent(DB, T, open);
  assert.equal(file?.mimeType, 'image/png');
  assert.equal(await store.docContent(DB, T2, open), null, 'مرفق شركة أخرى');
});

test('الحالة المرحّلة والعرض: حيّ/معكوس/مسودة/مفقود، FILE_GONE ⇒ FAILED، والمكرّر بالبصمة أو برقم الفاتورة عند غيره', async () => {
  reset();
  st.moves.push(
    { id: 'L', tenantId: T, number: 'JV-1', state: 'POSTED', reversedMoveId: null },
    { id: 'R', tenantId: T, number: 'JV-2', state: 'POSTED', reversedMoveId: null },
    { id: 'RR', tenantId: T, number: 'JV-3', state: 'POSTED', reversedMoveId: 'R' },
    { id: 'D', tenantId: T, number: null, state: 'DRAFT', reversedMoveId: null },
    { id: 'X', tenantId: T2, number: 'JV-9', state: 'POSTED', reversedMoveId: null },
  );
  st.posts.push({ tenantId: T, moveId: 'L', kind: 'PREPAID', createdAt: now() });
  const s = await store.postedStates(DB, T, ['L', 'R', 'D', 'GONE', 'X', null]);
  assert.deepEqual(s.get('L'), { moveId: 'L', moveNumber: 'JV-1', live: true, kind: 'PREPAID' });
  assert.deepEqual([s.get('R')!.live, s.get('D')!.live, s.get('GONE')!.live, s.get('X')!.live], [false, false, false, false]);
  assert.equal(await store.liveMoveOf(DB, T, null), null);

  const sha = 'abc123';
  const mine = seedDoc({ sha256: sha, facts: { ...types.emptyFacts(), invoiceNo: 'INV-77', vendorVat: '310123456700003' } });
  seedDoc({ actorRef: 'A2', sha256: sha, moveId: 'L' }, { entityType: 'MOVE', entityId: 'L' });
  const byInvoice = seedDoc({ sha256: 'zzz', facts: { ...types.emptyFacts(), invoiceNo: 'INV-88', vendorVat: '310123456700003' } });
  seedDoc({ actorRef: 'A2', sha256: 'yyy', moveId: 'L', facts: { ...types.emptyFacts(), invoiceNo: 'INV-88', vendorVat: '310123456700003' } });
  const reversedOnly = seedDoc({ sha256: 'rev', facts: { ...types.emptyFacts(), invoiceNo: 'INV-99' } });
  seedDoc({ actorRef: 'A2', sha256: 'rev', moveId: 'R' });
  const gone = seedDoc();
  st.atts = st.atts.filter((a) => a.id !== gone.attachmentId);
  const views = await store.docViewsFor(DB, T, [mine, byInvoice, reversedOnly, gone], ENV, new Map([[mine.id, 'D1']]), fakeEngine());
  assert.deepEqual(views[0].duplicateOf, { moveNumber: 'JV-1', reason: 'SHA' });
  assert.equal(views[0].ref, 'D1');
  assert.deepEqual(views[1].duplicateOf, { moveNumber: 'JV-1', reason: 'INVOICE_NO' });
  assert.equal(views[2].duplicateOf, null, 'قيدٌ معكوس لا يُعدّ تكراراً');
  assert.deepEqual([views[3].status, views[3].checks[0]], ['FAILED', { code: 'FILE_GONE', severity: 'block' }]);
  assert.deepEqual(views[0].payOptions, [{ paidFrom: 'cash', code: '111001', name: 'الصندوق الرئيسي' }]);
  assert.equal(views[0].posted, null);
});

test('toView: JSON معطوب يسقط بأمان، والحقول المعروفة وحدها، والحالة المجهولة NEEDS_REVIEW', () => {
  const base = seedDoc({ status: 'WAT', factsSource: 'AI', facts: { total: 5, vendorName: 'x', lines: [{ description: 'a', amount: '1' }, 'bad'], hack: true }, checks: [{ code: 'X', severity: 'nope' }, { code: 'QR_INVALID', severity: 'warn', details: { a: 'b', n: 3 } }], suggestion: { treatment: 'EXPENSE' } });
  const v = view.toView(base as never);
  assert.equal(v.status, 'NEEDS_REVIEW');
  assert.equal(v.factsSource, null, "لا مصدر 'AI' (D4)");
  assert.equal(v.facts!.total, null);
  assert.equal(v.facts!.vendorName, 'x');
  assert.deepEqual(v.facts!.lines, [{ description: 'a', amount: '1' }]);
  assert.equal((v.facts as Row).hack, undefined);
  assert.deepEqual(v.checks, [{ code: 'QR_INVALID', severity: 'warn', details: { a: 'b' } }]);
  assert.equal(v.suggestion, null);
  assert.equal(typeof v.createdAt, 'string');
});

// ═══ معاملة الترحيل ═══

test('relinkDocAttachment: AI_DOC ⇒ MOVE بصفٍّ واحد وتدقيق ATTACHMENT_ADD؛ إعادة الترحيل من القيد المعكوس بـrelinkedFrom؛ والمفقود DOC_FILE_GONE', async () => {
  reset();
  const audits: Row[] = [];
  const deps = { appendAudit: (async (_tx: unknown, input: Row) => { audits.push(input); return {} as never; }) as never };
  const d = seedDoc({ fileName: 'فاتورة.png' });
  const actor = { actorType: 'ADMIN' as const, actorId: 'A1', actorName: 'المحاسب الذكي بطلب سارة', impersonated: false };
  const r1 = await store.relinkDocAttachment(db as never, { tenantId: T, doc: d as never, moveId: 'MV1', moveNumber: 'JV-0001', actor }, deps);
  assert.deepEqual(r1, { relinkedFrom: null });
  assert.deepEqual([st.atts[0].entityType, st.atts[0].entityId], ['MOVE', 'MV1']);
  assert.equal(audits[0].action, 'ATTACHMENT_ADD');
  assert.deepEqual([audits[0].entityType, audits[0].entityId, audits[0].actor], ['MOVE', 'MV1', actor]);
  assert.equal(audits[0].after.relinkedFrom, undefined);
  assert.equal(audits[0].after.docId, d.id);

  // عُكس MV1 ثم أُعيد الترحيل إلى MV2: الصفّ نفسه من القيد السابق
  const r2 = await store.relinkDocAttachment(db as never, { tenantId: T, doc: { ...d, moveId: 'MV1' } as never, moveId: 'MV2', actor }, deps);
  assert.deepEqual(r2, { relinkedFrom: 'MV1' });
  assert.equal(st.atts[0].entityId, 'MV2');
  assert.equal(audits[1].after.relinkedFrom, 'MV1');
  // نداءٌ معاد للقيد نفسه: بلا كتابة ولا تدقيق ثانٍ
  assert.deepEqual(await store.relinkDocAttachment(db as never, { tenantId: T, doc: { ...d, moveId: 'MV2' } as never, moveId: 'MV2', actor }, deps), { relinkedFrom: null });
  assert.equal(audits.length, 2);

  // شركة أخرى، أو صفٌّ على قيدٍ لا يخصّ المستند، أو ملف محذوف ⇒ رفض يُسقط المعاملة
  await assert.rejects(store.relinkDocAttachment(db as never, { tenantId: T2, doc: { ...d, moveId: 'MV2' } as never, moveId: 'MV3' }, deps),
    (e: unknown) => e instanceof posting.AiPostRefusal && e.refusal.code === 'DOC_FILE_GONE');
  await assert.rejects(store.relinkDocAttachment(db as never, { tenantId: T, doc: { ...d, moveId: null } as never, moveId: 'MV3' }, deps),
    (e: unknown) => e instanceof posting.AiPostRefusal && e.refusal.code === 'DOC_FILE_GONE', 'المرفق على MV2 والمستند يقول بلا قيد');
  assert.equal(st.atts[0].entityId, 'MV2');
  assert.equal(audits.length, 2);
});

test('markDocPosted: مقارنة وتبديل على moveId السابق وupdatedAt — ترحيلان متزامنان ⇒ DOC_ALREADY_POSTED، وتصحيحٌ بينهما ⇒ DOC_CHANGED', async () => {
  reset();
  const d = seedDoc();
  const read0 = d.updatedAt;
  await store.markDocPosted(db as never, { tenantId: T, doc: { id: d.id, moveId: null, updatedAt: read0 }, moveId: 'MV1', postId: 'P1' });
  assert.deepEqual([st.docs[0].moveId, st.docs[0].postId], ['MV1', 'P1']);
  await assert.rejects(store.markDocPosted(db as never, { tenantId: T, doc: { id: d.id, moveId: null, updatedAt: read0 }, moveId: 'MV2', postId: 'P2' }),
    (e: unknown) => e instanceof posting.AiPostRefusal && e.refusal.code === 'DOC_ALREADY_POSTED');
  const read1 = st.docs[0].updatedAt as Date;
  await store.markDocPosted(db as never, { tenantId: T, doc: { id: d.id, moveId: 'MV1', updatedAt: read1 }, moveId: 'MV2', postId: 'P2' });
  assert.equal(st.docs[0].moveId, 'MV2');
  // تصحيحٌ (PATCH من نافذة أخرى) بعد القراءة وقبل الربط: moveId كما هو وupdatedAt تغيّر ⇒ DOC_CHANGED فتسقط المعاملة
  reset();
  const e = seedDoc();
  const snapshot = e.updatedAt;
  await db.aiAccountantDocument.updateMany({ where: { id: e.id, tenantId: T, moveId: null }, data: { facts: { total: '999.00' } } });
  await assert.rejects(store.markDocPosted(db as never, { tenantId: T, doc: { id: e.id, moveId: null, updatedAt: snapshot }, moveId: 'MV1', postId: 'P1' }),
    (x: unknown) => x instanceof posting.AiPostRefusal && x.refusal.code === 'DOC_CHANGED');
  assert.equal(st.docs[0].moveId, null);
  assert.ok((types.AI_DOC_REFUSALS as readonly string[]).includes('DOC_CHANGED'));
});

test('فحوص التاريخ مشتقّة عند العرض: «مستقبلي» يوم الرفع يزول حين يحلّ تاريخه، و«أقدم من سنة» يظهر حين يشيخ — بلا كتابة', async () => {
  reset();
  // رُفع في ٢٨ نوفمبر بتاريخ ١ ديسمبر (DATE_FUTURE مخزّن)؛ اليوم ٢ ديسمبر
  const future = seedDoc({
    status: 'NEEDS_REVIEW', manualEntry: false, factsSource: 'USER',
    facts: { ...types.emptyFacts(), issueDate: '2026-12-01', total: '115.00' },
    checks: [{ code: 'DATE_FUTURE', severity: 'block', field: 'issueDate', details: { date: '2026-12-01', today: '2026-11-28' } }, { code: 'QR_INVALID', severity: 'warn' }],
  });
  const clean = seedDoc({ status: 'NEEDS_REVIEW', manualEntry: false, factsSource: 'USER', facts: { ...types.emptyFacts(), issueDate: '2026-12-01', total: '115.00' }, checks: [{ code: 'DATE_FUTURE', severity: 'block', field: 'issueDate', details: { date: '2026-12-01', today: '2026-11-28' } }] });
  const inventory = seedDoc({ status: 'NEEDS_REVIEW', factsSource: 'USER', facts: { ...types.emptyFacts(), issueDate: '2026-12-01', total: '115.00', categoryHint: 'inventory_goods' }, checks: [{ code: 'DATE_FUTURE', severity: 'block', field: 'issueDate', details: { date: '2026-12-01', today: '2026-11-28' } }] });
  // رُفع بلا فحوص قبل ١١ شهراً ونصف؛ اليوم صار أقدم من سنة
  const aging = seedDoc({ status: 'EXTRACTED', factsSource: 'USER', facts: { ...types.emptyFacts(), issueDate: '2025-11-20', total: '50.00' }, checks: [] });
  const dec2 = { ...ENV, todayLocal: '2026-12-02' };
  const [vf, vc, vi, va] = await store.docViewsFor(DB, T, [future, clean, inventory, aging], dec2, new Map(), fakeEngine());
  assert.deepEqual(vf.checks.map((c) => c.code), ['QR_INVALID'], 'DATE_FUTURE زال وبقي غيره');
  assert.equal(vf.status, 'NEEDS_REVIEW');
  assert.deepEqual([vc.checks, vc.status], [[], 'EXTRACTED'], 'لا فحص باقٍ ⇒ جاهز');
  assert.deepEqual([vi.checks, vi.status], [[], 'NEEDS_REVIEW'], 'البضاعة لا تصير «جاهزة»');
  assert.deepEqual(va.checks.map((c) => [c.code, c.severity]), [['DATE_TOO_OLD', 'warn']]);
  assert.equal(va.status, 'NEEDS_REVIEW');
  // ما زال مستقبلياً بيومٍ قبل تاريخه ⇒ يبقى كما هو؛ والصفوف المخزّنة لم تُمسّ
  const [still] = await store.docViewsFor(DB, T, [clean], { ...ENV, todayLocal: '2026-11-30' }, new Map(), fakeEngine());
  assert.deepEqual([still.checks.map((c) => c.code), still.status], [['DATE_FUTURE'], 'NEEDS_REVIEW']);
  assert.equal(st.docs.find((d) => d.id === clean.id)!.checks.length, 1);
});

test('loadDocEnv: منازل العملة والمربّع من الدفاتر، والرقم الضريبي، والدليل بشركة الجلسة، وحدّ الرسملة من البيئة', async () => {
  reset();
  const e = await store.loadDocEnv(DB, { tenantId: T, currency: 'SAR', tz: 'Asia/Riyadh', todayLocal: '2026-11-18', taxDisabled: false }, { AI_ACCOUNTANT_ASSET_THRESHOLD: '3000' } as NodeJS.ProcessEnv);
  assert.deepEqual([e.currencyDecimals, e.vatBox, e.companyVat, e.assetThresholdMilli], [2, true, '300000000000003', 3_000_000n]);
  assert.ok(e.accounts.some((a) => a.code === '213002'));
  st.gl = { ...st.gl!, templateKey: 'GENERIC_6D', currencyDecimals: 3 };
  st.company = { ...st.company!, taxNumber: '  ' };
  const g = await store.loadDocEnv(DB, { tenantId: T, currency: 'KWD', tz: 'Asia/Kuwait', todayLocal: '2026-11-18', taxDisabled: true });
  assert.deepEqual([g.vatBox, g.currencyDecimals, g.companyVat, g.taxDisabled], [false, 3, null, true]);
});

test('العقد: لا مصدر AI ولا ثقة ولا موافقة (D4/D5)، ورموز الرفض تشمل NOT_A_PAYMENT وDOCS_DISABLED بلا DOCS_CONSENT_REQUIRED', () => {
  assert.deepEqual([...types.ACCT_FACTS_SOURCES], ['QR', 'USER', 'QR+USER']);
  assert.equal('confidence' in types.emptyFacts(), false);
  const refusals = types.AI_DOC_REFUSALS as readonly string[];
  for (const c of ['DOC_NOT_FOUND', 'DOC_ALREADY_POSTED', 'DOC_FILE_GONE', 'ASSET_BELOW_THRESHOLD', 'DOC_TREATMENT_REFERRED', 'DOC_IS_INVENTORY', 'NOT_A_PAYMENT', 'DOCS_DISABLED']) {
    assert.ok(refusals.includes(c), c);
  }
  assert.equal(refusals.includes('DOCS_CONSENT_REQUIRED'), false);
  assert.deepEqual(types.ACCT_ASSET_CODES, {
    leasehold_improvements: '121003', machinery: '121004', furniture: '121005', computers: '121006', vehicles: '121007', tools: '121008', software_license: '124001',
  });
  assert.ok(types.VENDOR_VAT_RE.test('310123456700003') && !types.VENDOR_VAT_RE.test('210123456700003') && !types.VENDOR_VAT_RE.test('31012345670003'));
});

test('المخطط: جدول المستندات الجديد بفهارسه وقيده الفريد، وأعمدة اختيارية بفهارس عادية على ai_accountant_posts', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('node:fs') as typeof import('node:fs');
  const schema = fs.readFileSync(path.join(SRC, '..', 'prisma', 'schema.prisma'), 'utf8').replace(/\r\n/g, '\n');
  const block = (name: string) => { const i = schema.indexOf(`model ${name} {`); assert.ok(i > 0, name); return schema.slice(i, schema.indexOf('\n}', i)); };
  const d = block('AiAccountantDocument');
  for (const f of [
    /tenant\s+Tenant\s+@relation\(fields: \[tenantId\], references: \[id\], onDelete: Cascade\)/, /actorRef\s+String\b/, /attachmentId\s+String\b/,
    /sha256\s+String\b/, /status\s+String\b/, /manualEntry\s+Boolean\s+@default\(false\)/, /factsSource\s+String\?/, /facts\s+Json\?/,
    /qrRaw\s+String\?/, /qrVerified\s+Boolean\s+@default\(false\)/, /checks\s+Json\b/, /suggestion\s+Json\?/, /moveId\s+String\?/,
    /@@unique\(\[tenantId, actorRef, sha256\]\)/, /@@index\(\[tenantId, actorRef, createdAt\]\)/, /@@index\(\[tenantId, sha256\]\)/,
    /@@map\("ai_accountant_documents"\)/,
  ]) assert.match(d, f);
  assert.doesNotMatch(d, /consent|confidence|extractor/i);
  const p = block('AiAccountantPost');
  assert.match(p, /docId\s+String\?/);
  assert.match(p, /parentPostId\s+String\?/);
  assert.match(p, /meta\s+Json\?/);
  assert.match(p, /@@index\(\[tenantId, docId\]\)/);
  assert.match(p, /@@index\(\[tenantId, parentPostId\]\)/);
  assert.equal((p.match(/^\s*@@unique/gm) ?? []).length, 1, 'لا @@unique جديد على جدول قائم');
  const tenant = block('Tenant');
  assert.match(tenant, /aiAccountantDocuments\s+AiAccountantDocument\[\]/);
  assert.doesNotMatch(tenant, /aiAccountantDocsConsent/);
});

// ═══ المسارات بحرّاسها الحقيقيين ═══

function mockRes() {
  const res: Row = { statusCode: 200, body: null, headers: {} };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.setHeader = (k: string, v: string) => { res.headers[k.toLowerCase()] = v; };
  return res;
}

const sign = (u: Row) => jwt.sign(u, process.env.JWT_SECRET!);

function hit(method: string, url: string, opts: { body?: unknown; headers?: Row; user?: Row } = {}): Promise<{ status: number; body: Row | null; raw?: Buffer; headers: Row; err?: unknown }> {
  return new Promise((resolve) => {
    const res = mockRes();
    res.json = (b: Row) => { res.body = b; resolve({ status: res.statusCode, body: b, headers: res.headers }); return res; };
    res.end = (b: Buffer) => { resolve({ status: res.statusCode, body: null, raw: b, headers: res.headers }); return res; };
    const token = sign(opts.user ?? { id: 'A1', role: 'ADMIN', name: 'سارة', tenantId: T });
    const req: Row = {
      method, url, originalUrl: `/api/ai-accountant${url}`, baseUrl: '', path: url.split('?')[0],
      headers: { authorization: `Bearer ${token}`, ...(opts.headers ?? {}) }, body: opts.body ?? {}, query: {}, params: {},
    };
    (router as unknown as (rq: Row, rs: Row, n: (e?: unknown) => void) => void)(req, res, (err?: unknown) => resolve({ status: err ? 500 : 404, body: null, headers: res.headers, err }));
  });
}

const upload = (bytes: Buffer, headers: Row = {}, user?: Row) =>
  hit('POST', '/documents', { body: bytes, headers: { 'content-type': 'image/png', 'x-file-name': encodeURIComponent('إيصال.png'), ...headers }, user });

test('POST /documents: 201 {document, deduped} بالعرض الكامل، والشركة والرافع من الجلسة لا من الجسم', async () => {
  reset();
  const bytes = png(256);
  const r = await upload(bytes, { 'x-tenant-id': T2 });
  assert.equal(r.status, 201, JSON.stringify(r.body ?? r.err));
  const v = r.body!.data.document;
  assert.equal(r.body!.data.deduped, false);
  for (const k of ['id', 'ref', 'fileName', 'mimeType', 'sizeBytes', 'createdAt', 'status', 'manualEntry', 'factsSource', 'facts', 'checks', 'qrVerified', 'suggestion', 'accountOptions', 'payOptions', 'posted', 'duplicateOf']) {
    assert.ok(k in v, k);
  }
  assert.deepEqual([v.fileName, v.mimeType, v.sizeBytes, v.status, v.manualEntry, v.ref, v.posted], ['إيصال.png', 'image/png', 256, 'NEEDS_REVIEW', true, '', null]);
  assert.ok(v.payOptions.some((o: Row) => o.paidFrom === 'payable' && o.code === '213002'), JSON.stringify(v.payOptions));
  assert.deepEqual([st.docs[0].tenantId, st.docs[0].actorRef], [T, 'A1']);
  const again = await upload(Buffer.from(bytes));
  assert.deepEqual([again.status, again.body!.data.deduped, again.body!.data.document.id], [201, true, v.id]);
  const bad = await upload(pdf(), { 'content-type': 'image/png' });
  assert.deepEqual([bad.status, bad.body?.code], [415, 'ATTACHMENT_TYPE_NOT_ALLOWED']);
  const json = await hit('POST', '/documents', { body: { contentBase64: 'AAAA' }, headers: { 'content-type': 'application/json' } });
  assert.deepEqual([json.status, json.body?.code], [415, 'ATTACHMENT_TYPE_NOT_ALLOWED'], 'خامٌ وحده');
});

test('المسارات: مفتاح الإطفاء DOCS_DISABLED، وAI_ACCOUNTANT_WRITE=0، ومن لا يرحّل NOT_ALLOWED، والقراءة لمن يرى الدفاتر', async () => {
  reset();
  const d = seedDoc();
  for (const [k, v] of [['AI_ACCOUNTANT_DOCS', '0'], ['AI_ACCOUNTANT_DOCS', 'off'], ['AI_ACCOUNTANT_WRITE', '0'], ['AI_ACCOUNTANT_LLM', '0']] as const) {
    process.env[k] = v;
    try {
      for (const [m, u, body] of [['POST', '/documents', png()], ['PATCH', `/documents/${d.id}`, { total: '5' }], ['DELETE', `/documents/${d.id}`, {}]] as const) {
        const r = await hit(m, u, { body, headers: { 'content-type': m === 'POST' ? 'image/png' : 'application/json' } });
        assert.deepEqual([r.status, r.body?.code], [403, 'DOCS_DISABLED'], `${k}=${v} ${m}`);
      }
    } finally { delete process.env[k]; }
  }
  assert.equal(st.docs.length, 1);
  // نموذجٌ غير مُعدّ: «سجّل القيد» لن يعمل ⇒ لا رفع
  delete process.env.GROQ_API_KEY;
  try {
    const r = await upload(png());
    assert.deepEqual([r.status, r.body?.code], [403, 'DOCS_DISABLED'], 'بلا نموذج مُعدّ');
  } finally { process.env.GROQ_API_KEY = 'gsk_test_docs'; }
  assert.equal(st.docs.length, 1);

  // يرى الدفاتر ولا يرحّل: الكتابة ممنوعة والقراءة مسموحة
  st.admin = { ...st.admin!, canManageCompanyUsers: false, canViewLedger: true, canPostJournals: false };
  const w = await upload(png());
  assert.deepEqual([w.status, w.body?.code], [403, 'NOT_ALLOWED']);
  const del = await hit('DELETE', `/documents/${d.id}`);
  assert.deepEqual([del.status, del.body?.code], [403, 'NOT_ALLOWED']);
  const g = await hit('GET', `/documents/${d.id}`);
  assert.equal(g.status, 200, JSON.stringify(g.body));
  assert.equal(g.body!.data.document.id, d.id);
  // لا يرى الدفاتر
  st.admin = { ...st.admin!, canViewLedger: false };
  const n = await hit('GET', `/documents/${d.id}`);
  assert.deepEqual([n.status, n.body?.code], [403, 'NOT_ALLOWED']);
  const c = await hit('GET', `/documents/${d.id}/content`);
  assert.deepEqual([c.status, c.body?.code], [403, 'NOT_ALLOWED']);
  // الدفاتر غير مفعّلة ⇒ لا ترحيل ولا رفع
  reset();
  st.gl = { ...st.gl!, activatedAt: null };
  assert.equal((await upload(png())).body?.code, 'NOT_ALLOWED');
  // المندوب يُردّ في السلسلة قبل كل شيء
  reset();
  const rep = await upload(png(), {}, { id: 'R1', role: 'SALES_REP', name: 'مندوب', tenantId: T });
  assert.equal(rep.status, 403);
  assert.equal(st.docs.length, 0);
});

test('GET /documents/:id و/content: العزل والترويسات (nosniff، inline، no-store)، والمعرّف غير الصالح 404', async () => {
  reset();
  const mine = seedDoc({ fileName: 'فاتورة ٢٢٣١.png' });
  const other = seedDoc({ actorRef: 'A2' });
  const foreign = seedDoc({ tenantId: T2 });
  const c = await hit('GET', `/documents/${mine.id}/content`);
  assert.equal(c.status, 200);
  assert.ok(Buffer.isBuffer(c.raw) && c.raw!.length === 100);
  assert.equal(c.headers['content-type'], 'image/png');
  assert.equal(c.headers['x-content-type-options'], 'nosniff');
  assert.equal(c.headers['cache-control'], 'private, no-store');
  assert.match(c.headers['content-disposition'], /^inline; filename="[^"]*"; filename\*=UTF-8''/);
  for (const id of [other.id, foreign.id, 'nope', 'not-a-uuid-at-all']) {
    const r = await hit('GET', `/documents/${id}`);
    assert.deepEqual([r.status, r.body?.code], [404, 'DOC_NOT_FOUND'], id);
    const rc = await hit('GET', `/documents/${id}/content`);
    assert.deepEqual([rc.status, rc.body?.code], [404, 'DOC_NOT_FOUND'], id);
  }
});

test('PATCH و DELETE عبر الموجّه: الجسم بـzod (400 INVALID_BODY)، والتصحيح يعيد العرض، والحذف {deleted:true}', async () => {
  reset();
  const d = (await upload(png(300))).body!.data.document;
  const bad = await hit('PATCH', `/documents/${d.id}`, { body: { docType: 'NOT_A_TYPE' } });
  assert.deepEqual([bad.status, bad.body?.code], [400, 'INVALID_BODY']);
  const bad2 = await hit('PATCH', `/documents/${d.id}`, { body: { months: 2.5 } });
  assert.deepEqual([bad2.status, bad2.body?.code], [400, 'INVALID_BODY']);
  const bad3 = await hit('PATCH', `/documents/${d.id}`, { body: { total: '١٬١٥٠٫٠٠ ريال؟؟' } });
  assert.deepEqual([bad3.status, bad3.body?.code, bad3.body?.details?.field], [400, 'DOC_PATCH_INVALID', 'total']);
  const ok = await hit('PATCH', `/documents/${d.id}`, {
    body: { docType: 'MAINTENANCE_INVOICE', categoryHint: 'maintenance', total: '١٬١٥٠٫٠٠', vatAmount: 150, issueDate: '2026-11-10', vendorVat: '310123456700003', tenantId: T2 },
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const v = ok.body!.data.document;
  assert.deepEqual([v.factsSource, v.facts.total, v.facts.vatAmount, v.facts.subtotal, v.facts.docType], ['USER', '1150.00', '150.00', '1000.00', 'MAINTENANCE_INVOICE']);
  assert.equal(v.suggestion?.accountCode, '621010');
  assert.equal(st.docs[0].tenantId, T);
  const nf = await hit('PATCH', '/documents/not-uuid', { body: {} });
  assert.deepEqual([nf.status, nf.body?.code], [404, 'DOC_NOT_FOUND']);
  // مستندٌ في قيد حيّ ⇒ 409 للتصحيح والحذف
  st.moves.push({ id: 'MV1', tenantId: T, number: 'JV-0042', state: 'POSTED', reversedMoveId: null });
  st.docs[0].moveId = 'MV1';
  const p409 = await hit('PATCH', `/documents/${d.id}`, { body: { total: '1' } });
  assert.deepEqual([p409.status, p409.body?.code, p409.body?.details], [409, 'DOC_ALREADY_POSTED', { moveNumber: 'JV-0042' }]);
  const d409 = await hit('DELETE', `/documents/${d.id}`);
  assert.deepEqual([d409.status, d409.body?.code], [409, 'DOC_ALREADY_POSTED']);
  st.docs[0].moveId = null;
  const del = await hit('DELETE', `/documents/${d.id}`);
  assert.deepEqual([del.status, del.body], [200, { success: true, data: { deleted: true } }]);
  assert.deepEqual([st.docs.length, st.atts.length], [0, 0]);
});

test('الموجّه: مسارات المستندات تحت السلسلة نفسها، والحارس بعد السلسلة وقبل الجسم الخام', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('node:fs') as typeof import('node:fs');
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const r = strip(fs.readFileSync(path.join(SRC, 'routes', 'aiAccountant.ts'), 'utf8').replace(/\r\n/g, '\n'));
  assert.match(r, /router\.post\('\/documents', requireDocs, readRawDoc,/);
  assert.match(r, /router\.patch\('\/documents\/:id', requireDocs,/);
  assert.match(r, /router\.delete\('\/documents\/:id', requireDocs,/);
  assert.match(r, /router\.get\('\/documents\/:id', requireDocsView,/);
  assert.match(r, /router\.get\('\/documents\/:id\/content', requireDocsView,/);
  assert.ok(r.indexOf("router.use(authenticate, requireAdmin, requireAiAccountant, requireAdminPermission('canViewReports'), refuseRepKeyScoped);") < r.indexOf("router.post('/documents'"));
  // لا قارئ ذكاء اصطناعي ولا موافقة (D4/D5)
  assert.doesNotMatch(r, /\/extract|consent|VISION/i);
  const svc = ['types', 'caps', 'store', 'view', 'gc'].map((f) => strip(fs.readFileSync(path.join(SRC, 'services', 'aiAccountant', 'documents', `${f}.ts`), 'utf8'))).join('\n');
  assert.doesNotMatch(svc, /gemini|groq|fetch\(|AI_ACCOUNTANT_VISION|consent/i, 'المستند لا يغادر المنصة');
});

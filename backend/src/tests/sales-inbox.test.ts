// «إدارة المبيعات» (طلب المالك ١٦ نوفمبر ٢٠٢٦): قمعٌ واحد لكل من تواصل مع المنصة — التجارب (ذاتية وعبر سفير)، نماذج الموقع،
// ومحادثات بوت واتساب. نثبت فوق Prisma مزيّف في الذاكرة (بلا قاعدة) وبوتٍ مزيّف (بلا شبكة): ترجمة كل مصدر إلى صفّه، وأن المزامنة
// لا تمسّ المرحلة والملاحظة أبداً، والخنق، وصلاحية واتساب، والتعديل، وأن النماذج تُسجَّل قبل البريد ولا يمنعه تعذّر القاعدة.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import jwt from 'jsonwebtoken';
import express from 'express';

process.env.JWT_SECRET = 'sales-inbox-test-secret';
delete process.env.STAFF_JWT_SECRET;
const SECRET = process.env.JWT_SECRET;
const SRC = path.join(__dirname, '..');
const read = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), 'utf8');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

// ─── Prisma مزيّف: مطابِقٌ يرفض ما لا يعرفه من العوامل ───
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
let contacts: Row[] = [];
let tenants: Row[] = [];
let attributions: Row[] = [];
const staff = new Map<string, Row>();
const owners = new Map<string, { id: string; isActive: boolean }>();
let seq = 0;
let contactCreateFails = false;
let tenantScans = 0;

function cond(v: unknown, c: unknown): boolean {
  if (c === null || typeof c !== 'object' || c instanceof Date) {
    return c instanceof Date ? v instanceof Date && v.getTime() === c.getTime() : (v ?? null) === c;
  }
  const o = c as Row;
  const keys = Object.keys(o).filter((k) => k !== 'mode');
  return keys.every((k) => {
    if (k === 'not') return v !== o.not;
    if (k === 'in') return (o.in as unknown[]).includes(v);
    if (k === 'contains') {
      if (typeof v !== 'string') return false;
      return o.mode === 'insensitive' ? v.toLowerCase().includes(String(o.contains).toLowerCase()) : v.includes(String(o.contains));
    }
    throw new Error(`عامل غير مدعوم في المزيّف: ${k}`);
  });
}
function match(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, c]) => {
    if (k === 'AND') return (c as Row[]).every((w) => match(row, w));
    if (k === 'OR') return (c as Row[]).some((w) => match(row, w));
    return cond(row[k] ?? null, c);
  });
}
const pick = (row: Row, select?: Row) => (select ? Object.fromEntries(Object.keys(select).map((k) => [k, row[k]])) : { ...row });
const newContact = (data: Row): Row => ({
  id: `c${++seq}`, name: null, company: null, phone: null, email: null, country: null, message: null, origin: null, tenantId: null,
  stage: 'NEW', note: null, firstAt: new Date(), lastAt: new Date(), createdAt: new Date(), updatedAt: new Date(), ...data,
});

const prisma = {
  salesContact: {
    async findMany(a: { where?: Row; select?: Row; orderBy?: unknown; take?: number }) {
      // الترتيب بمفتاح orderBy الأول (firstAt «وقت التسجيل» في القائمة) ثم createdAt
      const k = ((Array.isArray(a.orderBy) ? Object.keys((a.orderBy[0] ?? {}) as Row)[0] : undefined) ?? 'lastAt') as 'firstAt' | 'lastAt';
      const rows = contacts.filter((r) => match(r, a.where)).sort((x, y) => y[k].getTime() - x[k].getTime() || y.createdAt.getTime() - x.createdAt.getTime());
      return rows.slice(0, a.take ?? rows.length).map((r) => pick(r, a.select));
    },
    async count(a: { where?: Row }) { return contacts.filter((r) => match(r, a.where)).length; },
    async groupBy(a: { by: string[]; where?: Row }) {
      const m = new Map<string, number>();
      for (const r of contacts.filter((x) => match(x, a.where))) m.set(r[a.by[0]], (m.get(r[a.by[0]]) ?? 0) + 1);
      return [...m].map(([k, n]) => ({ [a.by[0]]: k, _count: { _all: n } }));
    },
    async findUnique(a: { where: { id: string } }) { const r = contacts.find((x) => x.id === a.where.id); return r ? { ...r } : null; },
    async update(a: { where: { id: string }; data: Row }) {
      const r = contacts.find((x) => x.id === a.where.id);
      if (!r) throw new Error('Record to update not found.');
      Object.assign(r, a.data, { updatedAt: new Date() });
      return { ...r };
    },
    async create(a: { data: Row }) {
      if (contactCreateFails) throw new Error('Can\'t reach database server');
      const r = newContact(a.data); contacts.push(r); return { ...r };
    },
    async createMany(a: { data: Row[]; skipDuplicates?: boolean }) {
      let count = 0;
      for (const d of a.data) {
        if (contacts.some((x) => x.channel === d.channel && x.sourceRef === d.sourceRef)) {
          if (a.skipDuplicates) continue;
          throw new Error('Unique constraint failed');
        }
        contacts.push(newContact(d)); count++;
      }
      return { count };
    },
  },
  tenant: {
    async findMany(a: { where: Row }) {
      tenantScans++;
      // كل الشركات عدا شركة العرض المزروعة (pro + «الشركة التجريبية») — «فُتح من قبل المبيعات» (طلب المالك ١٦ نوفمبر ٢٠٢٦)
      assert.deepEqual(a.where, { NOT: { AND: [{ plan: 'pro' }, { name: 'الشركة التجريبية' }] } });
      return tenants.filter((t) => !(t.plan === 'pro' && t.name === 'الشركة التجريبية')).map((t) => ({
        id: t.id, name: t.name, createdAt: t.createdAt, plan: t.plan, settings: t.settings ?? null, admins: t.admins ?? [],
      }));
    },
  },
  tenantAttribution: {
    async findMany(a: { where: { tenantId: { in: string[] } } }) {
      return attributions.filter((x) => a.where.tenantId.in.includes(x.tenantId));
    },
  },
  superAdmin: { async findUnique(a: { where: { id: string } }) { return owners.get(a.where.id) ?? null; } },
  platformStaff: {
    async findUnique(a: { where: { id: string }; select?: Row }) { const s = staff.get(a.where.id); return s ? pick(s, a.select) : null; },
    async update() { return {}; },
  },
  platformAuditLog: {
    async create() { return { id: `au${++seq}` }; },
    async update() { return {}; },
  },
};
stub('config/database', { default: prisma });

// ─── البوت والبريد وخدمات العملاء المحتملين: بلا شبكة ───
let botCalls: string[] = [];
let botReply: { ok: true; body: unknown } | { ok: false; status: number; message: string } = { ok: true, body: { threads: [] } };
stub('services/waBotInbox', {
  fetchWaBot: async (p: string) => { botCalls.push(p); return botReply; },
  waBotConfigured: () => true,
});
const mails: string[] = [];
stub('services/mailer', { sendMail: async (o: { subject: string }) => { mails.push(o.subject); return true; }, mailLayout: () => '<p></p>' });
stub('middleware/rateLimits', { mailLimiter: (_q: unknown, _s: unknown, next: () => void) => next() });
stub('services/marketingMailer', { sendMarketingEmail: async () => undefined, marketingProvider: () => 'brevo' });
stub('services/whatsapp', {
  whatsappReady: () => false, waSignatureEnforced: () => true, waNumber: (p?: string | null) => (p ? p.replace(/\D/g, '') : ''),
  sendWhatsAppText: async () => 'x', sendWhatsAppTemplate: async () => 'x',
});
stub('services/whatsappCampaign', {
  getWaConfig: async () => ({}), saveWaConfig: async () => undefined, resolveWaParams: () => [], previewWaParams: () => [],
  waSentToday: async () => 0, waRemainingToday: async () => 0, WA_PARAMS: [],
});
stub('services/enrich', { enrichFromWebsite: async () => ({}), hunterDomainSearch: async () => ({}), hunterReady: () => false });
stub('services/leadSources', { runSearch: async () => [], qualifyLeads: async () => new Map(), providersReady: () => ({}) });
stub('services/apifyBudget', { getApifyBudget: async () => ({}), setApifyCap: async () => ({}), apifyReady: () => false });
stub('services/leadHunter', { getHuntConfig: async () => ({}), saveHuntConfig: async () => undefined, runAutoHuntBatch: async () => ({}), ARAB_COUNTRIES: [] });
stub('services/leadEmailer', { getEmailConfig: async () => ({}), saveEmailConfig: async () => undefined, runAutoEmailBatch: async () => ({}) });
stub('services/communityHunter', { getCommunityConfig: async () => ({}), saveCommunityConfig: async () => undefined, runCommunityHuntBatch: async () => ({}) });

/* eslint-disable @typescript-eslint/no-var-requires */
const si = require('../services/salesInbox') as typeof import('../services/salesInbox');
const pa = require('../services/platformAccess') as typeof import('../services/platformAccess');
const leadsRouter = (require('../routes/leads') as typeof import('../routes/leads')).default;
const contactRouter = (require('../routes/contact') as typeof import('../routes/contact')).default;
const { errorHandler } = require('../middleware/errorHandler') as typeof import('../middleware/errorHandler');
/* eslint-enable @typescript-eslint/no-var-requires */
type Db = Parameters<typeof si.syncTrials>[0];
const db = prisma as unknown as Db;

const app = express();
app.use(express.json());
app.use('/api/leads', leadsRouter);
app.use('/api/contact', contactRouter);
app.use(errorHandler);
let base = '';
const server = http.createServer(app);
const ready = new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; resolve(); }));
test.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

async function call(method: string, url: string, token?: string | null, body?: unknown) {
  await ready;
  const r = await fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Row };
}
const owner = () => jwt.sign({ id: 'o1', role: 'SUPER_ADMIN', name: 'المالك' }, SECRET, { expiresIn: '1h' });
function staffWith(...permissions: string[]): string {
  const id = `s${++seq}`;
  staff.set(id, { id, name: 'موظف', email: `${id}@x.co`, isActive: true, permissions, tokenVersion: 0, mustChangePassword: false });
  return pa.signStaffToken({ id, tokenVersion: 0 });
}

const D = (s: string) => new Date(s);
function reset() {
  contacts = []; attributions = []; staff.clear(); owners.clear(); owners.set('o1', { id: 'o1', isActive: true });
  contactCreateFails = false; tenantScans = 0; botCalls = []; mails.length = 0;
  botReply = { ok: true, body: { threads: [] } };
  tenants = [
    { id: 't-self', name: 'مؤسسة الذات', plan: 'trial', createdAt: D('2026-11-10T08:00:00Z'),
      settings: { phone: '0501111111', countryCode: 'SA' }, admins: [{ name: 'سالم', email: 'salem@self.sa' }] },
    { id: 't-code', name: 'شركة الكود', plan: 'trial', createdAt: D('2026-11-11T08:00:00Z'),
      settings: { phone: '0502222222', countryCode: 'SA' }, admins: [{ name: 'خالد', email: 'k@code.sa' }] },
    { id: 't-portal', name: 'شركة البوابة', plan: 'trial', createdAt: D('2026-11-12T08:00:00Z'),
      settings: { phone: '0503333333', countryCode: 'AE' }, admins: [{ name: 'منى', email: 'm@portal.ae' }] },
    { id: 't-paid', name: 'مشترك', plan: 'pro', createdAt: D('2026-01-01T08:00:00Z') },
    { id: 't-seed', name: 'الشركة التجريبية', plan: 'pro', createdAt: D('2025-12-01T08:00:00Z') },
  ];
  attributions = [
    { tenantId: 't-code', source: 'signup_code', codeUsed: 'AB2CD3EF', affiliate: { fullName: 'سفير الكود', code: 'AB2CD3EF' } },
    { tenantId: 't-portal', source: 'portal', codeUsed: null, affiliate: { fullName: 'نورة السفيرة', code: 'ZZ9YY8XX' } },
  ];
  si.resetSalesSyncThrottle();
}
const thread = (o: Row): Row => ({ phone: '966512345678', name: 'عميل واتساب', stage: 'INTERESTED', stageAr: 'مهتم', lastAt: '2026-11-15T10:00:00.000Z', lastBody: 'كم السعر؟', lastFrom: 'العميل', ...o });

// ═══════════════════ الترجمة: كل مصدرٍ إلى صفّه ═══════════════════

test('التجربة: الذاتية «الموقع — التسجيل التجريبي»، وبكود سفير يُذكر الكود، و«فتحها سفير» قناة AMBASSADOR_TRIAL باسمه', () => {
  const t = { id: 't1', name: ' شركة النور ', createdAt: D('2026-11-01T00:00:00Z') };
  const admin = { name: 'أحمد', email: 'a@nour.sa' };
  const settings = { phone: '0500000000', countryCode: 'SA' };
  const self = si.trialFields({ tenant: t, admin, settings, attribution: null });
  assert.equal(self.channel, 'TRIAL');
  assert.equal(self.origin, 'الموقع — التسجيل التجريبي');
  assert.deepEqual(
    [self.sourceRef, self.tenantId, self.name, self.company, self.email, self.phone, self.country],
    ['t1', 't1', 'أحمد', 'شركة النور', 'a@nour.sa', '0500000000', 'SA'],
  );
  assert.equal(self.firstAt.getTime(), t.createdAt.getTime());
  assert.equal(self.lastAt.getTime(), t.createdAt.getTime());
  assert.equal(self.message, null);

  const coded = si.trialFields({ tenant: t, admin, settings, attribution: { source: 'signup_code', codeUsed: 'AB2CD3EF', affiliate: { fullName: 'س', code: 'AB2CD3EF' } } });
  assert.equal(coded.channel, 'TRIAL');
  assert.equal(coded.origin, 'الموقع — التسجيل التجريبي · كود سفير AB2CD3EF');

  const portal = si.trialFields({ tenant: t, admin, settings, attribution: { source: 'portal', codeUsed: null, affiliate: { fullName: 'نورة', code: 'ZZ9YY8XX' } } });
  assert.equal(portal.channel, 'AMBASSADOR_TRIAL');
  assert.equal(portal.origin, 'سفير: نورة');
  const portalNoName = si.trialFields({ tenant: t, admin, settings, attribution: { source: 'portal', codeUsed: null, affiliate: { fullName: '  ', code: 'ZZ9YY8XX' } } });
  assert.equal(portalNoName.origin, 'سفير: ZZ9YY8XX', 'بلا اسم ⇒ الكود');

  // إسنادٌ لاحق بمطالبة أو من المالك: التسجيل نفسه ذاتي — بلا كود في «من أين أتى»
  for (const source of ['claim', 'owner']) {
    const f = si.trialFields({ tenant: t, admin, settings, attribution: { source, codeUsed: null, affiliate: { fullName: 'س', code: 'X' } } });
    assert.deepEqual([f.channel, f.origin], ['TRIAL', 'الموقع — التسجيل التجريبي'], source);
  }
  const bare = si.trialFields({ tenant: t, admin: null, settings: null, attribution: null });
  assert.deepEqual([bare.name, bare.email, bare.phone, bare.country], [null, null, null, null]);
});

test('واتساب: الرقم أرقاماً مرجعاً و+ للعرض، وآخر رسالة ≤ ٣٠٠، و«من أين أتى» بمرحلة البوت — وما لا رقم له أو لا تاريخ يُهمل', () => {
  const f = si.whatsappFields(thread({ phone: '+966 51-234-5678', lastBody: 'س'.repeat(500) }))!;
  assert.equal(f.channel, 'WHATSAPP');
  assert.equal(f.sourceRef, '966512345678');
  assert.equal(f.phone, '+966512345678');
  assert.equal(f.name, 'عميل واتساب');
  assert.equal(f.message!.length, 300);
  assert.equal(f.origin, 'واتساب — بوت المبيعات · مهتم');
  assert.equal(f.lastAt.toISOString(), '2026-11-15T10:00:00.000Z');
  assert.equal(f.firstAt.getTime(), f.lastAt.getTime(), 'firstAt عند الإنشاء = lastAt');
  assert.deepEqual([f.company, f.email, f.country, f.tenantId], [null, null, null, null]);
  assert.equal(si.whatsappFields(thread({ stageAr: '' }))!.origin, 'واتساب — بوت المبيعات');
  assert.equal(si.whatsappFields(thread({ name: null }))!.name, null);
  assert.equal(si.whatsappFields(thread({ phone: '' })), null);
  assert.equal(si.whatsappFields(thread({ lastAt: 'x' })), null);
  assert.equal(si.whatsappFields(null), null);
});

test('النماذج: «من أين أتى» لكل نموذج، ومرجعٌ فريد لكل إرسال، والنصوص مقصوصة', () => {
  assert.deepEqual(si.FORM_ORIGIN, {
    CONTACT: 'الموقع — نموذج تواصل معنا', SUBSCRIPTION: 'الموقع — طلب اشتراك', QUOTE_REQUEST: 'الموقع — طلب عرض سعر', MEETING: 'الموقع — احجز اجتماع',
  });
  const a = si.formFields({ channel: 'CONTACT', name: ' ريم ', email: 'r@x.co', message: 'م'.repeat(3000) });
  const b = si.formFields({ channel: 'CONTACT', name: 'ريم' });
  assert.notEqual(a.sourceRef, b.sourceRef);
  assert.equal(a.name, 'ريم');
  assert.equal(a.message!.length, 2000);
  assert.equal(a.origin, 'الموقع — نموذج تواصل معنا');
  assert.equal(a.firstAt.getTime(), a.lastAt.getTime());
});

// ═══════════════════ المرحلة والملاحظة للبشر وحدهم ═══════════════════

test('syncPatch: لا stage ولا note ولا firstAt أبداً، ولا كتابة بلا تغيير', () => {
  const next = si.trialFields({ tenant: { id: 't1', name: 'جديد', createdAt: D('2026-11-01T00:00:00Z') }, admin: null, settings: null, attribution: null });
  const cur = {
    id: 'c1', channel: 'TRIAL', sourceRef: 't1', name: null, company: 'قديم', phone: null, email: null, country: null, message: null,
    origin: 'الموقع — التسجيل التجريبي', tenantId: 't1', lastAt: D('2026-11-01T00:00:00Z'),
    stage: 'WON', note: 'دفع', firstAt: D('2020-01-01T00:00:00Z'),
  };
  assert.deepEqual(si.syncPatch(cur, next), { company: 'جديد' });
  assert.equal(si.syncPatch({ ...cur, company: 'جديد' }, next), null, 'بلا تغيير ⇒ لا كتابة');
  const moved = si.syncPatch({ ...cur, company: 'جديد', channel: 'AMBASSADOR_TRIAL', lastAt: D('2026-10-01T00:00:00Z') }, next)!;
  assert.deepEqual(Object.keys(moved).sort(), ['channel', 'lastAt']);
  // أيّاً كانت الفروق — المفاتيح الممنوعة لا تظهر
  const all = si.syncPatch({ ...cur, name: 'x', phone: 'x', email: 'x', country: 'x', message: 'x', origin: 'x', tenantId: 'x', company: 'x' }, next)!;
  for (const k of ['stage', 'note', 'firstAt', 'id', 'sourceRef', 'createdAt']) assert.equal(k in all, false, k);
});

test('مزامنة الشركات: التجريبية، وغيرها «فُتح من قبل المبيعات» عدا شركة العرض، وإعادة المزامنة لا تمسّ المرحلة والملاحظة وfirstAt', async () => {
  reset();
  assert.deepEqual(await si.syncTrials(db), { created: 4, updated: 0 });
  const by = (ref: string) => contacts.find((c) => c.sourceRef === ref)!;
  assert.deepEqual([by('t-paid').channel, by('t-paid').origin, by('t-paid').company], ['SALES_CREATED', 'فُتح من قبل المبيعات', 'مشترك'], 'فتحه المالك من اللوحة');
  assert.equal(by('t-paid').firstAt.getTime(), D('2026-01-01T08:00:00Z').getTime(), 'وقت التسجيل = إنشاء الشركة');
  assert.equal(by('t-seed'), undefined, 'شركة العرض المزروعة ليست عميلاً');
  assert.deepEqual([by('t-self').channel, by('t-self').origin], ['TRIAL', 'الموقع — التسجيل التجريبي']);
  assert.deepEqual([by('t-code').channel, by('t-code').origin], ['TRIAL', 'الموقع — التسجيل التجريبي · كود سفير AB2CD3EF']);
  assert.deepEqual([by('t-portal').channel, by('t-portal').origin], ['AMBASSADOR_TRIAL', 'سفير: نورة السفيرة']);
  assert.deepEqual([by('t-portal').name, by('t-portal').email, by('t-portal').phone, by('t-portal').country], ['منى', 'm@portal.ae', '0503333333', 'AE']);

  Object.assign(by('t-self'), { stage: 'NEGOTIATION', note: 'اتصلت به', firstAt: D('2026-11-10T08:00:00Z') });
  tenants[0].name = 'مؤسسة الذات المحدودة';
  tenants[0].admins = [{ name: 'سالم العلي', email: 'salem@self.sa' }];
  assert.deepEqual(await si.syncTrials(db), { created: 0, updated: 1 });
  assert.deepEqual(
    [by('t-self').company, by('t-self').name, by('t-self').stage, by('t-self').note],
    ['مؤسسة الذات المحدودة', 'سالم العلي', 'NEGOTIATION', 'اتصلت به'],
  );
  assert.equal(contacts.length, 4, 'لا تكرار');
  assert.deepEqual(await si.syncTrials(db), { created: 0, updated: 0 }, 'بلا تغيير ⇒ لا كتابة');
});

test('مزامنة واتساب: تُنشئ وتحدّث آخر رسالة وتاريخها بلا مسّ المرحلة والملاحظة، وتعذّر البوت يُبقي الصفوف', async () => {
  reset();
  botReply = { ok: true, body: { threads: [thread({}), thread({ phone: '201000000001', name: null, stageAr: 'جديد', lastAt: '2026-11-14T09:00:00.000Z' }), thread({ phone: '' })] } };
  assert.deepEqual(await si.syncWhatsapp(db), { ok: true, included: true });
  assert.deepEqual(botCalls, ['/inbox/threads?limit=500']);
  assert.equal(contacts.length, 2);
  const w = contacts.find((c) => c.sourceRef === '966512345678')!;
  Object.assign(w, { stage: 'MEETING', note: 'موعد الأحد' });
  const firstAt = w.firstAt.getTime();

  botReply = { ok: true, body: { threads: [thread({ lastAt: '2026-11-16T07:00:00.000Z', lastBody: 'متى الاجتماع؟', stageAr: 'ساخن' })] } };
  assert.equal((await si.syncWhatsapp(db)).ok, true);
  assert.deepEqual(
    [w.message, w.lastAt.toISOString(), w.origin, w.stage, w.note, w.firstAt.getTime()],
    ['متى الاجتماع؟', '2026-11-16T07:00:00.000Z', 'واتساب — بوت المبيعات · ساخن', 'MEETING', 'موعد الأحد', firstAt],
  );

  botReply = { ok: false, status: 504, message: 'نائم' };
  assert.deepEqual(await si.syncWhatsapp(db), { ok: false, included: true, error: 'نائم' });
  assert.equal(contacts.length, 2, 'الصفوف القائمة باقية');
  botReply = { ok: true, body: { nope: 1 } };
  assert.equal((await si.syncWhatsapp(db)).ok, false, 'ردّ بلا قائمة');
});

test('الخنق: مرّة في الدقيقة لكل عملية، وواتساب لمن يُدرَج وحده، والمتعذّر يُعاد بعد ٢٠ث', async () => {
  reset();
  const t0 = 1_000_000;
  const a = await si.syncSalesInbox({ includeWhatsapp: false, db, now: t0 });
  assert.deepEqual(a.whatsapp, { ok: true, included: false });
  assert.deepEqual([tenantScans, botCalls.length], [1, 0], 'بلا صلاحية واتساب ⇒ لا نداء للبوت');

  await si.syncSalesInbox({ includeWhatsapp: true, db, now: t0 + 1000 });
  assert.deepEqual([tenantScans, botCalls.length], [1, 1], 'التجارب مخنوقة، وواتساب أول مرّة');
  await si.syncSalesInbox({ includeWhatsapp: true, db, now: t0 + 30_000 });
  assert.deepEqual([tenantScans, botCalls.length], [1, 1]);
  await si.syncSalesInbox({ includeWhatsapp: true, db, now: t0 + 61_500 });
  assert.deepEqual([tenantScans, botCalls.length], [2, 2], 'بعد الدقيقة');

  botReply = { ok: false, status: 504, message: 'نائم' };
  const t1 = t0 + 200_000;
  assert.deepEqual((await si.syncSalesInbox({ includeWhatsapp: true, db, now: t1 })).whatsapp, { ok: false, included: true, error: 'نائم' });
  botReply = { ok: true, body: { threads: [] } };
  assert.equal((await si.syncSalesInbox({ includeWhatsapp: true, db, now: t1 + 10_000 })).whatsapp.ok, false, 'آخر حالة ضمن نافذة الإعادة');
  assert.equal(botCalls.length, 3);
  assert.equal((await si.syncSalesInbox({ includeWhatsapp: true, db, now: t1 + 21_000 })).whatsapp.ok, true, 'يُعاد بعد ٢٠ث');
  assert.equal(botCalls.length, 4);
});

test('تعذّر المزامنة لا يرمي: القاعدة المعطّلة تُسجَّل وتعود الحالة', async () => {
  reset();
  let tried = 0;
  const broken = { ...prisma, tenant: { async findMany() { tried++; throw new Error('db down'); } } } as unknown as Db;
  const r = await si.syncSalesInbox({ includeWhatsapp: false, db: broken, now: 5 });
  assert.deepEqual(r.whatsapp, { ok: true, included: false });
  assert.equal(tried, 1, 'حاولت أول مرّة ولو كانت الساعة صغيرة');
  assert.ok(r.syncedAt instanceof Date);
});

// ═══════════════════ التعديل والمعاملات ═══════════════════

test('salesUpdateSchema: المراحل السبع وحدها، والملاحظة ≤ ٢٠٠٠ والفارغة تُمسح', () => {
  assert.deepEqual([...si.SALES_STAGES], ['NEW', 'CONTACTED', 'MEETING', 'NEGOTIATION', 'WON', 'LOST', 'NOT_FIT']);
  for (const stage of si.SALES_STAGES) assert.equal(si.salesUpdateSchema.safeParse({ stage }).success, true, stage);
  for (const stage of ['QUALIFIED', 'won', '', 7, null]) assert.equal(si.salesUpdateSchema.safeParse({ stage }).success, false, String(stage));
  assert.equal(si.salesUpdateSchema.safeParse({ note: 'x'.repeat(2001) }).success, false);
  assert.deepEqual(si.salesUpdateSchema.parse({ note: '  تابع غداً ' }), { note: 'تابع غداً' });
  assert.deepEqual(si.salesUpdateSchema.parse({ note: '   ' }), { note: null });
  assert.deepEqual(si.salesUpdateSchema.parse({ note: null }), { note: null });
  assert.equal('note' in si.salesUpdateSchema.parse({ stage: 'WON' }) && si.salesUpdateSchema.parse({ stage: 'WON' }).note !== undefined, false, 'غياب الملاحظة لا يمسحها');
});

test('parseSalesListQuery وbuildSalesWhere: الحدّ ٣٠٠ افتراضاً و١٠٠٠ أقصى، والمجهول يُهمل، وواتساب خارج النطاق لمن لا يملكه', () => {
  assert.deepEqual(si.parseSalesListQuery({}), { limit: 300 });
  assert.equal(si.parseSalesListQuery({ limit: '5000' }).limit, 1000);
  assert.equal(si.parseSalesListQuery({ limit: 'x' }).limit, 300);
  assert.deepEqual(si.parseSalesListQuery({ channel: 'TRIAL', stage: 'WON', q: ' سالم ' }), { limit: 300, channel: 'TRIAL', stage: 'WON', q: 'سالم' });
  assert.deepEqual(si.parseSalesListQuery({ channel: 'invoice-tool', stage: { not: 'x' }, q: { contains: 'x' } }), { limit: 300 }, 'نصوص فقط');
  assert.deepEqual(si.buildSalesWhere({}, true), {});
  assert.deepEqual(si.buildSalesWhere({}, false), { AND: [{ channel: { not: 'WHATSAPP' } }] });
  const w = si.buildSalesWhere({ channel: 'WHATSAPP' }, false) as Row;
  assert.equal(match({ channel: 'WHATSAPP' }, w), false, 'طلب واتساب صراحةً بلا صلاحية ⇒ لا شيء');
  const q = si.buildSalesWhere({ q: '0501111111' }, true) as Row;
  assert.equal(match({ phone: '+966501111111' }, q), true, 'الجوال المحلي يطابق الدولي');
  assert.equal(match({ origin: 'الموقع — احجز اجتماع' }, si.buildSalesWhere({ q: 'اجتماع' }, true) as Row), true);
  assert.equal(match({ email: 'Salem@Self.sa' }, si.buildSalesWhere({ q: 'salem@' }, true) as Row), true, 'بلا حساسية حالة');
});

// ═══════════════════ المسارات خلف الحارس ═══════════════════

test('القواعد: sales.view للقائمة والتعديل (لا leads.view عبر /:id)، وسجل عروض الأسعار للمالك وحده', () => {
  assert.equal(pa.ruleFor('GET', '/api/leads/sales-inbox')?.key, 'sales.view');
  assert.equal(pa.ruleFor('PUT', '/api/leads/sales-inbox/c1')?.key, 'sales.view');
  assert.equal(pa.ruleFor('GET', pa.requestPath({ baseUrl: '/api/leads', path: '/Sales-Inbox/' }))?.key, 'sales.view');
  assert.equal(pa.ruleFor('GET', '/api/quotes/admin'), null);
  assert.equal(pa.ruleFor('DELETE', '/api/quotes/admin/q1'), null);
  const keys = pa.STAFF_PERMISSIONS.map((p) => p.key) as string[];
  assert.ok(keys.includes('sales.view'));
  assert.equal(keys.some((k) => k.startsWith('quotes.')), false);
  assert.deepEqual(pa.STAFF_PERMISSIONS.find((p) => p.key === 'sales.view'), { key: 'sales.view', group: 'إدارة المبيعات', label: 'إدارة المبيعات' });
});

test('GET /sales-inbox: المالك يرى كل القنوات وواتساب، والموظف بـsales.view وحدها بلا واتساب ولا نداء للبوت، وغيره ٤٠٣', async () => {
  reset();
  botReply = { ok: true, body: { threads: [thread({})] } };
  contacts.push(newContact({ channel: 'MEETING', sourceRef: 'f1', name: 'طالب اجتماع', phone: '+966500000009', origin: 'الموقع — احجز اجتماع', firstAt: D('2026-11-13T00:00:00Z'), lastAt: D('2026-11-13T00:00:00Z') }));

  const o = await call('GET', '/api/leads/sales-inbox', owner());
  assert.equal(o.status, 200);
  const d = o.body.data;
  assert.deepEqual(d.whatsapp, { ok: true, included: true });
  assert.equal(typeof d.syncedAt, 'string');
  assert.deepEqual(d.rows.map((r: Row) => r.channel), ['WHATSAPP', 'MEETING', 'AMBASSADOR_TRIAL', 'TRIAL', 'TRIAL', 'SALES_CREATED'], 'الأحدث تسجيلاً أولاً');
  assert.equal(d.total, 6);
  assert.deepEqual(d.counts.byChannel, { TRIAL: 2, AMBASSADOR_TRIAL: 1, SALES_CREATED: 1, MEETING: 1, CONTACT: 0, SUBSCRIPTION: 0, QUOTE_REQUEST: 0, WHATSAPP: 1 });
  assert.deepEqual(d.counts.byStage, { NEW: 6, CONTACTED: 0, MEETING: 0, NEGOTIATION: 0, WON: 0, LOST: 0, NOT_FIT: 0 });
  assert.deepEqual(Object.keys(d.rows[0]).sort(), ['channel', 'company', 'country', 'email', 'firstAt', 'id', 'lastAt', 'message', 'name', 'note', 'origin', 'phone', 'stage', 'tenantId'].sort());

  // المرشّح يضيّق الصفوف والعدّادات على الكل
  const f = (await call('GET', '/api/leads/sales-inbox?channel=TRIAL&limit=1', owner())).body.data;
  assert.deepEqual([f.rows.length, f.total, f.counts.byChannel.MEETING], [1, 2, 1]);

  si.resetSalesSyncThrottle();
  const calls = botCalls.length;
  const s = await call('GET', '/api/leads/sales-inbox', staffWith('sales.view'));
  assert.equal(s.status, 200);
  assert.deepEqual(s.body.data.whatsapp, { ok: true, included: false });
  assert.equal(s.body.data.rows.some((r: Row) => r.channel === 'WHATSAPP'), false);
  assert.equal(s.body.data.counts.byChannel.WHATSAPP, 0);
  assert.equal(s.body.data.total, 5, 'الشركات الأربع (ومنها «فُتح من قبل المبيعات») والاجتماع — بلا واتساب');
  assert.equal(botCalls.length, calls, 'لا نداء للبوت');
  assert.equal((await call('GET', '/api/leads/sales-inbox?channel=WHATSAPP', staffWith('sales.view'))).body.data.rows.length, 0);

  const sw = await call('GET', '/api/leads/sales-inbox', staffWith('sales.view', 'waInbox.view'));
  assert.equal(sw.body.data.whatsapp.included, true);
  assert.equal(sw.body.data.counts.byChannel.WHATSAPP, 1);

  for (const t of [staffWith('leads.view'), staffWith('waInbox.view')]) {
    assert.equal((await call('GET', '/api/leads/sales-inbox', t)).status, 403);
  }
  assert.equal((await call('GET', '/api/leads/sales-inbox')).status, 401);
});

test('GET /sales-inbox: البوت المتعذّر ⇒ whatsapp.ok=false بالعربية والقائمة تعود', async () => {
  reset();
  botReply = { ok: false, status: 504, message: 'بوت واتساب لم يستجب' };
  const r = await call('GET', '/api/leads/sales-inbox', owner());
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data.whatsapp, { ok: false, included: true, error: 'بوت واتساب لم يستجب' });
  assert.equal(r.body.data.rows.length, 4, 'الشركات الأربع ومنها «فُتح من قبل المبيعات»');
});

test('PUT /sales-inbox/:id: المرحلة والملاحظة، ٤٠٠ لمرحلة مجهولة، ٤٠٤ لمجهول ولصفّ واتساب بلا صلاحيته — والمزامنة بعدها لا تمسّهما', async () => {
  reset();
  botReply = { ok: true, body: { threads: [thread({})] } };
  await call('GET', '/api/leads/sales-inbox', owner());
  const trial = contacts.find((c) => c.sourceRef === 't-self')!;
  const wa = contacts.find((c) => c.channel === 'WHATSAPP')!;
  const t = staffWith('sales.view');

  assert.equal((await call('PUT', `/api/leads/sales-inbox/${trial.id}`, t, { stage: 'QUALIFIED' })).status, 400);
  assert.equal((await call('PUT', `/api/leads/sales-inbox/${trial.id}`, t, { note: 'x'.repeat(2001) })).status, 400);
  assert.equal((await call('PUT', '/api/leads/sales-inbox/nope', t, { stage: 'WON' })).status, 404);
  assert.equal((await call('PUT', `/api/leads/sales-inbox/${wa.id}`, t, { stage: 'WON' })).status, 404, 'صفّ واتساب كأنه غير موجود');
  assert.equal(wa.stage, 'NEW');
  assert.equal((await call('PUT', `/api/leads/sales-inbox/${trial.id}`, staffWith('leads.edit'), { stage: 'WON' })).status, 403);

  const ok = await call('PUT', `/api/leads/sales-inbox/${trial.id}`, t, { stage: 'CONTACTED', note: '  اتصلت به ' });
  assert.equal(ok.status, 200);
  assert.deepEqual([ok.body.data.stage, ok.body.data.note, ok.body.data.id], ['CONTACTED', 'اتصلت به', trial.id]);
  assert.equal((await call('PUT', `/api/leads/sales-inbox/${wa.id}`, owner(), { stage: 'MEETING' })).body.data.stage, 'MEETING');

  // مزامنةٌ لاحقة بتغيّر الوصف: المرحلة والملاحظة كما وضعهما البشر
  tenants[0].name = 'اسم جديد';
  botReply = { ok: true, body: { threads: [thread({ lastBody: 'جديد', lastAt: '2026-11-16T09:00:00.000Z' })] } };
  si.resetSalesSyncThrottle();
  await call('GET', '/api/leads/sales-inbox', owner());
  assert.deepEqual([trial.company, trial.stage, trial.note], ['اسم جديد', 'CONTACTED', 'اتصلت به']);
  assert.deepEqual([wa.message, wa.stage], ['جديد', 'MEETING']);

  const cleared = await call('PUT', `/api/leads/sales-inbox/${trial.id}`, t, { note: '' });
  assert.deepEqual([cleared.body.data.note, cleared.body.data.stage], [null, 'CONTACTED']);
});

// ═══════════════════ نماذج الموقع ═══════════════════

test('النماذج الثلاثة تسجّل في «إدارة المبيعات» بقناتها ومصدرها، والبريد يصل كما كان', async () => {
  reset();
  const c = await call('POST', '/api/contact', null, { name: 'ريم', email: 'reem@x.co', phone: '0555', message: 'أريد عرضاً' });
  assert.equal(c.status, 200);
  const sub = await call('POST', '/api/contact/subscription', null, {
    companyName: 'شركة الغد', contactName: 'فهد', email: 'f@ghad.sa', phone: '0566666666', country: 'السعودية', city: 'جدة', repsCount: '12', notes: 'نحتاج تتبع',
  });
  assert.equal(sub.status, 200);
  const quote = await call('POST', '/api/contact/subscription', null, {
    companyName: 'شركة العرض', contactName: 'هند', email: 'h@q.sa', phone: '0577777777', country: 'السعودية', kind: 'quote',
  });
  assert.equal(quote.status, 200);
  const meet = await call('POST', '/api/contact/meeting', null, { name: 'ماجد', phone: '+966588888888', country: 'SA', lang: 'en' });
  assert.equal(meet.status, 200);
  assert.equal(mails.length, 4);

  const got = contacts.map((x) => [x.channel, x.origin, x.name, x.company, x.phone, x.email, x.country]);
  assert.deepEqual(got, [
    ['CONTACT', 'الموقع — نموذج تواصل معنا', 'ريم', null, '0555', 'reem@x.co', null],
    ['SUBSCRIPTION', 'الموقع — طلب اشتراك', 'فهد', 'شركة الغد', '0566666666', 'f@ghad.sa', 'السعودية'],
    ['QUOTE_REQUEST', 'الموقع — طلب عرض سعر', 'هند', 'شركة العرض', '0577777777', 'h@q.sa', 'السعودية'],
    ['MEETING', 'الموقع — احجز اجتماع', 'ماجد', null, '+966588888888', null, 'SA'],
  ]);
  assert.equal(contacts[0].message, 'أريد عرضاً');
  assert.equal(contacts[1].message, 'نحتاج تتبع · المدينة: جدة · عدد المناديب المتوقع: 12');
  assert.equal(contacts[2].message, null);
  assert.match(contacts[3].message, /^لغة الصفحة: /);
  assert.equal(new Set(contacts.map((x) => x.sourceRef)).size, 4, 'مرجعٌ لكل إرسال');
  assert.ok(contacts.every((x) => x.stage === 'NEW'));
});

test('تعذّر القاعدة لا يمنع البريد: النماذج الثلاثة تردّ كما كانت', async () => {
  reset();
  contactCreateFails = true;
  assert.equal(await si.recordInboundContact({ channel: 'CONTACT', name: 'x' }, db), false, 'لا يرمي');
  assert.equal((await call('POST', '/api/contact', null, { name: 'ريم', email: 'reem@x.co', message: 'مرحبا' })).status, 200);
  assert.equal((await call('POST', '/api/contact/subscription', null, {
    companyName: 'ش', contactName: 'ف', email: 'f@x.sa', phone: '0566666666', country: 'السعودية',
  })).status, 200);
  assert.equal((await call('POST', '/api/contact/meeting', null, { name: 'ماجد', phone: '+966588888888' })).status, 200);
  assert.equal(mails.length, 3);
  assert.equal(contacts.length, 0);
});

test('المصدر: التسجيل قبل sendMail داخل try/catch في كل نموذج، ومسارا الصفحة قبل /:id', () => {
  const contact = read('routes', 'contact.ts');
  const parts = [
    contact.slice(contact.indexOf("router.post('/',"), contact.indexOf("router.post('/subscription'")),
    contact.slice(contact.indexOf("router.post('/subscription'"), contact.indexOf("router.post('/meeting'")),
    contact.slice(contact.indexOf("router.post('/meeting'")),
  ];
  for (const p of parts) {
    const rec = p.indexOf('await recordInboundContact(');
    const mail = p.indexOf('await sendMail(');
    assert.ok(rec > 0 && mail > rec, 'التسجيل قبل البريد');
    const before = p.slice(0, rec);
    assert.ok(/try \{\s*$/.test(before), 'داخل try');
    assert.match(p.slice(rec, mail), /\} catch \(e\) \{ console\.error\(/, 'وcatch يكتفي بالسجلّ');
  }
  const svc = read('services', 'salesInbox.ts');
  const fn = svc.slice(svc.indexOf('export async function recordInboundContact'));
  assert.match(fn.slice(0, fn.indexOf('\n}\n')), /try \{[\s\S]*\} catch \(e\) \{[\s\S]*return false;/);

  const leads = read('routes', 'leads.ts');
  const id = leads.indexOf("router.get('/:id'");
  assert.ok(leads.indexOf("router.get('/sales-inbox'") > 0 && leads.indexOf("router.get('/sales-inbox'") < id);
  assert.ok(leads.indexOf("router.put('/sales-inbox/:id'") > 0 && leads.indexOf("router.put('/sales-inbox/:id'") < leads.indexOf("router.put('/:id'"));
  assert.equal((leads.match(/staffHas\(req, 'waInbox\.view'\)/g) ?? []).length, 2, 'القائمة والتعديل');
  // مولد الفواتير مستثنى بقرار المالك: لا قناة له
  assert.equal((si.SALES_CHANNELS as readonly string[]).some((c) => /invoice|tool/i.test(c)), false);
  assert.doesNotMatch(svc, /invoice-tool/);
});

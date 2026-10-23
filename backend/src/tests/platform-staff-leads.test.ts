// «موظفو المنصة» — عزل «عملاء مولد الفواتير» (source='invoice-tool') عمّن لا يملك invoiceTool.view. المراجعة الأمنية وجدت:
// (أ) ?source[equals]=invoice-tool كائنُ qs يصل Prisma مرشّحاً فيتخطّى المقارنة النصية، (ب) التعديل والحذف والمتابعة والتحويل بالمعرّف
// بلا فحص مصدر، (ج) الساخنون وتوزيع الدول في غرفة التسويق، (د) الإرسال والإثراء بالمعرّفات أو بمرشّح المصدر ومعاينة جسر واتساب ومحادثته.
// نثبت فوق Prisma مزيّف في الذاكرة (بلا قاعدة) بالموجّهين الحقيقيين خلف platformGate: الموظف لا يصلهم بأي طريق، والمالك كما كان.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import jwt from 'jsonwebtoken';
import express from 'express';

process.env.JWT_SECRET = 'platform-staff-leads-test-secret';
delete process.env.STAFF_JWT_SECRET;
const SECRET = process.env.JWT_SECRET;
const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

// ─── Prisma مزيّف: مطابِقُ مرشّحاتٍ يرفض ما لا يعرفه (كما يرفض Prisma عاملاً مجهولاً) ───
type Row = Record<string, unknown>;
const TOOL = 'invoice-tool';
let leads: Row[] = [];
let activities: Row[] = [];
let messages: Row[] = [];
const staff = new Map<string, Row>();
const owners = new Map<string, { id: string; isActive: boolean }>();
let audits: Row[] = [];
let seq = 0;
const wheres: { model: string; op: string; where: unknown }[] = [];

const same = (a: unknown, b: unknown) => (a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b);
function matchScalar(v: unknown, f: unknown): boolean {
  if (f === null) return v === null || v === undefined;
  if (typeof f !== 'object' || f instanceof Date) return same(v, f);
  const o = f as Row;
  const ci = o.mode === 'insensitive';
  for (const [k, x] of Object.entries(o)) {
    if (x === undefined || k === 'mode') continue;
    let ok: boolean;
    switch (k) {
      case 'equals': ok = matchScalar(v, x); break;
      case 'not': ok = !matchScalar(v, x) && !(x !== null && (v === null || v === undefined)); break; // SQL: NULL <> x ليس صحيحاً
      case 'in': ok = (x as unknown[]).some((y) => same(v, y)); break;
      case 'notIn': ok = !(x as unknown[]).some((y) => same(v, y)); break;
      case 'lte': ok = v != null && (v as number) <= (x as number); break;
      case 'contains': ok = typeof v === 'string' && (ci ? v.toLowerCase().includes(String(x).toLowerCase()) : v.includes(String(x))); break;
      default: throw new Error(`مرشّح غير مدعوم في المزيّف: ${k}`);
    }
    if (!ok) return false;
  }
  return true;
}
function matchWhere(row: Row, where: unknown): boolean {
  if (!where) return true;
  for (const [k, f] of Object.entries(where as Row)) {
    if (f === undefined) continue;
    if (k === 'AND') { if (!(Array.isArray(f) ? f : [f]).every((w) => matchWhere(row, w))) return false; continue; }
    if (k === 'OR') { if (!(f as unknown[]).some((w) => matchWhere(row, w))) return false; continue; }
    if (k === 'NOT') { if ((Array.isArray(f) ? f : [f]).some((w) => matchWhere(row, w))) return false; continue; }
    if (k === 'activities' || k === 'waMessages') {
      const kids = (k === 'activities' ? activities : messages).filter((c) => c.leadId === row.id);
      const rel = f as { some?: Row; none?: Row };
      if (rel.some && !kids.some((c) => matchWhere(c, rel.some))) return false;
      if (rel.none && kids.some((c) => matchWhere(c, rel.none))) return false;
      continue;
    }
    if (!matchScalar(row[k], f)) return false;
  }
  return true;
}
const pick = (row: Row | undefined | null, select?: Row): Row | null => {
  if (!row) return null;
  if (!select) return { ...row };
  const o: Row = {};
  for (const k of Object.keys(select)) o[k] = row[k];
  return o;
};
function table(name: string, rows: () => Row[], setRows: (r: Row[]) => void) {
  const log = (op: string, where: unknown) => { wheres.push({ model: name, op, where }); };
  return {
    async findMany(a: { where?: Row; take?: number; skip?: number; select?: Row } = {}) {
      log('findMany', a.where);
      const out = rows().filter((r) => matchWhere(r, a.where)).slice(a.skip ?? 0);
      return out.slice(0, a.take ?? out.length).map((r) => pick(r, a.select));
    },
    async findFirst(a: { where?: Row; select?: Row } = {}) { log('findFirst', a.where); return pick(rows().find((r) => matchWhere(r, a.where)), a.select); },
    async findUnique(a: { where: { id: string }; select?: Row }) { return pick(rows().find((r) => r.id === a.where.id), a.select); },
    async count(a: { where?: Row } = {}) { log('count', a.where); return rows().filter((r) => matchWhere(r, a.where)).length; },
    async groupBy(a: { by: string[]; where?: Row }) {
      log('groupBy', a.where);
      const m = new Map<unknown, number>();
      for (const r of rows().filter((x) => matchWhere(x, a.where))) m.set(r[a.by[0]], (m.get(r[a.by[0]]) ?? 0) + 1);
      return [...m].map(([v, n]) => ({ [a.by[0]]: v, _count: { _all: n } }));
    },
    async create(a: { data: Row }) { const row = { id: `${name[0]}${++seq}`, createdAt: new Date(), ...a.data }; rows().push(row); return { ...row }; },
    async createMany(a: { data: Row[] }) { for (const d of a.data) rows().push({ id: `${name[0]}${++seq}`, createdAt: new Date(), ...d }); return { count: a.data.length }; },
    async update(a: { where: { id: string }; data: Row }) {
      const row = rows().find((r) => r.id === a.where.id);
      if (!row) throw new Error('Record to update not found.');
      Object.assign(row, a.data);
      return { ...row };
    },
    async delete(a: { where: { id: string } }) {
      const row = rows().find((r) => r.id === a.where.id);
      if (!row) throw new Error('Record to delete does not exist.');
      setRows(rows().filter((r) => r !== row));
      return { ...row };
    },
  };
}
const prisma = {
  lead: table('lead', () => leads, (r) => { leads = r; }),
  leadActivity: table('activity', () => activities, (r) => { activities = r; }),
  waMessage: table('message', () => messages, (r) => { messages = r; }),
  superAdmin: { async findUnique(a: { where: { id: string } }) { return owners.get(a.where.id) ?? null; } },
  platformStaff: {
    async findUnique(a: { where: { id: string }; select?: Row }) { return pick(staff.get(a.where.id), a.select); },
    async update() { return {}; },
  },
  platformAuditLog: {
    async create(a: { data: Row }) { const row = { id: `au${++seq}`, ...a.data }; audits.push(row); return { id: row.id }; },
    async update() { return {}; },
  },
};
stub('config/database', { default: prisma });

// ─── خدمات الإرسال والصيد: بلا شبكة، تُسجّل ما يُرسَل ───
const sentEmails: string[] = [];
const sentWa: string[] = [];
const enriched: string[] = [];
let emailCfg: Row = { enabled: false, source: null, stage: null, countryCode: null };
stub('services/marketingMailer', { sendMarketingEmail: async (o: { to: string }) => { sentEmails.push(o.to); }, marketingProvider: () => 'brevo' });
stub('services/whatsapp', {
  whatsappReady: () => true, waSignatureEnforced: () => true,
  waNumber: (p?: string | null) => (p ? p.replace(/[^\d]/g, '') : ''),
  sendWhatsAppText: async (num: string) => { sentWa.push(num); return `wamid.${num}`; },
  sendWhatsAppTemplate: async (num: string) => { sentWa.push(num); return `wamid.${num}`; },
});
stub('services/whatsappCampaign', {
  getWaConfig: async () => ({ templateName: 't', language: 'ar', params: ['name'], dailyCap: 100, batchSize: 50 }),
  saveWaConfig: async () => undefined, resolveWaParams: () => [], previewWaParams: () => [],
  waSentToday: async () => 0, waRemainingToday: async () => 100, WA_PARAMS: [],
});
stub('services/enrich', { enrichFromWebsite: async (w: string) => { enriched.push(w); return {}; }, hunterDomainSearch: async () => ({}), hunterReady: () => false });
stub('services/leadSources', { runSearch: async () => [], qualifyLeads: async () => new Map(), providersReady: () => ({}) });
stub('services/apifyBudget', { getApifyBudget: async () => ({ monthlyCap: 0, used: 0 }), setApifyCap: async () => ({}), apifyReady: () => false });
stub('services/leadHunter', {
  getHuntConfig: async () => ({ enabled: false, totalRuns: 0, totalImported: 0, countries: [], lastRunAt: null }),
  saveHuntConfig: async () => undefined, runAutoHuntBatch: async () => ({}), ARAB_COUNTRIES: [],
});
stub('services/leadEmailer', {
  getEmailConfig: async () => ({ ...emailCfg }), saveEmailConfig: async (c: Row) => { emailCfg = c; }, runAutoEmailBatch: async () => ({}),
});
stub('services/communityHunter', { getCommunityConfig: async () => ({ enabled: false, lastRunAt: null }), saveCommunityConfig: async () => undefined, runCommunityHuntBatch: async () => ({}) });
stub('services/waBridge', {
  getBridgeSession: async () => ({ status: 'CONNECTED', lastHeartbeat: new Date().toISOString() }), saveBridgeSession: async () => ({}),
  isBridgeAlive: () => true, checkBridgeKey: () => false, bridgeKeyConfigured: () => true,
  getDraftTemplate: async () => 'مرحبا {{name}}', saveDraftTemplate: async () => undefined,
});
stub('services/waInbound', { handleInboundMessage: async () => ({}) });

/* eslint-disable @typescript-eslint/no-var-requires */
const pa = require('../services/platformAccess') as typeof import('../services/platformAccess');
const leadsRouter = (require('../routes/leads') as typeof import('../routes/leads')).default;
const waBridgeRouter = (require('../routes/waBridge') as typeof import('../routes/waBridge')).default;
const { errorHandler } = require('../middleware/errorHandler') as typeof import('../middleware/errorHandler');
/* eslint-enable @typescript-eslint/no-var-requires */

const app = express();
app.use(express.json());
app.get('/echo', (req, res) => { res.json(req.query); });
app.use('/api/leads', leadsRouter);
app.use('/api/wa-bridge', waBridgeRouter);
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
  const text = await r.text();
  let json: Record<string, any> = {}; // eslint-disable-line @typescript-eslint/no-explicit-any
  try { json = JSON.parse(text); } catch { /* نصّ (CSV) */ }
  return { status: r.status, body: json, text };
}

const owner = () => jwt.sign({ id: 'o1', role: 'SUPER_ADMIN', name: 'المالك' }, SECRET, { expiresIn: '1h' });
function staffWith(...permissions: string[]): string {
  const id = `s${++seq}`;
  staff.set(id, { id, name: 'موظف', email: `${id}@x.co`, isActive: true, permissions, tokenVersion: 0, mustChangePassword: false });
  return pa.signStaffToken({ id, tokenVersion: 0 });
}
const lead = (o: Row): Row => ({
  name: 'شركة', phone: null, email: null, website: null, city: null, country: null, countryCode: null, source: 'osm', stage: 'NEW',
  score: null, waOptOut: false, phoneIsMobile: true, notes: null, assignedTo: null, nextFollowUpAt: null, lastContactedAt: null,
  convertedTenantId: null, createdAt: new Date(), updatedAt: new Date(), ...o,
});
/** صفّ مولد فواتير (رقمه الضريبي في الملاحظات) وصفّان عاديان — بهواتف وبريد ومواقع وتفاعل */
function reset() {
  staff.clear(); owners.clear(); owners.set('o1', { id: 'o1', isActive: true });
  audits = []; wheres.length = 0; sentEmails.length = 0; sentWa.length = 0; enriched.length = 0;
  emailCfg = { enabled: false, source: null, stage: null, countryCode: null };
  leads = [
    lead({ id: 'tool1', name: 'مؤسسة المولد', source: TOOL, phone: '966500000001', email: 'tool@vat.sa', website: 'tool.sa', countryCode: 'SA', city: 'الرياض', notes: 'الرقم الضريبي: 300000000000003' }),
    lead({ id: 'reg1', name: 'موزع الجملة', source: 'osm', phone: '201000000001', email: 'reg@dist.eg', website: 'reg.eg', countryCode: 'EG' }),
    lead({ id: 'reg2', name: 'تاجر ثان', source: 'manual', phone: '971500000002', email: 'two@ae.ae', website: 'two.ae', countryCode: 'AE' }),
  ];
  activities = [
    { id: 'act1', leadId: 'tool1', type: 'CLICK', content: 'نقر', createdAt: new Date() },
    { id: 'act2', leadId: 'reg1', type: 'CLICK', content: 'نقر', createdAt: new Date() },
  ];
  messages = [
    { id: 'm1', leadId: 'tool1', phone: '966500000001', direction: 'IN', status: 'RECEIVED', body: 'رقمي الضريبي 300000000000003', createdAt: new Date() },
    { id: 'm2', leadId: null, phone: '966599999999', direction: 'IN', status: 'RECEIVED', body: 'بلا عميل', createdAt: new Date() },
  ];
}
const ids = (rows: { id: string }[]) => rows.map((r) => r.id).sort();
const hasNotTool = (where: unknown) => Array.isArray((where as Row)?.AND)
  && ((where as Row).AND as unknown[]).some((c) => JSON.stringify(c) === JSON.stringify({ source: { not: TOOL } }));

// ═══════════════════ (أ) مرشّح القائمة والتصدير ═══════════════════

test('qs الموسّع يحوّل ?source[equals]=x إلى كائن — أي أن الاختبارات التالية تمرّ بالطريق الذي استُغلّ فعلاً', async () => {
  const r = await call('GET', '/echo?source[equals]=invoice-tool&source2[not]=x');
  assert.deepEqual(r.body, { source: { equals: TOOL }, source2: { not: 'x' } });
});

test('موظف بـleads.view وحدها: source[equals] وsource[not] وsource=invoice-tool لا تعيد صفوف المولد، والمرشّح يحوي AND «ليس المولد»', async () => {
  reset();
  const t = staffWith('leads.view');
  for (const qs of ['source[equals]=invoice-tool', 'source[not]=x', 'source=invoice-tool', 'source[in][]=invoice-tool', '']) {
    wheres.length = 0;
    const r = await call('GET', `/api/leads?${qs}`, t);
    assert.equal(r.status, 200, qs);
    assert.ok(!r.body.data.some((l: Row) => l.source === TOOL), `تسرّب بـ${qs}`);
    const w = wheres.find((x) => x.model === 'lead' && x.op === 'findMany')!.where as Row;
    assert.ok(hasNotTool(w), `بلا شرطٍ إيجابي: ${qs} ⇒ ${JSON.stringify(w)}`);
    assert.ok(typeof w.source === 'string' || JSON.stringify(w.source) === JSON.stringify({ not: TOOL }), `source نصٌّ أو الاستثناء: ${JSON.stringify(w.source)}`);
  }
  // سائر المعاملات نصوصٌ فقط: كائن qs لا يصل Prisma (كان سيرمي أو يرشّح بما لم يُقصد)
  wheres.length = 0;
  const r = await call('GET', '/api/leads?countryCode[not]=EG&q[contains]=x&assignedTo[not]=a&stage[in][]=NEW', t);
  assert.equal(r.status, 200);
  const w = wheres.find((x) => x.model === 'lead' && x.op === 'findMany')!.where as Row;
  for (const k of ['countryCode', 'assignedTo', 'stage', 'OR']) assert.equal(w[k], undefined, k);
  // AND القائم لا يُكتب فوقه: «لم يُراسَل» مع الاستثناء
  wheres.length = 0;
  await call('GET', '/api/leads?emailed=false', t);
  const w2 = wheres.find((x) => x.model === 'lead' && x.op === 'findMany')!.where as Row;
  assert.equal((w2.AND as unknown[]).length, 2);
  assert.ok(hasNotTool(w2));
});

test('التصدير لموظفٍ بـleads.export: source[equals]=invoice-tool لا يُخرج صفوف المولد ولا أرقامهم', async () => {
  reset();
  const t = staffWith('leads.export');
  const r = await call('GET', '/api/leads/export/csv?source[equals]=invoice-tool', t);
  assert.equal(r.status, 200);
  assert.ok(!r.text.includes('مؤسسة المولد') && !r.text.includes('tool@vat.sa'), r.text);
  assert.ok(r.text.includes('موزع الجملة'));
});

test('من يملك invoiceTool.view والمالك: source=invoice-tool يعيد صفوف المولد كما كان، وبلا مصدر تبقى القائمة بلاهم', async () => {
  reset();
  const withTool = staffWith('leads.view', 'invoiceTool.view');
  assert.deepEqual(ids((await call('GET', '/api/leads?source=invoice-tool', withTool)).body.data), ['tool1']);
  wheres.length = 0;
  assert.deepEqual(ids((await call('GET', '/api/leads?source=invoice-tool', owner())).body.data), ['tool1']);
  assert.ok(!hasNotTool(wheres.find((x) => x.op === 'findMany')!.where), 'المالك بلا شرطٍ إضافي');
  assert.deepEqual(ids((await call('GET', '/api/leads', owner())).body.data), ['reg1', 'reg2']);
  assert.ok((await call('GET', '/api/leads/export/csv?source=invoice-tool', owner())).text.includes('مؤسسة المولد'));
});

// ═══════════════════ (ب) الصفّ بمعرّفه ═══════════════════

test('موظف بلا invoiceTool.view: التفاصيل والتعديل والحذف والمتابعة والتحويل على صفّ المولد ٤٠٤ ولا يتغيّر شيء — والصفّ العادي يعمل', async () => {
  reset();
  const t = staffWith('leads.view', 'leads.edit', 'leads.delete');
  const before = JSON.stringify(leads.find((l) => l.id === 'tool1'));
  const acts = activities.length;
  assert.equal((await call('GET', '/api/leads/tool1', t)).status, 404);
  assert.equal((await call('PUT', '/api/leads/tool1', t, { stage: 'WON', notes: 'x' })).status, 404);
  assert.equal((await call('POST', '/api/leads/tool1/activities', t, { type: 'NOTE', content: 'متابعة' })).status, 404);
  assert.equal((await call('POST', '/api/leads/tool1/convert', t, { convertedTenantId: 't9' })).status, 404);
  assert.equal((await call('DELETE', '/api/leads/tool1', t)).status, 404);
  assert.equal(JSON.stringify(leads.find((l) => l.id === 'tool1')), before, 'الصفّ كما هو');
  assert.equal(activities.length, acts, 'لا نشاط جديد');

  const g = await call('GET', '/api/leads/reg1', t);
  assert.equal(g.status, 200);
  assert.deepEqual(g.body.data.activities.map((a: Row) => a.id), ['act2'], 'الأنشطة كما كانت في التفاصيل');
  assert.equal((await call('PUT', '/api/leads/reg1', t, { stage: 'QUALIFIED' })).status, 200);
  assert.equal((await call('POST', '/api/leads/reg1/activities', t, { type: 'CALL', content: 'اتصال' })).status, 201);
  assert.equal((await call('POST', '/api/leads/reg1/convert', t, {})).status, 200);
  assert.equal(leads.find((l) => l.id === 'reg1')!.stage, 'WON');
  assert.equal((await call('DELETE', '/api/leads/reg2', t)).status, 200);
  assert.ok(!leads.some((l) => l.id === 'reg2'));
  assert.equal((await call('DELETE', '/api/leads/nope', t)).status, 404, 'غير الموجود ٤٠٤');
});

test('المالك ومن يملك invoiceTool.view: صفّ المولد بمعرّفه كما كان', async () => {
  reset();
  const t = staffWith('leads.view', 'leads.edit', 'invoiceTool.view');
  assert.equal((await call('GET', '/api/leads/tool1', t)).body.data.name, 'مؤسسة المولد');
  assert.equal((await call('PUT', '/api/leads/tool1', t, { stage: 'CONTACTED' })).status, 200);
  const g = await call('GET', '/api/leads/tool1', owner());
  assert.equal(g.status, 200);
  assert.deepEqual(g.body.data.activities.map((a: Row) => a.type).sort(), ['CLICK', 'STAGE_CHANGE'], 'التفاصيل بأنشطتها');
  assert.equal((await call('POST', '/api/leads/tool1/convert', owner(), {})).status, 200);
  assert.equal((await call('DELETE', '/api/leads/tool1', owner())).status, 200);
  assert.ok(!leads.some((l) => l.id === 'tool1'));
});

// ═══════════════════ (ج) غرفة قيادة التسويق ═══════════════════

test('marketing-stats: الموظف بلا invoiceTool.view لا يرى صفّ المولد بين الساخنين ولا دولته، والمالك يراهما', async () => {
  reset();
  const s = await call('GET', '/api/leads/marketing-stats', staffWith('leads.view'));
  assert.equal(s.status, 200);
  assert.deepEqual(ids(s.body.data.hotLeads), ['reg1']);
  assert.deepEqual(s.body.data.engagedByCountry.map((c: Row) => c.countryCode), ['EG']);
  assert.ok(!JSON.stringify(s.body).includes('966500000001'), 'لا هاتف');
  const o = await call('GET', '/api/leads/marketing-stats', owner());
  assert.deepEqual(ids(o.body.data.hotLeads), ['reg1', 'tool1']);
  assert.deepEqual(o.body.data.engagedByCountry.map((c: Row) => c.countryCode).sort(), ['EG', 'SA']);
  const withTool = await call('GET', '/api/leads/marketing-stats', staffWith('leads.view', 'invoiceTool.view'));
  assert.deepEqual(ids(withTool.body.data.hotLeads), ['reg1', 'tool1']);
});

// ═══════════════════ (د) الإرسال والإثراء وجسر واتساب ═══════════════════

test('البريد وواتساب Cloud والإثراء: معرّفات صفّ المولد أو مرشّح مصدره لا تصله من موظفٍ بلا صلاحيتهم', async () => {
  reset();
  const t = staffWith('leads.message', 'leads.hunt');
  const e = await call('POST', '/api/leads/email', t, { subject: 's', body: 'b', ids: ['tool1', 'reg1'] });
  assert.equal(e.status, 200);
  assert.deepEqual(sentEmails, ['reg@dist.eg']);
  assert.equal((await call('POST', '/api/leads/email', t, { subject: 's', body: 'b', source: TOOL })).body.data.targeted, 0);
  const w = await call('POST', '/api/leads/whatsapp-send', t, { mode: 'text', text: 'مرحبا', ids: ['tool1', 'reg2'] });
  assert.equal(w.status, 200);
  assert.deepEqual(sentWa, ['971500000002']);
  assert.equal((await call('POST', '/api/leads/whatsapp-send', t, { mode: 'text', text: 'x', source: TOOL })).body.data.targeted, 0);
  leads.forEach((l) => { l.email = null; });
  assert.equal((await call('POST', '/api/leads/enrich', t, { ids: ['tool1', 'reg1'] })).status, 200);
  assert.deepEqual(enriched, ['reg.eg']);
  enriched.length = 0;
  await call('POST', '/api/leads/enrich', t, { source: TOOL });
  assert.deepEqual(enriched, []);
  // المالك كما كان
  sentEmails.length = 0;
  reset();
  await call('POST', '/api/leads/email', owner(), { subject: 's', body: 'b', ids: ['tool1'] });
  assert.deepEqual(sentEmails, ['tool@vat.sa']);
});

test('معاينة واتساب والبريد الآلي: لا اسم من المولد ولا توجيه إليهم من موظفٍ بلا صلاحيتهم', async () => {
  reset();
  const t = staffWith('leads.message');
  assert.equal((await call('GET', '/api/leads/whatsapp-preview', t)).body.data.lead.name, 'موزع الجملة');
  assert.equal((await call('GET', '/api/leads/whatsapp-preview', owner())).body.data.lead.name, 'مؤسسة المولد', 'المالك كما كان');
  const bad = await call('PUT', '/api/leads/auto-email', t, { source: TOOL });
  assert.equal(bad.status, 403);
  assert.equal(emailCfg.source, null);
  assert.equal((await call('PUT', '/api/leads/auto-email', t, { source: 'osm' })).status, 200);
  assert.equal((await call('PUT', '/api/leads/auto-email', owner(), { source: TOOL })).status, 200);
  assert.equal(emailCfg.source, TOOL);
});

test('جسر واتساب: معاينة صفّ المولد ومحادثته وإرساله ٤٠٤ للموظف بلا صلاحيتهم — والمالك كما كان', async () => {
  reset();
  const t = staffWith('waBridge.view', 'waBridge.send');
  assert.equal((await call('GET', '/api/wa-bridge/preview/tool1', t)).status, 404);
  const th = await call('GET', '/api/wa-bridge/thread/tool1', t);
  assert.equal(th.status, 404);
  assert.ok(!th.text.includes('300000000000003'));
  const n = messages.length;
  assert.equal((await call('POST', '/api/wa-bridge/send', t, { leadId: 'tool1', text: 'مرحبا' })).status, 404);
  assert.equal(messages.length, n, 'لم يُدرَج شيء');

  const p = await call('GET', '/api/wa-bridge/preview/reg1', t);
  assert.equal(p.status, 200);
  assert.equal(p.body.data.text, 'مرحبا موزع الجملة');
  assert.ok(!('source' in p.body.data.lead), 'الردّ بحقوله السابقة');
  assert.deepEqual((await call('GET', '/api/wa-bridge/thread/reg1', t)).body.data, []);
  assert.deepEqual((await call('GET', '/api/wa-bridge/thread/nope', t)).body.data, [], 'معرّفٌ بلا عميل: لا رسائل (leadId قد يكون null)');
  assert.equal((await call('POST', '/api/wa-bridge/send', t, { leadId: 'reg1', text: 'مرحبا' })).status, 200);

  const op = await call('GET', '/api/wa-bridge/preview/tool1', owner());
  assert.equal(op.status, 200);
  assert.deepEqual(Object.keys(op.body.data.lead).sort(), ['city', 'country', 'countryCode', 'id', 'name', 'phone', 'waOptOut']);
  assert.deepEqual((await call('GET', '/api/wa-bridge/thread/tool1', owner())).body.data.map((m: Row) => m.id), ['m1']);
  assert.equal((await call('POST', '/api/wa-bridge/send', owner(), { leadId: 'tool1', text: 'مرحبا' })).status, 200);
});

test('جسر واتساب الجماعي: معرّفات صفّ المولد أو مرشّح مصدره لا تُدرَج من موظفٍ بلا صلاحيتهم، والمالك كما كان', async () => {
  reset();
  const t = staffWith('waBridge.send');
  const b = await call('POST', '/api/wa-bridge/bulk', t, { ids: ['tool1', 'reg1'] });
  assert.equal(b.status, 200);
  assert.equal(b.body.data.queued, 1);
  assert.deepEqual(messages.filter((m) => m.status === 'QUEUED').map((m) => m.leadId), ['reg1']);
  assert.equal((await call('POST', '/api/wa-bridge/bulk', t, { source: TOOL })).body.data.queued, 0);
  reset();
  assert.equal((await call('POST', '/api/wa-bridge/bulk', owner(), { ids: ['tool1', 'reg1'] })).body.data.queued, 2);
});

/* eslint-disable @typescript-eslint/no-explicit-any */
// قرار المالك (19 نوفمبر 2026): المالك يحدّد من «إعدادات السفراء» في لوحته سعر كل باقة يراه السفراء في
// تبويب «الباقات والأسعار» (شهرياً وسنوياً، ريالٌ صحيح 1..1,000,000 شاملٌ الضريبة — الفارغ = الكتالوج
// الرسمي) ونسبة خصم سفراء اليمن (0..90، الافتراضيّ ٣٣). الخصم يُطبَّق فوق السعر المعروض مقرّباً لأقرب ريال،
// والسعر المعلن (listMonthly/listYearly) يبقى الكتالوج الرسمي.
//
// قسمان: (١) منطق services/affiliate/pricing.ts وقراءة getSettings للعمود. (٢) الموجّهان الحقيقيان
// `/api/affiliate-admin/settings` و`/api/affiliate/pricing` فوق Prisma مزيّف في الذاكرة — بلا قاعدة ولا شبكة ولا حسابات.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-affiliate-pricing';
delete process.env.AFFILIATE_JWT_SECRET;
for (const k of ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'RESEND_API_KEY', 'FRONTEND_URL']) delete process.env[k];

const src = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), 'src', ...p), 'utf8');
const strip = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const riyals = (pkgs: Array<{ id: string; monthlyHalalas: number; yearlyHalalas: number }>) =>
  pkgs.map(p => [p.id, p.monthlyHalalas / 100, p.yearlyHalalas / 100]);

// ═════════════════════════════ (١) المنطق ═════════════════════════════

test('سعر المالك للسفراء يحلّ محلّ الكتالوج، والفارغ = الكتالوج، والمعلن يبقى الكتالوج', async () => {
  const { affiliatePricing } = await import('../services/affiliate/pricing');
  const p = affiliatePricing('966551234567', { packagePrices: { starter: { monthly: 249 }, pro: { yearly: 4990 } }, yemenDiscountPct: 33 });
  assert.equal(p.discountPct, 0);
  assert.equal(p.region, null);
  assert.deepEqual(riyals(p.packages), [['starter', 249, 2990], ['growth', 399, 3990], ['pro', 599, 4990]]);
  assert.deepEqual(p.packages.map(x => [x.listMonthlyHalalas, x.listYearlyHalalas]),
    [[29_900, 299_000], [39_900, 399_000], [59_900, 599_000]], 'المعلن: الكتالوج الرسمي دائماً');
  assert.deepEqual(p.packages.map(x => [x.baseMonthlyHalalas, x.baseYearlyHalalas]),
    [[24_900, 299_000], [39_900, 399_000], [59_900, 499_000]], 'قبل الخصم الإقليميّ = المعروض لغير اليمن');
  // بلا إعدادات: كما كان تماماً
  const none = affiliatePricing('966551234567');
  assert.deepEqual(riyals(none.packages), [['starter', 299, 2990], ['growth', 399, 3990], ['pro', 599, 5990]]);
  assert.deepEqual(riyals(affiliatePricing('966551234567', null).packages), riyals(none.packages));
});

test('خصم اليمن فوق السعر المعروض مقرّباً لأقرب ريال، بالنسبة التي يحدّدها المالك', async () => {
  const { affiliatePricing } = await import('../services/affiliate/pricing');
  const ye = '967771234567';
  // ٢٥٠ × ٦٧٪ = ١٦٧٫٥ ⇒ ١٦٨ (نصفٌ لأعلى)؛ ٢٥٠٠ × ٦٧٪ = ١٦٧٥
  const a = affiliatePricing(ye, { packagePrices: { starter: { monthly: 250, yearly: 2500 } }, yemenDiscountPct: 33 });
  assert.equal(a.region, 'YE');
  assert.equal(a.discountPct, 33);
  assert.deepEqual(riyals(a.packages), [['starter', 168, 1675], ['growth', 267, 2673], ['pro', 401, 4013]]);
  assert.deepEqual(a.packages.map(x => x.baseMonthlyHalalas), [25_000, 39_900, 59_900], 'المشطوب في البوابة = سعر السفراء قبل الخصم');
  assert.deepEqual(a.packages.map(x => x.listMonthlyHalalas), [29_900, 39_900, 59_900]);
  // نسبةٌ أخرى: ٥٠٪ من ٢٩٩ = ١٤٩٫٥ ⇒ ١٥٠
  const half = affiliatePricing(ye, { packagePrices: {}, yemenDiscountPct: 50 });
  assert.equal(half.discountPct, 50);
  assert.deepEqual(riyals(half.packages), [['starter', 150, 1495], ['growth', 200, 1995], ['pro', 300, 2995]]);
  // صفر = لا خصم ولا شارة منطقة
  const zero = affiliatePricing(ye, { packagePrices: { growth: { monthly: 350 } }, yemenDiscountPct: 0 });
  assert.equal(zero.discountPct, 0);
  assert.equal(zero.region, null);
  assert.deepEqual(riyals(zero.packages), [['starter', 299, 2990], ['growth', 350, 3990], ['pro', 599, 5990]]);
  // نسبةٌ تالفة في الإعدادات ⇒ الافتراضيّ ٣٣
  for (const bad of [-5, 91, 12.5, '40', null, undefined, NaN]) {
    assert.equal(affiliatePricing(ye, { yemenDiscountPct: bad as any }).discountPct, 33, String(bad));
  }
});

test('regionalDiscountFor: نسبة المالك لليمن، وغير اليمن بلا خصم', async () => {
  const { regionalDiscountFor } = await import('../services/affiliate/pricing');
  assert.equal(regionalDiscountFor('967771234567', { yemenDiscountPct: 20 })?.pct, 20);
  assert.equal(regionalDiscountFor('967771234567')?.pct, 33);
  assert.equal(regionalDiscountFor('967771234567', { yemenDiscountPct: 0 }), null);
  assert.equal(regionalDiscountFor('966551234567', { yemenDiscountPct: 50 }), null);
  assert.equal(regionalDiscountFor(null, { yemenDiscountPct: 50 }), null);
});

test('قراءة العمود متسامحة: معرّفٌ مجهول أو سالب أو كسر أو نصّ يُهمل (= الكتالوج)', async () => {
  const { parseAmbassadorPricing, cleanPackagePrices, affiliatePricing, packageCatalog } = await import('../services/affiliate/pricing');
  assert.deepEqual(parseAmbassadorPricing(null), { packagePrices: {}, yemenDiscountPct: 33 });
  assert.deepEqual(parseAmbassadorPricing(undefined), { packagePrices: {}, yemenDiscountPct: 33 });
  assert.deepEqual(parseAmbassadorPricing('x'), { packagePrices: {}, yemenDiscountPct: 33 });
  assert.deepEqual(parseAmbassadorPricing([1]), { packagePrices: {}, yemenDiscountPct: 33 });
  const messy = {
    packagePrices: {
      starter: { monthly: -10, yearly: 2500 }, growth: { monthly: 299.5, yearly: '3000' }, pro: { monthly: 0, yearly: 1_000_001 },
      enterprise: { monthly: 999 }, __proto__: { monthly: 1 },
    },
    yemenDiscountPct: 40,
  };
  assert.deepEqual(parseAmbassadorPricing(messy), { packagePrices: { starter: { yearly: 2500 } }, yemenDiscountPct: 40 });
  assert.deepEqual(cleanPackagePrices({ starter: null, growth: { monthly: null, yearly: null }, pro: { monthly: 1_000_000 } }), { pro: { monthly: 1_000_000 } });
  assert.deepEqual(riyals(affiliatePricing('966500000000', { packagePrices: messy.packagePrices as any }).packages),
    [['starter', 299, 2500], ['growth', 399, 3990], ['pro', 599, 5990]], 'التالف لا يصل البوابة');
  assert.deepEqual(packageCatalog().map(c => [c.id, c.monthly, c.yearly]), [['starter', 299, 2990], ['growth', 399, 3990], ['pro', 599, 5990]]);
  assert.ok(packageCatalog().every(c => c.name.length > 0));
});

test('getSettings يقرأ pricingJson — والصفّ القديم بلا العمود = الكتالوج والخصم الافتراضيّ', async () => {
  const core = await import('../services/affiliate/core');
  const row = (over: object) => ({
    id: 'global', intakeOpen: true, rateBps: 3000, holdDays: 10, minPayoutHalalas: 5000, refWindowDays: 90, claimLockDays: 90,
    firstPaymentWithinDays: 180, currentTermsVersion: '2026-11-v4', disclosureText: 'إفصاح', ...over,
  });
  const fake = (r: object | null): any => ({ affiliateSettings: { findUnique: async () => r } });
  const s = await core.getSettings(fake(row({ pricingJson: { packagePrices: { growth: { monthly: 349 } }, yemenDiscountPct: 25 } })));
  assert.deepEqual(s.packagePrices, { growth: { monthly: 349 } });
  assert.equal(s.yemenDiscountPct, 25);
  const old = await core.getSettings(fake(row({})));
  assert.deepEqual([old.packagePrices, old.yemenDiscountPct], [{}, 33]);
  const none = await core.getSettings(fake(null));
  assert.deepEqual([none.packagePrices, none.yemenDiscountPct], [{}, 33]);
  assert.deepEqual([core.DEFAULT_SETTINGS.packagePrices, core.DEFAULT_SETTINGS.yemenDiscountPct], [{}, 33]);
  // إنشاء الصفّ لا يمرّر لـPrisma حقلين ليسا عمودين
  const cols = core.settingsColumns(s);
  assert.ok(!('packagePrices' in cols) && !('yemenDiscountPct' in cols));
  assert.equal(cols.disclosureText, 'إفصاح');
});

test('الحرّاس: عمودٌ إضافيّ nullable، والإنشاء بـsettingsColumns، والمسار بإعدادات المالك وبصلاحية الإعدادات نفسها', () => {
  const schema = fs.readFileSync(path.join(process.cwd(), 'prisma', 'schema.prisma'), 'utf8');
  const at = schema.indexOf('model AffiliateSettings {');
  const model = schema.slice(at, schema.indexOf('\n}', at) + 1);
  assert.match(model, /\n\s*pricingJson\s+Json\?\s*\n/, 'عمودٌ nullable — db push إضافيّ');
  assert.doesNotMatch(model, /@@unique/);
  const admin = strip(src('routes', 'affiliateAdmin.ts'));
  assert.doesNotMatch(admin, /create: \{ id: 'global', \.\.\.(before|settings),/, 'نسخ القيمة كلّها يمرّر حقلين مجهولين لـPrisma');
  assert.equal((admin.match(/\.\.\.settingsColumns\((before|settings)\)/g) ?? []).length, 2);
  const portal = strip(src('routes', 'affiliate.ts'));
  assert.match(portal, /affiliatePricing\(req\.affiliate!\.phone, await getSettings\(\)\)/);
  const access = src('services', 'platformAccess.ts');
  assert.match(access, /r\('PUT', '\/api\/affiliate-admin\/settings', 'affiliates\.manage'\)/, 'الأسعار تُحفظ بصلاحية الإعدادات نفسها');
});

// ═════════════════════════════ (٢) الموجّهان فوق Prisma مزيّف ═════════════════════════════

const COLUMNS = new Set(['id', 'intakeOpen', 'rateBps', 'holdDays', 'minPayoutHalalas', 'refWindowDays', 'claimLockDays',
  'firstPaymentWithinDays', 'currentTermsVersion', 'disclosureText', 'pricingJson', 'updatedBy']);
const state: { settings: Record<string, any> | null; events: any[]; upserts: any[] } = { settings: null, events: [], upserts: [] };
const AMB = { id: 'amb-ye', status: 'approved', tokenVersion: 0, phone: '967771234567', email: 'ye@example.com' };

function fakePrisma(): Record<string, unknown> {
  const checkCols = (data: object) => {
    for (const k of Object.keys(data)) if (!COLUMNS.has(k)) throw new Error(`Unknown argument \`${k}\``);
  };
  const f: Record<string, unknown> = {
    superAdmin: { findUnique: async () => ({ isActive: true }) },
    affiliateSettings: {
      findUnique: async () => (state.settings ? { ...state.settings } : null),
      upsert: async ({ create, update }: any) => {
        state.upserts.push({ create, update });
        if (state.settings) { checkCols(update); state.settings = { ...state.settings, ...update, updatedAt: new Date() }; }
        else { checkCols(create); state.settings = { ...create, updatedAt: new Date() }; }
        return { ...state.settings };
      },
    },
    affiliateTerms: { findUnique: async () => null },
    affiliateEvent: { create: async ({ data }: any) => { state.events.push(data); return data; } },
    affiliateUser: { findUnique: async ({ where }: any) => (where.id === AMB.id ? { ...AMB } : null) },
  };
  f.$transaction = async (fn: any) => (typeof fn === 'function' ? fn(f) : Promise.all(fn));
  return f;
}

let port = 0;
let server: http.Server;
let ownerToken = '';
let ambToken = '';

before(async () => {
  process.env.DATABASE_URL = 'postgresql://offline:offline@127.0.0.1:9/offline?connect_timeout=1';
  const prisma = (await import('../config/database')).default as unknown as Record<string, unknown>;
  Object.assign(prisma, fakePrisma());
  const adminRouter = (await import('../routes/affiliateAdmin')).default;
  const portalRouter = (await import('../routes/affiliate')).default;
  const { errorHandler } = await import('../middleware/errorHandler');
  const { signSession } = await import('../services/affiliate/core');
  ownerToken = jwt.sign({ id: 'owner-1', role: 'SUPER_ADMIN' }, process.env.JWT_SECRET!);
  ambToken = signSession(AMB.id, AMB.tokenVersion);
  const app = express();
  app.use(express.json());
  app.use('/api/affiliate-admin', adminRouter);
  app.use('/api/affiliate', portalRouter);
  app.use(errorHandler);
  server = http.createServer(app);
  port = await new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
});

after(async () => { await new Promise(res => server.close(res)); });

async function call(method: string, url: string, body?: unknown, token = ownerToken): Promise<{ status: number; json: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${url}`, {
    method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}
const tick = () => new Promise(r => setTimeout(r, 30));

test('GET /settings: الأسعار الرسمية للوحة، وبلا صفٍّ = الكتالوج و٣٣٪', async () => {
  const r = await call('GET', '/api/affiliate-admin/settings');
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json.data.packagePrices, {});
  assert.equal(r.json.data.yemenDiscountPct, 33);
  assert.deepEqual(r.json.data.packageCatalog.map((c: any) => [c.id, c.monthly, c.yearly]),
    [['starter', 299, 2990], ['growth', 399, 3990], ['pro', 599, 5990]]);
});

test('PUT /settings يرفض السالب والكسر والنصّ والصفر وما فوق المليون والباقة المجهولة والمفتاح المجهول والنسبة خارج 0..90', async () => {
  const bad: unknown[] = [
    { packagePrices: { starter: { monthly: -1 } } },
    { packagePrices: { starter: { monthly: 249.5 } } },
    { packagePrices: { starter: { yearly: '2500' } } },
    { packagePrices: { starter: { monthly: 0 } } },
    { packagePrices: { growth: { yearly: 1_000_001 } } },
    { packagePrices: { enterprise: { monthly: 999 } } },
    { packagePrices: { starter: { weekly: 99 } } },
    { packagePrices: { starter: 250 } },
    { packagePrices: [] },
    { yemenDiscountPct: -1 },
    { yemenDiscountPct: 91 },
    { yemenDiscountPct: 12.5 },
    { yemenDiscountPct: '30' },
  ];
  for (const b of bad) {
    const r = await call('PUT', '/api/affiliate-admin/settings', b);
    assert.equal(r.status, 400, `${JSON.stringify(b)} ⇒ ${r.status} ${JSON.stringify(r.json)}`);
  }
  assert.equal(state.upserts.length, 0, 'لا كتابة من جسمٍ مرفوض');
});

test('PUT /settings يحفظ الأسعار (null = الرسمي) والنسبة، ويسجّل التغيير بالسابق — وبلا صفٍّ لا يمرّر حقلاً مجهولاً', async () => {
  const r = await call('PUT', '/api/affiliate-admin/settings', {
    packagePrices: { starter: { monthly: 250, yearly: null }, growth: null, pro: { yearly: 4990 } }, yemenDiscountPct: 25,
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(state.settings!.pricingJson, { packagePrices: { starter: { monthly: 250 }, pro: { yearly: 4990 } }, yemenDiscountPct: 25 });
  const created = state.upserts[0].create;
  assert.equal(created.disclosureText, 'أحصل على عمولة من فيلد سيلز إذا اشتركت عبر رابطي', 'الصفّ الأول بالقيم الافتراضية');
  assert.equal(created.updatedBy, 'owner-1');
  await tick();
  const ev = state.events.find(e => e.entity === 'settings' && e.action === 'updated');
  assert.ok(ev, 'حدث «settings/updated»');
  assert.deepEqual(ev.meta.changes, { packagePrices: { starter: { monthly: 250 }, pro: { yearly: 4990 } }, yemenDiscountPct: 25 });
  assert.deepEqual(ev.meta.previous, { packagePrices: {}, yemenDiscountPct: 33 });
  assert.equal(ev.actorType, 'owner');

  const g = await call('GET', '/api/affiliate-admin/settings');
  assert.deepEqual(g.json.data.packagePrices, { starter: { monthly: 250 }, pro: { yearly: 4990 } });
  assert.equal(g.json.data.yemenDiscountPct, 25);
});

test('بوابة سفير اليمن ترى سعر المالك بخصمه — والمشطوب سعر السفراء قبل الخصم', async () => {
  const r = await call('GET', '/api/affiliate/pricing', undefined, ambToken);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const d = r.json.data;
  assert.equal(d.region, 'YE');
  assert.equal(d.discountPct, 25);
  // ٢٥٠ × ٧٥٪ = ١٨٧٫٥ ⇒ ١٨٨؛ ٢٩٩٠ × ٧٥٪ = ٢٢٤٢٫٥ ⇒ ٢٢٤٣؛ ٤٩٩٠ × ٧٥٪ = ٣٧٤٢٫٥ ⇒ ٣٧٤٣
  assert.deepEqual(riyals(d.packages), [['starter', 188, 2243], ['growth', 299, 2993], ['pro', 449, 3743]]);
  assert.deepEqual(d.packages.map((p: any) => p.baseMonthlyHalalas), [25_000, 39_900, 59_900]);
  assert.deepEqual(d.packages.map((p: any) => p.listMonthlyHalalas), [29_900, 39_900, 59_900]);
});

test('PUT /settings بلا حقول الأسعار لا يمسّ pricingJson، وpackagePrices يستبدل الخريطة كلّها ({} = الرسمي)', async () => {
  const n = state.upserts.length;
  const a = await call('PUT', '/api/affiliate-admin/settings', { intakeOpen: false });
  assert.equal(a.status, 200, JSON.stringify(a.json));
  assert.ok(!('pricingJson' in state.upserts[n].update), 'تعديل المفتاح وحده لا يكتب الأسعار');
  assert.equal(state.settings!.pricingJson.yemenDiscountPct, 25);

  const b = await call('PUT', '/api/affiliate-admin/settings', { yemenDiscountPct: 0 });
  assert.equal(b.status, 200);
  assert.deepEqual(state.settings!.pricingJson, { packagePrices: { starter: { monthly: 250 }, pro: { yearly: 4990 } }, yemenDiscountPct: 0 }, 'النسبة وحدها تُبقي الأسعار');

  const c = await call('PUT', '/api/affiliate-admin/settings', { packagePrices: {} });
  assert.equal(c.status, 200);
  assert.deepEqual(state.settings!.pricingJson, { packagePrices: {}, yemenDiscountPct: 0 });
  const p = await call('GET', '/api/affiliate/pricing', undefined, ambToken);
  assert.equal(p.json.data.discountPct, 0);
  assert.deepEqual(riyals(p.json.data.packages), [['starter', 299, 2990], ['growth', 399, 3990], ['pro', 599, 5990]]);
});

test('PUT /settings ما زال يرفض قيم الشروط 409 terms_bound ولو مع الأسعار', async () => {
  const n = state.upserts.length;
  const r = await call('PUT', '/api/affiliate-admin/settings', { rateBps: 2500, packagePrices: { starter: { monthly: 200 } } });
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'terms_bound');
  assert.equal(state.upserts.length, n);
});

test('بلا توكن المالك: 401 — ولا يكتب السفير الإعدادات', async () => {
  const r = await call('PUT', '/api/affiliate-admin/settings', { yemenDiscountPct: 10 }, ambToken);
  assert.ok(r.status === 401 || r.status === 403, String(r.status));
});

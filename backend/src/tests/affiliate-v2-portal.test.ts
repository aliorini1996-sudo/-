/* eslint-disable @typescript-eslint/no-explicit-any */
// «سفير فيلد سيلز» v2 — بوابة السفير (الوكيل A، docs/affiliate/V2_SPEC.md §3 و§4 و§6.1 و§11). قرار المالك ١٨ نوفمبر ٢٠٢٦:
// الانضمام فوريّ بلا تأكيد بريد ولا موافقة، الحجز ١٠ أيام، التسوية كل ١٠ أيام بحدٍّ أدنى ٥٠ ريالاً، والملف الكامل شرطٌ للصرف.
//
// قسمان: (١) دوالٌّ نقيّة — قواعد الإصدارات المدمجة، نصّ v4، روابط التواصل، اكتمال الملف، فحص المستند وتشفيره، حدود دورة
// التسوية، وأرقام الرئيسية. (٢) الموجّه الحقيقي `/api/affiliate` فوق Prisma مزيّف في الذاكرة — بلا قاعدة بيانات ولا شبكة
// ولا حسابات حقيقية: التسجيل الفوريّ و409، ترقية الإرث عند الدخول وعند الإقلاع، /me، بيانات الاستلام بلا شرط، المستندات،
// الرئيسية، التسويات، المطالبات الفائتة، المواد.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-affiliate-v2';
delete process.env.AFFILIATE_JWT_SECRET;
delete process.env.AFFILIATE_IBAN_KEY;
delete process.env.AFFILIATE_DOC_KEY;
for (const k of ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'RESEND_API_KEY', 'FRONTEND_URL']) delete process.env[k];

const src = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), 'src', ...p), 'utf8');
const strip = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

// ═════════════════════════════ (١) دوالٌّ نقيّة ═════════════════════════════

test('قواعد الإصدارات المدمجة مثبّتةٌ بإصدارها: v1–v3 بحجز ٣٠ وحدّ ١٠٠، وv4 بحجز ١٠ وحدّ ٥٠ — والافتراضيات من v4', async () => {
  const core = await import('../services/affiliate/core');
  const v13 = { rateBps: 3000, holdDays: 30, minPayoutHalalas: 10000, refWindowDays: 90, claimLockDays: 90, firstPaymentWithinDays: 180 };
  for (const v of ['2026-09-v1', '2026-09-v2', '2026-09-v3']) assert.deepEqual(core.builtinTermsRules(v), v13, v);
  assert.deepEqual(core.builtinTermsRules('2026-11-v4'), { ...v13, holdDays: 10, minPayoutHalalas: 5000 });
  assert.equal(core.builtinTermsRules('owner-2026-12'), null);
  assert.equal(core.builtinTermsRules('__proto__'), null, 'لا مفاتيح موروثة');
  assert.deepEqual(core.pickRules(core.DEFAULT_SETTINGS), core.builtinTermsRules(core.DEFAULT_TERMS_VERSION));
  const copy = core.builtinTermsRules('2026-09-v1')!;
  copy.holdDays = 1;
  assert.equal(core.builtinTermsRules('2026-09-v1')!.holdDays, 30, 'نسخةٌ لا مرجع');
});

test('rulesFor: سفير v1–v3 يبقى بقواعد ما قبِل (لا أثر رجعيّ)، والمنشور من اللوحة بقواعده المخزَّنة', async () => {
  const core = await import('../services/affiliate/core');
  const terms: Record<string, unknown> = { 'owner-x': { rulesJson: { rateBps: 2500, holdDays: 14 } } };
  const fake: any = {
    affiliateTerms: { findUnique: async ({ where }: any) => (terms[where.version] as object) ?? null },
    affiliateSettings: { findUnique: async () => null },
  };
  assert.equal((await core.rulesFor('2026-09-v3', fake)).holdDays, 30, 'كان يُعيد الافتراضيات الحالية (١٠) لسفيرٍ قبِل ٣٠');
  assert.equal((await core.rulesFor('2026-09-v1', fake)).minPayoutHalalas, 10000);
  assert.equal((await core.rulesFor('2026-11-v4', fake)).holdDays, 10);
  const owner = await core.rulesFor('owner-x', fake);
  assert.equal(owner.rateBps, 2500);
  assert.equal(owner.holdDays, 14);
});

test('getSettings: صفٌّ كُتب أيّام v3 يُرقّى إلى v4 بقيم v4 (١٠ أيام/٥٠ ريالاً) — والإصدار المنشور من اللوحة لا يُمسّ', async () => {
  const core = await import('../services/affiliate/core');
  const row = (over: object) => ({
    id: 'global', intakeOpen: true, rateBps: 3000, holdDays: 30, minPayoutHalalas: 10000, refWindowDays: 90, claimLockDays: 90,
    firstPaymentWithinDays: 180, currentTermsVersion: '2026-09-v3', disclosureText: 'إفصاح', ...over,
  });
  const fake = (r: object | null): any => ({ affiliateSettings: { findUnique: async () => r } });
  const up = await core.getSettings(fake(row({})));
  assert.equal(up.currentTermsVersion, '2026-11-v4');
  assert.equal(up.holdDays, 10, '/terms/public و/me يقولان ١٠ لا ٣٠');
  assert.equal(up.minPayoutHalalas, 5000);
  assert.equal(up.disclosureText, 'إفصاح', 'الإفصاح والمفتاح من الصفّ');
  const custom = await core.getSettings(fake(row({ currentTermsVersion: 'owner-x', holdDays: 21, minPayoutHalalas: 7000 })));
  assert.equal(custom.currentTermsVersion, 'owner-x');
  assert.equal(custom.holdDays, 21);
  assert.equal(custom.minPayoutHalalas, 7000);
  assert.equal((await core.getSettings(fake(null))).holdDays, 10, 'بلا صفّ: الافتراضيات = v4');
});

test('نصّ الشروط v4: الأرقام الجديدة وبنود الحماية الناقصة، بلا Markdown — ونصّ v3 محفوظٌ لمن قبله', async () => {
  const core = await import('../services/affiliate/core');
  const v4 = core.builtinTermsBody('2026-11-v4') ?? '';
  assert.equal(v4, core.DEFAULT_TERMS_BODY);
  assert.ok(v4.includes('الإصدار 2026-11-v4'));
  const must = [
    '٣٠٪ من أوّل دفعة مؤكَّدة', 'شاملاً ضريبة القيمة المضافة', 'متصفّح الزائر ٩٠ يوماً', 'لك ٩٠ يوماً', 'خلال ١٨٠ يوماً',
    'معلّقة ١٠ أيام', 'تُعتمد تلقائياً', 'كل ١٠ أيام', 'الأيام ١ و١١ و٢١', 'بحدٍّ أدنى ٥٠ ريالاً', 'ويُرحَّل ما دونه',
    'الانضمام فوريّ', 'اكتمل ملفّه', 'مطالبة بإحالة فائتة', 'خلال ٣٠ يوماً من تسجيلها',
    'ادّعاءات مضلّلة', 'اسم فيلد سيلز أو شعارها', 'بإذنٍ كتابيّ', 'الضرائب', 'عدم نشاطٍ ١٢ شهراً',
    'تُسوّى لك العمولات المستحقّة المشروعة', 'يُشعَر به السفير', 'أنظمة المملكة العربية السعودية',
    'موثوق', '«إعلان»', 'ورقم التواصل معها',
  ];
  for (const m of must) assert.ok(v4.includes(m), `v4 ينقصه: ${m}`);
  assert.ok(!v4.includes('**'), 'نصٌّ عاديّ يُعرض مُهرَّباً');
  assert.ok(!v4.includes('ركاز'), 'لا أسماء منافسين');
  const v3 = core.builtinTermsBody('2026-09-v3') ?? '';
  assert.ok(v3.startsWith('شروط برنامج «سفير فيلد سيلز» — الإصدار 2026-09-v3'), 'ترويسة v3 حرفيّة لا من الافتراضيّ');
  assert.ok(v3.includes('معلّقة ٣٠ يوماً') && v3.includes('١٠٠ ريال'));
});

test('الرابط مباشرةً إلى صفحة التسجيل /signup?ref=', async () => {
  const { referralLink } = await import('../services/affiliate/core');
  assert.equal(referralLink('AB2C3D4E'), 'https://fieldsa.net/signup?ref=AB2C3D4E');
});

test('روابط التواصل: https وحدها حتى ٨، بمنصّةٍ معروفة، بلا محارف تحكّم — والمكرَّر يُسقط', async () => {
  const { normSocialLinks, readSocialLinks } = await import('../services/affiliate/rules');
  assert.deepEqual(normSocialLinks(null), { ok: true, links: [] });
  assert.deepEqual(normSocialLinks([]), { ok: true, links: [] });
  const ok = normSocialLinks([{ platform: 'X', url: ' https://x.com/fieldsa ' }, { platform: 'x', url: 'https://X.com/fieldsa' }, { platform: 'website', url: 'http://example.sa/a?b=1' }]);
  assert.deepEqual(ok, { ok: true, links: [{ platform: 'x', url: 'https://x.com/fieldsa' }, { platform: 'website', url: 'http://example.sa/a?b=1' }] });
  for (const bad of [
    [{ platform: 'x', url: 'javascript:alert(1)' }], [{ platform: 'x', url: 'data:text/html,hi' }], [{ platform: 'myspace', url: 'https://a.com' }],
    [{ platform: 'x', url: `https://a.com/${'a'.repeat(300)}` }], [{ platform: 'x', url: 'https://a.com/‮fdp' }], [{ platform: 'x', url: 'https://localhost' }],
    Array.from({ length: 9 }, (_, i) => ({ platform: 'other', url: `https://a${i}.com` })), 'https://x.com', [null],
  ]) assert.equal(normSocialLinks(bad).ok, false, JSON.stringify(bad).slice(0, 80));
  assert.deepEqual(readSocialLinks([{ platform: 'x', url: 'https://x.com/a' }, { platform: 'x', url: 'javascript:1' }, 5]), [{ platform: 'x', url: 'https://x.com/a' }]);
  assert.deepEqual(readSocialLinks({ not: 'array' }), []);
});

test('اكتمال الملف: النوع + الآيبان + الهوية (+ السجل للشركة) بترتيبٍ ثابت', async () => {
  const { profileMissing } = await import('../services/affiliate/rules');
  assert.deepEqual(profileMissing({ partnerType: null, hasIban: false, docKinds: [] }), ['partnerType', 'iban', 'national_id']);
  assert.deepEqual(profileMissing({ partnerType: 'individual', hasIban: true, docKinds: ['national_id'] }), []);
  assert.deepEqual(profileMissing({ partnerType: 'influencer', hasIban: true, docKinds: ['national_id'] }), []);
  assert.deepEqual(profileMissing({ partnerType: 'company', hasIban: true, docKinds: ['national_id'] }), ['commercial_reg']);
  assert.deepEqual(profileMissing({ partnerType: 'company', hasIban: false, docKinds: ['commercial_reg'] }), ['iban', 'national_id']);
  assert.deepEqual(profileMissing({ partnerType: 'robot', hasIban: true, docKinds: ['national_id'] }), ['partnerType'], 'نوعٌ مجهول = لا نوع');
});

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(120)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(120)]);
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), crypto.randomBytes(120)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 2, 3, 4]), Buffer.from('WEBPVP8 '), crypto.randomBytes(120)]);
const dataUrl = (mime: string, b: Buffer) => `data:${mime};base64,${b.toString('base64')}`;

test('المستند: النوع من البايتات (JPEG/PNG/WebP/PDF ≤ ٥ ميغابايت) — البادئة الكاذبة وSVG والضخم والتالف مرفوضة', async () => {
  const { parseDocumentDataUrl, AFFILIATE_DOC_MAX_BYTES } = await import('../services/affiliate/documents');
  for (const [mime, b] of [['image/png', PNG], ['image/jpeg', JPEG], ['application/pdf', PDF], ['image/webp', WEBP]] as const) {
    const r = parseDocumentDataUrl(dataUrl(mime, b));
    assert.ok(r.ok, mime);
    if (r.ok) { assert.equal(r.mime, mime); assert.ok(r.bytes.equals(b)); }
  }
  const bad = [
    dataUrl('image/png', PDF), dataUrl('application/pdf', PNG), dataUrl('image/svg+xml', Buffer.from('<svg onload=alert(1)>'.padEnd(64))),
    dataUrl('image/png', PNG.subarray(0, 20)), 'data:image/png;base64,abc', '', null,
    dataUrl('image/png', Buffer.concat([PNG, Buffer.alloc(AFFILIATE_DOC_MAX_BYTES)])),
  ];
  for (const x of bad) assert.equal(parseDocumentDataUrl(x).ok, false, String(x).slice(0, 40));
});

test('تشفير المستند: AES-256-GCM مربوطٌ بصاحبه — العبث أو سفيرٌ آخر أو مفتاحٌ آخر ⇒ null، ومفتاحه غير مفتاح الآيبان', async () => {
  const { encryptDocument, decryptDocument } = await import('../services/affiliate/documents');
  const enc = encryptDocument(PNG, 'aff-1');
  assert.equal(enc.length, 12 + 16 + PNG.length);
  assert.ok(!enc.includes(PNG.subarray(8, 40)), 'لا نصّ صريح في المخزَّن');
  assert.ok(decryptDocument(enc, 'aff-1')!.equals(PNG));
  assert.notDeepEqual(encryptDocument(PNG, 'aff-1'), enc, 'متّجهٌ ابتدائيّ عشوائيّ');
  assert.equal(decryptDocument(enc, 'aff-2'), null, 'صفٌّ نُقل إلى سفيرٍ آخر لا يُفكّ');
  const flipped = Buffer.from(enc); flipped[flipped.length - 1] ^= 1;
  assert.equal(decryptDocument(flipped, 'aff-1'), null);
  assert.equal(decryptDocument(Buffer.alloc(10), 'aff-1'), null);
  process.env.AFFILIATE_DOC_KEY = crypto.randomBytes(32).toString('hex');
  try {
    assert.equal(decryptDocument(enc, 'aff-1'), null, 'AFFILIATE_DOC_KEY يُستعمل حين يُضبط');
    assert.ok(decryptDocument(encryptDocument(JPEG, 'aff-1'), 'aff-1')!.equals(JPEG));
  } finally { delete process.env.AFFILIATE_DOC_KEY; }
  const docs = strip(src('services', 'affiliate', 'documents.ts'));
  assert.match(docs, /`\$\{affiliateSecret\(\)\}::doc`/, 'مشتقٌّ بغرضٍ مستقلّ عن ::iban');
  assert.match(docs, /sniffAttachmentMime/, 'فحص البايتات نفسه في مرفقات المشتريات');
});

test('حدود دورة التسوية: نهايات 1 و11 و21 الساعة 00:00 بتوقيت الرياض', async () => {
  const { nextSettlementAt, cycleBounds } = await import('../services/affiliate/settlement');
  const iso = (d: Date) => d.toISOString();
  // ٥ نوفمبر ظهراً بالرياض ⇒ التالية ١١ نوفمبر 00:00 الرياض = ١٠ نوفمبر 21:00 UTC
  assert.equal(iso(nextSettlementAt(new Date('2026-11-05T09:00:00Z'))), '2026-11-10T21:00:00.000Z');
  assert.equal(iso(nextSettlementAt(new Date('2026-11-25T09:00:00Z'))), '2026-11-30T21:00:00.000Z', 'أوّل الشهر التالي');
  assert.equal(iso(nextSettlementAt(new Date('2026-12-28T09:00:00Z'))), '2026-12-31T21:00:00.000Z', 'عبر السنة');
  // اللحظة نفسها نهايةٌ مرّت ⇒ التالية بعدها
  assert.equal(iso(nextSettlementAt(new Date('2026-11-10T21:00:00Z'))), '2026-11-20T21:00:00.000Z');
  assert.equal(iso(nextSettlementAt(new Date('2026-11-10T20:59:59Z'))), '2026-11-10T21:00:00.000Z');
  const b = cycleBounds(new Date('2026-11-15T09:00:00Z'));
  assert.deepEqual({ k: b.cycleKey, s: iso(b.periodStart), e: iso(b.periodEnd) }, { k: '2026-11-11', s: '2026-10-31T21:00:00.000Z', e: '2026-11-10T21:00:00.000Z' });
  const jan = cycleBounds(new Date('2027-01-05T00:00:00Z'));
  assert.deepEqual({ k: jan.cycleKey, s: iso(jan.periodStart), e: iso(jan.periodEnd) }, { k: '2027-01-01', s: '2026-12-20T21:00:00.000Z', e: '2026-12-31T21:00:00.000Z' });
  // ٣١ ديسمبر 22:00 UTC = ١ يناير بالرياض
  assert.equal(cycleBounds(new Date('2026-12-31T22:00:00Z')).cycleKey, '2027-01-01');
});

test('أرقام الرئيسية: أرباح ٦ أشهر بتاريخ الدفعة بتوقيت الرياض، ومعدّل التحويل كسرٌ أو null، والمجاميع لا تقلّ عن صفر', async () => {
  const s = await import('../services/affiliate/portalStats');
  const now = new Date('2026-02-10T12:00:00Z');
  assert.deepEqual(s.lastMonths(now), ['2025-09', '2025-10', '2025-11', '2025-12', '2026-01', '2026-02']);
  assert.equal(s.monthsWindowStart(now).toISOString(), '2025-08-31T21:00:00.000Z');
  const rows = [
    { paymentPaidAt: new Date('2026-01-31T21:30:00Z'), commissionHalalas: 1000 }, // ١ فبراير بالرياض
    { paymentPaidAt: new Date('2026-01-31T20:00:00Z'), commissionHalalas: 200 },  // ما زال ٣١ يناير
    { paymentPaidAt: new Date('2025-09-01T00:00:00Z'), commissionHalalas: 300 },
    { paymentPaidAt: new Date('2025-08-15T00:00:00Z'), commissionHalalas: 999 },  // خارج النافذة
  ];
  assert.deepEqual(s.earningsByMonth(rows, now), [
    { month: '2025-09', halalas: 300 }, { month: '2025-10', halalas: 0 }, { month: '2025-11', halalas: 0 },
    { month: '2025-12', halalas: 0 }, { month: '2026-01', halalas: 200 }, { month: '2026-02', halalas: 1000 },
  ]);
  assert.equal(s.conversionRate(0, 0), null);
  assert.equal(s.conversionRate(1, 3), 0.3333);
  assert.equal(s.conversionRate(5, 4), 1, 'لا يتجاوز ١');
  assert.deepEqual(s.earningsTotals({ approvedHalalas: 1000, paidHalalas: 2000, allAdjustmentsHalalas: -200, openAdjustmentsHalalas: -300 }), { totalEarnedHalalas: 2800, pendingSettlementHalalas: 700 });
  assert.deepEqual(s.earningsTotals({ approvedHalalas: 0, paidHalalas: 0, allAdjustmentsHalalas: -500, openAdjustmentsHalalas: -500 }), { totalEarnedHalalas: 0, pendingSettlementHalalas: 0 });
  assert.deepEqual([...s.LIVE_COMMISSION_STATUSES], ['pending', 'on_hold', 'approved', 'paid']);
});

test('حرّاس الوصل: مسارات v2 خلف الجلسة والقبول، والمستندات مقيّدةٌ بصاحبها، ولا مسارات تأكيد', () => {
  const portal = strip(src('routes', 'affiliate.ts'));
  for (const r of [
    "router.post('/documents', axAuth, requireApproved, axDocLimiter,", "router.get('/documents/:kind', axAuth, requireApproved,",
    "router.delete('/documents/:kind', axAuth, requireApproved,", "router.post('/missed-claims', axAuth, requireApproved,",
    "router.get('/missed-claims', axAuth, requireApproved,", "router.post('/missed-claims/:id/withdraw', axAuth, requireApproved,",
    "router.get('/materials', axAuth, requireApproved,", "router.get('/materials/:id/file', axAuth, requireApproved,",
  ]) assert.ok(portal.includes(r), r);
  assert.doesNotMatch(portal, /'\/verify-email'|'\/resend-verification'/);
  // المراجعة #7: تنزيل الملفات (data URL في الذاكرة) بحدٍّ لكلّ سفير وسقفٍ للمتزامن — والعقد {dataUrl} كما هو
  for (const r of ["router.get('/documents/:kind', axAuth, requireApproved, axFileLimiter, fileSlot,", "router.get('/materials/:id/file', axAuth, requireApproved, axFileLimiter, fileSlot,"]) assert.ok(portal.includes(r), r);
  const fileLimiter = portal.slice(portal.indexOf('const axFileLimiter'), portal.indexOf('});', portal.indexOf('const axFileLimiter')));
  assert.match(fileLimiter, /keyGenerator: [^\n]*affiliate\?\.id/, 'لكلّ سفير بمعرّفه من التوكن');
  assert.match(fileLimiter, /limit: 60/);
  // مراجعة ١٨ نوفمبر: الإغلاق وحده لا يحرّر المقعد (قطعٌ فوري كان يتجاوز السقف) — إغلاق الردّ **و**انتهاء المعالج
  assert.match(portal, /res\.once\('close', onClosed\)/, 'إغلاق الردّ طرفٌ في التحرير');
  // المراجعة #1: فتح الحسابات وإعادة إرسال روابطها بحدٍّ لكلّ IP في يوم الرياض فوق حدّ السفير — بلا شرط الملف (قرار المالك)
  assert.ok(portal.includes("router.post('/trials', axAuth, requireApproved, axTrialLimiter, axTrialIpLimiter,"));
  assert.ok(portal.includes("router.post('/trials/:id/resend', axAuth, requireApproved, axTrialLimiter, axTrialResendIpLimiter,"));
  const ipLimiter = portal.slice(portal.indexOf('const trialIpLimiter'), portal.indexOf('});', portal.indexOf('const trialIpLimiter')));
  assert.match(ipLimiter, /keyGenerator: [^\n]*riyadhDay\(\)[^\n]*req\.ip/, 'مفتاحه IP ويوم الرياض');
  const trials = portal.slice(portal.indexOf("router.post('/trials'"), portal.indexOf("router.post('/trials/:id/withdraw'"));
  assert.doesNotMatch(trials, /profileCompletedAt|profileMissing|profileComplete/, 'الحساب التجريبي لا يُشترط له ملفٌّ مكتمل');
  assert.match(portal, /normalizeMissedClaim\(b\)/, 'رموز المطالبة الفائتة من تحقّق الخدمة نفسه');
  assert.match(portal, /documentDataUrl\(aid\(req\), kind\)/, 'المعاينة لصاحب التوكن وحده');
  assert.match(portal, /createMissedClaim\(id, /);
  assert.match(portal, /withdrawMissedClaim\(aid\(req\), /);
  const docs = strip(src('services', 'affiliate', 'documents.ts'));
  let n = 0;
  for (const m of docs.matchAll(/\.affiliateDocument\.(findMany|findFirst|deleteMany|create)\(\{\s*(?:data|where): \{([^}]*)/g)) {
    n++;
    assert.match(m[2], /affiliateId/, `استعلام مستندٍ بلا قيد صاحبه: ${m[0].slice(0, 80)}`);
  }
  assert.ok(n >= 5, `الحارس لم يلتقط الاستعلامات (${n})`);
  assert.match(docs, /FOR UPDATE/, 'قفل صفّ السفير: مستندٌ واحدٌ ساري لكل نوع');
});

// ═════════════════════════════ (٢) الموجّه فوق Prisma مزيّف ═════════════════════════════

type Row = Record<string, any>;
const db: Record<string, Row[]> = {
  affiliateUser: [], affiliateEvent: [], affiliateDocument: [], affiliateDocumentBlob: [], affiliatePayout: [], affiliateCommission: [],
  affiliateAdjustment: [], tenantAttribution: [], affiliateClickDaily: [], opsMarker: [], affiliateMissedClaim: [], affiliateMaterial: [],
  affiliateMaterialBlob: [],
};
const mailSubjects: string[] = [];

function cond(v: any, c: any): boolean {
  if (c === null) return v == null;
  if (c instanceof Date) return v instanceof Date && v.getTime() === c.getTime();
  if (typeof c !== 'object') return v === c;
  return Object.entries(c).every(([op, x]: [string, any]) => {
    switch (op) {
      case 'in': return x.includes(v);
      case 'not': return x === null ? v != null : (x && typeof x === 'object' && !(x instanceof Date)) ? !cond(v, x) : v !== x;
      case 'gte': return v != null && v >= x;
      case 'gt': return v != null && v > x;
      case 'lt': return v != null && v < x;
      case 'lte': return v != null && v <= x;
      default: throw new Error(`مرشّحٌ غير مدعوم في المزيّف: ${op}`);
    }
  });
}
function match(row: Row, where: any = {}): boolean {
  return Object.entries(where).every(([k, c]) => (k === 'OR' ? (c as any[]).some(w => match(row, w)) : cond(row[k], c)));
}
const BLOB: Record<string, [string, string]> = { affiliateDocument: ['affiliateDocumentBlob', 'documentId'], affiliateMaterial: ['affiliateMaterialBlob', 'materialId'] };
function pick(name: string, row: Row | null | undefined, select?: any): Row | null {
  if (!row) return null;
  const withRel = (r: Row) => {
    const rel = BLOB[name];
    return rel ? { ...r, blob: db[rel[0]].find(b => b[rel[1]] === r.id) ?? null } : { ...r };
  };
  if (!select) return { ...row };
  const full = withRel(row);
  const out: Row = {};
  for (const [k, v] of Object.entries(select)) if (v) out[k] = k === 'blob' && full.blob && typeof v === 'object' ? pick('blob', full.blob, (v as any).select) : full[k];
  return out;
}
function sorted(rows: Row[], orderBy: any): Row[] {
  const keys = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []).flatMap((o: any) => Object.entries(o));
  return [...rows].sort((a, b) => {
    for (const [k, dir] of keys as [string, string][]) {
      if (a[k] < b[k]) return dir === 'asc' ? -1 : 1;
      if (a[k] > b[k]) return dir === 'asc' ? 1 : -1;
    }
    return 0;
  });
}
function apply(r: Row, data: Row) {
  for (const [k, v] of Object.entries(data)) r[k] = v && typeof v === 'object' && 'increment' in v ? (r[k] ?? 0) + v.increment : v;
  r.updatedAt = new Date();
}
const DEFAULTS: Record<string, () => Row> = {
  affiliateUser: () => ({
    tokenVersion: 0, failedLogins: 0, lockedUntil: null, status: 'pending_email', emailVerifiedAt: null, ibanEnc: null, ibanLast4: null,
    ibanHolderName: null, bankName: null, payoutUpdatedAt: null, profileCompletedAt: null, partnerType: null, companyName: null,
    socialLinks: null, mawthooqExpiry: null, statusReason: null, city: null, vatNumber: null, lastMailAt: null, createdAt: new Date(), updatedAt: new Date(),
  }),
  affiliateMissedClaim: () => ({ status: 'under_review', reasonNote: null, reviewedAt: null, submittedAt: new Date() }),
};
function model(name: string) {
  const rows = db[name];
  const self: any = {
    findUnique: async ({ where, select }: any) => pick(name, rows.find(r => match(r, where)), select),
    findUniqueOrThrow: async (a: any) => { const r = await self.findUnique(a); if (!r) throw new Error('not found'); return r; },
    findFirst: async ({ where, orderBy, select }: any) => pick(name, sorted(rows.filter(r => match(r, where)), orderBy)[0], select),
    findMany: async ({ where, orderBy, select, take }: any = {}) =>
      sorted(rows.filter(r => match(r, where)), orderBy).slice(0, take ?? Infinity).map(r => pick(name, r, select)),
    count: async ({ where }: any = {}) => rows.filter(r => match(r, where)).length,
    create: async ({ data, select }: any) => {
      const { blob, ...plain } = data;
      if ((name === 'affiliateUser' && rows.some(r => r.email === plain.email || r.code === plain.code)) || (name === 'opsMarker' && rows.some(r => r.key === plain.key))) {
        const { Prisma } = await import('@prisma/client');
        throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test', meta: { target: ['email'] } });
      }
      const row: Row = { id: crypto.randomUUID(), createdAt: new Date(), ...(DEFAULTS[name]?.() ?? {}), ...plain };
      rows.push(row);
      if (blob?.create) db[BLOB[name][0]].push({ id: crypto.randomUUID(), [BLOB[name][1]]: row.id, ...blob.create });
      return pick(name, row, select);
    },
    update: async ({ where, data }: any) => {
      const r = rows.find(x => match(x, where));
      if (!r) throw new Error(`update: لا صفّ في ${name}`);
      apply(r, data);
      return { ...r };
    },
    updateMany: async ({ where, data }: any) => {
      const hits = rows.filter(r => match(r, where));
      hits.forEach(r => apply(r, data));
      return { count: hits.length };
    },
    deleteMany: async ({ where }: any) => {
      const gone = rows.filter(r => match(r, where));
      const keep = rows.filter(r => !gone.includes(r));
      rows.splice(0, rows.length, ...keep); // في مكانه — الإشارات إلى المصفوفة تبقى صالحة
      const rel = BLOB[name];
      if (rel) db[rel[0]].splice(0, db[rel[0]].length, ...db[rel[0]].filter(b => !gone.some(g => g.id === b[rel[1]])));
      return { count: gone.length };
    },
    delete: async ({ where }: any) => { const i = rows.findIndex(r => match(r, where)); if (i < 0) throw new Error('nf'); return rows.splice(i, 1)[0]; },
    aggregate: async ({ where, _sum }: any) => {
      const hits = rows.filter(r => match(r, where));
      return { _sum: Object.fromEntries(Object.keys(_sum).map(k => [k, hits.length ? hits.reduce((s, r) => s + (r[k] ?? 0), 0) : null])) };
    },
    groupBy: async ({ by, where }: any) => {
      const groups = new Map<string, Row[]>();
      for (const r of rows.filter(x => match(x, where))) groups.set(r[by[0]], [...(groups.get(r[by[0]]) ?? []), r]);
      return [...groups].map(([k, rs]) => ({ [by[0]]: k, _sum: { commissionHalalas: rs.reduce((s, r) => s + r.commissionHalalas, 0) }, _count: { _all: rs.length } }));
    },
  };
  return self;
}
function fakePrisma(): Record<string, unknown> {
  const f: Record<string, unknown> = {
    affiliateSettings: { findUnique: async () => null },
    affiliateTerms: { findUnique: async () => null },
    $queryRaw: async (strings: TemplateStringsArray, ...vals: unknown[]) => {
      const sql = strings.join('?');
      if (sql.includes('RETURNING "failedLogins"')) {
        const u = db.affiliateUser.find(r => r.id === vals[0] && (!r.lockedUntil || r.lockedUntil < new Date()));
        if (!u) return [];
        u.failedLogins += 1;
        return [{ failedLogins: u.failedLogins }];
      }
      return [];
    },
    $executeRaw: async () => 0,
  };
  for (const name of Object.keys(db)) f[name] = model(name);
  f.$transaction = async (fn: any) => (typeof fn === 'function' ? fn(f) : Promise.all(fn));
  return f;
}

let port = 0;
let server: http.Server;
const forwardLog = console.log.bind(console);

before(async () => {
  process.env.DATABASE_URL = 'postgresql://offline:offline@127.0.0.1:9/offline?connect_timeout=1';
  console.log = (...args: unknown[]) => {
    if (args[0] === '[mail] لم يضبط بريد SMTP/Resend تم تخطي') { mailSubjects.push(String(args[1])); return; }
    forwardLog(...args);
  };
  const prisma = (await import('../config/database')).default as unknown as Record<string, unknown>;
  Object.assign(prisma, fakePrisma());
  const router = (await import('../routes/affiliate')).default;
  const { errorHandler } = await import('../middleware/errorHandler');
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/affiliate', router);
  app.use(errorHandler);
  server = http.createServer(app);
  port = await new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
});

after(async () => {
  console.log = forwardLog;
  await new Promise(res => server.close(res));
});

async function call(method: string, url: string, body?: unknown, token?: string): Promise<{ status: number; json: any }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/affiliate${url}`, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}
const tick = () => new Promise(r => setTimeout(r, 30));
/** ينتظر شرطاً غير متزامن (بريدٌ يُرسل بعد الردّ) حتى ثانيتين */
async function waitFor(ok: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !ok(); i++) await new Promise(r => setTimeout(r, 20));
}
/** بريد «قُبل طلبك» لإرث pending_review (المراجعة #20) — عدّه يكشف من راسلناه */
const APPROVED_SUBJECT = 'قُبل طلبك — سفير فيلد سيلز';
const approvedMails = () => mailSubjects.filter(s => s === APPROVED_SUBJECT).length;

const REG = {
  fullName: 'سفيرة الاختبار', email: 'Amb.One@Example.com', phone: '0551234567', password: 'Secret#123',
  partnerType: 'individual', acceptTerms: true, termsVersion: '2026-11-v4', socialLinks: [{ platform: 'instagram', url: 'https://instagram.com/amb1' }],
};
let token = '';
let me: Row;

test('التسجيل فوريّ: 201 بجلسةٍ وحسابٍ approved بلا تأكيد بريد — وبريد ترحيبٍ للسفير و«سفير جديد» للمالك', async () => {
  const r = await call('POST', '/register', REG);
  assert.equal(r.status, 201, JSON.stringify(r.json));
  token = r.json.data.token;
  const { verifySession } = await import('../services/affiliate/core');
  assert.ok(verifySession(token), 'جلسةٌ صالحة فوراً');
  assert.equal(r.json.data.user.status, 'approved');
  assert.equal(r.json.data.user.partnerType, 'individual');
  assert.deepEqual(r.json.data.user.socialLinks, [{ platform: 'instagram', url: 'https://instagram.com/amb1' }]);
  me = db.affiliateUser.find(u => u.email === 'amb.one@example.com')!;
  assert.equal(me.status, 'approved');
  assert.equal(me.emailVerifiedAt, null);
  assert.ok(me.lastLoginAt instanceof Date);
  assert.ok(db.affiliateEvent.some(e => e.entityId === me.id && e.action === 'registered' && e.toState === 'approved'));
  await tick();
  assert.ok(mailSubjects.includes('أهلاً بك في برنامج سفير فيلد سيلز'), mailSubjects.join(' | '));
  assert.ok(mailSubjects.some(s => s.startsWith('سفير جديد: ')));
  assert.ok(!mailSubjects.some(s => s.includes('تأكيد')), 'لا بريد تأكيد');
});

test('البريد المسجَّل 409 «سجّل الدخول» بلا كتابةٍ فوق الحساب — والشركة بلا اسمها 400 — والشروط القديمة 409 terms_outdated', async () => {
  const hash = me.passwordHash;
  const dup = await call('POST', '/register', { ...REG, email: 'AMB.ONE@example.com', password: 'Other#4567' });
  assert.equal(dup.status, 409);
  assert.deepEqual({ code: dup.json.code, message: dup.json.message }, { code: 'email_taken', message: 'يوجد حساب بهذا البريد — سجّل الدخول' });
  assert.equal(me.passwordHash, hash, 'كلمة المرور كما هي');
  assert.equal(db.affiliateUser.length, 1);
  const co = await call('POST', '/register', { ...REG, email: 'co@example.com', partnerType: 'company' });
  assert.equal(co.status, 400);
  const old = await call('POST', '/register', { ...REG, email: 'old@example.com', termsVersion: '2026-09-v3' });
  assert.equal(old.status, 409);
  assert.equal(old.json.code, 'terms_outdated');
  const noType = await call('POST', '/register', { ...REG, email: 'nt@example.com', partnerType: undefined });
  assert.equal(noType.status, 400, 'النوع إلزاميّ');
  assert.equal(db.affiliateUser.length, 1);
});

test('الدخول يرقّي الإرث pending_* إلى approved بكلمة المرور الصحيحة وحدها', async () => {
  const { hashPassword } = await import('../services/affiliate/core');
  const legacy = await model('affiliateUser').create({ data: { email: 'legacy@example.com', code: 'LEGACY23', passwordHash: hashPassword('Legacy#123'), fullName: 'إرث', phone: '966551112222', termsVersion: '2026-11-v4', termsAcceptedAt: new Date(), status: 'pending_email' } });
  const wrong = await call('POST', '/login', { email: 'legacy@example.com', password: 'nope-nope' });
  assert.equal(wrong.status, 401);
  assert.equal(db.affiliateUser.find(u => u.id === legacy.id)!.status, 'pending_email', 'لا ترقية بكلمة مرورٍ خاطئة');
  const ok = await call('POST', '/login', { email: 'LEGACY@example.com', password: 'Legacy#123' });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.ok(ok.json.data.token);
  assert.equal(ok.json.data.user.status, 'approved');
  assert.equal(db.affiliateUser.find(u => u.id === legacy.id)!.status, 'approved');
  await tick();
  assert.ok(db.affiliateEvent.some(e => e.entityId === legacy.id && e.action === 'legacy_pending_promoted' && e.fromState === 'pending_email' && e.actorType === 'system'));
  assert.equal(approvedMails(), 0, 'pending_email لا يُراسَل: عنوانه لم تثبت ملكيّته');
});

test('إرث pending_review يُبلَّغ «قُبل طلبك» مرّةً عند ترقيته بالدخول (وعد v1 بالبريد) — ولا يتكرّر بدخولٍ لاحق', async () => {
  const { hashPassword } = await import('../services/affiliate/core');
  await model('affiliateUser').create({ data: { email: 'review@example.com', code: 'REVIEW23', passwordHash: hashPassword('Review#123'), fullName: 'مراجعة', phone: '966551113333', termsVersion: '2026-11-v4', termsAcceptedAt: new Date(), status: 'pending_review' } });
  const ok = await call('POST', '/login', { email: 'review@example.com', password: 'Review#123' });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.data.user.status, 'approved');
  await waitFor(() => approvedMails() === 1);
  assert.equal(approvedMails(), 1);
  const again = await call('POST', '/login', { email: 'review@example.com', password: 'Review#123' });
  assert.equal(again.status, 200);
  await tick();
  assert.equal(approvedMails(), 1, 'الترقية مرّةً واحدة فالبريد مرّةً واحدة');
});

test('ترقية الإقلاع مرّةً واحدة بعلامة ax-v2-instant وحدثٍ ملخّص', async () => {
  const { promoteLegacyPendingAffiliates, hashPassword } = await import('../services/affiliate/core');
  for (const [i, st] of (['pending_review', 'pending_email'] as const).entries()) {
    await model('affiliateUser').create({ data: { email: `boot${i}@example.com`, code: `BOOT${i}AAA`, passwordHash: hashPassword('x'.repeat(8)), fullName: 'إقلاع', termsVersion: '2026-11-v4', termsAcceptedAt: new Date(), status: st } });
  }
  await model('affiliateUser').create({ data: { email: 'susp@example.com', code: 'SUSP2345', passwordHash: 'x:y', fullName: 'موقوف', termsVersion: '2026-11-v4', termsAcceptedAt: new Date(), status: 'suspended' } });
  const mailsBefore = approvedMails();
  assert.equal(await promoteLegacyPendingAffiliates(), 2);
  // المراجعة #20: «قُبل طلبك» لـpending_review وحده (boot0) بعد الالتزام — لا لـpending_email (boot1) ولا للموقوف
  await waitFor(() => approvedMails() > mailsBefore);
  await tick();
  assert.equal(approvedMails() - mailsBefore, 1, 'بريدٌ واحد: من كان قيد المراجعة وحده');
  assert.equal(db.affiliateUser.filter(u => u.status === 'pending_email' || u.status === 'pending_review').length, 0);
  assert.equal(db.affiliateUser.find(u => u.email === 'susp@example.com')!.status, 'suspended', 'الموقوف لا يُمسّ');
  assert.deepEqual(db.opsMarker.map(m => [m.key, m.value]), [['ax-v2-instant', 'done:2']]);
  assert.ok(db.affiliateEvent.some(e => e.entityId === 'ax-v2-instant' && e.action === 'legacy_pending_promoted' && e.meta?.count === 2 && e.meta?.pendingReview === 1));
  assert.equal(await promoteLegacyPendingAffiliates(), null, 'نسخةٌ ثانية أو إقلاعٌ لاحق لا يعيد');
});

test('بريد «قُبل طلبك» أفضل جهد: لمن رقّاه النظام وحده، بفاصلٍ بين الرسائل، ولا يرمي أبداً', async () => {
  const { notifyLegacyReviewApproved, hashPassword } = await import('../services/affiliate/core');
  const mk = (email: string, code: string, extra: Row) => model('affiliateUser').create({ data: { email, code, passwordHash: hashPassword('x'.repeat(8)), fullName: 'ن', termsVersion: '2026-11-v4', termsAcceptedAt: new Date(), ...extra } });
  const sys1 = await mk('sys1@example.com', 'SYS1AAAA', { status: 'approved', reviewedBy: 'system' });
  const sys2 = await mk('sys2@example.com', 'SYS2AAAA', { status: 'approved', reviewedBy: 'system' });
  const owner = await mk('own@example.com', 'OWN1AAAA', { status: 'approved', reviewedBy: 'owner-1' });
  const rej = await mk('rej@example.com', 'REJ1AAAA', { status: 'rejected', reviewedBy: 'system' });
  const before = approvedMails();
  const started = Date.now();
  assert.equal(await notifyLegacyReviewApproved([sys1.id, owner.id, rej.id, sys2.id], 40), 2, 'قرار المالك يُرسل بريده بنفسه، والمرفوض لا يُبلَّغ بقبول');
  assert.ok(Date.now() - started >= 35, 'فاصلٌ بين الرسالتين');
  await tick();
  assert.equal(approvedMails() - before, 2);
  assert.equal(await notifyLegacyReviewApproved([]), 0);
  // قاعدةٌ معطّلة: لا يرمي (يُستدعى بـvoid بعد الالتزام وفي الدخول)
  const prisma = (await import('../config/database')).default as any;
  const orig = prisma.affiliateUser.findMany;
  prisma.affiliateUser.findMany = async () => { throw new Error('db down'); };
  const errLog = console.error;
  console.error = () => {};
  try {
    assert.equal(await notifyLegacyReviewApproved([sys1.id]), 0);
  } finally {
    prisma.affiliateUser.findMany = orig;
    console.error = errLog;
  }
});

test('/me: النوع والروابط والمستندات واكتمال الملف وما ينقصه، والتسوية القادمة كل ١٠ أيام، والرابط الجديد', async () => {
  const r = await call('GET', '/me', undefined, token);
  assert.equal(r.status, 200);
  const d = r.json.data;
  assert.equal(d.user.partnerType, 'individual');
  assert.deepEqual(d.user.documents, []);
  assert.equal(d.user.profileComplete, false);
  assert.deepEqual(d.user.missing, ['iban', 'national_id']);
  assert.equal(d.settings.settlementEveryDays, 10);
  assert.equal(d.settings.holdDays, 10);
  assert.equal(d.settings.minPayoutHalalas, 5000);
  const { nextSettlementAt } = await import('../services/affiliate/settlement');
  assert.equal(d.settings.nextSettlementAt, nextSettlementAt().toISOString());
  assert.equal(d.link, `https://fieldsa.net/signup?ref=${me.code}`);
  assert.equal(d.canSetPayout, true, 'لا شرط «بعد أوّل عمولة»');
});

test('بيانات الاستلام متاحةٌ بلا عمولة — والآيبان يُدخل اكتمال الملف', async () => {
  assert.equal(db.affiliateCommission.length, 0);
  const bad = await call('PUT', '/payout-profile', { iban: 'SA0380000000608010167518', holderName: 'سفيرة' }, token);
  assert.equal(bad.status, 400, 'mod-97 كما هو');
  const r = await call('PUT', '/payout-profile', { iban: 'SA03 8000 0000 6080 1016 7519', holderName: 'سفيرة الاختبار' }, token);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.data.user.payout.ibanLast4, '7519');
  assert.ok(me.ibanEnc && !String(me.ibanEnc).includes('SA03'));
  assert.equal(me.profileCompletedAt, null, 'ينقصه صورة الهوية بعد');
});

test('المستندات: رفعٌ مشفّر يستبدل سابقه، ومعاينةٌ لصاحبه وحده، وحذفٌ حقيقيّ — واكتمال الملف يُختم ويُمسح', async () => {
  const up = await call('POST', '/documents', { kind: 'national_id', dataUrl: dataUrl('image/png', PNG) }, token);
  assert.equal(up.status, 201, JSON.stringify(up.json));
  assert.deepEqual({ kind: up.json.data.kind, mime: up.json.data.mime, size: up.json.data.sizeBytes }, { kind: 'national_id', mime: 'image/png', size: PNG.length });
  const blob = db.affiliateDocumentBlob[0];
  assert.ok(Buffer.isBuffer(blob.enc) && !blob.enc.includes(PNG.subarray(8, 40)), 'البايتات مشفّرة');
  assert.ok(me.profileCompletedAt instanceof Date, 'فرد + آيبان + هوية = مكتمل');
  assert.ok(db.affiliateEvent.some(e => e.entityId === me.id && e.action === 'profile_completed'));
  const view = await call('GET', '/documents/national_id', undefined, token);
  assert.equal(view.status, 200);
  assert.equal(view.json.data.dataUrl, dataUrl('image/png', PNG));
  const lie = await call('POST', '/documents', { kind: 'national_id', dataUrl: dataUrl('image/png', PDF) }, token);
  assert.equal(lie.status, 400);
  assert.equal(lie.json.code, 'document_invalid');
  const again = await call('POST', '/documents', { kind: 'national_id', dataUrl: dataUrl('image/jpeg', JPEG) }, token);
  assert.equal(again.status, 201);
  assert.equal(db.affiliateDocument.filter(d => d.affiliateId === me.id && d.kind === 'national_id').length, 1, 'مستندٌ واحدٌ ساري لكل نوع');
  assert.equal(db.affiliateDocumentBlob.length, 1, 'البايتات القديمة حُذفت معه');
  assert.ok(db.affiliateEvent.some(e => e.entity === 'document' && e.action === 'replaced'));
  // سفيرٌ آخر لا يرى مستند غيره: المعرّف من التوكن
  const { signSession } = await import('../services/affiliate/core');
  const other = db.affiliateUser.find(u => u.email === 'legacy@example.com')!;
  const otherToken = signSession(other.id, other.tokenVersion);
  assert.equal((await call('GET', '/documents/national_id', undefined, otherToken)).status, 404);
  assert.equal((await call('GET', '/documents/commercial_reg', undefined, token)).status, 404);
  assert.equal((await call('GET', '/documents/passport', undefined, token)).status, 400);
  assert.equal((await call('GET', '/documents/national_id')).status, 401, 'بلا جلسة');
  const meR = await call('GET', '/me', undefined, token);
  assert.deepEqual(meR.json.data.user.documents.map((d: Row) => [d.kind, d.mime]), [['national_id', 'image/jpeg']]);
  assert.equal(meR.json.data.user.profileComplete, true);
  const del = await call('DELETE', '/documents/national_id', undefined, token);
  assert.equal(del.status, 200);
  assert.equal(me.profileCompletedAt, null, 'نقص الملف يمسح الختم');
  assert.equal(db.affiliateDocumentBlob.length, 0, 'حذفٌ حقيقيّ');
  assert.equal((await call('DELETE', '/documents/national_id', undefined, token)).status, 404);
});

test('PUT /me: النوع واسم الشركة وروابط التواصل — والشركة تحتاج سجلّها التجاري لاكتمال ملفها', async () => {
  const noName = await call('PUT', '/me', { partnerType: 'company' }, token);
  assert.equal(noName.status, 400, 'الشركة بلا اسمها');
  const badLink = await call('PUT', '/me', { socialLinks: [{ platform: 'x', url: 'javascript:alert(1)' }] }, token);
  assert.equal(badLink.status, 400);
  await call('POST', '/documents', { kind: 'national_id', dataUrl: dataUrl('application/pdf', PDF) }, token);
  assert.ok(me.profileCompletedAt instanceof Date);
  const r = await call('PUT', '/me', { partnerType: 'company', companyName: ' مؤسسة السفير ', socialLinks: [{ platform: 'linkedin', url: 'https://linkedin.com/company/x' }] }, token);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.data.user.companyName, 'مؤسسة السفير');
  assert.equal(r.json.data.user.profileCompletedAt, null, 'تغيير النوع إلى شركة يُنقص الملف حتى السجل');
  const m = await call('GET', '/me', undefined, token);
  assert.deepEqual(m.json.data.user.missing, ['commercial_reg']);
  await call('POST', '/documents', { kind: 'commercial_reg', dataUrl: dataUrl('image/webp', WEBP) }, token);
  assert.ok(me.profileCompletedAt instanceof Date);
  const clear = await call('PUT', '/me', { socialLinks: null }, token);
  assert.deepEqual(clear.json.data.user.socialLinks, []);
});

test('/payouts: كلّ دفعاته عدا الملغاة بحقول الدورة وسبب الفشل — ودفعات غيره لا تظهر', async () => {
  const base = { affiliateId: me.id, commissionsHalalas: 9000, adjustmentsHalalas: -1000, netHalalas: 8000, ibanLast4: '7519', holderName: 'س', createdBy: 'system', transferredAt: null, bankReference: null, failedReason: null, periodStart: null, periodEnd: null };
  const t = (d: string) => new Date(d);
  db.affiliatePayout.push(
    { ...base, id: 'p-draft', status: 'draft', createdAt: t('2026-11-11T00:00:00Z'), periodStart: t('2026-10-31T21:00:00Z'), periodEnd: t('2026-11-10T21:00:00Z') },
    { ...base, id: 'p-rec', status: 'recorded', createdAt: t('2026-11-01T00:00:00Z'), transferredAt: t('2026-11-02T00:00:00Z'), bankReference: 'TRX-1' },
    { ...base, id: 'p-void', status: 'void', createdAt: t('2026-10-01T00:00:00Z') },
    { ...base, id: 'p-fail', status: 'failed', createdAt: t('2026-10-21T00:00:00Z'), failedReason: 'الآيبان مغلق' },
    { ...base, id: 'p-other', affiliateId: 'someone-else', status: 'recorded', createdAt: t('2026-11-05T00:00:00Z') },
  );
  const r = await call('GET', '/payouts', undefined, token);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.data.map((p: Row) => [p.id, p.status]), [['p-draft', 'draft'], ['p-rec', 'recorded'], ['p-fail', 'failed']]);
  const draft = r.json.data[0];
  for (const k of ['id', 'status', 'commissionsHalalas', 'adjustmentsHalalas', 'netHalalas', 'periodStart', 'periodEnd', 'transferredAt', 'bankReference', 'ibanLast4', 'failedReason']) assert.ok(k in draft, k);
  assert.equal(draft.periodEnd, '2026-11-10T21:00:00.000Z');
  assert.equal(r.json.data[2].failedReason, 'الآيبان مغلق');
  // مسودّةٌ قائمة ⇒ تغيير الآيبان 409 كما هو
  assert.equal((await call('PUT', '/payout-profile', { iban: 'SA0380000000608010167519', holderName: 'سفيرة' }, token)).status, 409);
});

test('/dashboard: الإجماليّ صافياً، والتسوية المعلّقة، والإحالات النشطة، والتحويل، وأرباح ٦ أشهر، والتسوية القادمة، والخطوات', async () => {
  const now = new Date();
  const c = (status: string, h: number, daysAgo = 1) => ({ id: crypto.randomUUID(), affiliateId: me.id, status, commissionHalalas: h, paymentPaidAt: new Date(now.getTime() - daysAgo * 86_400_000), createdAt: now });
  db.affiliateCommission.push(c('approved', 1000), c('paid', 2000), c('pending', 500), c('reversed', 999), c('declined', 777), { ...c('paid', 4000), affiliateId: 'someone-else' });
  db.affiliateAdjustment.push(
    { id: 'a1', affiliateId: me.id, amountHalalas: -300, payoutId: null },
    { id: 'a2', affiliateId: me.id, amountHalalas: 100, payoutId: 'p-rec' },
    { id: 'a3', affiliateId: me.id, amountHalalas: 50, payoutId: 'p-draft' },
  );
  db.tenantAttribution.push(...['active', 'active', 'void', 'disputed'].map(status => ({ id: crypto.randomUUID(), affiliateId: me.id, status })));
  const r = await call('GET', '/dashboard', undefined, token);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const d = r.json.data;
  assert.equal(d.signups, 3, 'غير الملغاة');
  assert.equal(d.activeReferrals, 2);
  assert.equal(d.paidCompanies, 3, 'الحيّة: معلّقة/معتمدة/مدفوعة');
  assert.equal(d.conversionRate, 1);
  assert.equal(d.totalEarnedHalalas, 1000 + 2000 - 300 + 100 + 50, 'المعتمد + المدفوع + كلّ القيود');
  assert.equal(d.pendingSettlementHalalas, 1000 - 300 + 50, 'المعتمد + القيود غير المسوّاة (بلا دفعة أو في مسودّة)');
  assert.equal(d.adjustmentsHalalas, -250, 'الحقل القديم كما هو');
  assert.equal(d.earningsByMonth.length, 6);
  assert.equal(d.earningsByMonth.reduce((s: number, m: Row) => s + m.halalas, 0), 3500, 'الحيّة وحدها، وله وحده');
  const { nextSettlementAt } = await import('../services/affiliate/settlement');
  assert.equal(d.nextSettlementAt, nextSettlementAt().toISOString());
  assert.deepEqual(d.steps, { account: true, shared: true, firstPaid: true });
});

test('المطالبة بإحالة فائتة: إنشاءٌ بلا بيانات اتصالٍ في الاسم والملاحظة، وقائمته، وسحب ما تحت المراجعة وحده', async () => {
  // المراجعة #13 و#21: رموز API.md على ردود 400 — كانت بلا رمز
  const bad = await call('POST', '/missed-claims', { companyName: 'مؤسسة الضوء', note: 'كلّمت المدير 0551234567' }, token);
  assert.deepEqual([bad.status, bad.json.code], [400, 'contact_in_text']);
  const badName = await call('POST', '/missed-claims', { companyName: 'مؤسسة الضوء info@daw.sa' }, token);
  assert.deepEqual([badName.status, badName.json.code], [400, 'contact_in_text']);
  const badCr = await call('POST', '/missed-claims', { companyName: 'مؤسسة الضوء', crNumber: '123' }, token);
  assert.deepEqual([badCr.status, badCr.json.code], [400, 'invalid_cr']);
  const badPhone = await call('POST', '/missed-claims', { companyName: 'مؤسسة الضوء', contactPhone: '12' }, token);
  assert.deepEqual([badPhone.status, badPhone.json.code], [400, 'invalid_phone']);
  const shortName = await call('POST', '/missed-claims', { companyName: 'م' }, token);
  assert.deepEqual([shortName.status, shortName.json.code], [400, 'invalid']);
  assert.ok(Array.isArray(shortName.json.errors?.companyName), 'حقول zod باقية فتُترجم رسالة الحقل في البوابة');
  assert.equal(db.affiliateMissedClaim.length, 0, 'لا كتابة في أيٍّ منها');
  const ok = await call('POST', '/missed-claims', { companyName: 'مؤسسة الضوء', contactPhone: '0551234567', crNumber: '1010101010', note: 'سجّلوا قبل أن يفتحوا رابطي' }, token);
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  const row = db.affiliateMissedClaim.find(x => x.id === ok.json.data.id)!;
  assert.deepEqual([row.affiliateId, row.contactPhone, row.crNumber, row.status], [me.id, '966551234567', '1010101010', 'under_review']);
  const list = await call('GET', '/missed-claims', undefined, token);
  assert.deepEqual(list.json.data.map((x: Row) => x.id), [row.id]);
  const other = db.affiliateUser.find(u => u.email === 'legacy@example.com')!;
  const { signSession } = await import('../services/affiliate/core');
  const otherToken = signSession(other.id, other.tokenVersion);
  assert.equal((await call('POST', `/missed-claims/${row.id}/withdraw`, {}, otherToken)).status, 404, 'مطالبة غيره لا تُسحب ولا يُكشف وجودها');
  assert.deepEqual((await call('GET', '/missed-claims', undefined, otherToken)).json.data, []);
  assert.equal((await call('POST', `/missed-claims/${row.id}/withdraw`, {}, token)).status, 200);
  assert.equal(row.status, 'withdrawn');
  const again = await call('POST', `/missed-claims/${row.id}/withdraw`, {}, token);
  assert.deepEqual([again.status, again.json.code], [409, 'not_under_review']);
});

test('حدّ المطالبات المفتوحة: 429 too_many_open_missed_claims — وسباق إرسالين (409 open_limit من الخدمة) يُردّ بالرمز نفسه', async () => {
  const VALID = { companyName: 'مؤسسة الحدّ' };
  const open = Array.from({ length: 20 }, (_, i) => ({ id: `mc-open-${i}`, affiliateId: me.id, companyName: `م${i}`, status: 'under_review', submittedAt: new Date() }));
  db.affiliateMissedClaim.push(...open);
  try {
    const full = await call('POST', '/missed-claims', VALID, token);
    assert.deepEqual([full.status, full.json.code], [429, 'too_many_open_missed_claims']);
  } finally {
    db.affiliateMissedClaim.splice(0, db.affiliateMissedClaim.length, ...db.affiliateMissedClaim.filter(c => !String(c.id).startsWith('mc-open-')));
  }
  // عدّ المسار يرى ١٩ والخدمة ترى ٢٠ (إرسالٌ متزامن سبقه)
  const prisma = (await import('../config/database')).default as any;
  const orig = prisma.affiliateMissedClaim.count;
  let calls = 0;
  prisma.affiliateMissedClaim.count = async () => (++calls === 1 ? 19 : 20);
  try {
    const race = await call('POST', '/missed-claims', VALID, token);
    assert.deepEqual([race.status, race.json.code], [429, 'too_many_open_missed_claims']);
    assert.equal(calls, 2, 'وصل فحص الخدمة');
  } finally {
    prisma.affiliateMissedClaim.count = orig;
  }
  assert.ok(!db.affiliateMissedClaim.some(c => c.companyName === 'مؤسسة الحدّ'));
});

test('المواد التسويقية: القائمة بلا بايتات، والملف data URL، والمفقود 404', async () => {
  db.affiliateMaterial.push(
    { id: 'm1', title: 'بطاقة', category: 'image', fileName: 'card.png', mime: 'image/png', sizeBytes: PNG.length, url: null, textBody: null, sortOrder: 1, createdBy: 'o', createdAt: new Date() },
    { id: 'm2', title: 'نصّ جاهز', category: 'text', fileName: null, mime: null, sizeBytes: null, url: null, textBody: 'جرّب فيلد سيلز', sortOrder: 0, createdBy: 'o', createdAt: new Date() },
  );
  db.affiliateMaterialBlob.push({ id: 'b1', materialId: 'm1', bytes: PNG });
  const list = await call('GET', '/materials', undefined, token);
  assert.equal(list.status, 200);
  assert.deepEqual(list.json.data.map((m: Row) => m.id), ['m2', 'm1']);
  assert.ok(!('blob' in list.json.data[1]) && !('bytes' in list.json.data[1]));
  const f = await call('GET', '/materials/m1/file', undefined, token);
  assert.equal(f.json.data.dataUrl, dataUrl('image/png', PNG));
  assert.equal((await call('GET', '/materials/m2/file', undefined, token)).status, 404, 'النصّ بلا ملف');
  assert.equal((await call('GET', '/materials/nope/file', undefined, token)).status, 404);
});

// ═════════════════════════════ إصلاحات المراجعة (#18 و#1 و#7) ═════════════════════════════

/** جلسةٌ لسفيرٍ قائم في المزيّف ببريده */
async function tokenOf(email: string): Promise<string> {
  const { signSession } = await import('../services/affiliate/core');
  const u = db.affiliateUser.find(x => x.email === email)!;
  assert.equal(u.status, 'approved', email);
  return signSession(u.id, u.tokenVersion);
}

test('/companies: refVia (رابط/رمز مكتوب) للتسجيل الذاتيّ وحده فيعمل عمود «الطريقة» — وغيره null', async () => {
  const b0 = db.affiliateUser.find(u => u.email === 'boot0@example.com')!;
  const at = (id: string, source: string, refVia: string | null, mins: number) => ({
    id, affiliateId: b0.id, tenantId: `t-${id}`, tenantNameSnapshot: id, source, refVia, status: 'active',
    createdAt: new Date(Date.now() - mins * 60_000), firstPaymentDeadline: new Date(Date.now() + 90 * 86_400_000),
  });
  db.tenantAttribution.push(at('via-link', 'signup_code', 'link', 1), at('via-typed', 'signup_code', 'typed', 2), at('via-old', 'signup_code', null, 3), at('via-claim', 'claim', 'link', 4));
  const r = await call('GET', '/companies', undefined, await tokenOf('boot0@example.com'));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(Object.fromEntries(r.json.data.map((c: Row) => [c.tenantName, c.refVia])), { 'via-link': 'link', 'via-typed': 'typed', 'via-old': null, 'via-claim': null });
  assert.ok(r.json.data.every((c: Row) => !('tenantId' in c)), 'معرّف الشركة لا يصل السفير');
});

test('فتح الحسابات: ١٠ لكلّ IP في يوم الرياض عبر كلّ الحسابات (لا يتجاوزه حسابٌ جديد) — وإعادة الإرسال بعدّادٍ منفصل', async () => {
  const saved = process.env.AX_PORTAL_TRIAL_ENABLED;
  // المفتاح مطفأ: المعالج يردّ 403 بلا أيّ كتابة — والمحدِّدان قبله يعدّان كلّ طلب
  process.env.AX_PORTAL_TRIAL_ENABLED = '0';
  try {
    const accounts = await Promise.all(['amb.one@example.com', 'legacy@example.com', 'boot0@example.com'].map(tokenOf));
    for (let i = 0; i < 10; i++) {
      const r = await call('POST', '/trials', {}, accounts[i % 3]);
      assert.deepEqual([r.status, r.json.code], [403, 'portal_trial_disabled'], `#${i + 1}`);
    }
    const fresh = await tokenOf('boot1@example.com');
    const capped = await call('POST', '/trials', {}, fresh);
    assert.deepEqual([capped.status, capped.json.code], [429, 'trial_ip_daily_cap'], 'حسابٌ آخر من الشبكة نفسها لا يفتح عدّاداً جديداً');
    assert.match(capped.json.message, /حاول غداً/);
    for (let i = 0; i < 10; i++) {
      const r = await call('POST', '/trials/at-x/resend', {}, accounts[i % 3]);
      assert.equal(r.status, 403, `إعادة الإرسال #${i + 1} لا تأكل عدّاد الفتح`);
    }
    const resendCapped = await call('POST', '/trials/at-x/resend', {}, fresh);
    assert.deepEqual([resendCapped.status, resendCapped.json.code], [429, 'trial_ip_daily_cap']);
    // السحب خارج المحدِّد: سحب حسابٍ فُتح بخطأ متاحٌ دائماً
    assert.equal((await call('POST', '/trials/at-x/withdraw', {}, fresh)).status, 404, 'يصل المعالج (لا 429)');
  } finally {
    if (saved === undefined) delete process.env.AX_PORTAL_TRIAL_ENABLED; else process.env.AX_PORTAL_TRIAL_ENABLED = saved;
  }
});

test('تنزيل الملفات: سقف المتزامن (٢ لكلّ سفير و٤ للخادم) يُحرَّر بانتهاء الردّ — والعقد {dataUrl} كما هو', async () => {
  const prisma = (await import('../config/database')).default as any;
  const orig = prisma.affiliateMaterial.findUnique;
  let waiting = 0;
  let open!: () => void;
  const gate = new Promise<void>(r => { open = r; });
  prisma.affiliateMaterial.findUnique = async (a: unknown) => { waiting++; await gate; return orig(a); };
  try {
    const [a, b, c] = await Promise.all(['amb.one@example.com', 'legacy@example.com', 'boot0@example.com'].map(tokenOf));
    const held = [call('GET', '/materials/m1/file', undefined, a), call('GET', '/materials/m1/file', undefined, a)];
    await waitFor(() => waiting === 2);
    const third = await call('GET', '/materials/m1/file', undefined, a);
    assert.deepEqual([third.status, third.json.code], [429, 'file_busy'], 'الثالث المتزامن من السفير نفسه');
    held.push(call('GET', '/materials/m1/file', undefined, b), call('GET', '/materials/m1/file', undefined, b));
    await waitFor(() => waiting === 4);
    const global = await call('GET', '/documents/national_id', undefined, c);
    assert.deepEqual([global.status, global.json.code], [429, 'file_busy'], 'الخادم كلّه: أربعة');
    open();
    for (const r of await Promise.all(held)) {
      assert.equal(r.status, 200);
      assert.equal(r.json.data.dataUrl, dataUrl('image/png', PNG));
    }
  } finally {
    prisma.affiliateMaterial.findUnique = orig;
  }
  await tick();
  const c = await tokenOf('boot0@example.com');
  assert.equal((await call('GET', '/materials/m1/file', undefined, c)).status, 200, 'المقاعد حُرّرت');
  assert.equal((await call('GET', '/documents/national_id', undefined, c)).status, 404);
});

test('تنزيل الملفات: قطع الطلب فوراً لا يُعيد المقعد والمعالج ما زال يحمّل الملف (مراجعة ١٨ نوفمبر) — يُحرَّر بانتهائهما معاً', async () => {
  const prisma = (await import('../config/database')).default as any;
  const orig = prisma.affiliateMaterial.findUnique;
  let waiting = 0;
  let open!: () => void;
  const gate = new Promise<void>(r => { open = r; });
  prisma.affiliateMaterial.findUnique = async (a: unknown) => { waiting++; await gate; return orig(a); };
  const a = await tokenOf('amb.one@example.com');
  const aborted: Promise<unknown>[] = [];
  try {
    for (let i = 0; i < 2; i++) {
      const ac = new AbortController();
      aborted.push(fetch(`http://127.0.0.1:${port}/api/affiliate/materials/m1/file`, { headers: { authorization: `Bearer ${a}` }, signal: ac.signal }).catch(() => null));
      await waitFor(() => waiting === i + 1);
      ac.abort();
    }
    await Promise.all(aborted);
    await tick();
    const third = await call('GET', '/materials/m1/file', undefined, a);
    assert.deepEqual([third.status, third.json.code], [429, 'file_busy'], 'المعالجان ما زالا يعملان ⇒ المقعدان محجوزان رغم القطع');
  } finally {
    open();
    prisma.affiliateMaterial.findUnique = orig;
  }
  await tick();
  assert.equal((await call('GET', '/materials/m1/file', undefined, a)).status, 200, 'انتهى المعالجان ⇒ حُرّر المقعدان');
});

test('مصدر: مقعد التنزيل يُحرَّر في finally كلّ معالج وبمهلة إرسال', () => {
  const code = src('routes', 'affiliate.ts');
  assert.equal((code.match(/finally \{ releaseFileSlot\(res\); \}/g) ?? []).length, 2, 'المساران خلف fileSlot');
  assert.ok(code.includes('res.setTimeout(FILE_SEND_DEADLINE_MS, () => res.destroy())'));
  assert.ok(!/res\.once\('close', release\)/.test(code), 'لا تحرير بإغلاق الردّ وحده');
});

test('تنزيل الملفات: ٦٠ في الساعة لكلّ سفير (المواد والمستندات بعدّادٍ واحد) — وسفيرٌ آخر لا يتأثّر', async () => {
  const t = await tokenOf('boot1@example.com');
  for (let i = 0; i < 60; i++) {
    const r = await call('GET', i % 2 ? '/materials/m1/file' : '/documents/national_id', undefined, t);
    assert.ok(r.status === 200 || r.status === 404, `#${i + 1}: ${r.status}`);
  }
  const over = await call('GET', '/materials/m1/file', undefined, t);
  assert.equal(over.status, 429);
  assert.match(over.json.message, /تنزيلاتٌ كثيرة من حسابك/);
  assert.equal((await call('GET', '/materials/m1/file', undefined, token)).status, 200, 'العدّاد لكلّ سفير لا لكلّ IP');
});

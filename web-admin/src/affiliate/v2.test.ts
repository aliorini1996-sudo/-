import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  barHeights, formatBytes, formatPercent, inviteText, listJoin, monthLabel, periodLabel, safeHttpUrl, sarCompact,
  supportWhatsappUrl, SUPPORT_WHATSAPP,
} from './format';
import { base64Bytes, dataUrlParts, dataUrlToBlob, docFileError, needsDownscale, safeFileName, DOC_MAX_BYTES } from './files';
import { dashboardView } from './dashboard';
import { profileProgress, needsCommercialReg } from './profile';
import { AX_DICT } from './i18n';
import { FAQ_KEYS } from './faq';

/**
 * حرّاس بوابة السفير v2 (قرار المالك ١٨ نوفمبر ٢٠٢٦ — docs/affiliate/V2_SPEC.md §3 و§6.1 و§7):
 * التنسيق الجديد، ومستندات «ملفي»، وقراءة لوحة الرئيسية، واكتمال الملف، وشاشاتٌ تُقرأ نصّاً.
 */

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('نصّ المشاركة الجاهز: الإفصاح أولاً ثم الدعوة ثم الرابط — بلا أسطر فارغة', () => {
  assert.equal(inviteText('إفصاح', 'جرّب:', 'https://fieldsa.net/signup?ref=AB12'), 'إفصاح\nجرّب:\nhttps://fieldsa.net/signup?ref=AB12');
  assert.equal(inviteText('', ' ', 'L'), 'L');
  assert.equal(inviteText(' إفصاح ', '', 'L'), 'إفصاح\nL');
});

test('الشهر المختصر ميلاديٌّ بلغة العرض، والقيمة غير الصالحة تُعرض كما هي', () => {
  assert.match(monthLabel('2026-11', 'en'), /^Nov/);
  assert.match(monthLabel('2026-01', 'fr'), /janv/i);
  assert.equal(monthLabel('2026-11', 'ar'), 'نوفمبر');
  assert.equal(monthLabel('bad', 'en'), 'bad');
  assert.doesNotMatch(monthLabel('2026-11', 'ar'), /[٠-٩]/);
});

test('معدل التحويل والحجم والأعمدة', () => {
  assert.equal(formatPercent(0.125), '12.5%');
  assert.equal(formatPercent(0.5), '50%');
  assert.equal(formatPercent(1.7), '100%', 'لا يتجاوز 100%');
  assert.equal(formatPercent(null), '—');
  assert.equal(formatPercent(Number.NaN), '—');
  assert.equal(formatBytes(850 * 1024), '850 KB');
  assert.equal(formatBytes(2.4 * 1024 * 1024), '2.4 MB');
  assert.equal(formatBytes(0), '1 KB');
  assert.deepEqual(barHeights([0, 50, 100, -20]), [0, 50, 100, 0]);
  assert.deepEqual(barHeights([1, 1000]), [4, 100], 'القيمة الصغيرة تُرى');
  assert.deepEqual(barHeights([0, 0]), [0, 0]);
  assert.equal(sarCompact(98_000), '980');
  assert.equal(sarCompact(123_456), '1.2k');
  assert.equal(sarCompact(500_000_000), '5M');
});

test('فترة التسوية: نهاية الدورة حصرية فيُعرض اليوم الذي قبلها بتوقيت الرياض', () => {
  // دورة 1→11 نوفمبر: البداية 2026-10-31T21:00Z (منتصف ليل 1 نوفمبر بالرياض) والنهاية 2026-11-10T21:00Z
  const label = periodLabel('2026-10-31T21:00:00.000Z', '2026-11-10T21:00:00.000Z', 'en');
  assert.match(label, /^1 November 2026 – 10 November 2026$/);
  assert.equal(periodLabel(null, null, 'en'), '—');
  assert.match(periodLabel(null, '2026-11-10T21:00:00.000Z', 'en'), /^10 November 2026$/);
});

test('الروابط الخارجية: http(s) وحده يصل href', () => {
  assert.equal(safeHttpUrl('https://youtu.be/x'), 'https://youtu.be/x');
  assert.equal(safeHttpUrl(' http://a.sa/p?q=1 '), 'http://a.sa/p?q=1');
  for (const bad of ['javascript:alert(1)', 'data:text/html,x', '//evil.com', 'ftp://a', '', null]) assert.equal(safeHttpUrl(bad), null, String(bad));
});

test('واتساب الدعم الرسميّ 966506061608 بنصٍّ أوّل مُرمَّز', () => {
  assert.equal(SUPPORT_WHATSAPP, '966506061608');
  assert.equal(supportWhatsappUrl('مرحباً & أهلاً'), `https://wa.me/966506061608?text=${encodeURIComponent('مرحباً & أهلاً')}`);
  assert.equal(supportWhatsappUrl(''), 'https://wa.me/966506061608');
});

test('القائمة بأداة العطف بلغة العرض', () => {
  assert.equal(listJoin(['a', 'b'], 'en'), 'a and b');
  assert.equal(listJoin(['أ'], 'ar'), 'أ');
  assert.equal(listJoin([], 'fr'), '');
});

test('مستندات «ملفي»: صورة أو PDF ≤ ٥ ميغابايت، والصورة الكبيرة أو HEIC تُصغَّر قبل الرفع', () => {
  assert.equal(DOC_MAX_BYTES, 5 * 1024 * 1024);
  assert.equal(docFileError({ type: 'image/jpeg', size: 9 * 1024 * 1024 }), null, 'الصورة الكبيرة تُصغَّر لا تُرفض');
  assert.equal(docFileError({ type: 'image/heic', size: 3_000_000 }), null);
  assert.equal(docFileError({ type: 'application/pdf', size: 4_000_000 }), null);
  assert.deepEqual(docFileError({ type: 'application/pdf', size: DOC_MAX_BYTES + 1 }), { key: 'val.docTooLarge', vars: { max: 5 } });
  assert.deepEqual(docFileError({ type: 'image/svg+xml', size: 10 }), { key: 'val.docType' }, 'SVG نصٌّ قد يحمل سكربتاً');
  assert.deepEqual(docFileError({ type: 'text/plain', size: 10 }), { key: 'val.docType' });
  assert.deepEqual(docFileError({ type: '', size: 10 }), { key: 'val.docType' });
  assert.equal(needsDownscale({ type: 'image/jpeg', size: 800_000 }), false);
  assert.equal(needsDownscale({ type: 'image/jpeg', size: 4_000_000 }), true);
  assert.equal(needsDownscale({ type: 'image/heic', size: 500_000 }), true, 'نوعٌ لا يقبله الخادم يُحوَّل JPEG');
  assert.equal(needsDownscale({ type: 'application/pdf', size: 4_000_000 }), false);
});

test('data URL: التفكيك والحجم والتحويل إلى Blob', () => {
  const url = `data:image/png;base64,${Buffer.from('hello world').toString('base64')}`;
  assert.deepEqual(dataUrlParts(url), { mime: 'image/png', base64: Buffer.from('hello world').toString('base64') });
  assert.equal(dataUrlParts('data:text/html,<b>x</b>'), null, 'بلا base64 مرفوض');
  assert.equal(dataUrlParts('javascript:x'), null);
  assert.equal(base64Bytes(Buffer.from('hello world').toString('base64')), 11);
  assert.equal(base64Bytes(Buffer.from('ab').toString('base64')), 2);
  const blob = dataUrlToBlob(url)!;
  assert.equal(blob.size, 11);
  assert.equal(blob.type, 'image/png');
  assert.equal(dataUrlToBlob('nope'), null);
  assert.equal(safeFileName('../../etc/passwd', 'f'), '.. .. etc passwd');
  assert.equal(safeFileName('  ', 'fallback.pdf'), 'fallback.pdf');
  assert.equal(safeFileName('عرض فيلد سيلز.pdf', 'f'), 'عرض فيلد سيلز.pdf');
});

test('لوحة الرئيسية: حقول v2 كما يرسلها الخادم، وتُشتقّ من القديمة لخادمٍ أقدم', () => {
  const base = { clicks30d: 4, signups: 8, paidCompanies: 2, pendingHalalas: 100, approvedHalalas: 3000, paidHalalas: 7000, adjustmentsHalalas: 0 };
  const v2 = dashboardView({
    ...base, totalEarnedHalalas: 10_000, pendingSettlementHalalas: 3000, activeReferrals: 5, conversionRate: 0.25,
    earningsByMonth: [{ month: '2026-11', halalas: 7000 }, { month: '2026-06', halalas: 0 }, { month: 'x', halalas: 9 }],
    nextSettlementAt: '2026-11-20T21:00:00.000Z', steps: { account: true, shared: true, firstPaid: false },
  });
  assert.equal(v2.totalEarnedHalalas, 10_000);
  assert.equal(v2.activeReferrals, 5);
  assert.equal(v2.conversionRate, 0.25);
  assert.deepEqual(v2.months.map((m) => m.month), ['2026-06', '2026-11'], 'بالترتيب الزمنيّ وبلا قيمٍ تالفة');
  assert.deepEqual(v2.steps, { account: true, shared: true, firstPaid: false });
  assert.equal(v2.nextSettlementAt, '2026-11-20T21:00:00.000Z');

  const old = dashboardView(base, '2026-11-10T21:00:00.000Z');
  assert.equal(old.totalEarnedHalalas, 10_000, 'المعتمدة + المدفوعة');
  assert.equal(old.pendingSettlementHalalas, 3000);
  assert.equal(old.activeReferrals, 8);
  assert.equal(old.conversionRate, 0.25);
  assert.deepEqual(old.months, []);
  assert.deepEqual(old.steps, { account: true, shared: true, firstPaid: true });
  assert.equal(old.nextSettlementAt, '2026-11-10T21:00:00.000Z', 'من /me');
  assert.equal(dashboardView({ ...base, signups: 0, conversionRate: null }).conversionRate, null);
  assert.equal(dashboardView({ clicks30d: 0, signups: 0, paidCompanies: 0 }).steps.shared, false);
});

test('اكتمال الملف: ٣ خطوات للفرد والمؤثّر و٤ للشركة — والخادم هو الحَكَم', () => {
  assert.deepEqual(profileProgress({ partnerType: 'individual', missing: ['iban', 'national_id'], profileComplete: false }),
    { percent: 33, done: 1, total: 3, missing: ['iban', 'national_id'], complete: false });
  assert.deepEqual(profileProgress({ partnerType: 'company', missing: ['commercial_reg'], profileComplete: false }),
    { percent: 75, done: 3, total: 4, missing: ['commercial_reg'], complete: false });
  assert.equal(profileProgress({ partnerType: 'influencer', missing: [], profileComplete: true }).percent, 100);
  assert.equal(profileProgress({ partnerType: null, missing: ['partnerType', 'iban', 'national_id'], profileComplete: false }).percent, 0);
  assert.equal(profileProgress({ partnerType: 'company', missing: ['weird' as never], profileComplete: false }).complete, false, 'بلا تصريح الخادم لا اكتمال');
  assert.equal(needsCommercialReg({ partnerType: 'company', missing: [] }), true);
  assert.equal(needsCommercialReg({ partnerType: 'individual', missing: [] }), false);
});

test('الأسئلة الشائعة الستّ بالخمس لغات وبالمتغيّرات نفسها', () => {
  assert.equal(FAQ_KEYS.length, 6);
  const topics = FAQ_KEYS.map((f) => f.q.replace('faq.q.', ''));
  assert.deepEqual(topics, ['commission', 'hold', 'referral', 'trial', 'missed', 'profile']);
  for (const { q, a } of FAQ_KEYS) {
    assert.ok(AX_DICT[q] && AX_DICT[a], `${q}/${a}`);
  }
  assert.match(AX_DICT['faq.a.missed'].en, /Missed referral claim/);
  assert.match(AX_DICT['faq.a.hold'].ar, /1 و11 و21/);
});

test('الشاشات: الشركات بعمود «الطريقة» ومدخل المطالبة، والأرباح بالتسويات وفشل التحويل', () => {
  const companies = read('./screens/CompaniesScreen.tsx');
  assert.match(companies, /label: t\('companies\.method'\), cell: \(c\) => textOf\(COMPANY_METHOD, companyMethod\(c\), lang\)/);
  assert.match(companies, /onClick=\{\(\) => openTab\('missed'\)\}/);
  const earnings = read('./screens/EarningsScreen.tsx');
  for (const k of ['settle.period', 'earn.commissions', 'earn.adjustments', 'settle.net', 'settle.paidOn', 'earn.heldUntil', 'settle.next']) {
    assert.match(earnings, new RegExp(`t\\('${k.replace('.', '\\.')}'`), k);
  }
  assert.match(earnings, /p\.status === 'failed'/, 'فشل التحويل بلا سبب ولا إرشاد');
  assert.match(earnings, /p\.failedReason/);
  assert.match(earnings, /filter\(\(p\) => p\.status !== 'void'\)/, 'الملغاة تظهر للسفير');
});

test('«ملفي»: الحساب البنكي متاحٌ دائماً، والمستندات بتصويرٍ أو من الاستديو مع معاينةٍ واستبدالٍ وحذف', () => {
  const s = read('./screens/ProfileScreen.tsx');
  // v2 (قرار المالك ١٨ نوفمبر ٢٠٢٦): بديل حارس canSetPayout — لا قفل «بعد أول عمولة»
  assert.doesNotMatch(s, /canSetPayout/, 'نموذج الآيبان ما زال مقفلاً بشرط canSetPayout');
  assert.match(s, /const showForm = editing \|\| !user\.payout;/);
  assert.match(s, /type="file" accept="image\/\*" capture="environment"/, 'لا تصوير بالكاميرا');
  assert.match(s, /type="file" accept="image\/\*,application\/pdf"/, 'لا اختيار من الاستديو');
  assert.match(s, /affiliateApi\.uploadDocument\(kind, dataUrl\)/);
  assert.match(s, /affiliateApi\.deleteDocument\(kind\)/);
  assert.match(s, /window\.confirm\(t\('doc\.deleteConfirm'/, 'الحذف بلا تأكيد');
  assert.match(s, /enabled: showPreview && !!doc/, 'المعاينة تُجلب قبل طلبها');
  assert.match(s, /<PartnerTypePicker value=\{form\.partnerType\}/);
  assert.match(s, /affiliateApi\.updateMe\(\{ socialLinks: links \}\)/);
  const api = read('./api.ts');
  assert.match(api, /axApi\.post\('\/documents', \{ kind, dataUrl \}/);
  assert.match(api, /axApi\.get\(`\/materials\/\$\{encodeURIComponent\(id\)\}\/file`/);
  assert.match(api, /axApi\.post\(`\/missed-claims\/\$\{encodeURIComponent\(id\)\}\/withdraw`\)/);
});

test('المواد التسويقية: الرابط http(s) وحده، والنصّ نصٌّ، والملف يُجلب عند الطلب', () => {
  const s = read('./screens/MaterialsScreen.tsx');
  assert.match(s, /const url = safeHttpUrl\(m\.url\);/);
  assert.doesNotMatch(s, /dangerouslySetInnerHTML/);
  assert.match(s, /affiliateApi\.materialFile\(m\.id\)/);
  assert.doesNotMatch(s, /useQuery\(\{[^}]*materialFile/, 'الملفات لا تُحمَّل مسبقاً');
});

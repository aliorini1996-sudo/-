import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  LOCAL_NO, OFFLINE_MAX_AGE_DAYS, QUOTE_PACKAGES, QUOTE_VALID_DAYS, displayNo, formatQuoteNo, localNoFor,
  quoteFigures, quoteInput, resolveOffline, toQuoteRecord,
} from '../services/quotes';

/**
 * حرّاس سجلّ عروض الأسعار. التسجيل **بلا دخول**، فالسؤال الحاكم: هل يستطيع متصفّحٌ
 * أن يُسجِّل سعراً أو باقةً أو صلاحيةً أو رقماً أو تاريخاً لم يأتِ من الخادم؟
 * وهل يتطابق ما يُحفظ مع ما طبعته صفحة الجوال في ملفّ العميل؟
 */

const base = {
  clientRef: '0b6f8d2e-4c1a-4f7e-9d3b-2a5c6e7f8a9b',
  company: 'مؤسسة الخير التجارية',
  unifiedNo: '7667890987',
  packageId: 'pro' as const,
  cycle: 'monthly' as const,
};
const NOW = new Date('2026-09-14T09:00:00Z');

test('الضريبة تُستخرَج من الشامل: ٥٩٩ = ٥٢٠٫٨٧ + ٧٨٫١٣ كما في صفحة الجوال', () => {
  assert.deepEqual(quoteFigures(59_900), { totalHalalas: 59_900, netHalalas: 52_087, vatHalalas: 7_813 });
});

test('السنويّ سعرٌ معتمد لا ١٢ × الشهري: ٥٩٩٠ = ٥٢٠٨٫٧٠ + ٧٨١٫٣٠، و٢٩٩٠ = ٢٦٠٠ + ٣٩٠', () => {
  assert.deepEqual(quoteFigures(599_000), { totalHalalas: 599_000, netHalalas: 520_870, vatHalalas: 78_130 });
  assert.deepEqual(quoteFigures(299_000), { totalHalalas: 299_000, netHalalas: 260_000, vatHalalas: 39_000 });
});

test('قرار المالك: السنويّ = عشرة أشهر (شهران مجاناً) لكل باقة', () => {
  for (const [id, p] of Object.entries(QUOTE_PACKAGES)) assert.equal(p.yearly, p.total * 10, id);
  assert.deepEqual(Object.values(QUOTE_PACKAGES).map(p => p.yearly), [2990, 3990, 5990]);
});

test('الثابت: الصافي + الضريبة = الإجمالي بالهللة، ومطابقٌ لتقريب الصفحة', () => {
  for (const riyals of [299, 399, 599, 2990, 3990, 5990, 1, 777, 100_000]) {
    const f = quoteFigures(riyals * 100);
    assert.equal(f.netHalalas + f.vatHalalas, f.totalHalalas, `${riyals}`);
    const pageNet = Math.round((riyals / 1.15) * 100) / 100; // r2(total / 1.15)
    assert.equal(f.netHalalas, Math.round(pageNet * 100), `انحراف عن الصفحة عند ${riyals}`);
  }
});

test('السعر والباقة والصلاحية من كتالوج الخادم: لقطة المتصفّح المزوّرة تُهمَل كلّها', () => {
  const forged = {
    ...base, cycle: 'yearly', monthlyTotal: 1, packageName: 'مزوّرة', packageLimit: 'بلا حد',
    validDays: 90, totalHalalas: 1, netHalalas: 1, vatHalalas: 0,
  };
  const rec = toQuoteRecord(quoteInput.parse(forged), NOW);
  assert.equal(rec.monthlyHalalas, 59_900);
  assert.equal(rec.yearlyHalalas, 599_000);
  assert.equal(rec.totalHalalas, 599_000);
  assert.equal(toQuoteRecord(quoteInput.parse({ ...forged, cycle: 'monthly' }), NOW).totalHalalas, 59_900);
  assert.equal(rec.packageName, 'المتقدمة');
  assert.equal(rec.packageLimit, QUOTE_PACKAGES.pro.limit);
  assert.equal(rec.validDays, QUOTE_VALID_DAYS);
});

test('باقةٌ خارج الكتالوج مرفوضة', () => {
  assert.equal(quoteInput.safeParse({ ...base, packageId: 'enterprise' }).success, false);
  assert.equal(quoteInput.safeParse({ ...base, packageId: 'PRO' }).success, false);
});

test('الكتالوج يطابق جدول الواجهة حرفياً (السعران والاسم والحدّ) — لا افتراق صامت بين الملف والسجلّ', () => {
  const src = readFileSync(path.join(process.cwd(), '..', 'web-admin', 'src', 'quote', 'quoteDoc.tsx'), 'utf8');
  const block = src.match(/export const PACKAGES = \[([\s\S]*?)\] as const;/);
  assert.ok(block, 'تعذّر العثور على PACKAGES في quoteDoc.tsx');
  const web = [...block![1].matchAll(/\{ id: '([^']+)', name: '([^']+)', total: (\d+), yearly: (\d+), limit: '([^']+)'/g)]
    .map(m => ({ id: m[1], name: m[2], total: Number(m[3]), yearly: Number(m[4]), limit: m[5] }));
  const server = Object.entries(QUOTE_PACKAGES)
    .map(([id, p]) => ({ id, name: p.name, total: p.total, yearly: p.yearly, limit: p.limit }));
  assert.deepEqual(web, server);
  assert.match(src, new RegExp(`export const VALID_DAYS = ${QUOTE_VALID_DAYS};`), 'صلاحية الواجهة تخالف الخادم');
});

test('التحقّق: رقمٌ موحّد بحروف، ودورة مجهولة، ونصٌّ فوق ٥٠٠، واسمٌ فارغ — مرفوضة برسائل عربية', () => {
  const bad = [
    { ...base, unifiedNo: '70A1234' }, { ...base, cycle: 'weekly' }, { ...base, note: 'x'.repeat(501) },
    { ...base, clientRef: 'not-a-uuid' }, { ...base, company: ' ' }, { ...base, presenter: 'x'.repeat(81) },
  ];
  for (const b of bad) {
    const r = quoteInput.safeParse(b);
    assert.equal(r.success, false, JSON.stringify(b).slice(0, 80));
    if (!r.success) assert.match(r.error.issues[0].message, /[؀-ۿ]/, 'رسالة غير عربية تصل الموظّف');
  }
  assert.equal(quoteInput.safeParse(base).success, true);
});

test('الحقول الاختيارية الفارغة تُحفظ null، والعرض المتّصل بلا رقمٍ مؤقّت ولا وسم', () => {
  const rec = toQuoteRecord(quoteInput.parse({ ...base, presenter: '   ', note: '' }), NOW);
  assert.equal(rec.presenter, null);
  assert.equal(rec.note, null);
  assert.equal(rec.quoteNo, null);
  assert.equal(rec.offline, false);
  assert.equal(rec.issuedAt, NOW);
});

test('رقم العرض: تسلسلٌ بأربع خانات وسنة الرياض (ليلة رأس السنة بتوقيت غرينتش)', () => {
  assert.equal(formatQuoteNo(7, NOW), 'FS-QT-2026-0007');
  assert.equal(formatQuoteNo(12345, NOW), 'FS-QT-2026-12345');
  assert.equal(formatQuoteNo(1, new Date('2026-12-31T22:30:00Z')), 'FS-QT-2027-0001'); // 01:30 في الرياض
});

test('الرقم المؤقّت: صيغة الواجهة بتوقيت الرياض، لا يلتبس بالتسلسل، ويُعرض كما طُبع', () => {
  assert.equal(localNoFor(new Date('2026-09-14T09:28:04Z')), 'FS-QT-2026-0914122804');
  assert.equal(localNoFor(new Date('2026-12-31T22:00:00Z')), 'FS-QT-2027-0101010000');
  assert.equal(LOCAL_NO.test('FS-QT-2026-0914122804'), true);
  assert.equal(LOCAL_NO.test('FS-QT-2026-0007'), false);
  assert.equal(displayNo({ seq: 3, quoteNo: null, issuedAt: NOW }), 'FS-QT-2026-0003');
  assert.equal(displayNo({ seq: 3, quoteNo: 'FS-QT-2026-0914122804', issuedAt: NOW }), 'FS-QT-2026-0914122804');
});

test('الرقم المؤقّت يُقبَل مقيَّداً بلحظته فقط — لا اختيار رقمٍ أو تاريخٍ على هوى المُرسِل', () => {
  const at = '2026-09-10T08:00:00.000Z';
  const good = localNoFor(new Date(at));
  // مطابقٌ ⇒ يُقبَل ويُوسَم
  const ok = toQuoteRecord(quoteInput.parse({ ...base, localNo: good, issuedAt: at }), NOW);
  assert.equal(ok.quoteNo, good);
  assert.equal(ok.offline, true);
  assert.equal(ok.issuedAt.toISOString(), at);
  // رقمٌ مختار لا يطابق اللحظة ⇒ يُهمَلان معاً
  const chosen = toQuoteRecord(quoteInput.parse({ ...base, localNo: 'FS-QT-2026-0000000001', issuedAt: at }), NOW);
  assert.equal(chosen.quoteNo, null);
  assert.equal(chosen.offline, false);
  assert.equal(chosen.issuedAt, NOW);
  // تاريخٌ بلا رقم ⇒ يُهمَل (لا تأريخ رجعيّ لعرضٍ متّصل)
  assert.equal(toQuoteRecord(quoteInput.parse({ ...base, issuedAt: at }), NOW).issuedAt, NOW);
});

test('نافذة الرقم المؤقّت: مستقبلٌ بدقيقتين لانحراف الساعة، وماضٍ حتى ١٨٠ يوماً', () => {
  const mk = (iso: string) => resolveOffline(localNoFor(new Date(iso)), iso, NOW);
  assert.ok(mk('2026-09-14T09:01:30Z'), 'انحراف ساعة الجوال دقيقة ونصف');
  assert.equal(mk('2026-09-14T09:01:30Z')!.issuedAt, NOW, 'لحظة مستقبلية تُقصّ إلى الآن');
  assert.equal(mk('2026-09-14T09:05:00Z'), null, 'مستقبل بخمس دقائق');
  const old = new Date(NOW.getTime() - (OFFLINE_MAX_AGE_DAYS - 1) * 86_400_000).toISOString();
  assert.ok(mk(old), 'جوالٌ لم يُفتح عليه الرابط أشهراً');
  const tooOld = new Date(NOW.getTime() - (OFFLINE_MAX_AGE_DAYS + 1) * 86_400_000).toISOString();
  assert.equal(mk(tooOld), null);
});

test('التركيب: التسجيل خلف محدّد المعدّل، والسجلّ والحذف للمالك وحده، وتصادمٌ فريد يُفحص بالمعرّف أولاً', () => {
  const src = readFileSync(path.join(__dirname, '../routes/quotes.ts'), 'utf8');
  assert.match(src, /router\.post\('\/', quoteLimiter,/);
  assert.match(src, /router\.get\('\/admin', authenticate, requireSuperAdmin,/);
  assert.match(src, /router\.delete\('\/admin\/:id', authenticate, requireSuperAdmin,/);
  assert.equal((src.match(/router\.(get|post|put|patch|delete)\(/g) || []).length, 3, 'مسارٌ إضافيّ قد يكشف السجلّ');
  // بعد أيّ P2002 يُبحث بالمعرّف قبل تمييز الرقم بلاحقة (Postgres قد يُبلغ عن فهرس الرقم أولاً)
  const createCatch = src.slice(src.indexOf('if (!isP2002(e)) throw e;'));
  assert.ok(createCatch.indexOf('byRef(input.clientRef)') < createCatch.indexOf("hitsField(e, 'quoteNo')"));
  const index = readFileSync(path.join(__dirname, '../index.ts'), 'utf8');
  assert.match(index, /app\.use\('\/api\/quotes', quotesRouter\)/);
});

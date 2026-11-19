/**
 * حرّاس منطق لوحة «سفير فيلد سيلز» للمالك.
 *
 * ما يحرسه:
 *  - كل قيمة تعداد في API.md لها تسمية عربية — حالة جديدة بلا تسمية تظهر للمالك
 *    رمزاً إنجليزياً فيتخذ قراراً مالياً على ما لا يفهمه.
 *  - تحويل الريال ⇔ الهللات بلا فاصلة عائمة — هللة مقطوعة من عمولة هي مال
 *    حقيقي، و`0.29 * 100` ليس 29.
 *  - النسبة المئوية ⇔ نقاط الأساس (الإعدادات تُعرض نسبةً وتُرسل bps).
 *  - v2 (قرار المالك ١٨ نوفمبر ٢٠٢٦، V2_SPEC §8): الانضمام فوريّ بلا موافقة، فشل التحويل، دورة التسوية
 *    كل ١٠ أيام، ملف السفير ومستنداته، المطالبات الفائتة، والمواد التسويقية.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  USER_STATUSES, CLAIM_STATUSES, ATTRIBUTION_STATUSES, COMMISSION_STATUSES, PAYOUT_STATUSES,
  CLAIM_HOWS, CLAIM_REASONS, FLAGS, ATTRIBUTION_SOURCES, REF_VIAS, ADJUSTMENT_KINDS, ACTOR_TYPES,
  USER_STATUS_LABEL, CLAIM_STATUS_LABEL, ATTRIBUTION_STATUS_LABEL, COMMISSION_STATUS_LABEL, PAYOUT_STATUS_LABEL,
  CLAIM_HOW_LABEL, CLAIM_REASON_LABEL, FLAG_LABEL, SOURCE_LABEL, REF_VIA_LABEL, ADJUSTMENT_KIND_LABEL, ACTOR_LABEL,
  USER_ACTIONS, ATTRIBUTION_ACTIONS, COMMISSION_ACTIONS, commissionActions, PUBLIC_PAGE_URL,
  labelOf, toneOf, normalizeNumeric, parseSarToHalalas, halalasToSarInput, formatHalalas,
  bpsToPercent, parsePercentToBps, parseIntInRange, validateTermsForm, validateReason,
  validatePayoutRecord, validateAdjustment, isIsoDay,
  cleanParams, matchesSearch, sortAffiliatesForSelect, apiErrorMessage, candidateBlocker, groupIban,
  normalizeDetail, normalizeClaims, normalizeAttributions, telHref, phoneDisplay,
  riyadhDayKey, dayKeyOf, reactivateCopy, attributionActions, canCreatePayout, adjustmentState,
  ACCRUAL_REASONS, ACCRUAL_REASON_LABEL, conflictMessage, withAccrual, claimLinkMessage, reassignMessage, claimActions,
  validateReassign, buildReassignBody, reassignClaimOptions, validateWindow,
  TERMS_RULE_KEYS, RULE_LABEL, RULE_LIMITS, rulesToInputs, rulesOf, parseRuleChanges, describeRuleChanges, formatRule,
  DISCLOSURE_MIN, validateDisclosure, settingsDiff, settingsDraftOf, syncSettingsDraft,
  // v2
  PARTNER_TYPES, SOCIAL_PLATFORMS, DOC_KINDS, MISSED_CLAIM_STATUSES, MATERIAL_CATEGORIES, PROFILE_MISSING, MISSED_MATCHES, PAYOUT_BLOCKS,
  PARTNER_TYPE_LABEL, SOCIAL_PLATFORM_LABEL, DOC_KIND_LABEL, PROFILE_MISSING_LABEL, MISSED_CLAIM_STATUS_LABEL, MISSED_MATCH_LABEL,
  MATERIAL_CATEGORY_LABEL, PAYOUT_BLOCK_LABEL, USER_FILTER_STATUSES,
  profileState, safeHttpUrl, socialLinksOf, formatBytes, documentPreview, dataUrlToBytes,
  nextSettlementDayKey, nextSettlementKey, payoutPeriod, validateFailReason, daysText, autoApproveNote,
  settlementRunMessage, lastCycleText, skippedText,
  missedClaimActions, validateMissedAccept, daysFromSignup, missedWindowLabel, missedAcceptMessage, normalizeMissedClaims,
  materialNeeds, validateMaterial, buildMaterialBody, materialBodyBytes, MATERIAL_MAX_BYTES, JSON_BODY_LIMIT_BYTES,
  normalizeOverview,
} from './affiliatesPanelLogic';
// أسعار الباقات في بوابة السفير (قرار المالك 19 نوفمبر 2026)
import {
  AMB_PRICE_MIN, AMB_PRICE_MAX, YEMEN_PCT_MIN, YEMEN_PCT_MAX, YEMEN_PCT_DEFAULT, AMB_PRICE_ERROR, YEMEN_PCT_ERROR,
  parseAmbPrice, parseYemenPct, pricingDraftOf, setPackagePrice, resetPackagePrice, hasCustomPrice, validatePricingDraft,
  pricingDiff, samePricingDraft, syncPricingDraft, regionalPrice, yemenPreview, cleanPackagePrices,
  type PackageCatalogItem, type SettingsBody,
} from './affiliatesPanelLogic';

const ARABIC = /[؀-ۿ]/;

function assertLabelled(name: string, values: readonly string[], map: Record<string, string | { label: string }>) {
  for (const v of values) {
    const hit = map[v];
    assert.ok(hit, `${name}: القيمة «${v}» بلا تسمية`);
    const label = typeof hit === 'string' ? hit : hit.label;
    assert.ok(label.trim().length > 0, `${name}: تسمية «${v}» فارغة`);
    assert.ok(ARABIC.test(label), `${name}: تسمية «${v}» ليست عربية: ${label}`);
  }
  // ولا تسميات لقيم ليست في التعداد (تسمية يتيمة = اسم حالة مكتوب خطأً)
  for (const k of Object.keys(map)) assert.ok(values.includes(k), `${name}: تسمية لقيمة غير معروفة «${k}»`);
}

test('كل قيمة تعداد لها تسمية عربية — ولا تسميات يتيمة', () => {
  assertLabelled('UserStatus', USER_STATUSES, USER_STATUS_LABEL);
  assertLabelled('ClaimStatus', CLAIM_STATUSES, CLAIM_STATUS_LABEL);
  assertLabelled('AttributionStatus', ATTRIBUTION_STATUSES, ATTRIBUTION_STATUS_LABEL);
  assertLabelled('CommissionStatus', COMMISSION_STATUSES, COMMISSION_STATUS_LABEL);
  assertLabelled('PayoutStatus', PAYOUT_STATUSES, PAYOUT_STATUS_LABEL);
  assertLabelled('ClaimHow', CLAIM_HOWS, CLAIM_HOW_LABEL);
  assertLabelled('ClaimReason', CLAIM_REASONS, CLAIM_REASON_LABEL);
  assertLabelled('Flag', FLAGS, FLAG_LABEL);
  assertLabelled('Source', ATTRIBUTION_SOURCES, SOURCE_LABEL);
  assertLabelled('RefVia', REF_VIAS, REF_VIA_LABEL);
  assertLabelled('AdjustmentKind', ADJUSTMENT_KINDS, ADJUSTMENT_KIND_LABEL);
  assertLabelled('ActorType', ACTOR_TYPES, ACTOR_LABEL);
  // v2
  assertLabelled('PartnerType', PARTNER_TYPES, PARTNER_TYPE_LABEL);
  assertLabelled('SocialPlatform', SOCIAL_PLATFORMS, SOCIAL_PLATFORM_LABEL);
  assertLabelled('DocKind', DOC_KINDS, DOC_KIND_LABEL);
  assertLabelled('ProfileMissing', PROFILE_MISSING, PROFILE_MISSING_LABEL);
  assertLabelled('MissedClaimStatus', MISSED_CLAIM_STATUSES, MISSED_CLAIM_STATUS_LABEL);
  assertLabelled('MissedMatch', MISSED_MATCHES, MISSED_MATCH_LABEL);
  assertLabelled('MaterialCategory', MATERIAL_CATEGORIES, MATERIAL_CATEGORY_LABEL);
  assertLabelled('PayoutBlock', PAYOUT_BLOCKS, PAYOUT_BLOCK_LABEL);
});

test('التعدادات مطابقة حرفياً لـ API.md', () => {
  // مسار نسبي لملف الاختبار نفسه — لا لمجلد التشغيل
  const doc = fs.readFileSync(fileURLToPath(new URL('../../../docs/affiliate/API.md', import.meta.url)), 'utf8');
  const union = (name: string): string[] => {
    const m = new RegExp(`type ${name} = ([^;]+);`).exec(doc);
    assert.ok(m, `النوع ${name} غير موجود في API.md`);
    // v2: `ProfileMissing` يحمل 'partnerType' بحرفٍ كبير — فالنمط يقبل الحالتين
    return [...m[1].matchAll(/'([A-Za-z_]+)'/g)].map((x) => x[1]);
  };
  assert.deepEqual([...USER_STATUSES], union('UserStatus'));
  assert.deepEqual([...CLAIM_STATUSES], union('ClaimStatus'));
  assert.deepEqual([...ATTRIBUTION_STATUSES], union('AttributionStatus'));
  assert.deepEqual([...COMMISSION_STATUSES], union('CommissionStatus'));
  assert.deepEqual([...PAYOUT_STATUSES], union('PayoutStatus'));
  assert.deepEqual([...CLAIM_HOWS], union('ClaimHow'));
  assert.deepEqual([...CLAIM_REASONS], union('ClaimReason'));
  assert.deepEqual([...FLAGS], union('Flag'));
  // v2 (V2_SPEC §3 — API.md يطابقها): فشل التحويل في PayoutStatus، وتعدادات الملف والمطالبات والمواد والحجب
  assert.ok((PAYOUT_STATUSES as readonly string[]).includes('failed'), 'حالة «فشل التحويل» غائبة');
  assert.deepEqual([...PARTNER_TYPES], union('PartnerType'));
  assert.deepEqual([...SOCIAL_PLATFORMS], union('SocialPlatform'));
  assert.deepEqual([...DOC_KINDS], union('DocKind'));
  assert.deepEqual([...PROFILE_MISSING], union('ProfileMissing'));
  assert.deepEqual([...MISSED_CLAIM_STATUSES], union('MissedClaimStatus'));
  assert.deepEqual([...MATERIAL_CATEGORIES], union('MaterialCategory'));
  assert.deepEqual([...PAYOUT_BLOCKS], union('PayoutBlock'));
});

test('تسميات أسباب رفض الترشيح وإشارات الإسناد كما حدّدها المالك', () => {
  assert.equal(CLAIM_REASON_LABEL.existing_customer, 'عميل قائم');
  assert.equal(CLAIM_REASON_LABEL.duplicate, 'مكرر');
  assert.equal(CLAIM_REASON_LABEL.self_referral, 'إحالة ذاتية');
  assert.equal(CLAIM_REASON_LABEL.insufficient, 'بيانات غير كافية');
  assert.equal(CLAIM_REASON_LABEL.other, 'أخرى');
  assert.equal(FLAG_LABEL.self_email, 'بريد المسوّق نفسه');
  assert.equal(FLAG_LABEL.self_phone, 'جوال المسوّق نفسه');
  assert.equal(FLAG_LABEL.returning_company, 'شركة عائدة');
  assert.equal(FLAG_LABEL.ip_match, 'نفس الشبكة');
  assert.equal(FLAG_LABEL.terms_outdated, 'لم يقبل الشروط الحالية');
  assert.ok((FLAGS as readonly string[]).includes('terms_outdated'));
});

test('كل حالة لها قائمة إجراءات (ولو فارغة)', () => {
  for (const s of USER_STATUSES) assert.ok(Array.isArray(USER_ACTIONS[s]), s);
  for (const s of ATTRIBUTION_STATUSES) assert.ok(Array.isArray(ATTRIBUTION_ACTIONS[s]), s);
  for (const s of COMMISSION_STATUSES) assert.ok(Array.isArray(COMMISSION_ACTIONS[s]), s);
  // الحالات النهائية لا تُعتمد ولا تُوقف
  assert.deepEqual(COMMISSION_ACTIONS.paid, []);
  assert.deepEqual(COMMISSION_ACTIONS.reversed, []);
  assert.deepEqual(COMMISSION_ACTIONS.declined, []);
  assert.ok(COMMISSION_ACTIONS.pending.includes('approve'));
  assert.ok(COMMISSION_ACTIONS.on_hold.includes('release'));
});

// v2: الاعتماد التلقائي كلّ ساعة يُخرج العمولة من «معلّقة» بعد حجزها بقليل — فالمعتمدة تُوقف أيضاً (holdCommission
// يقبل pending وapproved)، إلا ما دخل مسودّة دفعة: الخادم يرفضه in_draft فلا زرّ له.
test('v2: المعتمدة تُوقف ما لم تدخل مسودّة دفعة، والمسودّة تحجب الاعتماد والإيقاف والرفض', () => {
  assert.deepEqual(COMMISSION_ACTIONS.approved, ['hold']);
  assert.deepEqual(commissionActions({ status: 'approved', payoutId: null }), ['hold']);
  assert.deepEqual(commissionActions({ status: 'approved' }), ['hold']);
  assert.deepEqual(commissionActions({ status: 'approved', payoutId: 'p1' }), [], 'في مسودّة: لا إيقاف (in_draft)');
  assert.deepEqual(commissionActions({ status: 'pending', payoutId: null }), ['approve', 'hold', 'decline']);
  assert.deepEqual(commissionActions({ status: 'pending', payoutId: 'p1' }), []);
  assert.deepEqual(commissionActions({ status: 'on_hold', payoutId: null }), ['release', 'decline']);
  assert.deepEqual(commissionActions({ status: 'paid', payoutId: 'p1' }), []);
  // لا تُعدَّل القائمة الثابتة من نسخةٍ أُعيدت
  commissionActions({ status: 'approved', payoutId: null }).push('approve');
  assert.deepEqual(COMMISSION_ACTIONS.approved, ['hold']);
  // اللوحة تأخذ الإجراءات من الدالّة (لا من الخريطة مباشرةً) فيُحترم payoutId
  const src = fs.readFileSync(fileURLToPath(new URL('./AffiliatesPanel.tsx', import.meta.url)), 'utf8');
  assert.match(src, /const list = L\.commissionActions\(c\);/);
  assert.doesNotMatch(src, /L\.COMMISSION_ACTIONS\[c\.status\]/);
  assert.doesNotMatch(src, /عادت لفترة الحجز/, 'المحرَّرة بعد انتهاء حجزها تُعتمد خلال ساعة — لا «فترة حجز» جديدة');
});

// v2 — قرار المالك ١٨ نوفمبر ٢٠٢٦ (V2_SPEC §3): الانضمام فوريّ بلا موافقة، فلا «اعتماد/رفض» للطلبات بعد اليوم
// (الرفض = إيقاف)، والمرفوض إرثاً يُعاد تفعيله **معتمداً** مباشرةً لا «للمراجعة». كان الحارس يثبّت «إعادة للمراجعة».
test('v2: الإيقاف للمعتمد، وإعادة التفعيل للموقوف والمرفوض (إلى معتمد)، والإرث pending_* بلا إجراء', () => {
  assert.deepEqual(USER_ACTIONS.approved, ['suspend']);
  assert.deepEqual(USER_ACTIONS.rejected, ['reactivate']);
  assert.deepEqual(USER_ACTIONS.suspended, ['reactivate']);
  assert.deepEqual(USER_ACTIONS.pending_email, [], 'الإرث يُرقّى تلقائياً — لا زرّ');
  assert.deepEqual(USER_ACTIONS.pending_review, [], 'لا موافقة يدوية بعد اليوم');
  for (const s of USER_STATUSES) {
    for (const a of USER_ACTIONS[s] as string[]) assert.ok(a === 'suspend' || a === 'reactivate', `${s}: إجراءٌ قديم «${a}»`);
  }
  assert.equal(reactivateCopy('rejected').label, 'إعادة تفعيل');
  assert.match(reactivateCopy('rejected').success, /معتمداً/);
  assert.equal(reactivateCopy('suspended').label, 'إعادة تفعيل');
  // تصفية المسوّقين بلا حالات الإرث، لكنها تبقى في القاموس كي لا يظهر صفٌّ قديم رمزاً إنجليزياً
  assert.deepEqual([...USER_FILTER_STATUSES], ['approved', 'suspended', 'rejected']);
  assert.ok(USER_STATUS_LABEL.pending_review.label.includes('قديم'));
});

test('إجراءات الإسناد: إعادة الإسناد للمتنازع عليه والمُبطل، وتعديل البداية لما بلا عمولة', () => {
  const com = { id: 'c', status: 'pending', commissionHalalas: 100 };
  assert.deepEqual(attributionActions({ status: 'active', commission: null }), ['void', 'window']);
  assert.deepEqual(attributionActions({ status: 'active', commission: com }), ['void']);
  assert.deepEqual(attributionActions({ status: 'disputed', commission: null }), ['activate', 'void', 'reassign', 'window']);
  assert.deepEqual(attributionActions({ status: 'disputed', commission: com }), ['activate', 'void', 'reassign']);
  assert.deepEqual(attributionActions({ status: 'void', commission: com }), ['activate', 'reassign']);
  assert.ok(!attributionActions({ status: 'void', commission: null }).includes('window'), 'لا تعديل بداية لإسناد مُبطل');
  assert.ok(!attributionActions({ status: 'active', commission: null }).includes('reassign'), 'الفعّال لا يُعاد إسناده');
});

test('labelOf / toneOf تسقطان بأمان لقيمة خارج القاموس', () => {
  assert.equal(labelOf(USER_STATUS_LABEL, 'approved'), 'معتمد');
  assert.equal(labelOf(FLAG_LABEL, 'new_flag'), 'new_flag');
  assert.equal(labelOf(FLAG_LABEL, null), '—');
  assert.equal(toneOf(COMMISSION_STATUS_LABEL, 'paid'), 'green');
  assert.equal(toneOf(COMMISSION_STATUS_LABEL, 'unknown'), 'gray');
});

test('الريال ⇒ هللات: حالات الفاصلة العائمة تخرج صحيحة', () => {
  const h = (s: string, o?: { allowNegative?: boolean; allowZero?: boolean }) => {
    const r = parseSarToHalalas(s, o);
    assert.ok(r.ok, `رُفض «${s}»: ${!r.ok ? r.error : ''}`);
    return r.value;
  };
  // 0.29*100 = 28.999999999999996 و1.15*100 = 114.99999999999999 و19.99*100 = 1998.9999999999998
  assert.equal(h('0.29'), 29);
  assert.equal(h('1.15'), 115);
  assert.equal(h('19.99'), 1999);
  assert.equal(h('4.35'), 435);
  assert.equal(h('0.07'), 7);
  // 0.1 + 0.2 = 0.30000000000000004 — مجموع هللات صحيحة يبقى صحيحاً
  assert.equal(h('0.1') + h('0.2'), 30);
  assert.equal(h('0.3'), 30);
  assert.equal(h('100'), 10000);
  assert.equal(h('1.5'), 150);
  assert.equal(h('.5'), 50);
  assert.equal(h('5.'), 500);
  assert.equal(h('007.10'), 710);
  assert.equal(h('  12.50 '), 1250);
  assert.ok(Number.isInteger(h('123456.78')));
  assert.equal(h('123456.78'), 12345678);
});

test('الريال ⇒ هللات: السالب للتصحيحات فقط، والصفر بإذن', () => {
  const neg = parseSarToHalalas('-12.5', { allowNegative: true });
  assert.ok(neg.ok && neg.value === -1250);
  const negTypo = parseSarToHalalas('−0.29', { allowNegative: true }); // علامة ناقص طباعية
  assert.ok(negTypo.ok && negTypo.value === -29);
  assert.equal(parseSarToHalalas('-5').ok, false, 'السالب مرفوض بلا إذن');
  assert.equal(parseSarToHalalas('0').ok, false, 'الصفر مرفوض بلا إذن');
  assert.equal(parseSarToHalalas('-0', { allowNegative: true }).ok, false, '«-0» صفر');
  const zero = parseSarToHalalas('0', { allowZero: true });
  assert.ok(zero.ok && zero.value === 0 && !Object.is(zero.value, -0));
  const negZero = parseSarToHalalas('-0.00', { allowNegative: true, allowZero: true });
  assert.ok(negZero.ok && Object.is(negZero.value, 0), 'لا -0');
});

test('الريال ⇒ هللات: أكثر من خانتين عشريتين مرفوض لا مُقرَّب', () => {
  for (const s of ['1.005', '0.001', '10.999', '1.500', '-2.125']) {
    const r = parseSarToHalalas(s, { allowNegative: true });
    assert.equal(r.ok, false, `قُبل «${s}»`);
    if (!r.ok) assert.match(r.error, /خانتان/);
  }
});

test('الريال ⇒ هللات: مدخلات غير صالحة', () => {
  for (const s of ['', '   ', 'abc', '1.2.3', '1e3', '--5', '+-5', '.', '12a', '1,000.50', 'Infinity', 'NaN']) {
    assert.equal(parseSarToHalalas(s, { allowNegative: true, allowZero: true }).ok, false, `قُبل «${s}»`);
  }
  assert.equal(parseSarToHalalas('99999999999999999999').ok, false, 'رقم يتجاوز الأمان');
});

test('الأرقام العربية-الهندية والفارسية والفاصلة العربية مقبولة', () => {
  assert.equal(normalizeNumeric('١٢٣٫٤٥'), '123.45');
  const a = parseSarToHalalas('١٢٣٫٤٥');
  assert.ok(a.ok && a.value === 12345);
  const b = parseSarToHalalas('۵۰,۲۵'); // فارسية + فاصلة
  assert.ok(b.ok && b.value === 5025);
  const c = parseSarToHalalas('-٠٫٠٧', { allowNegative: true });
  assert.ok(c.ok && c.value === -7);
  const d = parseSarToHalalas('‏١٠٠ '); // علامة اتجاه + مسافة غير منكسرة
  assert.ok(d.ok && d.value === 10000);
});

test('هللات ⇒ نصّ قابل للتحرير ثم رجوعاً بلا فقد', () => {
  assert.equal(halalasToSarInput(10000), '100');
  assert.equal(halalasToSarInput(1250), '12.50');
  assert.equal(halalasToSarInput(7), '0.07');
  assert.equal(halalasToSarInput(-1999), '-19.99');
  assert.equal(halalasToSarInput(0), '0');
  for (const n of [0, 1, 7, 29, 99, 100, 101, 1250, 1999, 10000, 123456789, -1, -29, -1250]) {
    const r = parseSarToHalalas(halalasToSarInput(n), { allowNegative: true, allowZero: true });
    assert.ok(r.ok && r.value === n, `ذهاب وإياب ${n}`);
  }
});

test('عرض الهللات', () => {
  assert.equal(formatHalalas(123450), '1,234.50 ر.س');
  assert.equal(formatHalalas(10000), '100 ر.س');
  assert.equal(formatHalalas(-1250), '-12.50 ر.س');
  assert.equal(formatHalalas(5), '0.05 ر.س');
  assert.equal(formatHalalas(0), '0 ر.س');
  assert.equal(formatHalalas(null), '—');
  assert.equal(formatHalalas(undefined), '—');
});

test('نقاط الأساس ⇔ النسبة المئوية', () => {
  assert.equal(bpsToPercent(3000), '30');
  assert.equal(bpsToPercent(1250), '12.5');
  assert.equal(bpsToPercent(1234), '12.34');
  assert.equal(bpsToPercent(5), '0.05');
  assert.equal(bpsToPercent(10), '0.1');
  assert.equal(bpsToPercent(0), '0');
  assert.equal(bpsToPercent(10000), '100');

  const p = (s: string) => { const r = parsePercentToBps(s); assert.ok(r.ok, `رُفض «${s}»`); return r.value; };
  assert.equal(p('30'), 3000);
  assert.equal(p('12.5'), 1250);
  assert.equal(p('0.05'), 5);
  assert.equal(p('14.35'), 1435); // 14.35*100 = 1434.9999999999998
  assert.equal(p('٣٠'), 3000);
  assert.equal(p('0'), 0);
  assert.equal(p('100'), 10000);
  for (const bps of [0, 1, 5, 10, 99, 1250, 1234, 3000, 9999, 10000]) assert.equal(p(bpsToPercent(bps)), bps, `ذهاب وإياب ${bps}`);

  assert.equal(parsePercentToBps('100.01').ok, false);
  assert.equal(parsePercentToBps('-1').ok, false);
  assert.equal(parsePercentToBps('12.345').ok, false);
  assert.equal(parsePercentToBps('').ok, false);
});

test('الأعداد الصحيحة ضمن مدى', () => {
  const r = parseIntInRange('٣٠', 0, 365);
  assert.ok(r.ok && r.value === 30);
  assert.equal(parseIntInRange('366', 0, 365).ok, false);
  assert.equal(parseIntInRange('0', 1, 365).ok, false);
  assert.equal(parseIntInRange('1.5', 0, 365).ok, false);
  assert.equal(parseIntInRange('-1', 0, 365).ok, false);
  assert.equal(parseIntInRange('', 0, 365).ok, false);
});

test('نماذج: الشروط والسبب وتسجيل التحويل والتصحيح', () => {
  const body = 'أ'.repeat(50);
  assert.equal(validateTermsForm('2026-10-v2', body), null);
  assert.notEqual(validateTermsForm('v2', body), null, 'إصدار أقصر من 3');
  assert.notEqual(validateTermsForm('2026 v2', body), null, 'مسافة في الإصدار');
  assert.notEqual(validateTermsForm('2026-10-v2', 'قصير'), null);

  assert.equal(validateReason('بيانات مكررة'), null);
  assert.notEqual(validateReason('  ab '), null);

  assert.equal(validatePayoutRecord('TRX-123', '2026-09-10', '2026-09-13'), null);
  assert.notEqual(validatePayoutRecord('ab', '2026-09-10', '2026-09-13'), null);
  assert.notEqual(validatePayoutRecord('x'.repeat(81), '2026-09-10', '2026-09-13'), null);
  assert.notEqual(validatePayoutRecord('TRX-123', '2026-09-14', '2026-09-13'), null, 'مستقبل');
  assert.notEqual(validatePayoutRecord('TRX-123', '2026-02-30', '2026-09-13'), null, 'يوم غير موجود');

  const adj = validateAdjustment('aff-1', '-25.5', 'خصم استرداد');
  assert.ok(adj.ok && adj.value === -2550);
  assert.equal(validateAdjustment('', '10', 'ملاحظة').ok, false);
  assert.equal(validateAdjustment('aff-1', '0', 'ملاحظة').ok, false, 'القيد ≠ 0');
  assert.equal(validateAdjustment('aff-1', '10.001', 'ملاحظة').ok, false);
  assert.equal(validateAdjustment('aff-1', '10', 'ab').ok, false);
});

test('التواريخ: يوم ISO، ويوم الرياض لا UTC ولا يوم الجهاز', () => {
  assert.equal(isIsoDay('2026-09-13'), true);
  assert.equal(isIsoDay('2026-13-01'), false);
  assert.equal(isIsoDay('2026-9-1'), false);

  // 21:00 UTC = منتصف ليل الرياض: قبلها اليوم نفسه، وبعدها الغد — تقطيع UTC يُخطئ هنا
  assert.equal(riyadhDayKey(Date.parse('2026-09-13T20:59:59Z')), '2026-09-13');
  assert.equal(riyadhDayKey(Date.parse('2026-09-13T21:00:00Z')), '2026-09-14');
  assert.equal(riyadhDayKey(new Date('2026-09-13T21:30:00Z')), '2026-09-14');

  // حقول اليوم الخالص تُؤخذ كما هي، واللحظة الكاملة تُحوَّل ليوم الرياض — لا تُقصّ
  assert.equal(dayKeyOf('2026-09-13'), '2026-09-13');
  assert.equal(dayKeyOf('2026-09-12T22:00:00.000Z'), '2026-09-13', 'قصّ أول عشرة أحرف يعطي 12');
  assert.equal(dayKeyOf('2026-09-12T10:00:00.000Z'), '2026-09-12');
  assert.equal(dayKeyOf('2026-02-30'), null);
  assert.equal(dayKeyOf('garbage'), null);
  assert.equal(dayKeyOf(''), null);
  assert.equal(dayKeyOf(null), null);
});

test('لوحة المالك بلا «موثوق»: لا عمود ولا قسم ولا علامات مخالفة', () => {
  const src = fs.readFileSync(fileURLToPath(new URL('./AffiliatesPanel.tsx', import.meta.url)), 'utf8');
  assert.doesNotMatch(src, /MawthooqCell|موثوق|mawthooq|publicPromoter|ينشر علناً/, 'بقايا «موثوق» في لوحة المالك');
  const logic = fs.readFileSync(fileURLToPath(new URL('./affiliatesPanelLogic.ts', import.meta.url)), 'utf8');
  assert.doesNotMatch(logic, /isDayExpired|mawthooq|publicPromoter/, 'منطق «موثوق» غير المستعمل ما زال');
});

test('التصفية: معاملات نظيفة وبحث عربي مطبَّع', () => {
  assert.deepEqual(cleanParams({ status: '', q: '  أحمد ', x: undefined, y: null }), { q: 'أحمد' });
  assert.equal(matchesSearch('احمد', 'أحمد العتيبي'), true);
  assert.equal(matchesSearch('مؤسسه', 'مؤسسة النور'), true);
  assert.equal(matchesSearch('١٠١٠', '1010123456'), true);
  assert.equal(matchesSearch('', 'أي شيء'), true);
  assert.equal(matchesSearch('خالد', 'أحمد', null), false);

  const sorted = sortAffiliatesForSelect([
    { id: '1', status: 'suspended', fullName: 'أحمد' },
    { id: '2', status: 'approved', fullName: 'يوسف' },
    { id: '3', status: 'approved', fullName: 'بدر' },
  ]);
  assert.deepEqual(sorted.map((a) => a.id), ['3', '2', '1']);
});

test('مرشّح الصرف: مؤهّل بلا عمولات (تصحيح موجب وحده) يجوز إنشاء دفعته', () => {
  const correctionOnly = { eligible: true, hasPayout: true, netHalalas: 5000, commissionCount: 0 };
  assert.equal(canCreatePayout(correctionOnly), true);
  assert.equal(candidateBlocker(correctionOnly), null);
  assert.equal(canCreatePayout({ eligible: true, hasPayout: false }), false);
  assert.equal(canCreatePayout({ eligible: false, hasPayout: true }), false);
});

test('v2: مرشّح الصرف بـblockedBy من الخادم — iban_failed يحجب الدورة الآلية وحدها فيبقى اليدوي', () => {
  const base = { eligible: false, hasPayout: true, netHalalas: 8000, minPayoutHalalas: 5000 };
  assert.equal(canCreatePayout({ ...base, eligible: true, blockedBy: null }), true);
  assert.equal(candidateBlocker({ ...base, eligible: true, blockedBy: null }), null);
  assert.equal(canCreatePayout({ ...base, blockedBy: 'iban_failed' }), true, 'اليدوي متاح بعد فشل التحويل');
  assert.match(candidateBlocker({ ...base, blockedBy: 'iban_failed' })!, /فشل آخر تحويل/);
  for (const b of ['not_approved', 'below_min', 'no_iban', 'profile_incomplete', 'has_draft'] as const) {
    assert.equal(canCreatePayout({ ...base, blockedBy: b }), false, b);
    assert.ok(candidateBlocker({ ...base, blockedBy: b }), b);
  }
  assert.equal(canCreatePayout({ ...base, hasPayout: false, blockedBy: null }), false, 'بلا آيبان لا دفعة أبداً');
  // الحدّ الأدنى من شروط السفير نفسه لا من الإعدادات الحالية
  assert.equal(candidateBlocker({ ...base, netHalalas: 3000, blockedBy: 'below_min' }, 10000), 'دون الحدّ الأدنى 50 ر.س — يُرحَّل');
  assert.equal(candidateBlocker({ ...base, netHalalas: -10, blockedBy: 'below_min' }), 'الصافي صفر أو سالب');
  assert.equal(candidateBlocker({ ...base, blockedBy: 'profile_incomplete' }), 'ملفه غير مكتمل');
  assert.equal(candidateBlocker({ ...base, blockedBy: 'future_code' }), 'future_code', 'رمز مجهول يُعرض كما هو');
});

test('حالة قيد التصحيح: سُوّي فقط مع دفعة مسجَّلة', () => {
  assert.deepEqual(adjustmentState({ settled: true, inDraft: false }), { label: 'سُوّي', tone: 'green' });
  assert.deepEqual(adjustmentState({ settled: false, inDraft: true }), { label: 'في مسودّة دفعة', tone: 'blue' });
  assert.deepEqual(adjustmentState({ settled: false, inDraft: false }), { label: 'تُحتسب في الدفعة القادمة', tone: 'amber' });
  assert.equal(adjustmentState({}).label, 'تُحتسب في الدفعة القادمة', 'غياب الحقول لا يُعدّ تسوية');
  const withDraftPayout = { payoutId: 'p1', settled: false, inDraft: true };
  assert.notEqual(adjustmentState(withDraftPayout).label, 'سُوّي', 'payoutId لمسودّة ليس تسوية');
});

test('مرشّح الصرف: سبب عدم الأهلية', () => {
  assert.equal(candidateBlocker({ eligible: true, hasPayout: true, netHalalas: 20000 }, 10000), null);
  assert.match(candidateBlocker({ eligible: false, hasPayout: false, netHalalas: 20000 }) ?? '', /آيبان/);
  assert.match(candidateBlocker({ eligible: false, hasPayout: true, netHalalas: 5000 }, 10000) ?? '', /الحدّ الأدنى/);
  assert.match(candidateBlocker({ eligible: false, hasPayout: true, netHalalas: -100 }) ?? '', /سالب/);
});

test('تطبيع الردود: المصفوفات الغائبة تصير فارغة', () => {
  const d = normalizeDetail({ affiliate: { id: 'a' } } as unknown as Parameters<typeof normalizeDetail>[0]);
  for (const k of ['claims', 'attributions', 'commissions', 'adjustments', 'payouts', 'events'] as const) {
    assert.deepEqual(d[k], [], k);
  }
  const claims = normalizeClaims([{ id: 'c' }] as unknown as Parameters<typeof normalizeClaims>[0]);
  assert.deepEqual(claims[0].conflicts, []);
  assert.deepEqual(claims[0].suggestions, []);
  const attrs = normalizeAttributions([{ id: 't', flags: ['self_email'] }, { id: 'u' }] as unknown as Parameters<typeof normalizeAttributions>[0]);
  assert.deepEqual(attrs.map((a) => a.flags), [['self_email'], []]);
  assert.deepEqual(normalizeClaims(null as unknown as []), []);
});

test('كل رمز accrualReason له تسمية عربية — ولا تسميات يتيمة', () => {
  assertLabelled('AccrualReason', ACCRUAL_REASONS, ACCRUAL_REASON_LABEL);
  assert.equal(ACCRUAL_REASON_LABEL.outside_window, 'الدفعة خارج نافذة الإسناد — عدّل بداية الإسناد إن كان ذلك خطأً');
  assert.equal(ACCRUAL_REASON_LABEL.no_attribution, 'لا إسناد ساري للشركة');
  assert.equal(ACCRUAL_REASON_LABEL.error, 'تعذّر الاحتساب الآن — ستُعاد المحاولة تلقائياً');
  assert.equal(ACCRUAL_REASON_LABEL.earlier_payment_linked, 'رُبطت بالشركة دفعةٌ أقدم — أُوقفت العمولة القائمة للمراجعة');
});

test('رموز accrualReason مطابقة لقائمة API.md', () => {
  const doc = fs.readFileSync(fileURLToPath(new URL('../../../docs/affiliate/API.md', import.meta.url)), 'utf8');
  const line = doc.split('\n').find((l) => l.includes('رموز `accrualReason`'));
  assert.ok(line, 'سطر رموز accrualReason غير موجود في API.md');
  const codes = [...line!.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]).filter((c) => c !== 'accrualReason' && c !== 'null');
  assert.deepEqual([...ACCRUAL_REASONS].sort(), [...new Set(codes)].sort());
});

test('رسالة التنازع من كائن conflict: حالة الإسناد الآن وإيقاف العمولة', () => {
  assert.equal(
    conflictMessage({ attributionStatus: 'disputed', commissionHeld: true }),
    'الشركة مُسندة لسفير آخر برمز التسجيل — الإسناد الآن: متنازع عليه، وأُوقفت عمولته. احسمه من تبويب الإسناد بـ«إعادة إسناد»',
  );
  assert.equal(
    conflictMessage({ attributionStatus: 'void', commissionHeld: false }),
    'الشركة مُسندة لسفير آخر برمز التسجيل — الإسناد الآن: ملغى. احسمه من تبويب الإسناد بـ«إعادة إسناد»',
  );

  const withConflict = claimLinkMessage('مؤسسة النخبة', 'شركة النخبة', {
    attribution: { status: 'disputed' }, commissionCreated: false, accrualReason: null,
    conflict: { attributionStatus: 'disputed', commissionHeld: true },
  });
  assert.equal(withConflict.warn, true);
  assert.equal(withConflict.text, 'رُبط «مؤسسة النخبة» بـشركة النخبة. الشركة مُسندة لسفير آخر برمز التسجيل — الإسناد الآن: متنازع عليه، وأُوقفت عمولته. احسمه من تبويب الإسناد بـ«إعادة إسناد»');

  const noConflict = claimLinkMessage('مؤسسة النخبة', 'شركة النخبة', { attribution: { status: 'active' }, commissionCreated: true, accrualReason: null, conflict: null });
  assert.deepEqual(noConflict, { text: 'رُبط «مؤسسة النخبة» بـشركة النخبة — الإسناد: فعّال — وأُنشئت عمولة', warn: false });

  // للإسناد عمولةٌ قائمة ⇒ accrualReason = null ⇒ لا «أُنشئت» ولا سبب
  const existing = claimLinkMessage('م', 'ش', { attribution: { status: 'active' }, commissionCreated: false, accrualReason: null, conflict: null });
  assert.deepEqual(existing, { text: 'رُبط «م» بـش — الإسناد: فعّال', warn: false });
  const outside = claimLinkMessage('م', 'ش', { attribution: { status: 'active' }, commissionCreated: false, accrualReason: 'outside_window', conflict: null });
  assert.match(outside.text, /لم تُنشأ عمولة: الدفعة خارج نافذة الإسناد/);
});

test('رسالة إعادة الإسناد: نُقلت العمولة، أو أُنشئت، أو سبب عدم الإنشاء', () => {
  const moved = reassignMessage('شركة النور', { attribution: { status: 'active' }, commission: { status: 'pending' }, commissionCreated: false, accrualReason: null });
  assert.deepEqual(moved, { text: 'أُعيد إسناد شركة النور — الإسناد: فعّال — نُقلت العمولة — في فترة الحجز', warn: false });
  const held = reassignMessage('شركة النور', { attribution: { status: 'active' }, commission: { status: 'on_hold' }, commissionCreated: false, accrualReason: null });
  assert.match(held.text, /نُقلت العمولة — موقوفة$/);
  const created = reassignMessage('شركة النور', { attribution: { status: 'active' }, commission: { status: 'pending' }, commissionCreated: true, accrualReason: null });
  assert.match(created.text, /وأُنشئت عمولة \(في فترة الحجز\)$/);
  assert.doesNotMatch(created.text, /نُقلت/);
  const none = reassignMessage('شركة النور', { attribution: { status: 'active' }, commission: null, commissionCreated: false, accrualReason: 'no_payment' });
  assert.deepEqual(none, { text: 'أُعيد إسناد شركة النور — الإسناد: فعّال — لم تُنشأ عمولة: لا دفعة مؤكَّدة للشركة بعد', warn: true });
});

test('إجراءات بطاقة الترشيح: الرفض للمعتمد أيضاً، والربط للمعتمد والمنتهي بلا شركة', () => {
  assert.deepEqual(claimActions({ status: 'under_review', tenantId: null }), { approve: true, reject: true, link: false });
  assert.deepEqual(claimActions({ status: 'approved', tenantId: null }), { approve: false, reject: true, link: true });
  assert.deepEqual(claimActions({ status: 'approved', tenantId: 't1' }), { approve: false, reject: true, link: false });
  assert.deepEqual(claimActions({ status: 'expired', tenantId: null }), { approve: false, reject: false, link: true });
  assert.deepEqual(claimActions({ status: 'expired', tenantId: 't1' }), { approve: false, reject: false, link: false });
  for (const st of ['rejected', 'withdrawn', 'converted']) {
    assert.deepEqual(claimActions({ status: st, tenantId: null }), { approve: false, reject: false, link: false }, st);
  }
});

test('رسالة الربط: «أُنشئت عمولة» فقط حين commissionCreated، والتنازع والسبب يُذكران', () => {
  const base = 'رُبط الترشيح';
  assert.deepEqual(withAccrual(base, { commissionCreated: true, accrualReason: null, conflict: null }), { text: `${base} — وأُنشئت عمولة`, warn: false });
  // عمولة موجودة في الردّ لا تعني أنها أُنشئت الآن
  const existing = withAccrual(base, { commissionCreated: false, accrualReason: 'exists', conflict: null });
  assert.doesNotMatch(existing.text, /أُنشئت عمولة/);
  assert.match(existing.text, /للشركة عمولة مسبقاً/);
  assert.equal(existing.warn, true);

  const c = { attributionStatus: 'disputed', commissionHeld: true };
  const conflict = withAccrual(base, { commissionCreated: false, accrualReason: null, conflict: c });
  assert.ok(conflict.text.includes(conflictMessage(c)));
  assert.equal(conflict.warn, true);
  assert.doesNotMatch(conflict.text, /أُنشئت عمولة/);

  const outside = withAccrual(base, { commissionCreated: false, accrualReason: 'outside_window' });
  assert.match(outside.text, /لم تُنشأ عمولة: الدفعة خارج نافذة الإسناد/);

  assert.deepEqual(withAccrual(base, { commissionCreated: false, accrualReason: null }), { text: base, warn: false });
  assert.deepEqual(withAccrual(base, null), { text: base, warn: false });
  assert.match(withAccrual(base, { commissionCreated: false, accrualReason: 'new_code' }).text, /new_code/, 'رمز مجهول يُعرض كما هو');

  // ربط دفعة بشركة بلا سفير أمرٌ عادي — لا تنبيه
  const quiet = withAccrual('رُبطت الدفعة', { commissionCreated: false, accrualReason: 'no_attribution' }, { quietNoAttribution: true });
  assert.equal(quiet.warn, false);
  assert.match(quiet.text, /لا إسناد ساري للشركة/);
});

test('إعادة الإسناد: تحقّق وجسم وترشيحات السفير المعتمدة والمنتهية فقط', () => {
  const f = { affiliateId: 'a1', reason: 'أحالها بمكالمة موثّقة', effectiveFrom: '', claimId: '' };
  assert.equal(validateReassign(f), null);
  assert.match(validateReassign({ ...f, affiliateId: '' })!, /السفير/);
  assert.match(validateReassign({ ...f, reason: 'ab' })!, /السبب/);
  assert.match(validateReassign({ ...f, effectiveFrom: '2026-02-30' })!, /تاريخ/);
  assert.equal(validateReassign({ ...f, effectiveFrom: '2026-09-01' }), null);

  assert.deepEqual(buildReassignBody({ ...f, reason: '  سبب واضح  ' }), { affiliateId: 'a1', reason: 'سبب واضح' });
  assert.deepEqual(
    buildReassignBody({ ...f, effectiveFrom: '2026-09-01', claimId: 'c9' }),
    { affiliateId: 'a1', reason: 'أحالها بمكالمة موثّقة', effectiveFrom: '2026-09-01', claimId: 'c9' },
  );

  const claims = [
    { id: '1', affiliate: { id: 'a1' }, status: 'approved' },
    { id: '2', affiliate: { id: 'a1' }, status: 'expired' },
    { id: '3', affiliate: { id: 'a1' }, status: 'under_review' },
    { id: '4', affiliate: { id: 'a1' }, status: 'converted' },
    { id: '5', affiliate: { id: 'a2' }, status: 'approved' },
  ];
  assert.deepEqual(reassignClaimOptions(claims, 'a1').map((c) => c.id), ['1', '2']);
  assert.deepEqual(reassignClaimOptions(claims, ''), []);
  assert.deepEqual(reassignClaimOptions(null, 'a1'), []);
});

test('تعديل بداية الإسناد: تاريخ إلزامي وسبب', () => {
  assert.equal(validateWindow('2026-08-01', 'دفعة واتساب قبل إنشاء الحساب'), null);
  assert.match(validateWindow('', 'سبب كافٍ')!, /تاريخ/);
  assert.match(validateWindow('2026-13-01', 'سبب كافٍ')!, /تاريخ/);
  assert.match(validateWindow('2026-08-01', 'ab')!, /السبب/);
});

const CURRENT_RULES = { rateBps: 3000, holdDays: 30, minPayoutHalalas: 10000, refWindowDays: 90, claimLockDays: 60, firstPaymentWithinDays: 90 };

test('قواعد الشروط: الحقول من القيم الحالية، وتُرسل المتغيّرة فقط بوحدات الخادم', () => {
  for (const k of TERMS_RULE_KEYS) assert.ok(ARABIC.test(RULE_LABEL[k]), k);
  const inputs = rulesToInputs(CURRENT_RULES);
  assert.deepEqual(inputs, { rateBps: '30', holdDays: '30', minPayoutHalalas: '100', refWindowDays: '90', claimLockDays: '60', firstPaymentWithinDays: '90' });

  const same = parseRuleChanges(inputs, CURRENT_RULES);
  assert.ok(same.ok);
  assert.deepEqual(same.ok && same.value, {}, 'بلا تغيير ⇒ لا قواعد في الجسم');

  const changed = parseRuleChanges({ ...inputs, rateBps: '25.5', minPayoutHalalas: '150.25', refWindowDays: '٣٠' }, CURRENT_RULES);
  assert.ok(changed.ok);
  assert.deepEqual(changed.ok && changed.value, { rateBps: 2550, minPayoutHalalas: 15025, refWindowDays: 30 });

  assert.deepEqual(rulesOf({ ...CURRENT_RULES, intakeOpen: true, disclosureText: 'x' } as never), CURRENT_RULES, 'rulesOf يأخذ القواعد الست فقط');
});

test('قواعد الشروط: المدى مطابق للخادم', () => {
  assert.deepEqual(RULE_LIMITS, {
    rateBps: { min: 0, max: 10000 },
    holdDays: { min: 0, max: 365 },
    minPayoutHalalas: { min: 0, max: 100000000 },
    refWindowDays: { min: 1, max: 365 },
    claimLockDays: { min: 1, max: 365 },
    firstPaymentWithinDays: { min: 1, max: 730 },
  });
  const base = rulesToInputs(CURRENT_RULES);
  const check = (k: keyof typeof base, v: string, ok: boolean) =>
    assert.equal(parseRuleChanges({ ...base, [k]: v }, CURRENT_RULES).ok, ok, `${ok ? 'رُفض' : 'قُبل'} ${k}=${v}`);
  check('rateBps', '100.01', false); check('rateBps', '0', true); check('rateBps', '100', true);
  check('holdDays', '366', false); check('holdDays', '0', true); check('holdDays', '365', true);
  check('minPayoutHalalas', '1000000.01', false); check('minPayoutHalalas', '1000000', true);
  check('minPayoutHalalas', '0', true); check('minPayoutHalalas', '-1', false);
  check('refWindowDays', '0', false); check('refWindowDays', '366', false); check('refWindowDays', '365', true);
  check('claimLockDays', '0', false); check('claimLockDays', '366', false); check('claimLockDays', '365', true);
  check('firstPaymentWithinDays', '0', false); check('firstPaymentWithinDays', '731', false); check('firstPaymentWithinDays', '730', true);
});

test('قواعد الشروط: وصف التغييرات لنافذة التأكيد', () => {
  const lines = describeRuleChanges({ rateBps: 2500, holdDays: 45, minPayoutHalalas: 20000 }, CURRENT_RULES);
  assert.deepEqual(lines, [
    'نسبة العمولة: 30% ← 25%',
    'فترة الحجز: 30 يوماً ← 45 يوماً',
    'الحدّ الأدنى للصرف: 100 ر.س ← 200 ر.س',
  ]);
  assert.deepEqual(describeRuleChanges({}, CURRENT_RULES), []);
  assert.equal(formatRule('refWindowDays', undefined), '—');
});

// قرار المالك (19 نوفمبر 2026): PUT /settings صار يحمل أسعار السفراء أيضاً (packagePrices/yemenDiscountPct) عبر
// pricingDiff — وكان عنوان هذا الاختبار «يحمل intakeOpen وdisclosureText فقط». settingsDiff نفسه باقٍ كما هو: لا قيم شروط
test('الإعدادات: settingsDiff يحمل intakeOpen وdisclosureText وحدهما (والأسعار عبر pricingDiff)، والإفصاح 10 أحرف على الأقل', () => {
  const server = { intakeOpen: true, disclosureText: 'أحصل على عمولة إن اشتركت عبر رابطي', ...CURRENT_RULES };
  const draft = settingsDraftOf(server);
  assert.deepEqual(draft, { intakeOpen: true, disclosureText: 'أحصل على عمولة إن اشتركت عبر رابطي' });
  assert.deepEqual(settingsDiff(draft, server), {});
  assert.deepEqual(settingsDiff({ ...draft, intakeOpen: false }, server), { intakeOpen: false });
  assert.deepEqual(settingsDiff({ ...draft, disclosureText: '  نصّ جديد للإفصاح  ' }, server), { disclosureText: 'نصّ جديد للإفصاح' });
  const full = settingsDiff({ intakeOpen: false, disclosureText: 'x'.repeat(20) }, server);
  for (const k of TERMS_RULE_KEYS) assert.ok(!(k in full), `${k} لا يُرسل`);
  for (const k of ['packagePrices', 'yemenDiscountPct']) assert.ok(!(k in full), `${k} من pricingDiff وحده`);

  assert.equal(DISCLOSURE_MIN, 10);
  assert.ok(validateDisclosure('قصير جداً'));
  assert.equal(validateDisclosure('أحصل على عمولة'), null);
  assert.ok(validateDisclosure('x'.repeat(301)));
});

test('الإعدادات: إعادة الجلب لا تمحو تعديلات غير محفوظة', () => {
  const a = { intakeOpen: true, disclosureText: 'نصّ الإفصاح الأول' };
  const b = { intakeOpen: true, disclosureText: 'نصّ الإفصاح بعد التحديث' };
  assert.deepEqual(syncSettingsDraft(a, a, b), b, 'النموذج النظيف يتبنّى الجديد');
  const edited = { intakeOpen: false, disclosureText: 'نصّ الإفصاح الأول' };
  assert.deepEqual(syncSettingsDraft(edited, a, b), edited, 'المعدَّل يبقى');
});

test('الآيبان بمجموعات رباعية', () => {
  assert.equal(groupIban('sa0380000000608010167519'), 'SA03 8000 0000 6080 1016 7519');
  assert.equal(groupIban('SA03 8000 0000 6080 1016 7519'), 'SA03 8000 0000 6080 1016 7519');
  assert.equal(groupIban(''), '');
});

test('رسالة خطأ الخادم تُعرض كما هي، وإلا البديل', () => {
  assert.equal(apiErrorMessage({ response: { data: { message: 'لم تنتهِ فترة الحجز' } } }, 'تعذّر'), 'لم تنتهِ فترة الحجز');
  assert.equal(apiErrorMessage(new Error('network'), 'تعذّر'), 'تعذّر');
  assert.equal(apiErrorMessage({ response: { data: { message: '' } } }, 'تعذّر'), 'تعذّر');
  assert.equal(apiErrorMessage(null, 'تعذّر'), 'تعذّر');
});

test('AffiliatesPanel: سلوكيات العرض المرتبطة بالعقد الجديد', () => {
  const src = fs.readFileSync(fileURLToPath(new URL('./AffiliatesPanel.tsx', import.meta.url)), 'utf8');

  // تسجيل التحويل: المبلغ من الدفعة المُعادة، والنافذة تُغلق في النجاح والفشل
  const record = src.match(/function RecordPayoutDialog[\s\S]*?\n\}\n/);
  assert.ok(record, 'RecordPayoutDialog غير موجود');
  assert.match(record![0], /\(p\) => `سُجّل التحويل — \$\{L\.formatHalalas\(p\?\.netHalalas\)\}/, 'رسالة النجاح من لقطة الصفّ لا من الردّ');
  assert.doesNotMatch(record![0], /formatHalalas\(payout\.netHalalas\)\} لـ/, 'رسالة النجاح ما زالت من اللقطة');
  assert.doesNotMatch(record![0], /if \(ok\) onClose\(\)/, 'النافذة لا تُغلق عند الفشل');

  // الإعدادات: لا إعادة تركيب عند إعادة الجلب، ولا قيم شروط في PUT /settings
  assert.doesNotMatch(src, /<SettingsForm key=/, 'النموذج يُعاد تركيبه فيمحو التعديلات');
  assert.match(src, /لديك تعديلات غير محفوظة/);
  assert.match(src, /هذه القيم جزء من الشروط — تتغيّر بنشر إصدار جديد/);
  assert.doesNotMatch(src, /تغيير النسبة أو فترة الحجز لا يمسّ/, 'الملاحظة الخاطئة ما زالت');
  assert.match(src, /saveSettings: \(body: L\.SettingsBody\)/);
  assert.match(src, /publishTerms: \(body: \{ version: string; body: string; rules\?: Partial<L\.TermsRules> \}\)/);

  // الإسناد
  assert.match(src, /تُوقف عمولتها غير المصروفة \(إلا ما أوقفته يدوياً فيبقى بسببه\)؛ لنقلها لسفيرٍ آخر استعمل «إعادة إسناد» — لا ترفضها، فالرفض يُعاد احتسابه عند النقل/);
  assert.doesNotMatch(src, /فارفض العمولة من تبويب العمولات/, 'التلميح القديم يدفع لرفضٍ يُعاد احتسابه عند النقل');
  assert.doesNotMatch(src, /العمولة غير المصروفة تُعكس/);
  assert.doesNotMatch(src, /أبطل القائم أولاً/, 'التلميح ما زال يطلب الإبطال بدل «إعادة إسناد»');
  assert.match(src, /تنقل الشركة لهذا السفير وتُعيد احتساب عمولتها غير المصروفة \(والمرفوضة\) بنسبة شروطه، ويبقى إيقاف المالك اليدوي\. العمولة المصروفة يُقيَّد عكسها على السفير السابق ولصالح الجديد تلقائياً/);
  assert.match(src, /\(r\) => L\.reassignMessage\(row\.tenantName, r\)/, 'رسالة إعادة الإسناد لا تذكر نقل العمولة');
  assert.match(src, /success: \(res\) => L\.withAccrual\(`فُعّل إسناد \$\{t\.tenantName\}`/, 'التفعيل يتجاهل نتيجة الاحتساب');
  assert.match(src, /L\.claimLinkMessage\(/);
  assert.match(src, /const can = L\.claimActions\(c\)/);
  assert.match(src, /\{can\.reject && \(/, 'الرفض ما زال مقصوراً على قيد المراجعة');
  assert.match(src, /لاحتساب دفعةٍ تمّت قبل بداية الإسناد الحالية، كدفعة رابط تسجيل واتساب قبل إنشاء الحساب/);
  assert.match(src, /\/attributions\/\$\{id\}\/reassign/);
  assert.match(src, /\/attributions\/\$\{id\}\/window/);
  assert.match(src, /affApi\.claims\('approved'\)/);
  assert.match(src, /affApi\.claims\('expired'\)/);

  // «أُنشئت عمولة» لا تُبنى من وجود commission في ردود الربط
  assert.doesNotMatch(src, /r\?\.commission \? '، وأُنشئت عمولة'/);
  assert.doesNotMatch(src, /r\.commission \? 'رُبطت الدفعة بالشركة وأُنشئت عمولة/);

  // الصرف: الأهلية لا تشترط عمولات
  assert.match(src, /const can = L\.canCreatePayout\(c\)/);
  // التصحيحات: الحالة من settled/inDraft لا من payoutId
  assert.doesNotMatch(src, /j\.settled \?\? !!j\.payoutId/);
});

test('رقم تواصل الترشيح بصيغة الخادم المخزّنة: رابط tel: يُضيف + للجوال والدولي، وصفّ الترشيح يعرضه', () => {
  // قيمٌ كما يُعيدها GET /affiliate-admin/claims فعلاً (أرقامٌ مطبَّعة بلا +)
  assert.equal(telHref('966551234567'), 'tel:+966551234567', 'جوال سعودي');
  assert.equal(telHref('971501234567'), 'tel:+971501234567', 'دولي');
  assert.equal(telHref('0112345678'), 'tel:0112345678', 'ثابت يبدأ بصفر يُترك');
  assert.equal(telHref('920012345'), 'tel:920012345', 'موحّد قصير يُترك');
  assert.equal(telHref(''), null);
  assert.equal(telHref(null), null);
  assert.equal(phoneDisplay('966551234567'), '+966 55 123 4567');
  assert.equal(phoneDisplay('971501234567'), '+971501234567');
  assert.equal(phoneDisplay('0112345678'), '0112345678');
  assert.match(fs.readFileSync(fileURLToPath(new URL('./AffiliatesPanel.tsx', import.meta.url)), 'utf8'), /L\.phoneDisplay\(c\.contactPhone\)/);

  const src = fs.readFileSync(fileURLToPath(new URL('./AffiliatesPanel.tsx', import.meta.url)), 'utf8');
  assert.match(src, /c\.contactPhone && \(/, 'رقم التواصل لا يُعرض في صفّ الترشيح');
  assert.match(src, /href=\{L\.telHref\(c\.contactPhone\)!\}/, 'رقم التواصل ليس رابط tel:');
  assert.match(src, /رقم التواصل:/, 'لوحة المالك تبقى عربية');
});

// ─── v2 (قرار المالك ١٨ نوفمبر ٢٠٢٦ — V2_SPEC §3/§5/§8) ────────────────────

test('v2: حالة الملف لعمود «الملف» — ما ينقص بالترتيب الثابت، والغائب «—» لا «مكتمل»', () => {
  assert.deepEqual(profileState({ profileComplete: true, missing: [] }), { label: 'مكتمل', tone: 'green' });
  assert.deepEqual(profileState({ profileComplete: false, missing: ['national_id', 'iban'] }), { label: 'ينقصه: الآيبان، الهوية / الإقامة', tone: 'amber' });
  assert.equal(profileState({ profileComplete: false, missing: ['commercial_reg', 'partnerType'] }).label, 'ينقصه: نوع السفير، السجل التجاري');
  assert.equal(profileState({ profileComplete: false, missing: [] }).label, 'غير مكتمل');
  assert.equal(profileState({ profileComplete: false, missing: ['new_thing'] }).label, 'ينقصه: new_thing', 'رمز مجهول يُعرض كما هو');
  assert.deepEqual(profileState({}), { label: '—', tone: 'gray' }, 'خادمٌ أقدم بلا الحقلين');
});

test('v2: روابط التواصل — http/https وحدها تُفتح، والشكل غير المتوقع يسقط بأمان', () => {
  assert.equal(safeHttpUrl('https://x.com/fieldsa'), 'https://x.com/fieldsa');
  assert.equal(safeHttpUrl('  http://example.com '), 'http://example.com/');
  for (const bad of ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:text/html,<b>x</b>', 'ftp://x.com', 'x.com', '', null, undefined, 'https://']) {
    assert.equal(safeHttpUrl(bad as string | null | undefined), null, String(bad));
  }
  assert.deepEqual(
    socialLinksOf([{ platform: 'x', url: 'https://x.com/a' }, { url: 'https://b.com' }, { platform: 'instagram', url: '' }, null, 'str']),
    [{ platform: 'x', url: 'https://x.com/a' }, { platform: 'other', url: 'https://b.com' }],
  );
  assert.deepEqual(socialLinksOf({}), []);
  assert.deepEqual(socialLinksOf(null), []);
});

test('v2: معاينة المستند — الأنواع الأربعة المفحوصة وحدها، وPDF يُحوَّل لبايتات', () => {
  assert.deepEqual(documentPreview('data:image/png;base64,iVBORw0KGgo='), { kind: 'image', mime: 'image/png' });
  assert.deepEqual(documentPreview('data:image/jpeg;base64,/9j/'), { kind: 'image', mime: 'image/jpeg' });
  assert.deepEqual(documentPreview('data:image/webp;base64,UklGRg=='), { kind: 'image', mime: 'image/webp' });
  assert.deepEqual(documentPreview('data:application/pdf;base64,JVBERi0='), { kind: 'pdf', mime: 'application/pdf' });
  for (const bad of ['data:image/svg+xml;base64,PHN2Zz4=', 'data:text/html;base64,PGI+', 'https://x.com/a.png', 'data:image/png,raw', '', null]) {
    assert.equal(documentPreview(bad), null, String(bad));
  }
  assert.deepEqual([...(dataUrlToBytes('data:text/plain;base64,SGk=') ?? [])], [72, 105]);
  assert.equal(dataUrlToBytes('not-a-data-url'), null);
  assert.equal(formatBytes(812), '812 بايت');
  assert.equal(formatBytes(1536), '1.5 ك.ب');
  assert.equal(formatBytes(3 * 1024 * 1024), '3 م.ب');
  assert.equal(formatBytes(null), '—');
});

test('v2: دورة التسوية — نهاياتها 1 و11 و21 منتصف ليل الرياض، والقادمة من الخادم أولاً', () => {
  assert.equal(nextSettlementDayKey(Date.parse('2026-11-18T10:00:00Z')), '2026-11-21');
  assert.equal(nextSettlementDayKey(Date.parse('2026-11-10T20:59:59Z')), '2026-11-11', 'قبل منتصف ليل الرياض بثانية');
  assert.equal(nextSettlementDayKey(Date.parse('2026-11-10T21:00:00Z')), '2026-11-21', 'منتصف ليل ١١ بالرياض = دورته انتهت');
  assert.equal(nextSettlementDayKey(Date.parse('2026-11-21T12:00:00Z')), '2026-12-01');
  assert.equal(nextSettlementDayKey(Date.parse('2026-12-25T10:00:00Z')), '2027-01-01', 'رأس السنة');
  // لحظة الخادم (منتصف ليل الرياض = 21:00 UTC من اليوم السابق) تُقرأ يومَ الرياض لا يوم UTC
  assert.equal(nextSettlementKey('2026-11-20T21:00:00.000Z'), '2026-11-21');
  assert.equal(nextSettlementKey(null, Date.parse('2026-11-18T10:00:00Z')), '2026-11-21', 'خادمٌ أقدم ⇒ الحساب المحلي');
});

test('v2: فترة دفعة الدورة أيامٌ شاملة (النهاية حصريّة)، واليدوية بلا فترة', () => {
  assert.deepEqual(
    payoutPeriod({ periodStart: '2026-10-31T21:00:00.000Z', periodEnd: '2026-11-10T21:00:00.000Z', cycleKey: '2026-11-11' }),
    { from: '2026-11-01', to: '2026-11-10' },
  );
  assert.deepEqual(payoutPeriod({ periodStart: '2026-11-10T21:00:00.000Z', periodEnd: null, cycleKey: '2026-11-21' }), { from: '2026-11-11', to: '2026-11-20' });
  assert.equal(payoutPeriod({ periodStart: null, periodEnd: null, cycleKey: null }), null);
  assert.equal(payoutPeriod({}), null);
});

test('v2: فشل التحويل — سببٌ من 3 إلى 300 حرف (مدى الخادم)', () => {
  assert.equal(validateFailReason('الآيبان غير صحيح'), null);
  assert.match(validateFailReason('ab')!, /3/);
  assert.match(validateFailReason('  ab  ')!, /3/);
  assert.match(validateFailReason('x'.repeat(301))!, /300/);
  assert.equal(validateFailReason('x'.repeat(300)), null);
});

test('v2: ملاحظة الاعتماد التلقائي بعد الحجز (ويبقى اليدوي)', () => {
  assert.equal(daysText(1), 'يوم واحد');
  assert.equal(daysText(2), 'يومان');
  assert.equal(daysText(10), '10 أيام');
  assert.equal(daysText(30), '30 يوماً');
  assert.match(autoApproveNote(10), /تلقائياً/);
  assert.match(autoApproveNote(10), /10 أيام/);
  assert.match(autoApproveNote(undefined), /10 أيام/, 'الافتراضي حجز v4');
  assert.match(autoApproveNote(10), /الاعتماد اليدوي/);
  // التوقيت الحقيقي: نبضة المجدول كلّ ساعة لا دورة التسوية (1/11/21)
  assert.match(autoApproveNote(10), /خلال نحو ساعة من انتهاء فترة حجزها/);
  assert.doesNotMatch(autoApproveNote(10), /دورة التسوية/);
  assert.match(autoApproveNote(10), /والإيقاف ما لم تدخل مسودّة دفعة/);
});

test('v2: رسالة «تشغيل الدورة الآن» من ردّ الخادم — الدفعات ومجموعها والمعتمد تلقائياً ومن تُخطّي', () => {
  const r = settlementRunMessage({
    cycleKey: '2026-11-11', ran: true, reason: null, manual: true, autoApproved: 3,
    payouts: [{ id: 'p1', affiliateId: 'a', netHalalas: 12000 }, { id: 'p2', affiliateId: 'b', netHalalas: 8000 }],
    totalHalalas: 20000, skipped: { profile_incomplete: 2, below_min: 5, cycle_done: 1 },
  });
  assert.equal(r.warn, false);
  assert.match(r.text, /\(2026-11-11\)/);
  assert.match(r.text, /أُنشئت دفعتان بمجموع 200 ر\.س/);
  assert.match(r.text, /اعتُمدت تلقائياً 3 عمولة منذ الدورة السابقة/, 'الخادم يعدّ ما اعتمده النظام منذ الدورة السابقة');
  assert.match(r.text, /ملفه غير مكتمل: 2/);
  assert.match(r.text, /له دفعة في هذه الدورة: 1/);
  assert.doesNotMatch(r.text, /دون الحدّ/, 'ما دون الحدّ يُرحَّل بصمت');

  const none = settlementRunMessage({ cycleKey: '2026-11-11', ran: true, payouts: [], totalHalalas: 0, skipped: {} });
  assert.equal(none.warn, false);
  assert.match(none.text, /لا دفعات جديدة/);
  const busy = settlementRunMessage({ cycleKey: '2026-11-11', ran: false, reason: 'already_ran', payouts: [] });
  assert.equal(busy.warn, true);
  assert.match(busy.text, /أُنجزت أو تجري الآن/);
  assert.match(settlementRunMessage(null).text, /شُغّلت دورة التسوية/);
  assert.equal(skippedText({ below_min: 3 }), '');
  assert.equal(skippedText({ no_iban: 1, weird: 2 }), 'لم يُدخل آيبان بعد: 1 · weird: 2');
});

test('v2: «آخر دورة» للنظرة العامة والصرف', () => {
  assert.equal(lastCycleText(null), 'لم تُشغَّل دورة بعد');
  assert.equal(lastCycleText({ cycleKey: '2026-11-11', payouts: 3, totalHalalas: 15050, ranAt: '2026-11-11T00:05:00.000Z' }), 'آخر دورة 2026-11-11: 3 دفعات بمجموع 150.50 ر.س');
  assert.equal(lastCycleText({ cycleKey: '2026-11-11', payouts: 1, totalHalalas: 5000, ranAt: '2026-11-11T00:05:00.000Z' }), 'آخر دورة 2026-11-11: دفعة واحدة بمجموع 50 ر.س');
  assert.equal(lastCycleText({ cycleKey: '2026-11-11', payouts: 0, totalHalalas: 0, ranAt: null }), 'آخر دورة 2026-11-11: لم تُنجز بعد');
  assert.equal(lastCycleText({ cycleKey: '2026-11-11', payouts: 0, totalHalalas: 0, ranAt: '2026-11-11T00:05:00.000Z' }), 'آخر دورة 2026-11-11: 0 دفعة بمجموع 0 ر.س');
});

test('v2: تطبيع النظرة العامة — أرقام v2 الغائبة أصفار، وآخر دورة بلا مفتاح null', () => {
  const base = {
    affiliates: { approved: 3, suspended: 1, total: 4 }, attributions: { active: 1, disputed: 0 },
    commissions: { pendingHalalas: 0, onHoldHalalas: 0, readyToApprove: 0, approvedUnpaidHalalas: 0, paidHalalas: 0 },
  };
  const o = normalizeOverview(base);
  assert.equal(o.newAffiliates7d, 0);
  assert.equal(o.incompleteProfiles, 0);
  assert.equal(o.missedClaimsUnderReview, 0);
  assert.equal(o.nextSettlementAt, null);
  assert.equal(o.lastCycle, null);
  const full = normalizeOverview({ ...base, newAffiliates7d: 2, nextSettlementAt: '2026-11-20T21:00:00.000Z', lastCycle: { cycleKey: '2026-11-11', payouts: 2, totalHalalas: 500, ranAt: null } });
  assert.equal(full.newAffiliates7d, 2);
  assert.deepEqual(full.lastCycle, { cycleKey: '2026-11-11', payouts: 2, totalHalalas: 500, ranAt: null });
  assert.equal(normalizeOverview({ ...base, lastCycle: { payouts: 1 } as never }).lastCycle, null);
});

test('v2: تطبيع تفصيل السفير — الروابط والمستندات والمطالبات الفائتة، والحقول من الجذر احتياطاً', () => {
  const d = normalizeDetail({
    affiliate: {
      id: 'a', socialLinks: [{ platform: 'x', url: 'https://x.com/a' }],
      documents: [{ kind: 'national_id', mime: 'image/png', sizeBytes: 10, createdAt: '2026-11-18T10:00:00Z' }],
    },
  } as unknown as Parameters<typeof normalizeDetail>[0]);
  assert.equal(d.affiliate.socialLinks?.length, 1);
  assert.equal(d.affiliate.documents?.length, 1);
  assert.deepEqual(d.affiliate.missing, []);
  assert.deepEqual(d.missedClaims, []);
  const root = normalizeDetail({ affiliate: { id: 'a' }, partnerType: 'company', profileComplete: false, missing: ['commercial_reg'] } as unknown as Parameters<typeof normalizeDetail>[0]);
  assert.equal(root.affiliate.partnerType, 'company');
  assert.equal(root.affiliate.profileComplete, false);
  assert.deepEqual(root.affiliate.missing, ['commercial_reg']);
});

test('v2: المطالبات الفائتة — القبول والرفض لما تحت المراجعة، وشركةٌ وسبب، ومهلة ٣٠ يوماً', () => {
  assert.deepEqual(missedClaimActions({ status: 'under_review' }), { accept: true, reject: true });
  for (const st of ['accepted', 'rejected', 'withdrawn']) assert.deepEqual(missedClaimActions({ status: st }), { accept: false, reject: false }, st);

  assert.match(validateMissedAccept('', 'أكّدت الشركة بالهاتف')!, /الشركة/);
  assert.match(validateMissedAccept('t1', 'ab')!, /السبب/);
  assert.match(validateMissedAccept('t1', 'x'.repeat(501))!, /500/);
  assert.equal(validateMissedAccept('t1', 'أكّدت الشركة بالهاتف'), null);

  // الصيغة نفسها في الخادم: floor((submittedAt − createdAt)/يوم)
  assert.equal(daysFromSignup('2026-11-18T10:00:00Z', '2026-11-01T10:00:00Z'), 17);
  assert.equal(daysFromSignup('2026-11-18T09:00:00Z', '2026-11-01T10:00:00Z'), 16);
  assert.equal(daysFromSignup(null, '2026-11-01T10:00:00Z'), null);
  // القاعدة الواحدة مع القبول (missedClaims.ts: missedClaimDays/withinMissedClaimWindow): ٣٠ يوماً و٨ ساعات = اليوم
  // الثلاثون — داخلها ويقبلها الخادم؛ ٣١ يوماً كاملة خارجها ويرفضها claim_late
  assert.equal(daysFromSignup('2026-10-31T18:00:00Z', '2026-10-01T10:00:00Z'), 30);
  assert.equal(missedWindowLabel(daysFromSignup('2026-10-31T18:00:00Z', '2026-10-01T10:00:00Z'))!.tone, 'green');
  assert.equal(missedWindowLabel(daysFromSignup('2026-11-01T10:00:00Z', '2026-10-01T10:00:00Z'))!.tone, 'red');
  assert.equal(missedWindowLabel(daysFromSignup('2026-11-01T09:59:59Z', '2026-10-01T10:00:00Z'))!.tone, 'green', 'قبل اكتمال اليوم الحادي والثلاثين بثانية');

  assert.equal(missedWindowLabel(17)!.tone, 'green');
  assert.match(missedWindowLabel(17)!.label, /17 يوماً.*داخل المهلة/);
  assert.equal(missedWindowLabel(30)!.tone, 'green', 'اليوم الثلاثون داخلها');
  assert.equal(missedWindowLabel(31)!.tone, 'red');
  assert.match(missedWindowLabel(31)!.label, /خارج مهلة 30 يوماً/);
  assert.equal(missedWindowLabel(5, false)!.tone, 'red', 'withinWindow من الخادم يعلو');
  assert.equal(missedWindowLabel(-2)!.label, 'قُدّمت قبل تسجيل الشركة');
  assert.equal(missedWindowLabel(null), null);

  assert.deepEqual(
    missedAcceptMessage('مؤسسة النور', 'شركة النور', 'أحمد', { commissionCreated: true, accrualReason: null }),
    { text: 'قُبلت مطالبة «مؤسسة النور» — أُسندت شركة النور إلى أحمد — وأُنشئت عمولة', warn: false },
  );
  const noPay = missedAcceptMessage('م', 'ش', 'أ', { commissionCreated: false, accrualReason: 'no_payment' });
  assert.equal(noPay.warn, true);
  assert.match(noPay.text, /لا دفعة مؤكَّدة للشركة بعد/);
  assert.deepEqual(normalizeMissedClaims([{ id: 'm' }] as unknown as Parameters<typeof normalizeMissedClaims>[0])[0].suggestions, []);
  assert.deepEqual(normalizeMissedClaims(null as unknown as []), []);
});

test('v2: المواد التسويقية — ما تحتاجه كل فئة مطابقٌ للخادم', () => {
  assert.deepEqual(materialNeeds('image'), { file: 'required', url: 'none', text: 'optional' });
  assert.deepEqual(materialNeeds('document'), { file: 'required', url: 'none', text: 'optional' });
  assert.deepEqual(materialNeeds('video'), { file: 'optional', url: 'optional', text: 'optional' });
  assert.deepEqual(materialNeeds('link'), { file: 'none', url: 'required', text: 'optional' });
  assert.deepEqual(materialNeeds('text'), { file: 'none', url: 'none', text: 'required' });
  assert.equal(materialNeeds('bogus'), null);
  for (const c of MATERIAL_CATEGORIES) assert.ok(materialNeeds(c), c);
});

test('v2: المواد التسويقية — التحقّق قبل الرفع (الحجم والنوع والرابط والنصّ)', () => {
  const png = { name: 'a.png', size: 1000, type: 'image/png' };
  const f = { title: 'صورة الحملة', category: 'image' as const, url: '', textBody: '', file: png };
  assert.equal(validateMaterial(f), null);
  assert.match(validateMaterial({ ...f, title: 'a' })!, /عنوان/);
  assert.equal(validateMaterial({ ...f, category: '' }), 'اختر فئة المادة');
  assert.equal(validateMaterial({ ...f, file: null }), 'اختر الملف');
  assert.match(validateMaterial({ ...f, file: { ...png, type: 'application/pdf' } })!, /ليس صورة/);
  assert.match(validateMaterial({ ...f, category: 'document', file: png })!, /PDF/);
  assert.match(validateMaterial({ ...f, file: { ...png, size: MATERIAL_MAX_BYTES + 1 } })!, /٨ ميغابايت/);
  // دون ٨ ميغابايت لكن جسم JSON (base64 +٣٣٪) يتجاوز حدّ الخادم 10mb ⇒ يُرفض هنا لا بـ413
  assert.ok(materialBodyBytes(7_900_000, 'صورة', '') > JSON_BODY_LIMIT_BYTES);
  assert.match(validateMaterial({ ...f, file: { ...png, size: 7_900_000 } })!, /بعد الترميز/);
  assert.equal(validateMaterial({ ...f, file: { ...png, size: 7_000_000 } }), null);
  assert.match(validateMaterial({ ...f, file: { ...png, size: 0 } })!, /فارغ/);

  const v = { title: 'فيديو قصير', category: 'video' as const, url: '', textBody: '', file: null };
  assert.match(validateMaterial(v)!, /واحدٌ منهما/);
  assert.match(validateMaterial({ ...v, url: 'https://youtu.be/x', file: { name: 'v.mp4', size: 100, type: 'video/mp4' } })!, /واحدٌ منهما/);
  assert.equal(validateMaterial({ ...v, url: 'https://youtu.be/x' }), null);
  assert.equal(validateMaterial({ ...v, file: { name: 'v.mp4', size: 100, type: 'video/mp4' } }), null);

  const l = { title: 'صفحة البرنامج', category: 'link' as const, url: '', textBody: '', file: png };
  assert.equal(validateMaterial(l), 'اكتب الرابط');
  assert.match(validateMaterial({ ...l, url: 'javascript:alert(1)' })!, /https/);
  assert.equal(validateMaterial({ ...l, url: 'https://fieldsa.net/ambassadors' }), null, 'ملفٌ عالق من فئة سابقة لا يُحتسب');

  const t = { title: 'نصّ واتساب', category: 'text' as const, url: '', textBody: '', file: null };
  assert.equal(validateMaterial(t), 'اكتب النصّ الجاهز');
  assert.match(validateMaterial({ ...t, textBody: 'x'.repeat(4001) })!, /4000/);
  assert.equal(validateMaterial({ ...t, textBody: 'انضم لسفراء فيلد سيلز' }), null);
});

test('v2: جسم POST /materials — حقل المصدر الموافق للفئة وحده', () => {
  const png = { name: 'campaign.png', size: 1000, type: 'image/png' };
  assert.deepEqual(
    buildMaterialBody({ title: ' صورة ', category: 'image', url: 'https://stale', textBody: '', file: png }, 'data:image/png;base64,AAAA'),
    { title: 'صورة', category: 'image', dataUrl: 'data:image/png;base64,AAAA', fileName: 'campaign.png' },
  );
  assert.deepEqual(
    buildMaterialBody({ title: 'رابط', category: 'link', url: ' https://fieldsa.net/ambassadors ', textBody: ' انضم ', file: png }, 'data:image/png;base64,AAAA'),
    { title: 'رابط', category: 'link', url: 'https://fieldsa.net/ambassadors', textBody: 'انضم' },
  );
  assert.deepEqual(
    buildMaterialBody({ title: 'فيديو', category: 'video', url: 'https://youtu.be/x', textBody: '', file: null }),
    { title: 'فيديو', category: 'video', url: 'https://youtu.be/x' },
  );
  assert.deepEqual(
    buildMaterialBody({ title: 'نصّ', category: 'text', url: '', textBody: ' نصٌّ جاهز ', file: null }),
    { title: 'نصّ', category: 'text', textBody: 'نصٌّ جاهز' },
  );
});

test('v2: لوحة المالك — بلا موافقة طلبات، وبالتسوية وفشل التحويل والمطالبات الفائتة والمواد والمستندات', () => {
  const src = fs.readFileSync(fileURLToPath(new URL('./AffiliatesPanel.tsx', import.meta.url)), 'utf8');
  // الانضمام فوريّ: لا بطاقة «طلبات بانتظار المراجعة» ولا زرّا اعتماد/رفض للسفير
  assert.doesNotMatch(src, /طلبات انضمام بانتظار المراجعة/);
  assert.doesNotMatch(src, /كل طلب انضمام ينتظر موافقتك/);
  assert.doesNotMatch(src, /affiliateAction\(a\.id, '(approve|reject)'/);
  assert.match(src, /الانضمام فوريّ بلا موافقة/);
  assert.match(src, /البوابة: fieldsa\.net\/ax — صفحة البرنامج العلنية: fieldsa\.net\/ambassadors\/ —/);
  assert.match(src, /L\.PUBLIC_PAGE_URL/);
  // الرابط المُشارَك بالشرطة الأخيرة: Render يخدم المجلّد المصيَّر بها وحدها، وبدونها غلاف الرئيسية (معاينة خاطئة)
  assert.equal(PUBLIC_PAGE_URL, 'https://fieldsa.net/ambassadors/');
  // النظرة العامة
  for (const k of ['o.newAffiliates7d', 'o.incompleteProfiles', 'o.missedClaimsUnderReview', 'L.lastCycleText(o.lastCycle)', 'L.nextSettlementKey(o.nextSettlementAt)']) {
    assert.ok(src.includes(k), `النظرة العامة بلا ${k}`);
  }
  // الدرج: «عرض» المستند بصلاحية الآيبان وحدها، والجلب من مسار المالك المسجَّل
  const drawer = src.match(/function AffiliateDrawer[\s\S]*?\n\}\n/);
  assert.ok(drawer, 'AffiliateDrawer غير موجود');
  assert.match(drawer![0], /canIban && \(\s*<span[^>]*>\s*<ActionBtn[\s\S]{0,80}?setViewDoc\(kind\)/, 'زرّ «عرض» المستند بلا صلاحية affiliates.iban');
  assert.match(drawer![0], /روابط التواصل/);
  assert.match(drawer![0], /L\.SOCIAL_PLATFORM_LABEL/);
  assert.match(src, /\/affiliates\/\$\{id\}\/documents\/\$\{kind\}/);
  assert.match(src, /L\.documentPreview\(dataUrl\)/);
  // الجدول: النوع والملف
  assert.match(src, /<Th>النوع<\/Th>/);
  assert.match(src, /<Th>الملف<\/Th>/);
  // العمولات: الاعتماد التلقائي ويبقى اليدوي
  assert.match(src, /L\.autoApproveNote\(settings\?\.holdDays\)/);
  assert.match(src, /affApi\.commissionAction\(c\.id, 'approve'\)/);
  // الصرف: الدورة وتشغيلها وفشل التحويل والفترة
  assert.match(src, /\/settlement\/run/);
  assert.match(src, /\/payouts\/\$\{id\}\/fail/);
  assert.match(src, /function FailPayoutDialog/);
  assert.match(src, /L\.validateFailReason\(reason\)/);
  assert.match(src, /تشغيل الدورة الآن/);
  assert.match(src, /L\.settlementRunMessage\(/);
  assert.match(src, /L\.payoutPeriod\(p\)/);
  assert.match(src, /دورة التسوية كل ١٠ أيام \(١ و١١ و٢١/);
  // المطالبات الفائتة: القبول بربط شركة (TenantSearchBox) أو الرفض بسبب
  assert.match(src, /\/missed-claims\/\$\{id\}\/accept/);
  assert.match(src, /\/missed-claims\/\$\{id\}\/reject/);
  assert.match(src, /<TenantSearchBox selected=\{tenant\} onSelect=\{setTenant\} warnAttributed \/>/);
  assert.match(src, /L\.validateMissedAccept\(/);
  // المواد التسويقية
  assert.match(src, /api\.post\(`\$\{A\}\/materials`, body\)/);
  assert.match(src, /api\.delete\(`\$\{A\}\/materials\/\$\{id\}`\)/);
  assert.match(src, /L\.validateMaterial\(form\)/);
  // التصديرات التي تستوردها نافذة روابط الدفع
  assert.match(src, /export function TenantSearchBox/);
  assert.match(src, /export function LinkPaymentTenantDialog/);
});

// ─── أسعار الباقات في بوابة السفير (قرار المالك 19 نوفمبر 2026) ───────────
// المالك يحدّد من إعدادات السفراء سعر كل باقة يراه السفراء (شهرياً وسنوياً، ريالٌ صحيح شاملٌ الضريبة —
// الفارغ = الرسمي) ونسبة خصم سفراء اليمن (0–90). يُحفظ بزرّ «حفظ الإعدادات» نفسه عبر PUT /settings.

const CATALOG: PackageCatalogItem[] = [
  { id: 'starter', name: 'المبتدئة', monthly: 299, yearly: 2990 },
  { id: 'growth', name: 'المتوسطة', monthly: 399, yearly: 3990 },
  { id: 'pro', name: 'الاحترافية', monthly: 599, yearly: 5990 },
];
const readRepo = (...p: string[]) => fs.readFileSync(fileURLToPath(new URL(`../../../${p.join('/')}`, import.meta.url)), 'utf8');

test('أسعار السفراء: الحدود والنسبة الافتراضية والتقريب تطابق الخادم', () => {
  const svc = readRepo('backend', 'src', 'services', 'affiliate', 'pricing.ts');
  assert.match(svc, new RegExp(`AMB_PRICE_MIN = ${AMB_PRICE_MIN};`));
  assert.equal(AMB_PRICE_MAX, 1_000_000);
  assert.match(svc, /AMB_PRICE_MAX = 1_000_000;/);
  assert.match(svc, new RegExp(`YEMEN_PCT_MIN = ${YEMEN_PCT_MIN};`));
  assert.match(svc, new RegExp(`YEMEN_PCT_MAX = ${YEMEN_PCT_MAX};`));
  assert.match(svc, new RegExp(`dialPrefix: '967', pct: ${YEMEN_PCT_DEFAULT} `));
  assert.match(svc, /Math\.round\(\(riyals \* \(100 - pct\)\) \/ 100\) \* 100/, 'معاينة اللوحة بتقريب الخادم نفسه');
});

test('أسعار السفراء: السعر ريالٌ صحيح 1..1,000,000 والفارغ = الرسمي، والنسبة عددٌ صحيح 0..90', () => {
  assert.deepEqual(parseAmbPrice(''), { ok: true, value: null });
  assert.deepEqual(parseAmbPrice('   '), { ok: true, value: null });
  assert.deepEqual(parseAmbPrice('250'), { ok: true, value: 250 });
  assert.deepEqual(parseAmbPrice('٢٥٠'), { ok: true, value: 250 });
  assert.deepEqual(parseAmbPrice('2,990'), { ok: true, value: 2990 });
  assert.deepEqual(parseAmbPrice('1000000'), { ok: true, value: 1_000_000 });
  for (const bad of ['0', '-5', '249.5', '٢٤٩٫٥', '1000001', 'abc', '1e3']) {
    assert.deepEqual(parseAmbPrice(bad), { ok: false, error: AMB_PRICE_ERROR }, bad);
  }
  assert.deepEqual(parseYemenPct('33'), { ok: true, value: 33 });
  assert.deepEqual(parseYemenPct('0'), { ok: true, value: 0 });
  assert.deepEqual(parseYemenPct('٩٠٪'), { ok: true, value: 90 });
  for (const bad of ['', '91', '-1', '12.5', 'x']) assert.deepEqual(parseYemenPct(bad), { ok: false, error: YEMEN_PCT_ERROR }, bad);
});

test('أسعار السفراء: المسودّة من الخادم، والتحقّق، والجسم بالمتغيّر فقط (packagePrices كاملةً، و{} = الكلّ رسمي)', () => {
  const server = { packagePrices: { starter: { monthly: 250 }, enterprise: { monthly: 1 } }, yemenDiscountPct: 33, packageCatalog: CATALOG };
  const d = pricingDraftOf(server);
  assert.deepEqual(d, {
    prices: { starter: { monthly: '250', yearly: '' }, growth: { monthly: '', yearly: '' }, pro: { monthly: '', yearly: '' } },
    yemenPct: '33',
  }, 'المعرّف خارج الكتالوج يُهمل');
  const v0 = validatePricingDraft(d);
  assert.ok(v0.ok);
  if (v0.ok) assert.deepEqual(pricingDiff(v0.value, server), {}, 'لا تغيير ⇒ لا جسم');

  const d1 = setPackagePrice(d, 'pro', 'yearly', '٤٩٩٠');
  const v1 = validatePricingDraft(d1);
  assert.ok(v1.ok);
  if (v1.ok) {
    const body: SettingsBody = pricingDiff(v1.value, server);
    assert.deepEqual(body, { packagePrices: { starter: { monthly: 250 }, pro: { yearly: 4990 } } }, 'الخريطة كاملةً — الخادم يستبدلها');
  }

  assert.ok(hasCustomPrice(d1, 'starter'));
  const d2 = resetPackagePrice(d1, 'starter');
  assert.equal(hasCustomPrice(d2, 'starter'), false);
  assert.deepEqual(d2.prices.starter, { monthly: '', yearly: '' });
  const v2 = validatePricingDraft(d2);
  assert.ok(v2.ok);
  if (v2.ok) assert.deepEqual(pricingDiff(v2.value, server), { packagePrices: { pro: { yearly: 4990 } } });
  const all = validatePricingDraft(resetPackagePrice(d, 'starter'));
  assert.ok(all.ok);
  if (all.ok) assert.deepEqual(pricingDiff(all.value, server), { packagePrices: {} });

  const v3 = validatePricingDraft({ ...d, yemenPct: '0' });
  assert.ok(v3.ok);
  if (v3.ok) assert.deepEqual(pricingDiff(v3.value, server), { yemenDiscountPct: 0 }, 'النسبة وحدها');

  const bad = validatePricingDraft({ ...setPackagePrice(setPackagePrice(d, 'growth', 'monthly', '-1'), 'pro', 'yearly', '1.5'), yemenPct: '95' });
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    assert.equal(bad.error, AMB_PRICE_ERROR);
    assert.deepEqual(bad.invalid, ['growth.monthly', 'pro.yearly', 'yemenPct']);
  }
  const badPct = validatePricingDraft({ ...d, yemenPct: '' });
  assert.equal(badPct.ok, false);
  if (!badPct.ok) {
    assert.equal(badPct.error, YEMEN_PCT_ERROR);
    assert.deepEqual(badPct.invalid, ['yemenPct']);
  }

  // خادمٌ أقدم بلا كتالوج: لا حقول (القسم مخفيّ) ولا جسم
  assert.deepEqual(pricingDraftOf({}), { prices: {}, yemenPct: String(YEMEN_PCT_DEFAULT) });
  assert.deepEqual(cleanPackagePrices({ starter: { monthly: 0, yearly: 2.5 } }, ['starter']), {});
});

test('أسعار السفراء: إعادة الجلب لا تمحو تعديلاً غير محفوظ، و«٢٥٠» = « 250 »', () => {
  const a = pricingDraftOf({ packagePrices: {}, yemenDiscountPct: 33, packageCatalog: CATALOG });
  const b = pricingDraftOf({ packagePrices: { growth: { monthly: 349 } }, yemenDiscountPct: 25, packageCatalog: CATALOG });
  assert.deepEqual(syncPricingDraft(a, a, b), b, 'النظيفة تتبنّى الجديد');
  const edited = setPackagePrice(a, 'starter', 'monthly', '200');
  assert.deepEqual(syncPricingDraft(edited, a, b), edited, 'المعدَّلة تبقى');
  assert.ok(samePricingDraft(setPackagePrice(a, 'starter', 'monthly', '٢٥٠'), setPackagePrice(a, 'starter', 'monthly', ' 250 ')));
  assert.ok(!samePricingDraft(a, edited));
});

test('أسعار السفراء: معاينة سفير اليمن في اللوحة بتقريب الخادم (لأقرب ريال، النصف لأعلى)', () => {
  assert.equal(regionalPrice(299, 33), 200);
  assert.equal(regionalPrice(250, 33), 168, '١٦٧٫٥ ⇒ ١٦٨');
  assert.equal(regionalPrice(2990, 25), 2243, '٢٢٤٢٫٥ ⇒ ٢٢٤٣');
  assert.deepEqual(yemenPreview({ monthly: '250', yearly: '' }, CATALOG[0], 33), { monthly: 168, yearly: 2003 });
  assert.deepEqual(yemenPreview({ monthly: '-1', yearly: 'x' }, CATALOG[0], 33), { monthly: 200, yearly: 2003 }, 'التالف = الرسمي');
  assert.deepEqual(yemenPreview(undefined, CATALOG[2], 0), { monthly: 599, yearly: 5990 });
});

test('أسعار السفراء في اللوحة: كل نصٍّ عبر tr() ومترجمٌ في PHRASES بلغاته الأربع، ويُحفظ بزرّ الإعدادات نفسه', () => {
  const panel = fs.readFileSync(fileURLToPath(new URL('./AffiliatesPanel.tsx', import.meta.url)), 'utf8');
  const start = panel.indexOf('function PackagePricesSection(');
  assert.ok(start > 0, 'PackagePricesSection غير موجود');
  const section = panel.slice(start, panel.indexOf('\n}\n', start));
  const strings = fs.readFileSync(fileURLToPath(new URL('../i18n/strings.ts', import.meta.url)), 'utf8');
  const phrases = strings.slice(strings.indexOf('export const PHRASES'));
  const entryOf = (k: string): Record<string, string> | null => {
    const esc = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = phrases.match(new RegExp(`^\\s*'${esc}'\\s*:\\s*\\{([^\\n]*)\\},?\\s*$`, 'm'));
    if (!m) return null;
    const out: Record<string, string> = {};
    for (const lang of ['en', 'fr', 'tr', 'zh']) {
      const v = m[1].match(new RegExp(`\\b${lang}:\\s*(['"])((?:(?!\\1)[^\\\\]|\\\\.)*)\\1`));
      if (!v) return null;
      out[lang] = v[2];
    }
    return out;
  };

  const keys = new Set<string>([
    ...[...section.matchAll(/\btr\(\s*'((?:[^'\\]|\\.)*)'\s*\)/g)].map((m) => m[1]),
    ...CATALOG.map((c) => c.name), // tr(c.name) — الأسماء من كتالوج الخادم
    AMB_PRICE_ERROR, YEMEN_PCT_ERROR, // tr(error)
  ]);
  assert.ok(keys.size >= 16, `نصوص أقل من المتوقّع (${keys.size})`);
  const missing: string[] = [];
  const bad: string[] = [];
  for (const k of keys) {
    const e = entryOf(k);
    if (!e) { missing.push(k); continue; }
    for (const [lang, v] of Object.entries(e)) if (!v.trim() || ARABIC.test(v)) bad.push(`${k} (${lang})`);
  }
  assert.deepEqual(missing, [], `بلا ترجمة في PHRASES: ${missing.join(' | ')}`);
  assert.deepEqual(bad, [], `ترجمة فارغة أو عربية: ${bad.join(' | ')}`);
  // لا نصّ عربيّ خارج tr() في القسم
  const bare = section.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').replace(/\btr\(\s*'(?:[^'\\]|\\.)*'\s*\)/g, '');
  assert.ok(!ARABIC.test(bare), 'نصٌّ عربيّ خارج tr() في قسم الأسعار');

  // أسماء الكتالوج هنا = كتالوج الخادم
  const quotes = readRepo('backend', 'src', 'services', 'quotes.ts');
  for (const c of CATALOG) assert.ok(quotes.includes(`${c.id}: { name: '${c.name}', total: ${c.monthly}, yearly: ${c.yearly},`), c.id);

  // الحفظ بالزرّ نفسه وPUT /settings نفسه، والقسم يُخفى أمام خادمٍ أقدم
  const form = panel.slice(panel.indexOf('function SettingsForm('), start);
  assert.match(form, /L\.pricingDiff\(priced\.value, s\)/);
  assert.match(form, /if \(err \|\| !priced\.ok\) return;/);
  assert.match(form, /actions\.run\('settings:save', \(\) => affApi\.saveSettings\(diff\)/);
  assert.match(form, /\{!!s\.packageCatalog\?\.length && \(\s*<PackagePricesSection/);
  assert.match(form, /useEffect\(\(\) => \{\s*if \(L\.samePricingDraft\(pricingServer, pricingBase\)\) return;/, 'إعادة الجلب لا تمحو التعديل');
});

test('بوابة السفير: المشطوب سعر السفراء قبل خصم المنطقة (base) لا الكتالوج', () => {
  const screen = fs.readFileSync(fileURLToPath(new URL('../affiliate/screens/PricingScreen.tsx', import.meta.url)), 'utf8');
  assert.match(screen, /listH=\{pkg\.baseMonthlyHalalas \?\? pkg\.listMonthlyHalalas\}/);
  assert.match(screen, /listH=\{pkg\.baseYearlyHalalas \?\? pkg\.listYearlyHalalas\}/);
});

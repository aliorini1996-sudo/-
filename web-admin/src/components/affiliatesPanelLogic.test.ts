/**
 * حرّاس منطق لوحة «سفير فيلد سيلز» للمالك.
 *
 * ما يحرسه:
 *  - كل قيمة تعداد في API.md لها تسمية عربية — حالة جديدة بلا تسمية تظهر للمالك
 *    رمزاً إنجليزياً فيتخذ قراراً مالياً على ما لا يفهمه.
 *  - تحويل الريال ⇔ الهللات بلا فاصلة عائمة — هللة مقطوعة من عمولة هي مال
 *    حقيقي، و`0.29 * 100` ليس 29.
 *  - النسبة المئوية ⇔ نقاط الأساس (الإعدادات تُعرض نسبةً وتُرسل bps).
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
  USER_ACTIONS, ATTRIBUTION_ACTIONS, COMMISSION_ACTIONS,
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
});

test('التعدادات مطابقة حرفياً لـ API.md', () => {
  // مسار نسبي لملف الاختبار نفسه — لا لمجلد التشغيل
  const doc = fs.readFileSync(fileURLToPath(new URL('../../../docs/affiliate/API.md', import.meta.url)), 'utf8');
  const union = (name: string): string[] => {
    const m = new RegExp(`type ${name} = ([^;]+);`).exec(doc);
    assert.ok(m, `النوع ${name} غير موجود في API.md`);
    return [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
  };
  assert.deepEqual([...USER_STATUSES], union('UserStatus'));
  assert.deepEqual([...CLAIM_STATUSES], union('ClaimStatus'));
  assert.deepEqual([...ATTRIBUTION_STATUSES], union('AttributionStatus'));
  assert.deepEqual([...COMMISSION_STATUSES], union('CommissionStatus'));
  assert.deepEqual([...PAYOUT_STATUSES], union('PayoutStatus'));
  assert.deepEqual([...CLAIM_HOWS], union('ClaimHow'));
  assert.deepEqual([...CLAIM_REASONS], union('ClaimReason'));
  assert.deepEqual([...FLAGS], union('Flag'));
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

test('المرفوض يُعاد للمراجعة، والموقوف يُعاد تفعيله — بالمسار نفسه reactivate', () => {
  assert.deepEqual(USER_ACTIONS.rejected, ['reactivate']);
  assert.deepEqual(USER_ACTIONS.suspended, ['reactivate']);
  assert.equal(reactivateCopy('rejected').label, 'إعادة للمراجعة');
  assert.equal(reactivateCopy('suspended').label, 'إعادة تفعيل');
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

test('الإعدادات: PUT /settings يحمل intakeOpen وdisclosureText فقط، والإفصاح 10 أحرف على الأقل', () => {
  const server = { intakeOpen: true, disclosureText: 'أحصل على عمولة إن اشتركت عبر رابطي', ...CURRENT_RULES };
  const draft = settingsDraftOf(server);
  assert.deepEqual(draft, { intakeOpen: true, disclosureText: 'أحصل على عمولة إن اشتركت عبر رابطي' });
  assert.deepEqual(settingsDiff(draft, server), {});
  assert.deepEqual(settingsDiff({ ...draft, intakeOpen: false }, server), { intakeOpen: false });
  assert.deepEqual(settingsDiff({ ...draft, disclosureText: '  نصّ جديد للإفصاح  ' }, server), { disclosureText: 'نصّ جديد للإفصاح' });
  const full = settingsDiff({ intakeOpen: false, disclosureText: 'x'.repeat(20) }, server);
  for (const k of TERMS_RULE_KEYS) assert.ok(!(k in full), `${k} لا يُرسل`);

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

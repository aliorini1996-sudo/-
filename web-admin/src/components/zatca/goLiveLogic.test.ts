/**
 * حرّاس منطق «تفعيل المرحلة الثانية» ومراجعة الانتقال (Z5.8، TASK B).
 *
 * ما يحرسه:
 *  - تأكيد التفعيل «تفعيل» (مطابق للخادم)، وقاعدة ظهور الشاشة (envAllows === true وحده) — فشركةٌ لم تُفتح لها لا ترى شيئاً.
 *  - قائمة الجاهزية وحالة الأزرار (تسليح ثم go-live) مطابقة لبوابة الخادم.
 *  - تصنيف طابور مراجعة الانتقال (D11): تطبيع الصفوف، تسميات السبب والحالة، وإخفاء الشاشة عند 404 (شركة غير مربوطة).
 *  - كل تسمية عربية في المنطق والمكوّنين لها ترجمة كاملة بالإنجليزية والفرنسية والتركية والصينية (لا عربية في الترجمة).
 *  - توصيل التبويب: القسم الغنيّ خلف activationVisible، والزرّ المعطَّل باقٍ كما اليوم، ومراجعة الانتقال كسولة خلف PHASE2.
 *  - هُنَيْدات الواجهة البرمجية والنوع (client.ts / types) موصولة.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PHRASES } from '../../i18n/strings';
import { ZATCA_PHRASES } from './zatcaPhrases';
import { GO_LIVE_PHRASES } from './goLivePhrases';
import type { ZatcaGoLiveReadiness } from '../../types';
import {
  activationButtons, activationVisible, CUTOVER_REASON_LABEL, CUTOVER_STATUS_LABEL, cutoverIsPending, cutoverItemsFrom,
  cutoverReasonLabel, cutoverStatusLabel, cutoverStatusTone, GO_LIVE_CHECK_LABEL, GO_LIVE_CHECK_ORDER, GO_LIVE_CONFIRMATION_TEXT,
  goLiveCheckRows, goLiveErrorMessage, isCutoverStoreAbsent, isGoLiveConfirmed, REP_UNSYNCED_REASON_LABEL, repUnsyncedReasonLabel,
} from './goLiveLogic';

const phrase = (ar: string) => GO_LIVE_PHRASES[ar] ?? ZATCA_PHRASES[ar] ?? PHRASES[ar];
const LANGS = ['en', 'fr', 'tr', 'zh'] as const;

const readiness = (p: Partial<ZatcaGoLiveReadiness> = {}): ZatcaGoLiveReadiness => ({
  available: false,
  envAllows: true,
  armed: false,
  armedAt: null,
  checks: { unitActive: true, sellerReady: true, currencySar: true, repsSynced: false },
  reps: { ready: false, total: 0, synced: 0, unsynced: [] },
  ...p,
});

// ─── تأكيد التفعيل وظهور الشاشة ───

test('تأكيد التفعيل «تفعيل» مطابق للخادم (مع تشذيب الفراغ)', () => {
  assert.equal(GO_LIVE_CONFIRMATION_TEXT, 'تفعيل');
  assert.equal(isGoLiveConfirmed('تفعيل'), true);
  assert.equal(isGoLiveConfirmed('  تفعيل  '), true);
  assert.equal(isGoLiveConfirmed('تفعيلـ'), false);
  assert.equal(isGoLiveConfirmed('activate'), false);
  assert.equal(isGoLiveConfirmed(''), false);
});

test('الشاشة الغنيّة لا تظهر إلا حين هيّأ الخادم البوابة وسمح علم المنصّة (envAllows) — وإلا فالزرّ المعطَّل كما اليوم', () => {
  assert.equal(activationVisible({ goLiveReadiness: null }), false);
  assert.equal(activationVisible({ goLiveReadiness: undefined }), false);
  assert.equal(activationVisible({ goLiveReadiness: readiness({ envAllows: false }) }), false);
  assert.equal(activationVisible({ goLiveReadiness: readiness({ envAllows: true }) }), true);
});

// ─── قائمة الجاهزية وأزرارها ───

test('قائمة الجاهزية: ترتيب ثابت وحالة كل فحص من البوابة', () => {
  const rows = goLiveCheckRows(readiness({ checks: { unitActive: true, sellerReady: false, currencySar: true, repsSynced: false } }));
  assert.deepEqual(rows.map(r => r.key), [...GO_LIVE_CHECK_ORDER]);
  assert.deepEqual(rows.map(r => r.ok), [true, false, true, false]);
  assert.equal(rows[0].label, GO_LIVE_CHECK_LABEL.unitActive);
});

test('أزرار التفعيل: التسليح متاح قبله فقط، وgo-live يشترط الجاهزية الكاملة + الإقرار + كتابة «تفعيل»، ولا شيء أثناء العملية', () => {
  // بلا بوابة
  assert.deepEqual(activationButtons(null, 'تفعيل', true, false), { canArm: false, armed: false, canGoLive: false });
  // غير مُسلَّح ⇒ التسليح متاح، go-live لا
  const a = activationButtons(readiness({ armed: false, available: false }), 'تفعيل', true, false);
  assert.deepEqual(a, { canArm: true, armed: false, canGoLive: false });
  // مُسلَّح لكن غير جاهز ⇒ لا تسليح ولا go-live
  assert.deepEqual(activationButtons(readiness({ armed: true, available: false }), 'تفعيل', true, false), { canArm: false, armed: true, canGoLive: false });
  // جاهز كامل + إقرار + نصّ صحيح ⇒ go-live
  const ready = readiness({ armed: true, available: true });
  assert.equal(activationButtons(ready, 'تفعيل', true, false).canGoLive, true);
  assert.equal(activationButtons(ready, 'تفعيل', false, false).canGoLive, false, 'بلا إقرار المزامنة');
  assert.equal(activationButtons(ready, 'خطأ', true, false).canGoLive, false, 'نصّ تأكيد خاطئ');
  assert.equal(activationButtons(ready, 'تفعيل', true, true).canGoLive, false, 'أثناء عملية جارية');
  assert.equal(activationButtons(readiness({ armed: false, available: false }), 'تفعيل', true, true).canArm, false, 'لا تسليح أثناء عملية');
});

test('تسمية سبب عدم مزامنة المندوب: معروفة + احتياطية', () => {
  assert.equal(repUnsyncedReasonLabel('NO_REPORT'), REP_UNSYNCED_REASON_LABEL.NO_REPORT);
  assert.equal(repUnsyncedReasonLabel('OUTBOX_PENDING'), REP_UNSYNCED_REASON_LABEL.OUTBOX_PENDING);
  assert.equal(repUnsyncedReasonLabel('WHATEVER'), 'لم يزامن جهازه بعد');
});

test('رسالة رفض التفعيل: نصّ الخادم أولاً، ثم تسمية الرمز، ثم رسالة عامّة', () => {
  assert.equal(goLiveErrorMessage('GO_LIVE_NOT_READY', 'مناديب لم يزامنوا'), 'مناديب لم يزامنوا');
  assert.equal(goLiveErrorMessage('GO_LIVE_UNAVAILABLE', null).length > 0, true);
  assert.equal(goLiveErrorMessage('GO_LIVE_UNAVAILABLE', ''), 'التفعيل غير متاح الآن — لم تفتح المنصّة إطلاق المرحلة الثانية لشركتك بعد');
  assert.equal(goLiveErrorMessage(null, null), 'تعذّر تنفيذ الطلب');
});

// ─── طابور مراجعة الانتقال (D11) ───

test('تطبيع طابور مراجعة الانتقال: يقبل الصفوف الصالحة، يسقط ما لا معرّف له، ويطبّع الأنواع', () => {
  const parsed = cutoverItemsFrom({
    data: {
      items: [
        { id: 'a', clientRef: 'R1', clientCreatedAt: '2026-09-01T00:00:00Z', reason: 'WINDOW_EXPIRED', status: 'PENDING', amount: 12.5, salesRepId: 's1', customerId: 'c1' },
        { id: 42, reason: 'X' }, // معرّف غير نصّي ⇒ يُسقط
        { clientRef: 'no-id' },  // بلا معرّف ⇒ يُسقط
        { id: 'b', amount: 'nope', status: 'REJECTED' }, // amount غير رقميّ ⇒ null
      ],
    },
  });
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].id, 'a');
  assert.equal(parsed[0].amount, 12.5);
  assert.equal(parsed[1].amount, null);
  assert.equal(parsed[1].status, 'REJECTED');
  assert.deepEqual(cutoverItemsFrom(null), []);
  assert.deepEqual(cutoverItemsFrom({ data: {} }), []);
});

test('تسميات مراجعة الانتقال: سبب وحالة معروفان + احتياطي، ونبرة الحالة', () => {
  assert.equal(cutoverReasonLabel('CREATED_AFTER_GOLIVE'), CUTOVER_REASON_LABEL.CREATED_AFTER_GOLIVE);
  assert.equal(cutoverReasonLabel('???'), 'يحتاج مراجعة الإدارة');
  assert.equal(cutoverStatusLabel('ACCEPTED_PHASE2'), CUTOVER_STATUS_LABEL.ACCEPTED_PHASE2);
  assert.equal(cutoverStatusLabel('???'), 'حالة غير معروفة');
  assert.equal(cutoverStatusTone('PENDING'), 'pending');
  assert.equal(cutoverStatusTone('REJECTED'), 'danger');
  assert.equal(cutoverStatusTone('???'), 'muted');
  assert.equal(cutoverIsPending({ status: 'PENDING' }), true);
  assert.equal(cutoverIsPending({ status: 'ACCEPTED_PHASE1' }), false);
});

test('مراجعة الانتقال تُخفي نفسها فقط حين يردّ الخادم 404 GO_LIVE_UNAVAILABLE (شركة غير مربوطة بالإطلاق)', () => {
  assert.equal(isCutoverStoreAbsent(404, 'GO_LIVE_UNAVAILABLE'), true);
  assert.equal(isCutoverStoreAbsent(404, 'CUTOVER_NOT_FOUND'), false);
  assert.equal(isCutoverStoreAbsent(403, 'GO_LIVE_UNAVAILABLE'), false);
  assert.equal(isCutoverStoreAbsent(null, null), false);
});

// ─── الترجمة: كل تسمية عربية لها أربع لغات بلا عربية في الترجمة ───

test('كل تسمية عربية في المنطق (قوائم الجاهزية والأسباب والحالات والاحتياطيات) لها ترجمة كاملة بأربع لغات', () => {
  const labels = [
    ...Object.values(GO_LIVE_CHECK_LABEL),
    ...Object.values(REP_UNSYNCED_REASON_LABEL),
    ...Object.values(CUTOVER_REASON_LABEL),
    ...Object.values(CUTOVER_STATUS_LABEL),
    'لم يزامن جهازه بعد', 'يحتاج مراجعة الإدارة', 'حالة غير معروفة',
  ];
  for (const l of labels) {
    const t = phrase(l);
    assert.ok(t, `«${l}» بلا مدخل في القاموس`);
    for (const lang of LANGS) assert.ok(t[lang] && !/[؀-ۿ]/.test(t[lang]), `«${l}» بلا ترجمة ${lang}`);
  }
});

test('كل نصّ عربيّ مقتبس في مكوّنَي التفعيل والانتقال له مدخل في القاموس بأربع لغات (لا عربية في الترجمة)', () => {
  const files = ['./ZatcaActivationSection.tsx', './ZatcaCutoverPanel.tsx'];
  const seen = new Set<string>();
  for (const f of files) {
    const src = fs.readFileSync(fileURLToPath(new URL(f, import.meta.url)), 'utf8');
    // كل نصّ في سطرٍ واحد بين علامتَي اقتباس مفردتين يحوي حرفاً عربياً (يلتقط tr('…') وقيم الحوار والتنبيهات في شرط أو كائن).
    // استبعاد السطر الجديد يمنع تجاوز التعليقات العربية بين نصَّين (كلّ نصوصنا في سطرٍ واحد).
    for (const m of src.matchAll(/'([^'\n\\]*[؀-ۿ][^'\n\\]*)'/g)) seen.add(m[1]);
  }
  assert.ok(seen.size >= 20, `${seen.size} نصّاً عربياً — متوقّع أكثر`);
  for (const l of seen) {
    const t = phrase(l);
    assert.ok(t, `«${l}» بلا مدخل في القاموس`);
    for (const lang of LANGS) assert.ok(t[lang] && !/[؀-ۿ]/.test(t[lang]), `«${l}» بلا ترجمة ${lang}`);
  }
});

test('عبارات القسم كاملة بأربع لغات بلا عربية في الترجمة', () => {
  for (const [k, t] of Object.entries(GO_LIVE_PHRASES)) {
    for (const lang of LANGS) assert.ok(t[lang] && !/[؀-ۿ]/.test(t[lang]), `«${k}» بلا ترجمة ${lang}`);
  }
});

// ─── توصيل التبويب (حراسة ثابتة على الملف المشترك) ───

const readTab = () => fs.readFileSync(fileURLToPath(new URL('./ZatcaPhase2Tab.tsx', import.meta.url)), 'utf8');

test('التبويب: القسم الغنيّ خلف activationVisible والزرّ المعطَّل باقٍ كما اليوم لغير المفتوح لهم، ومراجعة الانتقال كسولة خلف PHASE2', () => {
  const tab = readTab();
  assert.match(tab, /import \{ activationVisible \} from '\.\/goLiveLogic';/);
  assert.match(tab, /activationVisible\(ov\) \?/, 'القسم الغنيّ مشروط بـactivationVisible');
  // شرط الزرّ المعطَّل والرسالة كما اليوم (فرع «وإلا») باقيان — لا شيء جديد لمن لم تُفتح له
  assert.ok(tab.includes("tr('تفعيل المرحلة الثانية')"), 'زرّ التفعيل المعطَّل باقٍ');
  assert.ok(tab.includes("tr('غير متاح قبل اكتمال ربط إصدار الفواتير')"), 'رسالة عدم التوفّر باقية');
  // القسمان كسولان (لا يدخلان حزمة من لا يفتح التبويب أو لا يُفتح له)
  assert.match(tab, /const loadZatcaActivationSection = \(\) => import\('\.\/ZatcaActivationSection'\);/);
  assert.match(tab, /const loadZatcaCutoverPanel = \(\) => import\('\.\/ZatcaCutoverPanel'\);/);
  // مراجعة الانتقال خلف PHASE2 (حيّ) فقط
  assert.match(tab, /ov\.regime === 'PHASE2' && <CutoverReviewCard \/>/);
});

test('هُنَيْدات الواجهة البرمجية والنوع موصولة (client.ts / types)', () => {
  const client = fs.readFileSync(fileURLToPath(new URL('../../api/client.ts', import.meta.url)), 'utf8');
  for (const m of ['goLiveReadiness:', 'armGoLive:', 'goLive:', 'cutoverList:', 'cutoverAccept:', 'cutoverReject:']) {
    assert.ok(client.includes(m), `client.zatcaApi.${m} غير موصول`);
  }
  const types = fs.readFileSync(fileURLToPath(new URL('../../types/index.ts', import.meta.url)), 'utf8');
  assert.match(types, /goLiveReadiness\?: ZatcaGoLiveReadiness \| null;/);
});

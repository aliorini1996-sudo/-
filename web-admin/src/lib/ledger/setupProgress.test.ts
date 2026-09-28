import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SETUP_STEP_COUNT, SETUP_STEPS, clampSetupStep, computeSetupProgress, setupProgressPercent, setupStepDisplayNo, setupStepLabel, setupWizardHref,
  type SetupDraftLike,
} from './setupProgress';

/**
 * تقدّم الإعداد (م‑2 وظ‑2): العدّاد وأوّل خطوة ناقصة ورابط المعالج.
 * الحقول المستعملة كلها من `GET /ledger/status` و`GET /ledger/setup` — لا حقل مخترعاً.
 * أربع خطوات بأرقام داخلية 1·3·5·6: «طريقة البدء» (2) و«الأرصدة المشتقة» (4) أُزيلتا بقرار الخبير المحاسبي
 * (كل تفعيل بداية نظيفة من يومه، والقيد الافتتاحي ما يُدخله المحاسب).
 */

const tr = (ar: string) => ar;

test('بلا مسودة (لا صلاحية تهيئة أو لم تُحمَّل): التقدّم مجهول ولا عدّاد كاذب', () => {
  const p = computeSetupProgress({ activatedAt: null });
  assert.equal(p.known, false);
  assert.equal(p.activated, false);
  assert.equal(p.done, 0);
  assert.equal(p.remaining, SETUP_STEP_COUNT);
  assert.equal(p.firstIncomplete, 1);
  assert.equal(p.steps.length, 4);
  assert.equal(SETUP_STEP_COUNT, 4);
  assert.deepEqual(computeSetupProgress({ activatedAt: null, draft: null }).known, false);
});

test('مسودة فارغة: معروفة وصفر خطوات، وأوّل ناقصة الأولى', () => {
  const p = computeSetupProgress({ activatedAt: null, draft: {} });
  assert.equal(p.known, true);
  assert.equal(p.done, 0);
  assert.equal(p.firstIncomplete, 1);
  assert.deepEqual(p.steps.map(s => s.key), ['basics', 'tree', 'manual', 'review']);
});

test('أثر كل خطوة في المسودة يحتسبها منجزة — وstep2 القديمة لا تُعدّ خطوة', () => {
  const draft: SetupDraftLike = {
    step1: { cutoverDate: '2026-09-01' },
    step2: { method: 'OPENING' },
    step3: { cashInvoiceRouting: 'MAIN_CASH', receiptRouting: { CASH: 'CUSTODY' } },
    step5: { rows: [] },
  };
  const p = computeSetupProgress({ activatedAt: null, draft });
  assert.deepEqual(p.steps.filter(s => s.done).map(s => s.step), [1, 3, 5]);
  // الأخيرة لا تكتمل إلا بالتفعيل
  assert.equal(p.firstIncomplete, 6);
  assert.equal(p.done, 3);
  assert.equal(p.remaining, 1);
});

test('currentStep يتجاوز الخطوات السابقة ولو خلت حقولها، ومسودة قديمة واقفة على خطوة مُزالة تُعدّ على التالية لها', () => {
  const p = computeSetupProgress({ activatedAt: null, draft: { currentStep: 5 } });
  assert.deepEqual(p.steps.filter(s => s.done).map(s => s.step), [1, 3]);
  assert.equal(p.firstIncomplete, 5);
  assert.equal(p.done, 2);
  const old4 = computeSetupProgress({ activatedAt: null, draft: { currentStep: 4 } });
  assert.deepEqual([old4.done, old4.firstIncomplete], [2, 5]);
  const old2 = computeSetupProgress({ activatedAt: null, draft: { currentStep: 2 } });
  assert.deepEqual([old2.done, old2.firstIncomplete], [1, 3]);
  // خطوة واحدة فقط: لا شيء تجاوزته بعد
  assert.equal(computeSetupProgress({ activatedAt: null, draft: { currentStep: 1 } }).done, 0);
  // رقم فاسد في المسودة المخزَّنة يرتدّ إلى 1 (قاعدة clampStep نفسها) فلا يُظهر تقدّماً لم يحدث
  assert.equal(computeSetupProgress({ activatedAt: null, draft: { currentStep: 99 } }).done, 0);
  assert.equal(computeSetupProgress({ activatedAt: null, draft: { currentStep: -3 } }).done, 0);
  assert.equal(computeSetupProgress({ activatedAt: null, draft: { currentStep: 6 } }).done, 3);
});

test('حقول الخطوة 3 الجزئية: أيّ من المسارين يكفي، والكائن الفارغ لا', () => {
  const only = computeSetupProgress({ activatedAt: null, draft: { step3: { receiptRouting: { CASH: 'DIRECT' } } } });
  assert.equal(only.steps[1].done, true);
  const empty = computeSetupProgress({ activatedAt: null, draft: { step3: {} } });
  assert.equal(empty.steps[1].done, false);
});

test('الأرصدة اليدوية بصفوف مدخلة أو بمصفوفة فارغة محفوظة — والغياب ناقص', () => {
  assert.equal(computeSetupProgress({ activatedAt: null, draft: { step5: { rows: [{ accountCode: '111001' }] } } }).steps[2].done, true);
  assert.equal(computeSetupProgress({ activatedAt: null, draft: { step5: { rows: [] } } }).steps[2].done, true);
  assert.equal(computeSetupProgress({ activatedAt: null, draft: { step5: {} } }).steps[2].done, false);
});

test('بعد التفعيل: الأربع كلها منجزة ولا بقية', () => {
  const p = computeSetupProgress({ activatedAt: '2026-09-20T08:00:00.000Z' });
  assert.equal(p.activated, true);
  assert.equal(p.known, true);
  assert.equal(p.done, 4);
  assert.equal(p.remaining, 0);
  assert.equal(p.firstIncomplete, 6);
});

test('التقدّم لا يتجاوز حدوده، والنسبة 0..100', () => {
  for (let n = 0; n <= 6; n++) {
    const p = computeSetupProgress({ activatedAt: null, draft: { currentStep: n + 1 } });
    assert.ok(p.done >= 0 && p.done <= p.total, `done=${p.done}`);
    assert.equal(p.done + p.remaining, p.total);
    const pct = setupProgressPercent(p);
    assert.ok(pct >= 0 && pct <= 100, `pct=${pct}`);
  }
  assert.equal(setupProgressPercent({ done: 3, total: 6 }), 50);
  assert.equal(setupProgressPercent({ done: 0, total: 0 }), 0);
  assert.equal(setupProgressPercent({ done: 9, total: 6 }), 100);
});

test('رابط المعالج يحمل الخطوة، وبلا خطوة يفتح الفهرس', () => {
  assert.equal(setupWizardHref(5), '/app/ledger?setupStep=5');
  assert.equal(setupWizardHref(4), '/app/ledger?setupStep=5', 'الخطوة 4 المُزالة');
  assert.equal(setupWizardHref(2), '/app/ledger?setupStep=3', 'الخطوة 2 المُزالة');
  assert.equal(setupWizardHref(), '/app/ledger');
  assert.equal(setupWizardHref(null), '/app/ledger');
  assert.equal(setupWizardHref(42), '/app/ledger?setupStep=1');
});

test('clampSetupStep يحرس المدى ويحوّل الخطوتين المُزالتين', () => {
  assert.equal(clampSetupStep('3'), 3);
  assert.equal(clampSetupStep(6.7), 6);
  assert.equal(clampSetupStep(0), 1);
  assert.equal(clampSetupStep(undefined), 1);
  assert.equal(clampSetupStep('x'), 1);
  assert.equal(clampSetupStep(2), 3);
  assert.equal(clampSetupStep(4), 5);
  assert.deepEqual(SETUP_STEPS.map(setupStepDisplayNo), [1, 2, 3, 4]);
});

test('لكل خطوة عنوان عربي غير فارغ ولا مكرر، ولا «طريقة البدء» ولا «الأرصدة المشتقة»', () => {
  const labels = SETUP_STEPS.map(n => setupStepLabel(tr, n));
  assert.equal(new Set(labels).size, 4);
  assert.ok(!labels.includes('الأرصدة المشتقة') && !labels.includes('طريقة البدء'));
  for (const l of labels) assert.match(l, /[؀-ۿ]/);
});

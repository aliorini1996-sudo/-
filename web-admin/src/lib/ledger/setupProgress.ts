import { LEDGER_BASE } from '../../pages/ledger/routes';

/**
 * تقدّم الإعداد المبدئي للدفاتر — دوالّ صرفة (م‑2 وظ‑2، مراجعة الخبير المحاسبي 2026‑09‑18).
 *
 * الخبير حفظ قيداً ثم قال «فين بقى الـPost؟ ده غير موجود خالص»، والزرّ موجود لكنه معطّل حتى
 * يُعتمد الإعداد وسببه مخفيّ في `title`. هذه الدوالّ تحوّل حالة الدفاتر والمسودة إلى تقدّم
 * معروض («٣ من ٦ خطوات») وإلى أوّل خطوة ناقصة يفتح عليها زرّ «أكمل الإعداد».
 *
 * **لا حقل مخترعاً**: المصدران هما `GET /ledger/status` (`activatedAt`) و`GET /ledger/setup`
 * (`draft` بحقولها `currentStep`, `step1.cutoverDate`, `step2.method`, `step3`, `step5.rows`
 * كما في `backend/src/routes/ledger/setup.ts`). المسودة تحتاج `canConfigureLedger`، فمن لا
 * يملكها يرى الحالة بلا عدّاد (`known === false`) لا رقماً مخترعاً.
 *
 * قاعدة «تمّت الخطوة»: أثرها في المسودة، **أو** أن المسودة تجاوزتها (`currentStep > n`) — لأن
 * الخطوة 4 (الأرصدة المشتقة) معاينة لا تحفظ حقلاً خاصاً بها (`onSave({}, 5)` في SetupReview.tsx).
 */

export const SETUP_STEPS = [1, 2, 3, 4, 5, 6] as const;
export type SetupStepNo = (typeof SETUP_STEPS)[number];
export const SETUP_STEP_COUNT = SETUP_STEPS.length;

export type SetupStepKey = 'basics' | 'method' | 'tree' | 'derived' | 'manual' | 'review';

/** مفاتيح ثابتة للخطوات (للاختبار والتتبّع) — الترتيب نفسه في SetupWizard.tsx */
export const SETUP_STEP_KEYS: Record<SetupStepNo, SetupStepKey> = {
  1: 'basics', 2: 'method', 3: 'tree', 4: 'derived', 5: 'manual', 6: 'review',
};

/** معامل الرابط الذي يفتح المعالج على خطوة بعينها */
export const SETUP_STEP_PARAM = 'setupStep';

type Tr = (ar: string) => string;

/** رقم خطوة صالح 1..6 (أي شيء آخر ⇒ 1) — مرآة clampStep في pages/ledger/setup/setupLogic.ts */
export const clampSetupStep = (n: unknown): SetupStepNo => {
  const v = Math.trunc(Number(n));
  return (v >= 1 && v <= 6 ? v : 1) as SetupStepNo;
};

/** ما يلزم من `GET /ledger/setup.draft` (شكل بنيوي يقبل `SetupDraft` كما هي) */
export interface SetupDraftLike {
  currentStep?: number | null;
  step1?: { cutoverDate?: string | null } | null;
  step2?: { method?: string | null } | null;
  step3?: { cashInvoiceRouting?: string | null; receiptRouting?: unknown } | null;
  step5?: { rows?: readonly unknown[] | null } | null;
}

export interface SetupProgressInput {
  /** `GET /ledger/status.activatedAt` (أو `setup.status.activatedAt`) */
  activatedAt?: string | null;
  /** `GET /ledger/setup.draft` — غيابه (لا صلاحية تهيئة أو لم يُحمَّل بعد) ⇒ `known === false` */
  draft?: SetupDraftLike | null;
}

export interface SetupStepProgress { step: SetupStepNo; key: SetupStepKey; done: boolean }

export interface SetupProgress {
  activated: boolean;
  /** المسودة معروفة (أو الدفاتر مفعّلة) ⇒ العدّاد يُعرض؛ وإلا يُعرض السبب بلا رقم */
  known: boolean;
  total: number;
  done: number;
  remaining: number;
  /** أوّل خطوة ناقصة (6 حين لا ينقص شيء) — وجهة زرّ «أكمل الإعداد» */
  firstIncomplete: SetupStepNo;
  steps: SetupStepProgress[];
}

/** حالة كل خطوة والتقدّم منها — صرفة، لا شبكة ولا حالة React. */
export function computeSetupProgress(input: SetupProgressInput): SetupProgress {
  const activated = !!input.activatedAt;
  const draft = input.draft ?? null;
  const known = activated || !!draft;
  // `currentStep` آخر خطوة بلغتها المسودة؛ غيابها ⇒ 1 (لم يتجاوز المستخدم شيئاً)
  const reached = draft?.currentStep == null ? 1 : clampSetupStep(draft.currentStep);
  const passed = (n: SetupStepNo) => !!draft && reached > n;
  const step3 = draft?.step3 ?? null;

  const doneOf: Record<SetupStepNo, boolean> = {
    1: activated || !!draft?.step1?.cutoverDate || passed(1),
    2: activated || !!draft?.step2?.method || passed(2),
    3: activated || !!(step3 && (step3.cashInvoiceRouting || step3.receiptRouting)) || passed(3),
    // الخطوة 4 معاينة إرشادية بلا حقل في المسودة: دليلها الوحيد تجاوزها
    4: activated || passed(4),
    5: activated || Array.isArray(draft?.step5?.rows) || passed(5),
    6: activated,
  };

  const steps: SetupStepProgress[] = SETUP_STEPS.map(n => ({ step: n, key: SETUP_STEP_KEYS[n], done: known && doneOf[n] }));
  const done = steps.filter(s => s.done).length;
  return {
    activated,
    known,
    total: SETUP_STEP_COUNT,
    done,
    remaining: SETUP_STEP_COUNT - done,
    firstIncomplete: steps.find(s => !s.done)?.step ?? 6,
    steps,
  };
}

/** نسبة الإنجاز 0..100 لشريط التقدّم */
export function setupProgressPercent(p: { done: number; total: number }): number {
  if (!(p.total > 0)) return 0;
  const v = Math.round((p.done / p.total) * 100);
  return v < 0 ? 0 : v > 100 ? 100 : v;
}

/**
 * رابط المعالج (فهرس الدفاتر) عند خطوة بعينها — `?setupStep=3`.
 * بلا خطوة يفتح المعالج حيث توقّفت المسودة.
 */
export function setupWizardHref(step?: number | null): string {
  if (step == null) return LEDGER_BASE;
  return `${LEDGER_BASE}?${SETUP_STEP_PARAM}=${clampSetupStep(step)}`;
}

/** عنوان الخطوة كما في المعالج — النداءات حرفية كي يلتقطها حارس القاموس */
export function setupStepLabel(tr: Tr, step: SetupStepNo): string {
  switch (step) {
    case 1: return tr('الأساس');
    case 2: return tr('طريقة البدء');
    case 3: return tr('الشجرة');
    case 4: return tr('الأرصدة المشتقة');
    case 5: return tr('الأرصدة اليدوية');
    case 6: return tr('المراجعة والتفعيل');
  }
}

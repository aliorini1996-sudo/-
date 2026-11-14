/**
 * «ربط الدفاتر بالنظام» — زرّ الاعتماد (L7 مبسّطة) وتحويل الدفاتر اليدوية (L9 مبسّطة). طلب المالك ١٤ نوفمبر ٢٠٢٦:
 * «مجرد زر تفعيل» — لا مسار ترحيل ولا جدولة جديدة: الاعتماد يمرّ بمسار التفعيل القائم (routes/ledger/setup.ts
 * POST /setup/commit — runSetupCommitRoute) فرعاً مربوطاً، ثم يرحّل المحرّكُ القائم كل المستندات بتواريخها (backfillState=RUNNING).
 *
 * هذه الوحدة تعطي ذلك المسار «خطّافات» الربط وحدها (LinkingCommitHooks) — setup.ts لا يستورد وحدات الربط قيمياً (حارس
 * «مظلمة» في linking-integration: لا يستوردها إلا routes/ledger/linking.ts)، فيمرّرها POST /linking/commit:
 *   - preconditions: شروط المنع البسيطة قبل أي كتابة — اسم الشركة حرفياً، العملة واحدة (P3 نفسه)، لا تاريخ إقفال يمسّ القيد
 *     الافتتاحي أو سنة الربط، وللتحويل (L9) لا قيد يدوياً (غير الافتتاح) مؤرّخاً في نافذة الربط ⇒ 409 LINKING_MANUAL_MOVES.
 *   - manualOptions/buildOpening: الافتتاح المشتقّ القائم (opening.ts — buildOpeningMove بسطوره المشتقّة) من computeDerivedOpening
 *     الذي يحسبه setup.ts بالمسند نفسه. للشركة المفعّل لها مخزون الشركة (warehouseEnabled ⇒ الجرد المستمر، L6) يضيف
 *     deriveInventory المخزونَ من محرّك التكلفة (114001/114002 لكل مندوب كما في linkedFrom — طيّ المعاينة نفسه) و211001 لكل
 *     مورّد و211002 (loadLinkedPayables)؛ تعذّر الطيّ بأمان (فوق السقف) ⇒ 409 LINKING_INVENTORY_TOO_LARGE لا افتتاح ناقص.
 *     الجرد الدوري: بلا سطور مخزون (سطوره يدوية تُقبل في الأرصدة اليدوية).
 *   - restateOpenings (L9): قيد نظام يعكس كل قيد افتتاحي قائم **بتاريخه نفسه** (فلا تتأثّر أرصدة ما بين التاريخين) بسبب
 *     LINKING_RESTATE — لا حذف لأي قيد؛ ثم يُرحَّل الافتتاح المشتقّ الجديد بتاريخ linkedFrom − 1.
 *     **موقوف** (LINKING_CONVERSION_AVAILABLE = false): كان يُسقط أرصدة البنك والأصول وحقوق الملكية من الافتتاح القديم، فالشروط
 *     ترد 409 LINKING_CONVERSION_UNAVAILABLE قبل أي قراءة حتى يُتاح إدخال أرصدة بداية السنة. الشيفرة باقية بلا وصول.
 *   - convert (L9 مبسّط B1، ما يستعمله الاعتماد فعلاً للدفاتر اليدوية المفعّلة): ربطٌ من تاريخ بدئها بلا مسّ الافتتاح القائم ولا أي قيد،
 *     وعكس القيود اليدوية المكرّرة بإقرار (convertManualBooks أدناه).
 *
 * لا مقارنة حرفية بطريقة الإعداد هنا (حارس b1-books-mode): الحكم عبر mode.ts في setup.ts.
 */
import type { GlSettings, Prisma } from '@prisma/client';
import { appendAudit, type AuditAction, type GlActor, type GlTx } from '../audit';
import { initialCursorRows } from '../backfill';
import { LINKED_CONTROL_KIND_OVERRIDES } from '../coa/sa';
import { isManualBooks } from '../mode';
import { initialWatermarkAt } from '../sync/classify';
import { addDays, compareLocalDate, fiscalYearStart, fromDbDate, toDbDate } from '../dates';
import { postMove, type PostedMove } from '../post';
import { loadBuildContext, requireMoveRecord, type LedgerContext, type MoveRecordForDraft } from '../resolve';
import { reversalDraftFromRecord } from '../reverse';
import type { InventoryMode, LocalDate, ReceiptRouting } from '../types';
import { buildOpeningMove, type DerivedOpening, type OpeningCutoff, type OpeningMoveInput, type OpeningMoveResult } from '../opening';
import { loadMoves } from '../../costing/streams';
import { replay } from '../../costing/stepper';
import { summarizeCosting } from '../../costing/summary';
import type { LocationTotals } from '../../costing/types';
import { CostingTooLargeError, foldCostingForPreview } from './costingFold';
import { LINKED_OPENING_ID_CHUNK, inventoryRepIds } from './openingLinked';
import { loadLinkedPayables } from './parity';
import { evaluateP3 } from './preflight';
import { LINKED_DEFAULT_RECEIPT_ROUTING, type LinkedOpeningPayables } from './types';

// ═══ الثوابت ═══

/** أساس الربط الوحيد في الزرّ: بأثر رجعي من بداية السنة المالية (قرار المالك) */
export const LINKING_COMMIT_BASIS = 'FY_RESTATED' as const;

/** سبب القيد العاكس للافتتاح القديم (GlMove.reversalReason) */
export const LINKING_RESTATE_REASON = 'LINKING_RESTATE';
export const LINKING_RESTATE_NARRATION = 'إعادة بناء الافتتاح عند ربط الدفاتر بالنظام (الافتتاح المشتقّ يحلّ محلّه)';

/** إجراءا التدقيق (audit.ts AUDIT_ACTIONS) — ويبقى `linking: true` في التفاصيل */
export const LINKING_AUDIT_ENABLE: AuditAction = 'LINKING_ENABLE';
export const LINKING_AUDIT_RESTATE: AuditAction = 'LINKING_RESTATE';

const LOCK_FIELDS = ['salesLockDate', 'purchaseLockDate', 'taxLockDate', 'hardLockDate'] as const;
type LockField = (typeof LOCK_FIELDS)[number];
const LOCK_LABELS_AR: Readonly<Record<LockField, string>> = {
  salesLockDate: 'إقفال المبيعات', purchaseLockDate: 'إقفال المشتريات', taxLockDate: 'إقفال الضريبة', hardLockDate: 'الإقفال النهائي',
};

export const LINKING_NAME_MISMATCH_MESSAGE = 'اكتب اسم الشركة كما هو تماماً لتأكيد ربط الدفاتر';
export const LINKING_FINAL_ACK_MESSAGE = 'ربط الدفاتر نهائي لا رجعة فيه — أقرّ بذلك قبل الاعتماد';

// ═══ صرفة ═══

/** تاريخ الربط: بداية السنة المالية لليوم المحلي (FY_RESTATED) */
export function linkingFromDate(today: LocalDate, fiscalYearEndMonth: number, fiscalYearEndDay: number): LocalDate {
  return fiscalYearStart(today, fiscalYearEndMonth, fiscalYearEndDay);
}

/** الاسم المكتوب يطابق اسم الشركة حرفياً (بعد قصّ المسافات في الطرفين وحدها) — الاسم الفارغ لا يطابق شيئاً */
export function companyNameMatches(expected: string | null | undefined, typed: unknown): boolean {
  if (typeof typed !== 'string' || typeof expected !== 'string') return false;
  const e = expected.trim();
  return e.length > 0 && typed.trim() === e;
}

export interface LockIssue { field: LockField; date: LocalDate; label: string }

/** تواريخ الإقفال التي تقع في `from` أو بعده (الإقفال يحكم «حتى تاريخه شاملاً») */
export function lockIssues(settingsRow: Partial<Record<LockField, Date | string | null>> | null | undefined, from: LocalDate): LockIssue[] {
  const out: LockIssue[] = [];
  if (!settingsRow) return out;
  for (const f of LOCK_FIELDS) {
    const v = settingsRow[f];
    if (v == null) continue;
    const d = typeof v === 'string' ? v.slice(0, 10) : fromDbDate(v);
    if (compareLocalDate(d, from) >= 0) out.push({ field: f, date: d, label: `${LOCK_LABELS_AR[f]} ${d}` });
  }
  return out;
}

/** أقدم التواريخ (القيد الافتتاحي الجديد وقيود الافتتاح القديمة المعكوسة بتواريخها) */
export function earliestDate(first: LocalDate, rest: readonly LocalDate[]): LocalDate {
  return rest.reduce((m, d) => (compareLocalDate(d, m) < 0 ? d : m), first);
}

/**
 * بداية نافذة القيود اليدوية المانعة للتحويل: linkedFrom، أو اليوم التالي لأقدم افتتاح قديم إن سبق تاريخَ الربط (دفاتر يدوية
 * بدأت في السنة السابقة) — فلا يُعكس افتتاحٌ تقوم عليه قيودٌ يدوية بعده.
 */
export function manualMovesFrom(linkedFrom: LocalDate, oldOpeningDates: readonly LocalDate[]): LocalDate {
  return earliestDate(linkedFrom, oldOpeningDates.map((d) => addDays(d, 1)));
}

export function linkingManualMovesMessage(count: number, from: LocalDate): string {
  return `لا تُحوَّل الدفاتر اليدوية إلى مربوطة: فيها ${count} قيداً يدوياً مؤرّخاً منذ ${from} — المستندات نفسها ستُرحَّل آلياً من هذا التاريخ فتتكرّر. اعكسها أو احذف مسوّداتها أولاً، أو اطلب المساعدة من الدعم الفني`;
}

// ═══ شروط المنع ═══

export interface LinkingBlock { status: number; code: string; message: string; details: Record<string, unknown> }

export interface OpeningToRestate { id: string; number: string | null; date: LocalDate }

export interface LinkingPlan {
  linkedFrom: LocalDate;
  converting: boolean;
  /** قيود الافتتاح القائمة (المرحّلة غير المعكوسة) — للتحويل وحده */
  openings: OpeningToRestate[];
}

/** أدنى عميل تحتاجه الشروط (المعاملة الحقيقية أو المزيّف في الاختبار) */
export type ActivateDb = Pick<GlTx, 'companySettings' | 'invoice' | 'glMove'>;

export interface PreconditionsInput {
  tenantId: string;
  linkedFrom: LocalDate;
  converting: boolean;
  /** صفّ gl_settings قبل الاعتماد (تواريخ الإقفال) أو null */
  settingsRow: Partial<Record<LockField, Date | null>> | null;
  /** عملة الدفاتر: لقطة الصفّ إن زُرع، وإلا ما سيزرعه القالب */
  glCurrency: string;
  /** currencyOverride ‖ currency؛ null = لا صفّ إعدادات للشركة */
  companyCurrency: string | null;
  typedCompanyName: string;
}

export async function loadOpeningsToRestate(db: Pick<GlTx, 'glMove'>, tenantId: string): Promise<OpeningToRestate[]> {
  const rows = await db.glMove.findMany({
    where: { tenantId, moveType: 'OPENING', state: 'POSTED', reversedMoveId: null, reversal: { is: null } },
    select: { id: true, number: true, date: true },
    orderBy: [{ date: 'asc' }, { id: 'asc' }],
  });
  return rows.map((r) => ({ id: r.id, number: r.number, date: fromDbDate(r.date) }));
}

/** القيود اليدوية (غير الافتتاح، مرحّلةً ومسودّة) المؤرّخة في `from` أو بعده */
export async function countManualMoves(db: Pick<GlTx, 'glMove'>, tenantId: string, from: LocalDate): Promise<number> {
  return db.glMove.count({ where: { tenantId, moveType: { not: 'OPENING' }, date: { gte: toDbDate(from) } } });
}

/**
 * L9 موقوف: تحويل الدفاتر اليدوية المفعّلة كان يُسقط أرصدة البنك والأصول وحقوق الملكية من الافتتاح القديم (أرصدة تاريخ البدء
 * اليدوي لا تاريخ الربط). يُتاح مع إدخال أرصدة بداية السنة — حتى ذلك يُرفض قبل أي قراءة أو كتابة.
 */
export const LINKING_CONVERSION_AVAILABLE: boolean = false;
export const LINKING_CONVERSION_UNAVAILABLE_CODE = 'LINKING_CONVERSION_UNAVAILABLE';
export const LINKING_CONVERSION_UNAVAILABLE_MESSAGE = 'تحويل الدفاتر اليدوية القائمة إلى مربوطة يُتاح قريباً مع إدخال أرصدة بداية السنة — لا تغيير على دفاترك';

/** العملة ثابتة: P3 نفسه في المعاينة — عملة الشركة = عملة الدفاتر، ولا فاتورة بعملة أخرى ⇒ 409 LINKING_CURRENCY، وإلا null */
async function currencyBlock(db: Pick<GlTx, 'invoice'>, tenantId: string, glCurrency: string, companyCurrency: string | null): Promise<LinkingBlock | null> {
  const groups = await db.invoice.groupBy({ by: ['currency'], where: { tenantId, currency: { not: null } }, _count: { _all: true } });
  const invoiceCurrencies = groups
    .filter((g): g is typeof g & { currency: string } => typeof g.currency === 'string')
    .map((g) => ({ currency: g.currency, invoices: g._count._all }))
    .sort((a, b) => (a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : 0));
  const p3 = evaluateP3({ mode: 'FULL', currency: glCurrency }, { company: { currency: companyCurrency, countryCode: '' }, invoiceCurrencies });
  if (p3.ok) return null;
  return { status: 409, code: 'LINKING_CURRENCY', message: p3.details, details: { reason: 'CURRENCY', glCurrency, companyCurrency, invoiceCurrencies } };
}

/** شروط المنع بالترتيب: التحويل (موقوف) ⇒ الاسم ⇒ العملة ⇒ الإقفال ⇒ القيود اليدوية (التحويل). لا كتابة. */
export async function linkingPreconditions(db: ActivateDb, i: PreconditionsInput): Promise<{ plan: LinkingPlan } | { block: LinkingBlock }> {
  if (i.converting && !LINKING_CONVERSION_AVAILABLE) {
    return {
      block: {
        status: 409, code: LINKING_CONVERSION_UNAVAILABLE_CODE, message: LINKING_CONVERSION_UNAVAILABLE_MESSAGE,
        details: { reason: 'CONVERSION_UNAVAILABLE' },
      },
    };
  }
  const cs = await db.companySettings.findUnique({ where: { tenantId: i.tenantId }, select: { name: true } });
  if (!companyNameMatches(cs?.name, i.typedCompanyName)) {
    return { block: { status: 422, code: 'LINKING_NAME_MISMATCH', message: LINKING_NAME_MISMATCH_MESSAGE, details: { reason: 'NAME_MISMATCH', field: 'companyName' } } };
  }

  const currency = await currencyBlock(db, i.tenantId, i.glCurrency, i.companyCurrency);
  if (currency) return { block: currency };

  const openings = i.converting ? await loadOpeningsToRestate(db, i.tenantId) : [];
  const openingDate = addDays(i.linkedFrom, -1);
  // القيد الافتتاحي الجديد (linkedFrom − 1) وعكس القديم بتاريخه: لا إقفال في أقدمهما أو بعده
  const lockFrom = earliestDate(openingDate, openings.map((o) => o.date));
  const locks = lockIssues(i.settingsRow, lockFrom);
  if (locks.length) {
    return {
      block: {
        status: 409, code: 'LINKING_LOCKED',
        message: `${locks.map((l) => l.label).join('، ')}: تاريخ إقفال لا يسبق القيد الافتتاحي (${lockFrom}) — ارفعه قبل ربط الدفاتر`,
        details: { reason: 'LOCK_DATES', from: lockFrom, locks },
      },
    };
  }

  if (i.converting) {
    const from = manualMovesFrom(i.linkedFrom, openings.map((o) => o.date));
    const count = await countManualMoves(db, i.tenantId, from);
    if (count > 0) {
      return { block: { status: 409, code: 'LINKING_MANUAL_MOVES', message: linkingManualMovesMessage(count, from), details: { reason: 'MANUAL_MOVES', count, from } } };
    }
  }
  return { plan: { linkedFrom: i.linkedFrom, converting: i.converting, openings } };
}

// ═══ L9: عكس الافتتاح القديم ═══

export interface RestatedOpening { originalId: string; originalNumber: string | null; reversalId: string; reversalNumber: string; date: LocalDate }

export interface RestateDeps {
  requireMoveRecord: (db: GlTx, tenantId: string, moveId: string) => Promise<MoveRecordForDraft & { id: string; number: string | null; state: string; reversal: { id: string } | null }>;
  postMove: typeof postMove;
}

const REAL_RESTATE_DEPS: RestateDeps = { requireMoveRecord, postMove };

/**
 * قيد نظام عاكس لكل افتتاح قديم، بتاريخ الأصل نفسه (لا يُزاح: الإقفال مفحوص في الشروط ⇒ REJECT)، وبنوعه نفسه (OPENING) فتبقى
 * مجاميع «القيد الافتتاحي» في الفحوص صافيةً = الافتتاح الجديد وحده. قفل gl-post ممسوك من المُستدعي.
 */
export async function restateOpenings(
  tx: GlTx,
  input: { tenantId: string; actor: GlActor; context: LedgerContext; now: Date; openings: readonly OpeningToRestate[] },
  deps: RestateDeps = REAL_RESTATE_DEPS,
): Promise<RestatedOpening[]> {
  const out: RestatedOpening[] = [];
  for (const o of input.openings) {
    const rec = await deps.requireMoveRecord(tx, input.tenantId, o.id);
    if (rec.state !== 'POSTED' || rec.reversal) continue;
    const date = fromDbDate(rec.date);
    const draft = reversalDraftFromRecord(rec, { date, reason: LINKING_RESTATE_NARRATION, originalNumber: rec.number });
    const posted: PostedMove = await deps.postMove(tx, draft, {
      tenantId: input.tenantId, actor: input.actor, context: input.context,
      validationMode: 'SYSTEM', lockPolicy: 'REJECT',
      reversedMoveId: rec.id, reversalReason: LINKING_RESTATE_REASON,
      auditAction: LINKING_AUDIT_RESTATE,
      auditSummary: `عكس القيد الافتتاحي ${rec.number ?? rec.id} عند ربط الدفاتر بالنظام`,
      auditExtra: { linking: true, reason: LINKING_RESTATE_REASON, originalNumber: rec.number, originalDate: date },
      now: input.now,
    });
    out.push({ originalId: rec.id, originalNumber: rec.number, reversalId: posted.id, reversalNumber: posted.number, date: posted.date });
  }
  return out;
}

// ═══ الافتتاح المشتقّ ═══

/**
 * خيارات validateManualBalanceRows للربط: حسابات السطور المشتقّة مرفوضة يدوياً. الجرد المستمر: المخزون والدائنون و211002
 * مشتقّة (مرفوضة يدوياً)؛ الدوري: المخزون يدويّ (OD7).
 */
export function linkedManualOptions(
  midVatPeriod: boolean, inventoryMode: InventoryMode = 'PERIODIC',
): { midVatPeriod: boolean; derivedAccounts: true; derivedInventory: boolean; derivedPayables: boolean } {
  const perpetual = inventoryMode === 'PERPETUAL';
  return { midVatPeriod, derivedAccounts: true, derivedInventory: perpetual, derivedPayables: perpetual };
}

/** طريقة الجرد للمربوطة: مخزون الشركة مفعّل (warehouseEnabled) ⇒ الجرد المستمر (L6) — مرآة params.ts في المعاينة */
export function linkedInventoryMode(warehouseEnabled: boolean | null | undefined): InventoryMode {
  return warehouseEnabled === true ? 'PERPETUAL' : 'PERIODIC';
}

export const LINKING_INVENTORY_TOO_LARGE_CODE = 'LINKING_INVENTORY_TOO_LARGE';
export const LINKING_INVENTORY_TOO_LARGE_MESSAGE =
  'حركات مخزون الشركة أكثر من أن تُقيَّم بأمان عند الاعتماد — لم يُربط شيء ولم يتغيّر شيء؛ تواصل مع الدعم';

/** ما يضيفه الجرد المستمر إلى الافتتاح المشتقّ */
export interface LinkedInventoryOpening {
  inventory: LocationTotals[] | null;
  salesRepNames: Record<string, string>;
  payables: LinkedOpeningPayables | null;
}

/**
 * الجرد المستمر: المخزون كما في linkedFrom من محرّك التكلفة (foldCostingForPreview — الطيّ نفسه الذي تعرضه المعاينة وتقيس به R8)
 * لكل موقع، وأسماء مناديب السيارات، والدائنون و211002. الدوري ⇒ لا شيء. فوق سقف الطيّ ⇒ block لا افتتاح ناقص.
 */
export async function deriveLinkedInventory(
  db: Prisma.TransactionClient, tenantId: string, i: { inventoryMode: InventoryMode; cut: OpeningCutoff; decimals: number; dbNow: Date },
): Promise<{ value: LinkedInventoryOpening } | { block: LinkingBlock }> {
  if (i.inventoryMode !== 'PERPETUAL') return { value: { inventory: null, salesRepNames: {}, payables: null } };
  let inventory: LocationTotals[];
  try {
    const folded = await foldCostingForPreview({ loadMoves, replay, summarizeCosting }, db, tenantId, {
      until: i.dbNow, currencyDecimals: i.decimals, cutoverDate: i.cut.cutoverDate, cutoverStart: i.cut.cutoverStart,
      openingSnapshotAt: i.cut.snapshotAt, timezone: i.cut.timezone,
    });
    inventory = [...folded.summary.openingByLocation];
  } catch (e) {
    if (e instanceof CostingTooLargeError) {
      return { block: { status: 409, code: LINKING_INVENTORY_TOO_LARGE_CODE, message: LINKING_INVENTORY_TOO_LARGE_MESSAGE, details: { reason: 'INVENTORY_TOO_LARGE' } } };
    }
    throw e;
  }
  const salesRepNames: Record<string, string> = {};
  const reps = inventoryRepIds(inventory);
  for (let k = 0; k < reps.length; k += LINKED_OPENING_ID_CHUNK) {
    const rows = await db.salesRep.findMany({ where: { tenantId, id: { in: reps.slice(k, k + LINKED_OPENING_ID_CHUNK) } }, select: { id: true, name: true } });
    for (const r of rows) salesRepNames[r.id] = r.name;
  }
  const payables = await loadLinkedPayables(db, tenantId, i.cut, i.decimals);
  return { value: { inventory, salesRepNames, payables } };
}

/**
 * القيد الافتتاحي المربوط: السطور المشتقّة (ذمم لكل عميل، عهدة لكل مندوب، أمانات، وللجرد المستمر المخزون والدائنون و211002)
 * ثم اليدوية ثم 319002.
 */
export function buildLinkedOpening(
  input: Omit<OpeningMoveInput, 'derived'>, opening: DerivedOpening, extra: LinkedInventoryOpening | null = null,
): OpeningMoveResult {
  return buildOpeningMove({
    ...input,
    derived: {
      opening, inventory: extra?.inventory ?? null,
      salesRepNames: { ...(input.salesRepNames ?? {}), ...(extra?.salesRepNames ?? {}) },
      payables: extra?.payables ?? null,
    },
  });
}

// ═══ L9 مبسّط (B1): تحويل الدفاتر اليدوية المفعّلة إلى مربوطة من تاريخ بدئها ═══
//
// الربط من تاريخ بدء الدفاتر اليدوية نفسه (linkedFrom = cutoverDate القائم، ولقطة openingSnapshotAt القائمة): لا يُمسّ قيد الافتتاح
// القديم ولا أي قيد — المحرّك يصنّف كالمربوطة (OPENING): ما قبل linkedFrom وأُنشئ حتى T0 القديم مشمول بالافتتاح (SKIPPED)، وما بعده
// يُرحَّل بتاريخه. القيود اليدوية المرحّلة منذ linkedFrom التي تمسّ حساباً يرحّله النظام آلياً تتكرّر ⇒ تُعكس بتاريخها الأصلي بقيد نظام
// (LINKING_DUPLICATE) بإقرار صريح (reverseDuplicates) — لا حذف لشيء.

export const LINKING_CONVERT_BASIS = 'FROM_ACTIVATION' as const;
export const LINKING_DUPLICATE_REASON = 'LINKING_DUPLICATE';
export const LINKING_DUPLICATE_NARRATION = 'عكس قيد يدوي مكرّر عند ربط الدفاتر: النظام يرحّل المستند نفسه آلياً';
export const LINKING_AUDIT_DUPLICATE: AuditAction = 'LINKING_DUPLICATE_REVERSE';
export const LINKING_DUPLICATES_ACK_CODE = 'LINKING_DUPLICATES_ACK';
export function linkingDuplicatesMessage(count: number, from: LocalDate): string {
  return `في دفاترك ${count} قيداً يدوياً منذ ${from} يمسّ حسابات يرحّلها النظام آلياً — تُعكس بتاريخها لأن النظام سيرحّلها تلقائياً (لا يُحذف شيء). أقرّ بعكسها ثم اربط`;
}

/** بادئات ما يرحّله النظام آلياً: الإيراد 411/412/413، والمخزون 114، والتكلفة 511/514، والموردون 211 — وحسابا الضريبة */
export const AUTO_POSTED_PREFIXES: readonly string[] = ['411', '412', '413', '114', '511', '514', '211'];
export const AUTO_POSTED_CODES: readonly string[] = ['212001', '116001'];
/** ليست إدخالاً يدوياً مكرّراً: الافتتاح والإقفالات وفروق العملة والمطابقة */
export const NON_DUPLICATE_MOVE_TYPES: readonly string[] = ['OPENING', 'TAX_CLOSING', 'FY_CLOSING', 'INV_CLOSING', 'FX', 'RECONCILE'];

export function isAutoPostedAccount(a: { code: string; controlKind: string | null }): boolean {
  return a.controlKind != null || a.code in LINKED_CONTROL_KIND_OVERRIDES || AUTO_POSTED_CODES.includes(a.code)
    || AUTO_POSTED_PREFIXES.some((p) => a.code.startsWith(p));
}

export interface LinkingDuplicate { id: string; number: string | null; date: LocalDate; moveType: string; ref: string | null; narration: string | null; totalMilli: string }

export type DuplicatesDb = Pick<GlTx, 'glAccount' | 'glMove'>;

/**
 * القيود اليدوية المكرّرة: مرحّلة، يدوية المنشأ بلا مستند مالك (sourceType فارغ)، غير معكوسة ولا عاكسة، ليست افتتاحاً ولا إقفالاً،
 * بتاريخ ≥ from، وتمسّ حساباً يرحّله النظام آلياً (نوع تحكّم أو البادئات أعلاه).
 */
export async function findLinkingDuplicates(db: DuplicatesDb, tenantId: string, from: LocalDate): Promise<LinkingDuplicate[]> {
  const accounts = await db.glAccount.findMany({
    where: {
      tenantId,
      OR: [
        { controlKind: { not: null } },
        { code: { in: [...AUTO_POSTED_CODES, ...Object.keys(LINKED_CONTROL_KIND_OVERRIDES)] } },
        ...AUTO_POSTED_PREFIXES.map((p) => ({ code: { startsWith: p } })),
      ],
    },
    select: { id: true, code: true, controlKind: true },
  });
  const ids = accounts.filter(isAutoPostedAccount).map((a) => a.id);
  if (!ids.length) return [];
  const rows = await db.glMove.findMany({
    where: {
      tenantId, state: 'POSTED', origin: 'MANUAL', sourceType: null, moveType: { notIn: [...NON_DUPLICATE_MOVE_TYPES] },
      reversedMoveId: null, reversal: { is: null }, date: { gte: toDbDate(from) }, lines: { some: { accountId: { in: ids } } },
    },
    select: { id: true, number: true, date: true, moveType: true, ref: true, narration: true, totalMilli: true },
    orderBy: [{ date: 'asc' }, { id: 'asc' }],
  });
  return rows.map((r) => ({
    id: r.id, number: r.number, date: fromDbDate(r.date), moveType: r.moveType, ref: r.ref, narration: r.narration, totalMilli: String(r.totalMilli),
  }));
}

/** صفّ gl_settings الذي يقرؤه التحويل */
export type ConvertSettingsRow = Pick<GlSettings, 'setupMethod' | 'activatedAt' | 'cutoverDate' | 'openingSnapshotAt' | 'currency' | 'receiptRouting'>
  & Partial<Record<LockField, Date | null>>;

export interface ConversionPlan { linkedFrom: LocalDate; snapshotAt: Date; duplicates: LinkingDuplicate[] }

export interface ConversionInput {
  tenantId: string;
  before: ConvertSettingsRow;
  companyCurrency: string | null;
  typedCompanyName: string;
  reverseDuplicates: boolean;
}

export type ConversionDb = Pick<GlTx, 'companySettings' | 'invoice' | 'glAccount' | 'glMove'>;

/** شروط التحويل بالترتيب بلا كتابة: يدوية مفعّلة بتاريخ بدء ⇒ الاسم ⇒ العملة ⇒ الإقفال منذ linkedFrom ⇒ إقرار القيود المكرّرة */
export async function conversionPreconditions(db: ConversionDb, i: ConversionInput): Promise<{ plan: ConversionPlan } | { block: LinkingBlock }> {
  const b = i.before;
  if (!b.activatedAt || !isManualBooks(b) || !b.cutoverDate || !b.openingSnapshotAt) {
    return { block: { status: 409, code: 'LINKING_NOT_MANUAL', message: 'التحويل للدفاتر اليدوية المفعّلة وحدها', details: { reason: 'NOT_MANUAL' } } };
  }
  const cs = await db.companySettings.findUnique({ where: { tenantId: i.tenantId }, select: { name: true } });
  if (!companyNameMatches(cs?.name, i.typedCompanyName)) {
    return { block: { status: 422, code: 'LINKING_NAME_MISMATCH', message: LINKING_NAME_MISMATCH_MESSAGE, details: { reason: 'NAME_MISMATCH', field: 'companyName' } } };
  }
  const currency = await currencyBlock(db, i.tenantId, b.currency || i.companyCurrency || '', i.companyCurrency);
  if (currency) return { block: currency };
  const linkedFrom = fromDbDate(b.cutoverDate);
  // المحرّك يرحّل منذ linkedFrom والعكس بتاريخ القيد الأصلي (≥ linkedFrom): لا إقفال في linkedFrom أو بعده
  const locks = lockIssues(b, linkedFrom);
  if (locks.length) {
    return {
      block: {
        status: 409, code: 'LINKING_LOCKED',
        message: `${locks.map((l) => l.label).join('، ')}: تاريخ إقفال لا يسبق تاريخ بدء الدفاتر (${linkedFrom}) — ارفعه قبل ربط الدفاتر`,
        details: { reason: 'LOCK_DATES', from: linkedFrom, locks },
      },
    };
  }
  const duplicates = await findLinkingDuplicates(db, i.tenantId, linkedFrom);
  if (duplicates.length && i.reverseDuplicates !== true) {
    return {
      block: {
        status: 409, code: LINKING_DUPLICATES_ACK_CODE, message: linkingDuplicatesMessage(duplicates.length, linkedFrom),
        details: { reason: 'DUPLICATES_ACK_REQUIRED', field: 'reverseDuplicates', count: duplicates.length, from: linkedFrom, moves: duplicates.slice(0, 50) },
      },
    };
  }
  return { plan: { linkedFrom, snapshotAt: b.openingSnapshotAt, duplicates } };
}

export interface ReversedDuplicate { originalId: string; originalNumber: string | null; reversalId: string; reversalNumber: string; date: LocalDate }

/**
 * عكس كل قيد مكرّر بقيد نظام **بتاريخه الأصلي** (lockPolicy REJECT — الإقفال مفحوص في الشروط) بسبب LINKING_DUPLICATE وتدقيق
 * LINKING_DUPLICATE_REVERSE — أدوات العكس القائمة نفسها (reversalDraftFromRecord + postMove بـreversedMoveId). المعكوس سلفاً يُتخطّى.
 * reverseMove لا يصلح هنا: وضعه اليدوي يرفض قيود حسابات التحكّم (الملكية)، والآلي يُزيح التاريخ إلى اليوم.
 */
export async function reverseLinkingDuplicates(
  tx: GlTx,
  input: { tenantId: string; actor: GlActor; context: LedgerContext; now: Date; duplicates: readonly LinkingDuplicate[] },
  deps: RestateDeps = REAL_RESTATE_DEPS,
): Promise<ReversedDuplicate[]> {
  const out: ReversedDuplicate[] = [];
  for (const d of input.duplicates) {
    const rec = await deps.requireMoveRecord(tx, input.tenantId, d.id);
    if (rec.state !== 'POSTED' || rec.reversal) continue;
    const date = fromDbDate(rec.date);
    const draft = reversalDraftFromRecord(rec, { date, reason: LINKING_DUPLICATE_NARRATION, originalNumber: rec.number });
    const posted: PostedMove = await deps.postMove(tx, draft, {
      tenantId: input.tenantId, actor: input.actor, context: input.context,
      validationMode: 'SYSTEM', lockPolicy: 'REJECT',
      reversedMoveId: rec.id, reversalReason: LINKING_DUPLICATE_REASON,
      auditAction: LINKING_AUDIT_DUPLICATE,
      auditSummary: `عكس القيد اليدوي المكرّر ${rec.number ?? rec.id} عند ربط الدفاتر — النظام يرحّل المستند نفسه آلياً`,
      auditExtra: { linking: true, reason: LINKING_DUPLICATE_REASON, originalNumber: rec.number, originalDate: date },
      now: input.now,
    });
    out.push({ originalId: rec.id, originalNumber: rec.number, reversalId: posted.id, reversalNumber: posted.number, date: posted.date });
  }
  return out;
}

export interface ConvertInput extends ConversionInput { actor: GlActor; actorId: string | null; dbNow: Date }
export interface ConvertResult {
  settings: GlSettings;
  linkedFrom: LocalDate;
  reversed: ReversedDuplicate[];
  inventoryMode: InventoryMode;
  watermarkAt: Date;
}

export interface ConvertDeps extends RestateDeps { loadContext: (tx: GlTx, tenantId: string) => Promise<LedgerContext>; appendAudit: typeof appendAudit }
const REAL_CONVERT_DEPS: ConvertDeps = { ...REAL_RESTATE_DEPS, loadContext: loadBuildContext, appendAudit };

/**
 * التحويل كلّه داخل معاملة الاعتماد (قفل gl-post ممسوك من المُستدعي): الشروط ⇒ عكس المكرّر ⇒ أنواع التحكّم المربوطة ⇒ التوجيه
 * الافتراضي ⇒ LINKED/FROM_ACTIVATION بـlinkedFrom = cutoverDate ولقطة الافتتاح القائمة، والجرد المستمر من linkedFrom لمخزون الشركة
 * المفعّل ⇒ مؤشّرات المربوطة (إن غابت) ⇒ RUNNING ⇒ تدقيق LINKING_ENABLE. لا يُمسّ قيد الافتتاح ولا activatedAt ولا cutoverDate.
 */
export async function convertManualBooks(
  tx: GlTx, i: ConvertInput, deps: ConvertDeps = REAL_CONVERT_DEPS,
): Promise<{ value: ConvertResult } | { block: LinkingBlock }> {
  const verdict = await conversionPreconditions(tx, i);
  if ('block' in verdict) return verdict;
  const { linkedFrom, snapshotAt, duplicates } = verdict.plan;
  const reversed = duplicates.length
    ? await reverseLinkingDuplicates(tx, { tenantId: i.tenantId, actor: i.actor, context: await deps.loadContext(tx, i.tenantId), now: i.dbNow, duplicates }, deps)
    : [];
  for (const [code, controlKind] of Object.entries(LINKED_CONTROL_KIND_OVERRIDES)) {
    await tx.glAccount.updateMany({ where: { tenantId: i.tenantId, code, controlKind: null }, data: { controlKind } });
  }
  const tenant = await tx.tenant.findUnique({ where: { id: i.tenantId }, select: { warehouseEnabled: true } });
  const inventoryMode = linkedInventoryMode(tenant?.warehouseEnabled);
  const settings = await tx.glSettings.update({
    where: { tenantId: i.tenantId },
    data: {
      setupMethod: 'LINKED', linkBasis: LINKING_CONVERT_BASIS, linkedFrom: toDbDate(linkedFrom), linkSnapshotAt: snapshotAt,
      linkedAt: i.dbNow, linkedBy: i.actorId, backfillState: 'RUNNING',
      inventoryMode, perpetualFromDate: inventoryMode === 'PERPETUAL' ? toDbDate(linkedFrom) : null,
      ...(i.before.receiptRouting == null ? { receiptRouting: { ...LINKED_DEFAULT_RECEIPT_ROUTING } as Prisma.InputJsonValue } : {}),
    },
  });
  const watermarkAt = initialWatermarkAt({ method: 'OPENING', cutoverDate: linkedFrom, openingSnapshotAt: snapshotAt, timezone: settings.timezone });
  await tx.glSyncCursor.createMany({ data: initialCursorRows(i.tenantId, inventoryMode, watermarkAt, { linked: true }), skipDuplicates: true });
  await deps.appendAudit(tx, {
    tenantId: i.tenantId, actor: i.actor, action: LINKING_AUDIT_ENABLE, entityType: 'SETTINGS', entityId: settings.id,
    summary: `تحويل الدفاتر اليدوية إلى مربوطة من تاريخ بدئها ${linkedFrom} — الافتتاح القائم باقٍ، وعُكس ${reversed.length} قيداً يدوياً مكرّراً — نهائي بلا فكّ`,
    before: { setupMethod: i.before.setupMethod, activatedAt: i.before.activatedAt, cutoverDate: linkedFrom },
    after: {
      method: 'LINKED',
      linking: {
        basis: LINKING_CONVERT_BASIS, linkedFrom, linkSnapshotAt: snapshotAt.toISOString(), converted: true, openingSource: 'MANUAL_KEPT',
        inventoryMode, watermarkAt: watermarkAt.toISOString(), reversedDuplicates: reversed, finalAcknowledged: true,
      },
    },
  });
  return { value: { settings, linkedFrom, reversed, inventoryMode, watermarkAt } };
}

/** حالة التحويل للبطاقة (قراءة فقط): هل الدفاتر يدوية مفعّلة، وتاريخ الربط، والقيود المكرّرة (عددها وأول ٥٠) */
export async function conversionStatus(db: Pick<GlTx, 'glSettings' | 'glAccount' | 'glMove'>, tenantId: string): Promise<{
  convertible: boolean; linkedFrom: LocalDate | null; duplicates: { count: number; moves: LinkingDuplicate[] };
}> {
  const s = await db.glSettings.findUnique({ where: { tenantId }, select: { setupMethod: true, activatedAt: true, cutoverDate: true } });
  if (!s?.activatedAt || !isManualBooks(s) || !s.cutoverDate) return { convertible: false, linkedFrom: null, duplicates: { count: 0, moves: [] } };
  const linkedFrom = fromDbDate(s.cutoverDate);
  const dups = await findLinkingDuplicates(db, tenantId, linkedFrom);
  return { convertible: true, linkedFrom, duplicates: { count: dups.length, moves: dups.slice(0, 50) } };
}

// ═══ الخطّافات التي يمرّرها POST /linking/commit إلى معالج الاعتماد (setup.ts) ═══

export interface LinkingCommitHooks {
  typedCompanyName: string;
  basis: typeof LINKING_COMMIT_BASIS;
  /** توجيه السندات حين لا تختاره المسودة ولا الصفّ (OD4 — المعاينة نفسها) */
  defaultReceiptRouting: Readonly<ReceiptRouting>;
  linkingFromDate: typeof linkingFromDate;
  preconditions: (db: GlTx, i: PreconditionsInput) => Promise<{ plan: LinkingPlan } | { block: LinkingBlock }>;
  manualOptions: typeof linkedManualOptions;
  inventoryMode: typeof linkedInventoryMode;
  deriveInventory: typeof deriveLinkedInventory;
  buildOpening: typeof buildLinkedOpening;
  restateOpenings: typeof restateOpenings;
  auditAction: string;
  /** L9 مبسّط (B1): إقرار عكس القيود اليدوية المكرّرة (من جسم POST /linking/commit) */
  reverseDuplicates: boolean;
  /** L9 مبسّط (B1): تحويل الدفاتر اليدوية المفعّلة داخل معاملة الاعتماد */
  convert: (tx: GlTx, i: Omit<ConvertInput, 'typedCompanyName' | 'reverseDuplicates'>) => Promise<{ value: ConvertResult } | { block: LinkingBlock }>;
}

export function linkingCommitHooks(typedCompanyName: string, opts: { reverseDuplicates?: boolean } = {}): LinkingCommitHooks {
  const reverseDuplicates = opts.reverseDuplicates === true;
  return {
    reverseDuplicates,
    convert: (tx, i) => convertManualBooks(tx, { ...i, typedCompanyName, reverseDuplicates }),
    typedCompanyName,
    basis: LINKING_COMMIT_BASIS,
    defaultReceiptRouting: LINKED_DEFAULT_RECEIPT_ROUTING,
    linkingFromDate,
    preconditions: linkingPreconditions,
    manualOptions: linkedManualOptions,
    inventoryMode: linkedInventoryMode,
    deriveInventory: deriveLinkedInventory,
    buildOpening: buildLinkedOpening,
    restateOpenings,
    auditAction: LINKING_AUDIT_ENABLE,
  };
}

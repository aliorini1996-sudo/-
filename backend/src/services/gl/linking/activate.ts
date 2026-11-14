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
 *
 * لا مقارنة حرفية بطريقة الإعداد هنا (حارس b1-books-mode): الحكم عبر mode.ts في setup.ts.
 */
import type { Prisma } from '@prisma/client';
import type { AuditAction, GlActor, GlTx } from '../audit';
import { addDays, compareLocalDate, fiscalYearStart, fromDbDate, toDbDate } from '../dates';
import { postMove, type PostedMove } from '../post';
import { requireMoveRecord, type LedgerContext, type MoveRecordForDraft } from '../resolve';
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

  // العملة ثابتة: P3 نفسه في المعاينة — عملة الشركة = عملة الدفاتر، ولا فاتورة بعملة أخرى
  const groups = await db.invoice.groupBy({ by: ['currency'], where: { tenantId: i.tenantId, currency: { not: null } }, _count: { _all: true } });
  const invoiceCurrencies = groups
    .filter((g): g is typeof g & { currency: string } => typeof g.currency === 'string')
    .map((g) => ({ currency: g.currency, invoices: g._count._all }))
    .sort((a, b) => (a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : 0));
  const p3 = evaluateP3({ mode: 'FULL', currency: i.glCurrency }, { company: { currency: i.companyCurrency, countryCode: '' }, invoiceCurrencies });
  if (!p3.ok) {
    return { block: { status: 409, code: 'LINKING_CURRENCY', message: p3.details, details: { reason: 'CURRENCY', glCurrency: i.glCurrency, companyCurrency: i.companyCurrency, invoiceCurrencies } } };
  }

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
}

export function linkingCommitHooks(typedCompanyName: string): LinkingCommitHooks {
  return {
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

// ============================================================================
// ZATCA المرحلة الثانية (Z5.5) — مسارات الإشعارات: المرتجع يصير إشعاراً دائناً مرتبطاً بأصله، والإلغاء يصير إشعاراً كاملاً
// ----------------------------------------------------------------------------
// z5_plan §3 «Z5.5» + §2.2 (معاملة الإصدار) + قرارات المالك D3/D4/Q1/Q5 + نقد الخطة (7، 11، 13، 20، 38):
//   • D3: لا مرتجع بلا أصل بعد الربط — POST /invoices بنوع RETURN يمرّ من هنا إلى إشعارٍ دائن يشير إلى فاتورته
//     (BT-25). وبلا أصلٍ في الطلب ⇒ 422 «اختر الفاتورة أولاً» كما كان.
//   • D4: الإلغاء بعد الربط ممنوع (409 قائم في PATCH /:id/cancel)، وبديله POST /:id/credit-note بـ`lines: 'FULL'`.
//   • Q5: الإشعار الكامل لمدير الشركة أو لمندوبٍ يملك «إلغاء الفاتورة»؛ والجزئيّ يبقى على قاعدة المرتجع اليوم
//     («إنشاء فاتورة»). والمدين لمدير الشركة وحده.
//   • نقد 20: نطاق المندوب هنا **بالعميل** لا بمُصدر الفاتورة — وإلّا تعذّر على مندوبٍ أن يُرجع بضاعةً باعها زميله
//     لعميله هو. (المسار يفحص canAccessCustomer قبل أن يصل شيء إلى هنا.)
//   • ترتيب الأقفال (§0.4 ونقد 38): وحدة الفوترة ⇒ الفاتورة الأصلية (FOR UPDATE) ⇒ إشعاراتها السابقة ⇒ المستند ⇒
//     صفّ الإشعار ⇒ دفتر العميل. والتحضير يجري **مرّتين**: مرّةً قبل أيّ قفل (كلّ رفضٍ رخيص قبل استهلاك ICV) ومرّةً
//     تحت القفل من الصفوف المقفلة وهي الحاكمة — فإشعارٌ سابق التزم بيننا يُفشل الثاني بحارس الكمية لا بازدواج صامت.
//   • نقد 13: أثر الإشعار على متبقّي الأصل يُكتب **فرقاً نسبياً** (decrement) لا قيمةً مطلقة، وروابط الدفع القديمة
//     تُماتُ بعد الالتزام — فلا يدفع العميل رابطاً لمبلغٍ أُسقط عنه.
//   • الاعتماد قبل المشاركة (Z5.4) يسري على الإشعار كما يسري على الفاتورة: القياسيّ يُعتمد داخل الطلب (201/202/422)
//     والمبسّط يُبلَّغ خلال ٢٤ ساعة. ورفض القياسيّ يُبطل الإشعار ويردّ متبقّي الأصل (services/invoiceVoid).
// لا يستورد services/gl ولا config/database (الاعتماديات تُحقن — الإنتاج في invoicesZatcaDeps.ts).
// ============================================================================

import type { Prisma, PrismaClient } from '@prisma/client';
import { ZatcaHttpError, noteLinesError, unitUnavailableError } from '../compliance/zatca/errors';
import { issuanceHttpError, type IssuanceCustomer, type IssuanceSellerSettings } from '../compliance/zatca/issue';
import { openIssuanceSigning } from '../compliance/zatca/issueSigner';
import { runIssuance, type StampInTxResult } from '../compliance/zatca/issueTx';
import type { InvoiceSubtype } from '../compliance/zatca/mapInvoice';
import type { UblParty } from '../compliance/zatca/model';
import {
  creditableLines, effectiveCreditScope, hasCreditableQty, noteEligibility, noteInvoiceColumns, noteItemColumns, noteNumberPrefix,
  noteRefusalError, prepareCreditNote, prepareDebitNote, creditNoteLegacyColumns, creditedTotalOf, debitNoteLegacyColumns,
  remainingAfterCreditNote, resolveReturnToStock, stampNoteInTx,
  type CreditLinesRequest, type CreditScope, type CreditableLine, type DebitNoteLineInput, type LegacyReturnQty,
  type NoteEligible, type NoteKind, type NoteOriginalInvoice, type NoteOriginalItem, type PreparedNote, type PriorNote,
} from '../compliance/zatca/notes';
import { resolveInvoiceRegime } from '../compliance/zatca/regime';
import {
  capsGate, clearStandardInline, einvoiceView, isReplayRequest, regimeSettingsOf,
  type ClientCapsHeaders, type EinvoiceView, type Phase2IssuanceDeps, type Phase2LedgerHooks, type Phase2Result, type Phase2Tx,
} from './invoicesZatca';

// ─── الاعتماديات ───

/** قيود دفتر العميل للإشعارات — دوالّ services/accounting نفسها التي يستدعيها المسار القديم. */
export interface NoteLedgerHooks {
  /** services/accounting.postReturnEntries (الإشعار الدائن = مرتجع في الدفتر). */
  postReturn(tx: Phase2Tx, tenantId: string, invoiceId: string, customerId: string, total: number, at: Date): Promise<void>;
  /** services/accounting.postInvoiceEntries (الإشعار المدين = مديونية جديدة). */
  postDebitNote(tx: Phase2Tx, tenantId: string, invoiceId: string, customerId: string, total: number, at: Date): Promise<void>;
}

export interface NoteIssuanceDeps extends Phase2IssuanceDeps {
  ledger: Phase2LedgerHooks & NoteLedgerHooks;
  /** إماتة روابط الدفع القائمة على الأصل بعد الالتزام (نقد 13) — نداء شبكيّ فلا يجري تحت قفل. */
  expireLinks?(tenantId: string, invoiceId: string): void;
}

// ─── قراءة الأصل وإشعاراته ───

/** ما يكفي لقراءة الأصل وإشعاراته السابقة (prisma أو مقبض معاملة). */
export type NoteDb = Pick<PrismaClient, 'invoice'>;

const ORIGINAL_ITEM_SELECT = {
  id: true, productId: true, seq: true, itemName: true, unitCode: true, qty: true, unitPrice: true, discountPct: true,
  taxPct: true, vatCategory: true, vatExemptionCode: true, vatExemptionReason: true,
  product: { select: { name: true, damagedReturnToStock: true } },
} satisfies Prisma.InvoiceItemSelect;

const ORIGINAL_SELECT = {
  id: true, tenantId: true, customerId: true, salesRepId: true, number: true, status: true, type: true, paymentPlan: true,
  zatcaPhase: true, documentKind: true, invoiceSubtype: true, einvoiceStatus: true, pricesIncludeTax: true, discountPct: true,
  total: true, paidAmt: true, remainingAmt: true, invoiceDate: true, einvoiceSnapshot: true,
  items: { select: ORIGINAL_ITEM_SELECT, orderBy: { seq: 'asc' } },
} satisfies Prisma.InvoiceSelect;

type OriginalRow = Prisma.InvoiceGetPayload<{ select: typeof ORIGINAL_SELECT }>;

export interface LoadedOriginal {
  original: NoteOriginalInvoice;
  /** مشتري الأصل كما دخل الـXML (einvoiceSnapshot.customer) — يُفعّل حارس انحراف الهوية. */
  originalBuyer: UblParty | null;
}

/** مشتري اللقطة إن كانت لقطةً مفهومة (v1)؛ وإلا null — اللقطة لا تُفشل إشعاراً. */
function buyerOfSnapshot(snapshot: unknown): UblParty | null {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const c = (snapshot as { customer?: unknown }).customer;
  return c && typeof c === 'object' ? (c as UblParty) : null;
}

function originalOf(row: OriginalRow): LoadedOriginal {
  const items: NoteOriginalItem[] = row.items.map(it => ({
    id: it.id,
    productId: it.productId,
    seq: it.seq,
    // المرحلة الأولى بلا لقطة بند: اسم البيع غير محفوظ، فاسم بطاقة الصنف اليوم أقرب ما يوجد
    itemName: it.itemName ?? it.product?.name ?? null,
    unitCode: it.unitCode,
    qty: Number(it.qty),
    unitPrice: Number(it.unitPrice),
    discountPct: Number(it.discountPct),
    taxPct: Number(it.taxPct),
    vatCategory: it.vatCategory,
    vatExemptionCode: it.vatExemptionCode,
    vatExemptionReason: it.vatExemptionReason,
    damagedReturnToStock: it.product?.damagedReturnToStock ?? null,
  }));
  return {
    original: {
      id: row.id, tenantId: row.tenantId, customerId: row.customerId, salesRepId: row.salesRepId, number: row.number,
      status: row.status, type: row.type, paymentPlan: row.paymentPlan, zatcaPhase: row.zatcaPhase,
      documentKind: row.documentKind, invoiceSubtype: row.invoiceSubtype, einvoiceStatus: row.einvoiceStatus,
      pricesIncludeTax: row.pricesIncludeTax === true, discountPct: Number(row.discountPct), total: Number(row.total),
      paidAmt: Number(row.paidAmt), remainingAmt: Number(row.remainingAmt), invoiceDate: row.invoiceDate ?? null, items,
    },
    originalBuyer: buyerOfSnapshot(row.einvoiceSnapshot),
  };
}

/** الأصل بلا قفل (قبل المعاملة): للرفض الرخيص وللمعاينة. */
export async function loadNoteOriginal(db: NoteDb, tenantId: string, invoiceId: string): Promise<LoadedOriginal | null> {
  const row = await db.invoice.findFirst({ where: { id: invoiceId, tenantId }, select: ORIGINAL_SELECT });
  return row ? originalOf(row) : null;
}

/** الأصل مقفلاً (FOR UPDATE) داخل المعاملة — المعاملات المزيّفة بلا `$queryRaw` تقرأ بلا قفل. */
export async function lockNoteOriginal(tx: Phase2Tx, tenantId: string, invoiceId: string): Promise<LoadedOriginal | null> {
  const raw = (tx as { $queryRaw?: unknown }).$queryRaw;
  if (typeof raw === 'function') {
    await tx.$queryRaw`SELECT id FROM invoices WHERE id = ${invoiceId} AND "tenantId" = ${tenantId} FOR UPDATE`;
  }
  const row = await tx.invoice.findFirst({ where: { id: invoiceId, tenantId }, select: ORIGINAL_SELECT });
  return row ? originalOf(row) : null;
}

/** إشعارات الأصل الملتزَمة (الدائنة تُنقص المتاح، والمدينة تُقرأ ولا تُنقص — countsTowardCredit). */
export async function loadPriorNotes(db: NoteDb, tenantId: string, originalInvoiceId: string): Promise<PriorNote[]> {
  const rows = await db.invoice.findMany({
    where: { tenantId, originalInvoiceId, status: 'CONFIRMED' },
    select: { id: true, status: true, documentKind: true, total: true, items: { select: { creditedItemId: true, qty: true } } },
  });
  return rows.map(r => ({
    id: r.id, status: r.status, documentKind: r.documentKind, total: Number(r.total),
    items: r.items.map(i => ({ creditedItemId: i.creditedItemId, qty: Number(i.qty) })),
  }));
}

/**
 * مرتجعات ما قبل الربط لعميل الأصل (مراجعة «مال ومخزون/امتثال»): صفوف RETURN قديمة بلا `originalInvoiceId` ولا
 * `documentKind` — لا يراها حارس الكمية المبنيّ على الإشعارات، فكانت بضاعةٌ أُرجعت قبل التفعيل تُرجَع ثانيةً بعده
 * (ائتمان مزدوج للعميل وكمّيةٌ وهمية في مخزون السيارة). تُقرأ **لأصلٍ من المرحلة الأولى وحده** (المربوطة لا مرتجع
 * قديم لها: مسار المرتجع القديم مغلق بعد التفعيل)، ومن تاريخ الأصل فصاعداً — ما سبقه ليس إرجاعاً له.
 */
export async function loadLegacyReturns(
  db: NoteDb, tenantId: string, customerId: string, since: Date | null | undefined,
): Promise<LegacyReturnQty[]> {
  const rows = await db.invoice.findMany({
    where: {
      tenantId, customerId, type: 'RETURN', status: 'CONFIRMED', documentKind: null, originalInvoiceId: null,
      ...(since instanceof Date ? { invoiceDate: { gte: since } } : {}),
    },
    select: { items: { select: { productId: true, qty: true } } },
  });
  const out: LegacyReturnQty[] = [];
  for (const r of rows) for (const i of r.items) out.push({ productId: i.productId, qty: Number(i.qty) });
  return out;
}

/** المرتجعات القديمة تُقرأ للأصل من المرحلة الأولى وحده — والمربوط يبقى بلا استعلامٍ زائد (سلوكه لا يتغيّر). */
async function legacyReturnsFor(db: NoteDb, tenantId: string, original: NoteOriginalInvoice): Promise<LegacyReturnQty[]> {
  if (original.zatcaPhase === 2) return [];
  return loadLegacyReturns(db, tenantId, original.customerId, original.invoiceDate ?? null);
}

// ─── الصلاحيات (Q5) ───

/** ما يقرّر الصلاحية من هويّة الطالب (المندوب بأعلامه، ومستخدم الشركة مرّ ببوابة canManageInvoices قبلاً). */
export interface NoteActor {
  role: string;
  canCreateInvoice?: boolean;
  canCancelInvoice?: boolean;
}

export type { CreditScope };

/** نطاق الطلب كما كُتب (حارسٌ مبكّر رخيص) — والنطاق الحاكم يُقاس من الأثر في `buildNote` (effectiveCreditScope). */
export const creditScopeOf = (lines: CreditLinesRequest): CreditScope => (lines === 'FULL' ? 'FULL' : 'PARTIAL');

export type PermissionVerdict = { ok: true } | { ok: false; messageAr: string };

const ALLOW: PermissionVerdict = { ok: true };

/**
 * Q5: الإشعار الكامل (بديل الإلغاء) لمدير الشركة أو لمندوبٍ يملك «إلغاء الفاتورة»؛ والجزئيّ على قاعدة المرتجع
 * اليوم («إنشاء فاتورة»). مستخدم الشركة عبر البوابة القائمة (canManageInvoices) فلا يُفحص هنا ثانيةً.
 */
export function creditNotePermission(actor: NoteActor, scope: CreditScope): PermissionVerdict {
  if (actor.role !== 'SALES_REP') return ALLOW;
  if (scope === 'FULL') {
    return actor.canCancelInvoice === true ? ALLOW : { ok: false, messageAr: 'لا تملك صلاحية إلغاء الفواتير — الإشعار الدائن الكامل بديل الإلغاء' };
  }
  return actor.canCreateInvoice === true ? ALLOW : { ok: false, messageAr: 'لا تملك صلاحية إنشاء فاتورة' };
}

/** الإشعار المدين (زيادة على فاتورة صدرت) لإدارة الشركة وحدها — لا للمندوب. */
export function debitNotePermission(actor: NoteActor): PermissionVerdict {
  return actor.role === 'SALES_REP' ? { ok: false, messageAr: 'إصدار الإشعار المدين من صلاحيات إدارة الشركة' } : ALLOW;
}

// ─── معاينة ما يُرجَع (GET /:id/creditable) ───

export interface CreditableView {
  invoiceId: string;
  number: string;
  subtype: InvoiceSubtype | null;
  documentKind: string | null;
  einvoiceStatus: string | null;
  total: number;
  remainingAmt: number;
  /** قيمة الإشعارات الدائنة الملتزَمة السابقة. */
  creditedTotal: number;
  /** خُصمت من المتاح كمّياتُ مرتجعاتٍ قديمة بلا رابط بالأصل (أصلٌ من المرحلة الأولى) — تنبيهٌ للمستخدم لا منع. */
  legacyReturnsApplied: boolean;
  /** هل يجوز إصدار إشعار على هذه الفاتورة الآن؟ */
  eligible: boolean;
  refusal: string | null;
  messageAr: string | null;
  lines: CreditableLine[];
}

export interface CreditableResult {
  status: number;
  body: Record<string, unknown>;
}

/**
 * معاينة الإشعار: بنود الأصل بالمتاح منها، وسببُ المنع حين يُمنع (بلا كشفٍ لما خارج النطاق — ذاك يُردّ 404 في المسار).
 * تعيد null حين تكون الشركة في المرحلة الأولى: لا إشعارات هناك، والمرتجع يبقى مستنداً عادياً.
 */
export async function creditableProjection(
  input: { tenantId: string; invoiceId: string; customer: IssuanceCustomer; actor: NoteActor },
  deps: NoteIssuanceDeps,
): Promise<CreditableResult | null> {
  const now = deps.now();
  const seller = await deps.units.loadSellerSettings(input.tenantId);
  const regime = await resolveInvoiceRegime(deps.db, input.tenantId, regimeSettingsOf(seller), {
    ...(deps.env ? { env: deps.env } : {}), now, seller,
  });
  if (regime.phase === 1) return null;

  const loaded = await loadNoteOriginal(deps.db, input.tenantId, input.invoiceId);
  if (!loaded) return notFoundResult();
  const eligibility = noteEligibility({ tenantId: input.tenantId, original: loaded.original, customer: input.customer });
  if (!eligibility.ok && noteRefusalError(eligibility.refusal) === null) return notFoundResult();

  const priorNotes = await loadPriorNotes(deps.db, input.tenantId, loaded.original.id);
  const legacyReturns = await legacyReturnsFor(deps.db, input.tenantId, loaded.original);
  const lines = creditableLines(loaded.original, priorNotes, legacyReturns);
  const refusal = eligibility.ok ? (hasCreditableQty(lines) ? null : 'NOTHING_TO_CREDIT') : eligibility.refusal;
  const view: CreditableView = {
    invoiceId: loaded.original.id,
    number: loaded.original.number,
    subtype: eligibility.ok ? eligibility.subtype : (loaded.original.invoiceSubtype as InvoiceSubtype | null),
    documentKind: loaded.original.documentKind,
    einvoiceStatus: loaded.original.einvoiceStatus,
    total: loaded.original.total,
    remainingAmt: loaded.original.remainingAmt,
    creditedTotal: creditedTotalOf(priorNotes),
    legacyReturnsApplied: lines.some(l => l.legacyCredited > 0),
    eligible: refusal === null,
    refusal,
    messageAr: refusal === null ? null : (noteRefusalError(refusal)?.messageAr ?? null),
    lines,
  };
  return {
    status: 200,
    body: {
      success: true,
      data: {
        ...view,
        permissions: {
          full: creditNotePermission(input.actor, 'FULL').ok,
          partial: creditNotePermission(input.actor, 'PARTIAL').ok,
          debit: debitNotePermission(input.actor).ok,
        },
      },
    },
  };
}

// ─── الطلب ───

/** بند مرتجعٍ كما يرسله تطبيق المندوب في POST /invoices (بند الأصل صريحاً، أو بالصنف حين لا يلتبس). */
export interface ReturnItemLine {
  productId?: string | null;
  invoiceItemId?: string | null;
  qty: number;
}

/** بنود الإشعار الدائن: 'FULL' كامل، أو قائمة ببنود الأصل، أو بنود مرتجعٍ تُحلّ إلى بنود الأصل. */
export type CreditLinesInput = CreditLinesRequest | { fromReturnItems: readonly ReturnItemLine[] };

export interface NoteContextBase {
  tenantId: string;
  caps: ClientCapsHeaders;
  originalInvoiceId: string;
  customer: IssuanceCustomer;
  /** المندوب الذي يُنسب إليه الإشعار (المُصدِر، وإلا مندوب الأصل). */
  salesRepId: string | null;
  decimals?: number;
  reason: string;
  clientRef?: string | null;
  clientCreatedAt?: string | null;
  /** صاحب الطلب (Q5) — يُفحص ثانيةً على **أثر** الإشعار لا على صيغته، قبل أيّ قفل أو ICV. */
  actor?: NoteActor;
}

export interface CreditNoteContext extends NoteContextBase {
  lines: CreditLinesInput;
  reasonCode?: string | null;
  returnToStock?: boolean | null;
}

export interface DebitNoteContext extends NoteContextBase {
  lines: readonly DebitNoteLineInput[];
}

const errorResult = (e: ZatcaHttpError): Phase2Result => ({ status: e.status, body: e.body() });

/** ما لا يُكشف: فاتورة شركةٍ أخرى أو عميلٍ آخر أو غير موجودة — ردٌّ واحد لا يفرّق بينها. */
const notFoundResult = (): Phase2Result => ({ status: 404, body: { success: false, message: 'الفاتورة غير موجودة' } });

const lineIssue = (field: string, messageAr: string) => ({ rule: 'CREDIT-LINE', field, messageAr, severity: 'error' as const });

/**
 * بنود مرتجع التطبيق ⇒ بنود الأصل: المعرّف الصريح يغلب، وإلا يُطابَق بالصنف **إن لم يلتبس** (بندٌ واحد متاح من ذلك
 * الصنف). التباسٌ أو صنفٌ ليس في الأصل ⇒ 422 يسمّي البند — لا تخمين على فاتورةٍ ضريبية.
 */
export function returnItemsToLines(items: readonly ReturnItemLine[], creditable: readonly CreditableLine[]): CreditLinesRequest {
  const issues: ReturnType<typeof lineIssue>[] = [];
  const out: { invoiceItemId: string; qty: number }[] = [];
  items.forEach((it, i) => {
    const explicit = typeof it.invoiceItemId === 'string' && it.invoiceItemId !== '' ? it.invoiceItemId : null;
    if (explicit) { out.push({ invoiceItemId: explicit, qty: Number(it.qty) }); return; }
    const pid = typeof it.productId === 'string' && it.productId !== '' ? it.productId : null;
    const matches = pid ? creditable.filter(l => l.productId === pid) : [];
    if (matches.length === 0) {
      issues.push(lineIssue(`items[${i}].productId`, `الصنف في السطر ${i + 1} ليس من بنود الفاتورة الأصلية`));
      return;
    }
    if (matches.length > 1) {
      issues.push(lineIssue(`items[${i}].invoiceItemId`, `الصنف «${matches[0].itemName || i + 1}» مكرَّر في الفاتورة الأصلية — حدّد بند الفاتورة المراد إرجاعه`));
      return;
    }
    out.push({ invoiceItemId: matches[0].invoiceItemId, qty: Number(it.qty) });
  });
  if (issues.length) throw noteLinesError(issues);
  return out;
}

function resolveLinesInput(input: CreditLinesInput, creditable: readonly CreditableLine[]): CreditLinesRequest {
  if (input === 'FULL') return 'FULL';
  if (Array.isArray(input)) return input as CreditLinesRequest;
  return returnItemsToLines((input as { fromReturnItems: readonly ReturnItemLine[] }).fromReturnItems, creditable);
}

// ─── الإصدار ───

/**
 * الضريبة الافتراضية للمحرّك: **نسبة أوّل بند في الأصل**، لا استعلام إعدادات ثانٍ ولا رقم مكتوب. وهي في الواقع لا
 * تُستعمل أبداً — بنود الإشعار الدائن تحمل نسبها من الأصل، وبنود المدين نسبتها مطلوبة في الطلب — فتبقى قيمةً
 * أقرب ما تكون إلى الحقيقة إن احتيج إليها يوماً (نسبة الأصل أصدق من افتراض الشركة اليوم).
 */
export function defaultTaxPctOfOriginal(original: NoteOriginalInvoice): number {
  const first = original.items.find(i => Number.isFinite(Number(i.taxPct)));
  return first ? Number(first.taxPct) : 15;
}

interface NoteBuild {
  prepared: PreparedNote;
  eligibility: NoteEligible;
  loaded: LoadedOriginal;
  priorNotes: readonly PriorNote[];
}

function buildNote(
  kind: NoteKind, ctx: CreditNoteContext | DebitNoteContext, loaded: LoadedOriginal, priorNotes: readonly PriorNote[],
  seller: IssuanceSellerSettings, now: Date, legacyReturns: readonly LegacyReturnQty[] = [],
): NoteBuild {
  const eligibility = noteEligibility({ tenantId: ctx.tenantId, original: loaded.original, customer: ctx.customer });
  if (!eligibility.ok) {
    const e = noteRefusalError(eligibility.refusal);
    throw e ?? new ZatcaHttpError('ZATCA_ORIGINAL_NOT_CLEARED', { reason: eligibility.refusal });
  }
  const base = {
    settings: seller,
    customer: ctx.customer,
    original: loaded.original,
    eligibility,
    reason: ctx.reason,
    companyVat: defaultTaxPctOfOriginal(loaded.original),
    now,
    ...(ctx.decimals !== undefined ? { decimals: ctx.decimals } : {}),
    originalBuyer: loaded.originalBuyer,
  };
  if (kind === 'CREDIT_NOTE') {
    const request = resolveLinesInput((ctx as CreditNoteContext).lines, creditableLines(loaded.original, priorNotes, legacyReturns));
    const prepared = prepareCreditNote({ ...base, priorNotes, legacyReturns, request });
    /* Q5 على الأثر (مراجعة «تراجع»): `lines:'FULL'` وقائمةٌ تعدّ كلّ البنود بكامل المتاح مستندٌ واحد وأثرُ إلغاءٍ
     * واحد — فالفحص هنا، بعد حلّ البنود وقبل أيّ قفل أو ICV، لا على صيغة الطلب وحدها في المسار. */
    if (ctx.actor) {
      const verdict = creditNotePermission(ctx.actor, effectiveCreditScope(prepared.creditable, prepared.lines));
      if (!verdict.ok) throw new ZatcaHttpError('ZATCA_NOTE_NOT_ALLOWED', { messageAr: verdict.messageAr, reason: 'CREDIT_SCOPE' });
    }
    return { prepared, eligibility, loaded, priorNotes };
  }
  return { prepared: prepareDebitNote({ ...base, lines: (ctx as DebitNoteContext).lines }), eligibility, loaded, priorNotes };
}

/** أعمدة بند الإشعار القديمة (ما يكتبه المسار القديم لكل بند) — مأخوذة من ناتج المحرّك. */
function legacyNoteItem(kind: NoteKind, line: { productId: string | null } | null, calc: {
  qty: number; unitPrice: number; discountPct: number; discountAmt: number; taxPct: number; taxAmt: number; lineTotal: number;
}) {
  return {
    // المدين بلا صنف: لا يمسّ مخزون سيارة ولا مبيعات صنف (حارس tests/debit-note-consumers-static)
    productId: kind === 'CREDIT_NOTE' ? (line?.productId ?? null) : null,
    qty: calc.qty, unitPrice: calc.unitPrice, discountPct: calc.discountPct, discountAmt: calc.discountAmt,
    taxPct: calc.taxPct, taxAmt: calc.taxAmt, lineTotal: calc.lineTotal,
  };
}

async function issueNote(
  kind: NoteKind, ctx: CreditNoteContext | DebitNoteContext, deps: NoteIssuanceDeps,
): Promise<Phase2Result | null> {
  const now = deps.now();
  const seller = await deps.units.loadSellerSettings(ctx.tenantId);
  const regime = await resolveInvoiceRegime(deps.db, ctx.tenantId, regimeSettingsOf(seller), {
    ...(deps.env ? { env: deps.env } : {}), now, seller,
  });
  // المرحلة الأولى: لا إشعارات — المستدعي يكمل مساره القديم (المرتجع) أو يردّ «غير متاح»
  if (regime.phase === 1) return null;

  const gate = capsGate(ctx.caps);
  if (gate) return errorResult(gate);

  /* مفتاح المنع من التكرار (clientRef) على ما أصله صندوق العمل دون اتصال — الشرط نفسه الذي تحرس به الفاتورة
   * (invoicesZatca.ts): رفعٌ مؤجَّل بلا مفتاح يُنشئ إشعاراً دائناً ثانياً بـICV لا يُمحى، فيُقيَّد للعميل ائتمانٌ
   * مرّتين وتعود الكمّيات مرّتين إلى مخزون السيارة. كان المسار الجديد يقبله (مراجعة «امتثال»). */
  const offlineOrigin = isReplayRequest(ctx.caps) || typeof ctx.clientCreatedAt === 'string';
  if (offlineOrigin && (typeof ctx.clientRef !== 'string' || ctx.clientRef === '')) {
    return errorResult(new ZatcaHttpError('ZATCA_CLIENT_UPDATE_REQUIRED', { logDetail: { source: 'CAPS', code: 'NO_CLIENT_REF' } }));
  }

  if ('blocked' in regime) return errorResult(unitUnavailableError(regime.blocked, { source: 'REGIME', code: regime.blocked }));
  if (!seller) return errorResult(unitUnavailableError('SELLER_NOT_READY', { source: 'REGIME', code: 'settings-missing' }));

  const loaded = await loadNoteOriginal(deps.db, ctx.tenantId, ctx.originalInvoiceId);
  if (!loaded) return notFoundResult();
  const first = noteEligibility({ tenantId: ctx.tenantId, original: loaded.original, customer: ctx.customer });
  if (!first.ok && noteRefusalError(first.refusal) === null) return notFoundResult();

  try {
    // التحضير قبل أيّ قفل: كلّ رفضٍ رخيص (الأهليّة، الكميات، القيمة، بيانات المشتري، العملة، الفحص المسبق) يقع هنا
    const priorNotes = await loadPriorNotes(deps.db, ctx.tenantId, loaded.original.id);
    const legacyReturns = await legacyReturnsFor(deps.db, ctx.tenantId, loaded.original);
    buildNote(kind, ctx, loaded, priorNotes, seller, now, legacyReturns);
    return await stampNote(kind, ctx, deps, seller, regime.unit, loaded, now);
  } catch (e) {
    const err = issuanceHttpError(e);
    if (!err) throw e; // P2002 على clientRef (سباق الرفع المكرّر) وما لا يخصّ الفوترة
    if (err.alert && deps.alert) {
      try {
        await deps.alert(err, { tenantId: ctx.tenantId, customerId: loaded.original.customerId });
      } catch { /* التنبيه لا يغيّر الردّ */ }
    }
    return errorResult(err);
  }
}

async function stampNote(
  kind: NoteKind, ctx: CreditNoteContext | DebitNoteContext, deps: NoteIssuanceDeps, seller: IssuanceSellerSettings,
  unit: { id: string; tenantId: string; keyVersion: number; vatNumber: string }, preview: LoadedOriginal, now: Date,
): Promise<Phase2Result> {
  const signing = await openIssuanceSigning({ store: deps.units, keyring: deps.keyring, now }, unit);

  let created: (Record<string, unknown> & { id: string }) | null = null;
  let built: NoteBuild | null = null;
  let remaining = { decrement: 0, customerCredit: 0, remainingAfter: preview.original.remainingAmt };

  const issued: StampInTxResult = await runIssuance({
    unitId: unit.id,
    ...(deps.mutex !== undefined ? { mutex: deps.mutex } : {}),
    transaction: () => deps.transaction(async tx => {
      created = null;
      // §0.4: الوحدة أولاً، ثمّ الفاتورة الأصلية — وإشعاراتها تُقرأ تحت قفلها فلا يزيد إشعاران على المتاح
      await deps.chain.lockChainHead(tx, unit.id);
      const locked = await lockNoteOriginal(tx, ctx.tenantId, ctx.originalInvoiceId);
      if (!locked) throw new ZatcaHttpError('ZATCA_ORIGINAL_NOT_CLEARED', { messageAr: 'الفاتورة الأصلية غير موجودة', reason: 'NOT_FOUND' });
      const priorNotes = await loadPriorNotes(tx as unknown as NoteDb, ctx.tenantId, locked.original.id);
      const legacyReturns = await legacyReturnsFor(tx as unknown as NoteDb, ctx.tenantId, locked.original);
      // التحضير الحاكم: من الصفوف المقفلة وحدها (إشعارٌ التزم بيننا يُفشل هذا بحارس الكمية لا بازدواج صامت)
      const build = buildNote(kind, ctx, locked, priorNotes, seller, now, legacyReturns);
      built = build;
      const prepared = build.prepared;
      const link = prepared.link;

      return stampNoteInTx<Phase2Tx>(tx, { chain: deps.chain, documents: deps.documents, now: deps.now }, {
        tenantId: ctx.tenantId,
        prepared: prepared.prepared,
        signing,
        sellerVat: seller.taxNumber,
        hooks: {
          allocateNumber: (t, issuedAt) => deps.chain.nextNumberInTx(t, ctx.tenantId, noteNumberPrefix(kind, issuedAt)),
          createInvoice: async (t, record) => {
            const total = record.amounts.total;
            const legacy = kind === 'CREDIT_NOTE'
              ? creditNoteLegacyColumns({
                reasonCode: (ctx as CreditNoteContext).reasonCode ?? null,
                returnToStock: resolveReturnToStock(
                  (ctx as CreditNoteContext).returnToStock, (ctx as CreditNoteContext).reasonCode ?? null, prepared.lines,
                ),
              })
              : debitNoteLegacyColumns(total);
            const row = await t.invoice.create({
              data: {
                tenantId: ctx.tenantId,
                number: record.number,
                clientRef: ctx.clientRef ?? undefined,
                clientCreatedAt: ctx.clientCreatedAt ? new Date(ctx.clientCreatedAt) : undefined,
                customerId: locked.original.customerId,
                // المدين يُنسب لمندوب الأصل (لا بيع جديد)، والدائن للمُصدِر وإلا لمندوب الأصل
                salesRepId: kind === 'DEBIT_NOTE'
                  ? locked.original.salesRepId
                  : (ctx.salesRepId ?? locked.original.salesRepId),
                ...legacy,
                pricesIncludeTax: locked.original.pricesIncludeTax,
                discountPct: kind === 'CREDIT_NOTE' ? locked.original.discountPct : 0,
                // أعمدة المرحلة الثانية والمرآة والمبالغ المخزَّنة + رابط الأصل (BT-25 وKSA-10)
                ...noteInvoiceColumns(record, link),
                einvoiceSnapshot: record.snapshot as unknown as Prisma.InputJsonObject,
                items: {
                  create: prepared.engine.items.map((calc, idx) => ({
                    ...legacyNoteItem(kind, prepared.lines[idx] ?? null, calc),
                    ...noteItemColumns(record.items[idx], kind === 'CREDIT_NOTE' ? (prepared.lines[idx]?.invoiceItemId ?? null) : null),
                  })),
                },
              },
              include: { items: true, customer: true },
            });
            created = row as unknown as Record<string, unknown> & { id: string };
            return { id: row.id };
          },
          // نقد 38: صفّ الأصل ثمّ دفتر العميل — آخر ما يُقفل، وبعد الختم وإدراج المستند
          afterDocument: async (t, summary) => {
            const total = prepared.prepared.amounts.total;
            if (kind === 'CREDIT_NOTE') {
              // F1 (نقد 13): فرقٌ نسبيّ لا قيمة مطلقة — سندُ قبضٍ متزامن لا يُدهس ولا يَدهس
              remaining = remainingAfterCreditNote(locked.original, total);
              if (remaining.decrement > 0) {
                await t.invoice.update({ where: { id: locked.original.id }, data: { remainingAmt: { decrement: remaining.decrement } } });
              }
              await deps.ledger.postReturn(t, ctx.tenantId, summary.invoiceId, locked.original.customerId, total, summary.issuedAt);
            } else {
              await deps.ledger.postDebitNote(t, ctx.tenantId, summary.invoiceId, locked.original.customerId, total, summary.issuedAt);
            }
          },
        },
      });
    }),
  });

  if (!created || !built) throw new ZatcaHttpError('ZATCA_INTERNAL', { logDetail: { source: 'NOTE', code: 'ROW_MISSING' } });
  const build = built as unknown as NoteBuild;
  deps.publish(ctx.tenantId);
  // نقد 13: رابط دفعٍ قديم على الأصل لا يبقى حيّاً بعد إسقاط جزءٍ من قيمته
  if (kind === 'CREDIT_NOTE' && deps.expireLinks) {
    try { deps.expireLinks(ctx.tenantId, build.loaded.original.id); } catch { /* لا يُفشل إشعاراً التُزم */ }
  }

  const view: EinvoiceView = einvoiceView(
    {
      environment: issued.environment, status: 'SIGNED', typeCode: issued.typeCode, typeName: issued.typeName, icv: issued.icv,
      uuid: issued.uuid, issueDate: issued.issueDate, issueTime: issued.issueTime, reportDeadline: issued.reportDeadline,
    },
    {
      einvoiceStatus: issued.mirror.einvoiceStatus, einvoiceQr: issued.mirror.einvoiceQr, documentKind: kind,
      invoiceSubtype: issued.subtype, issuedAt: issued.issuedAt,
    },
    now,
    issued.warnings,
  );
  const data: Record<string, unknown> = {
    ...(created as Record<string, unknown>),
    einvoice: view,
    original: {
      id: build.loaded.original.id,
      number: build.loaded.original.number,
      remainingAmt: remaining.remainingAfter,
      customerCredit: remaining.customerCredit,
      creditedTotal: build.prepared.creditedBefore + (kind === 'CREDIT_NOTE' ? build.prepared.prepared.amounts.total : 0),
    },
  };
  // القياسيّ (01) لا يُسلَّم قبل اعتماد الهيئة — الاعتماد الحيّ نفسه الذي يمرّ به إصدار الفاتورة (Z5.4)
  if (issued.subtype === '01') {
    /* رفضُ الهيئة يُبطل الإشعار ويردّ متبقّي الأصل في معاملة النتيجة نفسها (services/invoiceVoid) — فلا يحمل جسمُ
     * الـ422 أرقام أصلٍ عاد إلى ما كان (مراجعة «تراجع»): تُستبدل بقيم ما قبل الإشعار. */
    const originalBefore = {
      id: build.loaded.original.id,
      number: build.loaded.original.number,
      remainingAmt: build.loaded.original.remainingAmt,
      customerCredit: 0,
      creditedTotal: build.prepared.creditedBefore,
    };
    return clearStandardInline(deps, { tenantId: ctx.tenantId, invoiceId: issued.invoiceId, documentId: issued.documentId }, data, {
      view, warnings: issued.warnings, issuedAt: issued.issuedAt, documentKind: kind, restoreOnVoid: { original: originalBefore },
    }, now);
  }
  return { status: 201, body: { success: true, data } };
}

/**
 * إشعار دائن (381) على فاتورةٍ بعينها: مرتجعٌ جزئيّ أو إلغاءٌ كامل (D4). يعيد null للمرحلة الأولى.
 */
export function issueCreditNote(ctx: CreditNoteContext, deps: NoteIssuanceDeps): Promise<Phase2Result | null> {
  return issueNote('CREDIT_NOTE', ctx, deps);
}

/** إشعار مدين (383): زيادة على فاتورةٍ صدرت — لإدارة الشركة وحدها. يعيد null للمرحلة الأولى. */
export function issueDebitNote(ctx: DebitNoteContext, deps: NoteIssuanceDeps): Promise<Phase2Result | null> {
  return issueNote('DEBIT_NOTE', ctx, deps);
}

/**
 * D3: مرتجع POST /invoices في شركةٍ مربوطة ⇒ إشعار دائن مرتبط بأصله. بلا أصلٍ في الطلب ⇒ 422 كما هو اليوم،
 * ولا يمرّ المرتجع السالب أبداً. يعيد null للمرحلة الأولى فيكمل المسار القديم حرفاً بحرف.
 */
export async function issueReturnAsCreditNote(
  ctx: Omit<CreditNoteContext, 'lines' | 'originalInvoiceId'> & { originalInvoiceId: string | null; items: readonly ReturnItemLine[] },
  deps: NoteIssuanceDeps,
): Promise<Phase2Result | null> {
  const { items, originalInvoiceId, ...rest } = ctx;
  if (typeof originalInvoiceId !== 'string' || originalInvoiceId === '') {
    // مرتجعٌ بلا أصل: النظام الضريبي وحده يقرّر — والمرحلة الأولى تكمل مسارها القديم بلا أثر
    const seller = await deps.units.loadSellerSettings(ctx.tenantId);
    const regime = await resolveInvoiceRegime(deps.db, ctx.tenantId, regimeSettingsOf(seller), {
      ...(deps.env ? { env: deps.env } : {}), now: deps.now(), seller,
    });
    if (regime.phase === 1) return null;
    const gate = capsGate(ctx.caps);
    if (gate) return errorResult(gate);
    return errorResult(new ZatcaHttpError('ZATCA_RETURN_NEEDS_ORIGINAL'));
  }
  return issueCreditNote({ ...rest, originalInvoiceId, lines: { fromReturnItems: items } }, deps);
}

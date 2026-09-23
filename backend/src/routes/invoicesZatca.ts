// ============================================================================
// ZATCA المرحلة الثانية (Z5.2) — فرع الإصدار في POST /invoices، وحارس قدرات العميل، وإسقاط المستند في القراءات
// ----------------------------------------------------------------------------
// z5_plan §3 «Z5.2» + §2.1 (النظام الضريبي) + §2.2 (معاملة الإصدار) + §2.4 (الأعمدة والمبالغ) + نقد الخطة (1، 2، 6، 8، 12، 26، 38):
//   • فرع واحد في المسار القديم: المرحلة الأولى لا تمرّ من هنا إطلاقاً (regimeCandidate نقيّ من الإعدادات المحمَّلة والبيئة،
//     بصفر استعلامات)، ومسارها ورّدودها وترتيب استعلاماتها كما هي اليوم حرفاً بحرف.
//   • حارس القدرات (نقد 2): للأنظمة من المرحلة الثانية وحدها — بلا ترويسة X-FS-Caps: zatca2 ⇒ 426 قبل أيّ قرار آخر (قبل
//     الحجب 503 وقبل قاعدة الانتقال في Z5.8). ترويسة إعادة الرفع X-FS-Replay: 1 بلا قدرات ⇒ 409 ZATCA_CUTOVER_REVIEW: مستند
//     دون اتصال من حزمة قديمة لا يُصدَر على المسار القديم أبداً (مراجعة الإدارة تُبنى في Z5.8).
//   • القراءات (نقد 6): صفّ zatcaPhase = 2 لا يصل عميلاً بلا قدرات — لا في GET /:id ولا في ردّ إعادة الرفع (clientRef) ولا في
//     سباق P2002 — وإلا أعاد بناء QR المرحلة الأولى بخمس وسوم من إعدادات الشركة وطبع «فاتورة ضريبية» غير مختومة.
//   • الترتيب داخل المعاملة (نقد 38): قفل الوحدة ⇒ الرقم ⇒ الختم ⇒ صفّ الفاتورة ⇒ المستند SIGNED ⇒ تقدّم السلسلة ⇒ قيود
//     دفتر العميل. لا يُوقَّع شيء وصفوف العملاء مقفلة، والترقيم بمقبض المعاملة نفسه (نقد 8).
//   • لا استدعاء للهيئة هنا إطلاقاً (الإرسال والاعتماد في Z5.3/Z5.4): المستند يُحفظ SIGNED والمرآة signed/clearance_pending.
// لا يستورد services/gl ولا config/database (الاعتماديات تُحقن — الإنتاج في invoicesZatcaDeps.ts، والاختبار مخزن ذاكرة).
// ============================================================================

import type { Prisma, PrismaClient } from '@prisma/client';
import type { DocumentProjection, ZatcaDocumentStore } from '../compliance/zatca/documentStore';
import { ZATCA_ERROR_CATALOGUE, ZatcaHttpError, unitUnavailableError } from '../compliance/zatca/errors';
import {
  issuanceHttpError, phase2InvoiceColumns, phase2ItemColumns, phase2NumberPrefix, prepareIssuance,
  type EngineTotals, type IssuanceCustomer, type IssuanceProduct, type IssuanceRequest, type PreparedIssuance,
} from '../compliance/zatca/issue';
import type { IssuanceChainStore } from '../compliance/zatca/issueChain';
import { openIssuanceSigning } from '../compliance/zatca/issueSigner';
import { runIssuance, stampInTx, type StampInTxResult } from '../compliance/zatca/issueTx';
import type { EgsUnitStore } from '../compliance/zatca/onboardingStore';
import { REHEARSAL_ENVIRONMENT, resolveInvoiceRegime, type RegimeDb, type RegimeMode, type RegimeSettings } from '../compliance/zatca/regime';
import type { SecretKeyring } from '../compliance/zatca/secrets';
import { isOverdue, isPrintableMirror, subtypeOfTypeName, type Subtype } from '../compliance/zatca/status';
import type { KeyedAsyncMutex } from '../compliance/zatca/unitMutex';

// ─── ترويسات قدرات العميل (نقد 1، 2) ───

export const CAPS_HEADER = 'x-fs-caps';
export const REPLAY_HEADER = 'x-fs-replay';
/** القدرة التي تعني «هذا العميل يفهم فواتير المرحلة الثانية» (يرسلها api/client.ts وrep/repApi.ts). */
export const ZATCA2_CAP = 'zatca2';

/** ما يلزم من ترويسات الطلب (Express req.headers). */
export interface ClientCapsHeaders {
  caps?: string | string[] | undefined;
  replay?: string | string[] | undefined;
}

const firstHeader = (v: string | string[] | undefined): string => (Array.isArray(v) ? v.join(',') : typeof v === 'string' ? v : '');

export function capsFromHeaders(headers: Record<string, string | string[] | undefined>): ClientCapsHeaders {
  return { caps: headers[CAPS_HEADER], replay: headers[REPLAY_HEADER] };
}

/** ترويسة القدرات قائمة رموز مفصولة بفواصل أو مسافات (zatca2 حالياً؛ تزيد لاحقاً). */
export function hasZatca2Cap(h: ClientCapsHeaders): boolean {
  return firstHeader(h.caps).split(/[,\s;]+/).some(t => t.trim().toLowerCase() === ZATCA2_CAP);
}

/** X-FS-Replay: 1 — رفعٌ من صندوق العمل دون اتصال (rep/offlineSync.ts) لا طلب حيّ. */
export function isReplayRequest(h: ClientCapsHeaders): boolean {
  const v = firstHeader(h.replay).trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/**
 * نقد 2: العميل بلا قدرات لا يُصدر ولا يقرأ مستنداً من المرحلة الثانية.
 * بلا قدرات وبلا إعادة رفع ⇒ 426 «حدّث التطبيق». بإعادة رفع (حزمة قديمة، مستند أُنشئ أوف-لاين) ⇒ 409 «بانتظار مراجعة
 * الإدارة» — لا يُقبل على المسار القديم بحال (كان ذلك يطبع QR مرحلة أولى لفاتورة بعد التفعيل). null = العميل مؤهَّل.
 */
export function capsGate(h: ClientCapsHeaders): ZatcaHttpError | null {
  if (hasZatca2Cap(h)) return null;
  if (isReplayRequest(h)) return new ZatcaHttpError('ZATCA_CUTOVER_REVIEW', { logDetail: { source: 'CAPS', code: 'REPLAY_NO_CAPS' } });
  return new ZatcaHttpError('ZATCA_CLIENT_UPDATE_REQUIRED', { logDetail: { source: 'CAPS', code: 'NO_CAPS' } });
}

// ─── ردّ المسار ───

export interface Phase2Result {
  status: number;
  body: Record<string, unknown>;
}

const errorResult = (e: ZatcaHttpError): Phase2Result => ({ status: e.status, body: e.body() });

// ─── عرض الفوترة الإلكترونية في الردّ (einvoice) ───

/** بيئة الوحدة ⇒ وضع النظام المعروض: production حيّة، وغيرها بروفة (Z6). */
export function modeOfEnvironment(environment: string | null | undefined): RegimeMode {
  return environment === REHEARSAL_ENVIRONMENT ? 'rehearsal' : 'live';
}

export interface EinvoiceView {
  phase: 2;
  mode: RegimeMode;
  environment: string;
  /** مرآة الفاتورة (Invoice.einvoiceStatus): signed | clearance_pending | … */
  status: string | null;
  /** حالة المستند (ZatcaDocument.status): SIGNED في Z5.2 دائماً. */
  documentStatus: string;
  subtype: Subtype | null;
  documentKind: string | null;
  typeCode: string;
  typeName: string;
  icv: number;
  uuid: string;
  issuedAt: string | null;
  issueDate: string;
  issueTime: string;
  /** رمز QR المعروض: المبسّطة ختمنا، والقياسية null حتى الاعتماد (Z5.4). */
  qr: string | null;
  printable: boolean;
  overdue: boolean;
  reportDeadline: string | null;
  warnings: unknown[];
}

/** ما يحتاجه العرض من مستند (إسقاط القاعدة أو نتيجة الختم). */
export interface EinvoiceDocLike {
  environment: string;
  status: string;
  typeCode: string;
  typeName: string;
  icv: number;
  uuid: string;
  issueDate: string;
  issueTime: string;
  reportDeadline: Date | null;
}

/** ما يحتاجه العرض من صفّ الفاتورة (المرآة المجمَّدة). */
export interface EinvoiceMirrorLike {
  einvoiceStatus: string | null;
  einvoiceQr: string | null;
  documentKind: string | null;
  invoiceSubtype: string | null;
  issuedAt: Date | null;
}

export function einvoiceView(doc: EinvoiceDocLike, inv: EinvoiceMirrorLike, now: Date, warnings: readonly unknown[] = []): EinvoiceView {
  const subtype = (inv.invoiceSubtype === '01' || inv.invoiceSubtype === '02' ? inv.invoiceSubtype : subtypeOfTypeName(doc.typeName)) as Subtype | null;
  return {
    phase: 2,
    mode: modeOfEnvironment(doc.environment),
    environment: doc.environment,
    status: inv.einvoiceStatus,
    documentStatus: doc.status,
    subtype,
    documentKind: inv.documentKind,
    typeCode: doc.typeCode,
    typeName: doc.typeName,
    icv: doc.icv,
    uuid: doc.uuid,
    issuedAt: inv.issuedAt ? inv.issuedAt.toISOString() : null,
    issueDate: doc.issueDate,
    issueTime: doc.issueTime,
    qr: inv.einvoiceQr,
    printable: subtype ? isPrintableMirror(inv.einvoiceStatus, subtype) : false,
    overdue: isOverdue(doc, now),
    reportDeadline: doc.reportDeadline ? doc.reportDeadline.toISOString() : null,
    warnings: [...warnings],
  };
}

// ─── القراءات: GET /:id، إعادة الرفع (clientRef)، سباق P2002 ───

/** صفّ فاتورة من المرحلة الثانية (العمود قابل للإفراغ: null و1 مرحلة أولى). */
export function isPhase2Invoice(inv: { zatcaPhase?: number | null } | null | undefined): boolean {
  return inv?.zatcaPhase === 2;
}

export interface Phase2ReadDeps {
  documents: Pick<ZatcaDocumentStore<never>, 'loadProjection'>;
  now(): Date;
}

/** تحذيرات الهيئة المخزَّنة نصّاً (JSON) — تُقرأ متساهلةً: ما لا يُفهم يُهمل. */
function storedWarnings(raw: string | null | undefined): unknown[] {
  if (typeof raw !== 'string' || raw === '') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

export type Phase2InvoiceRow = EinvoiceMirrorLike & { id: string; zatcaPhase?: number | null; einvoiceWarnings?: string | null };

/**
 * ردّ قراءة صفّ من المرحلة الثانية: 426 لعميل بلا قدرات (نقد 6)، وإلا الصفّ نفسه + einvoice من آخر محاولة مستند.
 * null ⇒ الصفّ من المرحلة الأولى: المستدعي يردّ كما اليوم بلا أيّ استعلام إضافي.
 */
export async function phase2ReadBody(
  invoice: Phase2InvoiceRow | null | undefined, caps: ClientCapsHeaders, deps: Phase2ReadDeps, tenantId: string,
): Promise<{ status: number; einvoice: EinvoiceView | null; error: ZatcaHttpError | null } | null> {
  if (!isPhase2Invoice(invoice) || !invoice) return null;
  if (!hasZatca2Cap(caps)) {
    const e = new ZatcaHttpError('ZATCA_CLIENT_UPDATE_REQUIRED', { logDetail: { source: 'CAPS', code: 'READ_NO_CAPS' } });
    return { status: e.status, einvoice: null, error: e };
  }
  const p: DocumentProjection | null = await deps.documents.loadProjection(tenantId, invoice.id);
  if (!p) return { status: 200, einvoice: null, error: null };
  return { status: 200, einvoice: einvoiceView(p, invoice, deps.now(), storedWarnings(invoice.einvoiceWarnings)), error: null };
}

// ─── الإصدار ───

/** ما يمرّره المسار القديم بعد أن تحقّق منه كاملاً (لا يُعاد التحقق هنا). */
export interface Phase2RequestBody {
  type: string;
  paymentPlan?: string | null;
  pricesIncludeTax: boolean;
  discountPct?: number | null;
  items: readonly { productId: string; qty: number; unitPrice: number; discountPct?: number | null; taxPct?: number | null }[];
  /** تاريخ التوريد الذي يطلبه المدير (يُحترم للقياسية وحدها — §2.4 F16 ونقد 24). */
  invoiceDate?: string | null;
  dueDate?: string | null;
  notes?: string | null;
  clientRef?: string | null;
  clientCreatedAt?: string | null;
}

/** بند بعد المحرّك (finalItems في المسار القديم) — يُكتب كما هو ثم تُضاف أعمدة المرحلة الثانية فوقه. */
export interface Phase2LegacyItem {
  productId: string;
  qty: number;
  unitPrice: number;
  discountPct: number;
  discountAmt: number;
  taxPct: number;
  taxAmt: number;
  lineTotal: number;
}

export type Phase2Tx = Pick<Prisma.TransactionClient, '$queryRaw' | '$executeRaw' | 'zatcaDocument' | 'invoice' | 'notification'>;

/** قفل رأس السلسلة + الترقيم، كلاهما بمقبض معاملة الإصدار نفسه (نقد 8). المحوّل: issueStore.prisma.ts. */
export interface Phase2ChainStore extends IssuanceChainStore<Phase2Tx> {
  nextNumberInTx(tx: Phase2Tx, tenantId: string, prefix: string): Promise<string>;
}

export interface Phase2LedgerHooks {
  /** services/accounting.postCashInvoiceEntries */
  postCashInvoice(tx: Phase2Tx, tenantId: string, invoiceId: string, customerId: string, total: number, at: Date): Promise<void>;
  /** services/accounting.postInvoiceEntries */
  postCreditInvoice(tx: Phase2Tx, tenantId: string, invoiceId: string, customerId: string, total: number, at: Date): Promise<void>;
  /** إشعار تجاوز الحدّ الائتماني (كما يكتبه المسار القديم داخل المعاملة نفسها). */
  creditLimitNotice(tx: Phase2Tx, input: {
    tenantId: string; invoiceId: string; customerId: string; salesRepId: string; customerName: string; balance: number; limit: number;
  }): Promise<void>;
}

export interface Phase2IssuanceDeps extends Phase2ReadDeps {
  db: RegimeDb & Pick<PrismaClient, 'product'>;
  units: Pick<EgsUnitStore, 'loadSellerSettings' | 'loadUnit' | 'loadUnitCredentials'>;
  documents: Pick<ZatcaDocumentStore<Phase2Tx>, 'insertSigned' | 'advanceUnitChain'> & Pick<ZatcaDocumentStore<never>, 'loadProjection'>;
  chain: Phase2ChainStore;
  keyring: () => SecretKeyring;
  ledger: Phase2LedgerHooks;
  /** prisma.$transaction(fn, { maxWait, timeout }) — المعاملة التفاعلية الوحيدة في هذا المسار. */
  transaction<T>(fn: (tx: Phase2Tx) => Promise<T>): Promise<T>;
  publish(tenantId: string): void;
  /** عطل يستوجب تنبيه الإدارة (ختم/سلسلة) — لا يُرمى منه شيء. */
  alert?(err: ZatcaHttpError, at: { tenantId: string; customerId: string }): void | Promise<void>;
  env?: NodeJS.ProcessEnv;
  /** null = بلا قفل داخل العملية (اختبار). الافتراضي issuanceUnitMutex. */
  mutex?: KeyedAsyncMutex | null;
}

/** ما حمّله المسار القديم وتحقّق منه قبل الفرع. */
export interface Phase2IssuanceContext {
  tenantId: string;
  caps: ClientCapsHeaders;
  body: Phase2RequestBody;
  customerId: string;
  customer: IssuanceCustomer;
  customerName: string;
  customerBalance: number;
  customerCreditLimit: number;
  salesRepId: string;
  companyVat: number;
  engine: EngineTotals;
  items: readonly Phase2LegacyItem[];
  installments: readonly { seq: number; dueDate: Date; amount: number }[];
  signatureImages: { image: string | null; repImage: string | null } | null;
  creditCheck: boolean;
  deliveryDate?: Date;
  dueDate?: Date;
}

/** أعمدة البند كما يكتبها المسار القديم حرفياً (دالّة لا قيماً حرفية: أعمدة المرحلة الثانية تُكتب فوقها بالانتشار). */
function legacyItemColumns(i: Phase2LegacyItem) {
  return {
    productId: i.productId, qty: i.qty, unitPrice: i.unitPrice, discountPct: i.discountPct, discountAmt: i.discountAmt,
    taxPct: i.taxPct, taxAmt: i.taxAmt, lineTotal: i.lineTotal,
  };
}

const PRODUCT_PHASE2_SELECT = {
  id: true, name: true, vatCategory: true, vatExemptionCode: true, vatExemptionReason: true,
} satisfies Prisma.ProductSelect;

/** الإعدادات التي يقرأ منها النظامُ الضريبيُّ قرارَه (جزء من صفّ البائع المحمَّل). */
function regimeSettingsOf(seller: { countryCode: string | null; einvoiceProvider: string | null; zatcaPhase2StartedAt: Date | null; taxNumber: string | null } | null): RegimeSettings | null {
  if (!seller) return null;
  return {
    countryCode: seller.countryCode, einvoiceProvider: seller.einvoiceProvider,
    zatcaPhase2StartedAt: seller.zatcaPhase2StartedAt, taxNumber: seller.taxNumber,
  };
}

/**
 * فرع المرحلة الثانية في POST /invoices.
 *
 * يعيد **null** حين يتبيّن أنّ النظام مرحلة أولى فعلاً (شركة في قائمة البروفة وعلمها مطفأ مثلاً): المستدعي يكمل مساره
 * القديم كما هو بلا أيّ أثر. وإلا يعيد ردّاً جاهزاً (201/202/4xx/5xx). لا يرمي إلا ما لا يخصّ الفوترة (يمضي إلى معالج
 * الأخطاء العام)، وP2002 على clientRef يُرمى عمداً ليعالجه سباق المسار القديم.
 */
export async function issuePhase2Invoice(ctx: Phase2IssuanceContext, deps: Phase2IssuanceDeps): Promise<Phase2Result | null> {
  const now = deps.now();
  const seller = await deps.units.loadSellerSettings(ctx.tenantId);
  const regime = await resolveInvoiceRegime(deps.db, ctx.tenantId, regimeSettingsOf(seller), {
    ...(deps.env ? { env: deps.env } : {}), now, seller,
  });
  if (regime.phase === 1) return null; // ← المرحلة الأولى: المسار القديم يكمل بلا تغيير

  // نقد 2: حارس القدرات قبل كلّ قرار آخر من المرحلة الثانية (الحجب، وقاعدة الانتقال في Z5.8)
  const gate = capsGate(ctx.caps);
  if (gate) return errorResult(gate);

  // المرتجع في المرحلة الثانية إشعارٌ دائن مرتبط بالأصل (Z5.5) لا فاتورة سالبة
  if (ctx.body.type === 'RETURN') return errorResult(new ZatcaHttpError('ZATCA_RETURN_NEEDS_ORIGINAL'));

  if ('blocked' in regime) return errorResult(unitUnavailableError(regime.blocked, { source: 'REGIME', code: regime.blocked }));
  if (!seller) return errorResult(unitUnavailableError('SELLER_NOT_READY', { source: 'REGIME', code: 'settings-missing' }));

  /* مفتاح المنع من التكرار (clientRef) يُشترط على ما أصله **صندوق العمل دون اتصال** وحده: إعادة رفع صريحة
   * (X-FS-Replay) أو حزمة المندوب (ترسل clientCreatedAt مع كل طلب، حيّاً كان أو مؤجَّلاً). رفعٌ مؤجَّل بلا مفتاح
   * يُنشئ فاتورةً ضريبيةً مكرّرة بـICV ثانٍ لا يُمحى.
   * أمّا الطلب الحيّ من لوحة الإدارة و/m فلا يرسل clientRef اليوم (InvoiceModal.tsx وMInvoiceCreate.tsx)، واشتراطه
   * عليه يُخرج اللوحة و/m من الخدمة يوم التفعيل برسالة «حدّث التطبيق» لا حيلة لها — وهو عين ما منعه نقد 1
   * (ترويسة القدرات وحدها تُثبت أنّ الحزمة تعرف الإصدار الضريبي). حمايتهما من الرفع المكرّر تُضاف في Z5.6b. */
  const offlineOrigin = isReplayRequest(ctx.caps) || typeof ctx.body.clientCreatedAt === 'string';
  if (offlineOrigin && (typeof ctx.body.clientRef !== 'string' || ctx.body.clientRef === '')) {
    return errorResult(new ZatcaHttpError('ZATCA_CLIENT_UPDATE_REQUIRED', { logDetail: { source: 'CAPS', code: 'NO_CLIENT_REF' } }));
  }

  try {
    return await issueNow(ctx, deps, seller, regime.unit, now);
  } catch (e) {
    const err = issuanceHttpError(e);
    if (!err) throw e; // P2002 على clientRef (سباق الرفع المكرّر) وما لا يخصّ الفوترة
    if (err.alert && deps.alert) {
      try {
        await deps.alert(err, { tenantId: ctx.tenantId, customerId: ctx.customerId });
      } catch { /* التنبيه لا يغيّر الردّ */ }
    }
    return errorResult(err);
  }
}

async function issueNow(
  ctx: Phase2IssuanceContext, deps: Phase2IssuanceDeps, seller: NonNullable<Awaited<ReturnType<EgsUnitStore['loadSellerSettings']>>>,
  unit: { id: string; tenantId: string; keyVersion: number; vatNumber: string },
  now: Date,
): Promise<Phase2Result> {
  // فئة الضريبة والإعفاء للأصناف — تُقرأ **داخل الفرع وحده** (المسار القديم لا يحتاجها ولا يدفع ثمنها)
  const productIds = [...new Set(ctx.body.items.map(i => i.productId))];
  const products: IssuanceProduct[] = await deps.db.product.findMany({
    where: { id: { in: productIds }, tenantId: ctx.tenantId },
    select: PRODUCT_PHASE2_SELECT,
  });

  const request: IssuanceRequest = {
    type: ctx.body.type,
    paymentPlan: ctx.body.paymentPlan ?? null,
    pricesIncludeTax: ctx.body.pricesIncludeTax,
    discountPct: ctx.body.discountPct ?? 0,
    items: ctx.body.items.map(i => ({ productId: i.productId, qty: i.qty, unitPrice: i.unitPrice, discountPct: i.discountPct ?? 0, taxPct: i.taxPct ?? null })),
    supplyDate: ctx.body.invoiceDate ?? null,
  };
  // كلّ رفض هنا قبل أيّ قفل أو ICV (D2/Q2، D9، الفحص المسبق، مبالغ D6)
  const prepared: PreparedIssuance = prepareIssuance({
    settings: seller, customer: ctx.customer, products, request, companyVat: ctx.companyVat, engine: ctx.engine, now,
  });

  // المفتاح والشهادة لهذا الطلب وحده (بلا تخزين مؤقت)
  const signing = await openIssuanceSigning({ store: deps.units, keyring: deps.keyring, now }, unit);

  let created: Record<string, unknown> & { id: string } | null = null;
  const issued: StampInTxResult = await runIssuance({
    unitId: unit.id,
    ...(deps.mutex !== undefined ? { mutex: deps.mutex } : {}),
    transaction: () => deps.transaction(async tx => {
      created = null; // إعادة المعاملة (تصادم ترقيم) تبدأ من صفّ جديد
      return stampInTx<Phase2Tx>(tx, { chain: deps.chain, documents: deps.documents, now: deps.now }, {
        tenantId: ctx.tenantId,
        prepared,
        signing,
        sellerVat: seller.taxNumber,
        hooks: {
          allocateNumber: (t, issuedAt) => deps.chain.nextNumberInTx(t, ctx.tenantId, phase2NumberPrefix('INV', issuedAt)),
          createInvoice: async (t, record) => {
            const row = await t.invoice.create({
              data: {
                tenantId: ctx.tenantId,
                number: record.number,
                clientRef: ctx.body.clientRef ?? undefined,
                clientCreatedAt: ctx.body.clientCreatedAt ? new Date(ctx.body.clientCreatedAt) : undefined,
                customerId: ctx.customerId,
                salesRepId: ctx.salesRepId,
                type: ctx.body.type,
                ...(ctx.deliveryDate && { deliveryDate: ctx.deliveryDate }),
                dueDate: ctx.installments.length ? ctx.installments[ctx.installments.length - 1].dueDate : ctx.dueDate,
                ...(ctx.body.paymentPlan && { paymentPlan: ctx.body.paymentPlan }),
                ...(ctx.installments.length && {
                  installments: { create: ctx.installments.map(r => ({ tenantId: ctx.tenantId, seq: r.seq, dueDate: r.dueDate, amount: r.amount })) },
                }),
                notes: ctx.body.notes ?? undefined,
                ...(ctx.signatureImages && { signature: { create: { tenantId: ctx.tenantId, ...ctx.signatureImages } } }),
                pricesIncludeTax: ctx.body.pricesIncludeTax,
                discountPct: ctx.body.discountPct ?? 0,
                paidAmt: ctx.body.type === 'CASH' ? record.amounts.total : 0,
                remainingAmt: ctx.body.type === 'CASH' ? 0 : record.amounts.total,
                // أعمدة المرحلة الثانية والمرآة والمبالغ المخزَّنة (§2.4) — تغلب قيم المحرّك عمداً
                ...phase2InvoiceColumns(record),
                einvoiceSnapshot: record.snapshot as unknown as Prisma.InputJsonObject,
                items: {
                  // أعمدة البند القديمة كما هي، ثمّ seq والاسم والوحدة والفئة والإعفاء وضريبة سطر الـXML فوقها
                  create: ctx.items.map((i, idx) => ({ ...legacyItemColumns(i), ...phase2ItemColumns(record.items[idx]) })),
                },
              },
              include: { items: true, customer: true, installments: { orderBy: { seq: 'asc' } }, signature: { select: { image: true, repImage: true } } },
            });
            created = row as Record<string, unknown> & { id: string };
            return { id: row.id };
          },
          // نقد 38: قيود دفتر العميل (وقفل صفّه) **بعد** الختم وإدراج المستند وتقدّم السلسلة
          afterDocument: async (t, summary) => {
            const total = prepared.amounts.total;
            if (ctx.body.type === 'CASH') {
              await deps.ledger.postCashInvoice(t, ctx.tenantId, summary.invoiceId, ctx.customerId, total, summary.issuedAt);
            } else {
              await deps.ledger.postCreditInvoice(t, ctx.tenantId, summary.invoiceId, ctx.customerId, total, summary.issuedAt);
              if (ctx.creditCheck) {
                await deps.ledger.creditLimitNotice(t, {
                  tenantId: ctx.tenantId, invoiceId: summary.invoiceId, customerId: ctx.customerId, salesRepId: ctx.salesRepId,
                  customerName: ctx.customerName, balance: ctx.customerBalance + total, limit: ctx.customerCreditLimit,
                });
              }
            }
          },
        },
      });
    }),
  });

  if (!created) throw new ZatcaHttpError('ZATCA_INTERNAL', { logDetail: { source: 'ISSUE', code: 'ROW_MISSING' } });
  deps.publish(ctx.tenantId);

  const view = einvoiceView(
    {
      environment: issued.environment, status: 'SIGNED', typeCode: issued.typeCode, typeName: issued.typeName, icv: issued.icv,
      uuid: issued.uuid, issueDate: issued.issueDate, issueTime: issued.issueTime, reportDeadline: issued.reportDeadline,
    },
    {
      einvoiceStatus: issued.mirror.einvoiceStatus, einvoiceQr: issued.mirror.einvoiceQr, documentKind: prepared.kind,
      invoiceSubtype: prepared.subtype, issuedAt: issued.issuedAt,
    },
    now,
    issued.warnings,
  );
  const data = { ...(created as Record<string, unknown>), einvoice: view };
  // القياسية (01) تنتظر اعتماد الهيئة قبل تسليمها فاتورةً ضريبية — الاعتماد نفسه في Z5.4
  if (prepared.subtype === '01') {
    return {
      status: ZATCA_ERROR_CATALOGUE.ZATCA_CLEARANCE_PENDING.status,
      body: { success: true, code: 'ZATCA_CLEARANCE_PENDING', message: ZATCA_ERROR_CATALOGUE.ZATCA_CLEARANCE_PENDING.messageAr, data },
    };
  }
  return { status: 201, body: { success: true, data } };
}

/**
 * «تتبّع اللوط» — توزيع بنود الفواتير (المرحلة الأولى والثانية) وحرّاس إلغاء المرتجع وإطفاء عودته للمخزون (المواصفة §٤.٨،
 * §٤.١٠–٤.١٣، §٤.١٨). لا يستورد إعداد القاعدة: كل دالّة تأخذ db أو tx (الإصدار يمرّر معاملته، والفحص المسبق قاعدته).
 *
 * - **البيع** (§٤.٨): allocateOutLines على عرض سيارة المندوب، لكل صنفٍ بأسطره — لكل سطرٍ كميته الأساسية ومعامل وحدته وصريحه
 *   أو تلميحه (D22، D16، D26): FEFO من المؤهَّل ثم غير المسمّى (D17)، والصريح للإدارة والمفتاح، والطبقات للإعادة دون اتصال
 *   (R6). لا بيع فوق صالح تشغيلة (I1) ولا تحت min(0, غير المسمّى) (I2) لأي فاعل، ومنه من يملك «البيع بدون مخزون».
 * - **المرتجع المرتبط والإشعار الدائن** (§٤.١٠، §٤.٩): وراثة صفوف البيع بالترتيب الهجين (allocateReturnFromSale).
 * - **المرتجع الحرّ** (§٤.١١): «غير معروف» للمندوب، وصريحٌ اختياري للإدارة والمفتاح بلا فحص رصيد (زيادة).
 * - **الإزالة** (§٤.١٢–٤.١٣): إلغاء مرتجع أو إطفاء عودته لا يُبقي تشغيلةً سالبة ولا يُنقص غير المسمّى دون min(0, قبله).
 * كل كمية بوحدة الأساس (D22) وبأربع خانات (isLotQty) عدا الإعادة (R6).
 */
import type { LotDb, LotTx } from './lotsDb';
import { companyDay, loadLotMetas, lockLotProducts, placeViews } from './lotsDb';
import {
  ClientRefRace, LOT_HOLD_MIRRORS, LotError,
  allocateOutLines, allocateReturnFromSale, invEffect, isLotQty, lotBaseQty, lotErr, lotRemovalsOf,
  parseLotHint, parseLotRefsStrict, removalKeepsLots, replayMoment, stampFromRows,
  type AllocRow, type InvoiceLotAllocation, type InvoiceLotLine, type InvoiceLotPlan, type ItemExpiryStamp, type LotActor,
  type LotCertainty, type LotMeta, type LotRef, type LotRemovalItem, type LotWarning, type SaleLotRow,
} from './lots';
import { factorOf } from './units';
import { isDamagedVanReturn } from './vanDamaged';

type LineAlloc = { rows: AllocRow[]; stamp: ItemExpiryStamp | null };
type Allocated = { lines: Map<number, LineAlloc>; warnings: LotWarning[] };

/** D17 (افتراض المالك): البيع من غير المسمّى مسموح بعد نفاد المسمّى المؤهَّل، بيقين UNKNOWN، ولا يُنقص دون الصفر (I2) */
export const LOT_ALLOW_UNKNOWN = true;
/** مهلة كل معاملة فيها صنفٌ متتبَّع (D13) — والمسار غير المتتبَّع بلا خيار */
export const LOT_TX_OPTIONS = Object.freeze({ maxWait: 10_000, timeout: 20_000 });

const uniq = (xs: Iterable<string | null | undefined>): string[] => [...new Set([...xs].filter((x): x is string => typeof x === 'string' && x.length > 0))];
const isoDay = (d: Date | null | undefined): string | null => (d ? new Date(d).toISOString().slice(0, 10) : null);
const dayDate = (d: string): Date => new Date(`${d}T00:00:00.000Z`);
const CERTAINTIES: readonly LotCertainty[] = ['CONFIRMED', 'ASSUMED', 'UNKNOWN'];
const certaintyOf = (c: string): LotCertainty => ((CERTAINTIES as readonly string[]).includes(c) ? (c as LotCertainty) : 'ASSUMED');

/** خطأ لوط بفهرس السطر وصنفه — الرسالة والرمز والحالة كما هي */
const withLine = (e: LotError, l: Pick<InvoiceLotLine, 'idx' | 'productId'>): LotError =>
  new LotError(e.code, e.message, e.status, { ...(e.detail ?? {}), productId: l.productId, line: l.idx });

// ═══ بناء الخطة (يتشاركه مسار المرحلة الأولى وفرع المرحلة الثانية) ═══

/**
 * لحظة المستند المتتبَّع ويومه (D23): المسار الحيّ بيوم الخادم بمنطقة الشركة. والإعادة دون اتصال للمندوب وحده، بترويسة
 * الصندوق ومرجعه ولحظة جهازه صالحةً، محصورةً بين «الآن − ٧ أيام» و«الآن» وموسومة (REPLAY_CLAMPED). والمفتاح لا ينالها
 * (ترويسته تُمحى في middleware/auth.ts). يوم المرتجع بالقاعدة نفسها، وnull لغير المرتجع.
 */
export function invoiceLotMoment(input: {
  actor: LotActor; replayHeader: boolean; clientRef: string | null | undefined; clientCreatedAt: unknown;
  now: Date; tz: string; serverDay: string; isReturn: boolean;
}): { replay: { at: Date; clamped: boolean } | null; day: string; returnDay: string | null } {
  const m = input.actor === 'REP' && input.replayHeader && input.clientRef
    ? replayMoment(input.clientCreatedAt, input.now, input.tz)
    : null;
  const day = m?.day ?? input.serverDay;
  return { replay: m ? { at: m.at, clamped: m.clamped } : null, day, returnDay: input.isReturn ? day : null };
}

/**
 * أسطر الخطة من بنود المستند: الكمية الأساسية (qty × معامل لقطة الوحدة، D22) ومعاملها، وبند البيع للمرتجع المرتبط، وصفوف
 * اللوط كما وردت (lotsRaw: تُحلَّل بحسب الفاعل داخل التوزيع). الفهرس = موضع البند في المستند.
 */
export function invoiceLotLines(items: { productId: string; productName: string; qty: number; unitFactor?: number | null; saleItemId?: string | null; lots?: unknown }[]): InvoiceLotLine[] {
  return items.map((it, idx) => ({
    idx, productId: it.productId, productName: it.productName,
    qty: lotBaseQty({ qty: it.qty, unitFactor: it.unitFactor ?? 1 }), unitFactor: factorOf({ unitFactor: it.unitFactor }),
    saleItemId: it.saleItemId ?? null, lotsRaw: it.lots,
  }));
}

/** عَلَم الشركة — لفرع المرحلة الثانية (الإشعار الدائن حين يحمل أصله صنفاً متتبَّعاً، §١٠.١ الاستثناء الموثَّق) */
export async function lotTrackingEnabledFor(db: LotDb, tid: string): Promise<boolean> {
  const t = await db.tenant.findUnique({ where: { id: tid }, select: { lotTrackingEnabled: true } });
  return t?.lotTrackingEnabled === true;
}

// ═══ البيع (§٤.٨) ═══

/**
 * توزيع أسطر البيع المتتبَّعة على تشغيلات سيارة المندوب، لكل صنفٍ بأسطره (allocateOutLines): الصريح (الإدارة/المفتاح) يُحلَّل
 * بصرامة لكل سطر، والتلميح (المندوب مع الإعادة) بتسامح، والمندوب حيّاً يوزّع الخادم. لا allocateOut على المجموع ثم
 * distributeToLines: ذاك يشقّ كرتون «٢ كرتون + ٥ حبة» بلا وسم ويعيد توزيع التلميح فيخالف لوطُ السطر ورقته.
 */
async function allocateSale(db: LotDb, plan: InvoiceLotPlan, lines: InvoiceLotLine[]): Promise<Allocated> {
  const out = new Map<number, LineAlloc>();
  const warnings: LotWarning[] = [];
  const vanKey = plan.vanKey;
  if (!vanKey) throw new Error('LOT_SALE_WITHOUT_VAN');
  const strict = plan.actor !== 'REP';
  const explicitOf = new Map<number, LotRef[] | null>();
  const hintOf = new Map<number, LotRef[] | null>();
  for (const l of lines) {
    if (strict) {
      const r = parseLotRefsStrict(l.lotsRaw, l.qty);
      if (r instanceof LotError) throw withLine(r, l);
      explicitOf.set(l.idx, r.length ? r : null);
    } else if (plan.replay) {
      hintOf.set(l.idx, parseLotHint(l.lotsRaw));
    }
  }
  const pids = uniq(lines.map((l) => l.productId));
  const pv = await placeViews(db, plan.tenantId, { vanKeys: [vanKey], productIds: pids, withTotals: true });
  const views = pv.vans.get(vanKey);
  // بطاقات التشغيلات الصريحة: تشغيلةٌ من شركة أو صنفٍ آخر أو بلا رصيدٍ في السيارة تأخذ رمزها (NOT_FOUND/MISMATCH/BLOCKED/EXPIRED)
  const explicitIds = uniq([...explicitOf.values()].flatMap((rs) => (rs ?? []).map((r) => r.lotId)));
  const lookup = explicitIds.length ? await loadLotMetas(db, plan.tenantId, { lotIds: explicitIds }) : null;
  for (const pid of pids) {
    const view = views?.get(pid);
    if (!view) throw new Error(`LOT_VIEW_MISSING: ${pid}`);
    const own = lines.filter((l) => l.productId === pid);
    const r = allocateOutLines({
      productId: pid, productName: own[0].productName,
      lines: own.map((l) => ({ idx: l.idx, qty: l.qty, unitFactor: l.unitFactor, explicit: explicitOf.get(l.idx) ?? null, hint: hintOf.get(l.idx) ?? null })),
      view, day: plan.day, mode: 'SALE', allowUnknown: plan.allowUnknown, replay: plan.replay, lookup,
    });
    if (!r.ok) throw new LotError(r.error.code, r.error.message, r.error.status, { ...(r.error.detail ?? {}), lines: own.map((l) => l.idx) });
    warnings.push(...r.warnings);
    for (const l of own) {
      const rows = r.lines.get(l.idx) ?? [];
      // صلاحية بند البيع من أقرب انتهاءٍ مسمّى (D12)؛ صفوف «غير معروف» وحدها ⇒ اللقطة القائمة (الختم اللاحق، ن١-٣)
      const s = stampFromRows(rows);
      out.set(l.idx, { rows, stamp: s ? { expiresAt: dayDate(s.expiresAt), returnExpired: null, expirySaleInvoiceId: null } : null });
    }
  }
  return { lines: out, warnings };
}

// ═══ المرتجع المرتبط والإشعار الدائن (§٤.١٠، §٤.٩) ═══

/**
 * ما أُرجع من كل صفّ توزيع بيع في مرتجعاتٍ وإشعاراتٍ غير ملغاة (sourceItemLotId) — مرآة returnedBySaleItem (returnLinks.ts)
 * بصفوف اللوط.
 */
async function returnedBySource(db: LotDb, tid: string, rowIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!rowIds.length) return out;
  const prior = await db.invoiceItemLot.findMany({
    where: { tenantId: tid, sourceItemLotId: { in: rowIds }, invoiceItem: { invoice: { tenantId: tid, status: { not: 'CANCELLED' } } } },
    select: { sourceItemLotId: true, quantity: true },
  });
  for (const p of prior) if (p.sourceItemLotId) out.set(p.sourceItemLotId, (out.get(p.sourceItemLotId) ?? 0) + Number(p.quantity));
  return out;
}

/**
 * وراثة صفوف توزيع البيع (فاتورة البيع مقفلةٌ عند المستدعي): المتاح لكل صفّ = كميته − ما أُرجع منه، بالترتيب الهجين (ن١-٢)،
 * وسطران على بند بيعٍ واحد يتتابعان (الثاني يرى ما أخذه الأول). الختم من الصفوف المسمّاة بيوم المرتجع (D6: المنتهي يوجّه البند
 * كله)، وإلا اللقطة القائمة (linkedExpiry) — وفاتورة البيع في expirySaleInvoiceId.
 */
async function allocateLinkedReturn(db: LotDb, plan: InvoiceLotPlan, lines: InvoiceLotLine[]): Promise<Allocated> {
  const out = new Map<number, LineAlloc>();
  const tid = plan.tenantId;
  const returnDay = plan.returnDay ?? plan.day;
  const saleItemIds = uniq(lines.map((l) => l.saleItemId));
  const [saleRowsRaw, saleItems] = saleItemIds.length
    ? await Promise.all([
      db.invoiceItemLot.findMany({
        where: { tenantId: tid, invoiceItemId: { in: saleItemIds } },
        select: { id: true, invoiceItemId: true, lotId: true, quantity: true, certainty: true, expiryDate: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
      db.invoiceItem.findMany({ where: { id: { in: saleItemIds }, invoice: { tenantId: tid } }, select: { id: true, invoiceId: true } }),
    ])
    : [[], []];
  const saleInvoiceOf = new Map(saleItems.map((x) => [x.id, x.invoiceId]));
  const rowsByItem = new Map<string, SaleLotRow[]>();
  for (const r of saleRowsRaw) {
    const list = rowsByItem.get(r.invoiceItemId) ?? [];
    list.push({ id: r.id, lotId: r.lotId ?? null, quantity: Number(r.quantity), certainty: certaintyOf(r.certainty), expiryDate: isoDay(r.expiryDate) });
    rowsByItem.set(r.invoiceItemId, list);
  }
  const returned = await returnedBySource(db, tid, saleRowsRaw.map((r) => r.id));
  for (const l of lines) {
    const saleRows = l.saleItemId ? rowsByItem.get(l.saleItemId) ?? [] : [];
    const rows = allocateReturnFromSale({ qty: l.qty, returnDay, saleRows, returnedBySource: returned });
    for (const r of rows) if (r.sourceItemLotId) returned.set(r.sourceItemLotId, (returned.get(r.sourceItemLotId) ?? 0) + r.qty);
    const s = stampFromRows(rows, returnDay);
    const fallback = plan.fallbackStamps.get(l.idx) ?? null;
    const saleInvoiceId = (l.saleItemId && saleInvoiceOf.get(l.saleItemId)) || fallback?.expirySaleInvoiceId || null;
    out.set(l.idx, {
      rows,
      stamp: s ? { expiresAt: dayDate(s.expiresAt), returnExpired: s.returnExpired, expirySaleInvoiceId: saleInvoiceId } : fallback,
    });
  }
  return { lines: out, warnings: [] };
}

// ═══ المرتجع الحرّ (§٤.١١) ═══

/**
 * المندوب: صفٌّ واحد «غير معروف» بلا نقرة (D5). الإدارة والمفتاح: صريحٌ اختياري — التشغيلة من الشركة والصنف، Σ = الكمية
 * الأساسية، بلا فحص رصيد (زيادة)، والموقوفة تُقبل فتدخل معزولةً مع تحذير LOT_INTO_BLOCKED، واليقين CONFIRMED. الختم من الصفوف
 * المسمّاة، وإلا لقطة «آخر بيع» المحسوبة قبل المعاملة (fallbackStamps، ن١-٣).
 */
async function allocateFreeReturn(db: LotDb, plan: InvoiceLotPlan, lines: InvoiceLotLine[]): Promise<Allocated> {
  const out = new Map<number, LineAlloc>();
  const warnings: LotWarning[] = [];
  const returnDay = plan.returnDay ?? plan.day;
  const refs = new Map<number, LotRef[]>();
  if (plan.actor !== 'REP') {
    for (const l of lines) {
      const r = parseLotRefsStrict(l.lotsRaw, l.qty);
      if (r instanceof LotError) throw withLine(r, l);
      if (r.length) refs.set(l.idx, r);
    }
  }
  const lotIds = uniq([...refs.values()].flatMap((rs) => rs.map((r) => r.lotId)));
  const metas: Map<string, LotMeta> = lotIds.length ? await loadLotMetas(db, plan.tenantId, { lotIds }) : new Map();
  const intoBlocked = new Set<string>();
  for (const l of lines) {
    const lineRefs = refs.get(l.idx);
    const merged = new Map<string, { lotId: string | null; qty: number }>();
    for (const ref of lineRefs ?? [{ lotId: null, qty: l.qty }]) {
      const k = ref.lotId ?? '';
      const prev = merged.get(k);
      if (prev) prev.qty += ref.qty; else merged.set(k, { lotId: ref.lotId, qty: ref.qty });
    }
    const rows: AllocRow[] = [...merged.values()].map((ref) => {
      if (ref.lotId == null) return { lotId: null, qty: ref.qty, certainty: 'UNKNOWN', flags: [], expiryDate: null };
      const m = metas.get(ref.lotId);
      if (!m) throw lotErr('LOT_NOT_FOUND', {}, { productId: l.productId, lotId: ref.lotId, line: l.idx });
      if (m.productId !== l.productId) {
        throw lotErr('LOT_PRODUCT_MISMATCH', { lot: m.lotNumber, name: l.productName }, { productId: l.productId, lotId: m.id, lotProductId: m.productId, line: l.idx });
      }
      if (m.status !== 'ACTIVE' && !intoBlocked.has(m.id)) {
        intoBlocked.add(m.id);
        warnings.push({ code: 'LOT_INTO_BLOCKED', productId: l.productId, detail: { lotId: m.id, lotNumber: m.lotNumber, blockKind: m.blockKind, line: l.idx } });
      }
      return { lotId: m.id, qty: ref.qty, certainty: 'CONFIRMED', flags: [], expiryDate: m.expiryDate };
    });
    const s = stampFromRows(rows, returnDay);
    out.set(l.idx, {
      rows,
      stamp: s ? { expiresAt: dayDate(s.expiresAt), returnExpired: s.returnExpired, expirySaleInvoiceId: null } : (plan.fallbackStamps.get(l.idx) ?? null),
    });
  }
  return { lines: out, warnings };
}

/** التوزيع على مجموعة الأصناف المتتبَّعة — يرمي LotError عند الرفض (يشترك فيه الإصدار والفحص المسبق) */
async function allocateTracked(db: LotDb, plan: InvoiceLotPlan, tracked: ReadonlySet<string>): Promise<Allocated> {
  const lines = plan.lines.filter((l) => tracked.has(l.productId));
  if (!lines.length) return { lines: new Map(), warnings: [] };
  // كل كتابةٍ لصنفٍ متتبَّع بأربع خانات (الطيّ مقرَّب لأربع فيُصرف ما لا يوجد، I1) — والإعادة لا تُرفض بها (R6)
  if (!plan.replay) {
    for (const l of lines) {
      if (!isLotQty(l.qty)) throw lotErr('LOT_QTY_INVALID', {}, { productId: l.productId, line: l.idx, wanted: l.qty, decimals: 4 });
    }
  }
  if (plan.link !== 'NONE') return allocateLinkedReturn(db, plan, lines);
  if (plan.docType === 'RETURN') return allocateFreeReturn(db, plan, lines);
  return allocateSale(db, plan, lines);
}

/** التحذيرات التي تستحق إشعار الإدارة: صرفٌ من موقوف أو مسحوب أو منتهٍ، أو حصر اللحظة، أو تلميحٌ مرفوض (§٣.٣) */
const isFlagged = (w: LotWarning) => w.code === 'LOT_REPLAY_FLAGGED';

/** صفوف FOR KEY SHARE المقروءة سلفاً في معاملة الإصدار (lockedRows لـlockLotProducts) */
export interface LockedProductRow { id: string; lotTracked: boolean; lotTrackedSince: Date | null }

/**
 * داخل معاملة الإصدار، بعد assertReturnLinks وقبل tx.invoice.create (§٤.٨ البند ٧):
 * 1. lockLotProducts لكل أصناف المستند ⇒ المجموعة الموثوقة (D25)؛ صنفٌ صار متتبَّعاً بين القراءتين يُوزَّع، وما أُطفئ لا.
 *    `opts.lockedRows`: صفوف استعلام FOR KEY SHARE القائم في المسار (الوحدات المتعددة) فلا يتكرّر — تُستعمل إن غطّت كل الأصناف.
 * 2. clientRef موجودٌ تحت القفل ⇒ ClientRefRace (يلتقطه فرع P2002 فيعيد الفاتورة القائمة 200) — لا توزيع ثانٍ لمستندٍ واحد،
 *    ولا 409 كاذب لطلبٍ مكرَّر صُرف رصيده للتوّ.
 * 3. التوزيع (البيع، أو المرتجع المرتبط/الإشعار الدائن، أو الحرّ)، ثم إشعار LOT_REPLAY_FLAGGED داخل المعاملة نفسها.
 */
export async function allocateInvoiceLotsInTx(tx: LotTx, plan: InvoiceLotPlan, opts?: { lockedRows?: LockedProductRow[] | null }): Promise<InvoiceLotAllocation> {
  const pids = uniq(plan.lines.map((l) => l.productId));
  const rows = opts?.lockedRows;
  const covered = !!rows && pids.every((p) => rows.some((r) => r.id === p));
  const { tracked } = await lockLotProducts(tx, plan.tenantId, pids, covered ? { lockedRows: rows! } : undefined);
  if (plan.clientRef) {
    const dup = await tx.invoice.findUnique({ where: { tenantId_clientRef: { tenantId: plan.tenantId, clientRef: plan.clientRef } }, select: { id: true } });
    if (dup) throw new ClientRefRace();
  }
  const res = await allocateTracked(tx, plan, tracked);
  const flagged = res.warnings.filter(isFlagged);
  if (flagged.length) {
    const flags = [...new Set(flagged.flatMap((w) => (Array.isArray(w.detail?.flags) ? (w.detail!.flags as string[]) : [])))];
    await tx.notification.create({
      data: {
        tenantId: plan.tenantId,
        type: 'LOT_REPLAY_FLAGGED',
        title: 'فاتورة دون اتصال خالفت التشغيلات',
        body: 'فاتورة أعيد رفعها فصرفت من تشغيلة موقوفة أو مسحوبة أو منتهية أو رفض تلميح الجهاز فقد تخالف الورقة السجل',
        salesRepId: plan.vanKey,
        customerId: plan.customerId,
        data: JSON.stringify({ clientRef: plan.clientRef, flags, products: flagged.map((w) => w.productId) }),
      },
    });
  }
  return { tracked, lines: res.lines, warnings: res.warnings };
}

/**
 * فحصٌ رخيص بلا قفل قبل openIssuanceSigning (ن٢-٣، للمرحلة الثانية): التوزيع نفسه على قراءةٍ بلا قفل — ما سيُرفض حتماً
 * لا يُوقَّع. LotError ⇒ يُعاد (لا يُرمى)؛ وغيره يُرمى. القرار النهائي داخل المعاملة (allocateInvoiceLotsInTx).
 */
export async function precheckInvoiceLots(db: LotDb, plan: InvoiceLotPlan): Promise<LotError | null> {
  const pids = uniq(plan.lines.map((l) => l.productId));
  if (!pids.length) return null;
  const rows = await db.product.findMany({ where: { tenantId: plan.tenantId, id: { in: pids }, lotTracked: true }, select: { id: true } });
  if (!rows.length) return null;
  try {
    await allocateTracked(db, plan, new Set(rows.map((r) => r.id)));
    return null;
  } catch (e) {
    if (e instanceof LotError) return e;
    throw e;
  }
}

/** طلب لقطة «آخر بيع» للمرتجع الحرّ (§٤.١٨): العميل وتاريخ الفاتورة ولحظة المرتجع، وأسطر الأصناف بفهارسها */
export interface FreeReturnStampsQuery {
  customerId: string; invoiceDate: Date; returnAt: Date;
  items: { idx: number; productId: string }[];
}

/**
 * لقطة «آخر بيع» للمرتجع الحرّ محسوبةً **قبل** المعاملة (ن٢-٢) فتُكتب داخلها (ن١-٣) — تغلّف freeReturnStamps في
 * invoiceExpiry.ts (نسخةٌ واحدة مع الختم اللاحق) بقاعدة المستدعي. للصنف المتتبَّع تُقبل لقطة بيعٍ مختومة من التشغيلة وإن كانت
 * صلاحيته مطفأة (D21). يُستورد ديناميكياً: الوحدة لا تجرّ إعداد القاعدة إلى من يستوردها (فرعا المرحلة الثانية).
 */
export async function freeReturnStamps(db: LotDb, tid: string, q: FreeReturnStampsQuery): Promise<Map<number, ItemExpiryStamp>> {
  const out = new Map<number, ItemExpiryStamp>();
  if (!q.items.length) return out;
  const expiry = await import('./invoiceExpiry');
  const products = await db.product.findMany({
    where: { tenantId: tid, id: { in: uniq(q.items.map((i) => i.productId)) } },
    select: { id: true, shelfLifeEnabled: true, shelfLifeValue: true, shelfLifeUnit: true, shelfLifeBasis: true, shelfLifeFromDate: true },
  });
  const byId = new Map(products.map((p) => [p.id, p]));
  const { tz } = await companyDay(db, tid, q.returnAt);
  const stamps = await expiry.freeReturnStamps(tid, { customerId: q.customerId, invoiceDate: q.invoiceDate, returnAt: q.returnAt },
    q.items.filter((i) => byId.has(i.productId)).map((i) => ({ key: i.idx, productId: i.productId, product: byId.get(i.productId)! })),
    { tz, db });
  for (const [idx, s] of stamps) out.set(idx, s);
  return out;
}

// ═══ حرّاس الإزالة (§٤.١٢–٤.١٣) ═══

/** مرتجعٌ محجوز (D24) = voidDecision (void.ts:65-77): المرحلة الثانية، «01»، والمرآة فارغة أو ضمن LOT_HOLD_MIRRORS */
function isHeldDoc(inv: { type: string; zatcaPhase: number | null; invoiceSubtype: string | null; einvoiceStatus: string | null }): boolean {
  return inv.type === 'RETURN' && inv.zatcaPhase === 2 && inv.invoiceSubtype === '01'
    && (inv.einvoiceStatus == null || (LOT_HOLD_MIRRORS as readonly string[]).includes(inv.einvoiceStatus));
}

const later = (a: Date | null | undefined, b: Date | null | undefined): Date | null => {
  if (!a) return b ?? null;
  if (!b) return a;
  return a.getTime() >= b.getTime() ? a : b;
};

/**
 * إزالة أثر مرتجعٍ من سيارته (إلغاؤه، أو إطفاء عودته للمخزون) لا تكسر I1 ولا I2. صفّ الفاتورة مقفلٌ عند المستدعي
 * (lockInvoiceForCancel أو FOR UPDATE)، ثم بنوده وكل صفوف توزيعها المسمّاة والفارغة، ثم قفل أصناف البنود (لا أصناف الصفوف
 * وحدها: البند بلا صفوف كُتب قبل التتبّع وكميته في غير المسمّى عبر رصيد الصنف)، ثم عرض السيارة قبل الإزالة.
 */
async function assertRemovalKeepsLots(tx: LotTx, tid: string, invoiceId: string, mode: 'CANCEL' | 'RESTOCK_OFF'): Promise<void> {
  const inv = await tx.invoice.findFirst({
    where: { id: invoiceId, tenantId: tid },
    select: {
      id: true, type: true, status: true, salesRepId: true, returnToStock: true, returnReason: true, createdAt: true,
      zatcaPhase: true, invoiceSubtype: true, einvoiceStatus: true,
      items: { select: { productId: true, qty: true, baseQty: true, unitFactor: true, returnExpired: true, lots: { select: { lotId: true, quantity: true, createdAt: true, vanKey: true } } } },
    },
  });
  if (!inv || inv.type !== 'RETURN' || inv.status !== 'CONFIRMED') return;
  // إطفاء العودة يُزيل ما في SELLABLE وحده، وفقط إن كان المرتجع عائداً للمخزون الآن (foldStock يقرأ returnToStock صدقاً)
  if (mode === 'RESTOCK_OFF' && inv.returnToStock !== true) return;
  const pids = uniq(inv.items.map((it) => it.productId));
  if (!pids.length) return;
  const tenant = await tx.tenant.findUnique({ where: { id: tid }, select: { lotTrackingEnabled: true, lotTrackingSince: true } });
  if (tenant?.lotTrackingEnabled !== true) return;
  const { tracked, since } = await lockLotProducts(tx, tid, pids);
  if (!tracked.size) return;
  // الحقبة الفعلية لكل صنف = max(حقبة الشركة، حقبة الصنف) — شرط الطيّ في SQL نفسه
  const epoch = new Map(pids.map((p) => [p, later(tenant.lotTrackingSince, since.get(p) ?? null)]));
  const held = isHeldDoc(inv);
  const damaged = isDamagedVanReturn(inv);
  const items: LotRemovalItem[] = inv.items.filter((it) => it.productId).map((it) => {
    const e = invEffect({ type: inv.type, returnToStock: inv.returnToStock, returnExpired: it.returnExpired, damaged });
    const bucket = mode === 'CANCEL' ? (e?.bucket ?? null) : (e?.bucket === 'SELLABLE' ? 'SELLABLE' : null);
    return {
      productId: it.productId!, qty: lotBaseQty({ qty: Number(it.qty), baseQty: it.baseQty, unitFactor: it.unitFactor }), bucket, held,
      rows: it.lots.map((r) => ({ lotId: r.lotId ?? null, quantity: Number(r.quantity), createdAt: new Date(r.createdAt) })),
    };
  });
  let removals = lotRemovalsOf(items, epoch, tracked);
  // مندوبٌ محذوف (salesRepId = null بعد الحذف): بنود المستند خارج رصيد أي سيارة، وصفوفه المسمّاة باقية بمفتاح سيارته
  const vanKey = inv.salesRepId ?? inv.items.flatMap((it) => it.lots).find((r) => r.vanKey)?.vanKey ?? null;
  if (!inv.salesRepId) removals = removals.filter((r) => r.lotId != null);
  if (!vanKey || !removals.length) return;
  const rpids = uniq(removals.map((r) => r.productId));
  const pv = await placeViews(tx, tid, { vanKeys: [vanKey], productIds: rpids, withTotals: true });
  const views = pv.vans.get(vanKey);
  for (const pid of rpids) {
    const view = views?.get(pid);
    if (!view) throw new Error(`LOT_VIEW_MISSING: ${pid}`);
    const err = removalKeepsLots(view, removals);
    if (!err) continue;
    const lotNumber = typeof err.detail?.lotNumber === 'string' ? err.detail.lotNumber : null;
    const from = err.detail?.lotId == null ? 'الرصيد غير المسمّى' : `التشغيلة ${lotNumber ?? ''}`.trim();
    const what = mode === 'CANCEL' ? 'لا يُلغى المرتجع' : 'لا تُطفأ عودة المرتجع للمخزون';
    throw new LotError(err.code, `${what}: بيعت بضاعته من ${from}`, err.status, { ...(err.detail ?? {}), mode });
  }
}

/**
 * إلغاء مرتجع (§٤.١٢): بنود المرتجع وصفوفها ⇒ lotRemovalsOf (البند بلا صفوف والصفّ قبل الحقبة على غير المسمّى، والمحجوز بلا
 * فحص؛ since = max(Tenant.lotTrackingSince, Product.lotTrackedSince)) ⇒ removalKeepsLots على عرض السيارة لكل صنف — الصالح بعد
 * الطرح ≥ −EPS للمسمّى (I1) و≥ min(0, قبله) − EPS للفارغ (I2)، وإلا 409 LOT_STOCK_INSUFFICIENT
 */
export async function assertReturnCancelKeepsLots(tx: LotTx, tid: string, invoiceId: string): Promise<void> {
  await assertRemovalKeepsLots(tx, tid, invoiceId, 'CANCEL');
}

/** إعادة المرتجع للمخزون إلى false (§٤.١٣): القاعدة نفسها (lotRemovalsOf ثم removalKeepsLots) بدلو SELLABLE للبنود التي يوجّهها invEffect إليه */
export async function assertRestockOffKeepsLots(tx: LotTx, tid: string, invoiceId: string): Promise<void> {
  await assertRemovalKeepsLots(tx, tid, invoiceId, 'RESTOCK_OFF');
}

// ═══ مساعدات المسار ═══

/**
 * إشعار الحجز للمراجعة (D20): فاتورة دون اتصال لا يكفيها رصيد السيارة الفعلي — يُكتب خارج المعاملة الملغاة، مرةً واحدة لكل
 * clientRef (الجهاز يعيد السؤال دورياً). لا يرمي: فشله لا يغيّر ردّ 409.
 */
export async function recordReplayHeld(db: LotDb, input: {
  tenantId: string; clientRef: string; salesRepId: string | null; customerId: string | null; productName?: string | null; detail?: unknown;
}): Promise<void> {
  try {
    const prior = await db.notification.findFirst({
      where: { tenantId: input.tenantId, type: 'LOT_REPLAY_HELD', data: { contains: input.clientRef } },
      select: { id: true },
    });
    if (prior) return;
    const what = input.productName ? ` من «${input.productName}»` : '';
    await db.notification.create({
      data: {
        tenantId: input.tenantId,
        type: 'LOT_REPLAY_HELD',
        title: 'فاتورة دون اتصال بانتظار تحميل ناقص',
        body: `فاتورة دون اتصال لا يكفيها رصيد السيارة${what} بانتظار تسجيل الإدارة للتحميل الناقص`,
        salesRepId: input.salesRepId,
        customerId: input.customerId,
        data: JSON.stringify({ clientRef: input.clientRef, detail: input.detail ?? null }),
      },
    });
  } catch (e) {
    console.error('lot replay-held notice failed:', input.clientRef, (e as Error)?.message);
  }
}

/** صفّ تشغيلة بندٍ مباع على شاشة القابل للإرجاع */
export interface SaleItemLotView {
  lotId: string | null; lotNumber: string | null; expiryDate: string | null; sold: number; returned: number; returnable: number; certainty: LotCertainty;
}

/**
 * صفوف التوزيع لبنود فاتورة بيع على شاشة القابل للإرجاع (withLots=1، §٤.١٨): لكل بندٍ المباع والمُرجَع والمتاح لكل صفّ —
 * المُرجَع من صفوف مرتجعاتٍ وإشعاراتٍ غير ملغاة ورثته (sourceItemLotId).
 */
export async function saleItemLots(db: LotDb, tid: string, saleItemIds: string[]): Promise<Map<string, SaleItemLotView[]>> {
  const out = new Map<string, SaleItemLotView[]>();
  const ids = uniq(saleItemIds);
  if (!ids.length) return out;
  const rows = await db.invoiceItemLot.findMany({
    where: { tenantId: tid, invoiceItemId: { in: ids } },
    select: { id: true, invoiceItemId: true, lotId: true, quantity: true, certainty: true, expiryDate: true, lot: { select: { lotNumber: true } } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const returned = await returnedBySource(db, tid, rows.map((r) => r.id));
  for (const r of rows) {
    const sold = Number(r.quantity);
    const back = returned.get(r.id) ?? 0;
    const list = out.get(r.invoiceItemId) ?? [];
    list.push({
      lotId: r.lotId ?? null, lotNumber: r.lot?.lotNumber ?? null, expiryDate: isoDay(r.expiryDate),
      sold, returned: back, returnable: Math.max(0, sold - back), certainty: certaintyOf(r.certainty),
    });
    out.set(r.invoiceItemId, list);
  }
  return out;
}

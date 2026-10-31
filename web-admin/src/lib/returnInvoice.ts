/**
 * فاتورة الإرجاع من لوحة الإدارة (طلب المالك: «اضف قائمة تحدد نوع الفاتورة: فاتورة جديدة او فاتورة ارجاع») — منطقٌ نقيّ
 * بلا React ولا شبكة ولا قاموس، يُختبر وحده (returnInvoice.test.ts) وتستدعيه نافذة الفاتورة (InvoiceModal).
 *
 * ثلاثة مسارات على الخادم (POST /invoices، type=RETURN) ولكلٍّ تسعيره — والخطأ فيه يُقيِّد مبلغاً غير الذي رآه المدير:
 *  • **مرتجع حرّ (المرحلة الأولى)**: بلا فاتورة بيع؛ الأسعار والخصومات من الطلب حرفياً كفاتورة البيع (صافية، pricesIncludeTax
 *    غائب = false). يُرسَل كما يرسل البيع بنوده — المحرّك نفسه على الخادم يحسبه.
 *  • **مرتجع من فاتورة بيع (المرحلة الأولى)**: الخادم يتحقّق من الربط (services/returnLinks.ts: البند من الفاتورة، الصنف نفسه،
 *    الكمية ≤ المتاح) **ولا يتحقّق من السعر** — فالسعر من الطلب. والصحيح ما دفعه العميل فعلاً: `refundUnitPrice` (إجمالي بند
 *    البيع ÷ كميته، شامل الضريبة بعد خصمَي البند والفاتورة) مع pricesIncludeTax=true وخصمٍ صفر للبند والفاتورة — كما يفعل
 *    تطبيق المندوب حرفياً. إرسال السعر الصافي الأساسي بلا pricesIncludeTax يُضيف الضريبة مرّةً ثانية على مبلغٍ شاملها.
 *  • **إشعار دائن (المرحلة الثانية، ZATCA)**: الفاتورة الأصلية **إلزامية** (وإلا 422 ZATCA_RETURN_NEEDS_ORIGINAL)، والسبب
 *    ٣–١٠٠٠ حرف إلزامي (noteReason ?? notes، وإلا 422)، والأسعار والضريبة والخصم **من الأصل** والتاريخ «الآن» — فما يرسله
 *    الطلب من سعر يُهمَل (ويبقى unitPrice مطلوباً في المخطط فنرسل سعر الاسترداد نفسه). المعاينة هنا تقديرية لذلك.
 *
 * المعاينة تمرّ بالمحرّك المشترك (rep/invoiceCalc.ts — مرآة backend/src/lib/invoiceCalc.ts) بالمدخلات نفسها التي يحسب بها
 * الخادم، فإجماليّ المرتجع المرتبط المعروض قبل الإصدار هو ما يُقيَّد بعده خانةً بخانة. والورقة المطبوعة بعد الإصدار تُبنى من
 * ردّ الخادم لا من المعاينة (إجماليّ الإشعار الدائن من أسعار الأصل قد يفترق بكسرٍ عن تقديرنا).
 */
import { computeInvoiceTotals, roundDecimal } from '../rep/invoiceCalc';
import type { DocLotLine } from './lots';
import { QTY_EPS, factorOf, fromBase, refundAmount, roundQty, toBase, type UnitDef } from './units';
import { unitChoices, type UnitChoice } from '../rep/repUnits';

export type ReturnReason = 'NORMAL' | 'DAMAGED' | 'EXCHANGE';

/** أسباب الإرجاع كما يقبلها الخادم وعباراتها في القاموس (مشتركة مع تطبيق المندوب) */
export const RETURN_REASONS: readonly (readonly [ReturnReason, string])[] = Object.freeze([
  ['NORMAL', 'مرتجع عادي'],
  ['DAMAGED', 'بضاعة تالفة'],
  ['EXCHANGE', 'استبدال'],
] as const);

/** صفّ من GET /invoices/returnable-sales — فواتير بيع العميل التي بقي فيها ما يُرجَع (أحدث ٣٠٠، بنطاق المستخدم) */
export interface ReturnableSaleRow {
  id: string;
  number: string;
  invoiceDate: string;
  total: number | string;
  type: string;
  itemsCount: number;
  /** مجموع المتاح **بالأساس** عبر أصناف الفاتورة — يخلط وحداتٍ مختلفة فلا يُعرض رقماً إلا لخادمٍ قبل الميزة */
  returnableQty: number;
  /** عدد البنود التي بقي منها ما يُرجَع — العرض الصادق حين تختلط الوحدات */
  returnableLines?: number;
  productIds?: string[];
}

/** بند من GET /invoices/:id/returnable */
export interface ReturnableLineDto {
  saleItemId: string;
  productId: string;
  name: string;
  code?: string;
  unit?: string;
  sold: number;
  returned: number;
  returnable: number;
  refundUnitPrice: number;
  taxPct: number;
  shelfLife?: boolean;
  expiresAt?: string | null;
  expiredToday?: boolean | null;
  /** قيد المرتجع للصنف اليوم: سبب الرفض من الخادم — لا يُرجَع البند (والخادم يقرّر عند الإصدار) */
  returnBlocked?: string | null;
  // ——— الوحدات المتعددة (عقد /returnable في DESIGN.md). اختيارية: خادمٌ قبل الميزة ⇒ وحدة الأساس بمعامل ١ ———
  /** لقطة وحدة بند البيع — null ⇒ وحدة الأساس */
  unitName?: string | null;
  unitFactor?: number | null;
  soldBase?: number | null;
  returnedBase?: number | null;
  returnableBase?: number | null;
  /** ما دفعه العميل في البند فعلاً — مرجع `refundAmount` */
  lineTotal?: number | null;
  refundPerBase?: number | null;
  /** وحدات الصنف (أو في `product.units`) */
  units?: UnitDef[] | null;
  product?: { unit?: string | null; units?: UnitDef[] | null; repReturnUnit?: string | null } | null;
}

/**
 * بند فاتورة البيع في نموذج المرتجع. الكمية **بوحدة المرتجع المختارة** (`ret*`) — قد تكون أصغر من وحدة البيع
 * (حبّةٌ من كرتون)، والمتاح والمقارنة بالأساس (القاعدة ٩). والحقول القديمة (`sold/returned/returnable/
 * refundUnitPrice/unit`) **معاد التعبير عنها بوحدة المرتجع** فيبقى الجدول متّسقاً عموداً بعمود أيّاً كانت الوحدة،
 * ولصنفٍ بلا وحدات هي أرقام الخادم نفسها.
 */
export interface LinkedReturnLine extends ReturnableLineDto {
  /** الكمية المرتجعة التي أدخلها المدير — صفر = لا يُرجَع البند (لا يُرسَل) */
  qty: number;
  /** اسم وحدة الأساس للصنف */
  baseUnit: string;
  saleUnitName: string | null;
  saleUnitFactor: number;
  soldBase: number;
  returnedBase: number;
  returnableBase: number;
  /** null ⇒ خادمٌ لا يرسل إجمالي البند: يُسعَّر بسعر الاسترداد للوحدة كما قبل الميزة */
  lineTotal: number | null;
  /** سعر الاسترداد لوحدة الأساس (بلا تقريب) */
  refundPerBase: number;
  /** سعر الاسترداد لوحدة البيع كما أرسله الخادم — يُعرض حرفياً حين يُرجَع بوحدة البيع نفسها */
  saleRefundUnitPrice: number;
  units: UnitDef[];
  /** «قيود المندوب»: قيد وحدة المرتجع كما أرسله الخادم للمندوب وحده (الإدارة بلا قيد ⇒ غائب) */
  repReturnUnit?: 'ANY' | 'BASE' | 'LARGE';
  /** وحدة المرتجع: null = الأساس */
  retUnitId: string | null;
  retUnitName: string | null;
  retUnitFactor: number;
}

export interface LinkedSale {
  id: string;
  number: string;
  invoiceDate: string;
  lines: LinkedReturnLine[];
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** عتبة الكسور: الكميات تُجمع على الخادم بأعداد عشرية، فبقايا ‎1e-12‎ ليست «متاحاً» */
const EPS = 1e-9;

/** البند يُرجَع منه: بقي منه شيء ولا يمنعه قيد المرتجع للصنف */
export function isLineReturnable(l: Pick<ReturnableLineDto, 'returnable' | 'returnBlocked'>): boolean {
  return num(l.returnable) > EPS && !l.returnBlocked;
}

/**
 * ردّ /:id/returnable ⇒ فاتورة مرتبطة في النموذج. الكمية تبدأ **صفراً** لكل بند (لا «كامل الفاتورة» كتطبيق المندوب):
 * المدير يُدخل مرتجعاً من ورقةٍ أمامه، والخطأ الأخطر هنا إرجاعُ فاتورة كاملة بنقرة واحدة بلا قصد — وزرّ «إرجاع كامل
 * المتاح» يغطّي الحالة الأخرى صراحةً.
 */
export function toLinkedSale(raw: unknown): LinkedSale {
  const r = (raw ?? {}) as { id?: unknown; number?: unknown; invoiceDate?: unknown; lines?: unknown };
  const lines = Array.isArray(r.lines) ? r.lines : [];
  return {
    id: String(r.id ?? ''),
    number: String(r.number ?? ''),
    invoiceDate: String(r.invoiceDate ?? ''),
    lines: lines.map((x) => {
      const l = (x ?? {}) as ReturnableLineDto;
      const saleUnitFactor = factorOf({ unitFactor: l.unitFactor });
      const baseUnit = String(l.product?.unit ?? l.unit ?? '');
      /* خادمٌ قبل الميزة: لا حقول أساس ⇒ تُشتقّ من كميات وحدة البيع (ومعاملها ١ فهي هي). والمتاح لا يقلّ عن صفر */
      const soldBase = l.soldBase != null ? num(l.soldBase) : toBase(num(l.sold), { unitFactor: saleUnitFactor });
      const returnedBase = l.returnedBase != null ? num(l.returnedBase) : toBase(num(l.returned), { unitFactor: saleUnitFactor });
      const returnableBase = Math.max(0, l.returnableBase != null ? num(l.returnableBase) : toBase(num(l.returnable), { unitFactor: saleUnitFactor }));
      const lineTotal = l.lineTotal != null && Number.isFinite(Number(l.lineTotal)) ? Number(l.lineTotal) : null;
      /* سعر الاسترداد: خادمٌ بالوحدات يرسل حصّة الأساس (refundPerBase — والحقل القديم refundUnitPrice عنده بالأساس
       * أيضاً لعميلٍ لا يعرف الوحدات)، وخادمٌ قبلها سعر وحدة البيع وحده (ومعاملها ١ فهما واحد) */
      const perBaseDto = l.refundPerBase != null && Number.isFinite(Number(l.refundPerBase)) ? Math.max(0, Number(l.refundPerBase)) : null;
      const legacyPrice = Math.max(0, num(l.refundUnitPrice));
      const refundPerBase = perBaseDto ?? (lineTotal != null && soldBase > 0 ? lineTotal / soldBase : legacyPrice / saleUnitFactor);
      const saleUnitPrice = perBaseDto != null || lineTotal != null ? roundDecimal(refundPerBase * saleUnitFactor, 4) : legacyPrice;
      const line: LinkedReturnLine = {
        saleItemId: String(l.saleItemId),
        productId: String(l.productId),
        name: String(l.name ?? '-'),
        code: l.code ?? '',
        unit: baseUnit,
        sold: num(l.sold),
        returned: num(l.returned),
        returnable: Math.max(0, num(l.returnable)),
        refundUnitPrice: saleUnitPrice,
        taxPct: num(l.taxPct),
        shelfLife: l.shelfLife === true,
        expiresAt: l.expiresAt ?? null,
        expiredToday: typeof l.expiredToday === 'boolean' ? l.expiredToday : null,
        returnBlocked: l.returnBlocked ? String(l.returnBlocked) : null,
        qty: 0,
        baseUnit,
        saleUnitName: l.unitName ? String(l.unitName) : null,
        saleUnitFactor,
        soldBase, returnedBase, returnableBase, lineTotal, refundPerBase, saleRefundUnitPrice: saleUnitPrice,
        units: (Array.isArray(l.units) ? l.units : Array.isArray(l.product?.units) ? l.product!.units! : []) as UnitDef[],
        ...(l.product?.repReturnUnit === 'BASE' || l.product?.repReturnUnit === 'LARGE' ? { repReturnUnit: l.product.repReturnUnit } : {}),
        retUnitId: null, retUnitName: null, retUnitFactor: 1,
      };
      return expressIn(line, saleUnitChoice(line));
    }),
  };
}

/**
 * وحدات الإرجاع من بند بيع: الأساس ووحدات الصنف النشطة التي **لا تزيد** على وحدة البيع — حبّةٌ أو علبةٌ من كرتون،
 * لا كرتونٌ من حبّات (المتاح نفسه يحرسه الخادم بالأساس، والمنتقي لا يعرض وحدةً أكبر مما بِيع).
 */
export function returnUnitChoices(l: Pick<LinkedReturnLine, 'baseUnit' | 'units' | 'saleUnitFactor' | 'repReturnUnit'>): UnitChoice[] {
  const all = unitChoices({ unit: l.baseUnit, units: l.units }).filter((c) => c.factor <= l.saleUnitFactor + QTY_EPS);
  // «قيود المندوب»: الصغرى وحدها أو الكبرى وحدها — وإن لم يبقَ شيء عُرض الكل والخادم يقول السبب (لا منتقٍ فارغ)
  const rule = l.repReturnUnit;
  const ok = rule === 'BASE' ? all.filter((c) => c.factor <= 1 + QTY_EPS) : rule === 'LARGE' ? all.filter((c) => c.factor > 1 + QTY_EPS) : all;
  return ok.length ? ok : all;
}

/** وحدة البيع نفسها بين وحدات الإرجاع (الاسم والمعامل، ثم المعامل وحده)، وإلّا الأساس — وحدةٌ أُوقفت بعد البيع لا تُعرض */
function saleUnitChoice(l: LinkedReturnLine): UnitChoice {
  const all = returnUnitChoices(l);
  const same = (c: UnitChoice) => Math.abs(c.factor - l.saleUnitFactor) < QTY_EPS;
  return all.find((c) => same(c) && (c.id === null || c.name === l.saleUnitName)) ?? all.find(same) ?? all[0];
}

/**
 * البند بوحدة إرجاعٍ ما: الحقول القديمة تُعاد كتابتها بها من الأساس. ولوحدة البيع نفسها تبقى أرقام الخادم حرفياً
 * (سعر الاسترداد المقرَّب بأربع خانات كما أرسله) — فصنفٌ بلا وحدات يُعرض ويُرسَل كما قبل الميزة.
 */
function expressIn(l: LinkedReturnLine, c: UnitChoice): LinkedReturnLine {
  const f = factorOf({ unitFactor: c.factor });
  const asSold = Math.abs(f - l.saleUnitFactor) < QTY_EPS;
  return {
    ...l,
    retUnitId: c.id, retUnitName: c.id ? c.name : null, retUnitFactor: f,
    unit: c.id ? c.name : l.baseUnit,
    sold: fromBase(l.soldBase, f),
    returned: fromBase(l.returnedBase, f),
    returnable: fromBase(l.returnableBase, f),
    refundUnitPrice: asSold ? l.saleRefundUnitPrice : roundDecimal(l.refundPerBase * f, 4),
  };
}

/** تبديل وحدة المرتجع لبند: الكمية المكتوبة تبقى رقماً وتُقصّ على المتاح بالوحدة الجديدة */
export function withReturnUnit(l: LinkedReturnLine, unitId: string | null): LinkedReturnLine {
  const all = returnUnitChoices(l);
  const next = expressIn(l, all.find((c) => c.id === (unitId ?? null)) ?? all[0]);
  return { ...next, qty: clampReturnQty(l.qty, next) };
}

/**
 * مبلغ استرداد الكمية المكتوبة كما يحسبه الخادم (`refundAmount`: فرق تراكميَّين مقرَّبين من إجمالي البند) —
 * فـ٢٤ حبّةً فرادى = قيمة الكرتون تماماً. null ⇒ خادمٌ لا يرسل إجمالي البند: السعر للوحدة كما قبل الميزة.
 */
export function linkedRefundAmount(
  l: Pick<LinkedReturnLine, 'qty' | 'lineTotal' | 'soldBase' | 'returnedBase' | 'retUnitFactor'>, decimals = 2,
): number | null {
  if (l.lineTotal == null) return null;
  const q = num(l.qty);
  if (q <= 0) return 0;
  /* `refundAmount` تقرّب لمنزلتين؛ فلعملةٍ بثلاث (الدينار) أو بلا كسور يُقاس المبلغ بوحدةٍ تصير بها خاناته منزلتين ثم
   * يُعاد — كما يفعل الخادم (refundInCurrency في routes/invoices.ts) حرفاً، وإلا افترقت المعاينة عن القيد بفلس */
  const scale = Math.pow(10, decimals - 2);
  const scaled = refundAmount({ lineTotal: l.lineTotal * scale, qty: l.soldBase, unitFactor: 1 }, toBase(q, { unitFactor: l.retUnitFactor }), l.returnedBase);
  return roundDecimal(scaled / scale, decimals);
}

/**
 * سعر الوحدة الذي يدخل المحرّك ويُرسَل: المبلغ ÷ الكمية **بلا تقريب** (كـpriceFromLineTotal) فيعيد المحرّك إنتاج
 * المبلغ نفسه بعد تقريبه — والخادم حَكَمٌ يحسب سعر المرتجع المرتبط بنفسه من بند البيع.
 */
export function linkedUnitPrice(l: LinkedReturnLine, decimals = 2): number {
  const amt = linkedRefundAmount(l, decimals);
  return amt != null && num(l.qty) > 0 ? amt / num(l.qty) : num(l.refundUnitPrice);
}

/** أقصى ما يُرجَع بوحدة المرتجع المختارة */
export function maxReturnQty(l: Pick<LinkedReturnLine, 'returnable'>): number {
  return roundQty(num(l.returnable));
}

/**
 * لماذا لا تُربط هذه الفاتورة — عبارة القاموس وتفصيلٌ يُلحق بها (اسم الصنف وسبب القيد)، أو null.
 * (القائمة تصفّي ما لا متاح فيه أصلاً، لكن ما بين عرض القائمة واختيار الفاتورة قد يُرجَع الباقي من شاشةٍ أخرى.)
 */
export function linkedSaleProblem(sale: LinkedSale): { key: string; detail?: string } | null {
  const left = sale.lines.filter((l) => num(l.returnable) > EPS);
  if (left.length === 0) return { key: 'لا يوجد في هذه الفاتورة ما يمكن إرجاعه' };
  if (!left.some((l) => !l.returnBlocked)) {
    const b = left.find((l) => l.returnBlocked);
    return { key: 'قيد الصلاحية يمنع مرتجع أصناف هذه الفاتورة', detail: b ? `${b.name}: ${b.returnBlocked}` : undefined };
  }
  return null;
}

/** كمية المرتجع لبندٍ مرتبط: لا سالب ولا فوق المتاح، والممنوع صفرٌ دائماً (الخادم يردّ ما فوق المتاح 422/409) */
export function clampReturnQty(v: unknown, l: Pick<ReturnableLineDto, 'returnable' | 'returnBlocked'>): number {
  if (!isLineReturnable(l)) return 0;
  const n = num(v);
  if (n <= 0) return 0;
  return Math.min(n, num(l.returnable));
}

/**
 * «إرجاع كامل المتاح» (all=true) أو «تصفير الكميات» (all=false). الكامل بوحدة المرتجع إن انقسم المتاح عليها، وإلّا
 * بالأساس مع وحدة الأساس — لا «١٫٩٥٨ كرتون» بعد إرجاع حبّةٍ منه، ولا وحدتان في سطرٍ واحد.
 */
export function fillLinkedQty(lines: LinkedReturnLine[], all: boolean): LinkedReturnLine[] {
  return lines.map((l) => {
    if (!all || !isLineReturnable(l)) return { ...l, qty: 0 };
    const whole = l.returnableBase / l.retUnitFactor;
    if (l.retUnitFactor === 1 || Math.abs(whole - Math.round(whole)) < QTY_EPS) return { ...l, qty: num(l.returnable) };
    const base = withReturnUnit(l, null);
    return { ...base, qty: num(base.returnable) };
  });
}

/** البنود التي تُرسَل: كميةٌ موجبة فقط (البند المصفَّر «لا يُرجَع» — والخادم يرفض الكمية الصفرية في المخطط) */
export function activeLinkedLines(lines: LinkedReturnLine[]): LinkedReturnLine[] {
  return lines.filter((l) => num(l.qty) > EPS);
}

/**
 * بعد إعادة تحميل بنود الفاتورة (بعد تعارض كمية مع مرتجعٍ متزامن): المتاح الجديد من الخادم، وكمية المدير محفوظةٌ مقصوصةً
 * عليه — لا تُمسح كتابته كلّها لأن بنداً واحداً نقص.
 */
export function mergeRefreshedSale(prev: LinkedSale, fresh: LinkedSale): LinkedSale {
  // والوحدة المختارة محفوظةٌ معها: كميةٌ كُتبت بالحبّة لا تُقرأ كراتين بعد التحديث
  const wanted = new Map(prev.lines.map((l) => [l.saleItemId, l]));
  return {
    ...fresh,
    lines: fresh.lines.map((l) => {
      const w = wanted.get(l.saleItemId);
      return w ? refreshLinkedLine(w, l) : withReturnUnit({ ...l, qty: 0 }, l.retUnitId);
    }),
  };
}

/**
 * بند المرتجع بعد إعادة قراءة بند البيع (`fresh` من /returnable): كمية المستخدم بوحدته إن بقيت بين وحدات الإرجاع
 * **بمعاملها نفسه**، وإلّا (أُوقفت، أو تغيّر معاملها، أو حُذفت) تُحوَّل إلى الأساس بمعاملها القديم — فـ«٣ كرتون» تصير
 * «٧٢ حبة» لا «٣ حبة» صامتةً. ثم تُقصّ على المتاح الجديد بالأساس.
 */
export function refreshLinkedLine(prev: LinkedReturnLine, fresh: LinkedReturnLine): LinkedReturnLine {
  const same = returnUnitChoices(fresh).find((c) => c.id === prev.retUnitId && Math.abs(c.factor - prev.retUnitFactor) < QTY_EPS);
  if (same) return withReturnUnit({ ...fresh, qty: num(prev.qty) }, same.id);
  return withReturnUnit({ ...fresh, qty: toBase(num(prev.qty), { unitFactor: prev.retUnitFactor }) }, null);
}

/** مدخلات المحرّك للمرتجع المرتبط — هي حرفياً ما يقرؤه الخادم من بنود الطلب (انظر رأس الملف) */
function linkedCalcInputs(lines: LinkedReturnLine[], decimals: number) {
  return lines.map((l) => ({ qty: num(l.qty), unitPrice: linkedUnitPrice(l, decimals), discountPct: 0, taxPct: num(l.taxPct) }));
}

export interface LinkedReturnTotals {
  subtotal: number;
  discountAmt: number;
  taxAmt: number;
  total: number;
  /** إجمالي كل بندٍ مُرسَل (شامل الضريبة) بمفتاح بند البيع */
  lineTotals: Record<string, number>;
}

/**
 * معاينة إجماليّ المرتجع المرتبط بالمحرّك المشترك وبخيارات الخادم نفسها: أسعار شاملة، خصم الفاتورة صفر، خانات العملة.
 * `companyVat` لا أثر له هنا (كل بند يحمل ضريبته) ويُمرَّر للتوقيع وحده.
 */
export function linkedReturnTotals(lines: LinkedReturnLine[], decimals: number, companyVat = 15): LinkedReturnTotals {
  const active = activeLinkedLines(lines);
  const calc = computeInvoiceTotals(linkedCalcInputs(active, decimals), {
    companyVat, decimals, invoiceDiscountPct: 0, pricesIncludeTax: true,
  });
  const lineTotals: Record<string, number> = {};
  active.forEach((l, i) => { lineTotals[l.saleItemId] = calc.items[i].lineTotal; });
  return { subtotal: calc.subtotal, discountAmt: calc.discountAmt, taxAmt: calc.taxAmt, total: calc.total, lineTotals };
}

/** بند المرتجع الحرّ — بنود محرّر الأسطر في النافذة كما هي (أسعار صافية) */
export interface FreeReturnLine {
  productId: string;
  qty: number;
  unitPrice: number;
  discountPct: number;
  taxPct: number;
  /** وحدة البند (الوحدات المتعددة) — غائبة ⇒ الأساس. السعر والكمية بها */
  unitId?: string | null;
}

export interface ReturnHead {
  customerId: string;
  salesRepId: string;
  returnReason: ReturnReason;
  notes: string;
  /** فارغ = اليوم. يُهمَل في المرحلة الثانية (الإشعار يُصدَر «الآن» على الخادم) فلا يُرسَل */
  invoiceDate?: string;
  phase2: boolean;
  /** سبب الإشعار الدائن — يُرسَل في المرحلة الثانية وحدها (لا عمود له في مرتجع المرحلة الأولى) */
  noteReason?: string;
}

/**
 * جسم المرتجع المرتبط بفاتورة بيع. لا deliveryDate ولا خطة سداد (المخطط يرفض التقسيط مع المرتجع)، ولا clientCreatedAt
 * (بلا clientRef في المرحلة الثانية = 426)، ولا returnToStock (الخادم يشتقّه من السبب وسياسة الأصناف).
 */
export function buildLinkedReturnPayload(head: ReturnHead, sale: LinkedSale, decimals = 2): Record<string, unknown> {
  return {
    customerId: head.customerId,
    salesRepId: head.salesRepId,
    type: 'RETURN',
    returnReason: head.returnReason,
    originalInvoiceId: sale.id,
    // سعر الاسترداد شاملٌ الضريبة بعد كل خصومات البيع ⇒ لا خصم فوقه، والمحرّك يشتقّ الضريبة من الداخل
    pricesIncludeTax: true,
    discountPct: 0,
    notes: head.notes,
    ...(!head.phase2 && head.invoiceDate && { invoiceDate: head.invoiceDate }),
    ...(head.phase2 && { noteReason: (head.noteReason ?? '').trim() }),
    items: activeLinkedLines(sale.lines).map((l) => ({
      productId: l.productId,
      invoiceItemId: l.saleItemId,
      qty: num(l.qty),
      // وحدة المرتجع (حبّةٌ من كرتون): يحلّها الخادم بمعرّفها ويقارن المتاح بالأساس. وحدة الأساس ⇒ لا حقل (كما قبل الميزة)
      ...(l.retUnitId && { unitId: l.retUnitId }),
      unitPrice: linkedUnitPrice(l, decimals),
      discountPct: 0,
      taxPct: num(l.taxPct),
    })),
  };
}

/** جسم المرتجع الحرّ (المرحلة الأولى) — بنود النافذة كما يُرسل البيع بنوده، بالخصم العام نفسه */
export function buildFreeReturnPayload(head: ReturnHead, lines: FreeReturnLine[], discountPct: number): Record<string, unknown> {
  return {
    customerId: head.customerId,
    salesRepId: head.salesRepId,
    type: 'RETURN',
    returnReason: head.returnReason,
    discountPct,
    notes: head.notes,
    ...(!head.phase2 && head.invoiceDate && { invoiceDate: head.invoiceDate }),
    ...(head.phase2 && { noteReason: (head.noteReason ?? '').trim() }),
    items: lines.map((l) => ({
      productId: l.productId, qty: l.qty, unitPrice: l.unitPrice, discountPct: l.discountPct, taxPct: l.taxPct,
      // بلا وحدة يدخل المرتجع السيارة بالأساس: «٢» كرتونان تصير حبّتين
      ...(l.unitId && { unitId: l.unitId }),
    })),
  };
}

export const NOTE_REASON_MIN = 3;
export const NOTE_REASON_MAX = 1000;

/**
 * ما يمنع إصدار المرتجع قبل إرساله — عبارة القاموس أو null. (العميل والمندوب يفحصهما المستدعي بعباراتهما القائمة.)
 * كل شرطٍ هنا مرآةُ رفضٍ على الخادم، يُقال بلغة المدير قبل أن يصله 422 بلغة المحاسبة.
 */
export function returnFormProblem(input: {
  phase2: boolean;
  linked: LinkedSale | null;
  freeLines: Pick<FreeReturnLine, 'qty'>[];
  noteReason: string;
  invoiceDate: string;
}): string | null {
  const { phase2, linked } = input;
  // ZATCA_RETURN_NEEDS_ORIGINAL: لا مرتجع حرّ بعد الربط — الإشعار الدائن يشير إلى فاتورته
  if (phase2 && !linked) return 'اختر فاتورة البيع الأصلية — المرتجع في المرحلة الثانية إشعار دائن مرتبط بها';
  if (linked) {
    if (activeLinkedLines(linked.lines).length === 0) return 'أدخل كمية مرتجعة لصنف واحد على الأقل';
    // مرتجعٌ مؤرَّخ قبل بيعه يُقيَّد في فترةٍ لم يكن فيها البيع أصلاً
    if (!phase2 && input.invoiceDate && linked.invoiceDate && input.invoiceDate < linked.invoiceDate.slice(0, 10)) {
      return 'تاريخ المرتجع قبل تاريخ فاتورة البيع';
    }
  } else {
    if (input.freeLines.length === 0) return 'أضف صنفا على الأقل';
    if (input.freeLines.some((l) => !(num(l.qty) > 0))) return 'الكمية يجب أن تكون أكبر من صفر';
  }
  if (phase2) {
    const len = input.noteReason.trim().length;
    if (len < NOTE_REASON_MIN || len > NOTE_REASON_MAX) return 'سبب الإشعار الدائن مطلوب من 3 إلى 1000 حرف';
  }
  return null;
}

/**
 * رموز تعني «المتاح تغيّر منذ عرضته الشاشة» (مرتجعٌ آخر سبق هذا): تُعاد قراءة بنود الفاتورة فيرى المدير المتاح الجديد.
 * RETURN_LINK_INVALID يأتي 422 قبل المعاملة و409 تحت القفل — كلاهما يستحقّ التحديث.
 */
const STALE_QTY_CODES = new Set(['RETURN_LINK_INVALID', 'ZATCA_CREDIT_QTY_EXCEEDED', 'ZATCA_NOTHING_TO_CREDIT']);

/** عبارة احتياطية حين يصل الرمز بلا رسالة (وسيطٌ ابتلع الجسم) — الخادم يرسل رسالته العربية عادةً وهي الأدقّ */
const CODE_FALLBACK: Record<string, string> = {
  ZATCA_RETURN_NEEDS_ORIGINAL: 'اختر فاتورة البيع الأصلية — المرتجع في المرحلة الثانية إشعار دائن مرتبط بها',
  ZATCA_CREDIT_QTY_EXCEEDED: 'الكمية المرتجعة أكبر من المتاح للإرجاع',
  ZATCA_NOTHING_TO_CREDIT: 'لا يوجد في هذه الفاتورة ما يمكن إرجاعه',
  RETURN_LINK_INVALID: 'الكمية المرتجعة أكبر من المتاح للإرجاع',
};

export interface ReturnIssueError {
  /** نصّ يُمرَّر إلى tr() — رسالة الخادم (قد تكون في القاموس) أو عبارة احتياطية */
  message: string;
  code: string | null;
  /** المتاح تغيّر: أعد تحميل بنود الفاتورة المرتبطة */
  refreshLines: boolean;
}

/**
 * خطأ إصدار المرتجع ⇒ رسالة مقروءة. رسالة الخادم أوّلاً (عربية ومحدّدة: «الكمية المرتجعة أكبر من المتبقي في فاتورة البيع
 * (2)»)، وبنود ZATCA_NOTE_LINES_INVALID تُلحق أسبابها (`issues`) فلا يرى المدير «بنود الإشعار غير صحيحة» بلا أيّ بند.
 */
export function returnIssueError(err: unknown): ReturnIssueError {
  const data = (err as { response?: { data?: unknown } } | null)?.response?.data as
    { code?: unknown; message?: unknown; issues?: unknown } | undefined;
  const code = typeof data?.code === 'string' ? data.code : null;
  let message = typeof data?.message === 'string' && data.message.trim() ? data.message.trim() : '';
  if (Array.isArray(data?.issues)) {
    const extra = [...new Set(data!.issues
      .map((i) => (i as { messageAr?: unknown; severity?: unknown } | null))
      .filter((i) => i && i.severity !== 'warning' && typeof i.messageAr === 'string' && i.messageAr)
      .map((i) => String(i!.messageAr)))]
      .filter((m) => !message.includes(m))
      .slice(0, 3);
    if (extra.length) message = message ? `${message}: ${extra.join('، ')}` : extra.join('، ');
  }
  if (!message) message = (code && CODE_FALLBACK[code]) || 'تعذر إصدار المستند حاول مجددا';
  return { message, code, refreshLines: !!code && STALE_QTY_CODES.has(code) };
}

/** مصدر اسم البند ووحدته وصلاحيته لورقة المرتجع — بنود الردّ تحمل productId بلا اسم */
export interface DocLineSource {
  productId: string;
  name: string;
  unit?: string;
  /** وحدة الأساس للصنف — لبند ردٍّ بوحدة الأساس حين يكون `unit` وحدةَ بيعٍ أكبر */
  baseUnit?: string;
  saleItemId?: string | null;
  shelfLife?: boolean;
  expiresAt?: string | null;
  expiredToday?: boolean | null;
}

/** بند ورقة المرتجع — مطابق بنيوياً لـ InvoiceDoc['items'][number] (rep/RepDocuments.tsx) */
export interface ReturnDocItem {
  name: string;
  unit?: string;
  /** معامل وحدة البند (≠١ ⇒ الوحدة تُطبع ولو أخفاها القالب) */
  unitFactor?: number;
  qty: number;
  unitPrice: number;
  discountPct: number;
  taxPct: number;
  lineTotal: number;
  returnExpired?: boolean | null;
  expiresAt?: string | null;
  /** «تتبّع اللوط»: تشغيلات البند من ردّ الخادم (withDocLots) */
  lots?: DocLotLine[];
}

/**
 * بنود الورقة من **ردّ الخادم** لا من المعاينة: الإشعار الدائن يُسعَّر من الأصل، والمرتجع المرتبط يحمل صلاحيته المقيسة
 * على بيعه (returnExpired/expiresAt) — فالورقة تطابق السجلّ. الاسم من بند البيع (returnOfItemId في المرحلة الأولى،
 * creditedItemId في الثانية) ثم من الصنف.
 */
export function returnDocItems(items: unknown, sources: DocLineSource[]): ReturnDocItem[] {
  if (!Array.isArray(items)) return [];
  return items.map((x) => {
    const it = (x ?? {}) as Record<string, unknown>;
    const saleItemId = (it.returnOfItemId ?? it.creditedItemId ?? null) as string | null;
    const productId = String(it.productId ?? '');
    const src = (saleItemId ? sources.find((s) => s.saleItemId === saleItemId) : undefined)
      ?? sources.find((s) => s.productId === productId);
    /* الوحدة من لقطة بند الردّ أولاً: «٥ (كرتون)» على مرتجع ٥ حبّات خطأٌ ٢٤ ضعفاً على ورقةٍ بيد العميل.
     * وبندٌ بوحدة الأساس (بلا اسم، معامل ١) يأخذ اسم الأساس، ثم ما عرفه المصدر (ردٌّ من خادمٍ قبل الميزة) */
    const snapName = typeof it.unitName === 'string' && it.unitName.trim() ? it.unitName.trim() : null;
    const atBase = !snapName && it.unitFactor != null && factorOf({ unitFactor: Number(it.unitFactor) }) === 1;
    const out: ReturnDocItem = {
      name: src?.name ?? '-',
      unit: snapName ?? (atBase ? src?.baseUnit ?? src?.unit : src?.unit),
      ...(it.unitFactor != null && factorOf({ unitFactor: Number(it.unitFactor) }) !== 1 && { unitFactor: factorOf({ unitFactor: Number(it.unitFactor) }) }),
      qty: num(it.qty),
      unitPrice: num(it.unitPrice),
      discountPct: num(it.discountPct),
      taxPct: num(it.taxPct),
      lineTotal: num(it.lineTotal),
    };
    if (typeof it.returnExpired === 'boolean' && it.expiresAt) {
      out.returnExpired = it.returnExpired;
      out.expiresAt = String(it.expiresAt);
    } else if (src?.shelfLife && src.expiresAt) {
      out.returnExpired = src.expiredToday ?? null;
      out.expiresAt = src.expiresAt;
    }
    return out;
  });
}

/** كل عبارةٍ تُنتجها هذه الوحدة وتمرّ إلى tr() بمتغيّر (فلا يراها فحص القاموس الحرفي) — يحرسها returnInvoice.test.ts */
export const RETURN_INVOICE_PHRASES: readonly string[] = Object.freeze([
  ...RETURN_REASONS.map(([, p]) => p),
  'لا يوجد في هذه الفاتورة ما يمكن إرجاعه',
  'قيد الصلاحية يمنع مرتجع أصناف هذه الفاتورة',
  'اختر فاتورة البيع الأصلية — المرتجع في المرحلة الثانية إشعار دائن مرتبط بها',
  'أدخل كمية مرتجعة لصنف واحد على الأقل',
  'تاريخ المرتجع قبل تاريخ فاتورة البيع',
  'أضف صنفا على الأقل',
  'الكمية يجب أن تكون أكبر من صفر',
  'سبب الإشعار الدائن مطلوب من 3 إلى 1000 حرف',
  'الكمية المرتجعة أكبر من المتاح للإرجاع',
  'تعذر إصدار المستند حاول مجددا',
]);

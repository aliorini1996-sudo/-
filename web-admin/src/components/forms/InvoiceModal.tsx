import { useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { invoiceApi, customerApi, productApi, salesRepApi, companyApi, lotsApi } from '../../api/client';
import { Customer, Product, SalesRep } from '../../types';
import { formatCurrency, formatDate, formatDayOnly, getActiveCurrency } from '../../utils/format';
import { currencyDecimals } from '../../i18n/countries';
import { useTr } from '../../i18n/strings';
import { computeInvoiceTotals, priceFromLineTotal } from '../../rep/invoiceCalc';
import { previewInstallments, defaultFirstDue, MAX_INSTALLMENTS, type InstallmentPeriod } from '../../lib/installments';
import DecimalInput from '../DecimalInput';
import { InvoiceDoc, Company } from '../../rep/RepDocuments';
import { zatcaDocView } from '../../lib/zatca/docStatus';
import { zatcaIssueOutcome } from '../../lib/zatca/issueOutcome';
import { zatcaRegimeOf } from '../../lib/zatcaRegime';
import {
  RETURN_REASONS, type ReturnReason, type ReturnableSaleRow, type LinkedSale, type ReturnHead,
  toLinkedSale, linkedSaleProblem, clampReturnQty, fillLinkedQty, isLineReturnable, linkedReturnTotals,
  mergeRefreshedSale, buildLinkedReturnPayload, buildFreeReturnPayload, returnFormProblem, returnIssueError, returnDocItems,
  NOTE_REASON_MAX, returnUnitChoices, withReturnUnit, maxReturnQty,
} from '../../lib/returnInvoice';
import { choiceById, choiceNet, defaultChoice, hasUnitChoice, invoiceItemUnit, unitChoices, type UnitChoice } from '../../rep/repUnits';
import { baseQtyText, lineKey, unitTaken } from '../../lib/adminUnits';
import type { UnitDef } from '../../lib/units';
import {
  LOT_CERTAINTY_LABELS, LOT_STATUS_LABELS, LOT_WARNING_LABELS, lotErrorOf, lotFlagsOf, lotWarningsOf, type ProductLotDto,
} from '../../lib/lots';
import { lotErrorText, returnableLotsOf, saleLineLots, withDocLots, withFreeReturnLots, type SaleLotRow } from '../../lib/invoiceLots';
import { X, Trash2, Plus, Undo2 } from 'lucide-react';
import toast from 'react-hot-toast';
import SearchableSelect from '../SearchableSelect';

/**
 * بند الفاتورة في المحرّر. الوحدات المتعددة: `unit` اسم وحدة البند كما يُطبع، والكمية والسعر بها؛ و`unitId` وحدتها
 * (null = الأساس بمعامل ١) يحلّها الخادم بمعرّفها. والصنف نفسه بوحدتين بندان (المفتاح صنفٌ ووحدة) — «+١» على كرتونٍ
 * لا تُضاف إلى بند حبّات.
 */
interface LineItem {
  productId: string;
  productName: string;
  productCode: string;
  unit: string;
  unitId: string | null;
  unitFactor: number;
  /** وحدة أساس الصنف لحظة الإضافة — تُرسل مع البند فيكشف الخادم قائمةً قديمة («حدّث قائمة الأصناف») */
  baseUnit: string;
  /** وحدات الصنف — لعرض المنتقي، ولطباعة الوحدة ولو أخفاها القالب */
  units: UnitDef[];
  qty: number;
  unitPrice: number;
  discountPct: number;
  taxPct: number;
  lineTotal: number;
}

/** وحدة البند من اختيارٍ من وحدات الصنف */
const lineUnitFields = (p: Product, c: UnitChoice) => ({
  unit: c.name, unitId: c.id, unitFactor: c.id ? c.factor : 1, baseUnit: String(p.unit ?? ''), units: (p.units ?? []) as UnitDef[],
});

interface Props { onClose: () => void; onSaved: (doc: InvoiceDoc) => void; }

/** صافي البند — من المحرّك المشترك لا بصيغة ثانية تفترق عنه يوماً ما */
function calcLine(qty: number, price: number, discPct: number, taxPct: number) {
  return computeInvoiceTotals(
    [{ qty, unitPrice: price, discountPct: discPct, taxPct }],
    { companyVat: taxPct, decimals: 2, invoiceDiscountPct: 0 },
  ).items[0].lineTotal;
}

/**
 * «تتبّع اللوط» — تشغيلة سطر المرتجع الحرّ من الإدارة (D5): صريحةٌ اختيارية للسطر كله، والفارغ «غير معروف» (لا يُرسل شيء).
 * الموقوفة مقبولة وتدخل معزولة (LOT_INTO_BLOCKED). القائمة بصلاحية مخزون السيارات: تعذّرها يُبقي «غير معروف» وحده.
 */
function FreeReturnLotPicker({ productId, value, onChange, disabled, lotOn }: {
  productId: string; value: string; onChange: (lotId: string) => void; disabled?: boolean; lotOn: boolean;
}) {
  const tr = useTr();
  const { data: lots, isFetching } = useQuery({
    queryKey: ['lots-of-product', productId],
    enabled: lotOn && !!productId,
    staleTime: 60_000,
    queryFn: async () => (await lotsApi.list({ productId, limit: 200 })).data.data as ProductLotDto[],
  });
  const picked = (lots ?? []).find(l => l.id === value);
  return (
    <div className="mt-1">
      <select className="input py-1 text-xs w-auto max-w-[14rem]" value={value} disabled={disabled} aria-label={tr('تشغيلة الصنف المرتجع')}
        title={tr('تشغيلة الصنف المرتجع')} onChange={e => onChange(e.target.value)}>
        <option value="">{tr('التشغيلة')}: {tr('غير معروف')}</option>
        {(lots ?? []).map(l => (
          <option key={l.id} value={l.id}>
            {l.lotNumber}{l.expiryDate ? ` · ${formatDayOnly(l.expiryDate)}` : ''}{l.status === 'BLOCKED' ? ` · ${tr(LOT_STATUS_LABELS.BLOCKED)}` : ''}
          </option>
        ))}
      </select>
      {isFetching && !lots && <span className="ms-1 text-[10px] text-gray-400">{tr('جاري التحميل')}</span>}
      {picked?.status === 'BLOCKED' && <p className="text-[10px] text-amber-700 mt-0.5">{tr('تدخل الكمية تشغيلة موقوفة فتبقى معزولة لا تباع')}</p>}
    </div>
  );
}

export default function InvoiceModal({ onClose, onSaved }: Props) {
  const tr = useTr();
  const [customerId, setCustomerId] = useState('');
  const [type, setType] = useState<'CASH' | 'CREDIT'>('CREDIT');
  // «تقسيط» خطة سداد فوق البيع الآجل — لا نوع فاتورة ثالث في المحاسبة
  const [plan, setPlan] = useState<'IMMEDIATE' | 'INSTALLMENT'>('IMMEDIATE');
  const [insCount, setInsCount] = useState(3);
  const [insFirst, setInsFirst] = useState(defaultFirstDue());
  const [insPeriod, setInsPeriod] = useState<InstallmentPeriod>('MONTHLY');
  const [discountPct, setDiscountPct] = useState(0);
  const [notes, setNotes] = useState('');
  const [deliveryDate, setDeliveryDate] = useState(''); // تاريخ التسليم الاختياري — لا يظهر بالفاتورة إن تُرك فارغاً
  const [lines, setLines] = useState<LineItem[]>([]);
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [salesRepId, setSalesRepId] = useState('');
  const [invoiceDate, setInvoiceDate] = useState(''); // فارغ = اليوم؛ يسمح بإصدار قديم
  /* نوع المستند (طلب المالك): «فاتورة بيع» كما كانت حرفاً بحرف، أو «فاتورة إرجاع» تُرسل type=RETURN. حالة البيع (النوع
   * والتقسيط وبنوده) تبقى محفوظةً مخفيّةً أثناء المرتجع، فالعودة إلى البيع تعيدها كما تُركت؛ وربط فاتورة البيع يُفكّ. */
  const [docKind, setDocKind] = useState<'SALE' | 'RETURN'>('SALE');
  const isReturn = docKind === 'RETURN';
  const [returnReason, setReturnReason] = useState<ReturnReason>('NORMAL');
  // سبب الإشعار الدائن — إلزاميّ في المرحلة الثانية وحدها (٣–١٠٠٠ حرف، وإلا ردّه الخادم 422)
  const [noteReason, setNoteReason] = useState('');
  /* فاتورة البيع الأصلية وبنودها بكمياتها المرتجعة (lib/returnInvoice.ts). وجودها يستبدل محرّر الأسطر بجدول بنودها:
   * لا صنف من خارجها ولا سعر غير سعر استردادها (الخادم يرفض بنداً بلا invoiceItemId منها). */
  const [linked, setLinked] = useState<LinkedSale | null>(null);
  const [loadingSaleId, setLoadingSaleId] = useState<string | null>(null);
  // كل اختيار/فكّ/تغيير عميل يزيد العدّاد: ردٌّ وصل متأخراً عن فاتورةٍ تُركت لا يكتب فوق ما اختير بعده
  const pickSeq = useRef(0);
  const qc = useQueryClient();

  const { data: salesReps } = useQuery({
    queryKey: ['sales-reps-all'],
    queryFn: async () => {
      const res = await salesRepApi.list({ limit: 100 });
      return (res.data.data as SalesRep[]).filter(r => r.isActive);
    },
  });

  const { data: company } = useQuery({
    queryKey: ['company'],
    queryFn: async () => { const res = await companyApi.get(); return res.data.data as Company; },
  });

  // نجلب القائمة كاملة لتعمل القائمة المنسدلة بالتصفية المحلية بالكتابة
  const { data: customers } = useQuery({
    queryKey: ['customers-all'],
    queryFn: async () => {
      const res = await customerApi.list({ limit: 1000 });
      return res.data.data as Customer[];
    },
  });

  const { data: products } = useQuery({
    queryKey: ['products-all'],
    queryFn: async () => {
      const res = await productApi.list({ status: 'ACTIVE', limit: 1000 });
      return res.data.data as Product[];
    },
  });

  /* ZATCA المرحلة الثانية: المرتجع إشعارٌ دائن على فاتورته الأصلية — لا مرتجع حرّ، والسبب إلزاميّ، والتاريخ «الآن».
   * القرار من صفّ الشركة كما في صفحة الفواتير (zatcaRegimeOf). شركة «بروفة» يراها الويب مرحلةً أولى ويحسمها الخادم بـ422
   * مقروءة — والخادم هو الحَكَم في الحالين. */
  const phase2 = zatcaRegimeOf(company).phase === 2;

  /* «تتبّع اللوط» (ميزةٌ يفعّلها المالك): مطفأةً لا جلب ولا عمود ولا حقل (§١٠.١). مفعّلةً: لوطات بنود البيع على المرتجع
   * المرتبط (للعرض — الخادم يوزّعه بنفسه)، وتشغيلةٌ صريحة اختيارية لسطر المرتجع الحرّ (D5)، والورقة من ردّ الخادم */
  const lotOn = lotFlagsOf(company).on;
  const [saleLots, setSaleLots] = useState<Map<string, SaleLotRow[]>>(() => new Map());
  // تشغيلة كل سطر مرتجعٍ حرّ بمفتاح السطر (الصنف ووحدته) — الفارغ «غير معروف»
  const [freeLots, setFreeLots] = useState<Record<string, string>>({});
  const trackedIds = new Set(lotOn ? (products || []).filter(p => p.lotTracked === true).map(p => p.id) : []);

  // فواتير بيع العميل التي بقي فيها ما يُرجَع — طازجة دائماً (staleTime 0): المتاح يتغيّر بكل مرتجع
  const { data: returnableSales, isFetching: loadingSales, isError: salesFailed } = useQuery({
    queryKey: ['returnable-sales', customerId],
    enabled: isReturn && !!customerId,
    staleTime: 0,
    queryFn: async () => (await invoiceApi.returnableSales(customerId)).data.data as ReturnableSaleRow[],
  });

  const unlinkSale = () => { pickSeq.current++; setLinked(null); setLoadingSaleId(null); setSaleLots(new Map()); };

  /** بنود فاتورة البيع المختارة (والمندوب منها إن لم يُختر بعد: المرتجع يدخل سيارة المندوب المحدَّد هنا) */
  const pickSale = async (saleId: string) => {
    if (!saleId) { unlinkSale(); return; }
    const seq = ++pickSeq.current;
    setLoadingSaleId(saleId);
    try {
      const [r, detail] = await Promise.all([
        invoiceApi.returnable(saleId, { withLots: lotOn }),
        salesRepId ? Promise.resolve(null) : invoiceApi.get(saleId).catch(() => null),
      ]);
      if (seq !== pickSeq.current) return;
      const sale = toLinkedSale(r.data.data);
      const problem = linkedSaleProblem(sale);
      if (problem) { toast.error(tr(problem.key) + (problem.detail ? ` — ${problem.detail}` : '')); return; }
      setLinked(sale);
      setSaleLots(returnableLotsOf(r.data.data));
      const saleRep = (detail?.data?.data as { salesRepId?: string } | undefined)?.salesRepId;
      if (saleRep && salesReps?.some(x => x.id === saleRep)) setSalesRepId(prev => prev || saleRep);
    } catch (err) {
      if (seq === pickSeq.current) {
        const m = (err as { response?: { data?: { message?: string } } })?.response?.data?.message;
        toast.error(m ? tr(m) : tr('تعذر تحميل بنود الفاتورة'));
      }
    } finally {
      if (seq === pickSeq.current) setLoadingSaleId(null);
    }
  };

  /** المتاح تغيّر على الخادم (مرتجعٌ آخر سبق): بنود الفاتورة من جديد وكميات المدير مقصوصةً على المتاح الجديد */
  const refreshLinked = async (sale: LinkedSale) => {
    const seq = pickSeq.current;
    try {
      const r = await invoiceApi.returnable(sale.id, { withLots: lotOn });
      if (seq !== pickSeq.current) return;
      setLinked(prev => (prev && prev.id === sale.id ? mergeRefreshedSale(prev, toLinkedSale(r.data.data)) : prev));
      setSaleLots(returnableLotsOf(r.data.data));
    } catch { /* الرسالة قيلت؛ يبقى الجدول كما هو والخادم يحرس عند الإعادة */ }
    qc.invalidateQueries({ queryKey: ['returnable-sales'] });
  };

  const changeKind = (k: 'SALE' | 'RETURN') => { setDocKind(k); unlinkSale(); };
  const setLinkedQty = (saleItemId: string, v: number) =>
    setLinked(s => s && { ...s, lines: s.lines.map(l => (l.saleItemId === saleItemId ? { ...l, qty: clampReturnQty(v, l) } : l)) });

  const mutation = useMutation({
    mutationFn: (data: unknown) => invoiceApi.create(data),
    onSuccess: (res, vars) => {
      const inv = res.data.data;
      const repName = salesReps?.find(r => r.id === salesRepId)?.name || '';
      // «تتبّع اللوط»: تحذيرات التوزيع لا تمنع (من رصيدٍ غير مسمّى، وحدةٌ مقسومة، إلى تشغيلةٍ موقوفة) — تُقال مرّة
      const lotWarns = [...new Set(lotWarningsOf(res.data?.warnings).map(w => tr(LOT_WARNING_LABELS[w.code])))];
      if (lotWarns.length) toast(lotWarns.join(' · '), { duration: 8000 });
      /* فاتورة الإرجاع: النوع من جسم الطلب نفسه (لا من حالة النافذة وقت الردّ). والورقة من **ردّ الخادم** — الإشعار الدائن
       * يُسعَّر من الأصل والمرتبط يحمل صلاحيته المقيسة — فتطابق السجلّ لا المعاينة. */
      if ((vars as { type?: string } | undefined)?.type === 'RETURN') {
        qc.invalidateQueries({ queryKey: ['returnable-sales'] });
        qc.invalidateQueries({ queryKey: ['van-summary'] });
        qc.invalidateQueries({ queryKey: ['van-current'] });
        /* المرحلة الثانية: إشعار دائن على فاتورة قياسية ينتظر اعتماد الهيئة (202) — أُنشئ فعلاً ولا ورقة له حتى يُعتمد
         * (zatcaIssueOutcome ⇒ halt). تُغلق النافذة (إعادة الضغط تُصدر إشعاراً ثانياً) وتُحدَّث القائمة كما بعد البيع. */
        if (res.status !== 201) {
          const out = zatcaIssueOutcome(res, tr('صدر الإشعار الدائن وبانتظار اعتماد الهيئة ولا ورقة له حتى الاعتماد'));
          toast(tr(out.kind === 'issued' ? 'تم إنشاء المرتجع' : out.message), { duration: 8000 });
          qc.invalidateQueries({ queryKey: ['invoices'] });
          onClose();
          return;
        }
        // الاسم من بند البيع ثم من محرّر الأسطر ثم من قائمة الأصناف (بنود الردّ تحمل productId بلا اسم)
        // ومعها وحدة الأساس: بند ردٍّ بالأساس (بلا لقطة اسم) يُطبع باسم الأساس لا بوحدة بيعٍ أكبر (returnDocItems)
        const sources = [
          ...(linked?.lines ?? []).map(l => ({ productId: l.productId, name: l.name, unit: l.unit, baseUnit: l.baseUnit, saleItemId: l.saleItemId, shelfLife: l.shelfLife, expiresAt: l.expiresAt, expiredToday: l.expiredToday })),
          ...lines.map(l => ({ productId: l.productId, name: l.productName, unit: l.unit, baseUnit: l.baseUnit })),
          ...(products || []).map(p => ({ productId: p.id, name: p.name, unit: p.unit, baseUnit: p.unit })),
        ];
        const retDoc: InvoiceDoc = {
          // InvoiceDoc.type بلا RETURN: المرتجع «آجل» بعلم isReturn كما تبنيه invoiceDocFromDetail
          kind: 'invoice', number: inv.number, date: inv.invoiceDate, type: 'CREDIT', isReturn: true,
          company: company ?? null, customer: selectedCustomer as Customer, repName,
          // «تتبّع اللوط»: تشغيلات كل بند من ردّ الخادم (المرتبط وراثةً من البيع، والحرّ بما اختير أو «غير معروف»)
          items: withDocLots(returnDocItems(inv.items, sources), inv.items),
          pricesIncludeTax: inv.pricesIncludeTax === true,
          subtotal: Number(inv.subtotal), discount: Number(inv.discountAmt), tax: Number(inv.taxAmt), total: Number(inv.total),
          paidAmt: Number(inv.paidAmt ?? 0), remainingAmt: Number(inv.remainingAmt ?? 0),
          zatca: zatcaDocView(inv),
        };
        toast.success(tr('تم إنشاء المرتجع'));
        onSaved(retDoc);
        return;
      }
      // «تتبّع اللوط»: تشغيلات كل سطر كما وزّعها الخادم (بنود الردّ بالصنف والمعامل) — والصنف غير المتتبَّع بلا شيء
      const soldLots = saleLineLots(lines, inv.items);
      const doc: InvoiceDoc = {
        kind: 'invoice', number: inv.number, date: inv.invoiceDate, type, isReturn: false,
        company: company ?? null, customer: selectedCustomer as Customer, repName,
        // لقطة وحدة البند كما أُرسلت (الخادم يرفض ما يخالفها) — فورقة الحفظ تطابق ورقة إعادة الفتح (invoiceDocFromDetail)
        items: lines.map((l, i) => ({
          name: l.productName, unit: l.unit, unitFactor: l.unitFactor, multiUnit: l.units.length > 0,
          qty: l.qty, unitPrice: l.unitPrice, discountPct: l.discountPct, taxPct: l.taxPct, lineTotal: l.lineTotal,
          ...(soldLots[i] && { lots: soldLots[i] }),
        })),
        deliveryDate: deliveryDate || undefined,
        subtotal, discount: totalDiscount, tax: taxTotal, total,
        paidAmt: Number(inv.paidAmt), remainingAmt: Number(inv.remainingAmt),
        /* فوترة ZATCA المرحلة الثانية (Z5.6b، نقد الخطة 6): مستند ما بعد الحفظ يُبنى هنا لا من
         * `invoiceDocFromDetail` — وبدونه تطبع اللوحة رمز المرحلة الأولى لفاتورة مختومة. */
        zatca: zatcaDocView(inv),
      };
      toast.success(tr('تم إنشاء الفاتورة'));
      onSaved(doc);
    },
    onError: (err: unknown, vars) => {
      /* «تتبّع اللوط»: الأصناف المتتبَّعة لا تُباع فوق متاح تشغيلات السيارة (منعٌ دائم، R3) — رسالة النقص من تفاصيل الخادم
       * بالاسم والكمية والمتاح بوحدات الصنف؛ والانشغال «أعد المحاولة» */
      const le = lotErrorOf(err);
      if (le) {
        const prod = (id: string | null) => (id ? (products || []).find(p => p.id === id) : undefined);
        toast.error(lotErrorText(le, tr, {
          nameOf: id => prod(id)?.name,
          qtyText: (id, n) => baseQtyText(n, prod(id) ?? null, x => String(Number(x.toFixed(3))), { withUnit: true }),
        }), { duration: 8000 });
        return;
      }
      // المرتجع: رسالة الخادم بأسباب بنوده، وتعارض المتاح (مرتجعٌ آخر سبق) يعيد قراءة بنود الفاتورة فيرى المدير الجديد
      if ((vars as { type?: string } | undefined)?.type === 'RETURN') {
        const e = returnIssueError(err);
        toast.error(tr(e.message), { duration: 7000 });
        if (e.refreshLines && linked) void refreshLinked(linked);
        return;
      }
      const data = (err as { response?: { data?: { message?: string; code?: string } } })?.response?.data;
      // 400 UNIT_INVALID: وحدات صنفٍ تغيّرت منذ حُمّلت القائمة (أُوقفت أو حُوّل أساسه) — تُحدَّث القائمة، والمدير يراجع البند
      if (data?.code === 'UNIT_INVALID') qc.invalidateQueries({ queryKey: ['products-all'] });
      toast.error(data?.message || tr('خطأ'));
    },
  });

  /* الوحدة الافتراضية = الأكبر (repUnits.defaultChoice): بعد تحويل الصنف إلى الحبّة يبقى «+صنف» كرتوناً كما كان قبله.
   * والسعر سعر الوحدة (المحدَّد لها، وإلا الأساس × المعامل) — صافٍ قبل الضريبة كسعر الأساس في هذا المحرّر */
  const addProduct = (p: Product) => {
    const c = defaultChoice(p);
    const existing = lines.find(l => l.productId === p.id && (l.unitId ?? null) === c.id);
    if (existing) {
      setLines(ls => ls.map(l => lineKey(l) === lineKey(existing)
        ? { ...l, qty: l.qty + 1, lineTotal: calcLine(l.qty + 1, l.unitPrice, l.discountPct, l.taxPct) }
        : l
      ));
    } else {
      const price = choiceNet(c, p.basePrice);
      setLines(ls => [...ls, {
        productId: p.id, productName: p.name, productCode: p.code,
        ...lineUnitFields(p, c), qty: 1, unitPrice: price,
        discountPct: 0, taxPct: Number(p.taxPct),
        lineTotal: calcLine(1, price, 0, Number(p.taxPct)),
      }]);
    }
  };

  /** تبديل وحدة البند: الكمية رقمها كما هو والسعر سعر الوحدة الجديدة — وحدةٌ أخذها بندٌ آخر للصنف معطّلةٌ في المنتقي */
  const setLineUnit = (idx: number, unitId: string | null) => {
    const l = lines[idx];
    const p = (products || []).find(x => x.id === l?.productId);
    const c = p ? choiceById(p, unitId) : null;
    if (!l || !p || !c || unitTaken(lines, l.productId, c.id, lineKey(l))) return;
    const price = choiceNet(c, p.basePrice);
    setLines(ls => ls.map((x, i) => (i !== idx ? x : {
      ...x, ...lineUnitFields(p, c), unitPrice: price, lineTotal: calcLine(x.qty, price, x.discountPct, x.taxPct),
    })));
  };

  /** وحدة المرتجع لبندٍ من فاتورة البيع (حبّةٌ من كرتون): المتاح وسعر الاسترداد يُعاد التعبير عنهما بها */
  const setLinkedUnit = (saleItemId: string, unitId: string | null) =>
    setLinked(s => s && { ...s, lines: s.lines.map(l => (l.saleItemId === saleItemId ? withReturnUnit(l, unitId) : l)) });

  const updateLine = (idx: number, field: keyof LineItem, value: number) => {
    // المرتجع الحرّ: لا كمية سالبة (مرتجعٌ سالب بيعٌ مقنَّع يرفع رصيد العميل) — والصفر يُمنع عند الإصدار
    if (isReturn && field === 'qty') value = Math.max(0, Number.isFinite(value) ? value : 0);
    setLines(ls => ls.map((l, i) => {
      if (i !== idx) return l;
      // تعديل الإجمالي مباشرة: يُشتق سعر الوحدة عكسياً ويبقى الإجمالي كما كُتب
      // (لا يُعاد حسابه — وإلا حارب الحقلُ الكاتبَ أثناء الكتابة)
      if (field === 'lineTotal') {
        const p = priceFromLineTotal(value, l.qty, l.discountPct, l.taxPct, false);
        return p === null ? l : { ...l, lineTotal: value, unitPrice: p };
      }
      const updated = { ...l, [field]: value };
      return { ...updated, lineTotal: calcLine(updated.qty, updated.unitPrice, updated.discountPct, updated.taxPct) };
    }));
  };

  // الإجماليات من **المحرّك المشترك** لا بحساب يدويّ هنا: الحساب اليدويّ كان
  // يطرح خصم البند بينما الخادم لا يطرحه، فتُطبع ورقةٌ تخالف السجلّ المحاسبيّ
  // بمقدار الخصم كاملاً — بلا خطأ ولا تحذير يراه أحد.
  const calcAll = computeInvoiceTotals(
    lines.map(l => ({ qty: l.qty, unitPrice: l.unitPrice, discountPct: l.discountPct, taxPct: l.taxPct })),
    { companyVat: 15, decimals: 2, invoiceDiscountPct: discountPct },
  );
  const subtotal = calcAll.subtotal;
  const totalDiscount = calcAll.discountAmt;
  const taxTotal = calcAll.taxAmt;
  const total = calcAll.total;
  // معاينة الجدول — والخادم يكتب الحقيقي من إجماليّه
  const insPreview = plan === 'INSTALLMENT' ? previewInstallments(total, insCount, insFirst, insPeriod) : [];

  /* معاينة المرتجع المرتبط: المحرّك نفسه بخيارات الخادم نفسها (أسعار الاسترداد شاملة، بلا خصم، خانات عملة الشركة) —
   * فإجماليّه هنا هو ما يُقيَّد في المرحلة الأولى. وفي الثانية تقديرٌ: الإشعار يُسعَّر من بنود الأصل على الخادم. */
  const retDec = currencyDecimals(getActiveCurrency());
  const linkedCalc = isReturn && linked ? linkedReturnTotals(linked.lines, retDec, Number((company as { defaultVatPct?: number } | null | undefined)?.defaultVatPct ?? 15)) : null;
  // المرحلة الثانية بلا فاتورة مختارة: لا بنود تُرسل ⇒ أصفار (لا إجماليّ أسطرٍ حرّة مخفيّة لن تُصدر)
  const shown = linkedCalc ?? (phase2 ? { subtotal: 0, discountAmt: 0, taxAmt: 0, total: 0 } : { subtotal, discountAmt: totalDiscount, taxAmt: taxTotal, total });

  const submitReturn = () => {
    if (!customerId) { toast.error(tr('اختر العميل')); return; }
    if (!salesRepId) { toast.error(tr('اختر المندوب')); return; }
    if (loadingSaleId) return; // بنود الفاتورة المختارة لم تصل بعد
    const problem = returnFormProblem({ phase2, linked, freeLines: lines, noteReason, invoiceDate });
    if (problem) { toast.error(tr(problem)); return; }
    const head: ReturnHead = { customerId, salesRepId, returnReason, notes, invoiceDate, phase2, noteReason };
    // خانات عملة الشركة: سعر وحدة المرتجع (حبّةٌ من كرتون) يُشتقّ من مبلغه بها كما يحسبه الخادم (linkedUnitPrice)
    if (linked) { mutation.mutate(buildLinkedReturnPayload(head, linked, retDec)); return; }
    // «تتبّع اللوط» (D5): المرتجع الحرّ لصنفٍ متتبَّع بتشغيلته المختارة للسطر كله، وإلا «غير معروف» — والمطفأة الجسم كما كان
    const free = buildFreeReturnPayload(head, lines, discountPct);
    mutation.mutate(lotOn ? withFreeReturnLots(free, lines, l => (trackedIds.has(l.productId) ? freeLots[lineKey(l)] : undefined)) : free);
  };

  const handleSubmit = () => {
    if (isReturn) { submitReturn(); return; }
    if (!customerId) { toast.error(tr('اختر العميل')); return; }
    if (!salesRepId) { toast.error(tr('اختر المندوب')); return; }
    if (lines.length === 0) { toast.error(tr('أضف صنفا على الأقل')); return; }
    if (plan === 'INSTALLMENT' && insPreview.length === 0) {
      toast.error(tr('المبلغ لا يكفي لتقسيمه على هذا العدد من الأقساط')); return;
    }
    mutation.mutate({
      customerId, salesRepId, type, discountPct, notes,
      ...(invoiceDate && { invoiceDate }),
      ...(deliveryDate && { deliveryDate }),
      ...(plan === 'INSTALLMENT' && {
        paymentPlan: 'INSTALLMENT',
        installmentPlan: { count: insCount, firstDueDate: insFirst, period: insPeriod },
      }),
      items: lines.map(l => ({
        productId: l.productId, qty: l.qty, unitPrice: l.unitPrice,
        discountPct: l.discountPct, taxPct: l.taxPct,
        // الوحدات المتعددة: معرّف الوحدة يحلّه الخادم، ولقطتها كما رآها المدير (الاسم والمعامل ووحدة الأساس) تكشف
        // قائمةً قديمة — صنفٌ حُوّل أساسه بعد فتح النافذة يُردّ 400 UNIT_INVALID لا يُقيَّد «٢» حبّتين وقد قصد كرتونين
        ...invoiceItemUnit({ unit: l.unit, unitId: l.unitId, unitName: l.unitId ? l.unit : null, unitFactor: l.unitFactor, baseUnit: l.baseUnit }),
      })),
    });
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-start justify-center p-4 overflow-y-auto" dir="rtl">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl my-4">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b">
          <h2 className={`text-lg font-bold ${isReturn ? 'text-amber-700' : 'text-gray-800'}`}>{isReturn ? tr('فاتورة إرجاع') : tr('إنشاء فاتورة جديدة')}</h2>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg text-gray-500"><X size={18} /></button>
        </div>

        <div className="p-5 space-y-5">
          {/* نوع الفاتورة (طلب المالك بلفظه): جديدة = البيع كما كان، إرجاع = مرتجع مبيعات type=RETURN */}
          <div className="grid grid-cols-4 gap-4 items-end">
            <div>
              <label className="label">{tr('نوع الفاتورة')}</label>
              <select className={`input ${isReturn ? 'border-amber-300 text-amber-800 font-semibold' : ''}`} value={docKind}
                disabled={mutation.isPending}
                onChange={e => changeKind(e.target.value as 'SALE' | 'RETURN')}>
                <option value="SALE">{tr('فاتورة جديدة')}</option>
                <option value="RETURN">{tr('فاتورة إرجاع')}</option>
              </select>
            </div>
            {isReturn && (
              <p className="col-span-3 text-xs text-amber-800 bg-amber-50 border border-amber-100 rounded-xl px-3 py-2.5 flex items-center gap-2">
                <Undo2 size={14} className="shrink-0" />{tr('مرتجع مبيعات سيخفض رصيد العميل بقيمة المرتجع')}
              </p>
            )}
          </div>

          {/* Customer + Rep + Type + Date */}
          <div className="grid grid-cols-4 gap-4">
            <div>
              <label className="label">{tr('العميل')} *</label>
              <SearchableSelect
                placeholder={tr('اختر العميل')}
                searchPlaceholder={tr('اكتب اسم أو جوال العميل')}
                value={customerId}
                options={(customers || []).map(c => ({
                  value: c.id,
                  label: c.name,
                  hint: c.phone + (Number(c.balance) > 0 ? ` • ${tr('رصيد')} ${formatCurrency(c.balance)}` : ''),
                  hintColor: Number(c.balance) > 0 ? 'text-red-500' : undefined,
                }))}
                // فاتورة البيع المربوطة لعميلٍ آخر يرفضها الخادم («فاتورة البيع لعميلٍ آخر») — تُفكّ مع تغيير العميل
                onChange={(v) => { setCustomerId(v); setSelectedCustomer((customers || []).find(c => c.id === v) || null); unlinkSale(); }}
              />
            </div>
            <div>
              <label className="label">{tr('المندوب')} *</label>
              <select className="input" value={salesRepId} onChange={e => setSalesRepId(e.target.value)}>
                <option value="">{tr('اختر المندوب')}</option>
                {salesReps?.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </div>
            {isReturn ? (
              <div>
                <label className="label">{tr('سبب الإرجاع')}</label>
                <select className="input" value={returnReason} onChange={e => setReturnReason(e.target.value as ReturnReason)}>
                  {RETURN_REASONS.map(([v, label]) => <option key={v} value={v}>{tr(label)}</option>)}
                </select>
              </div>
            ) : (
              <div>
                <label className="label">{tr('طريقة الدفع')}</label>
                <select className="input"
                  value={plan === 'INSTALLMENT' ? 'INSTALLMENT' : type}
                  onChange={e => {
                    const v = e.target.value;
                    if (v === 'INSTALLMENT') { setType('CREDIT'); setPlan('INSTALLMENT'); }
                    else { setType(v as 'CASH' | 'CREDIT'); setPlan('IMMEDIATE'); }
                  }}>
                  <option value="CREDIT">{tr('آجل')}</option>
                  <option value="CASH">{tr('نقدي')}</option>
                  <option value="INSTALLMENT">{tr('تقسيط')}</option>
                </select>
              </div>
            )}
            {/* الإشعار الدائن (المرحلة الثانية) يُصدَر بتاريخ لحظته على الخادم — حقل تاريخٍ يُهمَل كذبٌ في الواجهة */}
            {!(isReturn && phase2) && (
              <div>
                <label className="label">{tr('التاريخ')}</label>
                <input type="date" className="input" value={invoiceDate} onChange={e => setInvoiceDate(e.target.value)} title={tr('اتركه فارغا لتاريخ اليوم')} />
              </div>
            )}
            {!isReturn && (
              <div>
                <label className="label">{tr('تاريخ التسليم (اختياري)')}</label>
                <input type="date" className="input" value={deliveryDate} onChange={e => setDeliveryDate(e.target.value)} title={tr('لا يظهر بالفاتورة ان ترك فارغا')} />
              </div>
            )}
          </div>

          {isReturn && (
            <div className="border border-amber-200 bg-amber-50/50 rounded-xl p-3 space-y-3">
              <div className="grid grid-cols-4 gap-4 items-end">
                <div className="col-span-2">
                  <label className="label">{tr('فاتورة البيع الأصلية')}{phase2 ? ' *' : ''}</label>
                  <SearchableSelect
                    placeholder={!customerId ? tr('اختر العميل أولا') : tr('اختر فاتورة البيع')}
                    searchPlaceholder={tr('رقم الفاتورة')}
                    value={linked?.id ?? loadingSaleId ?? ''}
                    disabled={!customerId || mutation.isPending}
                    loading={loadingSales || !!loadingSaleId}
                    options={!customerId ? [] : [
                      // المرحلة الأولى: المرتجع الحرّ خيارٌ صريح — وفي الثانية لا وجود له (الإشعار يشير لفاتورته)
                      ...(phase2 ? [] : [{ value: '', label: tr('بدون فاتورة بيع (مرتجع حر)') }]),
                      ...(returnableSales || []).map(s => ({
                        value: s.id,
                        label: s.number,
                        // المتاح بعدد البنود: مجموع الخادم بالأساس يخلط كراتين بحبّات فلا يُعرض رقماً — إلا لخادمٍ قبل الميزة
                        hint: `${formatDate(s.invoiceDate)} • ${formatCurrency(s.total)} • ${tr('المتاح للإرجاع')} ${s.returnableLines != null
                          ? `${s.returnableLines} ${tr('بند')}` : Number(Number(s.returnableQty).toFixed(3))}`,
                      })),
                    ]}
                    onChange={(v) => { void pickSale(v); }}
                  />
                  {salesFailed && <p className="text-xs text-red-500 mt-1">{tr('تعذر تحميل فواتير البيع')}</p>}
                  {customerId && !loadingSales && !salesFailed && returnableSales?.length === 0 && (
                    <p className="text-xs text-gray-500 mt-1">{tr('لا توجد فواتير بيع يمكن الإرجاع منها لهذا العميل')}</p>
                  )}
                </div>
                {linked && (
                  <div className="col-span-2 flex flex-wrap gap-2 justify-end">
                    <button type="button" className="btn-secondary text-xs py-1.5" disabled={mutation.isPending} onClick={() => setLinked(s => s && { ...s, lines: fillLinkedQty(s.lines, true) })}>{tr('إرجاع كامل المتاح')}</button>
                    <button type="button" className="btn-secondary text-xs py-1.5" disabled={mutation.isPending} onClick={() => setLinked(s => s && { ...s, lines: fillLinkedQty(s.lines, false) })}>{tr('تصفير الكميات')}</button>
                    <button type="button" className="text-xs text-gray-500 hover:text-red-600 px-2 disabled:opacity-50" disabled={mutation.isPending} onClick={unlinkSale}>{tr('إلغاء الربط')}</button>
                  </div>
                )}
              </div>
              {phase2 && (
                <>
                  <p className="text-xs text-amber-800">{tr('الفوترة الإلكترونية المرحلة الثانية مفعلة: المرتجع يصدر إشعارا دائنا مرتبطا بفاتورة البيع الأصلية وأسعاره من أسعارها')}</p>
                  <div>
                    <label className="label">{tr('سبب الإشعار الدائن')} *</label>
                    <input className="input" maxLength={NOTE_REASON_MAX} value={noteReason} onChange={e => setNoteReason(e.target.value)}
                      placeholder={tr('اكتب سبب الإرجاع كما يظهر في الإشعار الدائن')} />
                  </div>
                </>
              )}
              {/* التالف يدخل سيارة المندوب المحدَّد أعلاه رصيداً تالفاً لا يُباع — مهما كان اختيار العودة للمخزون */}
              {returnReason === 'DAMAGED' && (
                <p className="text-xs text-red-700 bg-red-50 border border-red-100 rounded-lg px-3 py-2">{tr('يدخل سيارة المندوب تالفا ولا يباع حتى تزيله الإدارة')}</p>
              )}
            </div>
          )}

          {!isReturn && plan === 'INSTALLMENT' && (
            <div className="border border-[#D6CFEA] bg-[#FAF9FD] rounded-xl p-3">
              <p className="text-xs font-bold text-[#5B4B9C] mb-2">{tr('جدولة الأقساط')}</p>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="label">{tr('عدد الأقساط')}</label>
                  <input type="number" min={2} max={MAX_INSTALLMENTS} className="input" value={insCount}
                    onChange={e => setInsCount(Math.max(2, Math.min(MAX_INSTALLMENTS, Number(e.target.value) || 2)))} />
                </div>
                <div>
                  <label className="label">{tr('أول قسط')}</label>
                  <input type="date" className="input" value={insFirst} onChange={e => setInsFirst(e.target.value)} />
                </div>
                <div>
                  <label className="label">{tr('الدورية')}</label>
                  <select className="input" value={insPeriod} onChange={e => setInsPeriod(e.target.value as InstallmentPeriod)}>
                    <option value="MONTHLY">{tr('شهري')}</option>
                    <option value="SEMI_MONTHLY">{tr('نصف شهري')}</option>
                    <option value="WEEKLY">{tr('أسبوعي')}</option>
                  </select>
                </div>
              </div>
              {insPreview.length === 0 ? (
                <p className="text-xs text-[#C0392B] mt-2">{tr('المبلغ لا يكفي لتقسيمه على هذا العدد من الأقساط')}</p>
              ) : (
                <div className="mt-2 border-t border-[#E9E1D3] pt-2 max-h-44 overflow-y-auto">
                  {insPreview.map(r => (
                    <div key={r.seq} className="flex justify-between text-xs py-0.5">
                      <span className="text-gray-500">{tr('قسط')} {r.seq} · {formatDate(r.dueDate as unknown as string)}</span>
                      <span className="font-bold text-gray-700">{formatCurrency(r.amount)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* بنود فاتورة البيع المربوطة: المبيع والمُرجَع سابقاً والمتاح وسعر الاسترداد، والكمية وحدها تُكتب (٠ = لا يُرجَع) */}
          {/* المرحلة الثانية بلا فاتورة مختارة: لا محرّر أسطر حرّ (لا مرتجع حرّ بعد الربط) بل دعوةٌ لاختيار الفاتورة */}
          {isReturn && (linked || loadingSaleId || phase2) ? (
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="label mb-0">
                {tr('الأصناف')}{linked && <span className="text-amber-700 font-normal"> · {tr('من فاتورة البيع')} <b dir="ltr">{linked.number}</b> · {formatDate(linked.invoiceDate)}</span>}
              </label>
            </div>
            <div className="border border-amber-200 rounded-xl overflow-hidden">
              <table className="table">
                <thead>
                  <tr>
                    <th>{tr('الصنف')}</th><th>{tr('مباع')}</th><th>{tr('المرتجع سابقا')}</th><th>{tr('المتاح للإرجاع')}</th>
                    <th title={tr('سعر الوحدة شامل الضريبة بعد خصومات فاتورة البيع')}>{tr('سعر الاسترداد')}</th>
                    <th>{tr('كمية المرتجع')}</th><th>{tr('الإجمالي')}</th>
                  </tr>
                </thead>
                <tbody>
                  {!linked && (
                    <tr><td colSpan={7} className="text-center py-8 text-gray-400 text-sm">
                      {loadingSaleId ? tr('جاري التحميل') : tr('اختر فاتورة البيع الأصلية — المرتجع في المرحلة الثانية إشعار دائن مرتبط بها')}
                    </td></tr>
                  )}
                  {linked?.lines.map(l => {
                    const open = isLineReturnable(l);
                    const lt = linkedCalc?.lineTotals[l.saleItemId];
                    /* الوحدات المتعددة: الأعمدة كلّها بوحدة المرتجع المختارة (lib/returnInvoice expressIn) — وحبّةٌ من بند كرتون
                     * وحدةٌ تُختار هنا، والمتاح بالأساس يُعرض مفكَّكاً «١ كرتون و٢٣ حبة» فلا يُقرأ «٤٧» كراتين */
                    const retChoices = returnUnitChoices(l);
                    const baseOf = { unit: l.baseUnit, units: l.units };
                    return (
                      // مفتاح بند البيع لا الصنف: الفاتورة الواحدة قد تحمل الصنف نفسه في بندين بسعرين
                      <tr key={l.saleItemId} className={open ? '' : 'opacity-60'}>
                        <td>
                          <p className="font-medium text-sm">{l.name}</p>
                          <p className="text-xs text-gray-400">{[l.code, l.saleUnitName ?? l.unit].filter(Boolean).join(' • ')}</p>
                          {retChoices.length > 1 && (
                            <select className="input py-1 text-xs mt-1 w-auto" value={l.retUnitId ?? ''} aria-label={tr('وحدة المرتجع')}
                              disabled={!open || mutation.isPending} onChange={e => setLinkedUnit(l.saleItemId, e.target.value || null)}>
                              {retChoices.map(c => <option key={c.id ?? 'base'} value={c.id ?? ''}>{c.name}{c.factor > 1 ? ` (${c.factor})` : ''}</option>)}
                            </select>
                          )}
                          {retChoices.length > 1 && open && (
                            <p className="text-[11px] text-gray-500 mt-0.5">{tr('المتاح للإرجاع')}: {baseQtyText(l.returnableBase, baseOf, n => String(Number(n.toFixed(3))))}</p>
                          )}
                          {l.returnBlocked && <p className="text-xs text-red-600 mt-0.5">{l.returnBlocked}</p>}
                          {l.shelfLife && l.expiresAt && (
                            l.expiredToday
                              ? <p className="text-[11px] font-semibold text-red-600 mt-0.5" title={tr('يدخل السيارة منتهيا ولا يباع')}>{tr('منتهي الصلاحية')} · {formatDayOnly(l.expiresAt)}</p>
                              : <p className="text-[11px] font-semibold text-[#1E7A52] mt-0.5">{tr('ساري الصلاحية')} · {tr('حتى')} {formatDayOnly(l.expiresAt)}</p>
                          )}
                          {/* «تتبّع اللوط»: تشغيلات البند المباع ومتاح كلٍّ منها للإرجاع (بالأساس) — للعرض، والخادم يوزّع المرتجع عليها */}
                          {lotOn && (saleLots.get(l.saleItemId)?.length ?? 0) > 0 && (
                            <div className="mt-1 rounded-lg bg-[#FAF7F0] border border-[#F1EBDF] px-2 py-1 space-y-0.5">
                              {saleLots.get(l.saleItemId)!.map((s, k) => (
                                <p key={s.lotId ?? `u${k}`} className="text-[11px] text-[#6E6557]">
                                  <span className="font-semibold text-[#1F1A13]" dir="ltr">{s.lotNumber ?? tr('غير معروف')}</span>
                                  {s.expiryDate && <> · {tr('تاريخ الانتهاء')} {formatDayOnly(s.expiryDate)}</>}
                                  {' · '}{tr('المتاح للإرجاع')} {baseQtyText(s.returnable, baseOf, n => String(Number(n.toFixed(3))), { withUnit: true })}
                                  {s.certainty !== 'CONFIRMED' && <span className="text-gray-400"> · {tr(LOT_CERTAINTY_LABELS[s.certainty])}</span>}
                                </p>
                              ))}
                              <p className="text-[10px] text-gray-400">{tr('يوزع المرتجع على تشغيلات البيع تلقائيا')}</p>
                            </div>
                          )}
                        </td>
                        {/* وحدة الأعمدة تُكتب بجانب الرقم حين للصنف وحدات — «٤٧» وحدها لا تقول أحبّاتٌ أم كراتين */}
                        <td className="text-sm">{Number(l.sold.toFixed(3))}{retChoices.length > 1 && <span className="text-[10px] text-gray-400"> {l.unit}</span>}</td>
                        <td className="text-sm text-gray-500">{Number(l.returned.toFixed(3))}</td>
                        <td className="text-sm font-semibold">{Number(l.returnable.toFixed(3))}{retChoices.length > 1 && <span className="text-[10px] font-normal text-gray-400"> {l.unit}</span>}</td>
                        <td className="text-sm">{formatCurrency(l.refundUnitPrice, undefined, 4)}{retChoices.length > 1 && <span className="text-[10px] text-gray-400"> / {l.unit}</span>}</td>
                        <td>
                          <input type="number" className="input w-24 text-center" min={0} max={maxReturnQty(l)} step="any" inputMode="decimal"
                            disabled={!open || mutation.isPending} value={l.qty}
                            onChange={e => setLinkedQty(l.saleItemId, Number(e.target.value))} />
                        </td>
                        <td className="text-sm font-semibold">{lt != null ? formatCurrency(lt) : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
          ) : (
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="label mb-0">{tr('الأصناف')}</label>
              <div className="w-72">
                <SearchableSelect
                  placeholder={tr('أضف صنفا')}
                  searchPlaceholder={tr('اكتب اسم أو كود الصنف')}
                  value=""
                  resetOnSelect
                  // صنفٌ بوحدات: سعر الوحدة التي يُضاف بها (الأكبر) واسمها — سعر الحبة وحده يُقرأ سعر كرتون
                  options={(products || []).map(p => ({
                    value: p.id, label: p.name,
                    hint: hasUnitChoice(p)
                      ? `${p.code} • ${formatCurrency(choiceNet(defaultChoice(p), p.basePrice))} / ${defaultChoice(p).name}`
                      : `${p.code} • ${formatCurrency(p.basePrice)}`,
                  }))}
                  onChange={(v) => { const p = (products || []).find(x => x.id === v); if (p) addProduct(p); }}
                />
              </div>
            </div>

            <div className="border border-gray-200 rounded-xl overflow-hidden">
              <table className="table">
                <thead>
                  <tr>
                    <th className="w-6"></th>
                    <th>{tr('الصنف')}</th><th>{tr('الكمية')}</th><th>{tr('السعر')}</th>
                    <th>{tr('خصم%')}</th><th>{tr('ضريبة%')}</th><th>{tr('الإجمالي')}</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.length === 0 && (
                    <tr><td colSpan={7} className="text-center py-8 text-gray-400 text-sm">{tr('اختر صنفا من القائمة لإضافته')}</td></tr>
                  )}
                  {lines.map((l, i) => {
                    const p = (products || []).find(x => x.id === l.productId);
                    const choices = p ? unitChoices(p) : [];
                    return (
                    // مفتاح الصنف ووحدته: الصنف نفسه بوحدتين بندان
                    <tr key={lineKey(l)}>
                      <td>
                        <button onClick={() => setLines(ls => ls.filter((_, j) => j !== i))} className="text-red-400 hover:text-red-600">
                          <Trash2 size={14} />
                        </button>
                      </td>
                      <td>
                        <p className="font-medium text-sm">{l.productName}</p>
                        {choices.length > 1 ? (
                          <select className="input py-1 text-xs mt-1 w-auto" value={l.unitId ?? ''} aria-label={tr('الوحدة')}
                            onChange={e => setLineUnit(i, e.target.value || null)}>
                            {choices.map(c => (
                              <option key={c.id ?? 'base'} value={c.id ?? ''} disabled={unitTaken(lines, l.productId, c.id, lineKey(l))}>
                                {c.name}{c.factor > 1 ? ` (${c.factor} ${choices[0].name})` : ''}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <p className="text-xs text-gray-400">{l.unit}</p>
                        )}
                        {/* «تتبّع اللوط» (D5): المرتجع الحرّ من الإدارة بتشغيلة صريحة اختيارية — البيع يوزّعه الخادم FEFO بلا حقل */}
                        {isReturn && trackedIds.has(l.productId) && (
                          <FreeReturnLotPicker productId={l.productId} lotOn={lotOn} disabled={mutation.isPending}
                            value={freeLots[lineKey(l)] ?? ''} onChange={v => setFreeLots(m => ({ ...m, [lineKey(l)]: v }))} />
                        )}
                      </td>
                      <td><input type="number" className="input w-20 text-center" min="0.001" step="any" inputMode="decimal" value={l.qty} onChange={e => updateLine(i, 'qty', Number(e.target.value))} /></td>
                      <td><DecimalInput className="input w-24" min={0} value={Number(l.unitPrice.toFixed(6))} onCommit={v => updateLine(i, 'unitPrice', v)} /></td>
                      <td><input type="number" className="input w-16 text-center" min="0" max="100" step="any" value={l.discountPct} onChange={e => updateLine(i, 'discountPct', Number(e.target.value))} /></td>
                      <td><input type="number" className="input w-16 text-center" min="0" max="100" step="any" value={l.taxPct} onChange={e => updateLine(i, 'taxPct', Number(e.target.value))} /></td>
                      <td><DecimalInput className="input w-28 font-semibold" min={0} title={tr('عدل الاجمالي وسينعكس على سعر الوحدة')} value={l.lineTotal} onCommit={v => updateLine(i, 'lineTotal', v)} /></td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
          )}

          {/* Totals */}
          {isReturn ? (
            <div className="flex justify-end">
              <div className="w-72 space-y-2 text-sm">
                <div className="flex justify-between"><span className="text-gray-500">{tr('المجموع قبل الخصم')}</span><span>{formatCurrency(shown.subtotal)}</span></div>
                {/* المرتبط بلا خصم: سعر الاسترداد صافٍ بعد خصومات البيع، وخصمٌ فوقه يُنقص ما يستحقه العميل مرّتين */}
                {!linked && !phase2 && (
                  <div className="flex justify-between items-center">
                    <span className="text-gray-500">{tr('خصم عام %')}</span>
                    <input type="number" className="input w-20 text-center" min="0" max="100" step="any" value={discountPct} onChange={e => setDiscountPct(Number(e.target.value))} />
                  </div>
                )}
                {shown.discountAmt > 0 && (
                  <div className="flex justify-between text-red-500"><span>{tr('إجمالي الخصم')}</span><span>- {formatCurrency(shown.discountAmt)}</span></div>
                )}
                <div className="flex justify-between text-[#E15A30]"><span>{tr('ضريبة القيمة المضافة')}</span><span>{formatCurrency(shown.taxAmt)}</span></div>
                <div className="flex justify-between font-bold text-lg border-t pt-2 text-amber-700"><span>{tr('إجمالي المرتجع دائن')}</span><span>{formatCurrency(shown.total)}</span></div>
                {phase2 && linked && <p className="text-[11px] text-gray-500 leading-relaxed">{tr('تقديري يحسب الإشعار الدائن من أسعار الفاتورة الأصلية')}</p>}
              </div>
            </div>
          ) : (
          <div className="flex justify-end">
            <div className="w-64 space-y-2 text-sm">
              <div className="flex justify-between"><span className="text-gray-500">{tr('المجموع قبل الخصم')}</span><span>{formatCurrency(subtotal)}</span></div>
              <div className="flex justify-between items-center">
                <span className="text-gray-500">{tr('خصم عام %')}</span>
                <input type="number" className="input w-20 text-center" min="0" max="100" step="any" value={discountPct} onChange={e => setDiscountPct(Number(e.target.value))} />
              </div>
              <div className="flex justify-between text-red-500"><span>{tr('إجمالي الخصم')}</span><span>- {formatCurrency(totalDiscount)}</span></div>
              <div className="flex justify-between text-[#E15A30]"><span>{tr('ضريبة القيمة المضافة')}</span><span>{formatCurrency(taxTotal)}</span></div>
              <div className="flex justify-between font-bold text-lg border-t pt-2"><span>{tr('الإجمالي النهائي')}</span><span>{formatCurrency(total)}</span></div>
            </div>
          </div>
          )}

          <div>
            <label className="label">{tr('ملاحظات')}</label>
            <textarea className="input" rows={2} value={notes} onChange={e => setNotes(e.target.value)} />
          </div>
        </div>

        {/* Footer */}
        <div className="flex gap-3 p-5 border-t">
          <button onClick={handleSubmit} disabled={mutation.isPending || (isReturn && !!loadingSaleId)} className="btn-primary flex-1 justify-center py-2.5">
            {mutation.isPending ? <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : isReturn ? <Undo2 size={16} /> : <Plus size={16} />}
            {isReturn ? tr('إصدار فاتورة الإرجاع') : tr('إصدار الفاتورة')}
          </button>
          <button onClick={onClose} className="btn-secondary">{tr('إلغاء')}</button>
        </div>
      </div>
    </div>
  );
}

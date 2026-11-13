import { useMemo, useState, lazy, Suspense } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import {
  Phone, Receipt, Wallet, RotateCcw, Scale, BookOpen, Paperclip, Share2, Undo2, Plus, ChevronLeft,
  type LucideIcon,
} from 'lucide-react';
import {
  suppliersApi, supplierPaymentsApi,
  type OpenBill, type Supplier, type SupplierPaymentView, type SupplierStatement, type SupplierStatementLine,
} from '../api/suppliers';
import { formatCurrency, formatDayOnly, formatNumber, getActiveCurrency } from '../utils/format';
import { currencyDecimals } from '../i18n/countries';
import { useTr } from '../i18n/strings';
import { useBackClose } from '../lib/useBackClose';
import { useAuthStore } from '../store/authStore';
import { MCard, MRow, MHeader, MEmpty, MError, MSpinner } from './mobileUi';
import { expectArray, expectObject } from './shape';
import { useMTaxOff } from './mTaxMode';
import { mCustomerTel } from './mCustomerPhone';
import { MEntryAttachments } from './MPurchaseAttachments';
import {
  BALANCE_LABELS, balanceState, ledgerKindOf, lineOpensPayment, openBillsTotals, payMethodLabel, type LedgerTone,
} from './MSuppliersLogic';
import MSuppliersPayForm, { type PayPreset } from './MSuppliersPayForm';
import MSuppliersPaymentView from './MSuppliersPaymentView';

/* الورقة في حزمة مستقلّة — تجرّ jspdf وhtml2canvas معها، ولا يدفع ثمنها من لم يشارك كشفاً */
const MSuppliersDocs = lazy(() => import('./MSuppliersDocs'));

type Tab = 'statement' | 'bills' | 'payments';
const TABS: { id: Tab; label: string }[] = [
  { id: 'statement', label: 'كشف الحساب' },
  { id: 'bills', label: 'الفواتير المفتوحة' },
  { id: 'payments', label: 'سندات الصرف' },
];

const TONE: Record<LedgerTone, { cls: string; icon: LucideIcon }> = {
  bill: { cls: 'text-[#C94E28] bg-[#FBEBE2]', icon: Receipt },
  pay: { cls: 'text-[#2F855A] bg-[#EAF6F0]', icon: Wallet },
  return: { cls: 'text-[#2B6CB0] bg-[#EBF2FA]', icon: RotateCcw },
  reverse: { cls: 'text-[#B7791F] bg-[#FDF6E7]', icon: Undo2 },
  refund: { cls: 'text-[#2B6CB0] bg-[#EBF2FA]', icon: Wallet },
  opening: { cls: 'text-[#6E6557] bg-[#F1EBDF]', icon: Scale },
  other: { cls: 'text-[#6E6557] bg-[#F1EBDF]', icon: BookOpen },
};

const PAYMENTS_PAGE = 30;

/**
 * بطاقة المورّد: رصيده بحاله، وبياناته، وثلاثة تبويبات — كشف الحساب (من/إلى برصيدٍ جارٍ ومشاركته ورقةً)، والفواتير المفتوحة
 * (بزرّ «سداد» يفتح سنداً مخصَّصاً لها)، وسندات الصرف (تُفتح فتُشارك أو تُلغى).
 *
 * الكشف كنظيره للعميل (MCustomerStatement) في ثلاثة: الرصيد المرحَّل يُعرض حين تُحدَّد بداية، وطرفا المدّة مستقلّان، والورقة
 * المطبوعة تُبنى من الصفوف التي على الشاشة بمدّتها لا بطلبٍ جديد — فلا تخالف الورقةُ الشاشة.
 */
export default function MSuppliersCard({ supplier, company, onClose }: {
  supplier: Supplier;
  company?: unknown;
  onClose: () => void;
}) {
  const tr = useTr();
  const taxOff = useMTaxOff();
  const user = useAuthStore(s => s.user);
  const decimals = currencyDecimals(getActiveCurrency());
  const [tab, setTab] = useState<Tab>('statement');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  // طبقات فوق البطاقة — كلٌّ بزرّ رجوعه، وإغلاق كلٍّ يُطفئ شرطه
  const [pay, setPay] = useState<{ preset: PayPreset | null } | null>(null);
  const [paymentId, setPaymentId] = useState<string | null>(null);
  const [doc, setDoc] = useState(false);
  const [atts, setAtts] = useState<SupplierStatementLine | null>(null);
  useBackClose(!!pay, () => setPay(null));
  useBackClose(!!paymentId, () => setPaymentId(null));
  useBackClose(doc, () => setDoc(false));
  useBackClose(!!atts, () => setAtts(null));

  // النسخة الحيّة: صفّ القائمة قد يكون أقدم من سندٍ سُجّل للتوّ
  const oneQ = useQuery({
    queryKey: ['m-suppliers', 'one', supplier.id],
    queryFn: async () => expectObject<Supplier>((await suppliersApi.get(supplier.id)).data?.data, 'المورد'),
    initialData: supplier,
  });
  const s = oneQ.data;

  const billsQ = useQuery({
    queryKey: ['m-suppliers', 'open-bills', supplier.id],
    queryFn: async () => expectArray<OpenBill>((await suppliersApi.openBills(supplier.id)).data?.data, 'الفواتير المفتوحة'),
  });

  const badRange = !!(from && to && from > to);
  const statementQ = useQuery({
    queryKey: ['m-suppliers', 'statement', supplier.id, from, to],
    /* كلٌّ على حدة: «من ١ يناير» بلا «إلى» تصفيةٌ صحيحة لا إلغاء */
    queryFn: async () => expectObject<SupplierStatement>(
      (await suppliersApi.statement(supplier.id, { ...(from && { from }), ...(to && { to }) })).data?.data, 'كشف الحساب'),
    enabled: (tab === 'statement' || doc) && !badRange,
  });

  const paymentsQ = useInfiniteQuery({
    queryKey: ['m-suppliers', 'payments', supplier.id],
    queryFn: async ({ pageParam }) => {
      const d = expectObject<{ items: unknown; total: unknown }>(
        (await supplierPaymentsApi.list({ supplierId: supplier.id, page: pageParam, limit: PAYMENTS_PAGE })).data?.data, 'سندات الصرف');
      return { items: expectArray<SupplierPaymentView>(d.items, 'سندات الصرف'), total: Number(d.total) || 0 };
    },
    initialPageParam: 1,
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, p) => n + p.items.length, 0);
      return last.items.length > 0 && loaded < last.total ? pages.length + 1 : undefined;
    },
    enabled: tab === 'payments',
  });

  if (pay) {
    return (
      <MSuppliersPayForm supplier={s} preset={pay.preset} onClose={() => setPay(null)}
        onCreated={id => { setPay(null); setPaymentId(id); }} />
    );
  }
  if (paymentId) return <MSuppliersPaymentView paymentId={paymentId} company={company} onClose={() => setPaymentId(null)} />;
  if (doc && statementQ.data) {
    return (
      <Suspense fallback={<MSpinner />}>
        <MSuppliersDocs doc={{ kind: 'statement', statement: statementQ.data, from: from || undefined, to: to || undefined }}
          company={company} issuer={user?.name || tr('الإدارة')} onClose={() => setDoc(false)} />
      </Suspense>
    );
  }
  if (atts?.warehouseEntryId) {
    return (
      <MEntryAttachments entryId={atts.warehouseEntryId} onClose={() => setAtts(null)} title={tr('فاتورة المشتريات')}
        subtitle={[s.name, atts.ref, formatDayOnly(atts.date)].filter(Boolean).join(' · ')} />
    );
  }

  const b = balanceState(s.balance, decimals);
  const bt = billsQ.data ? openBillsTotals(billsQ.data, decimals) : null;
  const tel = mCustomerTel(s.phone);

  return (
    <div className="h-full flex flex-col bg-[#FAF7F0]">
      <MHeader title={s.name} subtitle={[s.code, !s.isActive ? tr('مؤرشف') : null].filter(Boolean).join(' · ') || undefined} onBack={onClose} />

      <div className="flex-1 overflow-y-auto overscroll-contain p-3 space-y-3">
        {/* الرصيد بحاله: الرقم بلا إشارة واسم الحال فوقه — «−٥٠٠» وحدها تُقرأ ديناً وهي دفعةٌ مقدّمة */}
        <div className={`rounded-2xl border p-3.5 ${b.state === 'owed' ? 'border-[#F5DACE] bg-[#FDF5F0]' : b.state === 'advance' ? 'border-[#CFE0F3] bg-[#F3F8FD]' : 'border-[#F1EBDF] bg-white'}`}>
          <p className="text-[11px] text-[#9A8F7E] mb-1">{tr(BALANCE_LABELS[b.state])}</p>
          <p className={`text-2xl font-extrabold tabular-nums ${b.state === 'owed' ? 'text-[#C94E28]' : b.state === 'advance' ? 'text-[#2B6CB0]' : 'text-[#2F855A]'}`} dir="ltr">
            {formatCurrency(b.amount)}
          </p>
          {bt && billsQ.data && billsQ.data.length > 0 && (
            <p className="text-[11px] text-[#6E6557] mt-1.5">
              {tr('فواتير مفتوحة')}: {formatNumber(billsQ.data.length)} · <span dir="ltr" className="tabular-nums">{formatCurrency(bt.outstanding)}</span>
            </p>
          )}
          {bt && bt.overdue > 0 && (
            <p className="text-[11px] text-[#C0392B] font-semibold mt-0.5">
              {tr('متأخر السداد')}: <span dir="ltr" className="tabular-nums">{formatCurrency(bt.overdue)}</span> ({formatNumber(bt.overdueCount)} {tr('فاتورة')})
            </p>
          )}
        </div>

        {/* البيانات — ما حُفظ منها وحده، فلا صفوف «—» تملأ الشاشة */}
        {(s.phone || s.email || s.city || s.address || s.crNumber || s.vatNumber || s.paymentDays != null || s.bankName || s.iban || s.notes) && (
          <MCard>
            {s.phone && <InfoLine label={tr('الجوال')} value={s.phone} href={tel ?? undefined} icon={tel ? Phone : undefined} ltr />}
            {s.email && <InfoLine label={tr('البريد الإلكتروني')} value={s.email} ltr />}
            {(s.city || s.address) && <InfoLine label={tr('العنوان')} value={[s.city, s.address].filter(Boolean).join(' — ')} />}
            {s.crNumber && <InfoLine label={tr('السجل التجاري')} value={s.crNumber} ltr />}
            {!taxOff && s.vatNumber && <InfoLine label={tr('الرقم الضريبي')} value={s.vatNumber} ltr />}
            {s.paymentDays != null && (
              <InfoLine label={tr('مدة السداد')} value={s.paymentDays > 0 ? `${formatNumber(s.paymentDays)} ${tr('يوم')}` : tr('مستحقة في تاريخ الفاتورة')} />
            )}
            {s.bankName && <InfoLine label={tr('اسم البنك')} value={s.bankName} />}
            {s.iban && <InfoLine label="IBAN" value={s.iban} ltr />}
            {s.notes && <InfoLine label={tr('ملاحظات')} value={s.notes} />}
          </MCard>
        )}

        <div className="grid grid-cols-3 gap-1 bg-[#F1EBDF] rounded-xl p-1">
          {TABS.map(t => (
            <button key={t.id} type="button" onClick={() => setTab(t.id)}
              className={`text-[11px] font-semibold py-2 rounded-lg min-h-[40px] leading-tight ${tab === t.id ? 'bg-white text-[#1F1A13] shadow-sm' : 'text-[#6E6557]'}`}>
              {tr(t.label)}
            </button>
          ))}
        </div>

        {tab === 'statement' ? (
          <StatementTab q={statementQ} from={from} to={to} setFrom={setFrom} setTo={setTo} badRange={badRange}
            decimals={decimals} onShare={() => setDoc(true)} onOpenPayment={setPaymentId} onOpenAtts={setAtts} />
        ) : tab === 'bills' ? (
          <BillsTab q={billsQ} total={bt?.outstanding ?? 0} onPay={bill => setPay({ preset: { billId: bill.warehouseEntryId, amount: bill.outstanding } })} />
        ) : (
          <PaymentsTab q={paymentsQ} onOpen={setPaymentId} />
        )}
        <div className="h-2" />
      </div>

      <div className="flex-shrink-0 border-t border-[#E9E1D3] bg-white p-3"
        style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))' }}>
        <button type="button" onClick={() => setPay({ preset: null })}
          className="w-full bg-[#E15A30] text-white font-bold py-3.5 rounded-xl min-h-[50px] flex items-center justify-center gap-2">
          <Plus size={17} /> {tr('سند صرف جديد')}
        </button>
      </div>
    </div>
  );
}

// ═══ كشف الحساب ═══

function StatementTab({ q, from, to, setFrom, setTo, badRange, decimals, onShare, onOpenPayment, onOpenAtts }: {
  q: { data?: SupplierStatement; isLoading: boolean; isError: boolean; refetch: () => unknown };
  from: string; to: string; setFrom: (v: string) => void; setTo: (v: string) => void; badRange: boolean;
  decimals: number;
  onShare: () => void;
  onOpenPayment: (id: string) => void;
  onOpenAtts: (line: SupplierStatementLine) => void;
}) {
  const tr = useTr();
  const rangeOn = !!(from || to);
  const st = q.data;
  const cur = st?.currency || undefined;
  const lines = st?.lines ?? [];
  const closing = st ? balanceState(st.closing, decimals) : null;

  return (
    <div className="space-y-3">
      <MCard className="p-3 space-y-2">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-[11px] text-[#9A8F7E] block mb-1">{tr('من تاريخ')}</label>
            <input type="date" value={from} max={to || undefined} onChange={e => setFrom(e.target.value)}
              className="w-full rounded-xl border border-[#E9E1D3] px-2.5 py-2 text-xs bg-white" />
          </div>
          <div>
            <label className="text-[11px] text-[#9A8F7E] block mb-1">{tr('إلى تاريخ')}</label>
            <input type="date" value={to} min={from || undefined} onChange={e => setTo(e.target.value)}
              className="w-full rounded-xl border border-[#E9E1D3] px-2.5 py-2 text-xs bg-white" />
          </div>
        </div>
        <div className="flex items-center justify-between gap-2 min-h-[32px]">
          {rangeOn ? (
            <button type="button" onClick={() => { setFrom(''); setTo(''); }} className="text-[11px] font-semibold text-[#C94E28]">
              {tr('إلغاء التصفية')}
            </button>
          ) : <span />}
          {/* المشاركة بعد وصول البيانات وحدها: ورقةٌ تُبنى من لا شيء تعطي كشفاً فارغاً باسم المورّد */}
          {st && !badRange && (
            <button type="button" onClick={onShare}
              className="text-[11px] font-semibold text-[#1F1A13] bg-[#F1EBDF] rounded-full px-3 py-1.5 flex items-center gap-1.5 min-h-[32px]">
              <Share2 size={13} /> {tr('مشاركة / طباعة')}
            </button>
          )}
        </div>
        {badRange && <p className="text-[11px] text-[#C0392B] font-semibold">{tr('بداية الفترة بعد نهايتها')}</p>}
      </MCard>

      {badRange ? null
        : q.isLoading ? <MSpinner />
        : q.isError ? <MError onRetry={() => q.refetch()} text={tr('تعذر فتح كشف حساب المورد')} />
        : !st ? null
        : (
          <>
            {/* الرصيد المرحَّل حين تُحدَّد بداية — ما قبلها لا يُطوى بصمت */}
            {from && (
              <div className="flex items-center justify-between gap-2 rounded-xl bg-[#F1EBDF] px-3 py-2.5">
                <span className="text-[11px] text-[#6E6557]">{tr('رصيد مرحل من قبل الفترة')}</span>
                <span className="text-sm font-bold text-[#1F1A13] tabular-nums" dir="ltr">{formatCurrency(st.opening, cur)}</span>
              </div>
            )}

            {lines.length === 0 ? (
              <div className="py-10"><MEmpty icon={BookOpen} text={rangeOn ? tr('لا حركات في هذا المدى') : tr('لا حركات بعد')} /></div>
            ) : lines.map(l => (
              <StatementLineCard key={l.id} l={l} cur={cur} onOpenPayment={onOpenPayment} onOpenAtts={onOpenAtts} />
            ))}

            {lines.length > 0 && (
              <MCard className="p-3 space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-[#6E6557]">{tr('مجموع المدين')}</span>
                  <span className="font-bold text-[#2F855A] tabular-nums" dir="ltr">{formatCurrency(st.totalDebit, cur)}</span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-[#6E6557]">{tr('مجموع الدائن')}</span>
                  <span className="font-bold text-[#C94E28] tabular-nums" dir="ltr">{formatCurrency(st.totalCredit, cur)}</span>
                </div>
                <div className="flex items-center justify-between text-sm pt-1.5 border-t border-[#F1EBDF]">
                  {/* «الحالي» يصدق بلا نهايةٍ للمدّة وحدها: مع «إلى» هذا رصيد آخر يومٍ فيها */}
                  <span className="font-semibold text-[#1F1A13]">{to ? tr('رصيد نهاية الفترة') : tr('الرصيد الحالي')}</span>
                  <span className="font-extrabold text-[#1F1A13] tabular-nums" dir="ltr">{formatCurrency(st.closing, cur)}</span>
                </div>
                {closing && <p className="text-[11px] text-[#6E6557] text-end">{tr(BALANCE_LABELS[closing.state])}</p>}
              </MCard>
            )}
            <p className="text-[10px] text-[#9A8F7E] px-1 leading-relaxed">
              {tr('الدائن يزيد المستحق للمورد فواتير وإلغاء سندات والمدين ينقصه سندات صرف ومرتجعات والرصيد الموجب مستحق له')}
            </p>
          </>
        )}
    </div>
  );
}

function StatementLineCard({ l, cur, onOpenPayment, onOpenAtts }: {
  l: SupplierStatementLine; cur?: string;
  onOpenPayment: (id: string) => void;
  onOpenAtts: (line: SupplierStatementLine) => void;
}) {
  const tr = useTr();
  const k = ledgerKindOf(l.kind);
  const t = TONE[k.tone];
  const Icon = t.icon;
  const opens = lineOpensPayment(l);
  const atts = l.attachmentsCount > 0 && !!l.warehouseEntryId;
  return (
    <MCard className="p-3 space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className={`flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full ${t.cls}`}>
          <Icon size={12} />{tr(k.label)}
        </span>
        <span className="text-[11px] text-[#9A8F7E]">{formatDayOnly(l.date)}</span>
      </div>
      {/* بيان الخادم يحمل المرجع غالباً («سند صرف SP-000012 — نقدي») — فلا يُكرَّر سطراً ثانياً */}
      {l.description && <p className="text-xs text-[#1F1A13]">{l.description}</p>}
      {l.ref && !(l.description ?? '').includes(l.ref) && <p className="text-[11px] text-[#9A8F7E]" dir="ltr">{l.ref}</p>}
      {l.kind === 'BILL' && l.dueDate && l.dueDate !== l.date && (
        <p className="text-[11px] text-[#6E6557]">{tr('يستحق')} {formatDayOnly(l.dueDate)}</p>
      )}
      <div className="flex items-center justify-between gap-2 pt-1.5 border-t border-[#F1EBDF]">
        <span className="text-[11px]">
          {l.debit > 0 && <span className="text-[#2F855A] font-semibold">{tr('مدين')} <span dir="ltr" className="tabular-nums">{formatCurrency(l.debit, cur)}</span></span>}
          {l.credit > 0 && <span className="text-[#C94E28] font-semibold">{tr('دائن')} <span dir="ltr" className="tabular-nums">{formatCurrency(l.credit, cur)}</span></span>}
        </span>
        <span className="text-xs font-bold text-[#1F1A13] whitespace-nowrap">
          {tr('الرصيد')}: <span dir="ltr" className="tabular-nums">{formatCurrency(l.balance, cur)}</span>
        </span>
      </div>
      {/* أزرارٌ صريحة لا بطاقةٌ قابلة للنقر: زرٌّ داخل زرّ لا يصحّ، والمرفقات والسند فعلان مختلفان */}
      {(opens || atts) && (
        <div className="flex items-center gap-2 pt-1">
          {opens && l.supplierPaymentId && (
            <button type="button" onClick={() => onOpenPayment(l.supplierPaymentId as string)}
              className="text-[11px] font-semibold text-[#C94E28] bg-[#FBEBE2] rounded-full px-3 py-1.5 min-h-[32px] flex items-center gap-1">
              {tr('عرض السند')} <ChevronLeft size={12} />
            </button>
          )}
          {atts && (
            <button type="button" onClick={() => onOpenAtts(l)}
              className="text-[11px] font-semibold text-[#1F1A13] bg-[#F1EBDF] rounded-full px-3 py-1.5 min-h-[32px] flex items-center gap-1">
              <Paperclip size={12} /> {tr('فاتورة المشتريات')} ({formatNumber(l.attachmentsCount)})
            </button>
          )}
        </div>
      )}
    </MCard>
  );
}

// ═══ الفواتير المفتوحة ═══

function BillsTab({ q, total, onPay }: {
  q: { data?: OpenBill[]; isLoading: boolean; isError: boolean; refetch: () => unknown };
  total: number;
  onPay: (bill: OpenBill) => void;
}) {
  const tr = useTr();
  if (q.isLoading) return <MSpinner />;
  if (q.isError) return <MError onRetry={() => q.refetch()} text={tr('تعذر تحميل الفواتير المفتوحة')} />;
  const bills = q.data ?? [];
  if (!bills.length) return <div className="py-10"><MEmpty icon={Receipt} text={tr('لا فواتير آجلة مفتوحة لهذا المورد')} /></div>;
  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between gap-2 rounded-xl bg-[#F1EBDF] px-3 py-2.5">
        <span className="text-[11px] text-[#6E6557]">{tr('إجمالي المتبقي')} ({formatNumber(bills.length)})</span>
        <span className="text-sm font-bold text-[#1F1A13] tabular-nums" dir="ltr">{formatCurrency(total)}</span>
      </div>
      {bills.map(b => (
        <MCard key={b.warehouseEntryId} className="p-3 space-y-2">
          <div className="flex items-start justify-between gap-2">
            <span className="min-w-0">
              <span className="block text-sm font-semibold text-[#1F1A13] truncate" dir="auto">{b.supplierRef || tr('بلا رقم فاتورة')}</span>
              <span className="block text-[11px] text-[#9A8F7E]">{tr('تاريخ الفاتورة')} {formatDayOnly(b.billDate)}</span>
            </span>
            {b.daysOverdue > 0 ? (
              <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-[#FDF2F0] text-[#C0392B] whitespace-nowrap">
                {tr('أيام التأخير')}: {formatNumber(b.daysOverdue)}
              </span>
            ) : (
              <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-[#F1EBDF] text-[#6E6557] whitespace-nowrap">
                {tr('يستحق')} {formatDayOnly(b.dueDate)}
              </span>
            )}
          </div>
          <div className={`grid gap-2 text-[11px] ${b.returned > 0 ? 'grid-cols-3' : 'grid-cols-2'}`}>
            <Amount label={tr('الإجمالي')} value={b.total} />
            <Amount label={tr('المدفوع')} value={b.paid} />
            {b.returned > 0 && <Amount label={tr('المرتجع')} value={b.returned} />}
          </div>
          <div className="flex items-center justify-between gap-2 pt-2 border-t border-[#F1EBDF]">
            <span className="text-xs text-[#6E6557]">
              {tr('المتبقي')}: <b className="text-[#C94E28] tabular-nums" dir="ltr">{formatCurrency(b.outstanding)}</b>
            </span>
            <button type="button" onClick={() => onPay(b)}
              className="text-xs font-bold text-white bg-[#2F855A] rounded-xl px-4 py-2 min-h-[36px]">
              {tr('سداد')}
            </button>
          </div>
        </MCard>
      ))}
    </div>
  );
}

function Amount({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg bg-[#FAF7F0] px-2 py-1.5">
      <p className="text-[#9A8F7E]">{label}</p>
      <p className="font-bold text-[#1F1A13] tabular-nums" dir="ltr">{formatCurrency(value)}</p>
    </div>
  );
}

// ═══ سندات الصرف ═══

function PaymentsTab({ q, onOpen }: {
  q: {
    data?: { pages: { items: SupplierPaymentView[]; total: number }[] };
    isLoading: boolean; isError: boolean; refetch: () => unknown;
    hasNextPage: boolean; isFetchingNextPage: boolean; fetchNextPage: () => unknown;
  };
  onOpen: (id: string) => void;
}) {
  const tr = useTr();
  const rows = useMemo(() => q.data?.pages.flatMap(p => p.items) ?? [], [q.data]);
  if (q.isLoading) return <MSpinner />;
  if (q.isError) return <MError onRetry={() => q.refetch()} text={tr('تعذر تحميل سندات الصرف')} />;
  if (!rows.length) return <div className="py-10"><MEmpty icon={Wallet} text={tr('لا سندات صرف لهذا المورد بعد')} /></div>;
  return (
    <div className="space-y-2.5">
      <MCard>
        {rows.map(p => {
          const cancelled = p.status === 'CANCELLED';
          return (
            <MRow key={p.id} onClick={() => onOpen(p.id)}
              title={<span dir="ltr">{p.displayNumber}</span>}
              subtitle={[formatDayOnly(p.paidAt), tr(payMethodLabel(p.method)), p.method === 'REP_CUSTODY' ? p.salesRepName : null].filter(Boolean).join(' · ')}
              note={p.autoForEntryId ? tr('سند آلي لشراء نقدي') : undefined}
              trailing={
                <span className="flex items-center gap-1 flex-shrink-0">
                  <span className="text-end">
                    <span className={`block text-xs font-bold tabular-nums whitespace-nowrap ${cancelled ? 'text-[#C0392B] line-through' : 'text-[#1F1A13]'}`} dir="ltr">
                      {formatCurrency(p.amount)}
                    </span>
                    {cancelled && <span className="block text-[10px] text-[#C0392B] font-semibold">{tr('ملغى')}</span>}
                  </span>
                  <ChevronLeft size={15} className="text-[#C9BFB0]" />
                </span>
              } />
          );
        })}
      </MCard>
      {q.hasNextPage && (
        <button type="button" onClick={() => q.fetchNextPage()} disabled={q.isFetchingNextPage}
          className="w-full bg-white border border-[#E9E1D3] text-[#1F1A13] font-semibold text-sm py-3 rounded-xl min-h-[44px] disabled:opacity-60">
          {q.isFetchingNextPage ? tr('جاري التحميل') : tr('تحميل المزيد')}
        </button>
      )}
    </div>
  );
}

function InfoLine({ label, value, href, icon: Icon, ltr = false }: {
  label: string; value: string; href?: string; icon?: LucideIcon; ltr?: boolean;
}) {
  const body = (
    <div className="flex items-center gap-3 px-3.5 py-2.5 min-h-[44px]">
      <span className="text-[11px] text-[#9A8F7E] w-24 flex-shrink-0">{label}</span>
      <span className={`text-sm flex-1 break-words flex items-center gap-1.5 ${href ? 'text-[#E15A30] font-semibold' : 'text-[#1F1A13]'}`}
        dir={ltr ? 'ltr' : 'auto'}>
        {Icon && <Icon size={13} />}{value}
      </span>
    </div>
  );
  if (href) return <a href={href} className="block border-b border-[#F1EBDF] last:border-0 active:bg-[#FAF7F0]">{body}</a>;
  return <div className="border-b border-[#F1EBDF] last:border-0">{body}</div>;
}

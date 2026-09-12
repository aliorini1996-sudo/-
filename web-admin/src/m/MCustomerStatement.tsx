import { useState, lazy, Suspense } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FileDown, Receipt, Wallet, RotateCcw, BookOpen, Scale } from 'lucide-react';
import { customerApi } from '../api/client';
import { AccountEntry, Customer } from '../types';
import { formatCurrency, formatDate, formatNumber } from '../utils/format';
import { useTr } from '../i18n/strings';
import { useBackClose } from '../lib/useBackClose';
import { MCard, MScreen, MHeader, MEmpty, MError, MSpinner } from './mobileUi';
import { expectObject } from './shape';

/* المستند في حزمة مستقلّة — يجرّ jspdf وhtml2canvas وqrcode معه */
const MStatementDoc = lazy(() => import('./MStatementDoc'));

/**
 * كشف حساب العميل في تطبيق الإدارة — نظير نافذة اللوحة.
 *
 * لماذا بطاقاتٌ لا جدول: كشف اللوحة سبعة أعمدة (تاريخ · بيان · أصناف · مستند ·
 * مدين · دائن · رصيد)، ولا يُقرأ منها على ٣٦٠px إلّا عمودان. فالبطاقة تقلب
 * الاتجاه: حركةٌ واحدة في الشاشة، ورقمها أوّل ما تقع عليه العين.
 *
 * وثلاثة أشياء تجعل الكشف صادقاً، وكلّها مقصودة:
 *  · **الرصيد المرحَّل** يُعرض حين تُحدَّد بداية للمدّة — كشفٌ يبدأ من الصفر
 *    وللعميل رصيدٌ سابق يقرأه صاحبه على أنّه كلّ ما عليه.
 *  · **طرفا المدّة مستقلّان**: «من ١ يناير» بلا «إلى» تصفيةٌ صحيحة لا إلغاء.
 *  · **والمدّة تُطبع في المستند**: جزءٌ بلا حدوده يُقرأ كلّاً.
 */

interface StatementData {
  customer: Customer;
  entries: AccountEntry[];
  openingBalance: number;
  closingBalance: number;
}

/**
 * أنواع قيود الحساب **الستّة** كما يكتبها الخادم — لا ثلاثة.
 *
 * الثلاثة المنسيّة ليست نادرة: `RECEIPT_DEBIT` يُكتب عند إلغاء سند قبض أو عكس
 * تحصيل فاتورةٍ نقدية، و`ADJUSTMENT_*` يُكتبان لكلّ **رصيدٍ افتتاحيّ مستورد** —
 * أي في أوّل سطرٍ من كشف كلّ عميلٍ رُحّل رصيده عند الانضمام. وسقوطها إلى الفرع
 * الافتراضي كان يُظهر «RECEIPT_DEBIT» إنجليزيّةً في كشفٍ عربيّ يُطبع للعميل.
 *
 * و`INVOICE_CREDIT` لفظُه محايد عمداً: يكتبه الخادم للمرتجع **وللإلغاء** معاً
 * (اقرأ `accounting.ts`)، وتسميته «مرتجع» وحدها تكذب على نصف صفوفه. والسطر
 * تحته يحمل بيان الخادم فيفصّل أيّهما.
 */
const KIND: Record<string, { label: string; cls: string; icon: React.ElementType }> = {
  INVOICE_DEBIT: { label: 'فاتورة', cls: 'text-[#C94E28] bg-[#FBEBE2]', icon: Receipt },
  INVOICE_CREDIT: { label: 'إلغاء أو مرتجع', cls: 'text-[#2B6CB0] bg-[#EBF2FA]', icon: RotateCcw },
  RECEIPT_CREDIT: { label: 'تحصيل', cls: 'text-[#2F855A] bg-[#EAF6F0]', icon: Wallet },
  RECEIPT_DEBIT: { label: 'عكس تحصيل', cls: 'text-[#B7791F] bg-[#FDF6E7]', icon: RotateCcw },
  ADJUSTMENT_DEBIT: { label: 'تسوية', cls: 'text-[#6E6557] bg-[#F1EBDF]', icon: Scale },
  ADJUSTMENT_CREDIT: { label: 'تسوية', cls: 'text-[#6E6557] bg-[#F1EBDF]', icon: Scale },
};

export default function MCustomerStatement({ customer, company, repName, onClose }: {
  customer: Customer;
  /** إعدادات الشركة لترويسة المستند */
  company: unknown;
  /** اسم من يُصدر الكشف — يظهر في المستند */
  repName: string;
  onClose: () => void;
}) {
  const tr = useTr();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [pdf, setPdf] = useState(false);
  const rangeOn = !!(from || to);

  useBackClose(pdf, () => setPdf(false));

  const q = useQuery({
    queryKey: ['m-statement', customer.id, from, to],
    queryFn: async () => {
      /* كلٌّ على حدة: إرسالهما معاً أو لا شيء كان يُلغي «من ١ يناير» بصمت،
       * فيقرأ المستخدم كشفاً كاملاً وهو يظنّه مقصوراً على فترته. */
      const params: Record<string, string> = {};
      if (from) params.from = from;
      if (to) params.to = to;
      return expectObject<StatementData>(
        (await customerApi.statement(customer.id, Object.keys(params).length ? params : undefined)).data?.data,
        tr('كشف حساب'));
    },
  });

  const entries = q.data?.entries ?? [];
  const totalDebit = entries.reduce((s, e) => s + Number(e.debit), 0);
  const totalCredit = entries.reduce((s, e) => s + Number(e.credit), 0);

  if (pdf && q.data) {
    return (
      <Suspense fallback={<MSpinner />}>
        <MStatementDoc
          customer={q.data.customer}
          entries={entries}
          repName={repName}
          company={company}
          range={{
            from: from || undefined, to: to || undefined,
            openingBalance: q.data.openingBalance, closingBalance: q.data.closingBalance,
          }}
          onClose={() => setPdf(false)} />
      </Suspense>
    );
  }

  return (
    <MScreen header={
      <MHeader title={tr('كشف حساب')} subtitle={customer.name} onBack={onClose}
        action={
          /* التصدير لا يظهر قبل وصول البيانات: زرٌّ يبني مستنداً من لا شيء
             يعطي ورقةً فارغة باسم العميل، وهي أسوأ من غياب الزرّ. */
          q.data ? (
            <button onClick={() => setPdf(true)} className="p-2 text-[#9A8F7E] hover:text-white"
              aria-label={tr('تصدير PDF')} title={tr('تصدير PDF')}>
              <FileDown size={18} />
            </button>
          ) : undefined
        } />
    }>
      <div className="bg-[#FAF7F0] min-h-full p-3 space-y-3">
        {/* المدّة — تدخل مفتاح الاستعلام فيُعاد الجلب من الخادم */}
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
          {rangeOn && (
            <button type="button" onClick={() => { setFrom(''); setTo(''); }}
              className="text-[11px] font-semibold text-[#C94E28]">{tr('إلغاء التصفية')}</button>
          )}
        </MCard>

        {q.isLoading ? <MSpinner />
          : q.isError ? <MError onRetry={() => q.refetch()} text={tr('تعذر فتح كشف حساب العميل')} />
          : !q.data ? null
          : (
            <>
              {/* الرصيد المرحَّل: يُعرض حين تُحدَّد بداية — ما قبلها لا يُطوى بصمت */}
              {from && (
                <div className="flex items-center justify-between gap-2 rounded-xl bg-[#F1EBDF] px-3 py-2.5">
                  <span className="text-[11px] text-[#6E6557]">{tr('رصيد مرحل من قبل الفترة')}</span>
                  <span className="text-sm font-bold text-[#1F1A13]">{formatCurrency(q.data.openingBalance)}</span>
                </div>
              )}

              {entries.length === 0 ? (
                <div className="py-10">
                  <MEmpty icon={BookOpen} text={rangeOn ? tr('لا حركات في هذا المدى') : tr('لا حركات بعد')} />
                </div>
              ) : entries.map(e => {
                const k = KIND[e.type] ?? { label: e.type, cls: 'text-[#6E6557] bg-[#F1EBDF]', icon: BookOpen };
                const Icon = k.icon;
                /* أصناف الفاتورة لا تُعرض على قيد التحصيل النقديّ: الفاتورة
                 * النقدية تُولّد قيدين بنفس `invoiceId` (بيع وتحصيل)، فعرضُها
                 * على الاثنين يُظهر البضاعة مرّتين في كشفٍ واحد. وهي القاعدة
                 * نفسها التي يتبعها بناء المستند حرفاً. */
                const items = e.type === 'RECEIPT_CREDIT' ? [] : (e.invoice?.items ?? []);
                return (
                  <MCard key={e.id} className="p-3 space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className={`flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full ${k.cls}`}>
                        <Icon size={12} />{tr(k.label)}
                      </span>
                      <span className="text-[11px] text-[#9A8F7E]">{formatDate(e.entryDate)}</span>
                    </div>

                    <p className="text-xs text-[#1F1A13]">{e.description}</p>
                    {(e.invoice?.number || e.receipt?.number) && (
                      <p className="text-[11px] text-[#9A8F7E]" dir="ltr">{e.invoice?.number || e.receipt?.number}</p>
                    )}

                    {/* أصناف الفاتورة — تُختصر إلى ثلاثة ثمّ «و٤ أخرى»: بطاقةٌ
                        بعشرين صنفاً تدفع بقيّة الكشف خارج الشاشة */}
                    {items.length > 0 && (
                      <p className="text-[11px] text-[#6E6557] leading-relaxed">
                        {items.slice(0, 3).map(it => `${it.product.name} ×${formatNumber(Number(it.qty))}`).join(' · ')}
                        {/* مفتاحٌ واحد لا شظايا: «و» و«أخرى» منفصلين لا يُترجمان */}
                        {items.length > 3 && ` · +${formatNumber(items.length - 3)} ${tr('أصناف أخرى')}`}
                      </p>
                    )}

                    <div className="flex items-center justify-between gap-2 pt-1.5 border-t border-[#F1EBDF]">
                      <span className="text-[11px]">
                        {Number(e.debit) > 0 && <span className="text-[#C94E28] font-semibold">{tr('مدين')} {formatCurrency(e.debit)}</span>}
                        {Number(e.credit) > 0 && <span className="text-[#2F855A] font-semibold">{tr('دائن')} {formatCurrency(e.credit)}</span>}
                      </span>
                      <span className="text-xs font-bold text-[#1F1A13] whitespace-nowrap">
                        {tr('الرصيد')}: {formatCurrency(e.balance)}
                      </span>
                    </div>
                  </MCard>
                );
              })}

              {/* الإجمالي — أسفل الحركات كما في الكشف المطبوع */}
              {entries.length > 0 && (
                <MCard className="p-3 space-y-1.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-[#6E6557]">{tr('مجموع المدين')}</span>
                    <span className="font-bold text-[#C94E28]">{formatCurrency(totalDebit)}</span>
                  </div>
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-[#6E6557]">{tr('مجموع الدائن')}</span>
                    <span className="font-bold text-[#2F855A]">{formatCurrency(totalCredit)}</span>
                  </div>
                  <div className="flex items-center justify-between text-sm pt-1.5 border-t border-[#F1EBDF]">
                    {/* «الحالي» يصدق بلا تصفية وحدها: مع مدّةٍ مُصفّاة هذا رصيد
                        آخر يومٍ فيها لا رصيد اليوم */}
                    <span className="font-semibold text-[#1F1A13]">{rangeOn ? tr('رصيد نهاية الفترة') : tr('الرصيد الحالي')}</span>
                    <span className="font-extrabold text-[#1F1A13]">{formatCurrency(q.data.closingBalance)}</span>
                  </div>
                </MCard>
              )}
            </>
          )}

        <div className="h-2" />
      </div>
    </MScreen>
  );
}

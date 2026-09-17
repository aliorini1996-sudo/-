import { useState, useEffect, useRef, useCallback, lazy, Suspense } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search, Plus, Phone, MapPin, Pencil, ChevronLeft, FileText, Wallet, BookOpen } from 'lucide-react';
import { customerApi } from '../api/client';
import { Customer } from '../types';
import { formatCurrency } from '../utils/format';
import { channelLabel } from '../lib/channels';
import { useLang } from '../i18n/lang';
import { useTr } from '../i18n/strings';
import { useAuthStore } from '../store/authStore';
import { useBackClose } from '../lib/useBackClose';
import { MCard, MRow, MHeader, MEmpty, MError, MSpinner } from './mobileUi';
import MCustomerForm from './MCustomerForm';
import { can } from './perms';
import { expectArray, expectObject } from './shape';
import { zatcaCollectOn, type ZatcaCompanyLike } from '../lib/zatcaRegime';
import { BuyerRowLike, customerBuyerStatus, missingBuyerFormFields } from '../lib/zatca/buyerData';
import { BUYER_CLASSIFICATION_LABELS_AR, BUYER_FIELD_UI_LABELS_AR as BUYER_FIELD_LABELS_AR, buyerBadge } from '../lib/zatca/buyerForm';

const MInvoiceCreate = lazy(() => import('./MInvoiceCreate'));
const MReceiptCreate = lazy(() => import('./MReceiptCreate'));
/* الكشف في حزمة مستقلّة: لا يُفتح في كل زيارةٍ لملفّ عميل، ويجرّ معه مستند
 * الطباعة (jspdf) حين يُصدَّر */
const MCustomerStatement = lazy(() => import('./MCustomerStatement'));

const PAGE = 30;

/**
 * تبويب العملاء — قائمة بطاقات بتحميل تراكميّ، وتفاصيل ملء الشاشة، ونموذج
 * إنشاء/تعديل.
 *
 * التحميل تراكميّ لا مُرقَّم: الترقيم على الجوال يعني ضغطاتٍ صغيرة متكرّرة،
 * والتمرير أطبعُ للإبهام.
 */
export default function MCustomers({ accountingOn = true, company }: {
  /** «النظام المحاسبي» مفعّل للشركة؟ حين يكون false يسقط كل رقمٍ ماليّ عن
   *  العميل (الرصيد والحدّ الائتمانيّ ومدة السداد والمبيعات والتحصيل) ويسقط
   *  معه بابا «فاتورة جديدة» و«سند قبض». */
  accountingOn?: boolean;
  /** إعدادات الشركة — لترويسة كشف الحساب المطبوع وحدها */
  company?: unknown;
}) {
  const tr = useTr();
  const [q, setQ] = useState('');
  const [dq, setDq] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const [detail, setDetail] = useState<Customer | null>(null);
  const [editing, setEditing] = useState<Customer | null | undefined>(undefined); // undefined = مغلق، null = جديد
  // ⚠️ الشرط `!== undefined` لا `!!editing`: القيمة null تعني «عميل جديد» وهي مفتوحة
  useBackClose(editing !== undefined, () => setEditing(undefined));
  useBackClose(editing === undefined && !!detail, () => setDetail(null));
  const listRef = useRef<HTMLDivElement>(null);
  // فوترة ZATCA (Z5.1a، D2): شارة وفلتر «بيانات فوترة ناقصة» للشركة التي تجمع بيانات الفوترة وحدها — غيرها كما اليوم
  // والمحاسبة مفعّلة: بلاها لا فاتورة تُصدر من /m ولا قسم بيانات فوترة في نموذجه — فلا شريحة ولا شارة بلا حقول تُكملها
  const zatcaCollect = accountingOn && zatcaCollectOn(company as ZatcaCompanyLike | null);
  const [onlyIncomplete, setOnlyIncomplete] = useState(false);
  const incompleteMode = zatcaCollect && onlyIncomplete;

  useEffect(() => { const t = setTimeout(() => { setDq(q.trim()); setLimit(PAGE); }, 300); return () => clearTimeout(t); }, [q]);

  const listQ = useQuery({
    queryKey: ['m-customers', dq, limit],
    queryFn: async () => expectArray<Customer>((await customerApi.list({ search: dq, limit })).data?.data, 'العملاء'),
    enabled: !incompleteMode,
  });
  // القائمة من الخادم (لا من الصفحات المحمّلة): صفوف بلا حقول مالية — فتح أحدها يجلب العميل كاملاً
  const incompleteQ = useQuery({
    queryKey: ['m-customers', 'zatca-buyer', dq],
    queryFn: async () => expectArray<Customer>((await customerApi.buyerData({ bucket: 'incomplete', search: dq, limit: 200, summary: '0' })).data?.data, 'العملاء'),
    enabled: incompleteMode,
  });
  const summaryQ = useQuery({
    queryKey: ['m-customers', 'zatca-buyer-summary'],
    queryFn: async () => ((await customerApi.buyerData({ limit: 0 })).data?.summary ?? null) as { incomplete: number } | null,
    enabled: zatcaCollect,
    staleTime: 60_000,
  });
  const shownQ = incompleteMode ? incompleteQ : listQ;
  const openRow = async (c: Customer) => {
    if (!incompleteMode) { setDetail(c); return; }
    try { setDetail(expectObject<Customer>((await customerApi.get(c.id)).data?.data, 'العميل')); } catch { /* يبقى في القائمة */ }
  };

  // تمرير قريب من القاع ⇒ صفحة أخرى (بلا زرّ «المزيد»)
  const onScroll = useCallback(() => {
    const el = listRef.current;
    if (!el || listQ.isFetching || incompleteMode) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 160
        && (listQ.data?.length ?? 0) >= limit) setLimit(l => l + PAGE);
  }, [listQ.isFetching, listQ.data, limit, incompleteMode]);

  if (editing !== undefined) {
    return (
      <MCustomerForm customer={editing} accountingOn={accountingOn} zatcaCollect={zatcaCollect} onClose={() => setEditing(undefined)}
        onSaved={(c) => { setEditing(undefined); setDetail(c); }} />
    );
  }

  if (detail) {
    return (
      <MCustomerDetail customer={detail} accountingOn={accountingOn} zatcaCollect={zatcaCollect} company={company}
        onClose={() => setDetail(null)} onEdit={() => setEditing(detail)} />
    );
  }

  return (
    <div className="h-full flex flex-col bg-[#FAF7F0]">
      {/* البحث — على الخادم لا محلياً، فيصل لأي عميل مهما طالت القائمة */}
      <div className="flex-shrink-0 p-3 pb-2 flex items-center gap-2">
        <div className="relative flex-1">
          <Search size={15} className="absolute top-1/2 -translate-y-1/2 start-3 text-[#9A8F7E]" />
          <input value={q} onChange={e => setQ(e.target.value)} className="input ps-9"
            placeholder={tr('ابحث باسم أو جوال أو كود')} />
        </div>
        <button onClick={() => setEditing(null)}
          className="w-11 h-11 rounded-xl bg-[#E15A30] text-white flex items-center justify-center flex-shrink-0"
          aria-label={tr('عميل جديد')}>
          <Plus size={20} />
        </button>
      </div>
      {zatcaCollect && (
        <div className="flex-shrink-0 px-3 pb-2">
          <button onClick={() => setOnlyIncomplete(v => !v)}
            className={`text-xs px-3 py-1.5 rounded-full border ${onlyIncomplete ? 'bg-amber-600 text-white border-amber-600' : 'bg-amber-50 text-amber-800 border-amber-200'}`}>
            {tr('بيانات فوترة ناقصة')}{summaryQ.data ? ` (${summaryQ.data.incomplete})` : ''}
          </button>
        </div>
      )}

      <div ref={listRef} onScroll={onScroll} className="flex-1 overflow-y-auto overscroll-contain px-3 pb-3">
        {shownQ.isLoading ? <MSpinner />
          : shownQ.isError ? <MError onRetry={() => shownQ.refetch()} />
          : !shownQ.data?.length ? <MEmpty text={dq ? tr('لا نتائج') : incompleteMode ? tr('لا يوجد عملاء ببيانات فوترة ناقصة') : tr('لا يوجد عملاء بعد')} />
          : (
            <MCard>
              {shownQ.data.map(c => (
                <CustomerRow key={c.id} c={c} accountingOn={accountingOn && !incompleteMode} zatcaCollect={zatcaCollect} onOpen={() => openRow(c)} />
              ))}
            </MCard>
          )}
        {shownQ.isFetching && !shownQ.isLoading && (
          <p className="text-center text-[11px] text-[#9A8F7E] py-3">{tr('جاري التحميل')}</p>
        )}
      </div>
    </div>
  );
}

function CustomerRow({ c, accountingOn, zatcaCollect = false, onOpen }: {
  c: Customer; accountingOn: boolean; zatcaCollect?: boolean; onOpen: () => void;
}) {
  const tr = useTr();
  const over = c.creditLimit > 0 && c.balance > c.creditLimit;
  const badge = zatcaCollect ? buyerBadge(c as BuyerRowLike) : null;
  return (
    <MRow
      onClick={onOpen}
      leading={
        <span className="w-9 h-9 rounded-full bg-[#FBEBE2] text-[#C94E28] flex items-center justify-center text-sm font-bold flex-shrink-0">
          {c.name?.charAt(0) || ''}
        </span>
      }
      title={c.name}
      subtitle={[c.code, c.phone, c.city].filter(Boolean).join(' · ') || tr('بلا بيانات')}
      trailing={
        <span className="flex items-center gap-1 flex-shrink-0">
          {badge && (
            <span className={`text-[10px] px-1.5 py-0.5 rounded-full whitespace-nowrap ${badge === 'incomplete' ? 'bg-amber-50 text-amber-800' : 'bg-slate-100 text-slate-600'}`}>
              {badge === 'incomplete' ? tr('بيانات فوترة ناقصة') : tr('غير مصنف')}
            </span>
          )}
          {/* الرصيد يسقط كلّه مع المفتاح — لا صفراً ولا شرطةً مكانه */}
          {accountingOn && (
            <span className={`text-xs font-bold whitespace-nowrap ${over ? 'text-[#C0392B]' : c.balance > 0 ? 'text-[#B7791F]' : 'text-[#2F855A]'}`}>
              {formatCurrency(c.balance)}
            </span>
          )}
          <ChevronLeft size={15} className="text-[#C9BFB0]" />
        </span>
      } />
  );
}

/** تفاصيل العميل — ملء الشاشة، بقيّة الحقول وأزرار الإجراءات */
function MCustomerDetail({ customer, accountingOn, zatcaCollect = false, company, onClose, onEdit }: {
  customer: Customer; accountingOn: boolean; zatcaCollect?: boolean; company?: unknown; onClose: () => void; onEdit: () => void;
}) {
  const tr = useTr();
  const lang = useLang(s => s.lang);
  const user = useAuthStore(s => s.user);
  const [doc, setDoc] = useState<'invoice' | 'receipt' | null>(null);
  const [statement, setStatement] = useState(false);
  useBackClose(!!doc, () => setDoc(null));
  useBackClose(statement, () => setStatement(false));

  /* بابا الإنشاء كانا معروضين بلا أيّ فحص — لا للصلاحية ولا للمفتاح — فيفتح
   * مستخدمٌ بلا صلاحية الفواتير شاشةَ فاتورةٍ يردّها الخادم ٤٠٣ عند الحفظ،
   * وتراها شركةٌ بلا نظام محاسبيّ أصلاً. الفحصان هنا معاً. */
  const canInvoice = accountingOn && can(user, 'canManageInvoices');
  const canReceipt = accountingOn && can(user, 'canManageReceipts');
  /* والكشف حركاتٌ ومدين ودائن ورصيد — مالٌ صراح، فيسقط مع النظام المحاسبي
   * كما تسقط بطاقات الأرصدة أعلى الشاشة. ولا صلاحيةَ ثانيةً تحرسه في الخادم
   * لمستخدم اللوحة (المندوب وحده يحتاج `canViewStatement`)، فمن بلغ ملفّ
   * العميل يقرأ كشفه. */
  const canStatement = accountingOn;

  // نجلب النسخة الحيّة: البطاقة في القائمة قد تكون قديمة بعد تعديل
  const q = useQuery({
    queryKey: ['m-customer', customer.id],
    queryFn: async () => expectObject<Customer>((await customerApi.get(customer.id)).data?.data, 'العميل'),
    initialData: customer,
  });
  const c = q.data;
  const over = c.creditLimit > 0 && c.balance > c.creditLimit;

  /* الإنشاء من داخل ملفّ العميل: العميل مُمرَّر مسبقاً فلا يُعاد اختياره.
   * والحارس مشتقٌّ لا حالة: شاشةٌ فُتحت قبل وصول إعدادات الشركة تُطوى من تلقاء
   * نفسها لحظة وصولها، بلا تحديث حالةٍ أثناء الرسم. */
  const openDoc = doc === 'invoice' ? (canInvoice ? 'invoice' : null)
    : doc === 'receipt' ? (canReceipt ? 'receipt' : null) : null;
  /* الحارس مشتقٌّ لا حالة، كنظيره أدناه: شاشةٌ فُتحت قبل وصول إعدادات الشركة
   * تُطوى من تلقاء نفسها لحظة وصولها بـ`accountingEnabled:false`. */
  if (statement && canStatement) {
    return (
      <Suspense fallback={<MSpinner />}>
        <MCustomerStatement customer={c} company={company} repName={user?.name || tr('الإدارة')}
          onClose={() => setStatement(false)} />
      </Suspense>
    );
  }
  if (openDoc) {
    return (
      <Suspense fallback={<MSpinner />}>
        {openDoc === 'invoice'
          ? <MInvoiceCreate presetCustomerId={c.id} onClose={() => setDoc(null)} onCreated={() => setDoc(null)} />
          : <MReceiptCreate presetCustomerId={c.id} onClose={() => setDoc(null)} onCreated={() => setDoc(null)} />}
      </Suspense>
    );
  }

  return (
    <div className="h-full flex flex-col bg-[#FAF7F0]">
      <MHeader title={c.name} subtitle={c.code} onBack={onClose}
        action={
          <button onClick={onEdit} className="p-2 text-[#9A8F7E] hover:text-white" aria-label={tr('تعديل')}>
            <Pencil size={18} />
          </button>
        } />

      <div className="flex-1 overflow-y-auto overscroll-contain p-3 space-y-3">
        {/* الأرقام المالية — تُحذف من الشجرة كلّها حين يُطفأ النظام المحاسبي */}
        {accountingOn && (
          <div className="grid grid-cols-2 gap-2.5">
            <div className={`rounded-2xl border p-3.5 ${over ? 'border-[#F5C6C0] bg-[#FDF2F0]' : 'border-[#F1EBDF] bg-white'}`}>
              <p className="text-[11px] text-[#9A8F7E] mb-1">{tr('الرصيد')}</p>
              <p className={`text-lg font-bold ${over ? 'text-[#C0392B]' : 'text-[#1F1A13]'}`}>{formatCurrency(c.balance)}</p>
              {over && <p className="text-[10px] text-[#C0392B] mt-1">{tr('تجاوز الحد الائتماني')}</p>}
            </div>
            <div className="rounded-2xl border border-[#F1EBDF] bg-white p-3.5">
              <p className="text-[11px] text-[#9A8F7E] mb-1">{tr('الحد الائتماني')}</p>
              <p className="text-lg font-bold text-[#1F1A13]">{formatCurrency(c.creditLimit)}</p>
            </div>
            <div className="rounded-2xl border border-[#F1EBDF] bg-white p-3.5">
              <p className="text-[11px] text-[#9A8F7E] mb-1">{tr('إجمالي المبيعات')}</p>
              <p className="text-base font-bold text-[#1F1A13]">{formatCurrency(c.totalSales)}</p>
            </div>
            <div className="rounded-2xl border border-[#F1EBDF] bg-white p-3.5">
              <p className="text-[11px] text-[#9A8F7E] mb-1">{tr('إجمالي التحصيل')}</p>
              <p className="text-base font-bold text-[#2F855A]">{formatCurrency(c.totalCollected)}</p>
            </div>
          </div>
        )}

        {/* بيانات */}
        <MCard>
          <Info label={tr('الجوال')} value={c.phone} icon={Phone} href={c.phone ? `tel:${c.phone}` : undefined} />
          {c.altPhone && <Info label={tr('رقم بديل')} value={c.altPhone} icon={Phone} href={`tel:${c.altPhone}`} />}
          {c.businessName && <Info label={tr('اسم المنشأة')} value={c.businessName} />}
          {c.email && <Info label={tr('البريد الإلكتروني')} value={c.email} />}
          {/* «قناة البيع» تصنيفٌ تجاريّ لا مال، فتبقى. و«مدة السداد» شرطُ
              ائتمانٍ فتسقط مع المفتاح. */}
          <Info label={tr('قناة البيع')} value={channelLabel(c.channel, lang === 'ar' ? 'ar' : 'en')} />
          {accountingOn && <Info label={tr('مدة السداد')} value={`${c.paymentDays} ${tr('يوم')}`} />}
          <Info label={tr('الحالة')}
            value={c.status === 'ACTIVE' ? tr('نشط') : c.status === 'BLOCKED' ? tr('محظور') : tr('غير نشط')} />
          {(c.city || c.district || c.address) && (
            <Info label={tr('العنوان')} value={[c.city, c.district, c.address].filter(Boolean).join(' — ')} />
          )}
          {c.lat != null && c.lng != null && (
            <Info label={tr('الموقع')} value={tr('افتح في الخرائط')} icon={MapPin}
              href={`https://maps.google.com/?q=${c.lat},${c.lng}`} />
          )}
          {/* بيانات الفوترة الضريبية: لا وجه لها بلا فاتورة تُصدَر */}
          {accountingOn && c.commercialReg && <Info label={tr('السجل التجاري')} value={c.commercialReg} />}
          {accountingOn && c.taxNumber && <Info label={tr('الرقم الضريبي')} value={c.taxNumber} />}
          {/* فوترة ZATCA (D2): التصنيف ونواقص الفاتورة الضريبية — للشركة التي تجمع بيانات الفوترة وحدها */}
          {zatcaCollect && accountingOn && (() => {
            const st = customerBuyerStatus(c as BuyerRowLike);
            const missing = missingBuyerFormFields(st);
            const detailText = st.subtypeIfIssuedNow === '01'
              ? (st.complete ? tr('بيانات الفاتورة الضريبية مكتملة') : `${tr('ناقص للفاتورة الضريبية')}: ${missing.map(f => tr(BUYER_FIELD_LABELS_AR[f])).join('، ')}`)
              : st.classification === 'unclassified' ? tr('حدد نوع العميل هل هو منشأة أم فرد') : tr('تصدر له فاتورة مبسطة');
            return <Info label={tr('الفوترة الإلكترونية')} value={`${tr(BUYER_CLASSIFICATION_LABELS_AR[st.classification])} — ${detailText}`} />;
          })()}
        </MCard>

        {/* إجراءان مباشران لهذا العميل — بلا إعادة اختياره في الشاشة التالية.
            وكلٌّ خلف حارسَيه: صلاحية المستخدم ومفتاح النظام المحاسبي. */}
        {(canInvoice || canReceipt || canStatement) && (
          <div className={`grid gap-2.5 ${[canInvoice, canReceipt, canStatement].filter(Boolean).length === 1 ? 'grid-cols-1' : 'grid-cols-2'}`}>
            {canInvoice && (
              <button onClick={() => setDoc('invoice')}
                className="rounded-2xl border border-[#E9E1D3] bg-white p-3.5 min-h-[76px] flex flex-col items-center justify-center gap-1.5">
                <FileText size={19} className="text-[#E15A30]" />
                <span className="text-[11px] font-semibold text-[#1F1A13]">{tr('فاتورة جديدة')}</span>
              </button>
            )}
            {canReceipt && (
              <button onClick={() => setDoc('receipt')}
                className="rounded-2xl border border-[#E9E1D3] bg-white p-3.5 min-h-[76px] flex flex-col items-center justify-center gap-1.5">
                <Wallet size={19} className="text-[#2F855A]" />
                <span className="text-[11px] font-semibold text-[#1F1A13]">{tr('سند قبض')}</span>
              </button>
            )}
            {canStatement && (
              <button onClick={() => setStatement(true)}
                className="rounded-2xl border border-[#E9E1D3] bg-white p-3.5 min-h-[76px] flex flex-col items-center justify-center gap-1.5">
                <BookOpen size={19} className="text-[#2B6CB0]" />
                <span className="text-[11px] font-semibold text-[#1F1A13]">{tr('كشف حساب')}</span>
              </button>
            )}
          </div>
        )}

        <div className="h-2" />
      </div>
    </div>
  );
}

function Info({ label, value, icon: Icon, href }: {
  label: string; value: string; icon?: React.ElementType; href?: string;
}) {
  const body = (
    <div className="flex items-center gap-3 px-3.5 py-2.5 min-h-[48px]">
      <span className="text-[11px] text-[#9A8F7E] w-24 flex-shrink-0">{label}</span>
      <span className={`text-sm flex-1 truncate flex items-center gap-1.5 ${href ? 'text-[#E15A30] font-semibold' : 'text-[#1F1A13]'}`}
        dir="auto">
        {Icon && <Icon size={13} />}{value}
      </span>
    </div>
  );
  if (href) {
    return <a href={href} target="_blank" rel="noreferrer" className="block border-b border-[#F1EBDF] last:border-0 active:bg-[#FAF7F0]">{body}</a>;
  }
  return <div className="border-b border-[#F1EBDF] last:border-0">{body}</div>;
}

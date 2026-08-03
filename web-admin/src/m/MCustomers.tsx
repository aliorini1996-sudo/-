import { useState, useEffect, useRef, useCallback, lazy, Suspense } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search, Plus, Phone, MapPin, Pencil, ChevronLeft, FileText, Wallet } from 'lucide-react';
import { customerApi } from '../api/client';
import { Customer } from '../types';
import { formatCurrency } from '../utils/format';
import { channelLabel } from '../lib/channels';
import { useLang } from '../i18n/lang';
import { useTr } from '../i18n/strings';
import { MCard, MRow, MHeader, MEmpty, MError, MSpinner } from './mobileUi';
import MCustomerForm from './MCustomerForm';
import { expectArray, expectObject } from './shape';

const MInvoiceCreate = lazy(() => import('./MInvoiceCreate'));
const MReceiptCreate = lazy(() => import('./MReceiptCreate'));

const PAGE = 30;

/**
 * تبويب العملاء — قائمة بطاقات بتحميل تراكميّ، وتفاصيل ملء الشاشة، ونموذج
 * إنشاء/تعديل.
 *
 * التحميل تراكميّ لا مُرقَّم: الترقيم على الجوال يعني ضغطاتٍ صغيرة متكرّرة،
 * والتمرير أطبعُ للإبهام.
 */
export default function MCustomers() {
  const tr = useTr();
  const [q, setQ] = useState('');
  const [dq, setDq] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const [detail, setDetail] = useState<Customer | null>(null);
  const [editing, setEditing] = useState<Customer | null | undefined>(undefined); // undefined = مغلق، null = جديد
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => { const t = setTimeout(() => { setDq(q.trim()); setLimit(PAGE); }, 300); return () => clearTimeout(t); }, [q]);

  const listQ = useQuery({
    queryKey: ['m-customers', dq, limit],
    queryFn: async () => expectArray<Customer>((await customerApi.list({ search: dq, limit })).data?.data, 'العملاء'),
  });

  // تمرير قريب من القاع ⇒ صفحة أخرى (بلا زرّ «المزيد»)
  const onScroll = useCallback(() => {
    const el = listRef.current;
    if (!el || listQ.isFetching) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 160
        && (listQ.data?.length ?? 0) >= limit) setLimit(l => l + PAGE);
  }, [listQ.isFetching, listQ.data, limit]);

  if (editing !== undefined) {
    return (
      <MCustomerForm customer={editing} onClose={() => setEditing(undefined)}
        onSaved={(c) => { setEditing(undefined); setDetail(c); }} />
    );
  }

  if (detail) {
    return <MCustomerDetail customer={detail} onClose={() => setDetail(null)} onEdit={() => setEditing(detail)} />;
  }

  return (
    <div className="h-full flex flex-col bg-[#FAF7F0]">
      {/* البحث — على الخادم لا محلياً، فيصل لأي عميل مهما طالت القائمة */}
      <div className="flex-shrink-0 p-3 pb-2 flex items-center gap-2">
        <div className="relative flex-1">
          <Search size={15} className="absolute top-1/2 -translate-y-1/2 start-3 text-[#9A8F7E]" />
          <input value={q} onChange={e => setQ(e.target.value)} className="input ps-9"
            placeholder={tr('ابحث باسم أو جوال أو كود…')} />
        </div>
        <button onClick={() => setEditing(null)}
          className="w-11 h-11 rounded-xl bg-[#E15A30] text-white flex items-center justify-center flex-shrink-0"
          aria-label={tr('عميل جديد')}>
          <Plus size={20} />
        </button>
      </div>

      <div ref={listRef} onScroll={onScroll} className="flex-1 overflow-y-auto overscroll-contain px-3 pb-3">
        {listQ.isLoading ? <MSpinner />
          : listQ.isError ? <MError onRetry={() => listQ.refetch()} />
          : !listQ.data?.length ? <MEmpty text={dq ? tr('لا نتائج') : tr('لا يوجد عملاء بعد')} />
          : (
            <MCard>
              {listQ.data.map(c => <CustomerRow key={c.id} c={c} onOpen={() => setDetail(c)} />)}
            </MCard>
          )}
        {listQ.isFetching && !listQ.isLoading && (
          <p className="text-center text-[11px] text-[#9A8F7E] py-3">{tr('جاري التحميل...')}</p>
        )}
      </div>
    </div>
  );
}

function CustomerRow({ c, onOpen }: { c: Customer; onOpen: () => void }) {
  const tr = useTr();
  const over = c.creditLimit > 0 && c.balance > c.creditLimit;
  return (
    <MRow
      onClick={onOpen}
      leading={
        <span className="w-9 h-9 rounded-full bg-[#FBEBE2] text-[#C94E28] flex items-center justify-center text-sm font-bold flex-shrink-0">
          {c.name?.charAt(0) || '؟'}
        </span>
      }
      title={c.name}
      subtitle={[c.code, c.phone, c.city].filter(Boolean).join(' · ') || tr('بلا بيانات')}
      trailing={
        <span className="flex items-center gap-1 flex-shrink-0">
          <span className={`text-xs font-bold whitespace-nowrap ${over ? 'text-[#C0392B]' : c.balance > 0 ? 'text-[#B7791F]' : 'text-[#2F855A]'}`}>
            {formatCurrency(c.balance)}
          </span>
          <ChevronLeft size={15} className="text-[#C9BFB0]" />
        </span>
      } />
  );
}

/** تفاصيل العميل — ملء الشاشة، بقيّة الحقول وأزرار الإجراءات */
function MCustomerDetail({ customer, onClose, onEdit }: {
  customer: Customer; onClose: () => void; onEdit: () => void;
}) {
  const tr = useTr();
  const lang = useLang(s => s.lang);
  const [doc, setDoc] = useState<'invoice' | 'receipt' | null>(null);

  // نجلب النسخة الحيّة: البطاقة في القائمة قد تكون قديمة بعد تعديل
  const q = useQuery({
    queryKey: ['m-customer', customer.id],
    queryFn: async () => expectObject<Customer>((await customerApi.get(customer.id)).data?.data, 'العميل'),
    initialData: customer,
  });
  const c = q.data;
  const over = c.creditLimit > 0 && c.balance > c.creditLimit;

  // الإنشاء من داخل ملفّ العميل: العميل مُمرَّر مسبقاً فلا يُعاد اختياره
  if (doc) {
    return (
      <Suspense fallback={<MSpinner />}>
        {doc === 'invoice'
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
        {/* الأرقام المالية */}
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

        {/* بيانات */}
        <MCard>
          <Info label={tr('الجوال')} value={c.phone} icon={Phone} href={c.phone ? `tel:${c.phone}` : undefined} />
          {c.altPhone && <Info label={tr('رقم بديل')} value={c.altPhone} icon={Phone} href={`tel:${c.altPhone}`} />}
          {c.businessName && <Info label={tr('اسم المنشأة')} value={c.businessName} />}
          {c.email && <Info label={tr('البريد الإلكتروني')} value={c.email} />}
          <Info label={tr('قناة البيع')} value={channelLabel(c.channel, lang === 'ar' ? 'ar' : 'en')} />
          <Info label={tr('مدة السداد')} value={`${c.paymentDays} ${tr('يوم')}`} />
          <Info label={tr('الحالة')}
            value={c.status === 'ACTIVE' ? tr('نشط') : c.status === 'BLOCKED' ? tr('محظور') : tr('غير نشط')} />
          {(c.city || c.district || c.address) && (
            <Info label={tr('العنوان')} value={[c.city, c.district, c.address].filter(Boolean).join(' — ')} />
          )}
          {c.lat != null && c.lng != null && (
            <Info label={tr('الموقع')} value={tr('افتح في الخرائط')} icon={MapPin}
              href={`https://maps.google.com/?q=${c.lat},${c.lng}`} />
          )}
          {c.commercialReg && <Info label={tr('السجل التجاري')} value={c.commercialReg} />}
          {c.taxNumber && <Info label={tr('الرقم الضريبي')} value={c.taxNumber} />}
        </MCard>

        {/* إجراءان مباشران لهذا العميل — بلا إعادة اختياره في الشاشة التالية */}
        <div className="grid grid-cols-2 gap-2.5">
          <button onClick={() => setDoc('invoice')}
            className="rounded-2xl border border-[#E9E1D3] bg-white p-3.5 min-h-[76px] flex flex-col items-center justify-center gap-1.5">
            <FileText size={19} className="text-[#E15A30]" />
            <span className="text-[11px] font-semibold text-[#1F1A13]">{tr('فاتورة جديدة')}</span>
          </button>
          <button onClick={() => setDoc('receipt')}
            className="rounded-2xl border border-[#E9E1D3] bg-white p-3.5 min-h-[76px] flex flex-col items-center justify-center gap-1.5">
            <Wallet size={19} className="text-[#2F855A]" />
            <span className="text-[11px] font-semibold text-[#1F1A13]">{tr('سند قبض')}</span>
          </button>
        </div>

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

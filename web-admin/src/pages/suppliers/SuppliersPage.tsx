import { useEffect, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import {
  Archive, ArchiveRestore, ArrowRight, Banknote, ChevronLeft, ChevronRight, Handshake, Lock, Pencil, Plus, Search, Trash2, X,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { companyApi } from '../../api/client';
import { suppliersApi, type OpenBill, type Supplier, type SupplierPaymentView, type SupplierStatusFilter } from '../../api/suppliers';
import { useAccountingOn, AccountingOffNotice } from '../../components/AccountingGate';
import ConfirmDialog from '../../components/ConfirmDialog';
import { currencyDecimals } from '../../i18n/countries';
import { useTr } from '../../i18n/strings';
import { isTaxOff } from '../../lib/taxMode';
import type { Company } from '../../rep/RepDocuments';
import { useAuthStore } from '../../store/authStore';
import { formatCurrency, getActiveCurrency } from '../../utils/format';
import { paymentDaysText, serverCodeOf, SUPPLIER_ERROR_TEXT, supplierErrorText } from './supplierLogic';
import SupplierAgingTab from './SupplierAgingTab';
import SupplierBillsTab from './SupplierBillsTab';
import SupplierFormModal, { SUPPLIER_KEYS } from './SupplierFormModal';
import SupplierPaymentModal from './SupplierPaymentModal';
import SupplierPaymentsTab from './SupplierPaymentsTab';
import { SupplierPaymentVoucherModal } from './SupplierPaymentVoucher';
import SupplierStatementTab, { BalanceText } from './SupplierStatementTab';

const PAGE_SIZE = 50;
type DetailTab = 'statement' | 'bills' | 'payments';
const DETAIL_TABS: DetailTab[] = ['statement', 'bills', 'payments'];
const DETAIL_TAB_LABELS: Record<DetailTab, string> = { statement: 'كشف الحساب', bills: 'الفواتير المفتوحة', payments: 'سندات الصرف' };

type CompanyCfg = Company & { warehouseEnabled?: boolean; accountingEnabled?: boolean };

function TabButton({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" role="tab" aria-selected={on} onClick={onClick}
      className={`shrink-0 whitespace-nowrap rounded-xl border-2 px-4 py-2 text-sm font-semibold transition-colors ${on ? 'border-[#E15A30] bg-[#FBEBE2] text-[#C94E28]' : 'border-[#E9E1D3] bg-white text-[#44403a] hover:border-[#D8CDB9]'}`}>
      {children}
    </button>
  );
}

/**
 * «الموردون» («ربط الدفاتر» L1، طلب المالك ١٣ نوفمبر ٢٠٢٦) — سجلّ الموردين بجودة محاسبٍ محترف: البحث والحالة والرصيد المستحق
 * وعدد الفواتير المفتوحة، والإنشاء والتعديل والأرشفة والحذف (الحذف الحقيقي لمن لا تاريخ له، وإلا «أرشفه»). وصفحة المورّد
 * (?id=) بتبويبات كشف الحساب والفواتير المفتوحة وسندات الصرف، و«أعمار الذمم» لكل الموردين (?view=aging).
 *
 * تظهر حين يكون «مخزون الشركة» مفعّلاً والنظام المحاسبي غير مطفأ، لمن يملك صلاحية المستودع (canManageVanStock — حارس المسار
 * والقائمة)، والخادم هو الحَكَم. لا تكتب الصفحة شيئاً في الدفاتر (gl_*): الموردون وسنداتهم سجلٌّ تشغيليّ.
 */
export default function SuppliersPage() {
  const tr = useTr();
  const [params, setParams] = useSearchParams();
  const me = useAuthStore(s => s.user);
  const canEdit = me?.canManageVanStock !== false;
  const { on: accountingOn, ready: accountingReady } = useAccountingOn();
  const companyQ = useQuery({
    queryKey: ['company'],
    queryFn: async () => (await companyApi.get()).data.data as CompanyCfg | null,
    staleTime: 300_000,
  });
  const company = companyQ.data ?? null;
  const warehouseOn = company?.warehouseEnabled === true;
  const taxOff = isTaxOff(company);

  const supplierId = params.get('id');
  const view = params.get('view') === 'aging' ? 'aging' : 'list';
  const go = (next: Record<string, string | null>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(next)) if (v) p.set(k, v);
    setParams(p);
  };

  if (!accountingReady || companyQ.isLoading) return null;
  if (!accountingOn) return <AccountingOffNotice />;
  if (!warehouseOn) {
    return (
      <div className="card max-w-xl mx-auto text-center py-10">
        <div className="w-12 h-12 rounded-2xl bg-[#F1EBDF] text-[#9A8F7E] flex items-center justify-center mx-auto mb-3"><Lock size={22} /></div>
        <h1 className="text-lg font-bold text-[#1F1A13]">{tr('صفحة الموردين غير متاحة')}</h1>
        <p className="text-sm text-gray-500 mt-1.5">{tr('الموردون جزء من مخزون الشركة وهو غير مفعل لشركتك')}</p>
      </div>
    );
  }

  if (supplierId) {
    const tab = DETAIL_TABS.includes(params.get('tab') as DetailTab) ? params.get('tab') as DetailTab : 'statement';
    return (
      <SupplierDetail id={supplierId} tab={tab} company={company} taxOff={taxOff} canEdit={canEdit}
        onTab={t => go({ id: supplierId, tab: t })} onBack={() => go({})} />
    );
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title flex items-center gap-2"><Handshake size={22} className="text-[#E15A30]" /> {tr('الموردون')}</h1>
          <p className="text-xs text-gray-400 mt-0.5">{tr('سجل الموردين وأرصدتهم وكشوف حساباتهم وسندات الصرف')}</p>
        </div>
      </div>
      <div className="flex gap-2 mb-5 overflow-x-auto pb-1" role="tablist">
        <TabButton on={view === 'list'} onClick={() => go({})}>{tr('الموردون')}</TabButton>
        <TabButton on={view === 'aging'} onClick={() => go({ view: 'aging' })}>{tr('أعمار الذمم')}</TabButton>
      </div>
      {view === 'aging'
        ? <SupplierAgingTab onOpenSupplier={id => go({ id })} />
        : <SupplierList taxOff={taxOff} canEdit={canEdit} onOpen={id => go({ id })} />}
    </div>
  );
}

// ═══ القائمة ═══

function SupplierList({ taxOff, canEdit, onOpen }: { taxOff: boolean; canEdit: boolean; onOpen: (id: string) => void }) {
  const tr = useTr();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => { const t = setTimeout(() => setQ(search.trim()), 300); return () => clearTimeout(t); }, [search]);
  const [status, setStatus] = useState<SupplierStatusFilter>('active');
  const [page, setPage] = useState(1);
  useEffect(() => { setPage(1); }, [q, status]);

  const listQ = useQuery({
    queryKey: ['suppliers', 'list', q, status, page],
    queryFn: async () => (await suppliersApi.list({ search: q || undefined, status, page, limit: PAGE_SIZE })).data.data as { items: Supplier[]; total: number },
    placeholderData: keepPreviousData,
  });
  const items = listQ.data?.items ?? [];
  const total = listQ.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const [editing, setEditing] = useState<Supplier | null | 'new'>(null);
  const [delOf, setDelOf] = useState<Supplier | null>(null);
  const [historyOf, setHistoryOf] = useState<Supplier | null>(null);

  const archive = useMutation({
    mutationFn: (s: Supplier) => suppliersApi.update(s.id, { isActive: !s.isActive }),
    onSuccess: (_r, s) => {
      SUPPLIER_KEYS.forEach(k => qc.invalidateQueries({ queryKey: [k] }));
      toast.success(s.isActive ? tr('أرشف المورد') : tr('استعيد المورد'));
      setHistoryOf(null);
    },
    onError: (e: unknown) => toast.error(tr(supplierErrorText(e, 'تعذر حفظ المورد'))),
  });
  const remove = useMutation({
    mutationFn: (s: Supplier) => suppliersApi.remove(s.id),
    onSuccess: () => {
      SUPPLIER_KEYS.forEach(k => qc.invalidateQueries({ queryKey: [k] }));
      toast.success(tr('تم حذف المورد'));
      setDelOf(null);
    },
    onError: (e: unknown, s) => {
      setDelOf(null);
      // له تاريخ ⇒ لا حذف: نافذةٌ تعرض الأرشفة بديلاً (رسالة الخادم بالرمز)
      if (serverCodeOf(e) === 'SUPPLIER_HAS_HISTORY') setHistoryOf(s);
      else toast.error(tr(supplierErrorText(e, 'تعذر حذف المورد')));
    },
  });

  return (
    <>
      <div className="card mb-4">
        <div className="flex gap-3 flex-wrap items-end">
          <div className="flex-1 min-w-[220px]">
            <label className="label">{tr('بحث')}</label>
            <div className="relative">
              <Search size={15} className="absolute top-1/2 -translate-y-1/2 start-3 text-gray-400 pointer-events-none" />
              <input className="input ps-9 pe-8 w-full" value={search} onChange={e => setSearch(e.target.value)}
                placeholder={taxOff ? tr('الاسم أو الرمز أو الجوال') : tr('الاسم أو الرمز أو الرقم الضريبي أو الجوال')} />
              {search && (
                <button type="button" onClick={() => setSearch('')} title={tr('مسح البحث')} className="absolute top-1/2 -translate-y-1/2 end-2 text-gray-400 hover:text-gray-600">
                  <X size={15} />
                </button>
              )}
            </div>
          </div>
          <div>
            <label className="label">{tr('الحالة')}</label>
            <select className="input w-36" value={status} onChange={e => setStatus(e.target.value as SupplierStatusFilter)}>
              <option value="active">{tr('النشطون')}</option>
              <option value="archived">{tr('المؤرشفون')}</option>
              <option value="all">{tr('الكل')}</option>
            </select>
          </div>
          {canEdit && <button className="btn-primary ms-auto" onClick={() => setEditing('new')}><Plus size={16} /> {tr('مورد جديد')}</button>}
        </div>
      </div>

      {listQ.isPending ? (
        <div className="card flex items-center justify-center h-32 text-gray-400">{tr('جاري التحميل')}</div>
      ) : listQ.isError ? (
        <div className="card flex flex-col items-center gap-3 py-10 text-gray-500">
          <span>{tr(supplierErrorText(listQ.error, 'تعذر تحميل الموردين'))}</span>
          <button onClick={() => listQ.refetch()} className="btn-secondary">{tr('إعادة المحاولة')}</button>
        </div>
      ) : (
        <div className="card p-0">
          {items.length === 0 ? (
            <div className="text-center text-gray-400 text-sm py-12">
              {q ? tr('لا نتائج مطابقة للبحث') : status === 'archived' ? tr('لا موردين مؤرشفين') : tr('لا موردين بعد أضف أول مورد')}
            </div>
          ) : (
            <div className="table-wrapper">
              <table className="table">
                <thead>
                  <tr>
                    <th>{tr('المورد')}</th>
                    {!taxOff && <th>{tr('الرقم الضريبي')}</th>}
                    <th>{tr('الجوال')}</th>
                    <th>{tr('مدة السداد')}</th>
                    <th>{tr('الفواتير المفتوحة')}</th>
                    <th>{tr('الرصيد المستحق')}</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {items.map(s => (
                    <tr key={s.id} className={s.isActive ? undefined : 'bg-[#FAF7F0]/70'}>
                      <td>
                        <button type="button" className="font-semibold text-[#1F1A13] hover:text-[#C94E28] hover:underline text-start" onClick={() => onOpen(s.id)}>{s.name}</button>
                        <div className="text-[11px] text-[#9A8F7E] flex flex-wrap gap-x-2">
                          {s.code && <bdi dir="ltr">{s.code}</bdi>}
                          {s.nameEn && <bdi dir="ltr">{s.nameEn}</bdi>}
                          {s.city && <span>{s.city}</span>}
                          {!s.isActive && <span className="rounded bg-slate-100 border border-slate-200 text-slate-600 px-1.5 font-semibold">{tr('مؤرشف')}</span>}
                        </div>
                      </td>
                      {!taxOff && <td className="text-[12px]">{s.vatNumber ? <bdi dir="ltr">{s.vatNumber}</bdi> : '—'}</td>}
                      <td className="text-[12px]">{s.phone ? <bdi dir="ltr">{s.phone}</bdi> : '—'}</td>
                      <td className="text-[12px]">{paymentDaysText(s.paymentDays, tr)}</td>
                      <td className="tabular-nums">{s.openBillsCount > 0 ? <span className="font-semibold">{s.openBillsCount}</span> : <span className="text-gray-300">0</span>}</td>
                      <td><BalanceText value={s.balance} tr={tr} /></td>
                      <td>
                        <div className="flex items-center gap-1 justify-end">
                          {canEdit && (
                            <>
                              <button type="button" title={tr('تعديل')} className="p-1.5 rounded-lg hover:bg-[#F6F1E7] text-[#6E6557]" onClick={() => setEditing(s)}><Pencil size={15} /></button>
                              <button type="button" title={s.isActive ? tr('أرشفة') : tr('استعادة')} className="p-1.5 rounded-lg hover:bg-[#F6F1E7] text-[#6E6557]"
                                disabled={archive.isPending} onClick={() => archive.mutate(s)}>
                                {s.isActive ? <Archive size={15} /> : <ArchiveRestore size={15} />}
                              </button>
                              <button type="button" title={tr('حذف')} className="p-1.5 rounded-lg hover:bg-red-50 text-[#C0392B]" onClick={() => setDelOf(s)}><Trash2 size={15} /></button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {(pages > 1 || total > 0) && (
            <div className="flex items-center justify-between gap-3 px-5 py-3 border-t border-[#F1EBDF] text-sm text-[#6E6557]">
              <span className="tabular-nums">{total} {tr('مورد')}{pages > 1 ? ` · ${tr('صفحة')} ${page} / ${pages}` : ''}</span>
              {pages > 1 && (
                <div className="flex gap-2">
                  <button className="btn-secondary !px-2.5 !py-1.5" disabled={page <= 1} onClick={() => setPage(p => p - 1)} aria-label={tr('السابق')}><ChevronRight size={16} /></button>
                  <button className="btn-secondary !px-2.5 !py-1.5" disabled={page >= pages} onClick={() => setPage(p => p + 1)} aria-label={tr('التالي')}><ChevronLeft size={16} /></button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {editing && (
        <SupplierFormModal supplier={editing === 'new' ? null : editing} taxOff={taxOff} onClose={() => setEditing(null)} />
      )}
      {delOf && (
        <ConfirmDialog danger title={tr('حذف المورد')} loading={remove.isPending}
          message={`${delOf.name} — ${tr('يحذف المورد نهائيا إن لم تكن له حركات أو قيود أو دفعات ولا يمكن التراجع')}`}
          confirmLabel={tr('حذف نهائي')} onConfirm={() => remove.mutate(delOf)} onClose={() => setDelOf(null)} />
      )}
      {historyOf && (
        <ConfirmDialog title={tr('لا يمكن حذف المورد')} loading={archive.isPending}
          message={`${historyOf.name} — ${tr(SUPPLIER_ERROR_TEXT.SUPPLIER_HAS_HISTORY)}`}
          confirmLabel={historyOf.isActive ? tr('أرشفة المورد') : tr('إغلاق')}
          onConfirm={() => (historyOf.isActive ? archive.mutate(historyOf) : setHistoryOf(null))} onClose={() => setHistoryOf(null)} />
      )}
    </>
  );
}

// ═══ صفحة المورّد ═══

function SupplierDetail({ id, tab, company, taxOff, canEdit, onTab, onBack }: {
  id: string; tab: DetailTab; company: Company | null; taxOff: boolean; canEdit: boolean;
  onTab: (t: DetailTab) => void; onBack: () => void;
}) {
  const tr = useTr();
  const qc = useQueryClient();
  const sQ = useQuery({
    queryKey: ['supplier', id],
    queryFn: async () => (await suppliersApi.get(id)).data.data as Supplier,
  });
  const s = sQ.data;
  const [editing, setEditing] = useState(false);
  const [paying, setPaying] = useState<{ bill: OpenBill | null } | null>(null);
  const [printed, setPrinted] = useState<{ payment: SupplierPaymentView | null; id: string | null } | null>(null);
  const decimals = currencyDecimals(getActiveCurrency());

  const archive = useMutation({
    mutationFn: (sup: Supplier) => suppliersApi.update(sup.id, { isActive: !sup.isActive }),
    onSuccess: (_r, sup) => {
      SUPPLIER_KEYS.forEach(k => qc.invalidateQueries({ queryKey: [k] }));
      toast.success(sup.isActive ? tr('أرشف المورد') : tr('استعيد المورد'));
    },
    onError: (e: unknown) => toast.error(tr(supplierErrorText(e, 'تعذر حفظ المورد'))),
  });

  if (sQ.isPending) return <div className="card flex items-center justify-center h-32 text-gray-400">{tr('جاري التحميل')}</div>;
  if (sQ.isError || !s) {
    return (
      <div className="card flex flex-col items-center gap-3 py-10 text-gray-500">
        <span>{tr(supplierErrorText(sQ.error, 'تعذر تحميل المورد'))}</span>
        <div className="flex gap-2">
          <button onClick={onBack} className="btn-secondary"><ArrowRight size={15} /> {tr('كل الموردين')}</button>
          <button onClick={() => sQ.refetch()} className="btn-secondary">{tr('إعادة المحاولة')}</button>
        </div>
      </div>
    );
  }

  const facts: [string, React.ReactNode][] = [
    [tr('رمز المورد'), s.code ? <bdi dir="ltr">{s.code}</bdi> : null],
    [tr('الرقم الضريبي'), !taxOff && s.vatNumber ? <bdi dir="ltr">{s.vatNumber}</bdi> : null],
    [tr('السجل التجاري'), s.crNumber ? <bdi dir="ltr">{s.crNumber}</bdi> : null],
    [tr('الجوال'), s.phone ? <bdi dir="ltr">{s.phone}</bdi> : null],
    [tr('البريد الإلكتروني'), s.email ? <bdi dir="ltr">{s.email}</bdi> : null],
    [tr('العنوان'), [s.city, s.address].filter(Boolean).join(' · ') || null],
    [tr('الآيبان'), s.iban ? <bdi dir="ltr">{s.iban}</bdi> : null],
    [tr('البنك'), s.bankName],
    [tr('مدة السداد'), paymentDaysText(s.paymentDays, tr)],
  ];

  return (
    <div className="space-y-4">
      <button onClick={onBack} className="inline-flex items-center gap-1.5 text-sm text-[#6E6557] hover:text-[#1F1A13]"><ArrowRight size={15} /> {tr('كل الموردين')}</button>

      <div className="card space-y-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-xl font-bold text-[#1F1A13]">{s.name}</h1>
              {!s.isActive && <span className="rounded bg-slate-100 border border-slate-200 text-slate-600 px-1.5 text-[11px] font-semibold">{tr('مؤرشف')}</span>}
            </div>
            {s.nameEn && <p className="text-sm text-[#6E6557] mt-0.5"><bdi dir="ltr">{s.nameEn}</bdi></p>}
          </div>
          {canEdit && (
            <div className="flex gap-2 flex-wrap">
              <button className="btn-primary" onClick={() => setPaying({ bill: null })}><Banknote size={16} /> {tr('سند صرف جديد')}</button>
              <button className="btn-secondary" onClick={() => setEditing(true)}><Pencil size={15} /> {tr('تعديل')}</button>
              <button className="btn-secondary" disabled={archive.isPending} onClick={() => archive.mutate(s)}>
                {s.isActive ? <><Archive size={15} /> {tr('أرشفة')}</> : <><ArchiveRestore size={15} /> {tr('استعادة')}</>}
              </button>
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="rounded-xl bg-[#FAF7F0] border border-[#F1EBDF] p-3 text-center">
            <p className="text-xs text-[#6E6557]">{tr('الرصيد المستحق')}</p>
            <p className="text-xl mt-0.5"><BalanceText value={s.balance} tr={tr} /></p>
          </div>
          <div className="rounded-xl bg-[#FAF7F0] border border-[#F1EBDF] p-3 text-center">
            <p className="text-xs text-[#6E6557]">{tr('الفواتير المفتوحة')}</p>
            <p className="text-xl font-bold tabular-nums text-[#1F1A13] mt-0.5">{s.openBillsCount}</p>
          </div>
          <div className="rounded-xl bg-[#FAF7F0] border border-[#F1EBDF] p-3 text-center">
            <p className="text-xs text-[#6E6557]">{tr('مدة السداد')}</p>
            <p className="text-xl font-bold text-[#1F1A13] mt-0.5">{paymentDaysText(s.paymentDays, tr)}</p>
          </div>
        </div>

        <dl className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-1.5 text-sm">
          {facts.filter(([, v]) => v != null && v !== '').map(([k, v]) => (
            <div key={k} className="flex gap-2"><dt className="text-[#9A8F7E] shrink-0">{k}:</dt><dd className="text-[#1F1A13] min-w-0 break-words">{v}</dd></div>
          ))}
        </dl>
        {s.notes && <p className="text-[12px] text-[#6E6557] bg-[#FFFBEB] border border-[#FDE68A] rounded-lg px-3 py-2 whitespace-pre-line">{s.notes}</p>}
      </div>

      <div className="flex gap-2 overflow-x-auto pb-1" role="tablist">
        {DETAIL_TABS.map(t => <TabButton key={t} on={tab === t} onClick={() => onTab(t)}>{tr(DETAIL_TAB_LABELS[t])}</TabButton>)}
      </div>

      {tab === 'statement' && <SupplierStatementTab supplier={s} company={company} canEdit={canEdit} />}
      {tab === 'bills' && <SupplierBillsTab supplier={s} company={company} canEdit={canEdit} onPay={bill => setPaying({ bill })} />}
      {tab === 'payments' && <SupplierPaymentsTab supplier={s} canEdit={canEdit} onNew={() => setPaying({ bill: null })} />}

      {editing && <SupplierFormModal supplier={s} taxOff={taxOff} onClose={() => setEditing(false)} />}
      {paying && (
        <SupplierPaymentModal supplier={s} bill={paying.bill} decimals={decimals} onClose={() => setPaying(null)}
          onSaved={saved => { setPaying(null); if (saved.payment || saved.id) setPrinted(saved); }} />
      )}
      {/* بعد الحفظ: السند جاهزٌ للطباعة مباشرة */}
      {printed && <SupplierPaymentVoucherModal payment={printed.payment} paymentId={printed.id} supplier={s} onClose={() => setPrinted(null)} />}
    </div>
  );
}

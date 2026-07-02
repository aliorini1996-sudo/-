import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { salesRepApi, invoiceApi, receiptApi } from '../api/client';
import { SalesRep, Invoice, Receipt } from '../types';
import { Plus, Search, Edit, Check, X as XIcon, Copy, KeyRound, UserCheck, FileBarChart2, Download, Printer, X, Trash2, Banknote } from 'lucide-react';
import toast from 'react-hot-toast';
import SalesRepModal from '../components/forms/SalesRepModal';
import ResetPasswordModal from '../components/ResetPasswordModal';
import ConfirmDialog from '../components/ConfirmDialog';
import { formatCurrency, formatDate, formatNumber, statusLabels, paymentMethodLabels } from '../utils/format';
import { useTr } from '../i18n/strings';
import { shareOrDownloadExcel, num } from '../utils/excel';

interface Creds { name: string; username: string; password: string; }

export default function SalesRepsPage() {
  const qc = useQueryClient();
  const tr = useTr();
  const [search, setSearch] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [selected, setSelected] = useState<SalesRep | null>(null);
  const [createdCreds, setCreatedCreds] = useState<Creds | null>(null);
  const [statementRep, setStatementRep] = useState<SalesRep | null>(null);
  const [resetRep, setResetRep] = useState<SalesRep | null>(null);
  const [deleting, setDeleting] = useState<SalesRep | null>(null);
  const [collectRep, setCollectRep] = useState<SalesRep | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['sales-reps', search],
    queryFn: async () => {
      const res = await salesRepApi.list({ search, limit: 50 });
      return res.data.data as SalesRep[];
    },
  });

  const saveMutation = useMutation({
    mutationFn: (values: Partial<SalesRep> & { password?: string }) =>
      selected ? salesRepApi.update(selected.id, values) : salesRepApi.create(values),
    onSuccess: (_data, variables) => {
      const wasCreate = !selected;
      qc.invalidateQueries({ queryKey: ['sales-reps'] });
      setShowModal(false);
      setSelected(null);
      if (wasCreate) {
        // عرض بيانات الدخول لتسليمها للمندوب
        setCreatedCreds({ name: variables.name || '', username: variables.username || '', password: variables.password || '' });
      } else {
        toast.success(tr('تم تحديث بيانات المندوب'));
      }
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message || tr('حدث خطأ');
      toast.error(msg);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => salesRepApi.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sales-reps'] });
      toast.success(tr('تم حذف المندوب'));
      setDeleting(null);
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message || tr('تعذّر حذف المندوب');
      toast.error(msg);
      setDeleting(null);
    },
  });

  const perm = (val?: boolean) => val !== false
    ? <Check size={14} className="text-green-500" />
    : <XIcon size={14} className="text-gray-300" />;

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">{tr('إدارة المناديب')}</h1>
        <button className="btn-primary" onClick={() => { setSelected(null); setShowModal(true); }}><Plus size={16} />{tr('إضافة مندوب')}</button>
      </div>

      <div className="card mb-4">
        <div className="relative max-w-sm">
          <Search size={15} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input className="input pr-9" placeholder={tr('بحث بالاسم أو الجوال...')}
            value={search} onChange={e => setSearch(e.target.value)} />
        </div>
      </div>

      <div className="card p-0">
        <div className="table-wrapper">
          <table className="table">
            <thead>
              <tr>
                <th>{tr('المندوب')}</th><th>{tr('الجوال')}</th><th>{tr('اسم المستخدم')}</th>
                <th className="text-center">{tr('فاتورة')}</th>
                <th className="text-center">{tr('آجل')}</th>
                <th className="text-center">{tr('نقدي')}</th>
                <th className="text-center">{tr('تحصيل')}</th>
                <th className="text-center">{tr('تغيير سعر')}</th>
                <th className="text-center">{tr('خصم أقصى')}</th>
                <th className="text-center">{tr('مخزون السيارة')}</th>
                <th className="text-center">{tr('إضافة عميل')}</th>
                <th>{tr('الحالة')}</th>
                <th>{tr('إجراءات')}</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr><td colSpan={13} className="text-center py-12 text-gray-400">{tr('جاري التحميل...')}</td></tr>
              ) : data?.map(r => (
                <tr key={r.id}>
                  <td>
                    <p className="font-medium text-gray-800">{r.name}</p>
                    <p className="text-xs text-gray-400">{r.email || ''}</p>
                  </td>
                  <td className="font-mono text-sm text-gray-600">{r.phone}</td>
                  <td className="font-mono text-sm text-gray-500">{r.username}</td>
                  <td className="text-center">{perm(r.canCreateInvoice)}</td>
                  <td className="text-center">{perm(r.canSellOnCredit)}</td>
                  <td className="text-center">{perm(r.canSellInCash)}</td>
                  <td className="text-center">{perm(r.canCreateReceipt)}</td>
                  <td className="text-center">{perm(r.canChangePrice)}</td>
                  <td className="text-center text-sm text-gray-600">{r.maxDiscountPct}%</td>
                  <td className="text-center">{perm(r.canManageVanStock)}</td>
                  <td className="text-center">{perm(r.canAddCustomer)}</td>
                  <td><span className={r.isActive ? 'badge-active' : 'badge-inactive'}>{r.isActive ? tr('نشط') : tr('غير نشط')}</span></td>
                  <td>
                    <div className="flex items-center gap-1">
                      {r.showCollectionBalance !== false && (
                        <button onClick={() => setCollectRep(r)} className="p-1.5 hover:bg-green-50 rounded text-green-600" title={tr('استلام تحصيل')}><Banknote size={14} /></button>
                      )}
                      <button onClick={() => setStatementRep(r)} className="p-1.5 hover:bg-[#F1EBDF] rounded text-[#1F1A13]" title={tr('كشف الأداء والمبيعات')}><FileBarChart2 size={14} /></button>
                      <button onClick={() => { setSelected({ ...r, canSellOnCredit: r.canSellOnCredit ?? true, canSellInCash: r.canSellInCash ?? true, canManageVanStock: r.canManageVanStock ?? true }); setShowModal(true); }} className="p-1.5 hover:bg-[#FBEBE2] rounded text-[#E15A30]" title={tr('تعديل')}><Edit size={14} /></button>
                      <button onClick={() => setResetRep(r)} className="p-1.5 hover:bg-amber-50 rounded text-amber-600" title={tr('إعادة تعيين كلمة المرور')}><KeyRound size={14} /></button>
                      <button onClick={() => setDeleting(r)} className="p-1.5 hover:bg-red-50 rounded text-red-600" title={tr('حذف المندوب')}><Trash2 size={14} /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {showModal && (
        <SalesRepModal
          rep={selected}
          onClose={() => { setShowModal(false); setSelected(null); }}
          onSave={saveMutation.mutate}
          loading={saveMutation.isPending}
        />
      )}

      {createdCreds && (
        <CredentialsModal creds={createdCreds} onClose={() => setCreatedCreds(null)} />
      )}

      {statementRep && (
        <RepStatementModal rep={statementRep} onClose={() => setStatementRep(null)} />
      )}

      {resetRep && (
        <ResetPasswordModal
          title={tr('إعادة تعيين كلمة مرور المندوب')}
          subject={`${resetRep.name} · ${resetRep.username}`}
          onConfirm={async (newPassword) => { await salesRepApi.update(resetRep.id, { password: newPassword }); }}
          onClose={() => setResetRep(null)}
        />
      )}

      {deleting && (
        <ConfirmDialog
          danger
          title={tr('حذف المندوب')}
          message={`${tr('سيتم حذف المندوب')} «${deleting.name}» ${tr('نهائياً ولا يمكن التراجع. إن كانت لديه فواتير أو سندات فلن يُحذف — ويمكنك تعطيله بدلاً من ذلك.')}`}
          confirmLabel={tr('حذف نهائي')}
          loading={deleteMutation.isPending}
          onConfirm={() => deleteMutation.mutate(deleting.id)}
          onClose={() => setDeleting(null)}
        />
      )}

      {collectRep && (
        <ReceiveCollectionModal rep={collectRep} onClose={() => setCollectRep(null)}
          onDone={() => qc.invalidateQueries({ queryKey: ['sales-reps'] })} />
      )}
    </div>
  );
}

// ============ استلام تحصيل من المندوب ============
function ReceiveCollectionModal({ rep, onClose, onDone }: { rep: SalesRep; onClose: () => void; onDone: () => void }) {
  const tr = useTr();
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [filled, setFilled] = useState(false);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['rep-collection', rep.id],
    queryFn: async () => {
      const r = await salesRepApi.collection(rep.id);
      return r.data.data as { collected: number; settled: number; outstanding: number };
    },
  });

  // تعبئة الحقل تلقائياً بالرصيد المتبقّي (تسليم كامل) أول مرّة
  if (data && !filled) { setAmount(String(Math.max(0, Number(data.outstanding.toFixed(2))))); setFilled(true); }

  const settle = useMutation({
    mutationFn: () => salesRepApi.settle(rep.id, { amount: Number(amount), note: note || undefined }),
    onSuccess: () => {
      toast.success(tr('تم تسجيل الاستلام'));
      setNote(''); setFilled(false);
      refetch();
      onDone();
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message || tr('تعذّر التسجيل');
      toast.error(msg);
    },
  });

  const outstanding = data?.outstanding ?? 0;

  return (
    <div className="fixed inset-0 bg-black/50 z-[60] flex items-center justify-center p-4" dir="rtl">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md">
        <div className="flex items-center justify-between p-5 border-b border-[#E9E1D3]">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-green-50 rounded-xl flex items-center justify-center"><Banknote size={20} className="text-green-600" /></div>
            <div>
              <h2 className="text-lg font-bold text-[#1F1A13]">{tr('استلام تحصيل')}</h2>
              <p className="text-xs text-[#6E6557]">{rep.name}</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg text-gray-500"><X size={18} /></button>
        </div>

        <div className="p-5 space-y-4">
          {isLoading ? (
            <p className="text-center text-gray-400 py-6">{tr('جارٍ التحميل…')}</p>
          ) : (
            <>
              <div className="grid grid-cols-3 gap-2 text-center">
                <div className="bg-gray-50 rounded-xl p-3">
                  <p className="text-[11px] text-gray-500">{tr('إجمالي التحصيل')}</p>
                  <p className="font-bold text-sm text-gray-700 mt-1">{formatCurrency(data?.collected ?? 0)}</p>
                </div>
                <div className="bg-gray-50 rounded-xl p-3">
                  <p className="text-[11px] text-gray-500">{tr('المُستلَم سابقاً')}</p>
                  <p className="font-bold text-sm text-gray-700 mt-1">{formatCurrency(data?.settled ?? 0)}</p>
                </div>
                <div className="bg-green-50 rounded-xl p-3 border border-green-100">
                  <p className="text-[11px] text-green-700">{tr('الرصيد المتبقّي')}</p>
                  <p className="font-extrabold text-sm text-green-700 mt-1">{formatCurrency(outstanding)}</p>
                </div>
              </div>

              <div>
                <label className="label">{tr('المبلغ المُستلَم من المندوب')}</label>
                <input className="input" type="number" min={0} step="0.01" value={amount}
                  onChange={e => setAmount(e.target.value)} placeholder="0.00" />
                <p className="text-[11px] text-gray-400 mt-1">{tr('المبلغ مُعبّأ بالرصيد المتبقّي (تسليم كامل) — عدّله للتسليم الجزئي.')}</p>
              </div>
              <div>
                <label className="label">{tr('ملاحظة (اختياري)')}</label>
                <input className="input" value={note} onChange={e => setNote(e.target.value)} placeholder={tr('مثال: نقدًا، تحويل بنكي…')} />
              </div>
            </>
          )}
        </div>

        <div className="flex gap-3 p-5 border-t border-[#E9E1D3]">
          <button onClick={() => settle.mutate()}
            disabled={settle.isPending || isLoading || !(Number(amount) > 0)}
            className="btn-primary flex-1 justify-center py-2.5 disabled:opacity-60">
            {settle.isPending ? <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Banknote size={16} />}
            {tr('تسجيل الاستلام')}
          </button>
          <button onClick={onClose} className="btn-secondary">{tr('إغلاق')}</button>
        </div>
      </div>
    </div>
  );
}

// ============ كشف أداء وعمل المندوب ============
function RepStatementModal({ rep, onClose }: { rep: SalesRep; onClose: () => void }) {
  const tr = useTr();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['rep-statement', rep.id, from, to],
    queryFn: async () => {
      const base: Record<string, string | number> = { salesRepId: rep.id, limit: 5000, withItems: 1 };
      if (from && to) { base.from = from; base.to = to; }
      const [inv, rcp] = await Promise.all([
        invoiceApi.list({ ...base, status: 'CONFIRMED' }),
        receiptApi.list(base),
      ]);
      return { invoices: inv.data.data as Invoice[], receipts: rcp.data.data as Receipt[] };
    },
  });

  const invoices = data?.invoices ?? [];
  const receipts = data?.receipts ?? [];
  const sales = invoices.filter(i => (i.type as string) !== 'RETURN');
  const returns = invoices.filter(i => (i.type as string) === 'RETURN');
  const salesTotal = sales.reduce((s, i) => s + Number(i.total), 0);
  const returnsTotal = returns.reduce((s, i) => s + Number(i.total), 0);
  const collectTotal = receipts.reduce((s, r) => s + Number(r.amount), 0);
  const periodLabel = from && to ? `${formatDate(from)} — ${formatDate(to)}` : tr('كل الفترات');
  // ملخّص أصناف الفاتورة: «اسم ×كمية، …» (لعمود الأصناف في الكشف)
  const itemsText = (i: Invoice) => (i.items || []).map(it => `${it.product.name} ×${Number(it.qty)}`).join('، ');
  // إجماليات أسفل الكشف: مجموع مبالغ الفواتير + عدد الأصناف المباعة (مجموع الكميات)
  const invoicesAmountTotal = invoices.reduce((s, i) => s + Number(i.total), 0);
  const soldItemsCount = invoices.reduce((s, i) => s + (i.items || []).reduce((a, it) => a + Number(it.qty), 0), 0);

  // تصدير الكشف إلى Excel (3 أوراق: ملخص، فواتير، سندات)
  const exportRep = async () => {
    const summary = [
      { [tr('البند')]: tr('عدد فواتير البيع'), [tr('القيمة')]: sales.length },
      { [tr('البند')]: tr('إجمالي المبيعات'), [tr('القيمة')]: num(salesTotal) },
      { [tr('البند')]: tr('عدد المرتجعات'), [tr('القيمة')]: returns.length },
      { [tr('البند')]: tr('إجمالي المرتجعات'), [tr('القيمة')]: num(returnsTotal) },
      { [tr('البند')]: tr('صافي المبيعات'), [tr('القيمة')]: num(salesTotal - returnsTotal) },
      { [tr('البند')]: tr('عدد سندات القبض'), [tr('القيمة')]: receipts.length },
      { [tr('البند')]: tr('إجمالي التحصيل'), [tr('القيمة')]: num(collectTotal) },
    ];
    const invRows = invoices.map(i => ({
      [tr('رقم الفاتورة')]: i.number, [tr('العميل')]: i.customer.name,
      [tr('الأصناف')]: itemsText(i),
      [tr('النوع')]: tr(statusLabels[i.type] || i.type),
      [tr('التاريخ')]: formatDate(i.invoiceDate), [tr('الإجمالي')]: num(i.total), [tr('المدفوع')]: num(i.paidAmt), [tr('المتبقي')]: num(i.remainingAmt),
    })) as Record<string, string | number>[];
    // صف الإجمالي أسفل جدول الفواتير
    if (invoices.length) invRows.push({
      [tr('رقم الفاتورة')]: tr('الإجمالي'), [tr('العميل')]: '',
      [tr('الأصناف')]: `${soldItemsCount} ${tr('صنف مباع')}`,
      [tr('النوع')]: '', [tr('التاريخ')]: '', [tr('الإجمالي')]: num(invoicesAmountTotal), [tr('المدفوع')]: '', [tr('المتبقي')]: '',
    });
    const rcpRows = receipts.map(r => ({
      [tr('رقم السند')]: r.number, [tr('العميل')]: r.customer.name,
      [tr('طريقة الدفع')]: tr(paymentMethodLabels[r.paymentMethod] || r.paymentMethod),
      [tr('التاريخ')]: formatDate(r.receiptDate), [tr('المبلغ')]: num(r.amount),
    }));
    const out = await shareOrDownloadExcel([
      { name: tr('الملخص'), rows: summary, colWidths: [22, 16] },
      { name: tr('الفواتير'), rows: invRows, colWidths: [18, 24, 40, 10, 16, 12, 12, 12] },
      { name: tr('سندات القبض'), rows: rcpRows, colWidths: [18, 24, 14, 16, 12] },
    ], `${tr('كشف')}-${rep.name}-${new Date().toISOString().slice(0, 10)}`);
    toast.success(out === 'shared' ? tr('تمت المشاركة') : tr('تم تصدير كشف المندوب'));
  };

  // طباعة الكشف العادي (A4)
  const printStatement = () => {
    const esc = (s: unknown) => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string));
    const invRows = invoices.map((i, n) => `<tr><td>${n + 1}</td><td>${esc(i.number)}</td><td>${esc(i.customer.name)}</td><td style="font-size:10px">${esc((i.items?.length ? `${i.items.length} ${tr('صنف')}: ` : '') + itemsText(i))}</td><td>${esc(tr(statusLabels[i.type] || i.type))}</td><td>${formatDate(i.invoiceDate)}</td><td style="text-align:left">${num(i.total).toFixed(2)}</td></tr>`).join('');
    const rcpRows = receipts.map((r, n) => `<tr><td>${n + 1}</td><td>${esc(r.number)}</td><td>${esc(r.customer.name)}</td><td>${esc(tr(paymentMethodLabels[r.paymentMethod] || r.paymentMethod))}</td><td>${formatDate(r.receiptDate)}</td><td style="text-align:left">${num(r.amount).toFixed(2)}</td></tr>`).join('');
    const html = `<!DOCTYPE html><html dir="rtl" lang="ar"><head><meta charset="utf-8"/><title>${tr('كشف')} ${esc(rep.name)}</title>
    <style>
      @page { size: A4; margin: 14mm; }
      body { font-family: 'Tahoma','Arial',sans-serif; color:#1F1A13; font-size:12px; }
      h1 { color:#E15A30; font-size:20px; margin:0; }
      .sub { color:#6E6557; font-size:12px; margin:4px 0 14px; }
      .cards { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:16px; }
      .card { border:1px solid #E9E1D3; border-radius:8px; padding:10px 14px; min-width:120px; }
      .card .v { font-size:18px; font-weight:700; }
      .card .k { font-size:11px; color:#6E6557; }
      h2 { font-size:14px; margin:18px 0 6px; color:#1F1A13; border-bottom:2px solid #E15A30; padding-bottom:4px; }
      table { width:100%; border-collapse:collapse; }
      th { background:#FAF7F0; text-align:right; padding:6px 8px; font-size:11px; border-bottom:1px solid #E9E1D3; }
      td { padding:6px 8px; font-size:11px; border-bottom:1px solid #F1EBDF; }
    </style></head><body>
      <h1>FieldSales — ${tr('كشف المندوب')}</h1>
      <div class="sub">${tr('المندوب')}: <b>${esc(rep.name)}</b> · ${tr('الجوال')}: ${esc(rep.phone)} · ${tr('الفترة')}: ${periodLabel} · ${tr('تاريخ الإصدار')}: ${formatDate(new Date().toISOString())}</div>
      <div class="cards">
        <div class="card"><div class="v">${sales.length}</div><div class="k">${tr('عدد الفواتير')}</div></div>
        <div class="card"><div class="v">${num(salesTotal).toFixed(2)}</div><div class="k">${tr('إجمالي المبيعات')}</div></div>
        <div class="card"><div class="v">${receipts.length}</div><div class="k">${tr('عدد السندات')}</div></div>
        <div class="card"><div class="v">${num(collectTotal).toFixed(2)}</div><div class="k">${tr('إجمالي التحصيل')}</div></div>
        <div class="card"><div class="v">${num(salesTotal - returnsTotal).toFixed(2)}</div><div class="k">${tr('صافي المبيعات')}</div></div>
      </div>
      <h2>${tr('الفواتير')} (${invoices.length})</h2>
      <table><thead><tr><th>#</th><th>${tr('رقم الفاتورة')}</th><th>${tr('العميل')}</th><th>${tr('الأصناف')}</th><th>${tr('النوع')}</th><th>${tr('التاريخ')}</th><th>${tr('الإجمالي')}</th></tr></thead><tbody>${invRows || `<tr><td colspan=7>${tr('لا توجد فواتير')}</td></tr>`}</tbody>${invoices.length ? `<tfoot><tr style="background:#FAF7F0;font-weight:700;border-top:2px solid #E15A30"><td colspan=3>${tr('الإجمالي')}</td><td>${soldItemsCount} ${tr('صنف مباع')}</td><td colspan=2>${invoices.length} ${tr('فاتورة')}</td><td style="text-align:left">${num(invoicesAmountTotal).toFixed(2)}</td></tr></tfoot>` : ''}</table>
      <h2>${tr('سندات القبض')} (${receipts.length})</h2>
      <table><thead><tr><th>#</th><th>${tr('رقم السند')}</th><th>${tr('العميل')}</th><th>${tr('الطريقة')}</th><th>${tr('التاريخ')}</th><th>${tr('المبلغ')}</th></tr></thead><tbody>${rcpRows || `<tr><td colspan=6>${tr('لا توجد سندات')}</td></tr>`}</tbody></table>
    </body></html>`;
    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'position:fixed;right:-9999px;bottom:0;width:210mm;height:0;border:0;';
    document.body.appendChild(iframe);
    const idoc = iframe.contentWindow?.document;
    if (!idoc) { iframe.remove(); return; }
    idoc.open(); idoc.write(html); idoc.close();
    setTimeout(() => { try { iframe.contentWindow?.focus(); iframe.contentWindow?.print(); } catch { /* */ } setTimeout(() => iframe.remove(), 2000); }, 400);
  };

  const stat = (v: string, k: string, color: string) => (
    <div className="bg-white rounded-xl border border-[#E9E1D3] p-3">
      <p className={`text-lg font-bold ${color}`}>{v}</p>
      <p className="text-xs text-[#6E6557]">{k}</p>
    </div>
  );

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" dir="rtl">
      <div className="bg-[#FAF7F0] rounded-2xl shadow-2xl w-full max-w-3xl max-h-[92vh] overflow-y-auto">
        <div className="flex items-center justify-between p-5 border-b border-[#E9E1D3] bg-white rounded-t-2xl sticky top-0">
          <div className="flex items-center gap-2">
            <FileBarChart2 size={20} className="text-[#E15A30]" />
            <div>
              <h2 className="text-lg font-bold text-[#1F1A13]">{tr('كشف المندوب')} — {rep.name}</h2>
              <p className="text-xs text-[#6E6557]">{periodLabel}</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg text-gray-500"><X size={18} /></button>
        </div>

        <div className="p-5 space-y-4">
          {/* فلتر الفترة */}
          <div className="flex items-end gap-3 flex-wrap bg-white rounded-xl border border-[#E9E1D3] p-3">
            <div><label className="label">{tr('من تاريخ')}</label><input type="date" className="input" value={from} onChange={e => setFrom(e.target.value)} /></div>
            <div><label className="label">{tr('إلى تاريخ')}</label><input type="date" className="input" value={to} onChange={e => setTo(e.target.value)} /></div>
            {(from || to) && <button onClick={() => { setFrom(''); setTo(''); }} className="btn-secondary">{tr('كل الفترات')}</button>}
          </div>

          {isLoading ? (
            <div className="text-center text-gray-400 py-10">{tr('جاري التحميل...')}</div>
          ) : (
            <>
              {/* ملخص */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                {stat(String(sales.length), tr('عدد الفواتير'), 'text-[#E15A30]')}
                {stat(formatCurrency(salesTotal), tr('إجمالي المبيعات'), 'text-[#E15A30]')}
                {stat(String(receipts.length), tr('عدد السندات'), 'text-[#1E7A52]')}
                {stat(formatCurrency(collectTotal), tr('إجمالي التحصيل'), 'text-[#1E7A52]')}
              </div>

              {/* الفواتير */}
              <div>
                <h3 className="font-semibold text-[#1F1A13] mb-2 text-sm">{tr('الفواتير')} ({invoices.length})</h3>
                <div className="table-wrapper bg-white">
                  <table className="table">
                    <thead><tr><th>{tr('رقم الفاتورة')}</th><th>{tr('العميل')}</th><th>{tr('الأصناف')}</th><th>{tr('النوع')}</th><th>{tr('التاريخ')}</th><th>{tr('الإجمالي')}</th></tr></thead>
                    <tbody>
                      {invoices.length === 0 ? <tr><td colSpan={6} className="text-center py-6 text-gray-400">{tr('لا توجد فواتير')}</td></tr>
                        : invoices.map(i => (
                          <tr key={i.id}>
                            <td className="font-mono text-xs text-[#E15A30] align-top">{i.number}</td>
                            <td className="align-top">{i.customer.name}</td>
                            <td className="text-xs text-gray-600 align-top" style={{ maxWidth: 240 }}>
                              {i.items && i.items.length > 0
                                ? <><span className="font-semibold text-gray-700">{i.items.length} {tr('صنف')}</span>: {itemsText(i)}</>
                                : '-'}
                            </td>
                            <td className="align-top">{tr(statusLabels[i.type] || i.type)}</td>
                            <td className="text-xs text-gray-500 align-top">{formatDate(i.invoiceDate)}</td>
                            <td className="font-semibold align-top">{formatCurrency(i.total)}</td>
                          </tr>
                        ))}
                    </tbody>
                    {invoices.length > 0 && (
                      <tfoot>
                        <tr className="bg-[#FAF7F0] font-bold border-t-2 border-[#E15A30]">
                          <td colSpan={2} className="text-[#1F1A13]">{tr('الإجمالي')}</td>
                          <td className="text-[#1F1A13]">{formatNumber(soldItemsCount)} {tr('صنف مباع')}</td>
                          <td colSpan={2} className="text-xs text-gray-500">{invoices.length} {tr('فاتورة')}</td>
                          <td className="text-[#E15A30]">{formatCurrency(invoicesAmountTotal)}</td>
                        </tr>
                      </tfoot>
                    )}
                  </table>
                </div>
              </div>

              {/* السندات */}
              <div>
                <h3 className="font-semibold text-[#1F1A13] mb-2 text-sm">{tr('سندات القبض')} ({receipts.length})</h3>
                <div className="table-wrapper bg-white">
                  <table className="table">
                    <thead><tr><th>{tr('رقم السند')}</th><th>{tr('العميل')}</th><th>{tr('الطريقة')}</th><th>{tr('التاريخ')}</th><th>{tr('المبلغ')}</th></tr></thead>
                    <tbody>
                      {receipts.length === 0 ? <tr><td colSpan={5} className="text-center py-6 text-gray-400">{tr('لا توجد سندات')}</td></tr>
                        : receipts.map(r => (
                          <tr key={r.id}>
                            <td className="font-mono text-xs text-[#1E7A52]">{r.number}</td>
                            <td>{r.customer.name}</td>
                            <td>{tr(paymentMethodLabels[r.paymentMethod] || r.paymentMethod)}</td>
                            <td className="text-xs text-gray-500">{formatDate(r.receiptDate)}</td>
                            <td className="font-semibold text-[#1E7A52]">{formatCurrency(r.amount)}</td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>

        <div className="flex gap-3 p-5 border-t border-[#E9E1D3] bg-white rounded-b-2xl sticky bottom-0">
          <button onClick={exportRep} disabled={isLoading} className="btn-primary flex-1 justify-center py-2.5"><Download size={16} /> {tr('تصدير Excel')}</button>
          <button onClick={printStatement} disabled={isLoading} className="btn-secondary flex-1 justify-center py-2.5"><Printer size={16} /> {tr('طباعة الكشف')}</button>
          <button onClick={onClose} className="btn-secondary">{tr('إغلاق')}</button>
        </div>
      </div>
    </div>
  );
}

// ============ شاشة بيانات الدخول بعد إنشاء المندوب ============
function CredentialsModal({ creds, onClose }: { creds: Creds; onClose: () => void }) {
  const tr = useTr();
  const [copied, setCopied] = useState('');
  const copy = (label: string, text: string) => {
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(label);
      setTimeout(() => setCopied(''), 1500);
    });
  };
  const copyAll = () =>
    copy('all', `${tr('بيانات الدخول لتطبيق المندوب')}\n${tr('الاسم')}: ${creds.name}\n${tr('اسم المستخدم')}: ${creds.username}\n${tr('كلمة المرور')}: ${creds.password}`);

  const row = (label: string, value: string, key: string) => (
    <div className="flex items-center justify-between bg-gray-50 rounded-lg px-3 py-2.5">
      <div>
        <p className="text-[11px] text-gray-400">{label}</p>
        <p className="font-mono font-semibold text-gray-800" dir="ltr">{value}</p>
      </div>
      <button onClick={() => copy(key, value)} className="p-1.5 hover:bg-white rounded text-[#E15A30]" title={tr('نسخ')}>
        {copied === key ? <Check size={15} className="text-green-600" /> : <Copy size={15} />}
      </button>
    </div>
  );

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" dir="rtl">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md">
        <div className="p-6 text-center border-b border-gray-100">
          <div className="w-14 h-14 bg-green-100 rounded-2xl flex items-center justify-center mx-auto mb-3">
            <UserCheck size={28} className="text-green-600" />
          </div>
          <h2 className="text-lg font-bold text-gray-800">{tr('تم إنشاء حساب المندوب')}</h2>
          <p className="text-sm text-gray-500 mt-1">{creds.name}</p>
        </div>

        <div className="p-6 space-y-3">
          <div className="flex items-center gap-2 text-[#C94E28] bg-[#FBEBE2] rounded-lg px-3 py-2 text-xs">
            <KeyRound size={14} />
            {tr('سلّم هذه البيانات للمندوب ليدخل بها على التطبيق — كلمة المرور لن تظهر مرة أخرى')}
          </div>
          {row(tr('الاسم'), creds.name, 'name')}
          {row(tr('اسم المستخدم'), creds.username, 'username')}
          {row(tr('كلمة المرور'), creds.password, 'password')}
        </div>

        <div className="flex gap-3 p-6 pt-0">
          <button onClick={copyAll} className="btn-secondary flex-1 justify-center">
            {copied === 'all' ? <Check size={15} className="text-green-600" /> : <Copy size={15} />}
            {tr('نسخ الكل')}
          </button>
          <button onClick={onClose} className="btn-primary flex-1 justify-center">{tr('تم')}</button>
        </div>
      </div>
    </div>
  );
}

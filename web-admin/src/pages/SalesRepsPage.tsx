import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { salesRepApi, invoiceApi, receiptApi } from '../api/client';
import { SalesRep, Invoice, Receipt } from '../types';
import { Plus, Search, Edit, Check, X as XIcon, Copy, KeyRound, UserCheck, FileBarChart2, Download, Printer, X } from 'lucide-react';
import toast from 'react-hot-toast';
import SalesRepModal from '../components/forms/SalesRepModal';
import ResetPasswordModal from '../components/ResetPasswordModal';
import { formatCurrency, formatDate, statusLabels, paymentMethodLabels } from '../utils/format';
import { shareOrDownloadExcel, num } from '../utils/excel';

interface Creds { name: string; username: string; password: string; }

export default function SalesRepsPage() {
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [selected, setSelected] = useState<SalesRep | null>(null);
  const [createdCreds, setCreatedCreds] = useState<Creds | null>(null);
  const [statementRep, setStatementRep] = useState<SalesRep | null>(null);
  const [resetRep, setResetRep] = useState<SalesRep | null>(null);

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
        toast.success('تم تحديث بيانات المندوب');
      }
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message || 'حدث خطأ';
      toast.error(msg);
    },
  });

  const perm = (val: boolean) => val
    ? <Check size={14} className="text-green-500" />
    : <XIcon size={14} className="text-gray-300" />;

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">إدارة المناديب</h1>
        <button className="btn-primary" onClick={() => { setSelected(null); setShowModal(true); }}><Plus size={16} />إضافة مندوب</button>
      </div>

      <div className="card mb-4">
        <div className="relative max-w-sm">
          <Search size={15} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input className="input pr-9" placeholder="بحث بالاسم أو الجوال..."
            value={search} onChange={e => setSearch(e.target.value)} />
        </div>
      </div>

      <div className="card p-0">
        <div className="table-wrapper">
          <table className="table">
            <thead>
              <tr>
                <th>المندوب</th><th>الجوال</th><th>اسم المستخدم</th>
                <th className="text-center">فاتورة</th>
                <th className="text-center">آجل</th>
                <th className="text-center">نقدي</th>
                <th className="text-center">تحصيل</th>
                <th className="text-center">تغيير سعر</th>
                <th className="text-center">خصم أقصى</th>
                <th className="text-center">إضافة عميل</th>
                <th>الحالة</th>
                <th>إجراءات</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr><td colSpan={12} className="text-center py-12 text-gray-400">جاري التحميل...</td></tr>
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
                  <td className="text-center">{perm(r.canAddCustomer)}</td>
                  <td><span className={r.isActive ? 'badge-active' : 'badge-inactive'}>{r.isActive ? 'نشط' : 'غير نشط'}</span></td>
                  <td>
                    <div className="flex items-center gap-1">
                      <button onClick={() => setStatementRep(r)} className="p-1.5 hover:bg-[#F1EBDF] rounded text-[#1F1A13]" title="كشف الأداء والمبيعات"><FileBarChart2 size={14} /></button>
                      <button onClick={() => { setSelected(r); setShowModal(true); }} className="p-1.5 hover:bg-[#FBEBE2] rounded text-[#E15A30]" title="تعديل"><Edit size={14} /></button>
                      <button onClick={() => setResetRep(r)} className="p-1.5 hover:bg-amber-50 rounded text-amber-600" title="إعادة تعيين كلمة المرور"><KeyRound size={14} /></button>
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
          title="إعادة تعيين كلمة مرور المندوب"
          subject={`${resetRep.name} · ${resetRep.username}`}
          onConfirm={async (newPassword) => { await salesRepApi.update(resetRep.id, { password: newPassword }); }}
          onClose={() => setResetRep(null)}
        />
      )}
    </div>
  );
}

// ============ كشف أداء وعمل المندوب ============
function RepStatementModal({ rep, onClose }: { rep: SalesRep; onClose: () => void }) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['rep-statement', rep.id, from, to],
    queryFn: async () => {
      const base: Record<string, string | number> = { salesRepId: rep.id, limit: 5000 };
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
  const periodLabel = from && to ? `${formatDate(from)} — ${formatDate(to)}` : 'كل الفترات';

  // تصدير الكشف إلى Excel (3 أوراق: ملخص، فواتير، سندات)
  const exportRep = async () => {
    const summary = [
      { 'البند': 'عدد فواتير البيع', 'القيمة': sales.length },
      { 'البند': 'إجمالي المبيعات', 'القيمة': num(salesTotal) },
      { 'البند': 'عدد المرتجعات', 'القيمة': returns.length },
      { 'البند': 'إجمالي المرتجعات', 'القيمة': num(returnsTotal) },
      { 'البند': 'صافي المبيعات', 'القيمة': num(salesTotal - returnsTotal) },
      { 'البند': 'عدد سندات القبض', 'القيمة': receipts.length },
      { 'البند': 'إجمالي التحصيل', 'القيمة': num(collectTotal) },
    ];
    const invRows = invoices.map(i => ({
      'رقم الفاتورة': i.number, 'العميل': i.customer.name, 'النوع': statusLabels[i.type] || i.type,
      'التاريخ': formatDate(i.invoiceDate), 'الإجمالي': num(i.total), 'المدفوع': num(i.paidAmt), 'المتبقي': num(i.remainingAmt),
    }));
    const rcpRows = receipts.map(r => ({
      'رقم السند': r.number, 'العميل': r.customer.name,
      'طريقة الدفع': paymentMethodLabels[r.paymentMethod] || r.paymentMethod,
      'التاريخ': formatDate(r.receiptDate), 'المبلغ': num(r.amount),
    }));
    const out = await shareOrDownloadExcel([
      { name: 'الملخص', rows: summary, colWidths: [22, 16] },
      { name: 'الفواتير', rows: invRows, colWidths: [18, 24, 10, 16, 12, 12, 12] },
      { name: 'سندات القبض', rows: rcpRows, colWidths: [18, 24, 14, 16, 12] },
    ], `كشف-${rep.name}-${new Date().toISOString().slice(0, 10)}`);
    toast.success(out === 'shared' ? 'تمت المشاركة' : 'تم تصدير كشف المندوب');
  };

  // طباعة الكشف العادي (A4)
  const printStatement = () => {
    const esc = (s: unknown) => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string));
    const invRows = invoices.map((i, n) => `<tr><td>${n + 1}</td><td>${esc(i.number)}</td><td>${esc(i.customer.name)}</td><td>${esc(statusLabels[i.type] || i.type)}</td><td>${formatDate(i.invoiceDate)}</td><td style="text-align:left">${num(i.total).toFixed(2)}</td></tr>`).join('');
    const rcpRows = receipts.map((r, n) => `<tr><td>${n + 1}</td><td>${esc(r.number)}</td><td>${esc(r.customer.name)}</td><td>${esc(paymentMethodLabels[r.paymentMethod] || r.paymentMethod)}</td><td>${formatDate(r.receiptDate)}</td><td style="text-align:left">${num(r.amount).toFixed(2)}</td></tr>`).join('');
    const html = `<!DOCTYPE html><html dir="rtl" lang="ar"><head><meta charset="utf-8"/><title>كشف ${esc(rep.name)}</title>
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
      <h1>FieldSales — كشف المندوب</h1>
      <div class="sub">المندوب: <b>${esc(rep.name)}</b> · الجوال: ${esc(rep.phone)} · الفترة: ${periodLabel} · تاريخ الإصدار: ${formatDate(new Date().toISOString())}</div>
      <div class="cards">
        <div class="card"><div class="v">${sales.length}</div><div class="k">عدد الفواتير</div></div>
        <div class="card"><div class="v">${num(salesTotal).toFixed(2)}</div><div class="k">إجمالي المبيعات</div></div>
        <div class="card"><div class="v">${receipts.length}</div><div class="k">عدد السندات</div></div>
        <div class="card"><div class="v">${num(collectTotal).toFixed(2)}</div><div class="k">إجمالي التحصيل</div></div>
        <div class="card"><div class="v">${num(salesTotal - returnsTotal).toFixed(2)}</div><div class="k">صافي المبيعات</div></div>
      </div>
      <h2>الفواتير (${invoices.length})</h2>
      <table><thead><tr><th>#</th><th>رقم الفاتورة</th><th>العميل</th><th>النوع</th><th>التاريخ</th><th>الإجمالي</th></tr></thead><tbody>${invRows || '<tr><td colspan=6>لا توجد فواتير</td></tr>'}</tbody></table>
      <h2>سندات القبض (${receipts.length})</h2>
      <table><thead><tr><th>#</th><th>رقم السند</th><th>العميل</th><th>الطريقة</th><th>التاريخ</th><th>المبلغ</th></tr></thead><tbody>${rcpRows || '<tr><td colspan=6>لا توجد سندات</td></tr>'}</tbody></table>
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
              <h2 className="text-lg font-bold text-[#1F1A13]">كشف المندوب — {rep.name}</h2>
              <p className="text-xs text-[#6E6557]">{periodLabel}</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg text-gray-500"><X size={18} /></button>
        </div>

        <div className="p-5 space-y-4">
          {/* فلتر الفترة */}
          <div className="flex items-end gap-3 flex-wrap bg-white rounded-xl border border-[#E9E1D3] p-3">
            <div><label className="label">من تاريخ</label><input type="date" className="input" value={from} onChange={e => setFrom(e.target.value)} /></div>
            <div><label className="label">إلى تاريخ</label><input type="date" className="input" value={to} onChange={e => setTo(e.target.value)} /></div>
            {(from || to) && <button onClick={() => { setFrom(''); setTo(''); }} className="btn-secondary">كل الفترات</button>}
          </div>

          {isLoading ? (
            <div className="text-center text-gray-400 py-10">جاري التحميل...</div>
          ) : (
            <>
              {/* ملخص */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                {stat(String(sales.length), 'عدد الفواتير', 'text-[#E15A30]')}
                {stat(formatCurrency(salesTotal), 'إجمالي المبيعات', 'text-[#E15A30]')}
                {stat(String(receipts.length), 'عدد السندات', 'text-[#1E7A52]')}
                {stat(formatCurrency(collectTotal), 'إجمالي التحصيل', 'text-[#1E7A52]')}
              </div>

              {/* الفواتير */}
              <div>
                <h3 className="font-semibold text-[#1F1A13] mb-2 text-sm">الفواتير ({invoices.length})</h3>
                <div className="table-wrapper bg-white">
                  <table className="table">
                    <thead><tr><th>رقم الفاتورة</th><th>العميل</th><th>النوع</th><th>التاريخ</th><th>الإجمالي</th></tr></thead>
                    <tbody>
                      {invoices.length === 0 ? <tr><td colSpan={5} className="text-center py-6 text-gray-400">لا توجد فواتير</td></tr>
                        : invoices.map(i => (
                          <tr key={i.id}>
                            <td className="font-mono text-xs text-[#E15A30]">{i.number}</td>
                            <td>{i.customer.name}</td>
                            <td>{statusLabels[i.type] || i.type}</td>
                            <td className="text-xs text-gray-500">{formatDate(i.invoiceDate)}</td>
                            <td className="font-semibold">{formatCurrency(i.total)}</td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* السندات */}
              <div>
                <h3 className="font-semibold text-[#1F1A13] mb-2 text-sm">سندات القبض ({receipts.length})</h3>
                <div className="table-wrapper bg-white">
                  <table className="table">
                    <thead><tr><th>رقم السند</th><th>العميل</th><th>الطريقة</th><th>التاريخ</th><th>المبلغ</th></tr></thead>
                    <tbody>
                      {receipts.length === 0 ? <tr><td colSpan={5} className="text-center py-6 text-gray-400">لا توجد سندات</td></tr>
                        : receipts.map(r => (
                          <tr key={r.id}>
                            <td className="font-mono text-xs text-[#1E7A52]">{r.number}</td>
                            <td>{r.customer.name}</td>
                            <td>{paymentMethodLabels[r.paymentMethod] || r.paymentMethod}</td>
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
          <button onClick={exportRep} disabled={isLoading} className="btn-primary flex-1 justify-center py-2.5"><Download size={16} /> تصدير Excel</button>
          <button onClick={printStatement} disabled={isLoading} className="btn-secondary flex-1 justify-center py-2.5"><Printer size={16} /> طباعة الكشف</button>
          <button onClick={onClose} className="btn-secondary">إغلاق</button>
        </div>
      </div>
    </div>
  );
}

// ============ شاشة بيانات الدخول بعد إنشاء المندوب ============
function CredentialsModal({ creds, onClose }: { creds: Creds; onClose: () => void }) {
  const [copied, setCopied] = useState('');
  const copy = (label: string, text: string) => {
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(label);
      setTimeout(() => setCopied(''), 1500);
    });
  };
  const copyAll = () =>
    copy('all', `بيانات الدخول لتطبيق المندوب\nالاسم: ${creds.name}\nاسم المستخدم: ${creds.username}\nكلمة المرور: ${creds.password}`);

  const row = (label: string, value: string, key: string) => (
    <div className="flex items-center justify-between bg-gray-50 rounded-lg px-3 py-2.5">
      <div>
        <p className="text-[11px] text-gray-400">{label}</p>
        <p className="font-mono font-semibold text-gray-800" dir="ltr">{value}</p>
      </div>
      <button onClick={() => copy(key, value)} className="p-1.5 hover:bg-white rounded text-[#E15A30]" title="نسخ">
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
          <h2 className="text-lg font-bold text-gray-800">تم إنشاء حساب المندوب</h2>
          <p className="text-sm text-gray-500 mt-1">{creds.name}</p>
        </div>

        <div className="p-6 space-y-3">
          <div className="flex items-center gap-2 text-[#C94E28] bg-[#FBEBE2] rounded-lg px-3 py-2 text-xs">
            <KeyRound size={14} />
            سلّم هذه البيانات للمندوب ليدخل بها على التطبيق — كلمة المرور لن تظهر مرة أخرى
          </div>
          {row('الاسم', creds.name, 'name')}
          {row('اسم المستخدم', creds.username, 'username')}
          {row('كلمة المرور', creds.password, 'password')}
        </div>

        <div className="flex gap-3 p-6 pt-0">
          <button onClick={copyAll} className="btn-secondary flex-1 justify-center">
            {copied === 'all' ? <Check size={15} className="text-green-600" /> : <Copy size={15} />}
            نسخ الكل
          </button>
          <button onClick={onClose} className="btn-primary flex-1 justify-center">تم</button>
        </div>
      </div>
    </div>
  );
}

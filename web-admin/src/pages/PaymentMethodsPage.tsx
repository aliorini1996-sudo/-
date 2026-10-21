import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Banknote, CreditCard, Download, FileCheck, FileText, Globe, Landmark, Lock, Search, UserCheck, Wallet, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { companyApi, reportApi, teamsApi } from '../api/client';
import { useAccountingOn, AccountingOffNotice } from '../components/AccountingGate';
import { useTr } from '../i18n/strings';
import { formatCurrency, activeLocale } from '../utils/format';
import { shareOrDownloadExcel, type ExcelSheet } from '../utils/excel';
import { elementsToPdfBlob, downloadPdf } from '../rep/pdf';
import {
  filterBlocks, localDay, methodLabel, paymentMethodsSheets, repLabel, sharePct,
  type PaymentMethodsData, type PmBlock,
} from '../lib/paymentMethods';

/**
 * «طرق الدفع» (طلب المالك ٢١ أكتوبر ٢٠٢٦) — جدولٌ لكل طريقة دفع، صفوفه المناديب بما حصّله كلٌّ منهم بها في الفترة.
 *
 * على هيئة صفحة التقارير: شريط فلاتر (من/إلى/الفريق/بحث)، بطاقات إجمالي، جداول، وتصدير Excel وPDF يتبع المعروض.
 * والفرق عنها:
 *  - الفترة **اليوم** افتراضياً (لا «كل الفترات»): السؤال اليوميّ «كم حصّل كل مندوب اليوم نقداً وشبكة…».
 *  - الأرقام من الخادم (GET /reports/payment-methods) مجمّعةً بأيام الشركة المحلية — النقدي سندات قبضٍ نقدية **و**فواتير
 *    بيعٍ نقدي (يُعرض الشقّان)، والتحصيل بلا مندوب سطرٌ خارج الجدول لا صفّ (قرار المالك: «ما حصّله المندوب فقط»).
 *  - ثلاث بوّابات بترتيب: المحاسبة (AccountingOffNotice)، ثم عَلَم الشركة الذي يفعّله المالك (لافتة)، ثم صلاحية التقارير
 *    (PermissionRoute في App.tsx). والخادم يفرض الثلاث (٤٠٣) — الواجهة تُخفي فقط.
 *  - النطاق خادميّ بالكامل (المقيَّد بالقوائم ومشرف الفرق): لا تصفية نطاقٍ هنا، وقائمة الفرق نفسها مقيّدةٌ من الخادم.
 */

const METHOD_STYLE: Record<string, { icon: React.ElementType; tint: string; bar: string }> = {
  CASH: { icon: Banknote, tint: 'text-green-700 bg-green-50', bar: 'bg-green-500' },
  POS: { icon: CreditCard, tint: 'text-purple-700 bg-purple-50', bar: 'bg-purple-500' },
  BANK_TRANSFER: { icon: Landmark, tint: 'text-[#C94E28] bg-[#FBEBE2]', bar: 'bg-[#E15A30]' },
  CHEQUE: { icon: FileCheck, tint: 'text-orange-700 bg-orange-50', bar: 'bg-orange-500' },
  ONLINE: { icon: Globe, tint: 'text-sky-700 bg-sky-50', bar: 'bg-sky-500' },
};
const styleOf = (m: string) => METHOD_STYLE[m] ?? { icon: Wallet, tint: 'text-gray-600 bg-gray-100', bar: 'bg-gray-400' };

/** كود رفض الخادم (٤٠٣) — كاشُ إعدادات الشركة قد يتأخّر عن إطفاء المالك للميزة */
const errorCode = (e: unknown) => (e as { response?: { data?: { code?: string } } } | null)?.response?.data?.code;

export default function PaymentMethodsPage() {
  const tr = useTr();
  const { on: accountingOn, ready: accountingReady } = useAccountingOn();
  // مفتاح ['company'] ودالّته كبقيّة اللوحة (MainLayout وAccountingGate) — كاشٌ واحد لا طلبٌ ثانٍ
  const companyQ = useQuery({
    queryKey: ['company'],
    queryFn: async () => (await companyApi.get()).data.data as { paymentMethodsEnabled?: boolean } | null,
    staleTime: 300_000,
  });
  // مطفأة افتراضياً: لا تُفتح إلا بـtrue صريحة (غيابها من ردٍّ قديم = مطفأة)
  const featureOn = companyQ.data?.paymentMethodsEnabled === true;

  const [from, setFrom] = useState(() => localDay());
  const [to, setTo] = useState(() => localDay());
  const [search, setSearch] = useState('');
  const rangeBad = !!from && !!to && from > to;

  // «فرق العمل»: كما في التقارير — يظهر حين فعّلت الشركة الفرق ولها فرق، والمستندات بوسمها (الخادم)
  const [teamFilterState, setTeamFilter] = useState('');
  const teamsSettingsQ = useQuery({ queryKey: ['teams-settings'], queryFn: async () => (await teamsApi.settings()).data.data as { enabled: boolean } });
  const teamsQ = useQuery({
    queryKey: ['teams'], queryFn: async () => (await teamsApi.list()).data.data as { id: string; name: string; isActive: boolean }[],
    enabled: teamsSettingsQ.data?.enabled === true,
  });
  const teamsOn = teamsSettingsQ.data?.enabled === true && (teamsQ.data?.length ?? 0) > 0;
  const teamFilter = teamsOn ? teamFilterState : '';
  const teamFilterName = teamFilter === 'none' ? tr('بلا فريق') : teamsQ.data?.find(t => t.id === teamFilter)?.name ?? '';

  const reportQ = useQuery({
    queryKey: ['report-payment-methods', from, to, teamFilter],
    queryFn: async () => {
      const params: Record<string, string> = {};
      if (from) params.from = from;
      if (to) params.to = to;
      if (teamFilter) params.teamId = teamFilter;
      return (await reportApi.paymentMethods(params)).data.data as PaymentMethodsData;
    },
    enabled: accountingReady && accountingOn && featureOn && !rangeBad,
    // رفضٌ صريح من الخادم (٤٠٣ عَلَم/محاسبة، ٤٠٠ تاريخ) لا يتغيّر بالإعادة — الإعادة لانقطاع الشبكة و٥xx وحدهما
    retry: (n, e) => {
      const status = (e as { response?: { status?: number } } | null)?.response?.status ?? 0;
      return !(status >= 400 && status < 500) && n < 2;
    },
  });
  const data = reportQ.data;
  const blocks: PmBlock[] = useMemo(() => filterBlocks(data?.methods ?? [], search), [data, search]);
  const q = search.trim();
  const range = data ? (data.range.from === data.range.to ? data.range.from : `${data.range.from} — ${data.range.to}`) : '';

  // ─── التصدير: يتبع المعروض (البحث ضمناً) ───
  const safeName = (s: string) => s.replace(/[\\/?*[\]:]/g, '·').slice(0, 60);
  const title = teamFilterName ? `${tr('طرق الدفع')} - ${teamFilterName}` : tr('طرق الدفع');
  // اسم الملف بالفترة المعروضة (من الخادم: أيام الشركة) لا بيوم التصدير — ملفّ أمسِ المصدَّر اليوم يحمل تاريخ أمس
  const fileName = () => `${safeName(title)}-${range.replace(' — ', '_')}`;
  const sheetsOrNull = (): ExcelSheet[] | null => (data && blocks.some(b => b.rows.length) ? paymentMethodsSheets(blocks, tr) : null);

  const handleExport = async () => {
    const sheets = sheetsOrNull();
    if (!sheets) { toast.error(tr('لا توجد بيانات للتصدير')); return; }
    const out = await shareOrDownloadExcel(sheets, fileName());
    toast.success(out === 'shared' ? tr('تمت المشاركة') : tr('تم التصدير'));
  };

  /* PDF: نسخةٌ مختصرة من sheetsToPdf في صفحة التقارير (تبقى هناك — حرّاس اختبارها تثبّتها في ملفها). التقطيع إلزاميّ:
   * جدولٌ واحدٌ طويل يتجاوز حدّ الـcanvas فيخرج PDF صفحاتٍ بيضاء صامتة — عنصرٌ لكل ٣٠٠ صفّ. */
  const ROWS_PER_SLICE = 300;
  const handleExportPdf = async () => {
    const sheets = sheetsOrNull();
    if (!sheets) { toast.error(tr('لا توجد بيانات للتصدير')); return; }
    const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const teamLine = teamFilterName ? ` · ${tr('الفريق')}: ${teamFilterName}` : '';
    const header = `<div style="border-bottom:2px solid #E15A30;padding-bottom:10px;margin-bottom:8px"><h2 style="font-size:18px;margin:0;color:#1F1A13">${esc(tr('طرق الدفع'))}</h2><p style="font-size:12px;color:#6E6557;margin:4px 0 0">${esc(tr('الفترة'))}: ${esc(range)}${esc(teamLine)} · ${esc(tr('تاريخ الإصدار'))}: ${esc(new Date().toLocaleDateString(activeLocale()))}</p></div>`;
    const els: HTMLElement[] = [];
    for (const sh of sheets) {
      const cols = sh.rows.length ? Object.keys(sh.rows[0]) : [];
      const thead = `<tr>${cols.map(c => `<th style="border:1px solid #ddd;padding:6px 8px;background:#FAF7F0;font-size:11px;text-align:right;font-weight:700">${esc(c)}</th>`).join('')}</tr>`;
      for (let i = 0; i < Math.max(1, sh.rows.length); i += ROWS_PER_SLICE) {
        const tbody = sh.rows.slice(i, i + ROWS_PER_SLICE).map(r => `<tr>${cols.map(c => `<td style="border:1px solid #eee;padding:5px 8px;font-size:11px;text-align:right">${esc(r[c])}</td>`).join('')}</tr>`).join('');
        const el = document.createElement('div');
        el.style.cssText = 'position:fixed;left:-99999px;top:0;width:780px;background:#fff;padding:24px;font-family:Tahoma,Arial,sans-serif;direction:rtl';
        el.innerHTML = (els.length === 0 ? header : '')
          + `<h3 style="font-size:13px;margin:16px 0 6px;color:#1F1A13">${esc(sh.name)}${i > 0 ? ` (${esc(tr('تابع'))})` : ''}</h3><table style="width:100%;border-collapse:collapse;table-layout:fixed">${thead}${tbody}</table>`;
        document.body.appendChild(el);
        els.push(el);
      }
    }
    const toastId = toast.loading(tr('جارٍ إنشاء PDF'));
    await new Promise(r => setTimeout(r, 30));
    try {
      downloadPdf(await elementsToPdfBlob(els), fileName());
      toast.success(tr('تم التصدير'), { id: toastId });
    } catch { toast.error(tr('تعذر إنشاء PDF — جرّب مدى أقصر أو صدّر Excel'), { id: toastId }); }
    finally { els.forEach(e => e.remove()); }
  };

  // ─── البوّابات ───
  if (!accountingReady || companyQ.isLoading) return null;
  if (!accountingOn) return <AccountingOffNotice />;
  if (!featureOn || errorCode(reportQ.error) === 'PAYMENT_METHODS_NOT_ALLOWED') {
    return (
      <div className="card max-w-xl mx-auto text-center py-10">
        <div className="w-12 h-12 rounded-2xl bg-[#F1EBDF] text-[#9A8F7E] flex items-center justify-center mx-auto mb-3">
          <Lock size={22} />
        </div>
        <h1 className="text-lg font-bold text-[#1F1A13]">{tr('صفحة طرق الدفع غير مفعلة لشركتك')}</h1>
        <p className="text-sm text-gray-500 mt-1.5">{tr('تواصل مع مزود الخدمة لتفعيلها')}</p>
      </div>
    );
  }

  const scrollTo = (m: string) => document.getElementById(`pm-${m}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">{tr('طرق الدفع')}</h1>
          <p className="text-xs text-gray-400 mt-0.5">{tr('تحصيل كل مندوب موزعا على طرق الدفع في الفترة المحددة')}</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button className="btn-secondary" onClick={handleExport}><Download size={16} /> {tr('تصدير Excel')}</button>
          <button className="btn-secondary" onClick={handleExportPdf}><FileText size={16} /> {tr('تصدير PDF')}</button>
        </div>
      </div>

      {/* الفلاتر — هيئة صفحة التقارير */}
      <div className="card mb-4">
        <div className="flex gap-3 flex-wrap items-end">
          <div>
            <label className="label">{tr('من')}</label>
            {/* لا خانة فارغة: الخادم يقرأ «من» الفارغة يومَ «إلى» وحده — فتُملأ بالطرف الآخر أو باليوم، والأرقام تطابق ما تراه */}
            <input type="date" className="input w-36" value={from} max={to || undefined} onChange={e => setFrom(e.target.value || to || localDay())} />
          </div>
          <div>
            <label className="label">{tr('إلى')}</label>
            <input type="date" className="input w-36" value={to} min={from || undefined} onChange={e => setTo(e.target.value || from || localDay())} />
          </div>
          {teamsOn && (
            <div>
              <label className="label">{tr('الفريق')}</label>
              <select className="input w-44" value={teamFilter} onChange={e => setTeamFilter(e.target.value)}>
                <option value="">{tr('كل الفرق')}</option>
                {(teamsQ.data ?? []).map(t => <option key={t.id} value={t.id}>{t.name}{t.isActive ? '' : ` (${tr('مؤرشف')})`}</option>)}
                <option value="none">{tr('بلا فريق')}</option>
              </select>
            </div>
          )}
          <div className="flex-1 min-w-[200px]">
            <label className="label">{tr('بحث')}</label>
            <div className="relative">
              <Search size={15} className="absolute top-1/2 -translate-y-1/2 start-3 text-gray-400 pointer-events-none" />
              <input className="input ps-9 pe-8 w-full" value={search} onChange={e => setSearch(e.target.value)} placeholder={tr('اسم المندوب')} />
              {search && (
                <button type="button" onClick={() => setSearch('')} title={tr('مسح البحث')}
                  className="absolute top-1/2 -translate-y-1/2 end-2 text-gray-400 hover:text-gray-600">
                  <X size={15} />
                </button>
              )}
            </div>
          </div>
        </div>
        {/* الفترة التي حُسبت بها الأرقام فعلاً (من ردّ الخادم) — لا يُقرأ يومٌ واحد مجموعاً لفترة */}
        {range && <p className="text-xs text-[#6E6557] mt-2">{tr('الفترة')}: <bdi dir="ltr">{range}</bdi></p>}
        {rangeBad && <p className="text-xs text-red-600 mt-2">{tr('تاريخ البداية بعد تاريخ النهاية')}</p>}
      </div>

      {rangeBad ? null : reportQ.isPending ? (
        <div className="card flex items-center justify-center h-32 text-gray-400">{tr('جاري التحميل')}</div>
      ) : reportQ.isError || !data ? (
        <div className="card flex flex-col items-center gap-3 py-10 text-gray-500">
          <span>{tr('تعذر تحميل التقرير')}</span>
          <button onClick={() => reportQ.refetch()} className="btn-secondary">{tr('إعادة المحاولة')}</button>
        </div>
      ) : (
        <div className="space-y-4">
          {/* البطاقات: إجمالي الفترة لكل طريقة (كامل الفترة لا المعروض — البحث يقصّ الجداول وحدها) */}
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
            <div className="card text-center">
              <p className="text-xs text-gray-500">{tr('إجمالي التحصيل')}</p>
              <p className="text-xl font-bold text-green-600 tabular-nums">{formatCurrency(data.total.amount)}</p>
              <p className="text-[11px] text-gray-400 mt-0.5 tabular-nums">{data.total.count} {tr('عملية')} · {tr('عدد المناديب المحصلين')}: {data.repsCount}</p>
            </div>
            {data.methods.map(b => {
              const st = styleOf(b.method);
              return (
                <button key={b.method} type="button" onClick={() => scrollTo(b.method)} className="card text-center hover:border-[#E15A30]/40 transition-colors">
                  <p className="text-xs text-gray-500 flex items-center justify-center gap-1.5">
                    <span className={`w-5 h-5 rounded-md flex items-center justify-center ${st.tint}`}><st.icon size={12} /></span>
                    {methodLabel(b.method, tr)}
                  </p>
                  <p className="text-lg font-bold text-gray-700 tabular-nums mt-1">{formatCurrency(b.total.amount)}</p>
                  <p className="text-[11px] text-gray-400 mt-0.5 tabular-nums">{b.total.count} {tr('عملية')}</p>
                </button>
              );
            })}
          </div>

          {q && (
            <p className="text-xs text-[#6E6557]">{tr('نتائج البحث عن')} «{q}»</p>
          )}

          {/* جدولٌ لكل طريقة دفع — النقدي بعرض الصفحة لأعمدة شقّيه */}
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            {blocks.map(b => <MethodTable key={b.method} block={b} searching={!!q} />)}
          </div>
        </div>
      )}
    </div>
  );
}

function MethodTable({ block: b, searching }: { block: PmBlock; searching: boolean }) {
  const tr = useTr();
  const st = styleOf(b.method);
  const cash = b.method === 'CASH';
  return (
    <div id={`pm-${b.method}`} className={`card p-0 scroll-mt-4 ${cash ? 'xl:col-span-2' : ''}`}>
      <div className="px-5 py-3 border-b border-[#F1EBDF] flex items-center gap-3 text-sm flex-wrap">
        <span className="flex items-center gap-2">
          <span className={`w-7 h-7 rounded-lg flex items-center justify-center ${st.tint}`}><st.icon size={15} /></span>
          <b className="text-[#1F1A13]">{methodLabel(b.method, tr)}</b>
        </span>
        <span className="text-[#9A8F7E]">•</span>
        <span className="text-[#6E6557]">
          {searching ? tr('إجمالي المعروض') : tr('الإجمالي')}: <b className="text-green-700 tabular-nums">{formatCurrency(b.total.amount)}</b> ({b.total.count} {tr('عملية')})
        </span>
        <span className="text-[#9A8F7E] flex items-center gap-1"><UserCheck size={13} /> {b.rows.length}</span>
      </div>
      {cash && <p className="px-5 pt-2 text-[11px] text-[#9A8F7E]">{tr('النقدي يشمل سندات القبض النقدية وفواتير البيع النقدي')}</p>}

      {b.rows.length === 0 ? (
        <div className="text-center text-gray-400 text-sm py-8">
          {searching ? tr('لا نتائج مطابقة للبحث') : tr('لا تحصيل بهذه الطريقة في الفترة')}
        </div>
      ) : (
        <div className="table-wrapper">
          <table className="table">
            <thead>
              <tr>
                <th>#</th>
                <th>{tr('المندوب')}</th>
                <th>{tr('المبلغ')}</th>
                <th>{tr('عدد العمليات')}</th>
                {cash && <th>{tr('من سندات القبض')}</th>}
                {cash && <th>{tr('من الفواتير النقدية')}</th>}
                <th>{tr('النسبة من الإجمالي')}</th>
              </tr>
            </thead>
            <tbody>
              {b.rows.map((r, i) => {
                const pct = sharePct(r.amount, b.total.amount);
                return (
                  <tr key={r.salesRepId}>
                    <td className="text-gray-400">{i + 1}</td>
                    <td className={`font-medium ${r.repActive ? 'text-gray-800' : 'text-gray-500'}`}>{repLabel(r, tr)}</td>
                    <td className="tabular-nums font-bold text-green-600">{formatCurrency(r.amount)}</td>
                    <td className="tabular-nums text-gray-700">{r.count}</td>
                    {cash && (
                      <td className="tabular-nums text-gray-600">
                        {r.receiptsCount ? <>{formatCurrency(r.receiptsAmount)} <span className="text-[11px] text-gray-400">({r.receiptsCount})</span></> : <span className="text-gray-300">—</span>}
                      </td>
                    )}
                    {cash && (
                      <td className="tabular-nums text-gray-600">
                        {r.invoicesCount ? <>{formatCurrency(r.invoicesAmount)} <span className="text-[11px] text-gray-400">({r.invoicesCount})</span></> : <span className="text-gray-300">—</span>}
                      </td>
                    )}
                    <td>
                      <div className="flex items-center gap-2">
                        <div className="flex-1 min-w-[40px] bg-gray-200 rounded-full h-1.5">
                          <div className={`h-1.5 rounded-full ${st.bar}`} style={{ width: `${pct}%` }} />
                        </div>
                        <span className="text-xs text-gray-600 w-9 tabular-nums">{pct}%</span>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="font-bold border-t-2 border-[#E9E1D3] bg-[#FAF7F0]">
                <td colSpan={2} className="text-[#1F1A13]">{searching ? tr('إجمالي المعروض') : tr('الإجمالي')}</td>
                <td className="tabular-nums text-green-700">{formatCurrency(b.total.amount)}</td>
                <td className="tabular-nums text-gray-700">{b.total.count}</td>
                {cash && <td className="tabular-nums text-gray-700">{formatCurrency(b.total.receiptsAmount)} <span className="text-[11px] text-gray-400">({b.total.receiptsCount})</span></td>}
                {cash && <td className="tabular-nums text-gray-700">{formatCurrency(b.total.invoicesAmount)} <span className="text-[11px] text-gray-400">({b.total.invoicesCount})</span></td>}
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {/* بلا مندوب: خارج الجدول وإجماليه (قرار المالك) — يُذكر كي لا يختفي مالٌ محصَّل عن الشاشة */}
      {b.noRep.count > 0 && !searching && (
        <p className="px-5 py-2.5 border-t border-[#F1EBDF] text-[11px] text-[#9A8F7E]">
          {tr('خارج الجدول: تحصيل بلا مندوب (سند من الإدارة أو مندوب محذوف)')}: <b className="tabular-nums text-[#6E6557]">{formatCurrency(b.noRep.amount)}</b> ({b.noRep.count} {tr('عملية')})
        </p>
      )}
    </div>
  );
}

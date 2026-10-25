import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Banknote, CreditCard, Download, FileCheck, FileText, Globe, Landmark, Lock, Search, Settings2, Wallet, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { companyApi, reportApi, teamsApi } from '../api/client';
import { useAccountingOn, AccountingOffNotice } from '../components/AccountingGate';
import { useTr } from '../i18n/strings';
import { formatCurrency, activeLocale } from '../utils/format';
import { shareOrDownloadExcel, type ExcelSheet } from '../utils/excel';
import { elementsToPdfBlob, downloadPdf } from '../rep/pdf';
import {
  hasCashLikeCustom, listTotal, localDay, methodLabel, repLabel, repListSheets, repMethodList,
  type PaymentMethodsData, type PmBlock, type PmRepGroup,
} from '../lib/paymentMethods';
import { useAuthStore } from '../store/authStore';
import { methodIconComponent } from '../components/PaymentMethodIcon';
import PaymentMethodsManager from '../components/PaymentMethodsManager';

/**
 * «طرق الدفع» (طلب المالك ٢١ أكتوبر ٢٠٢٦) — **قائمة واحدة بكلّ المناديب**، والمندوب يتكرّر مع كلّ طريقة دفع:
 * «محمد نقدي / محمد شبكة / محمد تحويل / محمد شيك / محمد دفع إلكتروني» ثم إجماليُّه، ثم المندوب التالي (طلبه الثاني بدل
 * جدولٍ لكل طريقة). كلّ مناديب النطاق ولو بلا تحصيل (أصفارٌ لا غياب).
 *
 * على هيئة صفحة التقارير: شريط فلاتر (من/إلى/الفريق/بحث)، بطاقات إجمالي لكل طريقة، القائمة، وتصدير Excel وPDF يتبع المعروض.
 * والفرق عنها:
 *  - الفترة **اليوم** افتراضياً (لا «كل الفترات»): السؤال اليوميّ «كم حصّل كل مندوب اليوم نقداً وشبكة…».
 *  - الأرقام من الخادم (GET /reports/payment-methods) مجمّعةً بأيام الشركة المحلية — النقدي سندات قبضٍ نقدية **و**فواتير
 *    بيعٍ نقدي (يُعرض الشقّان)، والتحصيل بلا مندوب سطرٌ خارج الجدول لا صفّ (قرار المالك: «ما حصّله المندوب فقط»).
 *  - ثلاث بوّابات بترتيب: المحاسبة (AccountingOffNotice)، ثم عَلَم الشركة الذي يفعّله المالك (لافتة)، ثم صلاحية التقارير
 *    (PermissionRoute في App.tsx). والخادم يفرض الثلاث (٤٠٣) — الواجهة تُخفي فقط.
 *  - النطاق خادميّ بالكامل (المقيَّد بالقوائم ومشرف الفرق): لا تصفية نطاقٍ هنا، وقائمة الفرق نفسها مقيّدةٌ من الخادم.
 *  - «إدارة طرق الدفع» (طلب المالك ٢٥ أكتوبر): زرٌّ في الرأس لمن يملك «إعدادات الشركة» (وجلسة المالك) يفتح النافذة
 *    (components/PaymentMethodsManager). وكل جدولٍ بوصف الخادم: اسم الشركة للطريقة، والمضافة جدولٌ بمفتاحها وأيقونتها ولون
 *    أساسها — ولو «تُعامل مثل» النقدي فلا تدخل سطر «نقدي» (سطورٌ مستقلّة تدخل عهدة المندوب النقدية).
 */

const METHOD_STYLE: Record<string, { icon: React.ElementType; tint: string }> = {
  CASH: { icon: Banknote, tint: 'text-green-700 bg-green-50' },
  POS: { icon: CreditCard, tint: 'text-purple-700 bg-purple-50' },
  BANK_TRANSFER: { icon: Landmark, tint: 'text-[#C94E28] bg-[#FBEBE2]' },
  CHEQUE: { icon: FileCheck, tint: 'text-orange-700 bg-orange-50' },
  ONLINE: { icon: Globe, tint: 'text-sky-700 bg-sky-50' },
};
const styleOf = (m: string) => METHOD_STYLE[m] ?? { icon: Wallet, tint: 'text-gray-600 bg-gray-100' };
/** نمط جدولٍ من وصف الخادم: المضافة بأيقونتها المختارة ولون أساسها، والمدمجة كما اليوم */
const styleOfBlock = (b: Pick<PmBlock, 'method' | 'base' | 'custom' | 'icon'> | undefined, m: string) =>
  b?.custom ? { icon: methodIconComponent(b.icon, b.base ?? 'CASH'), tint: styleOf(b.base ?? '').tint } : styleOf(m);

/** كود رفض الخادم (٤٠٣) — كاشُ إعدادات الشركة قد يتأخّر عن إطفاء المالك للميزة */
const errorCode = (e: unknown) => (e as { response?: { data?: { code?: string } } } | null)?.response?.data?.code;

export default function PaymentMethodsPage() {
  const tr = useTr();
  const { on: accountingOn, ready: accountingReady } = useAccountingOn();
  // مفتاح ['company'] ودالّته كبقيّة اللوحة (MainLayout وAccountingGate) — كاشٌ واحد لا طلبٌ ثانٍ
  const companyQ = useQuery({
    queryKey: ['company'],
    queryFn: async () => (await companyApi.get()).data.data as { paymentMethodsEnabled?: boolean; paymentMethodsConfig?: unknown } | null,
    staleTime: 300_000,
  });
  // مطفأة افتراضياً: لا تُفتح إلا بـtrue صريحة (غيابها من ردٍّ قديم = مطفأة)
  const featureOn = companyQ.data?.paymentMethodsEnabled === true;
  // «إدارة طرق الدفع»: صلاحية «إعدادات الشركة» (الغائب مسموح كبقيّة اللوحة)، وجلسة المالك تمرّ كما على الخادم
  const user = useAuthStore(s => s.user);
  const impersonating = useAuthStore(s => s.impersonating);
  const canManageMethods = !!impersonating || (!!user && user.canManageCompanySettings !== false);
  const [managing, setManaging] = useState(false);

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
  const groups: PmRepGroup[] = useMemo(() => (data ? repMethodList(data, search) : []), [data, search]);
  const q = search.trim();
  const range = data ? (data.range.from === data.range.to ? data.range.from : `${data.range.from} — ${data.range.to}`) : '';

  // ─── التصدير: يتبع المعروض (البحث ضمناً) ───
  const safeName = (s: string) => s.replace(/[\\/?*[\]:]/g, '·').slice(0, 60);
  const title = teamFilterName ? `${tr('طرق الدفع')} - ${teamFilterName}` : tr('طرق الدفع');
  // اسم الملف بالفترة المعروضة (من الخادم: أيام الشركة) لا بيوم التصدير — ملفّ أمسِ المصدَّر اليوم يحمل تاريخ أمس
  const fileName = () => `${safeName(title)}-${range.replace(' — ', '_')}`;
  const sheetsOrNull = (): ExcelSheet[] | null => (data && groups.length ? repListSheets(groups, data, tr) : null);

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

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">{tr('طرق الدفع')}</h1>
          <p className="text-xs text-gray-400 mt-0.5">{tr('تحصيل كل مندوب موزعا على طرق الدفع في الفترة المحددة')}</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {canManageMethods && (
            <button className="btn-secondary" onClick={() => setManaging(true)}><Settings2 size={16} /> {tr('إدارة طرق الدفع')}</button>
          )}
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
              const st = styleOfBlock(b, b.method);
              return (
                <div key={b.method} className="card text-center">
                  <p className="text-xs text-gray-500 flex items-center justify-center gap-1.5 flex-wrap">
                    <span className={`w-5 h-5 rounded-md flex items-center justify-center ${st.tint}`}><st.icon size={12} /></span>
                    {methodLabel(b.method, tr, data)}
                    {/* معطّلة لا تظهر إلا لأن بها تحصيلاً في الفترة — تُوسَم كي لا تُظنّ متاحةً في نموذج السند */}
                    {b.active === false && <span className="text-[10px] text-[#9A8F7E]">({tr('معطلة')})</span>}
                  </p>
                  <p className="text-lg font-bold text-gray-700 tabular-nums mt-1">{formatCurrency(b.total.amount)}</p>
                  <p className="text-[11px] text-gray-400 mt-0.5 tabular-nums">{b.total.count} {tr('عملية')}</p>
                </div>
              );
            })}
          </div>

          {q && (
            <p className="text-xs text-[#6E6557]">{tr('نتائج البحث عن')} «{q}»</p>
          )}

          <RepMethodList groups={groups} searching={!!q} noRep={data.noRep} data={data} />
        </div>
      )}

      {managing && <PaymentMethodsManager onClose={() => setManaging(false)} />}
    </div>
  );
}

/**
 * القائمة: لكلّ مندوبٍ خمسة سطور (طريقةٌ لكلّ سطر، واسمه مكرَّرٌ في كلّ سطر كما طلب المالك) ثم سطر إجماليّه، وتتناوب
 * خلفيّة المناديب ليُقرأ كلٌّ منهم كتلةً. والنقدي يذكر شقّيه تحت مبلغه. والصفر رماديّ لا يختفي.
 */
function RepMethodList({ groups, searching, noRep, data }: { groups: PmRepGroup[]; searching: boolean; noRep: { amount: number; count: number }; data: PaymentMethodsData }) {
  const tr = useTr();
  const total = listTotal(groups);
  const blockOf = (m: string) => data.methods.find(b => b.method === m);
  return (
    <div className="card p-0">
      <div className="px-5 py-3 border-b border-[#F1EBDF] flex items-center gap-3 text-sm flex-wrap">
        <b className="text-[#1F1A13]">{tr('قائمة المناديب')}</b>
        <span className="text-[#9A8F7E]">•</span>
        <span className="text-[#6E6557]">{groups.length} {tr('مندوب')}</span>
        <span className="text-[#9A8F7E]">•</span>
        <span className="text-[#6E6557]">
          {searching ? tr('إجمالي المعروض') : tr('الإجمالي')}: <b className="text-green-700 tabular-nums">{formatCurrency(total.amount)}</b> ({total.count} {tr('عملية')})
        </span>
      </div>
      <p className="px-5 pt-2 text-[11px] text-[#9A8F7E]">{tr('النقدي يشمل سندات القبض النقدية وفواتير البيع النقدي')}</p>
      {/* مضافةٌ «تُعامل مثل» النقدي: سطرها مستقلّ عن «نقدي» (كل سندٍ في سطرٍ واحد فالإجمالي صحيح) وأساسها نقديّ في العهدة */}
      {hasCashLikeCustom(data) && (
        <p className="px-5 pt-0.5 text-[11px] text-[#9A8F7E]">{tr('الطرق المضافة التي تعامل مثل النقدي لها سطورها الخاصة وتدخل عهدة المندوب النقدية')}</p>
      )}

      {groups.length === 0 ? (
        <div className="text-center text-gray-400 text-sm py-8">
          {searching ? tr('لا نتائج مطابقة للبحث') : tr('لا مناديب في نطاقك')}
        </div>
      ) : (
        <div className="table-wrapper">
          <table className="table">
            <thead>
              <tr>
                <th>{tr('المندوب')}</th>
                <th>{tr('طريقة الدفع')}</th>
                <th>{tr('المبلغ')}</th>
                <th>{tr('عدد العمليات')}</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g, gi) => {
                const name = repLabel(g, tr);
                const band = gi % 2 === 1 ? 'bg-[#FAF7F0]/70' : '';
                return [
                  ...g.lines.map(l => {
                    const st = styleOfBlock(blockOf(l.method), l.method);
                    const has = l.count > 0 || l.amount !== 0;
                    return (
                      <tr key={`${g.salesRepId}-${l.method}`} className={band}>
                        <td className={`font-medium ${g.repActive ? 'text-gray-800' : 'text-gray-500'}`}>{name}</td>
                        <td>
                          <span className="inline-flex items-center gap-2">
                            <span className={`w-6 h-6 rounded-md flex items-center justify-center ${st.tint}`}><st.icon size={13} /></span>
                            {methodLabel(l.method, tr, data)}
                          </span>
                        </td>
                        <td className={`tabular-nums ${has ? 'font-bold text-green-600' : 'text-gray-300'}`}>
                          {formatCurrency(l.amount)}
                          {l.method === 'CASH' && l.receiptsCount > 0 && l.invoicesCount > 0 && (
                            <span className="block text-[11px] font-normal text-gray-400">
                              {tr('من سندات القبض')} {formatCurrency(l.receiptsAmount)} · {tr('من الفواتير النقدية')} {formatCurrency(l.invoicesAmount)}
                            </span>
                          )}
                          {l.method === 'CASH' && l.invoicesCount > 0 && l.receiptsCount === 0 && (
                            <span className="block text-[11px] font-normal text-gray-400">{tr('من الفواتير النقدية')}</span>
                          )}
                        </td>
                        <td className={`tabular-nums ${has ? 'text-gray-700' : 'text-gray-300'}`}>{l.count}</td>
                      </tr>
                    );
                  }),
                  <tr key={`${g.salesRepId}-total`} className={`${band} font-bold border-b-2 border-[#E9E1D3]`}>
                    <td className="text-[#1F1A13]">{name}</td>
                    <td className="text-[#6E6557]">{tr('الإجمالي')}</td>
                    <td className="tabular-nums text-green-700">{formatCurrency(g.total.amount)}</td>
                    <td className="tabular-nums text-gray-700">{g.total.count}</td>
                  </tr>,
                ];
              })}
            </tbody>
            <tfoot>
              <tr className="font-bold border-t-2 border-[#E9E1D3] bg-[#FAF7F0]">
                <td colSpan={2} className="text-[#1F1A13]">{searching ? tr('إجمالي المعروض') : tr('الإجمالي العام')}</td>
                <td className="tabular-nums text-green-700">{formatCurrency(total.amount)}</td>
                <td className="tabular-nums text-gray-700">{total.count}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {/* بلا مندوب: خارج القائمة وإجماليّها (قرار المالك) — يُذكر كي لا يختفي مالٌ محصَّل عن الشاشة */}
      {noRep.count > 0 && !searching && (
        <p className="px-5 py-2.5 border-t border-[#F1EBDF] text-[11px] text-[#9A8F7E]">
          {tr('خارج القائمة: تحصيل بلا مندوب (سند من الإدارة أو مندوب محذوف)')}: <b className="tabular-nums text-[#6E6557]">{formatCurrency(noRep.amount)}</b> ({noRep.count} {tr('عملية')})
        </p>
      )}
    </div>
  );
}

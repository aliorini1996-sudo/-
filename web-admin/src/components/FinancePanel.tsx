import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { financeApi } from '../api/client';
import {
  X, TrendingUp, TrendingDown, Wallet, Receipt, Plus, Trash2, PauseCircle,
  Repeat, Calendar, PieChart, AlertTriangle, CheckCircle2, Building2, Link2, RefreshCw, FileText, Clock,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { backdropClose } from '../lib/backdropClose';

interface MonthlyFinance {
  year: number; month: number;
  revenueSar: number; revenueNetSar: number; vatCollectedSar: number;
  gatewayFeeSar: number; expensesSar: number; vatPaidSar: number; vatDueSar: number;
  profitSar: number; marginPct: number; paidCount: number;
}
interface Snapshot {
  vatPct: number; gatewayFeePct: number; mrrSar: number; arrSar: number;
  payingTenants: number; unpaidTenants: number; totalTenants: number;
  expiringSoon: number; mrrBasis: string;
  monthlyRecurringCostSar: number; runwayNote: string;
  staleExpenses: number; staleDaysThreshold: number;
  current: MonthlyFinance; months: MonthlyFinance[];
  byCategory: { category: string; amountSar: number }[];
}
interface Revenue {
  id: string; clientName: string; description: string; amountSar: number;
  vatSar: number; gatewayFeeSar: number; netSar: number;
  isRecurring: boolean; months: number; paidAt: string;
}
interface RevenueList {
  rows: Revenue[]; totalCount: number; totalSar: number; truncated: boolean;
}
interface Expense {
  id: string; label: string; category: string; amountSar: number; vatSar: number;
  isRecurring: boolean; startsOn: string; endsOn: string | null; note: string | null;
  amountOriginal: number | null; currency: string; fxRate: number | null;
  staleDays: number; isStale: boolean;
}
interface QuarterFinance {
  year: number; quarter: number; periodLabel: string;
  revenueSar: number; vatCollectedSar: number; vatPaidSar: number; vatDueSar: number;
  expensesSar: number; profitSar: number;
}
interface InvoiceRow {
  id: string; number: string; buyerName: string; description: string;
  totalSar: number; vatSar: number; issuedAt: string;
}
interface InvoiceList {
  rows: InvoiceRow[]; ready: boolean; sellerName: string; vatNumber: string; note: string;
}

const sar = (n: number) => `${n.toLocaleString('en-US', { maximumFractionDigits: 2 })} ر.س`;
const MONTH_AR = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];

const CATEGORY: Record<string, { label: string; cls: string }> = {
  hosting: { label: 'استضافة', cls: 'bg-blue-50 text-blue-700' },
  ai: { label: 'ذكاء اصطناعي', cls: 'bg-purple-50 text-purple-700' },
  marketing: { label: 'تسويق', cls: 'bg-[#FBEBE2] text-[#B8431F]' },
  tools: { label: 'أدوات', cls: 'bg-gray-100 text-gray-700' },
  salaries: { label: 'رواتب', cls: 'bg-amber-50 text-amber-800' },
  other: { label: 'أخرى', cls: 'bg-gray-100 text-gray-600' },
};

/** بطاقة رقم — الرقم أولاً ثم تسميته، فالمالك يمسح الأرقام لا النصوص */
function Stat({ label, value, hint, tone = 'ink', icon: Icon }: {
  label: string; value: string; hint?: string; tone?: 'ink' | 'good' | 'bad'; icon: React.ElementType;
}) {
  const toneCls = tone === 'good' ? 'text-green-700' : tone === 'bad' ? 'text-red-600' : 'text-[#1F1A13]';
  return (
    <div className="rounded-xl border border-[#E7DECD] bg-white p-4">
      <div className="flex items-center gap-2 text-[11px] font-semibold text-gray-500">
        <Icon className="w-3.5 h-3.5" />
        {label}
      </div>
      <div className={`mt-1.5 text-xl font-bold tabular-nums ${toneCls}`} dir="ltr">{value}</div>
      {hint && <div className="mt-0.5 text-[11px] text-gray-400">{hint}</div>}
    </div>
  );
}

/**
 * الإدارة المالية — نافذة المالك.
 *
 * كل رقم هنا **مشتقّ في الخادم** من مصادر الحقيقة (مدفوعات ميسر · الاشتراكات ·
 * المصروفات المسجّلة). المالك لا يُدخل إلا مصروفاته، والباقي يُحسب: الإيراد،
 * الضريبة، الربح، والهامش. والمصروف المتكرّر يُحتسب في كل شهر يسري فيه دون
 * إعادة إدخال — وهذا ما يجعلها مؤتمتة لا دفتراً يدوياً.
 */
export default function FinancePanel({ onClose, onAddRevenue }: { onClose: () => void; onAddRevenue?: () => void }) {
  const qc = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [label, setLabel] = useState('');
  const [category, setCategory] = useState('hosting');
  const [amount, setAmount] = useState('');
  const [isRecurring, setIsRecurring] = useState(true);
  const [vatMode, setVatMode] = useState<'none' | 'inclusive' | 'exclusive'>('none');
  const [currency, setCurrency] = useState<'SAR' | 'USD' | 'EUR'>('SAR');
  const [quarter, setQuarter] = useState(() => Math.floor(new Date().getMonth() / 3) + 1);
  const [startsOn, setStartsOn] = useState(() => new Date().toISOString().slice(0, 10));

  const { data: snap, isLoading, isError } = useQuery({
    queryKey: ['finance-snapshot'],
    queryFn: async () => (await financeApi.snapshot()).data.data as Snapshot,
  });
  const { data: revenues } = useQuery({
    queryKey: ['finance-revenues'],
    queryFn: async () => (await financeApi.listRevenues()).data.data as RevenueList,
  });
  const year = new Date().getFullYear();
  const { data: qtr } = useQuery({
    queryKey: ['finance-quarter', year, quarter],
    queryFn: async () => (await financeApi.quarter(year, quarter)).data.data as QuarterFinance,
  });
  const { data: invoices } = useQuery({
    queryKey: ['finance-invoices'],
    queryFn: async () => (await financeApi.listInvoices()).data.data as InvoiceList,
  });
  const { data: expenses } = useQuery({
    queryKey: ['finance-expenses'],
    queryFn: async () => (await financeApi.listExpenses()).data.data as Expense[],
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['finance-snapshot'] });
    qc.invalidateQueries({ queryKey: ['finance-expenses'] });
    qc.invalidateQueries({ queryKey: ['finance-quarter'] });
    qc.invalidateQueries({ queryKey: ['finance-invoices'] });
  };

  const add = useMutation({
    mutationFn: () => financeApi.addExpense({
      label: label.trim(), category, amountSar: Number(amount),
      vatMode, currency, isRecurring, startsOn,
    }),
    onSuccess: () => {
      toast.success('سُجّل المصروف');
      setLabel(''); setAmount(''); setShowAdd(false);
      invalidate();
    },
    onError: () => toast.error('تعذّر التسجيل — تأكّد من المبلغ والوصف'),
  });

  const stop = useMutation({
    mutationFn: (id: string) => financeApi.stopExpense(id),
    onSuccess: () => { toast.success('أُوقف المصروف من اليوم'); invalidate(); },
  });
  const zeroVat = useMutation({
    mutationFn: (id: string) => financeApi.updateExpense(id, { vatSar: 0 }),
    onSuccess: () => { toast.success('صُفّرت ضريبة المدخلات على هذا المصروف'); invalidate(); },
  });
  const reviewed = useMutation({
    mutationFn: (id: string) => financeApi.markReviewed(id),
    onSuccess: () => { toast.success('سُجّلت المراجعة — المبلغ ما زال صحيحاً'); invalidate(); },
  });
  const backfill = useMutation({
    mutationFn: () => financeApi.backfillInvoices(),
    onSuccess: (r) => { toast.success(`أُصدرت ${r.data.data.issued} فاتورة`); invalidate(); },
    onError: () => toast.error('تعذّر الإصدار'),
  });
  const remove = useMutation({
    mutationFn: (id: string) => financeApi.deleteExpense(id),
    onSuccess: () => { toast.success('حُذف'); invalidate(); },
  });

  const cur = snap?.current;
  const maxRevenue = Math.max(1, ...(snap?.months || []).map((m) => m.revenueSar));

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center p-3 sm:p-6 overflow-y-auto"
      {...backdropClose(onClose)}
    >
      <div className="bg-[#FAF7F0] rounded-2xl w-full max-w-5xl shadow-xl my-4">

        <div className="flex items-center justify-between px-5 py-4 border-b border-[#E7DECD] sticky top-0 bg-[#FAF7F0] rounded-t-2xl z-10">
          <div className="flex items-center gap-2.5">
            <Wallet className="w-5 h-5 text-[#E15A30]" />
            <h2 className="text-lg font-bold text-[#1F1A13]">الإدارة المالية</h2>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-black/5" aria-label="إغلاق">
            <X className="w-5 h-5 text-gray-500" />
          </button>
        </div>

        <div className="p-5 space-y-5">
          {isLoading && <p className="text-sm text-gray-500 py-8 text-center">جارٍ حساب الصورة المالية…</p>}
          {isError && <p className="text-sm text-red-600 py-8 text-center">تعذّر جلب البيانات</p>}

          {snap && cur && (
            <>
              {/* الحالة العامة */}
              <div className={`rounded-xl p-4 flex items-start gap-3 ${
                snap.runwayNote.startsWith('عجز') ? 'bg-red-50 border border-red-200' : 'bg-green-50 border border-green-200'
              }`}>
                {snap.runwayNote.startsWith('عجز')
                  ? <AlertTriangle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
                  : <CheckCircle2 className="w-5 h-5 text-green-700 shrink-0 mt-0.5" />}
                <div>
                  <p className={`text-sm font-semibold ${snap.runwayNote.startsWith('عجز') ? 'text-red-700' : 'text-green-800'}`}>
                    {snap.runwayNote}
                  </p>
                  <p className="text-[11px] text-gray-500 mt-0.5">
                    محسوب من الإيراد المتكرّر بعد استخراج الضريبة ناقص التكاليف الشهرية المتكرّرة
                  </p>
                </div>
              </div>

              {snap.staleExpenses > 0 && (
                <div className="rounded-xl p-3 bg-amber-50 border border-amber-200 flex items-start gap-2.5">
                  <Clock className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
                  <p className="text-xs text-amber-900">
                    <b>{snap.staleExpenses} مصروف متكرّر لم يُراجَع منذ {snap.staleDaysThreshold} يوماً.</b>{' '}
                    راجع فاتورة المورّد: مبلغٌ قديم يُحتسب صامتاً كل شهر ويبدو صحيحاً — وهذا أخطر من غيابه.
                  </p>
                </div>
              )}

              {/* الأرقام الحاكمة */}
              <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
                <Stat icon={Repeat} label="الإيراد الشهري المتكرّر (MRR)" value={sar(snap.mrrSar)} hint={snap.mrrBasis} />
                <Stat icon={TrendingUp} label="محصّل هذا الشهر" value={sar(cur.revenueSar)} hint={`${cur.paidCount} عملية دفع`} />
                <Stat icon={TrendingDown} label="مصروفات الشهر" value={sar(cur.expensesSar)} hint={`متكرّر ${sar(snap.monthlyRecurringCostSar)}`} />
                <Stat
                  icon={Receipt}
                  label={`عمولة بوابة الدفع (${snap.gatewayFeePct}%)`}
                  value={sar(cur.gatewayFeeSar)}
                  hint="تُخصم من كل مبلغ محصّل"
                />
                <Stat
                  icon={Wallet}
                  label="صافي الربح"
                  value={sar(cur.profitSar)}
                  hint={`هامش ${cur.marginPct}%`}
                  tone={cur.profitSar >= 0 ? 'good' : 'bad'}
                />
              </div>

              {/* الشركات — مدفوعة مقابل غير مدفوعة، لا يتداخلان */}
              <section className="rounded-xl border border-[#E7DECD] bg-white px-4 py-3 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-xs">
                <span className="font-bold text-[#1F1A13]">الشركات الفعّالة {snap.totalTenants}</span>
                <span className="text-emerald-700">باشتراك مدفوع سارٍ: <b className="tabular-nums">{snap.payingTenants}</b></span>
                <span className="text-gray-600">بلا دفعة اشتراك: <b className="tabular-nums">{snap.unpaidTenants}</b></span>
                {snap.expiringSoon > 0 && (
                  <span className="text-amber-700">ينتهي اشتراكها خلال ٣٠ يوماً: <b className="tabular-nums">{snap.expiringSoon}</b></span>
                )}
                <span className="text-gray-400">سنوياً {sar(snap.arrSar)}</span>
              </section>

              {/* الضريبة */}
              <section className="rounded-xl border border-[#E7DECD] bg-white p-4">
                <div className="flex items-center gap-2 mb-3">
                  <Receipt className="w-4 h-4 text-[#E15A30]" />
                  <h3 className="text-sm font-bold text-[#1F1A13]">ضريبة القيمة المضافة ({snap.vatPct}%)</h3>
                  <span className="text-[11px] text-gray-400">— أسعارنا شاملة الضريبة، فتُستخرَج من المبلغ لا تُضاف إليه</span>
                </div>
                <div className="grid grid-cols-3 gap-3 text-center">
                  <div className="rounded-lg bg-[#FBF6EC] p-3">
                    <div className="text-[11px] text-gray-500">مخرجات (محصّلة)</div>
                    <div className="text-base font-bold tabular-nums text-[#1F1A13]" dir="ltr">{sar(cur.vatCollectedSar)}</div>
                  </div>
                  <div className="rounded-lg bg-[#FBF6EC] p-3">
                    <div className="text-[11px] text-gray-500">مدخلات (مدفوعة)</div>
                    <div className="text-base font-bold tabular-nums text-[#1F1A13]" dir="ltr">{sar(cur.vatPaidSar)}</div>
                  </div>
                  <div className={`rounded-lg p-3 ${cur.vatDueSar >= 0 ? 'bg-[#FBEBE2]' : 'bg-green-50'}`}>
                    <div className="text-[11px] text-gray-500">المستحقّ للهيئة</div>
                    <div className={`text-base font-bold tabular-nums ${cur.vatDueSar >= 0 ? 'text-[#B8431F]' : 'text-green-700'}`} dir="ltr">
                      {sar(cur.vatDueSar)}
                    </div>
                  </div>
                </div>
              </section>

              {/* الإقرار الربعي — الفترة التي تُقدَّم بها الإقرارات فعلاً */}
              <section className="rounded-xl border border-[#E7DECD] bg-white p-4">
                <div className="flex flex-wrap items-center gap-2 mb-3">
                  <Receipt className="w-4 h-4 text-[#E15A30]" />
                  <h3 className="text-sm font-bold text-[#1F1A13]">الإقرار الربعي</h3>
                  <span className="text-[11px] text-gray-400 flex-1">— زاتكا تُقدَّم بالربع، وجمع ثلاثة أشهر باليد هو حيث يقع الخطأ</span>
                  <div className="flex gap-1">
                    {[1, 2, 3, 4].map((q) => (
                      <button
                        key={q} onClick={() => setQuarter(q)}
                        className={`w-8 h-7 rounded-lg text-xs font-bold tabular-nums ${
                          quarter === q ? 'bg-[#1F1A13] text-white' : 'bg-[#F1EADD] text-gray-600 hover:bg-[#E7DECD]'
                        }`}
                      >{q}</button>
                    ))}
                  </div>
                </div>
                {qtr ? (
                  <>
                    <p className="text-[11px] text-gray-500 mb-2">{qtr.periodLabel}</p>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-center">
                      <div className="rounded-lg bg-[#FBF6EC] p-3">
                        <div className="text-[11px] text-gray-500">إيراد الربع</div>
                        <div className="text-base font-bold tabular-nums text-[#1F1A13]" dir="ltr">{sar(qtr.revenueSar)}</div>
                      </div>
                      <div className="rounded-lg bg-[#FBF6EC] p-3">
                        <div className="text-[11px] text-gray-500">مخرجات</div>
                        <div className="text-base font-bold tabular-nums text-[#1F1A13]" dir="ltr">{sar(qtr.vatCollectedSar)}</div>
                      </div>
                      <div className="rounded-lg bg-[#FBF6EC] p-3">
                        <div className="text-[11px] text-gray-500">مدخلات</div>
                        <div className="text-base font-bold tabular-nums text-[#1F1A13]" dir="ltr">{sar(qtr.vatPaidSar)}</div>
                      </div>
                      <div className="rounded-lg bg-[#FBEBE2] p-3">
                        <div className="text-[11px] text-gray-500">المستحقّ للهيئة</div>
                        <div className="text-base font-bold tabular-nums text-[#B8431F]" dir="ltr">{sar(qtr.vatDueSar)}</div>
                      </div>
                    </div>
                  </>
                ) : <p className="text-sm text-gray-500 text-center py-4">جارٍ حساب الربع…</p>}
              </section>

              {/* الفواتير الضريبية التي نُصدرها لمشتركينا */}
              <section className="rounded-xl border border-[#E7DECD] bg-white p-4">
                <div className="flex flex-wrap items-center gap-2 mb-1">
                  <FileText className="w-4 h-4 text-[#E15A30]" />
                  <h3 className="text-sm font-bold text-[#1F1A13]">فواتيرنا الضريبية للمشتركين</h3>
                  <span className="flex-1" />
                  {invoices?.ready && (
                    <button
                      onClick={() => backfill.mutate()} disabled={backfill.isPending}
                      className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-[#F1EADD] text-[#1F1A13] hover:bg-[#E7DECD] disabled:opacity-40"
                    >
                      {backfill.isPending ? 'جارٍ…' : 'أصدر ما فات'}
                    </button>
                  )}
                </div>
                <p className={`text-[11px] mb-3 ${invoices?.ready ? 'text-gray-500' : 'text-red-600 font-semibold'}`}>
                  {invoices?.note}
                  {invoices?.ready && invoices.vatNumber && ` · البائع ${invoices.sellerName} — الرقم الضريبي ${invoices.vatNumber}`}
                </p>
                {!invoices?.rows.length ? (
                  <p className="text-sm text-gray-500 text-center py-4">لا فاتورة صادرة بعد.</p>
                ) : (
                  <div className="space-y-2">
                    {invoices.rows.map((v) => (
                      <div key={v.id} className="flex items-center gap-3 rounded-lg border border-[#E7DECD] p-2.5">
                        <span className="text-[11px] font-bold tabular-nums px-2 py-0.5 rounded-full bg-[#F1EADD] text-[#1F1A13] shrink-0" dir="ltr">{v.number}</span>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-semibold text-[#1F1A13] truncate">{v.buyerName}</p>
                          <p className="text-[11px] text-gray-500 truncate">{v.description} · {v.issuedAt.slice(0, 10)}</p>
                        </div>
                        <div className="text-left shrink-0">
                          <p className="text-sm font-bold tabular-nums text-[#1F1A13]" dir="ltr">{sar(v.totalSar)}</p>
                          <p className="text-[10px] text-gray-500 tabular-nums" dir="ltr">ضريبة {sar(v.vatSar)}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              {/* ستة أشهر */}
              <section className="rounded-xl border border-[#E7DECD] bg-white p-4">
                <div className="flex items-center gap-2 mb-4">
                  <Calendar className="w-4 h-4 text-[#E15A30]" />
                  <h3 className="text-sm font-bold text-[#1F1A13]">آخر ستة أشهر</h3>
                </div>
                <div className="overflow-x-auto">
                  <div className="flex items-end gap-3 min-w-[420px] h-32">
                    {snap.months.map((m) => (
                      <div key={`${m.year}-${m.month}`} className="flex-1 flex flex-col items-center gap-1.5">
                        <span className="text-[10px] tabular-nums text-gray-500" dir="ltr">{m.revenueSar || ''}</span>
                        <div className="w-full flex items-end justify-center gap-0.5 h-20">
                          <div
                            className="w-1/2 rounded-t bg-[#E15A30]"
                            style={{ height: `${Math.max(2, (m.revenueSar / maxRevenue) * 100)}%` }}
                            title={`إيراد ${sar(m.revenueSar)}`}
                          />
                          <div
                            className="w-1/2 rounded-t bg-[#D8CDB6]"
                            style={{ height: `${Math.max(2, (m.expensesSar / maxRevenue) * 100)}%` }}
                            title={`مصروف ${sar(m.expensesSar)}`}
                          />
                        </div>
                        <span className="text-[10px] text-gray-500">{MONTH_AR[m.month - 1]}</span>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="flex items-center gap-4 mt-3 text-[11px] text-gray-500">
                  <span className="inline-flex items-center gap-1.5"><i className="w-3 h-2 rounded-sm bg-[#E15A30] inline-block" /> إيراد</span>
                  <span className="inline-flex items-center gap-1.5"><i className="w-3 h-2 rounded-sm bg-[#D8CDB6] inline-block" /> مصروف</span>
                </div>
              </section>

              {/* التكاليف حسب النوع */}
              {snap.byCategory.length > 0 && (
                <section className="rounded-xl border border-[#E7DECD] bg-white p-4">
                  <div className="flex items-center gap-2 mb-3">
                    <PieChart className="w-4 h-4 text-[#E15A30]" />
                    <h3 className="text-sm font-bold text-[#1F1A13]">التكاليف المتكرّرة حسب النوع</h3>
                  </div>
                  <div className="space-y-2">
                    {snap.byCategory.map((c) => (
                      <div key={c.category} className="flex items-center gap-3">
                        <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full shrink-0 ${CATEGORY[c.category]?.cls || CATEGORY.other.cls}`}>
                          {CATEGORY[c.category]?.label || c.category}
                        </span>
                        <div className="flex-1 h-2 rounded-full bg-[#F1EADD] overflow-hidden">
                          <div
                            className="h-full bg-[#E15A30] rounded-full"
                            style={{ width: `${(c.amountSar / Math.max(1, snap.monthlyRecurringCostSar)) * 100}%` }}
                          />
                        </div>
                        <span className="text-xs font-semibold tabular-nums text-[#1F1A13] shrink-0" dir="ltr">{sar(c.amountSar)}</span>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {/* الإيرادات — مدفوعات ميسر بأسماء عملائها */}
              <section className="rounded-xl border border-[#E7DECD] bg-white p-4">
                <div className="flex items-center justify-between mb-1">
                  <h3 className="text-sm font-bold text-[#1F1A13]">الإيرادات</h3>
                  {onAddRevenue && (
                    <button
                      onClick={onAddRevenue}
                      className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg bg-[#1F1A13] text-white hover:bg-black"
                    >
                      <Plus className="w-3.5 h-3.5" /> أضف إيراداً
                    </button>
                  )}
                </div>
                <p className="text-[11px] text-gray-500 mb-3 flex items-center gap-1">
                  <Link2 className="w-3 h-3 shrink-0" />
                  كل إيراد هنا دفعة ميسر مؤكَّدة — تُضاف بإصدار رابط دفع، وتُسجَّل تلقائياً لحظة دفع العميل.
                </p>

                {!!revenues?.totalCount && (
                  <div className="rounded-lg bg-[#FBF6EC] px-3 py-2 mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                    <span className="text-gray-600">
                      إجمالي المحصّل منذ البداية <b className="tabular-nums text-[#1F1A13]" dir="ltr">{sar(revenues.totalSar)}</b>
                    </span>
                    <span className="text-gray-500 tabular-nums">{revenues.totalCount} عملية دفع</span>
                    {revenues.truncated && (
                      <span className="text-amber-700">
                        معروض أحدث {revenues.rows.length} فقط — المجموع أعلاه يشمل الكلّ
                      </span>
                    )}
                  </div>
                )}

                {!revenues?.rows.length && (
                  <p className="text-sm text-gray-500 text-center py-6">
                    لا مدفوعات مؤكَّدة بعد — أصدر رابط دفع لعميلك ليظهر إيراده هنا.
                  </p>
                )}

                <div className="space-y-2">
                  {revenues?.rows.map((r) => (
                    <div key={r.id} className="flex items-center gap-3 rounded-lg border border-[#E7DECD] bg-white p-2.5">
                      <span
                        className={`inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full shrink-0 ${
                          r.isRecurring ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-600'
                        }`}
                      >
                        {r.isRecurring ? <><RefreshCw className="w-3 h-3" /> متكرّر</> : <>لمرّة واحدة</>}
                      </span>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold text-[#1F1A13] truncate flex items-center gap-1.5">
                          <Building2 className="w-3.5 h-3.5 text-gray-400 shrink-0" />
                          {r.clientName}
                        </p>
                        <p className="text-[11px] text-gray-500 truncate">
                          {r.description}
                          {r.isRecurring && ` · اشتراك ${r.months} شهر`}
                          {' · '}{r.paidAt}
                        </p>
                      </div>
                      <div className="text-left shrink-0">
                        <p className="text-sm font-bold tabular-nums text-emerald-700" dir="ltr">{sar(r.amountSar)}</p>
                        <p className="text-[10px] text-gray-500 tabular-nums" dir="ltr" title="بعد الضريبة وعمولة ميسر">
                          صافي {sar(r.netSar)}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </section>

              {/* المصروفات */}
              <section className="rounded-xl border border-[#E7DECD] bg-white p-4">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-bold text-[#1F1A13]">المصروفات التشغيلية</h3>
                  <button
                    onClick={() => setShowAdd((v) => !v)}
                    className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg bg-[#E15A30] text-white hover:bg-[#C94D28]"
                  >
                    <Plus className="w-3.5 h-3.5" /> أضف مصروفاً
                  </button>
                </div>

                {showAdd && (
                  <div className="rounded-lg bg-[#FBF6EC] p-3 mb-3 grid gap-2.5 sm:grid-cols-2">
                    <input
                      value={label} onChange={(e) => setLabel(e.target.value)}
                      placeholder="الوصف (مثال: استضافة Render)"
                      className="px-3 py-2 rounded-lg border border-[#E7DECD] text-sm bg-white"
                    />
                    <select value={category} onChange={(e) => setCategory(e.target.value)} className="px-3 py-2 rounded-lg border border-[#E7DECD] text-sm bg-white">
                      {Object.entries(CATEGORY).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                    </select>
                    <div className="flex gap-2">
                      <input
                        value={amount} onChange={(e) => setAmount(e.target.value)}
                        inputMode="decimal" placeholder={`المبلغ بـ${currency === 'SAR' ? 'الريال' : currency}`}
                        className="flex-1 min-w-0 px-3 py-2 rounded-lg border border-[#E7DECD] text-sm bg-white tabular-nums"
                      />
                      <select
                        value={currency} onChange={(e) => setCurrency(e.target.value as typeof currency)}
                        className="px-2 py-2 rounded-lg border border-[#E7DECD] text-sm bg-white shrink-0"
                        title="أدخل المبلغ كما في فاتورة المورّد — يُحوَّل للريال ويُحفَظ الأصل، فتحديثه لاحقاً رقم واحد"
                      >
                        <option value="SAR">ر.س</option>
                        <option value="USD">$</option>
                        <option value="EUR">€</option>
                      </select>
                    </div>
                    <input
                      type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)}
                      className="px-3 py-2 rounded-lg border border-[#E7DECD] text-sm bg-white"
                    />
                    <label className="flex items-center gap-2 text-xs text-gray-600">
                      <input type="checkbox" checked={isRecurring} onChange={(e) => setIsRecurring(e.target.checked)} />
                      يتكرّر شهرياً (يُحتسب تلقائياً كل شهر)
                    </label>
                    <select
                      value={vatMode} onChange={(e) => setVatMode(e.target.value as typeof vatMode)}
                      className="px-3 py-2 rounded-lg border border-[#E7DECD] text-sm bg-white"
                      title="فواتير المورّدين الأجانب (Render · Anthropic · النطاق) بلا ضريبة سعودية قابلة للخصم"
                    >
                      <option value="none">بلا ضريبة (مورّد أجنبي)</option>
                      <option value="inclusive">المبلغ شامل الضريبة</option>
                      <option value="exclusive">الضريبة تُضاف فوق المبلغ</option>
                    </select>
                    <div className="sm:col-span-2 flex justify-end">
                      <button
                        onClick={() => add.mutate()}
                        disabled={add.isPending || !label.trim() || !Number(amount)}
                        className="text-xs font-semibold px-4 py-2 rounded-lg bg-[#1F1A13] text-white disabled:opacity-40"
                      >
                        {add.isPending ? 'جارٍ الحفظ…' : 'حفظ'}
                      </button>
                    </div>
                  </div>
                )}

                {!expenses?.length && (
                  <p className="text-sm text-gray-500 text-center py-6">
                    لا مصروفات مسجّلة بعد — أضف تكاليفك ليُحسب صافي ربحك تلقائياً.
                  </p>
                )}

                <div className="space-y-2">
                  {expenses?.map((e) => {
                    const stopped = e.endsOn && new Date(e.endsOn) <= new Date();
                    return (
                      <div key={e.id} className={`flex items-center gap-3 rounded-lg border border-[#E7DECD] p-2.5 ${stopped ? 'opacity-50' : 'bg-white'}`}>
                        <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full shrink-0 ${CATEGORY[e.category]?.cls || CATEGORY.other.cls}`}>
                          {CATEGORY[e.category]?.label || e.category}
                        </span>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-semibold text-[#1F1A13] truncate">{e.label}</p>
                          <p className="text-[11px] text-gray-500">
                            {e.isRecurring ? 'شهري' : 'لمرّة واحدة'} · ضريبة مدخلات {sar(e.vatSar)}
                            {e.amountOriginal != null && ` · ${e.amountOriginal} ${e.currency} × ${e.fxRate}`}
                            {stopped && ' · موقوف'}
                          </p>
                          {e.isStale && !stopped && (
                            <p className="text-[10px] text-amber-700 font-semibold mt-0.5 flex items-center gap-1">
                              <Clock className="w-3 h-3" /> لم يُراجَع منذ {e.staleDays} يوماً
                              <button
                                onClick={() => reviewed.mutate(e.id)}
                                className="underline underline-offset-2 hover:text-amber-800"
                              >راجعتُه ولم يتغيّر</button>
                            </p>
                          )}
                          {e.vatSar > 0 && (
                            <button
                              onClick={() => zeroVat.mutate(e.id)}
                              className="mt-0.5 text-[10px] text-amber-700 underline underline-offset-2 hover:text-amber-800"
                              title="المورّدون الأجانب لا ضريبة مدخلات قابلة للخصم على فواتيرهم — تصفيرها يرفع المستحقّ للهيئة إلى قيمته الصحيحة"
                            >
                              لا ضريبة على هذا المصروف؟ صفّرها
                            </button>
                          )}
                        </div>
                        <span className="text-sm font-bold tabular-nums text-[#1F1A13] shrink-0" dir="ltr">{sar(e.amountSar)}</span>
                        {e.isRecurring && !stopped && (
                          <button onClick={() => stop.mutate(e.id)} title="إيقاف من اليوم" className="p-1.5 rounded-lg hover:bg-amber-50 text-amber-700">
                            <PauseCircle className="w-4 h-4" />
                          </button>
                        )}
                        <button onClick={() => remove.mutate(e.id)} title="حذف" className="p-1.5 rounded-lg hover:bg-red-50 text-red-600">
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </section>

              <p className="text-[11px] text-gray-400 text-center leading-relaxed">
                كل الأرقام مشتقّة آلياً: الإيراد من مدفوعات ميسر المؤكَّدة · الاشتراكات المتكرّرة من الشركات الفعّالة ·
                الضريبة مستخرَجة من مبالغ شاملة لها · عمولة البوابة تتبع الإيراد لا تُسجَّل ثابتة · والمصروف المتكرّر يُحتسب في كل شهر يسري فيه بلا إعادة إدخال.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

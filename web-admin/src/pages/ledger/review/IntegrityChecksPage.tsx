import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronLeft, ChevronRight, Hammer, Play, RefreshCw, ShieldCheck, Wrench } from 'lucide-react';
import toast from 'react-hot-toast';
import { useTr } from '../../../i18n/strings';
import { useLang, useDir } from '../../../i18n/lang';
import { useAuthStore } from '../../../store/authStore';
import { canLedger } from '../../../lib/ledgerPerms';
import { formatDateTime } from '../../../utils/format';
import ConfirmDialog from '../../../components/ConfirmDialog';
import { LedgerLoadingToast } from '../../../components/ledger/LedgerListView';
import { Badge, MilliAmount, ReasonDialog, syncResultText } from '../../../components/ledger/SyncBadges';
import { ledgerConfigApi, ledgerErrorOf, ledgerKeys } from '../../../api/ledgerConfig';
import { ledgerReviewApi, ledgerReviewKeys, type CheckKey, type CheckResult, type CheckRow } from '../../../api/ledgerReview';
import { ledgerErrorMessage } from '../../../lib/ledger/errors';
import { mergeChecksRun } from '../../../lib/ledger/checks';
import { milliAmount, CONTROL_ADJUSTABLE, checkStatusLabels, checkStatusTone, checkTitles, isMilliKey } from '../../../lib/ledger/sync';
import { parseAmountToMilli } from '../../../lib/ledger/format';
import { ledgerHref } from '../routes';

/**
 * «مراجعة ← فحوصات السلامة» (M3، REV‑03، §5.9): آخر تقرير (GET /checks) وتشغيله (POST /checks/run، مرة كل 60 ثانية)،
 * والتعمّق في صفوف كل فحص، واقتراح الإصلاح: «إعادة بناء الأرصدة» (C2)، و«قيد تصحيح حساب رئيسي» CONTROL_ADJUSTMENT
 * لصف أحمر من C3 إلى C5 وحده بسبب مكتوب ومبلغ لا يتجاوز الانحراف، ومراجعة الأحداث/المسودات/المعلّقات، و«مزامنة الآن».
 * الكتابة كلها canConfigureLedger، و«مزامنة الآن» لكل من يرى الصفحة.
 */

type Tr = (ar: string) => string;

/** عناوين أعمدة التعمّق الشائعة (المفاتيح الأخرى تُعرض كما هي) */
const columnLabels = (tr: Tr): Record<string, string> => ({
  name: tr('الاسم'), customerId: tr('العميل'), salesRepId: tr('المندوب'), ledgerMilli: tr('رصيد الأستاذ'), expectedMilli: tr('المتوقع'),
  gapMilli: tr('الانحراف'), pending: tr('بانتظار الترحيل'), adjustable: tr('قابل للتصحيح'), accountCode: tr('الحساب'), periodKey: tr('الفترة'),
  ledgerDebitMilli: tr('مدين البنود'), ledgerCreditMilli: tr('دائن البنود'), storedDebitMilli: tr('المدين المخزّن'), storedCreditMilli: tr('الدائن المخزّن'),
  number: tr('الرقم'), debitMilli: tr('مدين'), creditMilli: tr('دائن'), isActive: tr('نشط'), opsOutstandingMilli: tr('رصيد الشاشة التشغيلية'),
  ledgerCustodyMilli: tr('عهدة الأستاذ'), onlineUnclearedMilli: tr('إلكتروني غير مصفّى'), custodyExpensesMilli: tr('مصروفات العهدة'),
  openShortageMilli: tr('العجز المفتوح'), shortagesExpensedMilli: tr('عجز محمّل على المصروف'), nonCustodyClearedMilli: tr('المصفّى من خارج العهدة'),
  matched: tr('متطابق'), kind: tr('النوع'), linkId: tr('الرابط'), receiptId: tr('السند'), amountMilli: tr('المبلغ'), sourceKey: tr('المفتاح'),
  status: tr('الحالة'), severity: tr('الخطورة'), effectAt: tr('تاريخ الأثر'), attempts: tr('المحاولات'), lastError: tr('آخر خطأ'),
  siblingKey: tr('الشقيق'), siblingStatus: tr('حالة الشقيق'), balanceMilli: tr('الرصيد'), date: tr('التاريخ'), attentionReason: tr('السبب'),
  key: tr('المفتاح'), rate: tr('النسبة'), vatBox: tr('مربع الإقرار'), prefix: tr('البادئة'), missing: tr('الأرقام الناقصة'),
  missingCount: tr('عدد الناقص'), duplicates: tr('المكرر'), source: tr('المصدر'), watermarkAt: tr('آخر مؤشر'), lastRunAt: tr('آخر تشغيل'),
  lagMinutes: tr('التأخر بالدقائق'), stallTicks: tr('نبضات بلا تقدم'), lagging: tr('متأخر'), stalled: tr('متوقف'), ref: tr('المرجع'),
});

const HIDDEN_KEYS = new Set(['accountId', 'moveId', 'id', 'journalId', 'lagMs', 'siblingNextAttemptAt', 'siblingSkipReason', 'unexpected']);

export default function IntegrityChecksPage() {
  const tr = useTr();
  const qc = useQueryClient();
  const { user } = useAuthStore();
  const canConfigure = canLedger(user, 'canConfigureLedger');
  const [open, setOpen] = useState<CheckKey | null>(null);
  const [confirmRebuild, setConfirmRebuild] = useState(false);
  const [adjust, setAdjust] = useState<{ key: 'C3' | 'C4' | 'C5'; row: CheckRow } | null>(null);

  const statusQ = useQuery({ queryKey: ledgerKeys.status, queryFn: async () => (await ledgerConfigApi.status()).data.data, staleTime: 60_000 });
  const decimals = statusQ.data?.currencyDecimals ?? 2;
  const activated = !!statusQ.data?.activatedAt;

  const q = useQuery({ queryKey: ledgerReviewKeys.checks, queryFn: async () => (await ledgerReviewApi.checks.get()).data.data });
  const report = q.data?.report ?? null;

  const run = useMutation({
    mutationFn: async (only?: CheckKey[]) => (await ledgerReviewApi.checks.run(only)).data.data,
    onSuccess: (r, only) => {
      if (r.throttled) toast(`${tr('شُغّلت الفحوصات قبل قليل، أعد المحاولة بعد')} ${r.retryAfterSeconds ?? 60} ${tr('ثانية')}`);
      else toast.success(tr('اكتمل تشغيل الفحوصات'));
      // المقيَّد قد يعيد report=null — mergeChecksRun يعيد null حينها فيبقى التقرير المعروض
      const next = mergeChecksRun(report, r, only);
      if (next) qc.setQueryData(ledgerReviewKeys.checks, { report: next, keys: q.data?.keys ?? [] });
    },
    onError: (err) => toast.error(ledgerErrorMessage(tr, ledgerErrorOf(err))),
  });

  const rebuild = useMutation({
    mutationFn: async () => (await ledgerReviewApi.checks.rebuildBalances()).data.data,
    onSuccess: (r) => {
      toast.success(`${tr('أُعيد بناء الأرصدة الشهرية')}: ${r.inserted}`);
      setConfirmRebuild(false);
      run.mutate(undefined);
    },
    onError: (err) => { setConfirmRebuild(false); toast.error(ledgerErrorMessage(tr, ledgerErrorOf(err))); },
  });

  const sync = useMutation({
    mutationFn: async () => (await ledgerConfigApi.sync()).data,
    onSuccess: (r) => {
      if (r.running) toast(`${tr('المزامنة جارية الآن، أعد التحميل بعد قليل')} (${r.pendingEvents})`);
      else toast.success(`${tr('تمت المزامنة')} — ${tr('أحداث متبقية')}: ${r.pendingEvents}`);
    },
    onError: (err) => toast.error(syncResultText(tr, err)),
  });

  const titles = checkTitles(tr);
  const statusLabels = checkStatusLabels(tr);

  return (
    <div className="space-y-4">
      <LedgerLoadingToast show={q.isFetching || run.isPending || rebuild.isPending} />
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-bold text-[#1F1A13] inline-flex items-center gap-2"><ShieldCheck size={18} className="text-[#E15A30]" />{tr('فحوصات السلامة')}</h1>
        {report && <Badge tone={checkStatusTone(report.overall)}>{statusLabels[report.overall]}</Badge>}
        {report && <span className="text-xs text-[#6E6557]">{tr('آخر تشغيل')}: <bdi>{formatDateTime(report.ranAt)}</bdi></span>}
        <div className="flex gap-2 ms-auto">
          {activated && (
            <button type="button" className="btn-secondary !py-1.5 !px-3 text-sm inline-flex items-center gap-1 disabled:opacity-50" disabled={sync.isPending} onClick={() => sync.mutate()}>
              <RefreshCw size={14} className={sync.isPending ? 'animate-spin' : ''} />{tr('مزامنة الآن')}
            </button>
          )}
          {canConfigure && (
            <button type="button" className="btn-primary !py-1.5 !px-3 text-sm inline-flex items-center gap-1 disabled:opacity-50" disabled={!activated || run.isPending} onClick={() => run.mutate(undefined)}>
              <Play size={14} />{tr('تشغيل الفحوصات')}
            </button>
          )}
        </div>
      </div>

      {statusQ.data && !activated && (
        <p className="rounded-xl border border-[#F3D3C4] bg-[#FBEBE2] px-3 py-2 text-sm">{tr('الدفاتر بانتظار الإعداد')} — {tr('الفحوصات تعمل بعد التفعيل')}</p>
      )}
      {q.isError && <p className="text-sm text-[#C0392B]">{ledgerErrorMessage(tr, ledgerErrorOf(q.error))}</p>}
      {q.data && !report && activated && (
        <div className="card text-center py-8 text-sm text-[#6E6557]">
          {canConfigure ? tr('لا تقرير بعد، شغّل الفحوصات') : tr('لا تقرير بعد، يشغّله مسؤول الدفاتر')}
        </div>
      )}

      {report && (
        <div className="space-y-2">
          {report.results.map(r => (
            <CheckCard
              key={r.key}
              result={r}
              title={titles[r.key] ?? r.key}
              statusLabel={statusLabels[r.status]}
              decimals={decimals}
              open={open === r.key}
              onToggle={() => setOpen(o => (o === r.key ? null : r.key))}
              canConfigure={canConfigure}
              busy={run.isPending}
              onRerun={() => run.mutate([r.key])}
              onRebuild={() => setConfirmRebuild(true)}
              onSync={() => sync.mutate()}
              onAdjust={row => setAdjust({ key: r.key as 'C3' | 'C4' | 'C5', row })}
            />
          ))}
        </div>
      )}

      {confirmRebuild && (
        <ConfirmDialog
          title={tr('إعادة بناء الأرصدة الشهرية')}
          message={tr('تُحذف الأرصدة الشهرية المخزّنة وتُحسب من جديد من البنود المرحّلة، ويُدوَّن ذلك في سجل التدقيق')}
          confirmLabel={tr('إعادة بناء')}
          loading={rebuild.isPending}
          onClose={() => setConfirmRebuild(false)}
          onConfirm={() => rebuild.mutate()}
        />
      )}
      {adjust && (
        <ControlAdjustmentDialog
          checkKey={adjust.key}
          row={adjust.row}
          title={titles[adjust.key]}
          decimals={decimals}
          onClose={() => setAdjust(null)}
          onDone={() => { setAdjust(null); run.mutate([adjust.key]); qc.invalidateQueries({ queryKey: ['ledger', 'moves'] }); }}
        />
      )}
    </div>
  );
}

function CheckCard({ result: r, title, statusLabel, decimals, open, onToggle, canConfigure, busy, onRerun, onRebuild, onSync, onAdjust }: {
  result: CheckResult; title: string; statusLabel: string; decimals: number; open: boolean; onToggle: () => void; canConfigure: boolean;
  busy: boolean; onRerun: () => void; onRebuild: () => void; onSync: () => void; onAdjust: (row: CheckRow) => void;
}) {
  const tr = useTr();
  const lang = useLang(s => s.lang);
  const dir = useDir();
  const Closed = dir === 'rtl' ? ChevronLeft : ChevronRight;
  const adjustable = CONTROL_ADJUSTABLE.includes(r.key) && r.status === 'RED';

  let fix: ReactNode = null;
  switch (r.fix) {
    case 'REBUILD_BALANCES':
      fix = canConfigure ? <button type="button" className="btn-secondary !py-1 !px-2 text-xs inline-flex items-center gap-1" onClick={onRebuild}><Hammer size={12} />{tr('إعادة بناء الأرصدة')}</button> : null;
      break;
    case 'REVIEW_EVENTS':
      fix = <Link className="text-xs text-[#E15A30] hover:underline" to={`${ledgerHref('review/events')}?status=ERROR,HELD,BLOCKED`}>{tr('مراجعة الأحداث')}</Link>;
      break;
    case 'REVIEW_DRAFTS':
      fix = <Link className="text-xs text-[#E15A30] hover:underline" to={typeof r.metrics.listUrl === 'string' ? r.metrics.listUrl : `${ledgerHref('entries')}?state=DRAFT`}>{tr('عرض المسودات')}</Link>;
      break;
    case 'REVIEW_SUSPENSE':
      fix = <Link className="text-xs text-[#E15A30] hover:underline" to={ledgerHref('review/attention')}>{tr('قيود تحتاج انتباها')}</Link>;
      break;
    case 'CONFIGURE_TAXES':
      fix = <Link className="text-xs text-[#E15A30] hover:underline" to={ledgerHref('config/taxes')}>{tr('الضرائب')}</Link>;
      break;
    case 'SYNC_NOW':
      fix = <button type="button" className="btn-secondary !py-1 !px-2 text-xs inline-flex items-center gap-1" onClick={onSync}><RefreshCw size={12} />{tr('مزامنة الآن')}</button>;
      break;
    case 'DISABLE_ERP_POSTING':
      fix = <Link className="text-xs text-[#E15A30] hover:underline" to="/app/erp">{tr('ربط ERP')}</Link>;
      break;
    case 'CONTROL_ADJUSTMENT':
      fix = <span className="text-xs text-[#6E6557] inline-flex items-center gap-1"><Wrench size={12} />{tr('قيد التصحيح من صف الانحراف')}</span>;
      break;
    default:
      fix = null;
  }

  const rows = r.rows;
  const keys = [...new Set(rows.flatMap(x => Object.keys(x)))].filter(k => !HIDDEN_KEYS.has(k) && !(r.key === 'C3' && k === 'customerId') && !(r.key.startsWith('C4') && k === 'salesRepId'));
  const labels = columnLabels(tr);
  const cell = (k: string, v: unknown): ReactNode => {
    if (v === null || v === undefined) return '';
    if (isMilliKey(k) && (typeof v === 'string' || typeof v === 'number')) return <MilliAmount value={String(v)} decimals={decimals} />;
    if (typeof v === 'boolean') return v ? '✓' : '';
    if (Array.isArray(v)) return <bdi className="text-[11px]">{v.slice(0, 20).map(x => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join('، ')}{v.length > 20 ? ` (+${v.length - 20})` : ''}</bdi>;
    if (typeof v === 'object') return <bdi className="text-[11px] font-mono">{JSON.stringify(v)}</bdi>;
    if (k === 'status' || k === 'siblingStatus' || k === 'severity') return <bdi className="font-mono text-[11px]">{String(v)}</bdi>;
    if (/At$/.test(k) && typeof v === 'string') return formatDateTime(v);
    return <bdi>{String(v)}</bdi>;
  };

  return (
    <div className="card !p-0 overflow-hidden">
      <button type="button" className="w-full flex flex-wrap items-center gap-2 px-4 py-3 text-start hover:bg-[#FBF7F0]" onClick={onToggle} aria-expanded={open}>
        {open ? <ChevronDown size={16} /> : <Closed size={16} />}
        <span className="font-mono text-xs text-[#9A8F7E] w-9">{r.key}</span>
        <span className="font-semibold text-[#1F1A13]">{title}</span>
        <Badge tone={checkStatusTone(r.status)}>{statusLabel}</Badge>
        {r.rowCount > 0 && <span className="text-xs text-[#6E6557] tabular-nums">{r.rowCount}</span>}
        {lang === 'ar' && <span className="text-xs text-[#6E6557] truncate max-w-[28rem]">{r.summary}</span>}
      </button>
      {open && (
        <div className="border-t border-[#F1EBDF] px-4 py-3 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            {fix}
            {canConfigure && (
              <button type="button" disabled={busy} className="btn-secondary !py-1 !px-2 text-xs inline-flex items-center gap-1 ms-auto disabled:opacity-50" onClick={onRerun}>
                <Play size={12} />{tr('إعادة هذا الفحص')}
              </button>
            )}
          </div>
          {Object.keys(r.metrics).length > 0 && (
            <dl className="flex flex-wrap gap-x-6 gap-y-1 text-xs">
              {Object.entries(r.metrics).filter(([k]) => k !== 'listUrl').map(([k, v]) => (
                <div key={k} className="flex gap-1"><dt className="text-[#9A8F7E]">{labels[k] ?? k}:</dt><dd>{cell(k, v)}</dd></div>
              ))}
            </dl>
          )}
          {rows.length === 0 ? (
            <p className="text-sm text-[#6E6557]">{tr('لا صفوف')}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-[#9A8F7E]">
                    {keys.map(k => <th key={k} className="text-start font-semibold px-2 py-1 whitespace-nowrap">{labels[k] ?? k}</th>)}
                    {adjustable && canConfigure && <th />}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, i) => {
                    const canFix = adjustable && canConfigure && row.adjustable === true && typeof row.gapMilli === 'string' && row.gapMilli !== '0';
                    return (
                      <tr key={i} className="border-t border-[#F1EBDF] hover:bg-[#FBF7F0]">
                        {keys.map(k => <td key={k} className={`px-2 py-1 ${isMilliKey(k) ? 'text-end' : ''}`}>{cell(k, row[k])}</td>)}
                        {adjustable && canConfigure && (
                          <td className="px-2 py-1">
                            {canFix && <button type="button" className="text-[#E15A30] hover:underline whitespace-nowrap" onClick={() => onAdjust(row)}>{tr('قيد تصحيح')}</button>}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {r.rowCount > rows.length && <p className="text-[11px] text-[#9A8F7E] mt-1">{tr('يُعرض أول')} {rows.length} / {r.rowCount}</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** «قيد تصحيح حساب رئيسي» (§5.9): السبب إلزامي، والمبلغ اختياري لا يتجاوز الانحراف (افتراضياً الانحراف كله). */
function ControlAdjustmentDialog({ checkKey, row, title, decimals, onClose, onDone }: {
  checkKey: 'C3' | 'C4' | 'C5'; row: CheckRow; title: string; decimals: number; onClose: () => void; onDone: () => void;
}) {
  const tr = useTr();
  const [amount, setAmount] = useState('');
  const gapMilli = typeof row.gapMilli === 'string' ? BigInt(row.gapMilli) : 0n;
  const absGap = gapMilli < 0n ? -gapMilli : gapMilli;
  const parsed = amount.trim() ? parseAmountToMilli(amount, decimals) : null;
  const amountValid = !amount.trim() || (parsed !== null && parsed > 0n && parsed <= absGap);

  const errorText = (err: unknown) => {
    const e = ledgerErrorOf(err);
    switch (e?.reason) {
      case 'NO_DEVIATION': return tr('لا انحراف قائم لهذا الفحص');
      case 'CHECK_NOT_RED': return tr('الانحراف مؤقت بانتظار الترحيل الآلي، زامن ثم أعد الفحص');
      case 'AMOUNT_EXCEEDS_DEVIATION': return tr('المبلغ يتجاوز الانحراف المحسوب');
      case 'AMOUNT_INVALID': return tr('مبلغ غير صالح');
      case 'PARTNER_REQUIRED': return tr('حدد الشريك المنحرف');
      case 'ACCOUNT_NOT_MAPPED': return tr('الحساب الرئيسي أو حساب المعلّق غير مربوط');
      case 'CHECK_NOT_ADJUSTABLE': return tr('قيد التصحيح متاح لفحوص ذمم العملاء والعهدة والأمانات وحدها');
      default: return ledgerErrorMessage(tr, e);
    }
  };

  const post = useMutation({
    mutationFn: async (reason: string) => (await ledgerReviewApi.checks.controlAdjustment(checkKey, {
      reason,
      ...(checkKey === 'C3' && typeof row.customerId === 'string' ? { customerId: row.customerId } : {}),
      ...(checkKey === 'C4' && typeof row.salesRepId === 'string' ? { salesRepId: row.salesRepId } : {}),
      ...(amount.trim() ? { amount: amount.trim() } : {}),
    })).data.data,
    onSuccess: (r) => { toast.success(`${tr('رُحّل قيد التصحيح')} ${r.number}`); onDone(); },
    onError: (err) => toast.error(errorText(err), { duration: 7000 }),
  });

  return (
    <ReasonDialog
      title={`${tr('قيد تصحيح حساب رئيسي')} — ${title}`}
      confirmLabel={tr('ترحيل قيد التصحيح')}
      busy={post.isPending}
      extraValid={amountValid}
      onClose={onClose}
      onConfirm={reason => post.mutate(reason)}
      description={<>
        <p>{tr('يُرحَّل قيد على الحساب الرئيسي المنحرف مقابل الحساب المعلّق 911001، ثم يسوّي المحاسب الحساب المعلّق يدويا إلى الحساب الصحيح')}</p>
        <p className="mt-2">
          {typeof row.name === 'string' && <><span className="font-semibold">{row.name}</span> · </>}
          {tr('الانحراف')}: <MilliAmount value={String(row.gapMilli ?? '0')} decimals={decimals} />
        </p>
      </>}
    >
      <div>
        <label className="label" htmlFor="adjust-amount">{tr('المبلغ')}</label>
        <input id="adjust-amount" dir="ltr" inputMode="decimal" className="input" placeholder={milliAmount(absGap.toString())} value={amount} onChange={e => setAmount(e.target.value)} />
        <p className={`text-[11px] mt-1 ${amountValid ? 'text-[#9A8F7E]' : 'text-[#C0392B]'}`}>{tr('اتركه فارغا لتصحيح الانحراف كله، ولا يتجاوز الانحراف')}</p>
      </div>
    </ReasonDialog>
  );
}

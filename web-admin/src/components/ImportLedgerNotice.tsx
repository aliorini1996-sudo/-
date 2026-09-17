import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { BookOpen, CalendarDays, Check, AlertTriangle } from 'lucide-react';
import { useTr } from '../i18n/strings';
import { useAuthStore } from '../store/authStore';
import { useLedgerOn } from './LedgerGate';
import { canLedger } from '../lib/ledgerPerms';
import { ledgerConfigApi, ledgerKeys } from '../api/ledgerConfig';
import { ledgerSetupApi, ledgerSetupKeys, type SetupState } from '../api/ledgerSetup';
import { addDaysYmd, importContextTimezone, openingStockNoteKey, type ImportCutoverSplit, type OpeningStockGate } from '../lib/importData';
import { formatDayOnly } from '../utils/format';

/**
 * وعي صفحة «استيراد البيانات من نظامك السابق» بالدفاتر (خطة إصلاح الاستيراد، البنود 2أ و3أ و5د).
 *
 * كل ما هنا **قراءة فقط**: حالة الدفاتر `GET /ledger/status` ومسودة المعالج `GET /ledger/setup`.
 * الميزة مطفأة أو الصلاحية ناقصة أو 403 ⇒ السياق null ⇒ لا يظهر شيء وتبقى الصفحة كما كانت.
 */

export interface LedgerImportCtx {
  /** الدفاتر مفعّلة (activatedAt مضبوط) */
  activated: boolean;
  /** تاريخ البدء YYYY-MM-DD: المعتمد بعد التفعيل، أو مسودة المعالج قبله */
  cutoverDate: string | null;
  timezone: string;
  /** قبل التفعيل ومع مسودة: اليوم السابق لتاريخ البدء — اقتراح «تاريخ الصفوف بلا تاريخ» */
  suggestedUndatedDate: string | null;
  /** طريقة الإعداد: OPENING قيد افتتاحي، FULL_HISTORY كل حركة بتاريخها على 319002 (لا قيد افتتاحي) */
  method: 'OPENING' | 'FULL_HISTORY' | null;
}

export const FULL_HISTORY_IMPORT_NOTE = 'طريقة التاريخ الكامل: تُرحَّل كل حركة مستوردة بتاريخها على الأرصدة الافتتاحية 319002، ولا يُكتب قيد افتتاحي';
const asMethod = (m: unknown): LedgerImportCtx['method'] => (m === 'OPENING' || m === 'FULL_HISTORY' ? m : null);

export const LEDGER_WIZARD_HREF = '/app/ledger';

export function useLedgerImportContext(): LedgerImportCtx | null {
  const { on } = useLedgerOn();
  const user = useAuthStore((s) => s.user);
  const canView = canLedger(user, 'canViewLedger');
  const statusQ = useQuery({
    queryKey: ledgerKeys.status,
    queryFn: async () => (await ledgerConfigApi.status()).data.data,
    enabled: on && canView,
    retry: false,
    staleTime: 60_000,
  });
  const status = statusQ.data;
  const available = on && canView && !!status && status.suiteEnabled !== false;
  const activated = !!status?.activatedAt;
  const setupQ = useQuery({
    queryKey: ledgerSetupKeys.setup,
    queryFn: async () => (await ledgerSetupApi.get()).data.data as SetupState,
    enabled: available && !activated && canLedger(user, 'canConfigureLedger'),
    retry: false,
    staleTime: 60_000,
  });
  if (!available || !status) return null;
  const setup = setupQ.data && !setupQ.data.activated ? setupQ.data : null;
  const method = activated
    ? asMethod(status.setupMethod)
    : asMethod(setup?.effective?.method ?? setup?.draft?.step2?.method ?? status.setupMethod);
  // التاريخ الكامل قبل التفعيل: /setup/commit يستبدل التاريخ المُدخل بأقدم أثر (fullHistoryCutoverDate) ⇒ لا تاريخ step1
  const cutoverDate = activated
    ? status.cutoverDate ?? null
    : method === 'FULL_HISTORY'
      ? setup?.history?.fullHistoryCutoverDate ?? null
      : setup?.effective?.cutoverDate ?? setup?.draft?.step1?.cutoverDate ?? status.cutoverDate ?? null;
  // كما importTimezone في الخادم: قبل التفعيل منطقة المسودة (effective) مقدَّمة على الإعدادات ذات القيمة الافتراضية
  const timezone = importContextTimezone(activated, status.timezone, setup?.effective?.timezone);
  return {
    activated,
    cutoverDate,
    timezone,
    // لا قيد افتتاحي في التاريخ الكامل ⇒ لا اقتراح «اليوم السابق لتاريخ البدء»
    suggestedUndatedDate: !activated && method !== 'FULL_HISTORY' && cutoverDate ? addDaysYmd(cutoverDate, -1) : null,
    method,
  };
}

const box = (tone: 'info' | 'warn') => `rounded-lg border px-3 py-2 text-[11px] leading-relaxed ${tone === 'warn'
  ? 'border-amber-200 bg-amber-50 text-amber-900' : 'border-[#E8E0D2] bg-[#FBF7F0] text-[#6E6557]'}`;

/** تنبيه أعلى لوحة الاستيراد: قبل التفعيل (الافتتاح والمعالج) وبعده (الترحيل والتصحيح بالتراجع) */
export default function ImportLedgerNotice({ ctx }: { ctx: LedgerImportCtx | null }) {
  const tr = useTr();
  if (!ctx) return null;
  if (!ctx.activated) {
    return (
      <div className={`${box('info')} mt-3`} role="status">
        <p className="flex items-start gap-1.5">
          <BookOpen size={13} className="shrink-0 mt-0.5 text-[#E15A30]" />
          <span>
            {ctx.method === 'FULL_HISTORY'
              ? tr(FULL_HISTORY_IMPORT_NOTE)
              : tr('الأرصدة المؤرخة قبل تاريخ البدء تدخل القيد الافتتاحي عند التفعيل؛ استوردها قبل التفعيل بتاريخ اليوم السابق لتاريخ البدء')}
            {ctx.cutoverDate && <> · {tr('تاريخ البدء')}: <bdi className="tabular-nums">{formatDayOnly(ctx.cutoverDate)}</bdi></>}
            {' · '}<Link to={LEDGER_WIZARD_HREF} className="font-semibold text-[#E15A30] hover:underline">{tr('معالج إعداد الدفاتر')}</Link>
          </span>
        </p>
      </div>
    );
  }
  return (
    <div className={`${box('warn')} mt-3`} role="status">
      <p className="flex items-start gap-1.5">
        <BookOpen size={13} className="shrink-0 mt-0.5" />
        <span>
          {tr('الدفاتر مفعلة: الأرصدة الافتتاحية وكشوف الحسابات المستوردة تُرحَّل قيودا في الدفاتر')}
          {ctx.cutoverDate && <> · {tr('تاريخ البدء')}: <bdi className="tabular-nums">{formatDayOnly(ctx.cutoverDate)}</bdi></>}
          {'. '}{tr('التصحيح بعد الترحيل بالتراجع عن الدفعة فقط')}
        </span>
      </p>
    </div>
  );
}

/**
 * شرح بطاقة المخزون الافتتاحي بحالة البوابة (openingStockGate): مفتوحة، أو إقرار حين تاريخ البدء المحفوظ ≤ اليوم (مع أقرب
 * تاريخ بدء يشمل الاستيراد ورابط المعالج)، أو محجوبة بعد التفعيل أو في طريقة التاريخ الكامل. النصوص مفاتيح tr من importData.
 */
export function OpeningStockNote({ gate }: { gate: OpeningStockGate }) {
  const tr = useTr();
  const key = openingStockNoteKey(gate);
  if (!key) return null;
  if (gate.state === 'open') return <p className="text-[11px] text-gray-500 mb-3 leading-relaxed">{tr(key)}</p>;
  const wizard = <>{' · '}<Link to={LEDGER_WIZARD_HREF} className="font-semibold text-[#E15A30] hover:underline">{tr('معالج إعداد الدفاتر')}</Link></>;
  return (
    <p className={`${box('warn')} mb-3`} role="status">
      <AlertTriangle size={12} className="inline me-1" />
      {tr(key)}
      {gate.state === 'ack' && (
        <>
          {gate.cutoverDate && <> · {tr('تاريخ البدء')}: <bdi className="tabular-nums">{formatDayOnly(gate.cutoverDate)}</bdi></>}
          {' · '}{tr('أقرب تاريخ بدء يشمل مخزون اليوم')}: <bdi className="tabular-nums font-semibold">{formatDayOnly(gate.minCutoverDate)}</bdi>
          {wizard}
        </>
      )}
      {gate.state === 'blocked' && gate.reason === 'fullHistory' && wizard}
    </p>
  );
}

/**
 * إقرار صريح قبل استيراد المخزون حين تاريخ البدء المحفوظ ≤ اليوم (acknowledgeCutoverChange): الحركة تُسجَّل الآن فلا تدخل
 * القيد الافتتاحي إلا بتاريخ بدء بعد يوم الاستيراد، وتاريخ البدء لا يُقبل بعد اليوم ⇒ التعديل والاعتماد في يوم لاحق ≥ minCutoverDate.
 */
export function OpeningStockAckPanel({ cutoverDate, minCutoverDate, checked, onChange, disabled }: {
  cutoverDate: string | null;
  minCutoverDate: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  const tr = useTr();
  return (
    <div className={box('warn')} role="alert">
      <p className="font-semibold flex items-start gap-1.5">
        <CalendarDays size={13} className="shrink-0 mt-0.5" />
        <span>
          {tr('إقرار بتاريخ البدء قبل استيراد المخزون الافتتاحي')}
          {cutoverDate && <> · {tr('تاريخ البدء المحفوظ')}: <bdi className="tabular-nums">{formatDayOnly(cutoverDate)}</bdi></>}
        </span>
      </p>
      <p className="mt-1">
        {tr('المخزون المستورد اليوم لا يدخل القيد الافتتاحي إلا بتاريخ بدء بعد يوم الاستيراد، ولا يُقبل تاريخ بدء بعد اليوم. لذلك يلزم أن تعدّل تاريخ البدء في يوم لاحق إلى')}
        {' '}<bdi className="tabular-nums font-semibold">{formatDayOnly(minCutoverDate)}</bdi>{' '}
        {tr('أو بعده ثم تعتمد الدفاتر. إن اعتمدت بتاريخ البدء الحالي فلن تدخل قيمة المخزون القيد الافتتاحي، ويطلب منك التفعيل إقرارا بذلك')}
      </p>
      <label className="flex items-start gap-2 mt-2 cursor-pointer select-none">
        <input type="checkbox" className="mt-0.5" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
        <span className="font-semibold">{tr('أقرّ بأن تاريخ البدء يجب أن يُعدَّل في يوم لاحق إلى هذا التاريخ أو بعده ليدخل المخزون القيد الافتتاحي')}</span>
      </label>
    </div>
  );
}

/** اختيار «تاريخ الصفوف بلا تاريخ» صراحةً — زر الاستيراد معطّل حتى يُعتمد */
export function UndatedDateChooser({ ctx, count, input, onInput, confirmed, onConfirm, onChange }: {
  ctx: LedgerImportCtx;
  count: number;
  input: string;
  onInput: (v: string) => void;
  confirmed: string | null;
  onConfirm: (v: string) => void;
  onChange: () => void;
}) {
  const tr = useTr();
  if (count <= 0) return null;
  if (confirmed) {
    return (
      <div className={box('info')} role="status">
        <p className="flex items-center gap-1.5 flex-wrap">
          <Check size={13} className="text-green-600 shrink-0" />
          <span>{count} {tr('صف بلا تاريخ ستؤرخ بتاريخ')} <bdi className="tabular-nums font-semibold">{formatDayOnly(confirmed)}</bdi></span>
          <button type="button" onClick={onChange} className="text-[#E15A30] font-semibold hover:underline ms-auto">{tr('تغيير')}</button>
        </p>
      </div>
    );
  }
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(input);
  return (
    <div className={box('warn')} role="status">
      <p className="flex items-start gap-1.5 font-semibold">
        <CalendarDays size={13} className="shrink-0 mt-0.5" />
        <span>{count} {tr('صف بلا تاريخ في الملف. اختر تاريخها صراحة قبل الاستيراد')}</span>
      </p>
      {ctx.suggestedUndatedDate && (
        <p className="mt-1">{tr('المقترح: اليوم السابق لتاريخ البدء، فتدخل الأرصدة القيد الافتتاحي')}</p>
      )}
      {ctx.activated && (
        <p className="mt-1">{tr('الدفاتر مفعلة: الصفوف بلا تاريخ تُرفض ما لم تختر لها تاريخا')}</p>
      )}
      <div className="flex items-center gap-2 mt-2">
        <input type="date" value={input} onChange={(e) => onInput(e.target.value)}
          className="input py-1 text-xs tabular-nums w-40" dir="ltr" aria-label={tr('تاريخ الصفوف بلا تاريخ')} />
        <button type="button" disabled={!valid} onClick={() => onConfirm(input)}
          className="btn-primary text-xs py-1.5 px-3 disabled:opacity-50">
          <Check size={13} /> {tr('اعتماد هذا التاريخ')}
        </button>
      </div>
    </div>
  );
}

/** تصنيف صفوف المعاينة حول تاريخ البدء بالتقويم المحلي، مع استبعاد الصفوف بعد تاريخ البدء */
export function CutoverSplitNotice({ ctx, split, excludeAfter, onToggleExclude }: {
  ctx: LedgerImportCtx;
  split: ImportCutoverSplit;
  excludeAfter: boolean;
  onToggleExclude: (v: boolean) => void;
}) {
  const tr = useTr();
  // التاريخ الكامل قبل التفعيل: لا قيد افتتاحي ولا «قبل البدء» (البدء يتحرك إلى أقدم أثر) ⇒ سطر واحد صادق
  if (!ctx.activated && ctx.method === 'FULL_HISTORY') {
    return (
      <div className={box('info')} role="status">
        <p className="flex items-start gap-1.5"><BookOpen size={13} className="shrink-0 mt-0.5" /><span>{tr(FULL_HISTORY_IMPORT_NOTE)}</span></p>
      </div>
    );
  }
  if (!ctx.cutoverDate) return null;
  const row = (n: number, label: string, tone = 'text-gray-700') => (
    <li className="flex items-start gap-2">
      <span className={`tabular-nums font-bold min-w-[2.5rem] text-end ${tone}`}>{n}</span>
      <span>{label}</span>
    </li>
  );
  return (
    <div className={box(split.onOrAfter > 0 && !excludeAfter ? 'warn' : 'info')} role="status">
      <p className="font-semibold flex items-center gap-1.5 mb-1.5">
        <BookOpen size={13} className="shrink-0" />
        {tr('موضع الصفوف في الدفاتر')} · {tr('تاريخ البدء')}: <bdi className="tabular-nums">{formatDayOnly(ctx.cutoverDate)}</bdi>
      </p>
      <ul className="space-y-1">
        {row(split.before, ctx.activated
          ? tr('قبل تاريخ البدء: تُرحَّل وصولا متأخرا بتاريخ البدء')
          : tr('قبل تاريخ البدء: تدخل القيد الافتتاحي عند التفعيل'))}
        {row(split.onOrAfter, `${tr('في يوم البدء أو بعده: تُرحَّل بتاريخها على حساب الأرصدة الافتتاحية 319002، لا إيرادا ولا ضريبة')}${excludeAfter && split.onOrAfter ? ` — ${tr('مستبعدة')}` : ''}`,
          split.onOrAfter > 0 ? 'text-amber-700' : 'text-gray-400')}
        {row(split.undated, tr('بلا تاريخ'), split.undated > 0 ? 'text-amber-700' : 'text-gray-400')}
      </ul>
      {split.onOrAfter > 0 && (
        <label className="flex items-center gap-2 mt-2 cursor-pointer select-none">
          <input type="checkbox" checked={excludeAfter} onChange={(e) => onToggleExclude(e.target.checked)} />
          <span className="font-semibold">{tr('استبعاد الصفوف بعد تاريخ البدء')}</span>
          {!excludeAfter && <AlertTriangle size={12} className="text-amber-600" />}
        </label>
      )}
    </div>
  );
}

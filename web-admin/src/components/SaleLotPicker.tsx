// ============================================================================
// «تتبّع اللوط» — منتقي تشغيلة سطر البيع في نافذة «إنشاء فاتورة جديدة» (طلب المالك ٢ نوفمبر ٢٠٢٦).
// «تلقائي — الأقرب انتهاءً» افتراضاً (لا يُرسل شيء)، أو تشغيلةٌ واحدة للسطر كله، أو تقسيمٌ على أكثر من تشغيلة بمحرّر الصفوف
// المشترك مع شاشتي المخزون (LotRowsEditor). المنطق الصرف في lib/saleLots.ts، والكميات بوحدة الأساس (D22).
// ============================================================================

import { Layers } from 'lucide-react';
import { useTr } from '../i18n/strings';
import { formatDayOnly } from '../utils/format';
import { LOT_BLOCK_KIND_LABELS, LOT_STATUS_LABELS } from '../lib/lots';
import type { LotSource } from '../lib/stockLots';
import type { UnitDef } from '../lib/units';
import {
  SALE_LOT_SPLIT, asDraftProblem, initialSplitRows, lotQtyInLineUnit, saleLineBaseQty, saleLotPickable, saleLotView,
  type SaleLotPick, type SaleLotProblem,
} from '../lib/saleLots';
import { LotRowsEditor, draftProblemText, fmtLotQty } from './StockLotFields';

/** حالة المصادر: جاهزة، أو سببٌ يُبقي «تلقائي» وحده بنصٍّ بسيط */
export type SaleLotState = 'READY' | 'NO_REP' | 'NO_PERM' | 'LOADING' | 'FAILED';

/** سبب بقاء «تلقائي» وحده — نصوصٌ حرفية في tr() ليفحصها حارس المفاتيح */
function stateHint(state: Exclude<SaleLotState, 'READY'>, tr: (s: string) => string): string {
  if (state === 'NO_REP') return tr('اختر المندوب لاختيار التشغيلة من سيارته');
  if (state === 'NO_PERM') return tr('اختيار التشغيلة يحتاج صلاحية مخزون السيارات');
  if (state === 'LOADING') return tr('جاري التحميل');
  return tr('تعذر تحميل تشغيلات سيارة المندوب');
}

/** نصّ مشكلة تشغيلة السطر: رمزا البيع (موقوفة أو منتهية، وأربع خانات) ثم نصوص المحرّر المشتركة */
export function saleLotProblemText(
  p: SaleLotProblem | null, tr: (s: string) => string, prod?: Parameters<typeof draftProblemText>[2],
): string | null {
  if (p === 'LOT_NOT_SELLABLE') return tr('التشغيلة المختارة موقوفة أو منتهية لا تباع');
  if (p === 'LOT_BASE_DECIMALS') return tr('كمية الصنف المتتبع بأربع خانات عشرية على الأكثر بوحدة الأساس');
  return draftProblemText(asDraftProblem(p), tr, prod);
}

export default function SaleLotPicker({
  line, prod, state, sources, problem, serverError, disabled, onChange,
}: {
  line: { qty: number; unitFactor: number; unit: string; baseUnit: string; lotPick?: SaleLotPick | null };
  prod: { unit?: string | null; units?: UnitDef[] | null; primaryUnitId?: string | null } | null;
  state: SaleLotState;
  /** مصادر السطر (saleLotSources): المتاح بعد أسطر الصنف الأخرى — null قبل وصول اللقطة */
  sources: { all: LotSource[]; eligible: LotSource[] } | null;
  problem: SaleLotProblem | null;
  serverError?: string | null;
  disabled?: boolean;
  onChange: (pick: SaleLotPick | null) => void;
}) {
  const tr = useTr();
  const pick = line.lotPick ?? null;
  const base = saleLineBaseQty(line);
  const baseUnit = line.baseUnit || prod?.unit || '';
  const autoLabel = `${tr('التشغيلة')}: ${tr('تلقائي — الأقرب انتهاءً')}`;

  const view = saleLotView(state === 'READY' && !!sources, pick);
  if (view !== 'SELECT' || !sources) {
    return (
      <div className="mt-1 min-w-[12rem] max-w-[22rem]" data-sale-lot="">
        {view === 'PICK_KEPT' && pick ? (
          // اختيارٌ قائم بلا لقطة: يُرسل كما هو (والخادم يحكم) — فلا يُكتب «تلقائي» فوقه، ويُعاد إليه بزرّ
          <p className="text-[11px] text-[#1F1A13] inline-flex items-center gap-1 flex-wrap">
            <Layers size={12} className="text-[#E15A30]" />
            {tr('التشغيلة')}: {pick.mode === 'SPLIT' ? tr('تقسيم على أكثر من تشغيلة') : tr('تشغيلة مختارة')}
            <button type="button" disabled={disabled} onClick={() => onChange(null)}
              className="text-[#E15A30] font-semibold underline disabled:opacity-40">{tr('تلقائي')}</button>
          </p>
        ) : (
          <p className="text-[11px] text-[#6E6557] inline-flex items-center gap-1"><Layers size={12} className="text-[#E15A30]" />{autoLabel}</p>
        )}
        {state !== 'READY' && <p className="text-[10px] text-gray-400">{stateHint(state, tr)}</p>}
        {pick && problem && <p className="text-[10px] text-red-600 mt-0.5">{saleLotProblemText(problem, tr, prod)}</p>}
        {serverError && <p className="text-[10px] text-red-600 mt-0.5">{serverError}</p>}
      </div>
    );
  }

  const known = new Set(sources.all.map((s) => s.lotId));
  const value = !pick ? '' : pick.mode === 'ONE' ? pick.lotId : SALE_LOT_SPLIT;
  const optionLabel = (s: LotSource) => {
    const exp = s.expiryDate ? ` · ${tr('ينتهي')} ${formatDayOnly(s.expiryDate)}` : '';
    const tag = s.status === 'BLOCKED'
      ? ` · ${tr(s.blockKind ? LOT_BLOCK_KIND_LABELS[s.blockKind] : LOT_STATUS_LABELS.BLOCKED)}`
      : s.expired ? ` · ${tr('منتهية')}` : '';
    return `${s.lotNumber ?? ''}${exp}${tag} — ${tr('متاح')} ${lotQtyInLineUnit(s.usable, line, baseUnit)}`;
  };
  const choose = (v: string) => {
    if (!v) { onChange(null); return; }
    if (v === SALE_LOT_SPLIT) {
      // كراتين كاملة من كل تشغيلة أولاً كما يوزّع «تلقائي» (مراجعة D1)
      onChange({ mode: 'SPLIT', rows: initialSplitRows(base, sources.eligible, pick?.mode === 'ONE' ? pick.lotId : null, line.unitFactor) });
      return;
    }
    onChange({ mode: 'ONE', lotId: v });
  };

  return (
    <div className="mt-1 min-w-[12rem] max-w-[22rem]" data-sale-lot="">
      <div className="flex items-center gap-1">
        <Layers size={12} className="text-[#E15A30] shrink-0" />
        <select className={`input py-1 text-xs w-full min-w-0 ${problem || serverError ? 'border-red-300' : pick ? 'border-[#E15A30]/50' : ''}`}
          value={value} disabled={disabled} aria-label={tr('تشغيلة الصنف')} title={tr('تشغيلة الصنف')}
          onChange={(e) => choose(e.target.value)}>
          <option value="">{autoLabel}</option>
          {sources.all.map((s) => (
            <option key={s.lotId!} value={s.lotId!} disabled={!saleLotPickable(s) && value !== s.lotId}>{optionLabel(s)}</option>
          ))}
          {pick?.mode === 'ONE' && !known.has(pick.lotId) && <option value={pick.lotId}>{tr('تشغيلة لم تعد متاحة')}</option>}
          <option value={SALE_LOT_SPLIT} disabled={!sources.eligible.some(saleLotPickable) && pick?.mode !== 'SPLIT'}>{tr('تقسيم على أكثر من تشغيلة')}</option>
        </select>
      </div>
      {sources.all.length === 0 && !pick && <p className="text-[10px] text-gray-400 mt-0.5">{tr('لا تشغيلات مسماة لهذا الصنف في سيارة المندوب')}</p>}
      {pick?.mode === 'SPLIT' && (
        <div className="mt-1.5 rounded-lg border border-[#F1EBDF] bg-[#FAF7F0] px-2 py-1.5 space-y-1">
          {/* الصفوف بوحدة الأساس، فالسطر بوحدةٍ أكبر يُقال كم هو بالأساس — مجموع الصفوف يساويه تماماً */}
          <p className="text-[10px] text-[#6E6557]">
            {tr('كمية السطر')}: <b className="text-[#1F1A13]">{fmtLotQty(base)}{baseUnit ? ` ${baseUnit}` : ''}</b>
          </p>
          <LotRowsEditor rows={pick.rows} onChange={(rows) => onChange({ mode: 'SPLIT', rows })} sources={sources.eligible}
            lineBaseQty={base} baseUnit={baseUnit} problem={asDraftProblem(problem)} prod={prod} />
          {problem && !asDraftProblem(problem) && <p className="text-[10px] text-red-600">{saleLotProblemText(problem, tr, prod)}</p>}
        </div>
      )}
      {pick?.mode === 'ONE' && problem && <p className="text-[10px] text-red-600 mt-0.5">{saleLotProblemText(problem, tr, prod)}</p>}
      {serverError && <p className="text-[10px] text-red-600 mt-0.5">{serverError}</p>}
    </div>
  );
}

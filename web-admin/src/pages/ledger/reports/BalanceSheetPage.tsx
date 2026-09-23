import { useCallback, useMemo } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useTr } from '../../../i18n/strings';
import { formatDayOnly } from '../../../utils/format';
import { LedgerAmount } from '../../../components/ledger/LedgerAmount';
import type { ReportPeriodPayload, ReportResponse } from '../../../api/ledgerReports';
import ReportView, { type ReportRenderContext, type ReportTable } from './ReportView';
import { LEDGER_REPORTS_BASE, milliToUnitString } from './reportOptions';
import {
  balanceSheetCheck, balanceSheetTable,
  type BalanceSheetNodeRow, type BalanceSheetResponse,
} from './statementLines';

/**
 * **الميزانية العمومية** (M4، DESIGN.md §7.4، BS‑01…BS‑04) فوق القشرة المشتركة `ReportView` —
 * على نمط `TrialBalancePage`: الصفحة لا تجلب ولا تحسب ولا تصدّر.
 *
 * في القشرة: منتقي الفترة («حتى تاريخ» وحدها، §7.4 — يقصّها `reportFeatures`) والمقارنة ووحدة
 * العرض و«المرحّلة فقط» والهرمية وإخفاء الأصفار والبحث، وحالة الرابط، والطيّ، وتنبيهات RPT‑08،
 * **وزرّا التصدير**. وفي `statementLines.ts` الصرفة: الأقسام والمعادلات وسطر «الالتزامات + حقوق
 * الملكية» تذييلاً.
 *
 * وما هنا هو ما يخصّ هذا التقرير وحده:
 * - **وسم الخرق**: شريطٌ أحمر حين لا تتوازن، وآخر كهرماني حين يُخرَق ثابت حقوق الملكية. التوازن
 *   يُحسب من المجاميع نفسها (`balanceSheetCheck`) لا من وسم `balanced` وحده، فلا يمرّ فرقٌ صامت —
 *   ويظهر مع ذلك أحمر في صفّ الإجمالي نفسه (‏`danger` من `balanceSheetTable`).
 * - **ترويسة «اعتباراً من»**: مدى الردّ `[بداية السنة المالية، التاريخ]` مدى تعمّقٍ لا فترةَ
 *   تقرير (§7.5)، فيُعرض التاريخ وحده بـ`periodText` بدل مدى يضلّل القارئ.
 * - **تعمّق «أرباح السنة الجارية»** إلى قائمة الدخل للمدى نفسه [FYStart(D)، D] (§7.4).
 */

type BsResponse = ReportResponse<BalanceSheetNodeRow, BalanceSheetResponse['totals']>;

/** §7.4: تسمية «أرباح السنة الجارية غير الموزعة» ⇒ قائمة الدخل للفترة نفسها. صرفة. */
export function incomeStatementHref(period: ReportPeriodPayload): string {
  return `${LEDGER_REPORTS_BASE}/income-statement?mode=custom&from=${period.fyStart}&to=${period.to}`;
}

export default function BalanceSheetPage() {
  const tr = useTr();

  const toTable = useCallback(
    (data: BsResponse, ctx: ReportRenderContext): ReportTable =>
      balanceSheetTable(data as unknown as BalanceSheetResponse, ctx, { incomeHref: incomeStatementHref(ctx.period) }),
    [],
  );

  const summary = useCallback(
    (data: BsResponse, ctx: ReportRenderContext) => <ImbalanceNotice data={data as unknown as BalanceSheetResponse} ctx={ctx} />,
    [],
  );

  // «اعتباراً من 31/03/2026» لا «01/01/2026 — 31/03/2026»: الميزانية لحظةٌ لا مدة
  const periodText = useMemo(
    () => (p: ReportPeriodPayload) => `${tr('اعتباراً من')} ${formatDayOnly(p.to)}`,
    [tr],
  );

  return (
    <ReportView<BalanceSheetNodeRow, BalanceSheetResponse['totals']>
      reportKey="balance-sheet"
      title={tr('الميزانية العمومية')}
      subtitle={tr('الأصول مقابل الالتزامات وحقوق الملكية')}
      toTable={toTable}
      summary={summary}
      periodText={periodText}
    />
  );
}

/**
 * §7.4: «أي فرق يُعرض بشريط أحمر». الفرق يُحسب من المجاميع لا من وسم `balanced` الصامت،
 * والخرق الثاني (رأس المال + الأرباح مقابل مجموع حقوق الملكية) تنبيهٌ كهرماني لأنه خلل أسطر
 * لا خلل توازن.
 */
function ImbalanceNotice({ data, ctx }: { data: BalanceSheetResponse; ctx: ReportRenderContext }) {
  const tr = useTr();
  const check = balanceSheetCheck(data.totals);
  if (check.balanced && check.invariantHolds) return null;
  return (
    <>
      {!check.balanced && (
        <div className="rounded-xl border border-[#C0392B] bg-[#C0392B] p-3 text-xs text-white" role="alert">
          <p className="flex flex-wrap items-center gap-1.5 font-semibold">
            <AlertTriangle size={14} />
            {tr('الميزانية غير متوازنة: الأصول لا تساوي الالتزامات + حقوق الملكية')}
            {' — '}
            <LedgerAmount value={milliToUnitString(check.imbalanceMilli, ctx.unit)} decimals={ctx.decimals} colored={false} />
          </p>
        </div>
      )}
      {check.balanced && !check.invariantHolds && (
        <div className="rounded-xl border border-[#F0D7A8] bg-[#FDF6E7] p-3 text-xs text-[#7A5B12]" role="alert">
          <p className="flex flex-wrap items-center gap-1.5 font-semibold">
            <AlertTriangle size={14} />
            {tr('خلل في أسطر حقوق الملكية: رأس المال والأرباح لا يساوي مجموع حقوق الملكية')}
            {' — '}
            <LedgerAmount value={milliToUnitString(check.equityInvariantMilli, ctx.unit)} decimals={ctx.decimals} colored={false} />
          </p>
        </div>
      )}
    </>
  );
}

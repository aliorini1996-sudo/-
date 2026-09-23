import { useCallback } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useTr } from '../../../i18n/strings';
import { formatDayOnly } from '../../../utils/format';
import type { ReportResponse } from '../../../api/ledgerReports';
import ReportView, { type ReportRenderContext, type ReportTable } from './ReportView';
import {
  trialBalanceBroken, trialBalanceTable, trialImbalanceIssues, trialImbalanceLabels,
  type TrialBalanceResponse, type TrialCellJson, type TrialRowJson,
} from './reportRows';

/**
 * **ميزان المراجعة** (M4، DESIGN.md §7.2، TB‑01…TB‑03) فوق القشرة المشتركة `ReportView`.
 *
 * الصفحة لا تجلب ولا تحسب ولا تصدّر: الشريط والجلب والطيّ وزرّا التصدير في `ReportView`،
 * وتحويل الردّ إلى صفوف في `reportRows.ts` الصرفة. وما هنا هو ما يخصّ هذا التقرير وحده:
 *
 * - **الأعمدة الأربعة** لكل فترة (افتتاحي · مدين · دائن · نهائي) وتكرارها مع كل عمود مقارنة
 *   ومعه الفرق والنسبة (RPT‑04) — في `trialBalanceTable`.
 * - **صف «أرباح سنوات سابقة غير موزعة»**: صفٌّ افتراضي يبنيه الخادم (‏`kind: 'unallocated'`)
 *   بلا حساب، ويحمل حسابات `equity_unaffected` المدمجة فيه فيتعمّق إليها حين تكون حساباً واحداً.
 * - **صف الإجمالي بشروطه الثلاثة** (Σ الافتتاحي = 0، Σ المدين = Σ الدائن، Σ النهائي = 0) على
 *   **كل** الحسابات، و**الخرق يظهر أحمر** في الصف نفسه وفي تنبيه أعلى الجدول يسمّي الشرط
 *   المخروق وعموده. الشروط تُقرأ من `imbalance` في الردّ ولا تُعاد حسابها هنا.
 */

type TbResponse = ReportResponse<TrialRowJson, TrialCellJson[]>;

export default function TrialBalancePage() {
  const tr = useTr();

  const toTable = useCallback(
    (data: TbResponse, ctx: ReportRenderContext): ReportTable => trialBalanceTable(data as TrialBalanceResponse, ctx),
    [],
  );

  const summary = useCallback(
    (data: TbResponse) => <ImbalanceNotice data={data as TrialBalanceResponse} />,
    [],
  );

  return (
    <ReportView<TrialRowJson, TrialCellJson[]>
      reportKey="trial-balance"
      title={tr('ميزان المراجعة')}
      subtitle={tr('الرصيد الافتتاحي وحركة الفترة والرصيد النهائي')}
      toTable={toTable}
      summary={summary}
    />
  );
}

/**
 * تنبيه الخرق (§7.2): لا يظهر في الحالة السليمة، وحين يظهر يسمّي الشرط المخروق وعموده
 * بدل «غير متوازن» عامّة — فالخرق لا يقع إلا بخلل يحتاج فحص السلامة.
 */
function ImbalanceNotice({ data }: { data: TrialBalanceResponse }) {
  const tr = useTr();
  if (!trialBalanceBroken(data.imbalance)) return null;
  const labels = trialImbalanceLabels(tr);
  const columns = data.columns ?? [];
  return (
    <div className="rounded-xl border border-[#E8C3B7] bg-[#FBEBE2] p-3 text-xs text-[#C0392B]" role="alert">
      <p className="flex items-center gap-1.5 font-semibold">
        <AlertTriangle size={14} />
        {tr('صف الإجمالي مختلّ: راجع «مراجعة ← فحوصات السلامة»')}
      </p>
      <ul className="mt-1 space-y-0.5">
        {data.imbalance.flatMap((x, i) => trialImbalanceIssues(x).map(issue => (
          <li key={`${i}:${issue}`}>
            {columns[i]?.kind === 'comparison' ? `${tr('عمود المقارنة')} ${formatDayOnly(columns[i].to)}: ` : ''}
            {labels[issue]}
          </li>
        )))}
      </ul>
    </div>
  );
}

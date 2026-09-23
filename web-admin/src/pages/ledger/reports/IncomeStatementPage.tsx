import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTr } from '../../../i18n/strings';
import type { ReportResponse } from '../../../api/ledgerReports';
import ReportView, { type ReportRenderContext, type ReportTable } from './ReportView';
import type { ReportQueryParams } from './reportOptions';
import {
  incomeStatementTable,
  type IncomeStatementResponse, type IncomeStatementRow,
} from './statementLines';

/**
 * **قائمة الدخل** (M4، DESIGN.md §7.3، PL‑01…PL‑05) فوق القشرة المشتركة `ReportView` — على نمط
 * `TrialBalancePage`: الصفحة لا تجلب ولا تحسب ولا تصدّر.
 *
 * في القشرة: شريط §7.1 كاملاً (الفترة والمقارنة ووحدة العرض و«المرحّلة فقط» والهرمية وإخفاء
 * الأصفار والبحث)، وحالة الرابط، والطيّ، وتنبيهات RPT‑08، **وزرّا التصدير**. وفي
 * `statementLines.ts` الصرفة: الأسطر بترتيبها ومعادلاتها ومجاميعها الخمسة العريضة (RPT‑13).
 *
 * وما هنا هو ما يخصّ هذا التقرير وحده:
 * - **مبدّل «إظهار الحسابات بلا حركة»** (RPT‑14): يعيش في الرابط تحت `showZero`، ويمرّ بـ
 *   `extraParams` فيصل **النقطةَ والتصديرَ معاً** — فلا يعرض الملف ما لا تعرضه الشاشة أو العكس.
 * - أيقونة (i) بمعادلة كل سطر (RPT‑12) والتعمّق من مبلغ الحساب إلى دفتر الأستاذ (RPT‑11) كلاهما
 *   من حقلَي `hint` و`accountId` في عُقد الجدول، والقشرة ترسمهما.
 */

type IsResponse = ReportResponse<IncomeStatementRow, IncomeStatementResponse['totals']>;

/** RPT‑14 في الرابط: `showZero=true|1` (الافتراض إخفاء ما لا حركة له). صرفة. */
export function showZeroOf(sp: URLSearchParams): boolean {
  const v = sp.get('showZero');
  return v === 'true' || v === '1';
}

export default function IncomeStatementPage() {
  const tr = useTr();
  const [sp, setSp] = useSearchParams();
  const showZero = showZeroOf(sp);

  // يصل النقطةَ والتصديرَ معاً عبر القشرة (§7.1 البند 4: التصدير ينادي نقطته بالخيارات نفسها)
  const extraParams = useMemo<ReportQueryParams>(() => {
    const p: ReportQueryParams = {};
    if (showZero) p.showZero = 'true';
    return p;
  }, [showZero]);

  const toTable = useCallback(
    (data: IsResponse, ctx: ReportRenderContext): ReportTable =>
      incomeStatementTable(data as unknown as IncomeStatementResponse, ctx, { showAccountsWithoutMovement: showZero }),
    [showZero],
  );

  const toggleZero = (on: boolean) => {
    const next = new URLSearchParams(sp);
    if (on) next.set('showZero', 'true');
    else next.delete('showZero');
    setSp(next, { replace: true });
  };

  const extraControls = (
    <label className="inline-flex items-center gap-1.5 text-xs text-[#1F1A13]">
      <input type="checkbox" checked={showZero} onChange={e => toggleZero(e.target.checked)} />
      {tr('إظهار الحسابات بلا حركة')}
    </label>
  );

  return (
    <ReportView<IncomeStatementRow, IncomeStatementResponse['totals']>
      reportKey="income-statement"
      title={tr('قائمة الدخل')}
      subtitle={tr('الإيرادات والتكاليف حتى صافي الربح')}
      toTable={toTable}
      extraParams={extraParams}
      extraControls={extraControls}
    />
  );
}

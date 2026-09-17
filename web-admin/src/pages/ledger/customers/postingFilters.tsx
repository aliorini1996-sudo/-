import { Hourglass } from 'lucide-react';
import { useTr } from '../../../i18n/strings';
import type { LedgerFilterDef } from '../../../components/ledger/LedgerListView';
import type { PostingListParams } from '../../../api/ledgerReview';

/**
 * أجزاء مشتركة لقوائم «العملاء» (M3) — ليست صفحة مسار (لا صف لها في LEDGER_ROUTES).
 * الفلاتر `type:`/`status:`/`method:`/`posting:` ⇒ معاملات GET /customers/*؛ المجموعة الواحدة OR (قائمة بفواصل).
 */

type Tr = (ar: string) => string;

export function postingFilterDefs(tr: Tr): LedgerFilterDef[] {
  return [
    { key: 'posting:DONE', label: tr('مُرحّل'), group: 'posting' },
    { key: 'posting:PENDING', label: tr('بانتظار الترحيل'), group: 'posting' },
    { key: 'posting:BLOCKED', label: tr('محجوب مؤقتا'), group: 'posting' },
    { key: 'posting:ERROR', label: tr('خطأ'), group: 'posting' },
    { key: 'posting:HELD', label: tr('موقوف'), group: 'posting' },
    { key: 'posting:SKIPPED', label: tr('متخطّى'), group: 'posting' },
  ];
}

export function postingParamsOf(filters: readonly string[]): PostingListParams {
  const pick = (prefix: string) => filters.filter(f => f.startsWith(prefix)).map(f => f.slice(prefix.length));
  return { type: pick('type:'), status: pick('status:'), paymentMethod: pick('method:'), posting: pick('posting:') };
}

export function NotActivatedNotice() {
  const tr = useTr();
  return (
    <div className="flex items-start gap-2 rounded-xl border border-[#F3D3C4] bg-[#FBEBE2] px-3 py-2 text-sm text-[#1F1A13]" role="status">
      <Hourglass size={16} className="text-[#E15A30] shrink-0 mt-0.5" />
      <p><span className="font-semibold">{tr('الدفاتر بانتظار الإعداد')}</span> — {tr('المستندات تظهر هنا، وتُرحَّل آليا بعد التفعيل')}</p>
    </div>
  );
}

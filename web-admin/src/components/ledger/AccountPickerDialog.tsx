import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search, X, ChevronRight, ChevronLeft } from 'lucide-react';
import { useTr } from '../../i18n/strings';
import { useLang } from '../../i18n/lang';
import { ledgerName } from '../../lib/ledger/format';
import { accountTypeLabels } from '../../lib/ledger/labels';
import { backdropClose } from '../../lib/backdropClose';
import { useBackClose } from '../../lib/useBackClose';
import { ledgerConfigApi, ledgerKeys, isLedgerAccessError, type AccountListParams, type GlAccount } from '../../api/ledgerConfig';
import { ACCOUNT_GROUP_ORDER, accountGroupLabels, accountTypesOfGroup, fillCount, type AccountGroupKey } from './accountPicker';

/**
 * نافذة «بحث عن المزيد» لاختيار الحساب (م‑4 من مراجعة الخبير، على غرار أودو):
 * بحثٌ **بالخادم** — فيطابق الرمز والاسم بكل اللغات والوصف والمرادفات التي يعرفها
 * القالب — وفلتر بالنوع، وأعمدة الرمز والاسم والوصف والنوع، وترقيم صفحات،
 * واختيار بالنقر أو بالسهام وEnter.
 *
 * تُفتح من منتقي سطر القيد حين لا يكفيه المعروض؛ ولذلك تبحث في الحسابات **النشطة**
 * وحدها (المؤرشف لا يُرحَّل إليه)، ولا تفتح شاشة تحرير ولا تكتب شيئاً.
 */

/** صفوف الصفحة الواحدة في النافذة. */
const PAGE = 20;

export function AccountPickerDialog({ initialSearch = '', onPick, onClose }: {
  initialSearch?: string;
  onPick: (account: GlAccount) => void;
  onClose: () => void;
}) {
  const tr = useTr();
  const lang = useLang(s => s.lang);
  const groupLabels = accountGroupLabels(tr);
  const typeLabels = accountTypeLabels(tr);
  const [search, setSearch] = useState(initialSearch);
  const [debounced, setDebounced] = useState(initialSearch.trim());
  const [group, setGroup] = useState<AccountGroupKey | null>(null);
  const [offset, setOffset] = useState(0);
  const [hi, setHi] = useState(0);
  const listRef = useRef<HTMLTableSectionElement>(null);

  useBackClose(true, onClose);

  // مهلة قصيرة قبل سؤال الخادم كي لا يُطلق كل حرفٍ طلباً
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);
  useEffect(() => { setOffset(0); setHi(0); }, [debounced, group]);

  const params: AccountListParams = {
    search: debounced || undefined,
    type: group ? accountTypesOfGroup(group) : undefined,
    offset,
    limit: PAGE,
  };
  const q = useQuery({
    queryKey: ledgerKeys.accounts(params),
    queryFn: async () => (await ledgerConfigApi.accounts.list(params)).data,
    placeholderData: prev => prev,
  });

  const rows = q.data?.data ?? [];
  const total = q.data?.pagination?.total ?? rows.length;
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + rows.length, total);
  /** المميَّز محسوبٌ لا مخزَّن: صفحةٌ أقصر لا تترك التحديد خارجها */
  const active = rows.length ? Math.min(hi, rows.length - 1) : -1;

  // إبقاء الصفّ المميَّز داخل مجال الرؤية عند التنقّل بالسهام
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-hi="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active, rows]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setHi(Math.min(active + 1, rows.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi(Math.max(active - 1, 0)); }
    else if (e.key === 'Enter' && rows[active]) { e.preventDefault(); onPick(rows[active]); }
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-[70] flex items-center justify-center p-3 sm:p-4" {...backdropClose(onClose)}>
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[90vh] flex flex-col"
        onClick={e => e.stopPropagation()} onKeyDown={onKeyDown}
        role="dialog" aria-modal="true" aria-labelledby="account-picker-title"
      >
        <div className="flex items-center gap-2 px-5 py-4 border-b border-[#F1EBDF]">
          <Search size={18} className="text-[#E15A30]" />
          <h2 id="account-picker-title" className="text-lg font-bold text-[#1F1A13] flex-1">{tr('اختيار حساب')}</h2>
          <button type="button" onClick={onClose} aria-label={tr('إغلاق')} className="p-1 rounded hover:bg-[#F1EBDF]"><X size={18} /></button>
        </div>

        <div className="px-5 pt-4 space-y-3">
          <input
            className="input" autoFocus value={search} onChange={e => setSearch(e.target.value)}
            placeholder={tr('ابحث بالرمز أو الاسم أو الوصف')} aria-label={tr('ابحث بالرمز أو الاسم أو الوصف')}
          />
          <div className="flex flex-wrap gap-1.5">
            <GroupChip active={group === null} onClick={() => setGroup(null)}>{tr('كل الأنواع')}</GroupChip>
            {ACCOUNT_GROUP_ORDER.map(g => (
              <GroupChip key={g} active={group === g} onClick={() => setGroup(group === g ? null : g)}>{groupLabels[g]}</GroupChip>
            ))}
          </div>
        </div>

        <div className="px-5 py-3 flex-1 overflow-auto">
          {q.isError && (
            <p className="text-sm text-[#C0392B]">{isLedgerAccessError(q.error) ? tr('لا تملك صلاحية الوصول لهذا القسم') : tr('تعذر تحميل الحسابات')}</p>
          )}
          {!q.isError && q.isLoading && <p className="text-sm text-[#9A8F7E]">{tr('جاري التحميل...')}</p>}
          {!q.isError && !q.isLoading && rows.length === 0 && <p className="text-sm text-[#9A8F7E]">{tr('لا حساب يطابق البحث')}</p>}
          {rows.length > 0 && (
            <div className="table-wrapper">
              <table className="table">
                <thead>
                  <tr>
                    <th className="text-start w-24">{tr('الرمز')}</th>
                    <th className="text-start">{tr('اسم الحساب')}</th>
                    <th className="text-start hidden sm:table-cell">{tr('الوصف')}</th>
                    <th className="text-start hidden md:table-cell w-40">{tr('النوع')}</th>
                  </tr>
                </thead>
                <tbody ref={listRef}>
                  {rows.map((a, i) => (
                    <tr
                      key={a.id} data-hi={i === active} className={`cursor-pointer ${i === active ? 'bg-[#FBEBE2]' : ''}`}
                      onClick={() => onPick(a)} onMouseEnter={() => setHi(i)}
                    >
                      <td className={`align-top ${a.isActive ? '' : 'line-through'}`}><bdi className="tabular-nums text-[#6E6557]">{a.code}</bdi></td>
                      <td className={`align-top font-medium ${a.isActive ? '' : 'line-through'}`}>{ledgerName(a, lang)}</td>
                      {/* الوصف عربيّ في القالب ويُترجَم عبر القاموس حين تُضاف ترجمته (عقد الدفعة أ) */}
                      <td className="align-top text-xs text-[#6E6557] hidden sm:table-cell">{a.description ? tr(a.description) : '—'}</td>
                      <td className="align-top text-xs text-[#6E6557] hidden md:table-cell">{typeLabels[a.type] ?? a.type}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 px-5 py-3 border-t border-[#F1EBDF]">
          <p className="text-xs text-[#6E6557] flex-1">
            {fillCount(tr('{from}–{to} من {total} حساباً'), { from, to, total })}
          </p>
          <button
            type="button" className="btn-secondary !px-3 !py-1.5 disabled:opacity-40" disabled={offset === 0}
            onClick={() => { setOffset(o => Math.max(0, o - PAGE)); setHi(0); }}
          >
            <ChevronRight size={14} />{tr('السابق')}
          </button>
          <button
            type="button" className="btn-secondary !px-3 !py-1.5 disabled:opacity-40" disabled={to >= total}
            onClick={() => { setOffset(o => o + PAGE); setHi(0); }}
          >
            {tr('التالي')}<ChevronLeft size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}

function GroupChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button" onClick={onClick} aria-pressed={active}
      className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
        active ? 'bg-[#E15A30] text-white border-[#E15A30]' : 'bg-white text-[#44403a] border-[#DED5C4] hover:bg-[#FAF7F0]'}`}
    >
      {children}
    </button>
  );
}

export default AccountPickerDialog;

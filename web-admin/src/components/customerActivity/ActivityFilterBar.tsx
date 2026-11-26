import { memo } from 'react';
import { ArrowDownUp, Search, X } from 'lucide-react';
import { useTr } from '../../i18n/strings';
import { actorKindLabel, type ActivityView, type ActivityWho } from '../../lib/customerActivity';

/**
 * أدوات عرض «السجل الزمني» في أرشيف العميل (طلب المالك ٢١ نوفمبر ٢٠٢٦، أُعيدت فوق السجلّ الثابت): البحث في الملاحظات والأرقام
 * والأسماء، و«من نفّذ» (مندوبٌ أو إداريٌّ أو غيرهما)، و«الأحدث/الأقدم أولاً». تغيّر ما يُعرض وحده في الواجهة — لا تكتب شيئاً،
 * والسجلّ نفسه ثابتٌ لا يُعدَّل ولا يُحذف. الحالة عند الشاشة المضيفة (CustomerStudioModal) فيضبط «من خدم العميل» المنفّذ أيضاً.
 */
function ActivityFilterBarView({ view, onChange, options }: {
  view: ActivityView;
  onChange: (next: ActivityView) => void;
  /** خيارات «من نفّذ»: مناديب الأرشيف ثم منفّذو البنود المحمّلة (whoOptions) */
  options: ActivityWho[];
}) {
  const tr = useTr();
  const q = view.q ?? '';
  const order = view.order ?? 'desc';
  const labelOf = (w: ActivityWho) => (w.name ? `${w.name} · ${tr(actorKindLabel(w.kind))}` : tr(actorKindLabel(w.kind)));
  // المختار يبقى خياراً ولو لم تصل بنوده بعد (نقرةٌ على «من خدم العميل» قبل التحميل)
  const list = view.who && !options.some((o) => o.key === view.who!.key) ? [view.who, ...options] : options;
  return (
    <div className="flex flex-wrap items-center gap-2" role="search">
      <div className="relative flex-1 min-w-[180px]">
        <Search size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-[#6E6557]" />
        <input value={q} onChange={(e) => onChange({ ...view, q: e.target.value })} placeholder={tr('ابحث في الملاحظات والأرقام والأسماء')}
          aria-label={tr('ابحث في الملاحظات والأرقام والأسماء')} type="search"
          className="w-full text-sm border border-[#E9E1D3] rounded-lg pr-9 pl-8 py-2 bg-white outline-none focus:border-[#E15A30]" />
        {q && (
          <button type="button" onClick={() => onChange({ ...view, q: '' })} aria-label={tr('مسح البحث')} title={tr('مسح البحث')}
            className="absolute left-2 top-1/2 -translate-y-1/2 p-0.5 rounded text-[#6E6557] hover:text-[#1F1A13]">
            <X size={13} />
          </button>
        )}
      </div>
      <select value={view.who?.key ?? ''} aria-label={tr('من نفذ الإجراء')}
        onChange={(e) => onChange({ ...view, who: list.find((o) => o.key === e.target.value) ?? null })}
        className="text-sm border border-[#E9E1D3] rounded-lg px-2 py-2 bg-white outline-none focus:border-[#E15A30] max-w-[220px]">
        <option value="">{tr('كل المنفذين')}</option>
        {list.map((o) => <option key={o.key} value={o.key}>{labelOf(o)}</option>)}
      </select>
      <button type="button" onClick={() => onChange({ ...view, order: order === 'desc' ? 'asc' : 'desc' })} aria-pressed={order === 'asc'}
        className={`flex items-center gap-1.5 text-sm font-semibold rounded-lg px-3 py-2 border bg-white text-[#1F1A13] hover:border-[#E15A30] ${order === 'asc' ? 'border-[#E15A30]' : 'border-[#E9E1D3]'}`}>
        <ArrowDownUp size={14} /> {order === 'desc' ? tr('الأحدث أولا') : tr('الأقدم أولا')}
      </button>
    </div>
  );
}

const ActivityFilterBar = memo(ActivityFilterBarView);
export default ActivityFilterBar;

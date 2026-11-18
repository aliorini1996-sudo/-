import { useState } from 'react';
import { CalendarRange, PenLine, X } from 'lucide-react';
import { useTr } from '../../../i18n/strings';
import { monthStartOf, rangeError, visibleTemplates, type AiStatus, type ChatTemplate, type TemplateGate } from '../../../lib/aiAccountant';

/**
 * شرائح «الطلبات الجاهزة» — قائمة العقد بترتيبها: قوالب الترحيل لمن يرحّل وحده، و«ميزان المراجعة»/«المصروفات» لمن فعّل
 * الدفاتر (لا بديل تشغيلي لهما)، وتقارير الدفاتر لمن يراها، و«المشتريات والمخزون» لشركةٍ فعّلت المخزون (visibleTemplates).
 * «قوائم مالية من تاريخ إلى تاريخ» تفتح خانتي تاريخ تحت الشرائح، والفترة تُرسَل نصّاً صريحاً بالأرقام فلا يحسب النموذج
 * تاريخاً بنفسه.
 *
 * compact (الجوال) أحجامٌ أصغر، وsingleRow (الجوال دائماً، والويب بعد بدء المحادثة): الشرائح سطرٌ واحد يُمرَّر أفقياً بدل
 * الالتفاف — فلا تُستهلك مساحة الرسائل بثلاثة أسطر شرائح.
 */
export default function TemplateBar({ status, compact, singleRow, disabled, onPick, onRange }: {
  status: (TemplateGate & Pick<AiStatus, 'todayLocal'>) | null;
  compact?: boolean;
  singleRow?: boolean;
  disabled?: boolean;
  onPick: (t: ChatTemplate) => void;
  onRange: (t: ChatTemplate, range: { from: string; to: string }) => void;
}) {
  const tr = useTr();
  const templates = visibleTemplates(status);
  const today = status?.todayLocal ?? '';
  const [rangeFor, setRangeFor] = useState<ChatTemplate | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const err = rangeFor ? rangeError(from, to) : null;

  const pick = (t: ChatTemplate) => {
    if (disabled) return;
    if (t.mode === 'range') {
      if (rangeFor) { setRangeFor(null); return; }
      // الافتراض: أول الشهر الحالي حتى اليوم — بتقويم الشركة (من حالة الخادم)
      setFrom(today ? monthStartOf(today) : '');
      setTo(today);
      setRangeFor(t);
      return;
    }
    setRangeFor(null);
    onPick(t);
  };

  const submitRange = () => {
    if (!rangeFor || err || disabled) return;
    onRange(rangeFor, { from, to });
    setRangeFor(null);
  };

  return (
    <div className={compact ? 'px-3 pt-2' : 'px-4 pt-3'}>
      <div
        className={singleRow ? `flex gap-1.5 overflow-x-auto pb-2 ${compact ? '-mx-3 px-3' : '-mx-4 px-4'}` : 'flex flex-wrap gap-1.5 pb-1'}
        style={singleRow ? { scrollbarWidth: 'none' } : undefined}
        role="group"
        aria-label={tr('طلبات جاهزة')}
      >
        {templates.map(t => {
          const active = rangeFor?.id === t.id;
          return (
            <button
              key={t.id}
              type="button"
              disabled={disabled}
              onClick={() => pick(t)}
              className={[
                'shrink-0 inline-flex items-center gap-1 rounded-full border transition-colors whitespace-nowrap disabled:opacity-50',
                compact ? 'text-[11px] px-2.5 py-1.5' : 'text-xs px-3 py-1.5',
                t.posting
                  ? 'border-[#E15A30]/40 bg-[#FBEBE2] text-[#C94E28] hover:bg-[#F8DCCD]'
                  : active
                    ? 'border-[#E15A30] bg-[#E15A30] text-white'
                    : 'border-[#E0D7C6] bg-white text-[#44403a] hover:border-[#E15A30]/60 hover:text-[#C94E28]',
              ].join(' ')}
            >
              {t.posting && <PenLine size={12} />}
              {t.mode === 'range' && <CalendarRange size={12} />}
              {tr(t.label)}
            </button>
          );
        })}
      </div>

      {rangeFor && (
        <div className={`mt-1 mb-1 rounded-xl border border-[#E9E1D3] bg-[#FAF7F0] ${compact ? 'p-2' : 'p-3'}`}>
          <div className="flex items-end gap-2 flex-wrap">
            <div className={compact ? 'flex-1 min-w-[120px]' : ''}>
              <label className="block text-[11px] font-medium text-[#6E6557] mb-0.5">{tr('من')}</label>
              <input type="date" className={`input ${compact ? 'py-1.5' : 'w-40'}`} value={from} max={to || undefined}
                onChange={e => setFrom(e.target.value)} />
            </div>
            <div className={compact ? 'flex-1 min-w-[120px]' : ''}>
              <label className="block text-[11px] font-medium text-[#6E6557] mb-0.5">{tr('إلى')}</label>
              <input type="date" className={`input ${compact ? 'py-1.5' : 'w-40'}`} value={to} min={from || undefined}
                onChange={e => setTo(e.target.value)} />
            </div>
            <div className="flex items-center gap-1.5">
              <button type="button" className="btn-primary py-2" disabled={!!err || disabled} onClick={submitRange}>
                {tr('اعرض القوائم')}
              </button>
              <button type="button" className="p-2 text-[#9A8F7E] hover:text-[#1F1A13]" onClick={() => setRangeFor(null)}
                aria-label={tr('إلغاء')} title={tr('إلغاء')}>
                <X size={16} />
              </button>
            </div>
          </div>
          {err === 'reversed' && <p className="text-xs text-red-600 mt-1.5">{tr('تاريخ البداية بعد تاريخ النهاية')}</p>}
          {(err === 'invalid' || err === 'missing') && (from || to) && <p className="text-xs text-red-600 mt-1.5">{tr('اختر تاريخين صحيحين')}</p>}
        </div>
      )}
    </div>
  );
}

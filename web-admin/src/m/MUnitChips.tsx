import { useTr } from '../i18n/strings';
import { formatNumber } from '../utils/format';
import type { UnitChoice } from '../rep/repUnits';

/**
 * منتقي وحدة السطر (الوحدات المتعددة) — رقائق لا قائمة منسدلة: وحدتان أو ثلاث تُرى كلّها وتُنقر بالإبهام.
 *
 * لا يُرسم أصلاً لصنفٍ بوحدةٍ واحدة: الشاشة كما قبل الميزة حرفاً. ومعامل كل وحدةٍ بجانب اسمها («كرتون ٢٤»):
 * اسمٌ وحده لا يقول كم حبّةً يُحمَّل، وكرتونٌ بـ١٢ عند صنفٍ و٢٤ عند آخر.
 * `taken` وحداتٌ أخذها سطرٌ آخر للصنف نفسه — تُعطَّل لا تُخفى، فيعرف المستخدم أين ذهبت.
 */
export default function MUnitChips({ options, value, onChange, taken }: {
  options: UnitChoice[];
  /** معرّف الوحدة المختارة — null للأساس */
  value: string | null;
  onChange: (unitId: string | null) => void;
  taken?: (c: UnitChoice) => boolean;
}) {
  const tr = useTr();
  if (options.length < 2) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label={tr('الوحدة')}>
      {options.map(o => {
        const on = (o.id ?? null) === (value ?? null);
        const off = !on && !!taken?.(o);
        return (
          <button key={o.id ?? 'base'} type="button" role="radio" aria-checked={on} disabled={off}
            onClick={() => { if (!on) onChange(o.id); }}
            className={`min-h-[34px] px-3 rounded-full text-[12px] font-semibold border transition-colors
              ${on ? 'bg-[#E15A30] text-white border-[#E15A30]'
                : off ? 'bg-[#F5F1E9] text-[#C9BFB0] border-[#F1EBDF]'
                : 'bg-white text-[#6E6557] border-[#E9E1D3] active:bg-[#FAF7F0]'}`}>
            {o.name}
            {o.factor > 1 && <span className="opacity-75 font-normal"> {formatNumber(o.factor)}</span>}
          </button>
        );
      })}
    </div>
  );
}

/**
 * «أدوات التصميم» لكل قسم (طلب المالك ٣ نوفمبر ٢٠٢٦): إظهار/إخفاء، والمحاذاة، وحجم الخط بالنسبة (70–160٪)، والمسافة قبله
 * وبعده بالملّيمتر. يستعملها مفتّش المصمّم الحرّ وصفوف «أدوات التصميم» في المحرّر (P7) — بلا استيراد للـAPI فتُختبر في node.
 *
 * القيمة الافتراضية (ظاهر، محاذاة القالب، 100٪، 0 ملم) تُحذف من المخزَّن لا تُكتب — فالتعديل الذي يعود إلى الافتراضي لا يترك
 * أثراً، وملفٌّ لم يُمسّ يطبع كاليوم حرفياً. كل كتابةٍ تمرّ بـwithSectionStyle (designModel).
 */
import { useEffect, useState } from 'react';
import { Eye, EyeOff, RotateCcw } from 'lucide-react';
import { useTr } from '../../../i18n/strings';
import {
  ALIGNS, ALIGN_LABELS, LAYOUT_BOUNDS, LOCKED_VISIBLE, SECTION_LABELS, layoutOf,
  type Align, type PrintProfile, type SectionId, type SectionStyle,
} from '../../../lib/print/printSettings';
import { withSectionStyle } from '../../../lib/print/designModel';

/** أقسامٌ تحمل بيانات إلزامية للفاتورة الضريبية — إخفاؤها مسموح (قرار المالك في نصوص المطبوعات) بتنبيهٍ وتأكيدٍ واحد */
export const MANDATORY_CONTENT_SECTIONS: readonly SectionId[] = Object.freeze(['header', 'info', 'parties', 'customer', 'totals'] as SectionId[]);
export const HIDE_MANDATORY_WARNING = 'هذا القسم يحمل بيانات إلزامية للفاتورة الضريبية، وإخفاؤه قد يخالف متطلبات الفوترة الإلكترونية';
export const LOCKED_VISIBLE_HINT = 'الأصناف ورمز QR لا تخفى';

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const ARABIC_DIGITS = /[٠-٩]/g;

/** نصّ الخانة → رقم (يقبل الأرقام العربية والفاصلة) أو null */
export function parseNum(text: string): number | null {
  const t = text.trim().replace(ARABIC_DIGITS, (d) => String(d.charCodeAt(0) - 0x0660)).replace('٫', '.').replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** نمط القسم المحفوظ (أو {}) */
export const sectionStyleOf = (p: PrintProfile, id: SectionId): SectionStyle => ({ ...(layoutOf(p).sections?.[id] ?? {}) });

/** تعديل مفتاحٍ واحد: undefined يحذفه، والقيمة الافتراضية (ظاهر/100٪/0 ملم) يحذفها withSectionStyle، والنمط الفارغ يُزال كلّه */
export function withStyleKey<K extends keyof SectionStyle>(p: PrintProfile, id: SectionId, key: K, value: SectionStyle[K] | undefined): PrintProfile {
  return withSectionStyle(p, id, { [key]: value } as Partial<SectionStyle>);
}

const clampTo = (v: number, [lo, hi]: readonly [number, number]): number => Math.min(hi, Math.max(lo, v));
export const clampFontPct = (v: number): number => Math.round(clampTo(v, LAYOUT_BOUNDS.fontPct));
export const clampSpaceMm = (v: number): number => Math.round(clampTo(v, LAYOUT_BOUNDS.spaceMm) * 2) / 2;

/** خانة رقمٍ بنصٍّ محلّي: لا تُرسل إلا رقماً منتهياً بعد قصّه (عند Enter أو مغادرة الخانة) — كـNumField في المحرّر */
export function NumInput({ value, onCommit, clampFn, label, suffix, width = 64, disabled }: {
  value: number; onCommit(v: number): void; clampFn(v: number): number; label: string; suffix?: string; width?: number; disabled?: boolean;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => { setText(String(value)); }, [value]);
  const commit = (): void => {
    const n = parseNum(text);
    if (n === null) { setText(String(value)); return; }
    const v = clampFn(n);
    setText(String(v));
    if (v !== value) onCommit(v);
  };
  return (
    <span className="inline-flex items-center gap-1">
      <input type="text" inputMode="decimal" dir="ltr" aria-label={label} value={text} disabled={disabled}
        onChange={(e) => setText(e.target.value)} onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }}
        className="input !py-1 !px-2 text-xs text-center" style={{ width }} />
      {suffix && <span className="text-[11px] text-[#9A8F7E]" dir="ltr">{suffix}</span>}
    </span>
  );
}

export const chipCls = (on: boolean): string =>
  `rounded-full border px-2.5 py-0.5 text-[11px] font-semibold disabled:opacity-40 ${on ? 'border-[#E15A30] bg-[#FBEBE2] text-[#C94E28]' : 'border-[#E9E1D3] bg-white text-[#44403a]'}`;

/** شرائح المحاذاة بترتيبها المادي على الورقة العربية: يمين (البداية) ثم وسط ثم يسار */
export function AlignChips({ value, onChange, allowAuto, label }: { value: Align | null; onChange(a: Align | null): void; allowAuto?: boolean; label: string }) {
  const tr = useTr();
  return (
    <span className="inline-flex flex-wrap gap-1" role="group" aria-label={label}>
      {allowAuto && (
        <button type="button" aria-pressed={value === null} onClick={() => onChange(null)} className={chipCls(value === null)}>{tr('تلقائي')}</button>
      )}
      {ALIGNS.map((a) => (
        <button type="button" key={a} aria-pressed={value === a} onClick={() => onChange(a)} className={chipCls(value === a)}>{tr(ALIGN_LABELS[a])}</button>
      ))}
    </span>
  );
}

/** صفوف أدوات قسمٍ واحد */
export function SectionStyleFields({ p, update, id, phase2 }: { p: PrintProfile; update(next: PrintProfile): void; id: SectionId; phase2: boolean }) {
  const tr = useTr();
  const s = sectionStyleOf(p, id);
  const visible = s.visible !== false;
  const locked = LOCKED_VISIBLE.includes(id);
  const mandatory = MANDATORY_CONTENT_SECTIONS.includes(id);
  const fontPct = fin(s.fontPct) ? s.fontPct : 100;
  const before = fin(s.spaceBeforeMm) ? s.spaceBeforeMm : 0;
  const after = fin(s.spaceAfterMm) ? s.spaceAfterMm : 0;
  const empty = Object.keys(s).length === 0;
  const toggleVisible = (): void => {
    if (locked) return;
    if (visible && mandatory && !window.confirm(`${tr('إخفاء القسم')}: ${tr(SECTION_LABELS[id])}\n${tr(HIDE_MANDATORY_WARNING)}`)) return;
    update(withStyleKey(p, id, 'visible', visible ? false : undefined));
  };
  const row = 'flex flex-wrap items-center gap-2 py-1';
  const lab = 'text-[11px] text-[#6E6557] min-w-[84px]';
  return (
    <div data-section-style={id} className="space-y-0.5">
      <div className={row}>
        <span className={lab}>{tr('الظهور')}</span>
        <button type="button" onClick={toggleVisible} disabled={locked} aria-pressed={visible}
          title={locked ? tr(LOCKED_VISIBLE_HINT) : undefined}
          className={`${chipCls(visible)} inline-flex items-center gap-1`}>
          {visible ? <Eye className="w-3.5 h-3.5" aria-hidden="true" /> : <EyeOff className="w-3.5 h-3.5" aria-hidden="true" />}
          {visible ? tr('ظاهر') : tr('مخفي')}
        </button>
        {locked && <span className="text-[11px] text-[#9A8F7E]">{tr(LOCKED_VISIBLE_HINT)}</span>}
      </div>
      {!visible && mandatory && (
        <p className="text-[11px] text-[#8E2A1F] bg-[#FBEBE2] rounded px-2 py-1" role="note">{tr(HIDE_MANDATORY_WARNING)}</p>
      )}
      <div className={row}>
        <span className={lab}>{tr('المحاذاة')}</span>
        <AlignChips value={s.align ?? null} allowAuto label={tr('المحاذاة')} onChange={(a) => update(withStyleKey(p, id, 'align', a ?? undefined))} />
      </div>
      <div className={row}>
        <span className={lab}>{tr('حجم الخط')}</span>
        <input type="range" min={LAYOUT_BOUNDS.fontPct[0]} max={LAYOUT_BOUNDS.fontPct[1]} step={5} value={fontPct}
          aria-label={tr('حجم الخط')} className="w-28 accent-[#E15A30]" style={{ touchAction: 'pan-y' }}
          onChange={(e) => update(withStyleKey(p, id, 'fontPct', clampFontPct(Number(e.target.value))))} />
        <NumInput value={fontPct} clampFn={clampFontPct} label={tr('حجم الخط')} suffix="%" width={56}
          onCommit={(v) => update(withStyleKey(p, id, 'fontPct', v))} />
      </div>
      <div className={row}>
        <span className={lab}>{tr('المسافة قبله')}</span>
        <NumInput value={before} clampFn={clampSpaceMm} label={tr('المسافة قبله')} suffix="mm"
          onCommit={(v) => update(withStyleKey(p, id, 'spaceBeforeMm', v))} />
        <span className="text-[11px] text-[#6E6557]">{tr('بعده')}</span>
        <NumInput value={after} clampFn={clampSpaceMm} label={tr('المسافة بعده')} suffix="mm"
          onCommit={(v) => update(withStyleKey(p, id, 'spaceAfterMm', v))} />
      </div>
      <div className={row}>
        <button type="button" disabled={empty} onClick={() => update(withSectionStyle(p, id, null))}
          className="inline-flex items-center gap-1 text-[11px] text-[#6E6557] hover:text-[#C94E28] disabled:opacity-40">
          <RotateCcw className="w-3 h-3" aria-hidden="true" />{tr('تنسيق القسم الافتراضي')}
        </button>
      </div>
    </div>
  );
}

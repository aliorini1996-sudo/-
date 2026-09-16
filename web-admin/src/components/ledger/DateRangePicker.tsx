import { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import { useTr } from '../../i18n/strings';
import { useDir } from '../../i18n/lang';
import { activeLocale, formatDayOnly } from '../../utils/format';

/**
 * منتقي فترة الدفاتر (§8.3): فترات جاهزة وأسهم تزيح الفترة بطولها، وتقويم يبدأ أسبوعه حسب
 * `weekStartsOn` (GlSettings، 0 = الأحد)، وتكبير إلى الشهور، وتعطيل ما قبل `minDate`.
 * التواريخ نصوص `YYYY-MM-DD` محلية بلا مناطق زمنية (الحساب على UTC خالص).
 */

export interface DateRange { from: string; to: string }

type Preset = 'thisMonth' | 'lastMonth' | 'thisQuarter' | 'lastQuarter' | 'thisYear' | 'lastYear';

const pad = (n: number) => String(n).padStart(2, '0');
const iso = (y: number, m: number, d: number) => { const t = new Date(Date.UTC(y, m, d)); return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`; };
const parts = (s: string) => { const [y, m, d] = s.split('-').map(Number); return { y, m: m - 1, d }; };
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

/** السنة المالية التي تحوي `date` بنهاية `endMonth/endDay` (1-12). */
export function fiscalYearOf(date: string, endMonth = 12, endDay = 31): DateRange {
  const { y } = parts(date);
  const endThis = iso(y, endMonth - 1, Math.min(endDay, lastDay(y, endMonth - 1)));
  const endY = date <= endThis ? y : y + 1;
  const to = iso(endY, endMonth - 1, Math.min(endDay, lastDay(endY, endMonth - 1)));
  const { y: ty, m: tm, d: td } = parts(to);
  return { from: iso(ty - 1, tm, td + 1), to };
}

export function presetRange(p: Preset, today: string, fy: { endMonth: number; endDay: number } = { endMonth: 12, endDay: 31 }): DateRange {
  const { y, m } = parts(today);
  switch (p) {
    case 'thisMonth': return { from: iso(y, m, 1), to: iso(y, m, lastDay(y, m)) };
    case 'lastMonth': return { from: iso(y, m - 1, 1), to: iso(y, m, 0) };
    case 'thisQuarter': { const q = Math.floor(m / 3) * 3; return { from: iso(y, q, 1), to: iso(y, q + 3, 0) }; }
    case 'lastQuarter': { const q = Math.floor(m / 3) * 3 - 3; return { from: iso(y, q, 1), to: iso(y, q + 3, 0) }; }
    case 'thisYear': return fiscalYearOf(today, fy.endMonth, fy.endDay);
    case 'lastYear': { const cur = fiscalYearOf(today, fy.endMonth, fy.endDay); return fiscalYearOf(iso(parts(cur.from).y, parts(cur.from).m, parts(cur.from).d - 1), fy.endMonth, fy.endDay); }
  }
}

/** يزيح الفترة بطولها: شهر كامل ⇒ شهر، ربع ⇒ ربع، سنة ⇒ سنة، وإلا بعدد الأيام. */
export function shiftRange(r: DateRange, dirn: 1 | -1): DateRange {
  const a = parts(r.from); const b = parts(r.to);
  const wholeMonths = a.d === 1 && b.d === lastDay(b.y, b.m);
  if (wholeMonths) {
    const span = (b.y - a.y) * 12 + (b.m - a.m) + 1;
    const fy = a.y; const fm = a.m + dirn * span;
    return { from: iso(fy, fm, 1), to: iso(fy, fm + span, 0) };
  }
  const days = Math.round((Date.UTC(b.y, b.m, b.d) - Date.UTC(a.y, a.m, a.d)) / 86_400_000) + 1;
  return { from: iso(a.y, a.m, a.d + dirn * days), to: iso(b.y, b.m, b.d + dirn * days) };
}

export function todayLocal(timeZone = 'Asia/Riyadh'): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  } catch { return new Date().toISOString().slice(0, 10); }
}

export function DateRangePicker({ value, onChange, weekStartsOn = 0, minDate, maxDate, timezone, fiscalYearEnd, className = '' }: {
  value: DateRange;
  onChange: (r: DateRange) => void;
  /** 0 = الأحد … 6 = السبت (GlSettings.weekStartsOn) */
  weekStartsOn?: number;
  /** ما قبله معطّل (مثل cutoverDate) */
  minDate?: string | null;
  maxDate?: string | null;
  timezone?: string;
  fiscalYearEnd?: { endMonth: number; endDay: number };
  className?: string;
}) {
  const tr = useTr();
  const dir = useDir();
  const [open, setOpen] = useState(false);
  const [zoom, setZoom] = useState<'days' | 'months'>('days');
  const [cursor, setCursor] = useState(() => { const p = parts(value.from); return { y: p.y, m: p.m }; });
  const [pending, setPending] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const today = todayLocal(timezone);
  const locale = activeLocale();

  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) { setOpen(false); setPending(null); } };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);

  const clamp = (r: DateRange): DateRange => ({
    from: minDate && r.from < minDate ? minDate : r.from,
    to: maxDate && r.to > maxDate ? maxDate : r.to,
  });
  const apply = (r: DateRange) => { onChange(clamp(r)); setPending(null); };
  const disabled = (d: string) => (!!minDate && d < minDate) || (!!maxDate && d > maxDate);

  const presets: { key: Preset; label: string }[] = [
    { key: 'thisMonth', label: tr('هذا الشهر') },
    { key: 'lastMonth', label: tr('الشهر الماضي') },
    { key: 'thisQuarter', label: tr('هذا الربع') },
    { key: 'lastQuarter', label: tr('الربع الماضي') },
    { key: 'thisYear', label: tr('هذه السنة المالية') },
    { key: 'lastYear', label: tr('السنة المالية الماضية') },
  ];

  const weekdays = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(locale, { weekday: 'narrow', timeZone: 'UTC' });
    // 2023-01-01 أحد
    return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(Date.UTC(2023, 0, 1 + ((weekStartsOn + i) % 7)))));
  }, [locale, weekStartsOn]);

  const days = useMemo(() => {
    const first = new Date(Date.UTC(cursor.y, cursor.m, 1)).getUTCDay();
    const lead = (first - weekStartsOn + 7) % 7;
    const n = lastDay(cursor.y, cursor.m);
    return [...Array(lead).fill(null), ...Array.from({ length: n }, (_, i) => iso(cursor.y, cursor.m, i + 1))] as (string | null)[];
  }, [cursor, weekStartsOn]);

  const monthName = (y: number, m: number, style: 'long' | 'short' = 'long') =>
    new Intl.DateTimeFormat(locale, { month: style, year: style === 'long' ? 'numeric' : undefined, timeZone: 'UTC' }).format(new Date(Date.UTC(y, m, 1)));
  const dayNum = (d: string) => new Intl.NumberFormat(locale).format(parts(d).d);

  const pick = (d: string) => {
    if (!pending) { setPending(d); return; }
    apply(d < pending ? { from: d, to: pending } : { from: pending, to: d });
  };

  const Prev = dir === 'rtl' ? ChevronRight : ChevronLeft;
  const Next = dir === 'rtl' ? ChevronLeft : ChevronRight;
  const canPrev = !minDate || shiftRange(value, -1).to >= minDate;

  return (
    <div ref={ref} className={`relative inline-flex items-center gap-1 ${className}`}>
      <button type="button" className="p-1.5 rounded-lg hover:bg-[#F1EBDF] disabled:opacity-40" disabled={!canPrev} aria-label={tr('الفترة السابقة')} onClick={() => apply(shiftRange(value, -1))}><Prev size={16} /></button>
      <button type="button" className="inline-flex items-center gap-2 border border-[#E8E0D2] rounded-xl bg-white px-3 py-1.5 text-sm hover:border-[#E15A30]" onClick={() => setOpen(o => !o)}>
        <CalendarDays size={15} className="text-[#E15A30]" />
        <bdi>{formatDayOnly(value.from)}</bdi><span className="text-[#9A8F7E]">←</span><bdi>{formatDayOnly(value.to)}</bdi>
      </button>
      <button type="button" className="p-1.5 rounded-lg hover:bg-[#F1EBDF]" aria-label={tr('الفترة التالية')} onClick={() => apply(shiftRange(value, 1))}><Next size={16} /></button>

      {open && (
        <div className="absolute z-40 top-full mt-1 start-0 bg-white rounded-xl shadow-xl border border-[#E8E0D2] p-3 flex flex-col sm:flex-row gap-3 w-max max-w-[92vw]">
          <div className="flex sm:flex-col gap-1 flex-wrap sm:w-40">
            {presets.map(p => (
              <button key={p.key} type="button" className="text-start text-sm px-2 py-1 rounded hover:bg-[#FBF7F0]"
                onClick={() => { apply(presetRange(p.key, today, fiscalYearEnd)); setOpen(false); }}>{p.label}</button>
            ))}
          </div>
          <div className="w-64">
            <div className="flex items-center justify-between mb-2">
              <button type="button" className="p-1 rounded hover:bg-[#F1EBDF]" aria-label={tr('السابق')}
                onClick={() => setCursor(c => (zoom === 'days' ? { y: c.m === 0 ? c.y - 1 : c.y, m: (c.m + 11) % 12 } : { y: c.y - 1, m: c.m }))}><Prev size={15} /></button>
              <button type="button" className="text-sm font-semibold hover:text-[#E15A30]" onClick={() => setZoom(z => (z === 'days' ? 'months' : 'days'))}>
                {zoom === 'days' ? monthName(cursor.y, cursor.m) : new Intl.NumberFormat(locale, { useGrouping: false }).format(cursor.y)}
              </button>
              <button type="button" className="p-1 rounded hover:bg-[#F1EBDF]" aria-label={tr('التالي')}
                onClick={() => setCursor(c => (zoom === 'days' ? { y: c.m === 11 ? c.y + 1 : c.y, m: (c.m + 1) % 12 } : { y: c.y + 1, m: c.m }))}><Next size={15} /></button>
            </div>
            {zoom === 'months' ? (
              <div className="grid grid-cols-3 gap-1">
                {Array.from({ length: 12 }, (_, m) => {
                  const r = { from: iso(cursor.y, m, 1), to: iso(cursor.y, m, lastDay(cursor.y, m)) };
                  const off = disabled(r.to);
                  return (
                    <button key={m} type="button" disabled={off}
                      className="text-sm py-2 rounded hover:bg-[#FBEBE2] disabled:opacity-30 disabled:hover:bg-transparent"
                      onClick={() => { setCursor({ y: cursor.y, m }); setZoom('days'); apply(r); }}>{monthName(cursor.y, m, 'short')}</button>
                  );
                })}
              </div>
            ) : (
              <div className="grid grid-cols-7 gap-0.5 text-center">
                {weekdays.map((w, i) => <span key={i} className="text-[11px] text-[#9A8F7E] py-1">{w}</span>)}
                {days.map((d, i) => {
                  if (!d) return <span key={i} />;
                  const inRange = pending ? d === pending : d >= value.from && d <= value.to;
                  const edge = !pending && (d === value.from || d === value.to);
                  return (
                    <button key={d} type="button" disabled={disabled(d)} onClick={() => pick(d)}
                      className={`text-xs py-1.5 rounded ${edge || (pending && d === pending) ? 'bg-[#E15A30] text-white' : inRange ? 'bg-[#FBEBE2]' : 'hover:bg-[#FBF7F0]'} ${d === today ? 'font-bold' : ''} disabled:opacity-30`}>
                      {dayNum(d)}
                    </button>
                  );
                })}
              </div>
            )}
            {pending && <p className="text-[11px] text-[#9A8F7E] mt-2">{tr('اختر تاريخ النهاية')}</p>}
          </div>
        </div>
      )}
    </div>
  );
}

export default DateRangePicker;

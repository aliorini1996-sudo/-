import { useEffect, useRef, useState } from 'react';
import { Camera, ScanLine } from 'lucide-react';
import { useTr } from '../i18n/strings';
import { burstWindowMs, cleanScan, wedgeChar, WEDGE_DEFAULTS } from '../lib/laserScanner';

// حدود المستمع العام نفسها لقبول دفعةٍ بلا لاحقة: نافذة الدفعة (تأخّرٌ محتمل للقارئ) قبل الحكم بالسكون
const BURST_WIN = burstWindowMs(WEDGE_DEFAULTS.maxGapMs);

/** تفضيل الجهاز (لا الشركة): القارئ عتادُ هذا الجهاز — جهاز Sunmi لمندوبٍ وجوالٌ عاديٌّ لآخر في الشركة نفسها */
export const LASER_PREF_KEY = 'fs_laser_scanner';

export function readLaserPref(): boolean {
  try { return localStorage.getItem(LASER_PREF_KEY) === '1'; } catch { return false; }
}
export function writeLaserPref(on: boolean) {
  try { if (on) localStorage.setItem(LASER_PREF_KEY, '1'); else localStorage.removeItem(LASER_PREF_KEY); } catch { /* تخزينٌ محجوب: يبقى للجلسة */ }
}

/**
 * حقل «قارئ الليزر» في فاتورة المندوب — لمن فعّله على جهازه (طلب المالك ١١ نوفمبر ٢٠٢٦).
 *
 * لماذا حقلٌ مع أن المستمع العام (useLaserScanner) يلتقط القارئ بلا حقل: بعض الأجهزة اليدوية تكتب الكود في **الحقل المركَّز**
 * دفعةً واحدة (وضع «تعبئة مباشرة» في Sunmi/Urovo) لا مفتاحاً مفتاحاً — فبلا حقلٍ مركَّز لا يصل شيء. والحقل:
 * - `inputMode="none"`: لا تفتح لوحة مفاتيح الجوال (القارئ هو لوحة المفاتيح).
 * - يبقى مركَّزاً: إن غادر التركيزُ أيَّ عنصرٍ إلى غير حقل كتابة (نقرةٌ على صنف، اختيارٌ من القائمة المنسدلة) عاد إليه.
 * - يقبل الكود بـEnter أو Tab (قارئٌ يكتب مفتاحاً مفتاحاً)، أو دفعةً في حدثٍ واحد (تعبئة مباشرة، ٤ حروف فأكثر)، أو دفعةً سريعة
 *   سكنت بلا لاحقة (بحدود المستمع العام WEDGE_DEFAULTS).
 * - الكود من مواضع المفاتيح (wedgeChar) ما دام لكل حرفٍ موضع — فلا تفسده لغة لوحة المفاتيح — وإلا فنصّ الحقل.
 * - `data-laser-field`: المستمع العام يتجاهله فلا يُضاف الصنف مرّتين.
 */
export default function LaserScanField({ onScan, onUseCamera }: {
  onScan: (code: string) => void;
  /** الرجوع إلى الكاميرا: يطفئ التفضيل ويفتح ماسح الكاميرا */
  onUseCamera: () => void;
}) {
  const tr = useTr();
  const ref = useRef<HTMLInputElement>(null);
  const [val, setVal] = useState('');
  // أحدث onScan (مؤقّت السكون يُطلق بعد رسمٍ لاحق)
  const scanRef = useRef(onScan);
  scanRef.current = onScan;
  /* الكود بمواضع المفاتيح (تخطيط US كالمستمع العام): القارئ يرسل مواضع، ولغة لوحة الجهاز تكتب في الحقل غير ما قصد — «&é"» بالفرنسية
   * بدل «123»، وحروف Code128 عربيةً. null = حرفٌ وصل بلا موضع (تعبئةٌ مباشرة، أحداثٌ محقونة، لصق، Backspace) فنصّ الحقل هو المرجع */
  const phys = useRef<string | null>('');
  const keyed = useRef(false); // مفتاحٌ سبق تغيّر النص — نصٌّ بلا مفتاحٍ قبله (لصقٌ من القائمة، تعبئة) لا تعرفه المواضع
  // قارئٌ بلا لاحقة (بلا Enter/Tab): بداية الدفعة الجارية في النص وفي المواضع، وآخر لحظة كتابة، وجريها السريع (≤ maxGapMs) وأطوله
  const idleT = useRef<number | undefined>(undefined);
  const lastT = useRef(-Infinity);
  const burstFrom = useRef(0);
  const physFrom = useRef(0);
  const physLen = useRef(0);
  const run = useRef(0);
  const longest = useRef(0);

  const resetBuf = () => {
    window.clearTimeout(idleT.current);
    phys.current = '';
    keyed.current = false;
    lastT.current = -Infinity;
    burstFrom.current = 0; physFrom.current = 0; physLen.current = 0; run.current = 0; longest.current = 0;
  };
  const submit = (raw: string) => {
    resetBuf(); // مؤقّت السكون يُلغى: Enter بعده لا يُضيف الصنف مرّةً ثانية
    setVal('');
    const code = cleanScan(raw);
    if (code) scanRef.current(code);
  };

  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
    /* التركيز يعود للحقل متى غادر **أيَّ** عنصر لا الحقل وحده: اختيار صنفٍ من القائمة المنسدلة يُزيل زرّه المركَّز فيسقط التركيز
     * على الصفحة، وكذلك مغادرة بحثها أو رقم الفاتورة أو قائمة الفريق — وبلا حقلٍ مركَّز لا يصل مسح «التعبئة المباشرة» ولا يُرى ذلك */
    let t: number | undefined;
    const keepFocus = () => {
      window.clearTimeout(t);
      t = window.setTimeout(() => {
        const el = ref.current;
        const a = document.activeElement as HTMLElement | null;
        if (!el || !el.isConnected || a === el) return;
        // التركيز في حقل كتابةٍ آخر (كمية، بحث) أو قائمة يستعملها المندوب: يُترك له
        if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable)) return;
        el.focus({ preventScroll: true });
      }, 0);
    };
    document.addEventListener('focusout', keepFocus, true);
    return () => { document.removeEventListener('focusout', keepFocus, true); window.clearTimeout(t); window.clearTimeout(idleT.current); };
  }, []);

  return (
    <div className="mb-2 flex items-center gap-2 rounded-xl bg-[#1F1A13] text-white ps-3 pe-1.5 py-1.5">
      <ScanLine size={16} className="text-[#E15A30] shrink-0" />
      <input
        ref={ref}
        data-laser-field=""
        inputMode="none"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        enterKeyHint="done"
        dir="ltr"
        aria-label={tr('امسح الصنف بالقارئ')}
        placeholder={tr('امسح الصنف بالقارئ')}
        value={val}
        onChange={e => {
          const v = e.target.value;
          // تعبئةٌ مباشرة: الكود كاملاً في حدثٍ واحد — يُقبل فوراً (والقارئ الذي يرسل Enter بعده يجد الحقل فارغاً)
          if (v.length - val.length >= 4 && v.startsWith(val)) { submit(v.slice(val.length)); return; }
          if (!v) { resetBuf(); setVal(''); return; }
          if (!keyed.current) phys.current = null;
          keyed.current = false;
          const now = performance.now();
          /* فاصلٌ أطول من نافذة الدفعة يبدأ دفعةً جديدة: ما قبله كتابةٌ بطيئة لا تدخل في قبول السكون. وتعثّر القارئ داخل النافذة لا يقطعها —
           * الحقل يحمل نصّها كاملاً فلا ذيل يُقبل وحده */
          const gap = now - lastT.current;
          if (gap > BURST_WIN) { burstFrom.current = val.length; physFrom.current = physLen.current; run.current = 0; longest.current = 0; }
          run.current = gap > WEDGE_DEFAULTS.maxGapMs ? 1 : run.current + 1;
          longest.current = Math.max(longest.current, run.current);
          lastT.current = now;
          physLen.current = phys.current?.length ?? 0;
          setVal(v);
          window.clearTimeout(idleT.current);
          /* دفعةٌ سكنت بلا Enter/Tab: تُقبل إن بلغت idleMinLength وفيها جريٌ سريعٌ بطول minLength (قارئٌ لا إنسان) — كالمستمع العام،
           * فالكتابة باليد لا تُرسل كوداً ناقصاً. ونصٌّ بمسافات (مُوسِّع نصوص) ليس باركوداً */
          idleT.current = window.setTimeout(() => {
            const p = phys.current;
            const burst = p ? p.slice(physFrom.current) : v.slice(burstFrom.current);
            if (longest.current >= WEDGE_DEFAULTS.minLength && !/\s/.test(burst) && cleanScan(burst).length >= WEDGE_DEFAULTS.idleMinLength) submit(burst);
          }, BURST_WIN + 30);
        }}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); submit(phys.current || val); return; }
          if (e.key === 'Shift' || e.key === 'CapsLock') return;
          const n = e.nativeEvent;
          // حرف الموضع كما قصده القارئ — ومفتاحٌ بلا موضع أو بتحكّم أو غير حرفي (Backspace) يُسقط المواضع إلى نصّ الحقل
          const ch = n.code && !n.isComposing && !n.ctrlKey && !n.altKey && !n.metaKey ? wedgeChar(n) : null;
          phys.current = ch !== null && phys.current !== null ? phys.current + ch : null;
          keyed.current = true;
        }}
        className="flex-1 min-w-0 bg-transparent outline-none text-sm py-1.5 placeholder:text-white/50"
      />
      <button type="button" onClick={onUseCamera} title={tr('استخدم الكاميرا')}
        className="shrink-0 flex items-center gap-1 rounded-lg bg-white/10 px-2.5 py-1.5 text-[11px]">
        <Camera size={14} /> {tr('الكاميرا')}
      </button>
    </div>
  );
}

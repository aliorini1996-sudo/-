import { useCallback, useEffect, useRef, useState } from 'react';
import { Bluetooth, X } from 'lucide-react';
import { useTr } from '../../i18n/strings';
import type { DirectUi } from '../../rep/printDirect';

/**
 * الطباعة المباشرة بالبلوتوث في الواجهة — «إعدادات الطباعة» M3 (التصميم §5.2 «أثناء الطباعة»): غطاءٌ بنسبة التقدّم وزرّ
 * إلغاء. المرحلتان: التجهيز (رسم القالب نقاطاً — ثوانٍ على الجوال) ثم الإرسال (نسبة البايتات؛ صفحة MIP480 قد تأخذ دقيقة).
 * الإلغاء يكمل الأمر الجاري ثم يرسل أمر التهيئة (وFF للنقطية) — فلا رذاذ على الورق ولا ورقة عالقة.
 */
export interface DirectJobState { phase: 'prepare' | 'send'; pct: number }

export function pageLabelOf(tr: (s: string) => string): (n: number, m: number) => string {
  return (n, m) => tr('صفحة {n} من {m}').replace('{n}', String(n)).replace('{m}', String(m));
}

export function useDirectPrint() {
  const tr = useTr();
  const [job, setJob] = useState<DirectJobState | null>(null);
  const ctrl = useRef<AbortController | null>(null);
  const last = useRef('');
  useEffect(() => () => ctrl.current?.abort(), []);

  /** يشغّل مهمةً بالغطاء — والنتيجة 'cancelled' إن ألغاها المستخدم */
  const run = useCallback(async (fn: (ui: DirectUi) => Promise<'done' | 'cancelled'>, opts?: { slow?: boolean; lang?: 'tspl'; tsplFlip?: boolean }): Promise<'done' | 'cancelled'> => {
    const c = new AbortController();
    ctrl.current = c;
    last.current = '';
    setJob({ phase: 'prepare', pct: 0 });
    try {
      return await fn({
        signal: c.signal,
        slow: opts?.slow,
        lang: opts?.lang,
        tsplFlip: opts?.tsplFlip,
        pageLabel: pageLabelOf(tr),
        onProgress: (phase, f) => {
          const pct = Math.max(0, Math.min(100, Math.round(f * 100)));
          const key = `${phase}:${pct}`;
          if (key !== last.current) { last.current = key; setJob({ phase, pct }); }
        },
      });
    } finally {
      if (ctrl.current === c) ctrl.current = null;
      setJob(null);
    }
  }, [tr]);

  const cancel = useCallback(() => ctrl.current?.abort(), []);
  return { job, run, cancel };
}

export function DirectPrintOverlay({ job, onCancel }: { job: DirectJobState | null; onCancel: () => void }) {
  const tr = useTr();
  if (!job) return null;
  const sending = job.phase === 'send';
  return (
    <div className="fixed inset-0 z-[1300] bg-black/45 flex items-center justify-center p-6" role="alertdialog" aria-modal="true" aria-live="polite">
      <div className="bg-white rounded-3xl w-full max-w-sm p-5 text-center shadow-xl">
        <Bluetooth size={28} className="mx-auto text-[#E15A30]" />
        <p className="font-bold text-[#1F1A13] mt-2">{sending ? tr('جار الإرسال إلى الطابعة') : tr('جار تجهيز الطباعة')}</p>
        <div className="mt-4 h-2.5 rounded-full bg-[#F1EBDF] overflow-hidden" dir="ltr">
          <div className="h-full bg-[#E15A30] transition-[width] duration-200" style={{ width: `${sending ? job.pct : Math.max(4, job.pct)}%` }} />
        </div>
        <p className="text-sm text-[#6E6557] mt-2" dir="ltr">{job.pct}%</p>
        <button type="button" onClick={onCancel} className="mt-4 w-full bg-gray-100 text-gray-700 font-semibold py-2.5 rounded-xl flex items-center justify-center gap-2">
          <X size={16} /> {tr('إلغاء الطباعة')}
        </button>
      </div>
    </div>
  );
}

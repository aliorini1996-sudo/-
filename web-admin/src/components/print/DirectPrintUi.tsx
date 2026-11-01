import { useCallback, useEffect, useRef, useState } from 'react';
import { Bluetooth, Printer, X } from 'lucide-react';
import { useTr } from '../../i18n/strings';
import type { DirectOutcome, DirectUi } from '../../rep/printDirect';

/**
 * الطباعة المباشرة بالبلوتوث في الواجهة — «إعدادات الطباعة» M3 (التصميم §5.2 «أثناء الطباعة»): غطاءٌ بنسبة التقدّم وزرّ
 * إلغاء. المرحلتان: التجهيز (رسم القالب نقاطاً — ثوانٍ على الجوال) ثم الإرسال (نسبة البايتات؛ صفحة MIP480 قد تأخذ دقيقة).
 * الإلغاء يكمل الأمر الجاري ثم يرسل أمر التهيئة (وFF للنقطية) — فلا رذاذ على الورق ولا ورقة عالقة.
 *
 * مسار تطبيق فيلد سيلز (أندرويد بلا Web Serial): «الطباعة جاهزة» بزرّ «اطبع الآن» إن انقضت صلاحية اللمسة قبل فتح التطبيق
 * (tap)، ثم «جار الإرسال إلى الطابعة» بشريطٍ كامل بلا إلغاء (handoff) — التقدّم والإلغاء بعدها في شاشة التطبيق.
 */
export interface DirectJobState { phase: 'prepare' | 'send' | 'tap' | 'handoff'; pct: number; onTap?: () => void }

export function pageLabelOf(tr: (s: string) => string): (n: number, m: number) => string {
  return (n, m) => tr('صفحة {n} من {m}').replace('{n}', String(n)).replace('{m}', String(m));
}

export function useDirectPrint() {
  const tr = useTr();
  const [job, setJob] = useState<DirectJobState | null>(null);
  const ctrl = useRef<AbortController | null>(null);
  const last = useRef('');
  useEffect(() => () => ctrl.current?.abort(), []);

  /** يشغّل مهمةً بالغطاء — والنتيجة 'cancelled' إن ألغاها المستخدم، و'handed' إن سُلّمت للتطبيق بلا مفتاح */
  const run = useCallback(async (fn: (ui: DirectUi) => Promise<DirectOutcome>, opts?: { slow?: boolean; lang?: 'tspl'; tsplFlip?: boolean; label?: string }): Promise<DirectOutcome> => {
    const c = new AbortController();
    ctrl.current = c;
    last.current = '';
    setJob({ phase: 'prepare', pct: 0 });
    /** لمسةٌ ثانية تمنح إيماءةً حيّة — تُحلّ داخل النقرة نفسها، والإلغاء يرفضها */
    const requestTap = () => new Promise<void>((resolve, reject) => {
      if (c.signal.aborted) { reject(new Error('cancelled')); return; }
      const onAbort = () => reject(new Error('cancelled'));
      c.signal.addEventListener('abort', onAbort, { once: true });
      last.current = 'tap';
      setJob({ phase: 'tap', pct: 100, onTap: () => { c.signal.removeEventListener('abort', onAbort); resolve(); } });
    });
    try {
      return await fn({
        signal: c.signal,
        slow: opts?.slow,
        lang: opts?.lang,
        tsplFlip: opts?.tsplFlip,
        docLabel: opts?.label,
        requestTap,
        onHandoff: () => { last.current = 'handoff'; setJob({ phase: 'handoff', pct: 100 }); },
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
  if (job.phase === 'tap' || job.phase === 'handoff') {
    const tap = job.phase === 'tap';
    return (
      <div className="fixed inset-0 z-[1300] bg-black/45 flex items-center justify-center p-6" role="alertdialog" aria-modal="true" aria-live="polite">
        <div className="bg-white rounded-3xl w-full max-w-sm p-5 text-center shadow-xl">
          <Bluetooth size={28} className="mx-auto text-[#E15A30]" />
          <p className="font-bold text-[#1F1A13] mt-2">{tap ? tr('الطباعة جاهزة') : tr('جار الإرسال إلى الطابعة')}</p>
          {tap ? (
            <>
              <button type="button" onClick={job.onTap} className="mt-4 w-full bg-[#E15A30] hover:bg-[#C94E28] text-white font-semibold py-2.5 rounded-xl flex items-center justify-center gap-2">
                <Printer size={16} /> {tr('اطبع الآن')}
              </button>
              <button type="button" onClick={onCancel} className="mt-2 w-full bg-gray-100 text-gray-700 font-semibold py-2.5 rounded-xl flex items-center justify-center gap-2">
                <X size={16} /> {tr('إلغاء الطباعة')}
              </button>
            </>
          ) : (
            <div className="mt-4 h-2.5 rounded-full bg-[#F1EBDF] overflow-hidden" dir="ltr">
              <div className="h-full bg-[#E15A30] w-full" />
            </div>
          )}
        </div>
      </div>
    );
  }
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

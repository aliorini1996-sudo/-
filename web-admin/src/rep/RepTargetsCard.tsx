import { Check, Target, Trophy } from 'lucide-react';
import { useTr } from '../i18n/strings';
import { useLang } from '../i18n/lang';
import { activeLocale, formatCurrency, formatDate } from '../utils/format';
import {
  barPct, daysLeftText, monthLabel, pctText, rewardText, targetAmountText, targetRemaining, targetStateText, targetTitle,
  type RepTargetView, type RepTargetsData,
} from '../lib/repTargets';

const num = (n: number) => Number(n).toLocaleString(activeLocale(), { maximumFractionDigits: 4 });
const money = (n: number) => formatCurrency(n);

/**
 * «هدف الشهر» على رئيسية تطبيق المندوب (طلب المالك ٩ نوفمبر ٢٠٢٦: «يظهر بشكل دائم في الصفحة الرئيسية»). أهدافه التي وضعها
 * المدير هذا الشهر، لكلٍّ شريطه (مرجاني ثم أخضر عند التحقق) والمُنجَز من الهدف ونسبته والمتبقي، وسطر مكافأته.
 * الأرقام من الخادم (GET /rep-targets/mine)؛ و`stale` لحظة آخر نجاحٍ حين تُعرض نسخةٌ محفوظة بلا اتصال — فلا يُقرأ رقمٌ قديم
 * كأنه اللحظة، ومعها «تحديث» يعيد جلبها وحدها (`onRetry`) — فلا تبقى موسومةً حتى تُركَّب الرئيسية من جديد. ولا شيء يُرسم بلا أهداف.
 */
export default function RepTargetsCard({ data, stale, onRetry }: { data: RepTargetsData; stale: number | null; onRetry?: () => void }) {
  const tr = useTr();
  const lang = useLang(s => s.lang);
  if (!data.targets.length) return null;
  const days = data.isCurrent ? daysLeftText(data.daysLeft, lang, tr, num) : '';
  return (
    <div className="bg-white rounded-3xl p-5 border-2 border-[#F5DACE]">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs text-gray-500">{tr('هدف الشهر')}</p>
          <p className="text-lg font-extrabold text-[#1F1A13] mt-0.5">{monthLabel(data.month, activeLocale())}</p>
          {days && <p className="text-[11px] text-gray-400 mt-0.5">{days}</p>}
        </div>
        <div className="w-14 h-14 bg-[#FBEBE2] rounded-2xl flex items-center justify-center shrink-0">
          <Target size={26} className="text-[#E15A30]" />
        </div>
      </div>

      {stale !== null && (
        <div className="mt-3 text-[11px] bg-amber-50 border border-amber-200 text-amber-800 rounded-xl px-3 py-2 flex items-center justify-between gap-3">
          <span>{`${tr('أرقام غير محدثة آخر تحديث')} ${formatDate(new Date(stale).toISOString())}`}</span>
          {onRetry && <button type="button" onClick={onRetry} className="shrink-0 font-semibold underline">{tr('تحديث')}</button>}
        </div>
      )}

      <div className="mt-4 space-y-4">
        {data.targets.map((t, i) => <TargetBlock key={t.id} t={t} first={i === 0} />)}
      </div>
    </div>
  );
}

function TargetBlock({ t, first }: { t: RepTargetView; first: boolean }) {
  const tr = useTr();
  const p = t.progress;
  const stateText = targetStateText(p);
  return (
    <div className={first ? '' : 'pt-4 border-t border-[#F1EBDF]'}>
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-bold text-[#1F1A13] leading-snug break-words min-w-0">{targetTitle(t, tr, num)}</p>
        {!stateText && (
          <bdi className={`shrink-0 text-base font-extrabold ${p.done ? 'text-green-600' : 'text-[#E15A30]'}`}>{pctText(p.pct, activeLocale())}</bdi>
        )}
      </div>

      {stateText ? (
        <p className="mt-2 text-xs bg-amber-50 border border-amber-200 text-amber-800 rounded-xl px-3 py-2">{tr(stateText)}</p>
      ) : (
        <>
          <div className="mt-2 h-2.5 bg-[#F1EBDF] rounded-full overflow-hidden">
            <div className={`h-full rounded-full transition-all ${p.done ? 'bg-green-500' : 'bg-[#E15A30]'}`} style={{ width: `${barPct(p.pct)}%` }} />
          </div>
          <div className="mt-1.5 flex items-center justify-between gap-2 text-xs">
            <span className="text-[#1F1A13]">
              <bdi className="font-bold">{targetAmountText(t, p.achieved, money, num)}</bdi>
              <span className="text-gray-400"> / <bdi>{targetAmountText(t, p.goal, money, num)}</bdi></span>
            </span>
            {p.done ? (
              <span className="shrink-0 inline-flex items-center gap-1 text-[11px] font-bold text-green-700 bg-green-50 border border-green-200 rounded-full px-2 py-0.5">
                <Check size={12} /> {tr('تحقق الهدف')}
              </span>
            ) : (
              <span className="shrink-0 text-gray-500">
                {tr('متبقي {x}').replace('{x}', () => targetAmountText(t, targetRemaining(p), money, num))}
              </span>
            )}
          </div>
          {t.kind === 'COLLECTION_PCT' && p.base != null && (
            <p className="text-[11px] text-gray-400 mt-1">{tr('الديون المفتوحة بداية الشهر')}: <bdi>{formatCurrency(p.base)}</bdi></p>
          )}
        </>
      )}

      <p className={`mt-2 text-xs flex items-center gap-1.5 ${t.reward.earned ? 'text-green-700 font-semibold' : 'text-[#6E6557]'}`}>
        <Trophy size={14} className={`shrink-0 ${t.reward.earned ? 'text-green-600' : 'text-[#E15A30]'}`} />
        <span>{rewardText(t, tr, money, num)}</span>
      </p>
      {t.note && <p className="mt-1.5 text-[11px] text-gray-500 bg-[#FAF7F0] rounded-xl px-3 py-2 leading-relaxed whitespace-pre-line break-words">{t.note}</p>}
    </div>
  );
}

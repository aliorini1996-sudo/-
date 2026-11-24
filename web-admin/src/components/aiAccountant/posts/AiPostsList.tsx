import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ListChecks, RefreshCw, RotateCcw } from 'lucide-react';
import { aiAccountantApi } from '../../../api/client';
import { useTr } from '../../../i18n/strings';
import PostedMoveCard from './PostedMoveCard';
import { POSTS_LIMIT, POSTS_QUERY_KEY, normalizePostsResponse } from './aiPosts';

/**
 * تبويب «قيود المحاسب الذكي»: أحدث القيود التي رحّلها المحاسب لهذه الشركة (GET /ai-accountant/posts — الخادم يحصرها
 * بشركة الجلسة ويعيد قائمةً فارغة لمن لا يرى الدفاتر)، الأحدث أولاً، كلٌّ ببطاقته وزرّ «عكس القيد».
 *
 * المفتاح ['ai-accountant-posts'] مشترك: البطاقة تبطله بعد العكس، وغلاف المحادثة يبطله حين يُعكس قيدٌ من ردٍّ في المحادثة —
 * فتتحدّث حالة «معكوس» هنا من الخادم (GlMove.reversedMoveId) لا من تخمين الواجهة.
 */
export default function AiPostsList() {
  const tr = useTr();
  const q = useQuery({
    queryKey: POSTS_QUERY_KEY,
    queryFn: async () => normalizePostsResponse((await aiAccountantApi.posts(POSTS_LIMIT)).data?.data),
    staleTime: 30_000,
  });

  if (q.isPending) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-12 text-[#9A8F7E]" aria-busy>
        <span className="w-7 h-7 border-2 border-[#E9E1D3] border-t-[#E15A30] rounded-full animate-spin" />
        <p className="text-xs">{tr('جارٍ التحميل…')}</p>
      </div>
    );
  }

  if (q.isError) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-12 text-center px-4" role="alert">
        <AlertTriangle size={22} className="text-[#C94E28]" />
        <p className="text-sm text-[#6E6557]">{tr('تعذر تحميل البيانات')}</p>
        <button type="button" className="btn-secondary !text-xs !px-3 !py-1.5" onClick={() => void q.refetch()} disabled={q.isFetching}>
          <RotateCcw size={13} /> {tr('إعادة المحاولة')}
        </button>
      </div>
    );
  }

  const rows = q.data ?? [];

  if (rows.length === 0) {
    return (
      <div className="max-w-md mx-auto flex flex-col items-center text-center gap-2 py-12 px-4">
        <span className="w-12 h-12 rounded-2xl bg-[#F1EBDF] text-[#9A8F7E] flex items-center justify-center">
          <ListChecks size={22} />
        </span>
        <p className="text-sm font-semibold text-[#1F1A13]">{tr('لا توجد قيود سجّلها المحاسب الذكي بعد')}</p>
        <p className="text-xs text-[#6E6557] leading-relaxed">
          {tr('اطلب من المحاسب تسجيل مصروف أو رواتب وستظهر قيوده هنا، ويمكنك عكس أي قيد منها')}
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto space-y-3">
      <div className="flex items-center gap-2">
        <p className="text-xs text-[#6E6557] flex-1 min-w-0">{tr('القيود التي سجّلها المحاسب الذكي — الأحدث أولاً')}</p>
        <button
          type="button"
          onClick={() => void q.refetch()}
          disabled={q.isFetching}
          className="inline-flex items-center gap-1 text-xs text-[#6E6557] hover:text-[#E15A30] disabled:opacity-50"
        >
          <RefreshCw size={12} className={q.isFetching ? 'animate-spin' : ''} /> {tr('تحديث')}
        </button>
      </div>
      {rows.map((m) => <PostedMoveCard key={m.moveId} move={m} />)}
      {rows.length >= POSTS_LIMIT && (
        <p className="text-[11px] text-[#9A8F7E] text-center pt-1">
          {tr('تُعرض أحدث {n} قيداً — الأقدم تجده في قيود اليومية بالبحث عن مرجعه').replace('{n}', String(POSTS_LIMIT))}
        </p>
      )}
    </div>
  );
}

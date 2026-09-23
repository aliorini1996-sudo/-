import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { Plus, X } from 'lucide-react';
import { useTr } from '../../../i18n/strings';
import { useLang } from '../../../i18n/lang';
import { ledgerName } from '../../../lib/ledger/format';
import { ledgerErrorMessage } from '../../../lib/ledger/errors';
import { AccountPickerDialog } from '../../../components/ledger/AccountPickerDialog';
import { ledgerErrorOf, type GlAccount } from '../../../api/ledgerConfig';
import { ledgerReportsApi, type ReportResponse } from '../../../api/ledgerReports';
import ReportView, { type ReportRenderContext, type ReportTable } from './ReportView';
import {
  parseReportOptions, reportQueryParams, reportSearchString, todayInTimezone, type ReportOptionsState,
} from './reportOptions';
import {
  chunkOfSection, generalLedgerTable, ledgerSectionsWithMore,
  type GeneralLedgerResponse, type GeneralLedgerSectionJson, type GeneralLedgerTotalsJson,
  type LedgerPageChunk,
} from './reportRows';

/**
 * **دفتر الأستاذ العام** (M4، DESIGN.md §7.5 ORPT‑02) فوق القشرة المشتركة `ReportView`.
 *
 * لكل حساب قسمٌ قابل للطيّ: صفّ **رصيد افتتاحي** (بقاعدة الافتتاح في الميزان §7.2)، ثم سطوره
 * بأعمدة §7.5 (التاريخ · الرقم · الدفتر · الشريك · المندوب · البيان · مدين · دائن · **رصيد جارٍ**)،
 * ثم بنود الإقفال المفصولة إن وُجدت، ثم الإجمالي. ومن **كل سطر رابطٌ إلى قيده**.
 *
 * **الترقيم والتحميل عند الطلب (§7.1):** الخادم يقرأ 500 سطر لكل حساب ويعيد مع كل قسم مؤشّر
 * `nextCursor`؛ زرّ «تحميل المزيد» يطلب **صفحة ذلك الحساب وحده** بالخيارات نفسها + `cursor`،
 * وتُضمّ الصفحة إلى ما قبلها في `reportRows.ts` الصرفة، وتبدأ بصفّ **«رصيد مُرحَّل»** = الرصيد
 * الجاري قبل أول سطر فيها. فلا يُجلب سطرٌ زائد عمّا يُعرض على قاعدة 0.1 CPU.
 *
 * **الصفحات المحمَّلة مربوطة بتوقيع الخيارات** (`reportSearchString`): أيّ تغيير في الفترة أو
 * الفلاتر يُبطلها فوراً — وإلا خلطت صفحةٌ من مدى سابق سطورها بمدى جديد (والخادم نفسه يرفض
 * مؤشّراً من نطاق آخر بـ400 صريح).
 *
 * **اختيار الحساب** بالمنتقي القائم `AccountPickerDialog` (بحثٌ بالخادم بكل اللغات والمرادفات،
 * لا يُكرَّر هنا)، والاختيار يعيش في عنوان الصفحة تحت `account` — وهو المعامل الذي يكتبه رابط
 * التعمّق القادم من التقارير الأخرى، فيُقرأ منه مباشرةً.
 */

type GlResponse = ReportResponse<GeneralLedgerSectionJson, GeneralLedgerTotalsJson>;

/** الصفحات المحمَّلة ومعها توقيع الخيارات التي حُمِّلت تحته. */
interface LoadedPages {
  sig: string;
  chunks: LedgerPageChunk[];
}

export default function GeneralLedgerPage() {
  const tr = useTr();
  const lang = useLang(s => s.lang);
  const [sp, setSp] = useSearchParams();
  const [loaded, setLoaded] = useState<LoadedPages>({ sig: '', chunks: [] });
  const [names, setNames] = useState<Record<string, string>>({});
  const [picker, setPicker] = useState(false);

  const spString = sp.toString();
  const state = useMemo(
    () => parseReportOptions(spString, { reportKey: 'general-ledger', today: todayInTimezone() }),
    [spString],
  );
  const accounts = state.accounts;

  /** فلتر الحسابات في العنوان تحت `account` (عقد التعمّق)، فيبقى الرابط قابلاً للمشاركة. */
  const setAccounts = useCallback((ids: readonly string[]) => {
    const next = new URLSearchParams(sp);
    next.delete('accounts');
    if (ids.length > 0) next.set('account', ids.join(','));
    else next.delete('account');
    setSp(next, { replace: true });
  }, [sp, setSp]);

  const chunksFor = useCallback(
    (s: ReportOptionsState) => (loaded.sig === reportSearchString(s) ? loaded.chunks : []),
    [loaded],
  );

  const toTable = useCallback(
    (data: GlResponse, ctx: ReportRenderContext): ReportTable =>
      generalLedgerTable(data as GeneralLedgerResponse, ctx, chunksFor(ctx.state)),
    [chunksFor],
  );

  const onLoaded = useCallback((sig: string, chunk: LedgerPageChunk) => {
    setLoaded(prev => ({ sig, chunks: [...(prev.sig === sig ? prev.chunks : []), chunk] }));
  }, []);

  /** الأسماء تُدمج ولا تُستبدل: حسابٌ اختاره المستخدم ولا حركة له يبقى باسمه لا بمعرّفه. */
  const mergeNames = useCallback((next: Record<string, string>) => {
    setNames(prev => ({ ...prev, ...next }));
  }, []);

  const below = useCallback(
    (data: GlResponse, ctx: ReportRenderContext) => (
      <LedgerPagingBar
        data={data as GeneralLedgerResponse}
        state={ctx.state}
        chunks={chunksFor(ctx.state)}
        onLoaded={onLoaded}
        onNames={mergeNames}
      />
    ),
    [chunksFor, onLoaded, mergeNames],
  );

  const addAccount = (a: GlAccount) => {
    setPicker(false);
    setNames(n => ({ ...n, [a.id]: `${a.code} ${ledgerName(a, lang)}` }));
    if (!accounts.includes(a.id)) setAccounts([...accounts, a.id]);
  };

  const extraControls = (
    <span className="flex flex-wrap items-center gap-1.5">
      <span className="text-xs text-[#6E6557]">{tr('الحسابات')}:</span>
      {accounts.length === 0 && <span className="text-xs text-[#9A8F7E]">{tr('كل الحسابات')}</span>}
      {accounts.map(id => (
        <span key={id} className="inline-flex items-center gap-1 rounded-lg border border-[#E8E0D2] bg-white px-2 py-1 text-xs">
          <bdi>{names[id] ?? id}</bdi>
          <button
            type="button"
            aria-label={tr('إزالة الحساب من الفلتر')}
            className="text-[#9A8F7E] hover:text-[#C0392B]"
            onClick={() => setAccounts(accounts.filter(x => x !== id))}
          >
            <X size={12} />
          </button>
        </span>
      ))}
      <button
        type="button"
        className="inline-flex items-center gap-1 h-8 px-2.5 rounded-lg border border-[#E8E0D2] bg-white text-xs text-[#1F1A13] hover:bg-[#FBF7F0]"
        onClick={() => setPicker(true)}
      >
        <Plus size={13} />{tr('إضافة حساب')}
      </button>
    </span>
  );

  return (
    <>
      <ReportView<GeneralLedgerSectionJson, GeneralLedgerTotalsJson>
        reportKey="general-ledger"
        title={tr('دفتر الأستاذ العام')}
        subtitle={tr('سطور كل حساب برصيد جارٍ')}
        toTable={toTable}
        below={below}
        extraControls={extraControls}
      />
      {picker && <AccountPickerDialog onPick={addAccount} onClose={() => setPicker(false)} />}
    </>
  );
}

/**
 * شريط الترقيم (§7.1): «عُرض ٥٠٠ من ١٢٤٠» لكل حساب بقي فيه سطور، وزرّ يحمّل صفحته التالية
 * بالمؤشّر. الطلب يمرّ بالخيارات نفسها (‏`reportQueryParams`) فيطابق نطاق المؤشّر في الخادم،
 * ويعيد **قسم ذلك الحساب وحده** فتُضمّ صفحته بلا إعادة قراءة ما قُرئ.
 */
function LedgerPagingBar({ data, state, chunks, onLoaded, onNames }: {
  data: GeneralLedgerResponse;
  state: ReportOptionsState;
  chunks: readonly LedgerPageChunk[];
  onLoaded: (sig: string, chunk: LedgerPageChunk) => void;
  onNames: (next: Record<string, string>) => void;
}) {
  const tr = useTr();
  const lang = useLang(s => s.lang);
  const sig = reportSearchString(state);
  const sections = data.rows ?? [];

  // أسماء الحسابات المفلتَر بها تأتي من الردّ، فلا يبقى في الشريط معرّفٌ خام بعد التعمّق
  useEffect(() => {
    if (sections.length === 0) return;
    onNames(Object.fromEntries(sections.map(s => [s.account.id, `${s.account.code} ${ledgerName(s.account, lang)}`])));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, lang]);

  const more = useMutation({
    mutationFn: async (cursor: string) => (
      await ledgerReportsApi.get<GeneralLedgerSectionJson, GeneralLedgerTotalsJson>(
        'general-ledger',
        reportQueryParams(state, { cursor }),
      )
    ).data.data,
    onSuccess: (next) => {
      const section = next.rows[0];
      if (section) onLoaded(sig, chunkOfSection(section));
    },
  });

  const pending = ledgerSectionsWithMore(sections, chunks);
  if (pending.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-[#E8E0D2] bg-[#FBF7F0] p-2 text-xs">
      <span className="text-[#6E6557]">{tr('سطور لم تُعرض بعد')}:</span>
      {pending.map(({ section, view }) => (
        <button
          key={section.account.id}
          type="button"
          className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg border border-[#E8E0D2] bg-white text-[#1F1A13] hover:bg-[#FBF7F0] disabled:opacity-40"
          disabled={more.isPending}
          onClick={() => { if (view.nextCursor) more.mutate(view.nextCursor); }}
        >
          <bdi className="font-mono text-[11px] text-[#9A8F7E]">{section.account.code}</bdi>
          <span>{tr('تحميل المزيد')}</span>
          <bdi className="tabular-nums text-[#9A8F7E]">{view.loadedCount} / {view.lineCount}</bdi>
        </button>
      ))}
      {more.isError && <span className="text-[#C0392B]">{ledgerErrorMessage(tr, ledgerErrorOf(more.error))}</span>}
    </div>
  );
}

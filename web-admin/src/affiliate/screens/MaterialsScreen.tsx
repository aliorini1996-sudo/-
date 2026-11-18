// ============================================================================
// «المواد التسويقية» (V2_SPEC §6.1 و§7) — مكتبةٌ يرفعها المالك: صور وفيديو قصير ومستندات
// (تُنزَّل أو تُشارك بقائمة الجوال)، ونصوصٌ جاهزة (تُنسخ)، وروابط (تُفتح). تصفيةٌ بالفئة.
// الملف يُجلب عند الطلب فقط (GET /materials/:id/file) — لا تحميل مسبق لكل المكتبة على الجوال.
// الرابط يُفتح إن كان http(s) وحده، والنصّ يُعرض نصّاً (لا HTML). ما يظهر يُقرَّر من بيانات المادّة
// (../materials): فيديو الرابط رابطٌ يُفتح، والتعليق المرافق لأيّ فئةٍ يُنسخ.
// ============================================================================
import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { BookOpen, ChevronDown, Download, ExternalLink, FileText, Film, Image, Link2, PlayCircle, Share2, Type, type LucideIcon } from 'lucide-react';
import { affiliateApi, qk } from '../api';
import { errorText } from '../errors';
import { canShareFile, dataUrlToFile, downloadDataUrl, safeFileName } from '../files';
import { formatBytes, formatDay } from '../format';
import { useAxT, type AxKey } from '../i18n';
import { MATERIAL_CATEGORY, MATERIAL_CATEGORY_ORDER, textOf } from '../labels';
import { materialParts } from '../materials';
import type { MaterialCategory, MaterialRow, MeResponse } from '../types';
import { Chips, CopyButton, Empty, ErrorBox, Loading, SectionTitle, Spinner } from '../ui';
import { useAxQuery } from '../useAx';

interface TabProps { me: MeResponse; refreshMe: () => void }

const CAT_ICON: Record<MaterialCategory, LucideIcon> = { image: Image, video: Film, document: FileText, text: Type, link: Link2 };

type Filter = MaterialCategory | 'all';

function FileActions({ m }: { m: MaterialRow }) {
  const { t, lang } = useAxT();
  const name = safeFileName(m.fileName, `${m.title || 'field-sales'}`);
  const fetchFile = useMutation({
    mutationFn: (mode: 'download' | 'share') => affiliateApi.materialFile(m.id).then((r) => ({ r, mode })),
    onSuccess: async ({ r, mode }) => {
      const dataUrl = r?.dataUrl || '';
      if (mode === 'share') {
        const file = dataUrlToFile(dataUrl, name);
        if (file && canShareFile(file)) {
          try { await navigator.share({ files: [file], title: m.title }); return; } catch (e) {
            if ((e as { name?: string })?.name === 'AbortError') return;
          }
        }
      }
      if (!downloadDataUrl(dataUrl, name)) toast.error(t('mat.downloadFailed'));
    },
    onError: (err) => toast.error(errorText(err, lang, 'mat.downloadFailed')),
  });
  const nav = typeof navigator !== 'undefined' ? (navigator as Navigator & { canShare?: unknown }) : undefined;
  const shareable = !!nav && typeof nav.share === 'function' && typeof nav.canShare === 'function';
  const busy = fetchFile.isPending;
  return (
    <div className="flex gap-2">
      <button type="button" disabled={busy} onClick={() => fetchFile.mutate('download')} className="btn-primary flex-1 justify-center py-2 disabled:opacity-60">
        {busy && fetchFile.variables === 'download' ? <Spinner size={16} /> : <Download size={15} />} {t('mat.download')}
      </button>
      {shareable && (
        <button type="button" disabled={busy} onClick={() => fetchFile.mutate('share')} className="btn-secondary flex-1 justify-center py-2 disabled:opacity-60">
          {busy && fetchFile.variables === 'share' ? <Spinner size={16} /> : <Share2 size={15} />} {t('mat.share')}
        </button>
      )}
    </div>
  );
}

function MaterialCard({ m }: { m: MaterialRow }) {
  const { t, lang } = useAxT();
  const Icon = CAT_ICON[m.category] ?? FileText;
  // من بيانات المادّة لا فئتها وحدها (../materials): فيديو الرابط يُفتح ولا «تنزيل» يرتدّ بـ404،
  // والتعليق المرافق لأيّ فئةٍ يُعرض ويُنسخ.
  const { file, url, text, textIsMain } = materialParts(m);
  return (
    <div className="bg-white rounded-2xl border border-[#E9E1D3] p-3.5 space-y-2.5">
      <div className="flex items-start gap-3">
        <span className="w-10 h-10 rounded-xl bg-[#FBEBE2] text-[#E15A30] flex items-center justify-center shrink-0"><Icon size={19} /></span>
        <div className="min-w-0 flex-1">
          <p className="font-bold text-[14px] text-[#1F1A13] break-words" dir="auto">{m.title}</p>
          <p className="text-[11.5px] text-[#8A8072] mt-0.5">
            {textOf(MATERIAL_CATEGORY, m.category, lang)} · {formatDay(m.createdAt, lang)}
            {file && m.sizeBytes ? <> · <bdi dir="ltr">{formatBytes(m.sizeBytes)}</bdi></> : null}
          </p>
        </div>
      </div>
      {text && (
        <>
          <p className={`rounded-xl bg-[#FAF7F0] border border-[#E9E1D3] px-3 py-2.5 text-[13px] text-[#1F1A13] leading-relaxed overflow-y-auto ${textIsMain ? 'max-h-48' : 'max-h-32'}`} dir="auto" style={{ whiteSpace: 'pre-wrap' }}>
            {text}
          </p>
          {/* «نصّ» ⇒ النسخ هو الإجراء الرئيس؛ والتعليق المرافق لملفٍّ أو رابط ⇒ زرٌّ ثانويّ */}
          <CopyButton text={text} label={t('mat.copyText')} primary={textIsMain} className="w-full py-2" />
        </>
      )}
      {url && (
        <div className="flex gap-2">
          <a href={url} target="_blank" rel="noopener noreferrer" className="btn-primary flex-1 justify-center py-2">
            <ExternalLink size={15} /> {t('mat.open')}
          </a>
          <CopyButton text={url} label={t('mat.copyLink')} className="flex-1 py-2" />
        </div>
      )}
      {file && <FileActions m={m} />}
    </div>
  );
}

/** أقسام «اعرف النظام» بترتيبها — العنوان والنصّ من القاموس (السطر الجديد = نقطة) */
export const GUIDE_SECTIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;
/** صفحة الفيديوهات التعليمية (TutorialPage في App.tsx) — آخر «اعرف النظام» */
export const TUTORIAL_PATH = '/tutorial';

/**
 * «اعرف النظام» (طلب المالك ١٨ نوفمبر ٢٠٢٦): شرح المنصة داخل «المواد التسويقية» ليفهمها السفير قبل الترويج لها،
 * وفي آخره رابط صفحة الفيديوهات التعليمية. القسم الأول مفتوح والباقي يُفتح بالنقر — مريحٌ على الجوال.
 */
export function SystemGuide() {
  const { t } = useAxT();
  return (
    <section aria-labelledby="ax-guide-title" className="space-y-2.5">
      <div className="flex items-center gap-2">
        <BookOpen size={19} className="text-[#E15A30] shrink-0" />
        <h2 id="ax-guide-title" className="text-[16px] font-bold text-[#1F1A13]">{t('guide.title')}</h2>
      </div>
      <p className="text-[13px] text-[#6E6557] leading-relaxed">{t('guide.intro')}</p>
      {GUIDE_SECTIONS.map((n, i) => (
        <details key={n} className="group bg-white rounded-2xl border border-[#E9E1D3] open:border-[#E15A30]/40" open={i === 0}>
          <summary className="flex items-center justify-between gap-3 cursor-pointer list-none px-4 py-3.5 text-[14px] font-bold text-[#1F1A13] [&::-webkit-details-marker]:hidden">
            <span>{t(`guide.s${n}.t` as AxKey)}</span>
            <ChevronDown size={18} className="shrink-0 text-[#8A8072] transition-transform group-open:rotate-180" />
          </summary>
          <ul className="px-4 pb-4 -mt-1 space-y-1.5 list-disc ps-8 text-[13px] text-[#44403a] leading-7">
            {t(`guide.s${n}.b` as AxKey).split(/\n/).map((line) => <li key={line}>{line}</li>)}
          </ul>
        </details>
      ))}
      <a
        href={TUTORIAL_PATH} target="_blank" rel="noopener noreferrer"
        className="flex items-center gap-3 rounded-2xl bg-[#1F1A13] text-[#FAF7F0] p-4 hover:brightness-110"
      >
        <PlayCircle size={30} className="text-[#E15A30] shrink-0" />
        <span className="flex-1 min-w-0">
          <span className="block text-[14px] font-bold">{t('guide.videos.t')}</span>
          <span className="block text-[12px] opacity-80 leading-relaxed">{t('guide.videos.d')}</span>
        </span>
        <span className="shrink-0 inline-flex items-center gap-1 text-[12px] font-bold text-[#F5A588]">
          {t('guide.videos.cta')} <ExternalLink size={14} />
        </span>
      </a>
    </section>
  );
}

export function MaterialsTab({ refreshMe }: TabProps) {
  const { t, lang } = useAxT();
  const q = useAxQuery(qk.materials, affiliateApi.materials, refreshMe);
  const [filter, setFilter] = useState<Filter>('all');
  const rows = (q.data ?? []).filter((m) => filter === 'all' || m.category === filter);
  // الفئات الظاهرة: ما فيه موادّ فعلاً (والكل دائماً)
  const present = new Set((q.data ?? []).map((m) => m.category));
  const options: Array<{ value: Filter; label: string }> = [
    { value: 'all', label: t('mat.all') },
    ...MATERIAL_CATEGORY_ORDER.filter((c) => present.has(c)).map((c) => ({ value: c as Filter, label: textOf(MATERIAL_CATEGORY, c, lang) })),
  ];

  return (
    <div className="space-y-4">
      <SystemGuide />
      <div className="pt-2">
        <SectionTitle>{t('tab.materials')}</SectionTitle>
        <p className="text-[13px] text-[#6E6557] leading-relaxed -mt-1">{t('mat.intro')}</p>
      </div>
      {q.isLoading ? <Loading /> : q.isError || !q.data ? (
        <ErrorBox err={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <>
          {options.length > 2 && <Chips<Filter> value={filter} options={options} onChange={setFilter} label={t('tab.materials')} />}
          {rows.length === 0 ? (
            <Empty title={t('mat.empty')} hint={t('mat.emptyHint')} />
          ) : (
            <div className="grid sm:grid-cols-2 gap-2.5">
              {rows.map((m) => <MaterialCard key={m.id} m={m} />)}
            </div>
          )}
        </>
      )}
    </div>
  );
}

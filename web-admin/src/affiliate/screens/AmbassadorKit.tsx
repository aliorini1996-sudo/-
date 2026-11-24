// ============================================================================
// «حقيبة السفير الجاهزة» (طلب المالك ١٩ نوفمبر ٢٠٢٦): صور ومنشورات وقصص ورسائل من فيلد سيلز داخل «المواد
// التسويقية». المحتوى في public/ambassador-kit/kit.json (لا في الشيفرة — يُحدَّث بلا تغيير البوابة)، و`{link}`
// في كل نصّ يُستبدل برابط السفير نفسه (me.link) فيُنسخ أو يُشارَك جاهزاً.
// ============================================================================
import { useQuery } from '@tanstack/react-query';
import { Download, ExternalLink, FileText, MessageCircle, PlayCircle, Share2, Sparkles } from 'lucide-react';
import { canShareFile } from '../files';
import { whatsappShareUrl } from '../format';
import { useAxT } from '../i18n';
import { CopyButton } from '../ui';

export const KIT_URL = '/ambassador-kit/kit.json';
type Localized = Record<string, string>;
export interface KitItem {
  id: string;
  kind: 'image' | 'document' | 'link' | 'text';
  file?: string;
  url?: string;
  format?: 'square' | 'story';
  title: Localized;
  caption?: Localized;
  text?: Localized;
}

/** نصّ اللغة: لغته إن وُجدت، وإلا العربية للعربي والإنجليزية لغيره */
export function pickLang(m: Localized | undefined, lang: string): string {
  if (!m) return '';
  return m[lang] ?? (lang === 'ar' ? m.ar : m.en) ?? m.ar ?? m.en ?? '';
}
/** `{link}` ← رابط السفير */
export const fillLink = (s: string, link: string) => s.split('{link}').join(link);

async function shareImage(file: string, text: string): Promise<void> {
  const nav = navigator as Navigator & { share?: (d: ShareData) => Promise<void> };
  try {
    const blob = await (await fetch(file)).blob();
    const f = new File([blob], file.split('/').pop() || 'fieldsales.png', { type: blob.type || 'image/png' });
    if (nav.share && canShareFile(f)) { await nav.share({ files: [f], text }); return; }
  } catch (e) {
    if ((e as { name?: string })?.name === 'AbortError') return;
  }
  window.open(whatsappShareUrl(text), '_blank', 'noopener,noreferrer');
}

const btn = 'inline-flex items-center justify-center gap-1.5 rounded-xl border border-[#E9E1D3] bg-white px-3 py-2 text-[12.5px] font-semibold text-[#1F1A13] hover:border-[#E15A30]/50';

export function AmbassadorKit({ link }: { link: string }) {
  const { t, lang } = useAxT();
  const q = useQuery({
    queryKey: ['ax-kit'],
    queryFn: async () => {
      const r = await fetch(KIT_URL, { cache: 'no-cache' });
      if (!r.ok) throw new Error(String(r.status));
      return (await r.json()) as { items: KitItem[] };
    },
    staleTime: 60 * 60_000,
    retry: 1,
  });
  const items = q.data?.items ?? [];
  if (!items.length) return null;
  const images = items.filter((i) => i.kind === 'image' && i.file);
  const docs = items.filter((i) => (i.kind === 'document' && i.file) || (i.kind === 'link' && i.url));
  const texts = items.filter((i) => i.kind === 'text' && i.text);
  const cap = (i: KitItem) => fillLink(pickLang(i.caption, lang), link);

  return (
    <section aria-labelledby="ax-kit-title" className="space-y-3">
      <div className="flex items-center gap-2">
        <Sparkles size={19} className="text-[#E15A30] shrink-0" />
        <h2 id="ax-kit-title" className="text-[16px] font-bold text-[#1F1A13]">{t('kit.title')}</h2>
      </div>
      <p className="text-[13px] text-[#6E6557] leading-relaxed -mt-1">{t('kit.intro')}</p>

      <h3 className="text-[13.5px] font-bold text-[#1F1A13] pt-1">{t('kit.images')}</h3>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
        {images.map((i) => (
          <div key={i.id} className="bg-white rounded-2xl border border-[#E9E1D3] overflow-hidden flex flex-col">
            <img src={i.file} alt={pickLang(i.title, lang)} loading="lazy" className={`w-full object-cover bg-[#F6F1E8] ${i.format === 'story' ? 'aspect-[9/16]' : 'aspect-square'}`} />
            <div className="p-2.5 space-y-2 flex-1 flex flex-col">
              <p className="text-[12.5px] font-bold text-[#1F1A13] leading-snug flex-1">{pickLang(i.title, lang)}</p>
              <div className="grid grid-cols-2 gap-1.5">
                <a href={i.file} download={`fieldsales-${i.id}.png`} className={btn}><Download size={14} /> {t('kit.download')}</a>
                <button type="button" onClick={() => void shareImage(i.file!, cap(i))} className={btn}><Share2 size={14} /> {t('kit.share')}</button>
              </div>
              {i.caption && <CopyButton text={cap(i)} label={t('kit.copyCaption')} className="w-full justify-center text-[12px]" />}
            </div>
          </div>
        ))}
      </div>

      {docs.length > 0 && <h3 className="text-[13.5px] font-bold text-[#1F1A13] pt-1">{t('kit.docs')}</h3>}
      {docs.map((i) => {
        const href = i.kind === 'link' ? i.url! : i.file!;
        const Icon = i.kind === 'link' ? PlayCircle : FileText;
        return (
          <div key={i.id} className="bg-white rounded-2xl border border-[#E9E1D3] p-3.5 flex flex-wrap items-center gap-2.5">
            <Icon size={22} className="text-[#E15A30] shrink-0" />
            <p className="flex-1 min-w-[10rem] text-[13.5px] font-bold text-[#1F1A13]">{pickLang(i.title, lang)}</p>
            <a href={href} target="_blank" rel="noopener noreferrer" className={btn}><ExternalLink size={14} /> {t('kit.open')}</a>
            {i.caption && <CopyButton text={cap(i)} label={t('kit.copyCaption')} className="text-[12px]" />}
          </div>
        );
      })}

      <h3 className="text-[13.5px] font-bold text-[#1F1A13] pt-1">{t('kit.texts')}</h3>
      {texts.map((i) => {
        const body = fillLink(pickLang(i.text, lang), link);
        return (
          <details key={i.id} className="group bg-white rounded-2xl border border-[#E9E1D3] open:border-[#E15A30]/40">
            <summary className="cursor-pointer list-none px-4 py-3.5 text-[13.5px] font-bold text-[#1F1A13] [&::-webkit-details-marker]:hidden">
              {pickLang(i.title, lang)}
            </summary>
            <div className="px-4 pb-4 space-y-2.5">
              <p dir="auto" className="whitespace-pre-wrap text-[13px] leading-7 text-[#44403a] bg-[#FAF7F0] rounded-xl p-3">{body}</p>
              <div className="flex flex-wrap gap-2">
                <CopyButton text={body} label={t('mat.copyText')} primary />
                <a href={whatsappShareUrl(body)} target="_blank" rel="noopener noreferrer" className={btn}><MessageCircle size={14} /> {t('kit.whatsapp')}</a>
              </div>
            </div>
          </details>
        );
      })}
    </section>
  );
}

import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { BrandIcon } from '../components/BrandLogo';
import { profileDeckApi } from '../api/client';
import { PROFILE_DECK, deckImg } from '../content/profileDeck';

/**
 * «بروفايل» — الملف التعريفي fieldsa.net/profile
 *
 * الصفحة تعرض **العرض التقديمي نفسه** كما صمّمه المالك، شريحةً شريحة، بلا أي
 * إعادة صياغة ولا إعادة تخطيط. والصور مصدَّرة من بوربوينت مباشرةً بدقّة
 * ٢٤٠٠×١٣٥٠ لكل شريحة، فما يراه الزائر هو ما يراه المالك في ملفّه حرفياً.
 *
 * ولماذا صور الشرائح لا إعادة بناء التصميم في HTML: إعادةُ البناء إعادةُ تفسير
 * — تنزلق ببكسلات، وتنكسر أسطرها على قياس آخر، وتحتاج مطابقةً يدوية بعد كل
 * تعديل في العرض. أمّا صورة الشريحة فهي ما يرسمه بوربوينت بخطوطه المضمَّنة،
 * فتبقى مطابقةً للأصل مهما تغيّرت الشاشة.
 *
 * ولئلا تكون الصفحة صامتة عند محرّكات البحث وعند من لا يرى: نصّ كل شريحة
 * مرافقٌ لها مقروءاً للآلة (`profileDeck.ts`) — بديلُ صورةٍ وصفيّ، ومحتوىً
 * مخفيّ بصرياً يفهرسه الزاحف ويتلوه قارئ الشاشة.
 *
 * تحديث العرض: صدّر شرائحه إلى `public/media/profile-deck/sNN.webp` وأعِد
 * توليد `content/profileDeck.ts` معها — الاثنان مصدرٌ واحد لا ينفصل.
 */

const COLORS = { coral: '#E15A30', ink: '#1F1A13', cream: '#FAF7F0' };
/** الملفّ المدمَج في البناء — يُستعمل حتى يرفع المالك ملفاً من لوحته */
const BUILTIN_PDF = '/fieldsales-profile.pdf';

interface Slide { seq: number; title: string; lines: string[]; src: string }

interface Manifest {
  slides: { seq: number; title: string; lines: string[]; v: number }[];
  file: { name: string; v: number } | null;
}

export default function ProfilePage() {
  useEffect(() => {
    document.title = 'بروفايل Field Sales';
  }, []);

  /**
   * ما رفعه المالك أولاً، والمدمَج في البناء احتياطاً.
   *
   * والسقوط للمدمَج ليس ترفاً: لو تعذّر الخادم أو خلا الجدول لظهرت الصفحة
   * فارغةً لزائرٍ قد يكون مستثمراً. فهي لا تُكسَر أبداً — أسوأ حالاتها أن تعرض
   * النسخة السابقة.
   */
  const { data: up } = useQuery({
    queryKey: ['profile-deck'],
    queryFn: async () => (await profileDeckApi.get()).data.data as Manifest,
    staleTime: 60_000,
    retry: 1,
  });

  const uploaded = (up?.slides?.length ?? 0) > 0;
  const slides: Slide[] = uploaded
    ? up!.slides.map(s => ({
      seq: s.seq, title: s.title || `شريحة ${s.seq}`, lines: s.lines,
      // بصمة النسخة في الرابط: يُخزَّن طويلاً ويتجدّد عند الرفع وحده
      src: `/api/profile-deck/slide/${s.seq}?v=${s.v}`,
    }))
    : PROFILE_DECK.map(s => ({ seq: s.n, title: s.title, lines: s.lines, src: deckImg(s.n) }));

  const pdfHref = up?.file ? `/api/profile-deck/file?v=${up.file.v}` : BUILTIN_PDF;
  const pdfName = up?.file?.name || 'بروفايل Field Sales.pdf';

  /**
   * السماح بالتكبير بالإصبعين في هذه الصفحة وحدها.
   *
   * الموقع يضبط `user-scalable=no` عالمياً (وهو صواب في التطبيقات: يمنع
   * التكبير العابر عند لمس حقلٍ مزدوجاً). لكن هذه الصفحة **شرائح عرض بمقاس
   * ١٦:٩**، وعلى شاشة عرضها ٣٧٥ بكسل تصير الشريحة ٢١١ بكسلاً ارتفاعاً، فنصّها
   * أصغر من أن يُقرأ — ومنعُ التكبير يحبس القارئ بلا مخرج.
   *
   * ويُعاد الإعداد الأصلي عند مغادرة الصفحة، فلا تتسرّب هذه الرخصة إلى بقية
   * التطبيق.
   */
  useEffect(() => {
    const tag = document.querySelector('meta[name="viewport"]');
    if (!tag) return;
    const before = tag.getAttribute('content');
    tag.setAttribute('content', 'width=device-width, initial-scale=1, maximum-scale=5, user-scalable=yes, viewport-fit=cover');
    return () => { if (before !== null) tag.setAttribute('content', before); };
  }, []);

  return (
    <div dir="rtl" style={{ background: COLORS.ink, fontFamily: "'IBM Plex Sans Arabic', system-ui, sans-serif" }}>
      {/* شريط رقيق: الهوية ورابط التنزيل — لا يزاحم الشرائح */}
      <header className="sticky top-0 z-20 backdrop-blur"
        style={{ background: 'rgba(31,26,19,.86)', borderBottom: '1px solid rgba(250,247,240,.10)' }}>
        <div className="max-w-[1400px] mx-auto px-4 py-2.5 flex items-center justify-between">
          <a href="/" className="flex items-center gap-2.5" aria-label="Field Sales">
            <BrandIcon size={28} />
            <span style={{ fontFamily: "'IBM Plex Serif', serif", fontWeight: 700, fontSize: 17 }}>
              <span style={{ color: COLORS.cream }}>Field</span>
              <span style={{ color: COLORS.coral }}> Sales</span>
            </span>
          </a>
          <a href={pdfHref} download={pdfName} title="تنزيل البروفايل PDF"
            className="px-3.5 py-1.5 rounded-xl text-sm font-bold inline-flex items-center gap-1.5"
            style={{ background: COLORS.coral, color: '#fff' }}>
            <Download size={14} />
            PDF
          </a>
        </div>
      </header>

      {/* على الجوال الشريحة العرضية تصير قصيرة، فنقول للقارئ كيف يقرؤها */}
      <p className="sm:hidden px-4 py-2.5 text-center" style={{ color: 'rgba(250,247,240,.6)', fontSize: 11.5 }}>
        كبر بإصبعين لقراءة الشريحة، أو نزل الملف من زر PDF
      </p>

      {/* الشرائح — كل واحدة بنسبة 16:9 ثابتة فلا تُقتطع ولا تُشوَّه على أي شاشة */}
      <main className="max-w-[1400px] mx-auto sm:px-4 sm:py-4 flex flex-col sm:gap-4">
        {slides.map(s => (
          <figure key={s.seq} className="m-0 relative sm:rounded-2xl overflow-hidden"
            style={{ aspectRatio: '16 / 9', background: COLORS.ink }}>
            <img
              src={s.src}
              alt={`${s.seq}. ${s.title}`}
              width={2400}
              height={1350}
              /* الأولى فوق الطيّة فتُحمَّل فوراً، والباقي عند الاقتراب */
              loading={s.seq === 1 ? 'eager' : 'lazy'}
              decoding="async"
              fetchPriority={s.seq === 1 ? 'high' : 'auto'}
              className="block w-full h-full object-contain select-none"
            />
            {/* نصّ الشريحة للزاحف وقارئ الشاشة — مخفيّ بصرياً لا بـdisplay:none */}
            <figcaption className="sr-only">
              <h2>{s.title}</h2>
              {s.lines.map((l, i) => <p key={i}>{l}</p>)}
            </figcaption>
          </figure>
        ))}
      </main>

      <footer className="max-w-[1400px] mx-auto px-4 py-8 text-center"
        style={{ color: 'rgba(250,247,240,.55)', fontSize: 13 }}>
        <a href={pdfHref} download={pdfName}
          className="font-bold" style={{ color: COLORS.coral }}>
          تنزيل الملف كاملا PDF
        </a>
        <span className="mx-2">·</span>
        <span>{slides.length} شريحة</span>
        <span className="mx-2">·</span>
        <a href="mailto:info@fieldsa.net" style={{ color: 'inherit' }}>info@fieldsa.net</a>
      </footer>
    </div>
  );
}

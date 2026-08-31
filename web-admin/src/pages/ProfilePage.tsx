import { useEffect } from 'react';
import { Download } from 'lucide-react';
import { BrandIcon } from '../components/BrandLogo';
import { PROFILE_DECK, DECK_COUNT, deckImg } from '../content/profileDeck';

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
const PROFILE_PDF = '/fieldsales-profile.pdf';

export default function ProfilePage() {
  useEffect(() => {
    document.title = 'بروفايل Field Sales';
  }, []);

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
          <a href={PROFILE_PDF} download="بروفايل Field Sales.pdf" title="تنزيل البروفايل PDF"
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
        {PROFILE_DECK.map(s => (
          <figure key={s.n} className="m-0 relative sm:rounded-2xl overflow-hidden"
            style={{ aspectRatio: '16 / 9', background: COLORS.ink }}>
            <img
              src={deckImg(s.n)}
              alt={`${s.n}. ${s.title}`}
              width={2400}
              height={1350}
              /* الأولى فوق الطيّة فتُحمَّل فوراً، والباقي عند الاقتراب */
              loading={s.n === 1 ? 'eager' : 'lazy'}
              decoding="async"
              fetchPriority={s.n === 1 ? 'high' : 'auto'}
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
        <a href={PROFILE_PDF} download="بروفايل Field Sales.pdf"
          className="font-bold" style={{ color: COLORS.coral }}>
          تنزيل الملف كاملا PDF
        </a>
        <span className="mx-2">·</span>
        <span>{DECK_COUNT} شريحة</span>
        <span className="mx-2">·</span>
        <a href="mailto:info@fieldsa.net" style={{ color: 'inherit' }}>info@fieldsa.net</a>
      </footer>
    </div>
  );
}

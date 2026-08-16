import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { BrandIcon } from '../components/BrandLogo';
import { ArrowLeft, PlayCircle, Clock } from 'lucide-react';

/**
 * دليل الاستخدام المرئيّ — fieldsa.net/tutorial
 * فيديو شرح شامل للوحة الإدارة (مونتاج من تسجيلات حقيقية) مع فهرس فصولٍ
 * ينقل المشاهد للدقيقة مباشرةً. الفيديو يُخدَم من أصول الموقع الثابتة /media.
 */

// فصول الفيديو (بالثواني) — من مونتاج 16 أغسطس 2026: مقدّمة + ٣ أقسام ببطاقات
const CHAPTERS: { t: number; label: string }[] = [
  { t: 7,    label: 'لوحة التحكم — مؤشرات اليوم والمبيعات' },
  { t: 197,  label: 'إدارة العملاء — الإضافة والتعديل وكشف الحساب' },
  { t: 258,  label: 'المنتجات — الأصناف والأسعار' },
  { t: 438,  label: 'المناديب — الصلاحيات واستلام التحصيل وكشف المندوب' },
  { t: 663,  label: 'مخزون سيارات المناديب — التحميل والإفراغ' },
  { t: 813,  label: 'التتبّع المباشر — الخريطة وخط السير والزيارات' },
  { t: 933,  label: 'الفواتير وسندات القبض' },
  { t: 1013, label: 'التقارير — المبيعات والمديونيات وأداء المناديب' },
  { t: 1233, label: 'مستخدمو الشركة والصلاحيات' },
  { t: 1333, label: 'الإعدادات واستيراد البيانات من نظامك السابق' },
];

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export default function TutorialPage() {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => { document.title = 'دليل استخدام المنصّة — Field Sales'; }, []);

  const seek = (t: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = t;
    v.play().catch(() => { /* المتصفح قد يمنع التشغيل التلقائي — يكفي الانتقال */ });
    v.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  return (
    <div dir="rtl" className="min-h-screen bg-[#FAF7F0]" style={{ fontFamily: "'IBM Plex Sans Arabic', sans-serif" }}>
      {/* الترويسة */}
      <header className="bg-white border-b border-[#E9E1D3]">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between">
          <Link to="/" className="flex items-center gap-2.5">
            <BrandIcon size={34} radius={0.28} />
            <span className="text-lg" style={{ fontFamily: "'IBM Plex Serif', serif", fontWeight: 700 }}>
              <span className="text-[#1F1A13]">Field</span><span className="text-[#E15A30]"> Sales</span>
            </span>
          </Link>
          <Link to="/" className="inline-flex items-center gap-1.5 text-sm font-semibold text-[#E15A30] hover:underline">
            تعرّف على المنصّة <ArrowLeft size={15} />
          </Link>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-8">
        <div className="text-center mb-6">
          <h1 className="text-2xl sm:text-3xl font-bold text-[#1F1A13]">دليل استخدام المنصّة</h1>
          <p className="text-[#6E6557] mt-2 text-sm sm:text-base">شرح شامل للوحة الإدارة خطوة بخطوة — من لوحة التحكم حتى استيراد بياناتك.</p>
        </div>

        {/* المشغّل */}
        <div className="rounded-2xl overflow-hidden shadow-lg border border-[#E9E1D3] bg-black">
          <video ref={videoRef} controls preload="metadata" playsInline className="w-full block" src="/media/tutorial.mp4" />
        </div>

        {/* فهرس الفصول */}
        <div className="mt-8 bg-white rounded-2xl border border-[#E9E1D3] overflow-hidden">
          <div className="px-5 py-3.5 border-b border-[#F1EBDF] flex items-center gap-2">
            <PlayCircle size={18} className="text-[#E15A30]" />
            <h2 className="font-bold text-[#1F1A13]">فهرس الفصول — انقر للانتقال</h2>
          </div>
          <ul className="divide-y divide-[#F6F1E8]">
            {CHAPTERS.map(c => (
              <li key={c.t}>
                <button onClick={() => seek(c.t)}
                  className="w-full flex items-center justify-between gap-3 px-5 py-3 text-right hover:bg-[#FAF7F0] transition-colors">
                  <span className="text-[14.5px] text-[#1F1A13]">{c.label}</span>
                  <span className="inline-flex items-center gap-1 text-[12px] font-semibold text-[#E15A30] tabular-nums shrink-0">
                    <Clock size={13} /> {fmt(c.t)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>

        {/* فيديو مستقلّ: تطبيق الإدارة على الجوال (عموديّ) */}
        <div className="mt-10">
          <div className="text-center mb-5">
            <h2 className="text-xl sm:text-2xl font-bold text-[#1F1A13]">تطبيق الإدارة على الجوال</h2>
            <p className="text-[#6E6557] mt-1.5 text-sm">لوحتك كاملةً من جيبك — جولة سريعة في تطبيق الجوال للإدارة.</p>
          </div>
          <div className="mx-auto rounded-2xl overflow-hidden shadow-lg border border-[#E9E1D3] bg-black" style={{ maxWidth: 360 }}>
            <video controls preload="metadata" playsInline className="w-full block" src="/media/tutorial-mobile.mp4" />
          </div>
        </div>

        <p className="text-center text-[12px] text-[#9A8F7E] mt-8">
          لديك سؤال بعد المشاهدة؟ راسلنا على <a href="mailto:help@fieldsa.net" className="text-[#E15A30] font-semibold">help@fieldsa.net</a>
        </p>
      </main>
    </div>
  );
}

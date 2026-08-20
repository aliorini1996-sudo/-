import { useState } from 'react';
import { Link, useParams, Navigate } from 'react-router-dom';
import { BrandIcon } from '../components/BrandLogo';
import { ArrowLeft, Download, MessageCircle, FileSpreadsheet } from 'lucide-react';
import LanguageToggle from '../components/LanguageToggle';
import { useLang, useDir } from '../i18n/lang';
import { useSeo } from '../lib/seo';
import { seoUrls, pathForLocale } from '../i18n/locale';
import { waHref } from '../components/WhatsAppFab';
import { TEMPLATES, templateBySlug, type TemplateSpec } from '../content/templates';

/**
 * بنك النماذج — تنزيل مباشر **بلا بوابة بريد ولا تسجيل**.
 *
 * النموذج يُبنى في المتصفّح لحظة النقر: لا ملفات مخزّنة على الخادم، ولا جداول
 * قاعدة بيانات، ولا تكلفة تشغيل. ومكتبة xlsx تُحمَّل ديناميكياً فلا تدخل الحزمة
 * الأولى — الصفحة تبقى خفيفة لمن يقرأ ولا ينزّل.
 */

/** يبني ورقة xlsx من مواصفة النموذج ويُنزّلها */
async function downloadTemplate(t: TemplateSpec) {
  const XLSX = await import('xlsx');
  const rows: (string | number)[][] = [
    [t.title],
    [t.purpose],
    [],
    t.columns,
    ...t.sample,
  ];
  // صفوف فارغة جاهزة للتعبئة — النموذج يُستخدم لا يُقرأ فقط
  for (let i = 0; i < 25; i++) rows.push(new Array(t.columns.length).fill(''));
  rows.push([]);
  rows.push(['ملاحظات']);
  for (const n of t.notes) rows.push([n]);
  rows.push([]);
  rows.push(['نموذج مجاني من Field Sales fieldsa net']);

  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = (t.widths || t.columns.map(() => 16)).map((w) => ({ wch: w }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'النموذج');
  // اتجاه الورقة من اليمين لليسار — بلا هذا تُفتح الأعمدة معكوسة بصرياً على العربي.
  // ⚠️ يجب أن يكون على **مستوى المصنّف**: `ws['!views'] = [{ RTL: true }]` على مستوى
  //    الورقة لا تكتبه هذه المكتبة إطلاقاً (تحقّقتُ من XML الناتج: صفر rightToLeft)
  //    فيبدو الكود سليماً ويخرج الملف LTR بصمت.
  wb.Workbook = { Views: [{ RTL: true }] };
  XLSX.writeFile(wb, `${t.slug}.xlsx`);
}

export default function TemplatesPage() {
  const { slug } = useParams();
  const lang = useLang((s) => s.lang);
  const dir = useDir();
  const tpl = slug ? templateBySlug(decodeURIComponent(slug)) : undefined;
  const [busy, setBusy] = useState<string | null>(null);

  const arPath = tpl ? `/نماذج/${tpl.slug}` : '/نماذج';
  const seo = seoUrls(arPath, lang);

  useSeo({
    title: tpl ? `${tpl.title} تحميل مجاني Excel | Field Sales` : 'نماذج مجانية لشركات التوزيع | Field Sales',
    description: tpl
      ? `${tpl.purpose} حمله بصيغة Excel مجانا وبلا تسجيل`
      : 'نماذج Excel مجانية جاهزة لشركات التوزيع سند قبض كشف حساب عهدة سيارة المندوب خطة خط سير مرتجعات تسوية تحصيل بلا تسجيل',
    canonical: seo.canonical,
    locale: lang,
  });

  if (slug && !tpl) return <Navigate to="/نماذج" replace />;

  const handle = async (t: TemplateSpec) => {
    setBusy(t.slug);
    try { await downloadTemplate(t); } finally { setBusy(null); }
  };

  return (
    <div dir={dir} className="min-h-screen bg-[#FAF7F0] text-[#1F1A13]">
      <header className="border-b border-[#E8E0D2] bg-white/70 backdrop-blur">
        <div className="max-w-4xl mx-auto px-4 py-3 flex items-center justify-between">
          <Link to={pathForLocale('/', lang)} className="flex items-center gap-2 text-sm text-[#6b6357]">
            <ArrowLeft size={16} className={dir === 'rtl' ? 'rotate-180' : ''} />
            <BrandIcon size={22} /><span>الرئيسية</span>
          </Link>
          <LanguageToggle variant="light" />
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-8">
        {!tpl ? (
          <>
            <h1 className="text-2xl sm:text-3xl font-bold">نماذج مجانية لشركات التوزيع</h1>
            <p className="text-[#6b6357] mt-2 max-w-2xl leading-relaxed">
              نماذج Excel جاهزة تستعملها كما هي أو تعدلها <strong>بلا تسجيل وبلا بريد</strong> اضغط وحمل
            </p>
            <ul className="grid gap-3 sm:grid-cols-2 mt-6">
              {TEMPLATES.map((t) => (
                <li key={t.slug} className="bg-white border border-[#E8E0D2] rounded-xl p-4 flex flex-col">
                  <Link to={`/نماذج/${t.slug}`} className="font-semibold hover:text-[#E15A30]">{t.title}</Link>
                  <p className="text-xs text-[#6b6357] mt-1.5 leading-relaxed flex-1">{t.purpose}</p>
                  <button
                    onClick={() => handle(t)} disabled={busy === t.slug}
                    className="mt-3 inline-flex items-center justify-center gap-2 text-sm border border-[#E8E0D2] rounded-lg py-2 hover:border-[#E15A30] disabled:opacity-60"
                  >
                    <Download size={15} />{busy === t.slug ? 'جار التجهيز' : 'تحميل Excel'}
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <>
            <h1 className="text-2xl sm:text-3xl font-bold">{tpl.title}</h1>
            <p className="text-[#6b6357] mt-3 leading-relaxed">{tpl.purpose}</p>

            <button
              onClick={() => handle(tpl)} disabled={busy === tpl.slug}
              className="mt-5 inline-flex items-center gap-2 bg-[#E15A30] text-white rounded-lg px-5 py-2.5 text-sm disabled:opacity-60"
            >
              <FileSpreadsheet size={16} />{busy === tpl.slug ? 'جار التجهيز' : 'تحميل النموذج Excel'}
            </button>
            <p className="text-[11px] text-[#9A8F7E] mt-2">بلا تسجيل وبلا بريد الملف يبنى في متصفحك ولا يرسل شيء لخوادمنا</p>

            <section className="mt-7 bg-white border border-[#E8E0D2] rounded-xl p-5 overflow-x-auto">
              <h2 className="font-semibold text-sm mb-3">أعمدة النموذج</h2>
              <table className="w-full text-xs">
                <caption className="sr-only">{tpl.title}</caption>
                <thead>
                  <tr className="text-start">
                    {tpl.columns.map((c) => (
                      <th key={c} scope="col" className="text-start py-2 pe-3 font-medium text-[#6b6357] whitespace-nowrap">{c}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#F0EBE0]">
                  {tpl.sample.map((row, i) => (
                    <tr key={i}>
                      {row.map((cell, j) => (
                        <td key={j} className="py-2 pe-3 whitespace-nowrap tabular-nums">{cell === '' ? '—' : cell}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>

            <section className="mt-6 bg-white border border-[#E8E0D2] rounded-xl p-5">
              <h2 className="font-semibold text-sm">كيف تستعمله</h2>
              <ul className="mt-2 space-y-1.5 text-xs text-[#4a443a] list-disc ps-4">
                {tpl.notes.map((n) => <li key={n} className="leading-relaxed">{n}</li>)}
              </ul>
            </section>

            <section className="mt-6 bg-white border border-[#E8E0D2] rounded-xl p-5">
              <h2 className="font-semibold text-sm">حين يصير النموذج غير كاف</h2>
              <p className="text-xs text-[#6b6357] mt-2 leading-relaxed">
                هذا النموذج يخدم شركة تدير عددا محدودا من الحركات يدويا إن كنت تصدر عشرات المستندات
                يوميا من الميدان فField Sales يصدرها من جوال المندوب <strong>حتى بلا إنترنت</strong>
                ويرحلها محاسبيا تلقائيا
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Link to={pathForLocale('/pricing', lang)} className="text-sm border border-[#E8E0D2] rounded-lg px-3 py-2">شاهد الأسعار</Link>
                <a href={waHref(arPath, { lang })} target="_blank" rel="noopener noreferrer"
                   className="inline-flex items-center gap-2 bg-[#25D366] text-white rounded-lg px-3 py-2 text-sm">
                  <MessageCircle size={15} />تحدث معنا
                </a>
              </div>
            </section>
          </>
        )}
      </main>
    </div>
  );
}

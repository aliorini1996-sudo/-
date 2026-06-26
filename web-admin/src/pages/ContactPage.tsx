import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { siteContentApi } from '../api/client';
import { defaultContent } from '../landing/defaultContent';
import { BrandIcon } from '../components/BrandLogo';
import { ArrowLeft, Mail, Phone, MapPin, MessageCircle, LifeBuoy } from 'lucide-react';

// صفحة التواصل مع الشركة — بياناتها من CMS
export default function ContactPage() {
  const { data } = useQuery({
    queryKey: ['site-content'],
    queryFn: async () => { const r = await siteContentApi.get(); return r.data.data as unknown; },
    staleTime: 60_000,
  });
  const content = (data || defaultContent) as typeof defaultContent;
  const c = content.contact || defaultContent.contact;

  const cards = [
    c.email && { icon: Mail, label: 'البريد الإلكتروني', value: c.email, href: `mailto:${c.email}` },
    c.phone && { icon: Phone, label: 'الهاتف', value: c.phone, href: `tel:${c.phone}` },
    c.whatsapp && { icon: MessageCircle, label: 'واتساب', value: c.whatsapp, href: `https://wa.me/${String(c.whatsapp).replace(/[^0-9]/g, '')}` },
    c.address && { icon: MapPin, label: 'العنوان', value: c.address, href: undefined },
  ].filter(Boolean) as { icon: React.ElementType; label: string; value: string; href?: string }[];

  return (
    <div dir="rtl" className="min-h-screen bg-[#FAF7F0] text-[#1F1A13]" style={{ fontFamily: "'IBM Plex Sans Arabic', sans-serif" }}>
      <header className="sticky top-0 z-20 border-b border-[#E9E1D3] bg-[#FAF7F0]/85 backdrop-blur">
        <div className="max-w-4xl mx-auto px-5 h-16 flex items-center justify-between">
          <Link to="/" className="flex items-center gap-2.5">
            <BrandIcon size={34} />
            <span style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 700 }} className="text-lg">
              <span className="text-[#1F1A13]">Field</span><span className="text-[#E15A30]">Sales</span>
            </span>
          </Link>
          <Link to="/" className="text-sm font-semibold text-[#6E6557] hover:text-[#E15A30] flex items-center gap-1 transition-colors">
            العودة للرئيسية <ArrowLeft size={15} />
          </Link>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-5 py-16">
        <div className="text-center mb-10">
          <div className="w-16 h-16 rounded-2xl bg-[#FBEBE2] flex items-center justify-center mx-auto mb-4">
            <LifeBuoy size={30} className="text-[#E15A30]" />
          </div>
          <h1 className="text-3xl lg:text-4xl font-extrabold tracking-tight">تواصل معنا</h1>
          <p className="text-[#6E6557] mt-3 max-w-xl mx-auto leading-relaxed">{c.intro}</p>
        </div>

        <div className="grid sm:grid-cols-2 gap-4 max-w-2xl mx-auto">
          {cards.map((card, i) => {
            const inner = (
              <div className="bg-white rounded-2xl border border-[#E9E1D3] p-6 flex items-center gap-4 hover:border-[#E8C9BC] transition-colors h-full">
                <div className="w-12 h-12 rounded-xl bg-[#FBEBE2] flex items-center justify-center shrink-0">
                  <card.icon size={22} className="text-[#E15A30]" />
                </div>
                <div className="min-w-0">
                  <p className="text-xs text-[#9A8F7E] mb-0.5">{card.label}</p>
                  <p className="font-semibold text-[#1F1A13] truncate" dir="ltr" style={{ textAlign: 'right' }}>{card.value}</p>
                </div>
              </div>
            );
            return card.href
              ? <a key={i} href={card.href} target={card.href.startsWith('http') ? '_blank' : undefined} rel="noreferrer">{inner}</a>
              : <div key={i}>{inner}</div>;
          })}
        </div>

        {c.email && (
          <div className="text-center mt-10">
            <a href={`mailto:${c.email}`} className="inline-flex items-center gap-2 px-7 py-3.5 rounded-2xl font-bold text-white bg-[#E15A30] hover:bg-[#C94E28] transition-colors shadow-lg shadow-[#E15A30]/25">
              <Mail size={18} /> أرسل لنا رسالة
            </a>
          </div>
        )}
      </main>

      <footer className="border-t border-[#E9E1D3] py-6 text-center text-xs text-[#9A8F7E]">
        © {new Date().getFullYear()} Field Sales — fieldsa.net
      </footer>
    </div>
  );
}

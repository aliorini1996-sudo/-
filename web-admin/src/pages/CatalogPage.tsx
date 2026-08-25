import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Phone, MessageCircle, Package } from 'lucide-react';
import { roundDecimal } from '../rep/invoiceCalc';
import { currencyDecimals, currencySymbol } from '../i18n/countries';

/**
 * منيو المنتجات العام — الصفحة التي يشاركها المندوب مع عملائه:
 * /c/{tenantId}/{repId}
 *
 * بلا مصادقة، محمولة أولاً (العميل يفتحها من واتساب على جواله)، بهوية الشركة
 * (شعار ولون)، وبختم المندوب: «مندوبك فلان» بزرَّي اتصال وواتساب على رقم عمله.
 * السعر المعروض شامل الضريبة — نفس معادلة السعر المعلن في تطبيق المندوب.
 */

interface CatalogData {
  company: { name: string; logo?: string | null; primaryColor?: string | null; currency: string };
  rep: { name: string; contact?: string | null };
  products: { name: string; unit: string; basePrice: number; taxPct: number; image?: string | null; category?: string | null }[];
}

const API = import.meta.env.VITE_API_URL ? `${import.meta.env.VITE_API_URL}/api` : '/api';

export default function CatalogPage() {
  const { tenantId, repId } = useParams();
  const [data, setData] = useState<CatalogData | null>(null);
  const [err, setErr] = useState(false);
  const [cat, setCat] = useState<string | null>(null);

  // روابط المنيو خاصة تُشارك يداً بيد — لا تُفهرس
  useEffect(() => {
    const m = document.createElement('meta');
    m.name = 'robots'; m.content = 'noindex, nofollow';
    document.head.appendChild(m);
    return () => { document.head.removeChild(m); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch(`${API}/public/catalog/${tenantId}/${repId}`)
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(j => { if (!cancelled) { setData(j.data as CatalogData); document.title = `${j.data.company.name} — منيو المنتجات`; } })
      .catch(() => { if (!cancelled) setErr(true); });
    return () => { cancelled = true; };
  }, [tenantId, repId]);

  const brand = data?.company.primaryColor || '#E15A30';
  const dec = currencyDecimals(data?.company.currency || 'SAR');
  const sym = currencySymbol(data?.company.currency || 'SAR');
  // السعر شامل الضريبة — مطابق لمعادلة تطبيق المندوب حرفياً
  const gross = (p: { basePrice: number; taxPct: number }) =>
    roundDecimal(Number(p.basePrice) * (1 + Number(p.taxPct) / 100), dec);

  const cats = useMemo(() => {
    const set = new Map<string, number>();
    for (const p of data?.products ?? []) {
      const k = p.category ?? 'أخرى';
      set.set(k, (set.get(k) ?? 0) + 1);
    }
    return [...set.keys()];
  }, [data]);

  const shown = (data?.products ?? []).filter(p => !cat || (p.category ?? 'أخرى') === cat);
  const wa = data?.rep.contact ? `https://wa.me/${data.rep.contact.replace(/[^0-9]/g, '')}` : null;

  if (err) {
    return (
      <div dir="rtl" style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#FAF7F0', fontFamily: 'system-ui', color: '#6E6557', padding: 24, textAlign: 'center' }}>
        الرابط غير صحيح او لم يعد متاحا — تواصل مع مندوبك
      </div>
    );
  }
  if (!data) {
    return (
      <div dir="rtl" style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#FAF7F0' }}>
        <div style={{ width: 34, height: 34, border: '3px solid #E9E1D3', borderTopColor: '#E15A30', borderRadius: '50%', animation: 'spin 0.9s linear infinite' }} />
        <style>{'@keyframes spin{to{transform:rotate(360deg)}}'}</style>
      </div>
    );
  }

  return (
    <div dir="rtl" style={{ minHeight: '100vh', background: '#FAF7F0', fontFamily: "'IBM Plex Sans Arabic', system-ui, sans-serif", color: '#1F1A13', paddingBottom: 80 }}>
      {/* رأس الشركة */}
      <header style={{ background: '#fff', borderBottom: '1px solid #E9E1D3', padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 12, position: 'sticky', top: 0, zIndex: 10 }}>
        {data.company.logo
          ? <img src={data.company.logo} alt="" style={{ width: 44, height: 44, borderRadius: 12, objectFit: 'cover', border: '1px solid #E9E1D3' }} />
          : <span style={{ width: 44, height: 44, borderRadius: 12, background: brand, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}><Package size={22} color="#fff" /></span>}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 800, fontSize: 16, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{data.company.name}</div>
          <div style={{ fontSize: 11.5, color: '#8A8178' }}>منيو المنتجات · الاسعار شاملة الضريبة</div>
        </div>
      </header>

      {/* شريط المندوب */}
      <div style={{ background: brand, color: '#fff', padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 13.5, flex: 1 }}>مندوبك: <b>{data.rep.name}</b></span>
        {data.rep.contact && (
          <span style={{ display: 'inline-flex', gap: 8 }}>
            <a href={`tel:${data.rep.contact}`} aria-label="اتصال" style={{ width: 34, height: 34, borderRadius: 10, background: 'rgba(255,255,255,.18)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: '#fff' }}><Phone size={17} /></a>
            {wa && <a href={wa} target="_blank" rel="noreferrer" aria-label="واتساب" style={{ width: 34, height: 34, borderRadius: 10, background: 'rgba(255,255,255,.18)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: '#fff' }}><MessageCircle size={17} /></a>}
          </span>
        )}
      </div>

      {/* فئات */}
      {cats.length > 1 && (
        <div style={{ display: 'flex', gap: 8, overflowX: 'auto', padding: '12px 16px 4px', WebkitOverflowScrolling: 'touch' }}>
          <button onClick={() => setCat(null)} style={{ flexShrink: 0, border: '1px solid ' + (cat === null ? brand : '#E9E1D3'), background: cat === null ? brand : '#fff', color: cat === null ? '#fff' : '#4A4239', borderRadius: 999, padding: '6px 14px', fontSize: 12.5, fontWeight: 700, cursor: 'pointer' }}>الكل</button>
          {cats.map(c => (
            <button key={c} onClick={() => setCat(c)} style={{ flexShrink: 0, border: '1px solid ' + (cat === c ? brand : '#E9E1D3'), background: cat === c ? brand : '#fff', color: cat === c ? '#fff' : '#4A4239', borderRadius: 999, padding: '6px 14px', fontSize: 12.5, fontWeight: 700, cursor: 'pointer' }}>{c}</button>
          ))}
        </div>
      )}

      {/* الأصناف */}
      <main style={{ padding: '12px 16px', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 12 }}>
        {shown.map((p, i) => (
          <div key={i} style={{ background: '#fff', border: '1px solid #E9E1D3', borderRadius: 16, overflow: 'hidden' }}>
            <div style={{ aspectRatio: '1', background: '#F6F1E7', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {p.image
                ? <img src={p.image} alt={p.name} loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                : <Package size={34} color="#D8CDB9" />}
            </div>
            <div style={{ padding: '10px 12px' }}>
              <div style={{ fontWeight: 700, fontSize: 13.5, lineHeight: 1.45, minHeight: 38 }}>{p.name}</div>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginTop: 6 }}>
                <span style={{ color: brand, fontWeight: 800, fontSize: 15 }}>{gross(p).toLocaleString('ar-SA', { minimumFractionDigits: dec, maximumFractionDigits: dec })} <span style={{ fontSize: 11 }}>{sym}</span></span>
                <span style={{ fontSize: 10.5, color: '#8A8178' }}>{p.unit}</span>
              </div>
            </div>
          </div>
        ))}
        {!shown.length && <p style={{ gridColumn: '1/-1', textAlign: 'center', color: '#8A8178', fontSize: 13, padding: 30 }}>لا اصناف في هذه الفئة</p>}
      </main>

      {/* زر واتساب عائم */}
      {wa && (
        <a href={`${wa}?text=${encodeURIComponent('مرحبا اطلعت على منيو المنتجات وارغب بالطلب')}`} target="_blank" rel="noreferrer"
          style={{ position: 'fixed', bottom: 18, insetInlineStart: 18, background: '#1E7A52', color: '#fff', borderRadius: 999, padding: '12px 20px', fontWeight: 800, fontSize: 14, display: 'inline-flex', alignItems: 'center', gap: 8, boxShadow: '0 10px 26px rgba(30,122,82,.4)', textDecoration: 'none' }}>
          <MessageCircle size={18} /> اطلب عبر واتساب
        </a>
      )}

      <footer style={{ textAlign: 'center', padding: '26px 16px 10px', fontSize: 11, color: '#B7AD9D' }}>
        مدعوم من <a href="/" style={{ color: '#8A8178', fontWeight: 700, textDecoration: 'none' }}>FieldSales</a>
      </footer>
    </div>
  );
}

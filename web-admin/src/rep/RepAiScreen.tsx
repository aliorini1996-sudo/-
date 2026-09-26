import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ChevronRight, Crosshair, MapPin, Navigation, Plus, Route as RouteIcon, Sparkles, Store, UserPlus, X, ClipboardCheck, Trash2, MessageCircle, Send } from 'lucide-react';
import repApi from './repApi';
import { cacheGet, cacheSet, newClientRef } from './offlineDb';
import { isNetworkError } from './offlineSync';
import { useAiRepTr } from '../i18n/aiRepPhrases';
import { formatCurrency } from '../utils/format';
import { loadGoogleMaps, searchNearbyOnDevice } from './googleMaps';
import RepAiMap from './RepAiMap';
import { CONFIDENCE_LABEL, OUTCOMES, OUTCOME_LABEL, fmtDistance, fmtRange, multiStopUrl, navUrl, orderRoute, routeLegs, refsFor, renderRefs } from './aiRepLogic';

/**
 * المندوب الذكي — شاشة المندوب:
 *   «القريبة»: المحلات المستهدفة حوله (Google) مدموجةً بسجلّ الشركة، وملخّص ما يُتوقّع أن يشتريه كل محل.
 *   تفاصيل المحل: توقّع كل منتج (شهرياً وأول طلب) وطلب تجريبي، ثم ملاحة / تسجيل نتيجة / إضافته عميلاً.
 *   «مساري»: ترتيب المحطات المختارة وروابط الملاحة.
 * الأرقام من بيانات الشركة الفعلية (محرّك حتمي في الخادم) — لا يخترعها أحد.
 * شروط Google: الاسم والعنوان لا يُخزَّنان على الجهاز؛ النسخة المحفوظة دون اتصال بلا أسماء.
 */

interface Range { low: number; median: number; high: number }
interface Summary {
  ok: boolean; confidence?: string; peers?: number; ringKm?: number | null; monthlyTotalValue?: Range | null;
  top?: { name: string; unit: string; penetration: number; qtyMedian: number | null }[]; eligiblePeers?: number; minPeers?: number;
}
interface Item {
  placeId: string; name: string; address: string | null; lat: number; lng: number; outletType: string; outletTypeLabel: string;
  distanceM: number; relation: 'NEW' | 'CUSTOMER' | 'POSSIBLE_CUSTOMER'; customerId: string | null;
  lastOutcome: string | null; lastOutcomeAt: string | null; rejectedRecently: boolean; estimate: Summary;
}
interface Me {
  placesConfigured: boolean; mapsKey?: string | null; showMoney: boolean; searchRadiusM: number; targetTypes: { code: string; label: string; google?: string[] }[]; dailySearches: { used: number; limit: number };
  advisor?: { available: boolean; reason: string | null; used: number; limit: number };
}
interface ChatMsg { role: 'user' | 'assistant'; text: string; refs?: string[] }
interface Guide { text: string; plan: string[]; source: 'AI' | 'RULES' }
interface ProductEst {
  productId: string; name: string; unit: string; priority: boolean; buyers: number; peers: number; penetration: number;
  monthlyQty: Range | null; monthlyValue: Range | null; firstOrderQty: number | null; trialQty: number | null; confidence: string; hidden: null | 'FEW_BUYERS' | 'DOMINANT';
}
interface Estimate { ok: boolean; confidence?: string; peers?: number; ringKm?: number | null; monthlyTotalValue?: Range | null; products?: ProductEst[]; why: string }
export interface AiAddPrefill { outletType: string; aiPlaceId: string; lat?: number; lng?: number }
interface PendingOutcome { body: Record<string, unknown> }

const PENDING_KEY = 'ai-rep:pending-outcomes';
const LAST_KEY = 'ai-rep:last';

function getGps(): Promise<{ lat: number; lng: number; accuracy: number }> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) { reject(new Error('no-geo')); return; }
    navigator.geolocation.getCurrentPosition(
      p => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
      e => reject(e),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 20000 },
    );
  });
}

async function flushPending(): Promise<void> {
  const hit = await cacheGet<PendingOutcome[]>(PENDING_KEY);
  const list = hit?.data ?? [];
  if (!list.length || !navigator.onLine) return;
  const left: PendingOutcome[] = [];
  for (const p of list) {
    try { await repApi.post('/ai-rep/rep/outcomes', p.body, { background: true } as never); }
    catch (e) { if (isNetworkError(e)) left.push(p); /* رفضٌ من الخادم (تحقّق) لا يُعاد إلى ما لا نهاية */ }
  }
  await cacheSet(PENDING_KEY, left);
}

export default function RepAiScreen({ onBack, onAddCustomer, onOpenCustomer }: {
  onBack: () => void;
  onAddCustomer: (prefill: AiAddPrefill) => void;
  onOpenCustomer: (customerId: string) => void;
}) {
  const tr = useAiRepTr();
  const [me, setMe] = useState<Me | null>(null);
  const [meErr, setMeErr] = useState<string | null>(null);
  const [types, setTypes] = useState<string[]>([]);
  const [items, setItems] = useState<Item[] | null>(null);
  const [cachedAt, setCachedAt] = useState<number | null>(null);
  const [origin, setOrigin] = useState<{ lat: number; lng: number; accuracy: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [tab, setTab] = useState<'near' | 'route' | 'ask'>('near');
  // المحادثة تخصّ القائمة الحالية: مراجع P1… تُبنى منها، فبحثٌ جديد يبدأ محادثة جديدة
  const [chat, setChat] = useState<ChatMsg[]>([]);
  const [askDraft, setAskDraft] = useState('');
  const [route, setRoute] = useState<Item[]>([]);
  const [open, setOpen] = useState<Item | null>(null);
  // خريطة Google داخل التطبيق (إن ضُبط مفتاحها) والتوجيه التلقائي بعد كل بحث
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [g, setG] = useState<any>(null);
  const [mapErr, setMapErr] = useState('');
  const [guide, setGuide] = useState<Guide | null>(null);
  const [guiding, setGuiding] = useState(false);
  useEffect(() => {
    if (!me?.mapsKey) return;
    loadGoogleMaps(me.mapsKey).then(setG).catch(() => setMapErr(tr('تعذّر تحميل خريطة Google — تحقّق من الاتصال')));
  }, [me?.mapsKey, tr]);

  useEffect(() => {
    void flushPending();
    repApi.get('/ai-rep/rep/me')
      .then(r => { const d = r.data.data as Me; setMe(d); setTypes(d.targetTypes.map(t => t.code)); })
      .catch(e => setMeErr(e?.response?.data?.message || (isNetworkError(e) ? tr('أنت دون اتصال') : tr('تعذّر تحميل المندوب الذكي'))));
    // آخر نتائج محفوظة (بلا أسماء) — تُعرض موسومة بزمنها إن لم يوجد بحث جديد
    cacheGet<Item[]>(LAST_KEY).then(hit => { if (hit?.data?.length) { setItems(prev => prev ?? hit.data); setCachedAt(hit.updatedAt); } }).catch(() => undefined);
    const onOnline = () => { void flushPending(); };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [tr]);

  const search = useCallback(async () => {
    setBusy(true); setMsg('');
    try {
      const gps = await getGps().catch(() => null);
      if (!gps) { setMsg(tr('فعّل الموقع لنعرف المحلات القريبة منك')); return; }
      setOrigin(gps);
      let list: Item[];
      if (me?.mapsKey) {
        // الخريطة في الجهاز تبحث عن المحلات، والخادم يدمجها بسجلّ الشركة ويتوقّع (الأسماء تبقى هنا)
        const gg = g ?? await loadGoogleMaps(me.mapsKey);
        if (!g) setG(gg);
        const includedTypes = [...new Set(me.targetTypes.filter(t => types.includes(t.code)).flatMap(t => t.google ?? []))];
        const found = await searchNearbyOnDevice(gg, { lat: gps.lat, lng: gps.lng, radiusM: me.searchRadiusM, includedTypes });
        const r = await repApi.post('/ai-rep/rep/analyze', {
          lat: gps.lat, lng: gps.lng, types,
          places: found.map(f => ({ placeId: f.placeId, primaryType: f.primaryType, types: f.types, lat: f.lat, lng: f.lng })),
        });
        const byId = new Map(found.map(f => [f.placeId, f]));
        list = ((r.data.data.items ?? []) as Item[]).map(it => ({ ...it, name: byId.get(it.placeId)?.name ?? '', address: byId.get(it.placeId)?.address ?? null }));
      } else {
        const r = await repApi.post('/ai-rep/rep/nearby', { lat: gps.lat, lng: gps.lng, accuracyM: gps.accuracy, types });
        list = (r.data.data.items ?? []) as Item[];
      }
      setItems(list); setCachedAt(null); setChat([]); setGuide(null);
      setMe(m => (m ? { ...m, dailySearches: { ...m.dailySearches, used: m.dailySearches.used + 1 } } : m));
      // الحفظ دون اتصال بلا أسماء ولا عناوين (شروط Google)
      void cacheSet(LAST_KEY, list.map(i => ({ ...i, name: '', address: null })));
      if (!list.length) { setMsg(tr('لا محلات مستهدفة في هذا النطاق — جرّب نوعاً آخر أو تحرّك قليلاً')); return; }
      // التوجيه: العقل يفحص كل المحلات المجاورة ويعطي خطة (أو خطة حتمية من بيانات الشركة إن لم يُضبط)
      setGuiding(true);
      try {
        const gr = await repApi.post('/ai-rep/rep/guide', { outlets: refsFor(list), gps: { lat: gps.lat, lng: gps.lng } });
        const gd = gr.data.data as Guide;
        setGuide(gd);
        const planItems = gd.plan.map(ref => list[Number(ref.slice(1)) - 1]).filter(Boolean);
        if (planItems.length) setRoute(planItems);
      } catch { /* التوجيه اختياري: القائمة والخريطة تبقيان */ }
      finally { setGuiding(false); }
    } catch (e) {
      const err = e as { response?: { data?: { message?: string } } };
      setMsg(err?.response?.data?.message || (isNetworkError(e) ? tr('أنت دون اتصال — البحث يحتاج الإنترنت') : tr('تعذّر البحث')));
    } finally { setBusy(false); }
  }, [types, tr, me, g]);

  const inRoute = useCallback((id: string) => route.some(r => r.placeId === id), [route]);
  const toggleRoute = (it: Item) => setRoute(rt => (rt.some(r => r.placeId === it.placeId) ? rt.filter(r => r.placeId !== it.placeId) : [...rt, it]));

  const ordered = useMemo(() => (origin ? routeLegs(origin, orderRoute(origin, route)) : []), [origin, route]);
  const money = (n: number) => formatCurrency(n, undefined, 0);

  if (meErr) {
    return (
      <div className="p-4 space-y-4 h-full">
        <Header onBack={onBack} title={tr('المندوب الذكي')} />
        <p className="text-center text-sm text-gray-500 py-10">{meErr}</p>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <div className="p-4 pb-2 space-y-3 flex-shrink-0">
        <Header onBack={onBack} title={tr('المندوب الذكي')}
          right={origin ? <span className="text-[11px] text-gray-400 flex items-center gap-1"><Crosshair size={11} /> {origin.accuracy <= 50 ? tr('موقعك دقيق') : tr('موقعك تقريبي')}</span> : null} />
        {me && !me.placesConfigured && (
          <p className="text-xs rounded-xl bg-amber-50 border border-amber-200 text-amber-800 p-2.5">{tr('البحث عن المحلات لم يُفعَّل بعد لدى مزوّد الخدمة — التوقّعات لعملائك متاحة من ملفّاتهم')}</p>
        )}
        <div className="grid grid-cols-3 gap-2 bg-gray-100 rounded-xl p-1">
          {(['near', 'route', 'ask'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)} className={`py-2 rounded-lg text-sm font-semibold ${tab === t ? 'bg-white text-[#E15A30] shadow-sm' : 'text-gray-500'}`}>
              {t === 'near' ? tr('القريبة') : t === 'route' ? `${tr('مساري')} (${route.length})` : tr('اسأل')}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 pb-24 space-y-3">
        {tab === 'near' ? (
          <>
            {me && (
              <div className="flex flex-wrap gap-1.5">
                {me.targetTypes.map(t => {
                  const on = types.includes(t.code);
                  return (
                    <button key={t.code} onClick={() => setTypes(ts => (on ? (ts.length > 1 ? ts.filter(x => x !== t.code) : ts) : [...ts, t.code]))}
                      className={`text-xs rounded-full px-3 py-1.5 border ${on ? 'bg-[#FBEBE2] border-[#F5DACE] text-[#C94E28] font-semibold' : 'bg-white border-gray-200 text-gray-500'}`}>
                      {tr(t.label)}
                    </button>
                  );
                })}
              </div>
            )}
            <button onClick={search} disabled={busy || !me?.placesConfigured}
              className="w-full flex items-center justify-center gap-2 bg-[#E15A30] disabled:opacity-50 text-white rounded-2xl py-3.5 font-bold">
              <Sparkles size={18} /> {busy ? tr('أبحث في المحلات القريبة…') : tr('ابحث عن فرص حولي')}
            </button>
            {me && <p className="text-[11px] text-gray-400 text-center">{tr('بحث اليوم')}: {me.dailySearches.used} / {me.dailySearches.limit} · {tr('النطاق')} {fmtDistance(me.searchRadiusM)}</p>}
            {msg && <p className="text-sm text-center text-gray-500">{msg}</p>}
            {cachedAt && <p className="text-[11px] text-amber-700 text-center">{tr('نتائج محفوظة من')} {new Date(cachedAt).toLocaleTimeString()} — {tr('الأسماء تظهر عند البحث من جديد')}</p>}
            {me?.mapsKey && (g
              ? <RepAiMap g={g} origin={origin} items={(items ?? []).map(i => ({ placeId: i.placeId, lat: i.lat, lng: i.lng, relation: i.relation, rejectedRecently: i.rejectedRecently, name: i.name }))}
                  plan={route.map(r => r.placeId)} onSelect={id => { const it = (items ?? []).find(x => x.placeId === id); if (it) setOpen(it); }} />
              : <div className="w-full h-64 rounded-2xl bg-gray-100 flex items-center justify-center text-xs text-gray-400">{mapErr || tr('جاري تحميل الخريطة…')}</div>)}
            {guiding && <p className="text-sm text-center text-[#C94E28]">{tr('المستشار يفحص المحلات المجاورة…')}</p>}
            {guide && (
              <div className="rounded-2xl border border-[#F5DACE] bg-[#FBEBE2] p-4 space-y-2">
                <p className="text-xs font-bold text-[#C94E28] flex items-center gap-1.5"><Sparkles size={14} /> {guide.source === 'AI' ? tr('توجيه المستشار الذكي') : tr('خطة من بيانات شركتك')}</p>
                <p className="text-sm text-[#1F1A13] whitespace-pre-wrap leading-6">{renderRefs(guide.text, (items ?? []).map((it, i) => ({ ref: `P${i + 1}`, label: it.name || `${tr(it.outletTypeLabel)} ${fmtDistance(it.distanceM)}` })))}</p>
                {!!guide.plan.length && (() => {
                  const planItems = guide.plan.map(ref => (items ?? [])[Number(ref.slice(1)) - 1]).filter(Boolean);
                  const url = multiStopUrl(planItems);
                  return (
                    <div className="flex gap-2">
                      {url && <a href={url} target="_blank" rel="noreferrer" className="flex-1 flex items-center justify-center gap-1.5 rounded-xl bg-[#1F1A13] text-white py-2.5 text-sm font-bold"><Navigation size={15} /> {tr('ابدأ الخطة في خرائط Google')}</a>}
                      <button onClick={() => setTab('route')} className="rounded-xl border border-[#E15A30] text-[#E15A30] px-3 text-sm font-semibold">{tr('مساري')}</button>
                    </div>
                  );
                })()}
              </div>
            )}

            {(items ?? []).map(it => (
              <div key={it.placeId} className={`rounded-2xl border p-3.5 ${it.rejectedRecently ? 'border-gray-100 bg-gray-50 opacity-80' : 'border-gray-100 bg-white'}`}>
                <button className="w-full text-right" onClick={() => setOpen(it)}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-bold text-[#1F1A13] truncate">{it.name || `${tr('محل')} — ${tr(it.outletTypeLabel)}`}</p>
                      <p className="text-[11px] text-gray-400 truncate">{tr(it.outletTypeLabel)} · {fmtDistance(it.distanceM)}{it.address ? ` · ${it.address}` : ''}</p>
                    </div>
                    <RelationTag it={it} />
                  </div>
                  <EstimateLine s={it.estimate} showMoney={!!me?.showMoney} money={money} />
                </button>
                <div className="flex gap-2 mt-2.5">
                  <button onClick={() => setOpen(it)} className="flex-1 text-xs rounded-xl border border-gray-200 py-2 font-semibold text-[#1F1A13]">{tr('التفاصيل والتوقّع')}</button>
                  <button onClick={() => toggleRoute(it)} className={`text-xs rounded-xl border px-3 py-2 font-semibold ${inRoute(it.placeId) ? 'border-[#E15A30] text-[#E15A30] bg-[#FBEBE2]' : 'border-gray-200 text-gray-600'}`}>
                    {inRoute(it.placeId) ? tr('في المسار') : <span className="inline-flex items-center gap-1"><Plus size={12} /> {tr('المسار')}</span>}
                  </button>
                </div>
              </div>
            ))}
            {!!items?.length && <p className="text-[10px] text-gray-400 text-center">{tr('بيانات الأماكن')}: Google Maps</p>}
          </>
        ) : tab === 'route' ? (
          <RouteTab ordered={ordered} hasOrigin={!!origin} onRemove={id => setRoute(rt => rt.filter(r => r.placeId !== id))} onOpen={setOpen} />
        ) : (
          <AskTab me={me} items={items ?? []} origin={origin} chat={chat} setChat={setChat} draft={askDraft} setDraft={setAskDraft}
            onUsed={() => setMe(m => (m?.advisor ? { ...m, advisor: { ...m.advisor, used: m.advisor.used + 1 } } : m))}
            onOpenRef={ref => { const it = (items ?? [])[Number(ref.slice(1)) - 1]; if (it) setOpen(it); }} />
        )}
      </div>

      {open && (
        <OutletSheet item={open} showMoney={!!me?.showMoney} money={money} onClose={() => setOpen(null)}
          inRoute={inRoute(open.placeId)} onToggleRoute={() => toggleRoute(open)}
          onAddCustomer={onAddCustomer} onOpenCustomer={onOpenCustomer}
          onAsk={me?.advisor?.available ? () => { const i = (items ?? []).findIndex(x => x.placeId === open.placeId); setOpen(null); setTab('ask'); if (i >= 0) setAskDraft(`وش أعرض على P${i + 1}؟ وكم الكمية المناسبة؟`); } : undefined}
          onOutcome={(kind) => setItems(list => (list ?? []).map(x => (x.placeId === open.placeId ? { ...x, lastOutcome: kind, lastOutcomeAt: new Date().toISOString(), rejectedRecently: kind === 'NOT_INTERESTED' || kind === 'EXCLUSIVE_SUPPLIER' } : x)).filter(x => !(x.placeId === open.placeId && kind === 'CLOSED')))} />
      )}
    </div>
  );
}

function Header({ onBack, title, right }: { onBack: () => void; title: string; right?: ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <button onClick={onBack} className="p-2 -mr-2 text-gray-500"><ChevronRight size={20} /></button>
      <p className="flex-1 font-bold text-[#1F1A13] flex items-center gap-1.5"><Sparkles size={17} className="text-[#E15A30]" /> {title}</p>
      {right}
    </div>
  );
}

function RelationTag({ it }: { it: Item }) {
  const tr = useAiRepTr();
  if (it.rejectedRecently) return <span className="shrink-0 text-[10px] rounded-full px-2 py-0.5 bg-gray-200 text-gray-600">{tr(OUTCOME_LABEL[it.lastOutcome ?? ''] ?? 'زرته')}</span>;
  if (it.relation === 'CUSTOMER') return <span className="shrink-0 text-[10px] rounded-full px-2 py-0.5 bg-blue-50 text-blue-700">{tr('عميل حالي')}</span>;
  if (it.relation === 'POSSIBLE_CUSTOMER') return <span className="shrink-0 text-[10px] rounded-full px-2 py-0.5 bg-blue-50 text-blue-600">{tr('ربما عميل حالي')}</span>;
  if (it.lastOutcome) return <span className="shrink-0 text-[10px] rounded-full px-2 py-0.5 bg-amber-50 text-amber-700">{tr(OUTCOME_LABEL[it.lastOutcome] ?? '')}</span>;
  return <span className="shrink-0 text-[10px] rounded-full px-2 py-0.5 bg-green-50 text-green-700">{tr('فرصة جديدة')}</span>;
}

function EstimateLine({ s, showMoney, money }: { s: Summary; showMoney: boolean; money: (n: number) => string }) {
  const tr = useAiRepTr();
  if (!s.ok) return <p className="text-[11px] text-gray-400 mt-2">{tr('لا تكفي بيانات شركتك لتوقّع هذا النوع بعد')}</p>;
  const t = s.top?.[0];
  return (
    <div className="mt-2 space-y-0.5">
      {showMoney && s.monthlyTotalValue && (
        <p className="text-sm font-bold text-[#E15A30]">{tr('متوقع شهرياً')}: {fmtRange(s.monthlyTotalValue, money)}</p>
      )}
      {t && <p className="text-[11px] text-gray-600">{t.name}: {t.qtyMedian != null ? `${t.qtyMedian} ${t.unit} / ${tr('شهر')}` : tr('يشتريه')} · {Math.round(t.penetration * 100)}٪ {tr('من المحلات المشابهة')}</p>}
      <p className="text-[10px] text-gray-400">{tr(CONFIDENCE_LABEL[s.confidence ?? 'LOW'])} · {tr('من')} {s.peers} {tr('محلات مشابهة')}</p>
    </div>
  );
}

function RouteTab({ ordered, hasOrigin, onRemove, onOpen }: {
  ordered: Array<Item & { legKm: number; cumKm: number; etaMin: number }>; hasOrigin: boolean; onRemove: (id: string) => void; onOpen: (it: Item) => void;
}) {
  const tr = useAiRepTr();
  if (!ordered.length) return <p className="text-center text-sm text-gray-400 py-10">{hasOrigin ? tr('أضف محلات إلى مسارك من قائمة القريبة') : tr('ابحث عن الفرص أولاً ثم أضف محلات إلى مسارك')}</p>;
  const all = multiStopUrl(ordered);
  const last = ordered[ordered.length - 1];
  return (
    <div className="space-y-3">
      <div className="rounded-2xl bg-[#1F1A13] text-white p-4">
        <p className="text-xs text-white/60">{tr('مسارك المقترح')}</p>
        <p className="text-lg font-bold">{ordered.length} {tr('محطات')} · {last.cumKm.toFixed(1)} {tr('كم')} · ~{last.etaMin} {tr('دقيقة قيادة')}</p>
        <p className="text-[10px] text-white/50 mt-1">{tr('الترتيب الأقصر من موقعك؛ الزمن تقديري')}</p>
        {all && <a href={all} target="_blank" rel="noreferrer" className="mt-3 flex items-center justify-center gap-2 bg-[#E15A30] rounded-xl py-2.5 font-bold text-sm"><Navigation size={16} /> {ordered.length > 4 ? tr('ابدأ أول ٤ محطات في خرائط Google') : tr('ابدأ المسار في خرائط Google')}</a>}
      </div>
      {ordered.map((s, i) => (
        <div key={s.placeId} className="rounded-2xl border border-gray-100 bg-white p-3 flex items-center gap-3">
          <span className="w-7 h-7 rounded-full bg-[#FBEBE2] text-[#C94E28] text-sm font-bold flex items-center justify-center shrink-0">{i + 1}</span>
          <button className="flex-1 min-w-0 text-right" onClick={() => onOpen(s)}>
            <p className="font-semibold text-sm truncate">{s.name || tr(s.outletTypeLabel)}</p>
            <p className="text-[11px] text-gray-400">{s.legKm.toFixed(1)} {tr('كم')} · ~{s.etaMin} {tr('دقيقة')}</p>
          </button>
          <a href={navUrl(s)} target="_blank" rel="noreferrer" className="p-2 text-[#E15A30]" title={tr('ملاحة')}><Navigation size={18} /></a>
          <button onClick={() => onRemove(s.placeId)} className="p-2 text-gray-400"><Trash2 size={16} /></button>
        </div>
      ))}
    </div>
  );
}

function OutletSheet({ item, showMoney, money, onClose, inRoute, onToggleRoute, onAddCustomer, onOpenCustomer, onOutcome, onAsk }: {
  item: Item; showMoney: boolean; money: (n: number) => string; onClose: () => void; inRoute: boolean; onToggleRoute: () => void;
  onAddCustomer: (p: AiAddPrefill) => void; onOpenCustomer: (id: string) => void; onOutcome: (kind: string) => void; onAsk?: () => void;
}) {
  const tr = useAiRepTr();
  const [est, setEst] = useState<Estimate | null>(null);
  const [err, setErr] = useState('');
  const [mode, setMode] = useState<'view' | 'outcome'>('view');
  const [kind, setKind] = useState<string>('');
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState('');
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    let alive = true;
    repApi.post('/ai-rep/rep/estimate', { lat: item.lat, lng: item.lng, outletType: item.outletType, ...(item.customerId && { customerId: item.customerId }) })
      .then(r => { if (alive) setEst(r.data.data as Estimate); })
      .catch(e => { if (alive) setErr(e?.response?.data?.message || (isNetworkError(e) ? tr('أنت دون اتصال') : tr('تعذّر حساب التوقّع'))); });
    return () => { alive = false; };
  }, [item, tr]);

  const submitOutcome = async () => {
    if (!kind) return;
    setSaving(true);
    const gps = await getGps().catch(() => null);
    const body = {
      clientRef: newClientRef(), placeId: item.placeId, outletType: item.outletType, kind,
      ...(name.trim() && { repTypedName: name.trim() }), ...(note.trim() && { note: note.trim() }),
      ...(gps && { lat: gps.lat, lng: gps.lng, accuracyM: gps.accuracy }), occurredAt: new Date().toISOString(),
    };
    try {
      await repApi.post('/ai-rep/rep/outcomes', body);
      setSaved(tr('سُجّلت النتيجة'));
    } catch (e) {
      if (isNetworkError(e)) {
        const hit = await cacheGet<PendingOutcome[]>(PENDING_KEY);
        await cacheSet(PENDING_KEY, [...(hit?.data ?? []), { body }]);
        setSaved(tr('حُفظت وسترسل عند عودة الاتصال'));
      } else {
        setSaved((e as { response?: { data?: { message?: string } } })?.response?.data?.message || tr('تعذّر التسجيل'));
        setSaving(false);
        return;
      }
    }
    onOutcome(kind);
    setSaving(false); setMode('view');
  };

  const addAsCustomer = async () => {
    setAdding(true);
    // الموقع من GPS المندوب عند الباب (لا من Google): موقع العميل دائم، وإحداثيات Google لا تُخزَّن
    const gps = await getGps().catch(() => null);
    setAdding(false);
    onAddCustomer({ outletType: item.outletType, aiPlaceId: item.placeId, ...(gps && gps.accuracy <= 100 && { lat: gps.lat, lng: gps.lng }) });
  };

  return (
    <div className="absolute inset-0 z-40 bg-white flex flex-col" dir="rtl">
      <div className="p-4 flex items-start gap-2 border-b border-gray-100 flex-shrink-0">
        <div className="flex-1 min-w-0">
          <p className="font-bold text-[#1F1A13] flex items-center gap-1.5"><Store size={17} className="text-[#E15A30] shrink-0" /> <span className="truncate">{item.name || tr(item.outletTypeLabel)}</span></p>
          <p className="text-[11px] text-gray-400 mt-0.5">{tr(item.outletTypeLabel)} · {fmtDistance(item.distanceM)}{item.address ? ` · ${item.address}` : ''}</p>
        </div>
        <button onClick={onClose} className="p-2 text-gray-500"><X size={20} /></button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4 pb-28">
        {mode === 'outcome' ? (
          <div className="space-y-3">
            <p className="font-bold text-sm">{tr('نتيجة الزيارة')}</p>
            <div className="grid grid-cols-2 gap-2">
              {OUTCOMES.map(o => (
                <button key={o.kind} onClick={() => setKind(o.kind)}
                  className={`rounded-xl border py-2.5 text-sm ${kind === o.kind ? 'border-[#E15A30] bg-[#FBEBE2] text-[#C94E28] font-semibold' : 'border-gray-200 text-gray-600'}`}>{tr(o.label)}</button>
              ))}
            </div>
            <input className="w-full rounded-xl border border-gray-200 px-3 py-2.5 text-sm" maxLength={120} placeholder={tr('اسم المحل كما في اللوحة (اختياري)')} value={name} onChange={e => setName(e.target.value)} />
            <textarea className="w-full rounded-xl border border-gray-200 px-3 py-2.5 text-sm min-h-[72px]" maxLength={500} placeholder={tr('ملاحظة (اختياري)')} value={note} onChange={e => setNote(e.target.value)} />
            <div className="flex gap-2">
              <button onClick={() => setMode('view')} className="flex-1 rounded-xl border border-gray-200 py-2.5 text-sm">{tr('رجوع')}</button>
              <button onClick={submitOutcome} disabled={!kind || saving} className="flex-1 rounded-xl bg-[#E15A30] disabled:opacity-50 text-white py-2.5 text-sm font-bold">{saving ? tr('جاري الحفظ') : tr('سجّل')}</button>
            </div>
          </div>
        ) : !est ? (
          <p className="text-center text-sm text-gray-400 py-8">{err || tr('أحسب المتوقع من بيانات شركتك…')}</p>
        ) : !est.ok ? (
          <div className="rounded-2xl bg-amber-50 border border-amber-200 p-4 text-sm text-amber-800">{est.why}</div>
        ) : (
          <>
            {saved && <p className="text-xs text-center text-green-700 bg-green-50 rounded-xl py-2">{saved}</p>}
            <div className="rounded-2xl bg-[#FBEBE2] border border-[#F5DACE] p-4">
              <p className="text-xs text-[#C94E28]">{tr('المتوقع لمحل مثل هذا')}</p>
              {showMoney && est.monthlyTotalValue && <p className="text-xl font-extrabold text-[#1F1A13] mt-1">{fmtRange(est.monthlyTotalValue, money)} <span className="text-xs font-normal text-gray-500">/ {tr('شهر')} {tr('قبل الضريبة')}</span></p>}
              <p className="text-[11px] text-gray-600 mt-1">{tr(CONFIDENCE_LABEL[est.confidence ?? 'LOW'])} · {est.why}</p>
            </div>

            {est.products?.some(p => p.trialQty) && (
              <div className="rounded-2xl border border-gray-100 p-4">
                <p className="font-bold text-sm mb-2 flex items-center gap-1.5"><ClipboardCheck size={15} className="text-[#E15A30]" /> {tr('طلب تجريبي مقترح')}</p>
                <div className="space-y-1">
                  {est.products.filter(p => p.trialQty).map(p => (
                    <p key={p.productId} className="text-sm flex justify-between"><span>{p.name}</span><b>{p.trialQty} {p.unit}</b></p>
                  ))}
                </div>
                <p className="text-[10px] text-gray-400 mt-2">{tr('من أول طلبات المحلات المشابهة للأصناف التي يشتريها نصفها على الأقل')}</p>
              </div>
            )}

            <div className="rounded-2xl border border-gray-100 p-4">
              <p className="font-bold text-sm mb-2">{tr('المتوقع لكل منتج')}</p>
              <div className="space-y-2.5">
                {est.products?.map(p => (
                  <div key={p.productId} className="border-b border-gray-50 pb-2 last:border-0">
                    <div className="flex justify-between gap-2">
                      <p className="text-sm font-semibold">{p.name}{p.priority && <span className="text-[10px] text-[#E15A30] mr-1">★</span>}</p>
                      <p className="text-[11px] text-gray-500 shrink-0">{p.buyers} {tr('من')} {p.peers} {tr('يشترونه')}</p>
                    </div>
                    {p.monthlyQty ? (
                      <p className="text-xs text-gray-700 mt-0.5">
                        {tr('شهرياً')}: <b>{fmtRange(p.monthlyQty)}</b> {p.unit} ({tr('الوسيط')} {p.monthlyQty.median})
                        {showMoney && p.monthlyValue && <> · {fmtRange(p.monthlyValue, money)}</>}
                        {p.firstOrderQty != null && <> · {tr('أول طلب')} ~{p.firstOrderQty}</>}
                      </p>
                    ) : (
                      <p className="text-[11px] text-gray-400 mt-0.5">{p.buyers === 0 ? tr('لا تشتريه المحلات المشابهة بعد') : p.hidden === 'DOMINANT' ? tr('مشترٍ واحد يطغى على الكمية — لا رقم موثوق') : tr('المشترون أقل من ٥ — لا رقم حفاظاً على الخصوصية')}</p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </div>

      {mode === 'view' && (
        <div className="absolute bottom-0 inset-x-0 bg-white border-t border-gray-100 p-3 grid grid-cols-2 gap-2">
          {onAsk && <button onClick={onAsk} className="col-span-2 flex items-center justify-center gap-1.5 rounded-xl border border-[#F5DACE] bg-[#FBEBE2] text-[#C94E28] py-2 text-sm font-semibold"><MessageCircle size={15} /> {tr('اسأل المستشار عن هذا المحل')}</button>}
          <a href={navUrl(item)} target="_blank" rel="noreferrer" className="flex items-center justify-center gap-1.5 rounded-xl bg-[#1F1A13] text-white py-2.5 text-sm font-bold"><Navigation size={15} /> {tr('ابدأ الملاحة')}</a>
          <button onClick={onToggleRoute} className={`flex items-center justify-center gap-1.5 rounded-xl border py-2.5 text-sm font-semibold ${inRoute ? 'border-[#E15A30] text-[#E15A30]' : 'border-gray-200'}`}><RouteIcon size={15} /> {inRoute ? tr('في المسار') : tr('أضف للمسار')}</button>
          <button onClick={() => { setMode('outcome'); setSaved(''); }} className="flex items-center justify-center gap-1.5 rounded-xl border border-gray-200 py-2.5 text-sm font-semibold"><MapPin size={15} /> {tr('سجّل نتيجة')}</button>
          {item.customerId ? (
            <button onClick={() => onOpenCustomer(item.customerId!)} className="flex items-center justify-center gap-1.5 rounded-xl border border-blue-200 text-blue-700 py-2.5 text-sm font-semibold">{tr('ملف العميل')}</button>
          ) : (
            <button onClick={addAsCustomer} disabled={adding} className="flex items-center justify-center gap-1.5 rounded-xl bg-[#E15A30] text-white py-2.5 text-sm font-bold disabled:opacity-60"><UserPlus size={15} /> {adding ? tr('أحدد موقعك…') : tr('أضفه عميلاً')}</button>
          )}
        </div>
      )}
    </div>
  );
}

/** «اسأل»: المستشار الذكي — يرى مراجع المحلات (P1…) لا أسماءها، والتطبيق يعرض الاسم مكان المرجع. */
function AskTab({ me, items, origin, chat, setChat, draft, setDraft, onUsed, onOpenRef }: {
  me: Me | null; items: Item[]; origin: { lat: number; lng: number } | null;
  chat: ChatMsg[]; setChat: (f: (c: ChatMsg[]) => ChatMsg[]) => void; draft: string; setDraft: (s: string) => void;
  onUsed: () => void; onOpenRef: (ref: string) => void;
}) {
  const tr = useAiRepTr();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const names = useMemo(() => items.map((it, i) => ({ ref: `P${i + 1}`, label: it.name || `${tr(it.outletTypeLabel)} ${fmtDistance(it.distanceM)}` })), [items, tr]);
  const adv = me?.advisor;
  if (!adv) return <p className="text-center text-sm text-gray-400 py-10">{tr('جاري التحميل')}</p>;
  if (!adv.available) {
    return <p className="text-center text-sm text-gray-500 py-10">{adv.reason === 'DISABLED_BY_COMPANY' ? tr('المستشار الذكي متوقف لشركتك') : tr('المستشار الذكي لم يُفعَّل بعد لدى مزوّد الخدمة')}</p>;
  }
  const ask = async (text: string) => {
    const q = text.trim();
    if (!q || busy) return;
    if (!navigator.onLine) { setErr(tr('المستشار يحتاج الإنترنت')); return; }
    const next: ChatMsg[] = [...chat, { role: 'user', text: q }];
    setChat(() => next); setDraft(''); setBusy(true); setErr('');
    try {
      const r = await repApi.post('/ai-rep/rep/chat', {
        messages: next.slice(-8).map(m => ({ role: m.role, text: m.text })),
        outlets: refsFor(items),
        ...(origin && { gps: { lat: origin.lat, lng: origin.lng } }),
      });
      const d = r.data.data as { text: string; refs: string[] };
      setChat(c => [...c, { role: 'assistant', text: d.text, refs: d.refs }]);
      onUsed();
    } catch (e) {
      setErr((e as { response?: { data?: { message?: string } } })?.response?.data?.message || (isNetworkError(e) ? tr('المستشار يحتاج الإنترنت') : tr('المستشار غير متاح مؤقتاً')));
      setChat(c => c.slice(0, -1)); setDraft(q);
    } finally { setBusy(false); }
  };
  const chips = items.length
    ? ['من أي محل أبدأ؟ ولماذا؟', 'رتّب لي مساراً لأفضل الفرص الجديدة', 'وش أعرض على أقرب فرصة جديدة؟', 'كيف أرد إذا قال: عندي مورّد؟']
    : ['كيف أرد إذا قال: عندي مورّد؟', 'كيف أفتح الحديث مع صاحب بقالة جديد؟'];
  return (
    <div className="space-y-3">
      {!items.length && <p className="text-[11px] text-amber-700 bg-amber-50 rounded-xl p-2">{tr('ابحث عن الفرص أولاً ليعرف المستشار المحلات حولك')}</p>}
      {chat.length === 0 && (
        <div className="flex flex-wrap gap-1.5">
          {chips.map(c => <button key={c} onClick={() => ask(tr(c))} className="text-xs rounded-full px-3 py-1.5 border border-[#F5DACE] bg-[#FBEBE2] text-[#C94E28]">{tr(c)}</button>)}
        </div>
      )}
      {chat.map((m, i) => (
        <div key={i} className={`rounded-2xl p-3 text-sm whitespace-pre-wrap ${m.role === 'user' ? 'bg-[#1F1A13] text-white mr-8' : 'bg-white border border-gray-100 ml-8'}`}>
          {m.role === 'assistant' ? renderRefs(m.text, names) : m.text}
          {!!m.refs?.length && (
            <div className="flex flex-wrap gap-1.5 mt-2">
              {m.refs.slice(0, 6).map(r => <button key={r} onClick={() => onOpenRef(r)} className="text-[11px] rounded-full px-2.5 py-1 bg-[#FBEBE2] text-[#C94E28]">{names.find(n => n.ref === r)?.label ?? r}</button>)}
            </div>
          )}
        </div>
      ))}
      {busy && <p className="text-xs text-gray-400">{tr('المستشار يحسب من بيانات شركتك…')}</p>}
      {err && <p className="text-xs text-red-600">{err}</p>}
      <div className="flex gap-2 sticky bottom-0 bg-white pt-2">
        <input value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void ask(draft); }} maxLength={1500}
          placeholder={tr('اسأل المستشار…')} className="flex-1 rounded-xl border border-gray-200 px-3 py-2.5 text-sm" />
        <button onClick={() => ask(draft)} disabled={busy || !draft.trim()} className="rounded-xl bg-[#E15A30] disabled:opacity-50 text-white px-3"><Send size={16} /></button>
      </div>
      <p className="text-[10px] text-gray-400 text-center">{tr('أسئلة اليوم')}: {adv.used} / {adv.limit} · {tr('الأرقام من بيانات شركتك؛ المستشار لا يخترعها')}</p>
    </div>
  );
}

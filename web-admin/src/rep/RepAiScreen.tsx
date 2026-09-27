import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChevronRight, Crosshair, MapPin, Navigation, Plus, Route as RouteIcon, Sparkles, Store, UserPlus, X, ClipboardCheck, Trash2, MessageCircle, Send, Shuffle, ThumbsUp, ThumbsDown } from 'lucide-react';
import repApi from './repApi';
import { cacheGet, cacheSet, currentRepId, newClientRef, outboxAdd } from './offlineDb';
import { isNetworkError } from './offlineSync';
import { useAiRepTr } from '../i18n/aiRepPhrases';
import { formatCurrency } from '../utils/format';
import { useBackClose } from '../lib/useBackClose';
import { loadGoogleMaps } from './googleMaps';
import RepAiMap from './RepAiMap';
import { loadAiSession, onConverted, patchAiSession, saveAiSession, type AiAddPrefill } from './aiRepSession';
import {
  CONFIDENCE_LABEL, FEEDBACK_REASONS, OBJECTIONS, OBJECTION_OUTCOMES, OUTCOMES, OUTCOME_LABEL, distKm, fmtDistance, fmtRange, multiStopUrl, navUrl,
  orderRoute, routeLegs, renderRefs,
} from './aiRepLogic';

/**
 * المندوب الذكي — شاشة المندوب:
 *   «القريبة»: خريطة Google داخل التطبيق + المحلات المستهدفة حوله (بحث الخادم) مدموجةً بسجلّ الشركة، وملخّص ما
 *     يُتوقّع أن يشتريه كل محل، ثم **توجيه العقل** تلقائياً بعد كل بحث (خطة مرقّمة ومسار).
 *   تفاصيل المحل: المتوقع لكل منتج وأول طلب وطلب تجريبي، ثم ملاحة / تسجيل نتيجة / إضافته عميلاً.
 *   «مساري»: المحطات بترتيب الخطة (أو الأقصر عند الطلب) وروابط الملاحة. «اسأل»: أسئلة حرّة للمستشار.
 * المراجع P1… والإحداثيات يثبّتها الخادم عند البحث (جلسة البحث)، فالجهاز يرسل المرجع لا الإحداثيات.
 * الأسماء من Google تبقى في الذاكرة أثناء الجلسة فقط؛ النسخة المحفوظة دون اتصال بلا أسماء ولمدة يوم واحد.
 * حلقة التعلّم: سبب التردّد بزر (لا نص حرّ للعقل)، و👍/👎 بأسباب ثابتة على كل رد يحمل turnId.
 */

interface Range { low: number; median: number; high: number }
interface Summary {
  ok: boolean; confidence?: string; peers?: number; ringKm?: number | null; monthlyTotalValue?: Range | null;
  top?: { name: string; unit: string; penetration: number; qtyMedian: number | null }[]; eligiblePeers?: number; minPeers?: number;
}
interface Item {
  ref: string; placeId: string; name: string; address: string | null; lat: number; lng: number; outletType: string; outletTypeLabel: string;
  distanceM: number; relation: 'NEW' | 'CUSTOMER' | 'POSSIBLE_CUSTOMER'; customerId: string | null;
  lastOutcome: string | null; lastOutcomeAt: string | null; rejectedRecently: boolean; estimate: Summary; closed?: boolean;
}
interface Me {
  placesConfigured: boolean; placesMode?: 'AUTO' | 'MANUAL'; mapsKey?: string | null; showMoney: boolean; searchRadiusM: number; minPeers?: number;
  targetTypes: { code: string; label: string }[]; dailySearches: { used: number; limit: number };
  advisor?: { available: boolean; reason: string | null; used: number; limit: number };
  learning?: { on: boolean };
}
interface ChatMsg { role: 'user' | 'assistant'; text: string; refs?: string[]; turnId?: string }
interface Guide { text: string; plan: string[]; source: 'AI' | 'RULES'; turnId?: string; learned?: boolean }
interface ProductEst {
  productId: string; name: string; unit: string; priority: boolean; buyers: number | null; peers: number; penetration: number | null;
  monthlyQty: Range | null; monthlyValue: Range | null; firstOrderQty: number | null; trialQty: number | null; confidence: string; hidden: null | 'FEW_BUYERS' | 'DOMINANT';
  trialCalibrated?: boolean;
}
interface Estimate { ok: boolean; confidence?: string; peers?: number; ringKm?: number | null; monthlyTotalValue?: Range | null; products?: ProductEst[]; why: string; minPeers?: number }
type Tab = 'near' | 'route' | 'ask';

const LAST_KEY = 'ai-rep:last';
const ME_KEY = 'ai-rep:me';
const LAST_MAX_AGE_MS = 24 * 60 * 60 * 1000; // إحداثيات Google على الجهاز يوماً واحداً كحدّ أقصى (الشروط: ٣٠ يوماً)
const ADD_PIN_MAX_M = 75;

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

const errMsg = (e: unknown): string | undefined => (e as { response?: { data?: { message?: string } } })?.response?.data?.message;
const errCode = (e: unknown): string | undefined => (e as { response?: { data?: { code?: string } } })?.response?.data?.code;

export default function RepAiScreen({ repId, canAddCustomer, onBack, onAddCustomer, onOpenCustomer }: {
  repId: string;
  canAddCustomer: boolean;
  onBack: () => void;
  onAddCustomer: (prefill: AiAddPrefill) => void;
  onOpenCustomer: (customerId: string) => Promise<boolean>;
}) {
  const tr = useAiRepTr();
  const restored = useRef(loadAiSession(repId)).current;
  const [me, setMe] = useState<Me | null>(null);
  const [offline, setOffline] = useState(false);
  const [meErr, setMeErr] = useState<string | null>(null);
  const [types, setTypes] = useState<string[]>([]);
  const [items, setItems] = useState<Item[] | null>((restored?.items as Item[] | null) ?? null);
  const [searchId, setSearchId] = useState<string | null>(restored?.searchId ?? null);
  const [cachedAt, setCachedAt] = useState<number | null>(null);
  const [origin, setOrigin] = useState<{ lat: number; lng: number; accuracy: number } | null>(restored?.origin ?? null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [tab, setTab] = useState<Tab>(restored?.tab ?? 'near');
  const [chat, setChat] = useState<ChatMsg[]>((restored?.chat as ChatMsg[]) ?? []);
  const [askDraft, setAskDraft] = useState(restored?.askDraft ?? '');
  const [routeIds, setRouteIds] = useState<string[]>(restored?.routeIds ?? []);
  const [open, setOpen] = useState<Item | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [g, setG] = useState<any>(null);
  const [mapErr, setMapErr] = useState(false);
  const [mapAttempt, setMapAttempt] = useState(0);
  const [guide, setGuide] = useState<Guide | null>((restored?.guide as Guide | null) ?? null);
  const [guiding, setGuiding] = useState(false);
  const searchIdRef = useRef(searchId);
  searchIdRef.current = searchId;

  // حالة الشاشة في ذاكرة الجلسة: الرجوع أو «أضفه عميلاً» يفكّكان الشاشة، فتعود كما كانت
  useEffect(() => {
    saveAiSession({ repId, searchId, items, origin, guide, routeIds, chat, askDraft, tab });
  }, [repId, searchId, items, origin, guide, routeIds, chat, askDraft, tab]);

  // عميل أُنشئ من محلٍّ مقترح ⇒ يصير «عميلاً حالياً» هنا (لا يُضاف مرة ثانية)
  useEffect(() => onConverted((placeId, customerId) => {
    setItems(list => (list ?? []).map(x => (x.placeId === placeId ? { ...x, relation: 'CUSTOMER', customerId, lastOutcome: 'CONVERTED' } : x)));
    setRouteIds(ids => ids.filter(id => id !== placeId));
  }), []);

  // التحميل عند التركيب وعند عودة الاتصال (لا تبعيات متغيّرة أخرى — كانت تُسبّب حلقة طلبات)
  const [meTick, setMeTick] = useState(0);
  useEffect(() => {
    const on = () => setMeTick(n => n + 1);
    window.addEventListener('online', on);
    return () => window.removeEventListener('online', on);
  }, []);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await repApi.get('/ai-rep/rep/me');
        const d = r.data.data as Me;
        if (!alive) return;
        setMe(d); setOffline(false);
        setTypes(t => (t.length ? t : d.targetTypes.map(x => x.code)));
        void cacheSet(ME_KEY, d);
      } catch (e) {
        if (!alive) return;
        if (isNetworkError(e)) {
          const hit = await cacheGet<Me>(ME_KEY).catch(() => null);
          if (hit?.data) { setMe(hit.data); setOffline(true); setTypes(t => (t.length ? t : hit.data.targetTypes.map(x => x.code))); }
          else setMeErr('OFFLINE');
        } else setMeErr(errMsg(e) || 'LOAD_FAILED');
      }
      if (!restored?.items && meTick === 0) {
        const hit = await cacheGet<{ savedAt: number; items: Item[] } | null>(LAST_KEY).catch(() => null);
        const saved = hit?.data;
        if (saved && Date.now() - saved.savedAt >= LAST_MAX_AGE_MS) void cacheSet(LAST_KEY, null); // انتهت: تُحذف لا تُتجاهل
        else if (alive && saved?.items?.length) { setItems(prev => prev ?? saved.items); setCachedAt(saved.savedAt); }
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meTick]);

  // الخريطة داخل التطبيق (مفتاح عرض فقط) — بمهلة وإعادة محاولة
  useEffect(() => {
    if (!me?.mapsKey || offline) return;
    let alive = true;
    setMapErr(false);
    loadGoogleMaps(me.mapsKey).then(gg => { if (alive) setG(gg); }).catch(() => { if (alive) setMapErr(true); });
    return () => { alive = false; };
  }, [me?.mapsKey, offline, mapAttempt]);

  const itemById = useMemo(() => new Map((items ?? []).map(i => [i.placeId, i])), [items]);
  const visibleItems = useMemo(() => (items ?? []).filter(i => !i.closed), [items]);
  const names = useMemo(() => (items ?? []).map(it => ({ ref: it.ref, label: it.name || `${tr(it.outletTypeLabel)} ${fmtDistance(it.distanceM)}` })), [items, tr]);
  const routeItems = useMemo(() => routeIds.map(id => itemById.get(id)).filter((x): x is Item => !!x && !x.closed), [routeIds, itemById]);
  const legs = useMemo(() => (origin ? routeLegs(origin, routeItems) : []), [origin, routeItems]);
  const mapItems = useMemo(() => visibleItems.map(i => ({ placeId: i.placeId, lat: i.lat, lng: i.lng, relation: i.relation, rejectedRecently: i.rejectedRecently, name: i.name, closed: i.closed })), [visibleItems]);
  const selectOnMap = useCallback((id: string) => { const it = itemById.get(id); if (it) setOpen(it); }, [itemById]);
  const money = useCallback((n: number) => formatCurrency(n, undefined, 0), []);
  const limitReached = !!me && me.dailySearches.used >= me.dailySearches.limit;
  // بلا مفتاح بحث Google: خرائط Google بحساب المندوب، وهو يضيف المحلات (رابط مشاركة أو «أنا عند المحل الآن»)
  const manual = !!me && (me.placesMode ? me.placesMode === 'MANUAL' : !me.placesConfigured);

  const routeEditedRef = useRef(false);
  const runGuide = useCallback(async (sid: string, list: Item[]) => {
    setGuiding(true);
    try {
      const gr = await repApi.post('/ai-rep/rep/guide', { searchId: sid });
      const gd = gr.data.data as Guide;
      const byRef = new Map(list.map(i => [i.ref, i.placeId]));
      const planIds = gd.plan.map(r => byRef.get(r)).filter((x): x is string => !!x);
      if (loadAiSession(repId)?.searchId === sid) patchAiSession(repId, { guide: gd, routeIds: planIds });
      if (searchIdRef.current !== sid) return; // بحث أحدث وصل — لا نخلط الخطط
      setGuide(gd);
      // خطة المستشار أولاً ثم ما أضافه المندوب يدوياً أثناء الانتظار
      setRouteIds(ids => (routeEditedRef.current ? [...planIds, ...ids.filter(id => !planIds.includes(id))] : planIds));
      if (gd.source === 'AI') setMe(m => (m?.advisor ? { ...m, advisor: { ...m.advisor, used: m.advisor.used + 1 } } : m));
    } catch { /* التوجيه اختياري: القائمة والخريطة تبقيان */ }
    finally { if (searchIdRef.current === sid) setGuiding(false); }
  }, [repId]);

  const search = useCallback(async () => {
    if (!me || busy) return;
    if (limitReached) { setMsg(tr('بلغت حدّ البحث اليومي — نتائجك الحالية تبقى متاحة')); return; }
    setBusy(true); setMsg('');
    try {
      const gps = await getGps().catch(() => null);
      if (!gps) { setMsg(tr('فعّل الموقع لنعرف المحلات القريبة منك')); return; }
      const r = await repApi.post('/ai-rep/rep/nearby', { lat: gps.lat, lng: gps.lng, accuracyM: gps.accuracy, types });
      const sid = r.data.data.searchId as string;
      const list = (r.data.data.items ?? []) as Item[];
      searchIdRef.current = sid;
      routeEditedRef.current = false;
      patchAiSession(repId, { searchId: sid, items: list, origin: gps, guide: null, routeIds: [], chat: [] });
      setOrigin(gps); setSearchId(sid); setItems(list); setCachedAt(null);
      setChat([]); setGuide(null); setRouteIds([]); setOpen(null); setGuiding(false);
      setMe(m => (m ? { ...m, dailySearches: { ...m.dailySearches, used: m.dailySearches.used + 1 } } : m));
      // الحفظ دون اتصال بلا أسماء ولا عناوين، ولمدة يوم (شروط Google)
      void cacheSet(LAST_KEY, { savedAt: Date.now(), items: list.map(i => ({ ...i, name: '', address: null })) });
      if (!list.length) { setMsg(tr('لا محلات مستهدفة في هذا النطاق — جرّب نوعاً آخر أو تحرّك قليلاً')); return; }
      void runGuide(sid, list);
    } catch (e) {
      setMsg(errMsg(e) || (isNetworkError(e) ? tr('أنت دون اتصال — البحث يحتاج الإنترنت') : tr('تعذّر البحث')));
      if (errCode(e) === 'AI_REP_DAILY_LIMIT') setMe(m => (m ? { ...m, dailySearches: { ...m.dailySearches, used: m.dailySearches.limit } } : m));
    } finally { setBusy(false); }
  }, [me, busy, limitReached, types, tr, runGuide, repId]);

  // محلٌّ أضافه المندوب يدوياً: يُلحق بالجلسة نفسها، أو يبدأ جلسة جديدة إن انتهت القديمة على الخادم
  const onManualAdded = useCallback((sid: string, item: Item, gps: { lat: number; lng: number; accuracy: number } | null) => {
    if (sid !== searchIdRef.current) {
      searchIdRef.current = sid;
      routeEditedRef.current = false;
      setSearchId(sid); setItems([item]); setGuide(null); setRouteIds([]); setChat([]);
    } else {
      setItems(list => {
        const l = list ?? [];
        return l.some(x => x.placeId === item.placeId) ? l.map(x => (x.placeId === item.placeId ? item : x)) : [...l, item];
      });
    }
    if (gps) setOrigin(o => o ?? gps);
    setCachedAt(null); setMsg(''); setOpen(item);
  }, []);

  const inRoute = useCallback((id: string) => routeIds.includes(id), [routeIds]);
  const toggleRoute = (it: Item) => { routeEditedRef.current = true; setRouteIds(ids => (ids.includes(it.placeId) ? ids.filter(x => x !== it.placeId) : [...ids, it.placeId])); };
  const shortestOrder = () => { if (origin) setRouteIds(orderRoute(origin, routeItems).map(i => i.placeId)); };

  const onOutcome = (placeId: string, kind: string) => {
    setItems(list => (list ?? []).map(x => (x.placeId === placeId
      ? { ...x, lastOutcome: kind, lastOutcomeAt: new Date().toISOString(), rejectedRecently: kind === 'NOT_INTERESTED' || kind === 'EXCLUSIVE_SUPPLIER', closed: kind === 'CLOSED' || x.closed }
      : x)));
    if (kind === 'CLOSED') { setRouteIds(ids => ids.filter(id => id !== placeId)); setOpen(null); }
  };

  if (meErr && !me) {
    return (
      <div className="p-4 space-y-4 h-full">
        <Header onBack={onBack} title={tr('المندوب الذكي')} />
        <p className="text-center text-sm text-gray-500 py-10">{meErr === 'OFFLINE' ? tr('أنت دون اتصال') : meErr === 'LOAD_FAILED' ? tr('تعذّر تحميل المندوب الذكي') : meErr}</p>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col relative">
      <div className="p-4 pb-2 space-y-3 flex-shrink-0">
        <Header onBack={onBack} title={tr('المندوب الذكي')}
          right={origin ? <span className="text-[11px] text-gray-400 flex items-center gap-1"><Crosshair size={11} /> {origin.accuracy <= 50 ? tr('موقعك دقيق') : tr('موقعك تقريبي')}</span> : null} />
        {offline && <p className="text-xs rounded-xl bg-amber-50 border border-amber-200 text-amber-800 p-2.5">{tr('أنت دون اتصال — تظهر آخر نتائجك، والبحث والمستشار يعودان مع الاتصال')}</p>}
        <div className="grid grid-cols-3 gap-2 bg-gray-100 rounded-xl p-1">
          {(['near', 'route', 'ask'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)} className={`py-2 rounded-lg text-sm font-semibold ${tab === t ? 'bg-white text-[#E15A30] shadow-sm' : 'text-gray-500'}`}>
              {t === 'near' ? tr('القريبة') : t === 'route' ? `${tr('مساري')} (${routeItems.length})` : tr('اسأل')}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 pb-24">
        {/* «القريبة» تبقى مركّبة (مخفية) بين التبويبات: الخريطة لا تُنشأ من جديد (تحميل مدفوع) */}
        <div hidden={tab !== 'near'} className="space-y-3">
          {me && manual && (
            <ManualPanel me={me} offline={offline} searchId={searchId} origin={origin} onOrigin={setOrigin} onAdded={onManualAdded}
              canGuide={!!searchId && !!visibleItems.length} guiding={guiding} onGuide={() => { if (searchId && items) void runGuide(searchId, items); }} />
          )}
          {me && !manual && (
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
          {!manual && (
            <button onClick={search} disabled={busy || !me?.placesConfigured || offline || limitReached}
              className="w-full flex items-center justify-center gap-2 bg-[#E15A30] disabled:opacity-50 text-white rounded-2xl py-3.5 font-bold">
              <Sparkles size={18} /> {busy ? tr('أبحث في المحلات القريبة…') : limitReached ? tr('بلغت حدّ البحث اليومي') : tr('ابحث عن فرص حولي')}
            </button>
          )}
          {me && !manual && <p className="text-[11px] text-gray-400 text-center">{tr('بحث اليوم')}: {me.dailySearches.used} / {me.dailySearches.limit} · {tr('النطاق')} {fmtDistance(me.searchRadiusM)}</p>}
          {msg && <p className="text-sm text-center text-gray-500">{msg}</p>}
          {cachedAt && <p className="text-[11px] text-amber-700 text-center">{tr('نتائج محفوظة من')} {new Date(cachedAt).toLocaleTimeString()} — {tr('الأسماء تظهر عند البحث من جديد')}</p>}

          {me?.mapsKey && !manual && !offline && (g
            ? <RepAiMap g={g} origin={origin} items={mapItems} plan={routeIds} fitKey={searchId} visible={tab === 'near'} onSelect={selectOnMap} />
            : (
              <div className="w-full h-64 rounded-2xl bg-gray-100 flex flex-col items-center justify-center gap-2 text-xs text-gray-500">
                {mapErr
                  ? <><span>{tr('تعذّر تحميل خريطة Google — تحقّق من الاتصال')}</span><button onClick={() => setMapAttempt(n => n + 1)} className="rounded-lg border border-gray-300 px-3 py-1.5 font-semibold">{tr('أعد المحاولة')}</button></>
                  : tr('جاري تحميل الخريطة…')}
              </div>
            ))}

          {guiding && <p className="text-sm text-center text-[#C94E28]">{tr('المستشار يفحص المحلات المجاورة…')}</p>}
          {guide && (
            <div className="rounded-2xl border border-[#F5DACE] bg-[#FBEBE2] p-4 space-y-2">
              <p className="text-xs font-bold text-[#C94E28] flex items-center gap-1.5"><Sparkles size={14} /> {guide.source === 'AI' ? tr('توجيه المستشار الذكي') : tr('خطة من بيانات شركتك')}</p>
              {guide.learned && <p className="text-[11px] text-[#C94E28]/80">{tr('الترتيب متعلَّم من نتائج زيارات فريقك')}</p>}
              <p className="text-sm text-[#1F1A13] whitespace-pre-wrap leading-6">{renderRefs(guide.text, names)}</p>
              <GoogleAttribution />
              {!!routeItems.length && (() => {
                const url = multiStopUrl(routeItems);
                return (
                  <div className="flex gap-2">
                    {url && <a href={url} target="_blank" rel="noreferrer" className="flex-1 flex items-center justify-center gap-1.5 rounded-xl bg-[#1F1A13] text-white py-2.5 text-sm font-bold"><Navigation size={15} /> {tr('ابدأ الخطة في خرائط Google')}</a>}
                    <button onClick={() => setTab('route')} className="rounded-xl border border-[#E15A30] text-[#E15A30] px-3 text-sm font-semibold">{tr('مساري')}</button>
                  </div>
                );
              })()}
              {guide.turnId && !offline && <FeedbackBar key={guide.turnId} turnId={guide.turnId} />}
            </div>
          )}

          {!!visibleItems.length && !(me?.mapsKey && g && !offline) && <GoogleAttribution />}
          {visibleItems.map(it => (
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
          {!!visibleItems.length && <GoogleAttribution />}
          {me?.learning?.on && !!visibleItems.length && <LearningFooter />}
        </div>

        {tab === 'route' && (
          <RouteTab legs={legs} hasOrigin={!!origin} onRemove={id => setRouteIds(ids => ids.filter(x => x !== id))} onOpen={setOpen} onShortest={shortestOrder} />
        )}
        {tab === 'ask' && (
          <AskTab me={me} offline={offline} searchId={searchId} names={names} chat={chat} setChat={setChat} draft={askDraft} setDraft={setAskDraft}
            searchIdRef={searchIdRef}
            onUsed={() => setMe(m => (m?.advisor ? { ...m, advisor: { ...m.advisor, used: m.advisor.used + 1 } } : m))}
            onOpenRef={ref => { const it = (items ?? []).find(i => i.ref === ref && !i.closed); if (it) setOpen(it); }}
            onExpired={() => { searchIdRef.current = null; setSearchId(null); setMsg(tr('انتهت نتيجة البحث — ابحث من جديد')); }} />
        )}
      </div>

      {open && (
        <OutletSheet item={open} searchId={searchId} showMoney={!!me?.showMoney} money={money} minPeers={me?.minPeers ?? 5}
          canAddCustomer={canAddCustomer} offline={offline} onClose={() => setOpen(null)}
          inRoute={inRoute(open.placeId)} onToggleRoute={() => toggleRoute(open)}
          onAddCustomer={onAddCustomer} onOpenCustomer={onOpenCustomer}
          onAsk={me?.advisor?.available && !offline ? () => { setOpen(null); setTab('ask'); setAskDraft(`وش أعرض على ${open.ref}؟ وكم الكمية المناسبة؟`); } : undefined}
          onOutcome={kind => onOutcome(open.placeId, kind)} />
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

/**
 * خريطة Google الموحّدة داخل التطبيق قبل ضبط مفتاح البحث للمنصّة: خريطة Google مضمّنة حول المندوب بنوع المحل
 * المختار (نفسها لكل من فُعّلت له الميزة). المندوب يضغط «أنا عند المحل الآن» عند باب المحل، أو يلصق رابط محل —
 * فيضيفه الخادم للجلسة ويحسب توقّع مشترياته، ثم يوجّهه العقل على المحلات المضافة.
 */
function ManualPanel({ me, offline, searchId, origin, onOrigin, onAdded, canGuide, guiding, onGuide }: {
  me: Me; offline: boolean; searchId: string | null; origin: { lat: number; lng: number; accuracy: number } | null;
  onOrigin: (o: { lat: number; lng: number; accuracy: number }) => void;
  onAdded: (sid: string, item: Item, gps: { lat: number; lng: number; accuracy: number } | null) => void;
  canGuide: boolean; guiding: boolean; onGuide: () => void;
}) {
  const tr = useAiRepTr();
  const [type, setType] = useState(me.targetTypes[0]?.code ?? '');
  const [text, setText] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<'' | 'map' | 'link' | 'here'>('');
  const [err, setErr] = useState('');
  const word = tr(me.targetTypes.find(t => t.code === type)?.label ?? '');
  const hl = (document.documentElement.lang || 'ar').slice(0, 2);
  const embed = origin
    ? `https://maps.google.com/maps?q=${encodeURIComponent(word)}&ll=${origin.lat.toFixed(5)},${origin.lng.toFixed(5)}&z=15&hl=${hl}&output=embed`
    : null;
  const locate = useCallback(async () => {
    setBusy('map'); setErr('');
    const gps = await getGps().catch(() => null);
    setBusy('');
    if (!gps) { setErr(tr('فعّل الموقع لنعرف المحلات القريبة منك')); return; }
    onOrigin(gps);
  }, [onOrigin, tr]);
  // الخريطة تظهر مباشرة عند فتح الشاشة (موقع المندوب مطلوب لتوسيطها)
  const autoLocated = useRef(false);
  useEffect(() => {
    if (autoLocated.current || origin || offline) return;
    autoLocated.current = true;
    void locate();
  }, [origin, offline, locate]);

  const paste = async () => {
    try { const t = await navigator.clipboard.readText(); if (t) setText(t.slice(0, 2000)); } catch { /* المتصفح منع القراءة: يلصق المندوب بنفسه */ }
  };

  const add = async (here: boolean) => {
    if (!type || busy) return;
    setBusy(here ? 'here' : 'link'); setErr('');
    try {
      const gps = await getGps().catch(() => null);
      if (here && !gps) { setErr(tr('فعّل الموقع لنعرف المحلات القريبة منك')); return; }
      const body = {
        outletType: type,
        ...(searchId && { searchId }),
        ...(name.trim() && { name: name.trim() }),
        ...(here && gps ? { here: { lat: gps.lat, lng: gps.lng, accuracyM: gps.accuracy } } : { text: text.trim() }),
        ...(gps && { gps: { lat: gps.lat, lng: gps.lng } }),
      };
      const r = await repApi.post('/ai-rep/rep/manual', body);
      onAdded(r.data.data.searchId as string, r.data.data.item as Item, gps);
      setText(''); setName('');
    } catch (e) {
      setErr(errMsg(e) || (isNetworkError(e) ? tr('أنت دون اتصال — البحث يحتاج الإنترنت') : tr('تعذّرت إضافة المحل')));
    } finally { setBusy(''); }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5">
        {me.targetTypes.map(t => (
          <button key={t.code} onClick={() => setType(t.code)}
            className={`text-xs rounded-full px-3 py-1.5 border ${type === t.code ? 'bg-[#FBEBE2] border-[#F5DACE] text-[#C94E28] font-semibold' : 'bg-white border-gray-200 text-gray-500'}`}>
            {tr(t.label)}
          </button>
        ))}
      </div>

      {embed && !offline ? (
        <iframe title={tr('خريطة Google')} src={embed} className="w-full h-64 rounded-2xl border border-gray-100" loading="lazy" referrerPolicy="no-referrer-when-downgrade" />
      ) : (
        <button onClick={locate} disabled={offline || busy === 'map'} className="w-full h-40 rounded-2xl bg-gray-100 flex flex-col items-center justify-center gap-2 text-sm text-gray-600 disabled:opacity-60">
          <MapPin size={22} className="text-[#E15A30]" /> {busy === 'map' ? tr('أحدد موقعك…') : tr('اعرض المحلات حولي على خريطة Google')}
        </button>
      )}

      <div className="rounded-2xl border border-gray-100 bg-white p-3.5 space-y-2">
        <p className="text-sm font-bold text-[#1F1A13] flex items-center gap-1.5"><Plus size={15} className="text-[#E15A30]" /> {tr('أضف محلاً ليحسب له العقل التوقّع')}</p>
        <p className="text-[11px] text-gray-500">{tr('عند باب المحل اضغط «أنا عند المحل الآن»، أو الصق رابط المحل من خرائط Google')}</p>
        <div className="flex gap-2">
          <textarea value={text} onChange={e => setText(e.target.value)} maxLength={2000} dir="auto" rows={2}
            placeholder={tr('الصق رابط المحل من خرائط Google')} className="flex-1 rounded-xl border border-gray-200 px-3 py-2 text-sm" />
          <button onClick={paste} className="rounded-xl border border-gray-200 px-3 text-xs font-semibold text-gray-600">{tr('الصق')}</button>
        </div>
        <input value={name} onChange={e => setName(e.target.value)} maxLength={120} placeholder={tr('اسم المحل (اختياري)')}
          className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm" />
        <div className="grid grid-cols-2 gap-2">
          <button onClick={() => add(false)} disabled={offline || !!busy || !text.trim()} className="rounded-xl bg-[#E15A30] disabled:opacity-50 text-white py-2.5 text-sm font-bold">
            {busy === 'link' ? tr('أحسب المتوقع من بيانات شركتك…') : tr('أضف وتوقّع')}
          </button>
          <button onClick={() => add(true)} disabled={offline || !!busy} className="rounded-xl border border-[#E15A30] text-[#E15A30] disabled:opacity-50 py-2.5 text-sm font-bold flex items-center justify-center gap-1">
            <Crosshair size={14} /> {busy === 'here' ? tr('أحدد موقعك…') : tr('أنا عند المحل الآن')}
          </button>
        </div>
        {err && <p className="text-xs text-red-600">{err}</p>}
      </div>

      {canGuide && (
        <button onClick={onGuide} disabled={guiding || offline} className="w-full flex items-center justify-center gap-2 rounded-2xl border-2 border-[#E15A30] text-[#C94E28] disabled:opacity-50 py-3 text-sm font-bold">
          <Sparkles size={16} /> {guiding ? tr('المستشار يفحص المحلات المجاورة…') : tr('اطلب توجيه المستشار للمحلات المضافة')}
        </button>
      )}
    </div>
  );
}

/** نسب Google Maps بجوار أي اسم أو عنوان من Places يُعرض بلا خريطة (شرط Google). */
function GoogleAttribution() {
  return <p className="text-xs text-gray-500 text-left" dir="ltr">Google Maps</p>;
}

function LearningFooter() {
  const tr = useAiRepTr();
  return <p className="text-[10px] text-gray-400 text-center">{tr('المستشار يتعلّم من نتائج زيارات شركتك — الأرقام من بياناتكم فقط')}</p>;
}

/** تقييمات الجلسة لكل turnId: الرجوع بين التبويبات لا يعيد سؤال «هل أفادك؟» عن رد قُيّم. */
const feedbackGiven = new Map<string, { vote: 1 | -1; reason: string | null }>();

/**
 * 👍/👎 على رد المستشار (best-effort). 👎 يفتح أسباباً ثابتة اختيارية (لا نص حرّ). إعادة التقييم تستبدل السابق على الخادم.
 * الشكر يظهر بعد قبول الخادم فقط؛ رد انتهت مهلته (404) يُخفي الشريط، وخطأ الشبكة يُعيده ليُعاد المحاولة.
 */
function FeedbackBar({ turnId }: { turnId: string }) {
  const tr = useAiRepTr();
  const [fb, setFb] = useState(() => feedbackGiven.get(turnId) ?? null);
  const [sending, setSending] = useState(false);
  const [gone, setGone] = useState(false);
  const send = async (vote: 1 | -1, reason: string | null = null) => {
    if (sending) return;
    const prev = fb;
    setFb({ vote, reason }); setSending(true);
    try {
      await repApi.post('/ai-rep/rep/feedback', { turnId, vote, ...(reason ? { reason } : {}) });
      feedbackGiven.set(turnId, { vote, reason });
    } catch (e) {
      const status = (e as { response?: { status?: number } })?.response?.status;
      if (status === 404) setGone(true); else setFb(prev);
    } finally { setSending(false); }
  };
  if (gone) return null;
  const saved = !sending && feedbackGiven.has(turnId);
  return (
    <div className="pt-2 space-y-1.5">
      {!fb ? (
        <div className="flex items-center gap-2 text-[11px] text-gray-500">
          <span>{tr('هل أفادك؟')}</span>
          <button onClick={() => send(1)} className="inline-flex items-center gap-1 rounded-full border border-gray-200 bg-white px-2.5 py-1 text-gray-600"><ThumbsUp size={12} /> {tr('مفيد')}</button>
          <button onClick={() => send(-1)} className="inline-flex items-center gap-1 rounded-full border border-gray-200 bg-white px-2.5 py-1 text-gray-600"><ThumbsDown size={12} /> {tr('غير مفيد')}</button>
        </div>
      ) : fb.vote === -1 && (
        <div className="flex flex-wrap gap-1.5">
          {FEEDBACK_REASONS.map(r => (
            <button key={r.code} disabled={sending} onClick={() => send(-1, fb.reason === r.code ? null : r.code)}
              className={`text-[11px] rounded-full px-2.5 py-1 border ${fb.reason === r.code ? 'bg-[#FBEBE2] border-[#F5DACE] text-[#C94E28] font-semibold' : 'bg-white border-gray-200 text-gray-500'}`}>
              {tr(r.label)}
            </button>
          ))}
        </div>
      )}
      {fb && saved && <p className="text-[11px] text-green-700">{tr('شكراً — المستشار يتعلّم من تقييمك')}</p>}
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
        <p className="text-sm font-bold text-[#E15A30]">{tr('متوقع شهرياً')}: {fmtRange(s.monthlyTotalValue, money)} <span className="text-[10px] font-normal text-gray-500">{tr('قبل الضريبة')}</span></p>
      )}
      {t && <p className="text-[11px] text-gray-600">{t.name}: {t.qtyMedian != null ? `${t.qtyMedian} ${t.unit} / ${tr('شهر')}` : tr('يشتريه')} · {Math.round(t.penetration * 100)}٪ {tr('من المحلات المشابهة')}</p>}
      <p className="text-[10px] text-gray-400">{tr(CONFIDENCE_LABEL[s.confidence ?? 'LOW'])} · {tr('من')} {s.peers} {tr('محلات مشابهة')}</p>
    </div>
  );
}

function RouteTab({ legs, hasOrigin, onRemove, onOpen, onShortest }: {
  legs: Array<Item & { legKm: number; cumKm: number; etaMin: number }>; hasOrigin: boolean; onRemove: (id: string) => void; onOpen: (it: Item) => void; onShortest: () => void;
}) {
  const tr = useAiRepTr();
  if (!legs.length) return <p className="text-center text-sm text-gray-400 py-10">{hasOrigin ? tr('أضف محلات إلى مسارك من قائمة القريبة') : tr('ابحث عن الفرص أولاً ثم أضف محلات إلى مسارك')}</p>;
  const all = multiStopUrl(legs);
  const last = legs[legs.length - 1];
  return (
    <div className="space-y-3">
      <div className="rounded-2xl bg-[#1F1A13] text-white p-4">
        <p className="text-xs text-white/60">{tr('مسارك')}</p>
        <p className="text-lg font-bold">{legs.length} {tr('محطات')} · {last.cumKm.toFixed(1)} {tr('كم')} · ~{last.etaMin} {tr('دقيقة قيادة')}</p>
        <p className="text-[10px] text-white/50 mt-1">{tr('بترتيب الخطة؛ الزمن تقديري')}</p>
        <div className="mt-3 flex gap-2">
          {all && <a href={all} target="_blank" rel="noreferrer" className="flex-1 flex items-center justify-center gap-2 bg-[#E15A30] rounded-xl py-2.5 font-bold text-sm"><Navigation size={16} /> {legs.length > 4 ? tr('ابدأ أول ٤ محطات في خرائط Google') : tr('ابدأ المسار في خرائط Google')}</a>}
          {legs.length > 2 && <button onClick={onShortest} className="rounded-xl border border-white/30 px-3 text-xs font-semibold flex items-center gap-1"><Shuffle size={13} /> {tr('رتّب الأقصر')}</button>}
        </div>
      </div>
      {legs.map((s, i) => (
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
      <GoogleAttribution />
    </div>
  );
}

function AskTab({ me, offline, searchId, names, chat, setChat, draft, setDraft, searchIdRef, onUsed, onOpenRef, onExpired }: {
  me: Me | null; offline: boolean; searchId: string | null; names: { ref: string; label: string }[];
  chat: ChatMsg[]; setChat: (f: (c: ChatMsg[]) => ChatMsg[]) => void; draft: string; setDraft: (s: string) => void;
  searchIdRef: { current: string | null }; onUsed: () => void; onOpenRef: (ref: string) => void; onExpired: () => void;
}) {
  const tr = useAiRepTr();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const adv = me?.advisor;
  if (!adv) return <p className="text-center text-sm text-gray-400 py-10">{tr('جاري التحميل')}</p>;
  if (offline) return <p className="text-center text-sm text-gray-500 py-10">{tr('المستشار يحتاج الإنترنت')}</p>;
  if (!adv.available) {
    return <p className="text-center text-sm text-gray-500 py-10">{adv.reason === 'DISABLED_BY_COMPANY' ? tr('المستشار الذكي متوقف لشركتك') : tr('المستشار الذكي لم يُفعَّل بعد لدى مزوّد الخدمة')}</p>;
  }
  const ask = async (text: string) => {
    const q = text.trim().slice(0, 1500);
    if (!q || busy) return;
    if (!navigator.onLine) { setErr(tr('المستشار يحتاج الإنترنت')); return; }
    const sid = searchIdRef.current;
    const next: ChatMsg[] = [...chat, { role: 'user', text: q }];
    setChat(() => next); setDraft(''); setBusy(true); setErr('');
    try {
      const r = await repApi.post('/ai-rep/rep/chat', {
        messages: next.slice(-8).map(m => ({ role: m.role, text: m.text.slice(0, m.role === 'assistant' ? 6000 : 1500) })),
        ...(sid && { searchId: sid }),
      });
      if (searchIdRef.current !== sid) return; // بحث جديد بدأ محادثة جديدة — الرد القديم لا يُلحق بها
      const d = r.data.data as { text: string; refs: string[]; turnId?: string };
      setChat(c => [...c, { role: 'assistant', text: d.text, refs: d.refs, ...(d.turnId ? { turnId: d.turnId } : {}) }]);
      onUsed();
    } catch (e) {
      if (searchIdRef.current !== sid) return;
      setErr(errMsg(e) || (isNetworkError(e) ? tr('المستشار يحتاج الإنترنت') : tr('المستشار غير متاح مؤقتاً')));
      setChat(c => c.slice(0, -1)); setDraft(q);
      if (errCode(e) === 'AI_REP_SEARCH_EXPIRED') onExpired();
    } finally { setBusy(false); }
  };
  // سؤال خبرة الفريق يظهر حين يكون التعلّم مفعّلاً (أداة field_insights لا تُتاح للعقل وهو متوقف)
  const team = me?.learning?.on ? ['وش تعلّمت من زيارات فريقنا؟'] : [];
  const chips = searchId
    ? ['من أي محل أبدأ؟ ولماذا؟', 'رتّب لي مساراً لأفضل الفرص الجديدة', 'وش أعرض على أقرب فرصة جديدة؟', 'كيف أرد إذا قال: عندي مورّد؟', ...team]
    : ['كيف أرد إذا قال: عندي مورّد؟', 'كيف أفتح الحديث مع صاحب بقالة جديد؟', ...team];
  return (
    <div className="space-y-3">
      {!searchId && <p className="text-[11px] text-amber-700 bg-amber-50 rounded-xl p-2">{tr('ابحث عن الفرص أولاً ليعرف المستشار المحلات حولك')}</p>}
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
          {m.role === 'assistant' && m.turnId && <FeedbackBar key={m.turnId} turnId={m.turnId} />}
        </div>
      ))}
      {busy && <p className="text-xs text-gray-400">{tr('المستشار يحسب من بيانات شركتك…')}</p>}
      {err && <p className="text-xs text-red-600">{err}</p>}
      {chat.some(m => m.role === 'assistant') && <GoogleAttribution />}
      <div className="flex gap-2 sticky bottom-0 bg-white pt-2">
        <input value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void ask(draft); }} maxLength={1500}
          placeholder={tr('اسأل المستشار…')} className="flex-1 rounded-xl border border-gray-200 px-3 py-2.5 text-sm" />
        <button onClick={() => ask(draft)} disabled={busy || !draft.trim()} className="rounded-xl bg-[#E15A30] disabled:opacity-50 text-white px-3"><Send size={16} /></button>
      </div>
      <p className="text-[10px] text-gray-400 text-center">{tr('أسئلة اليوم')}: {adv.used} / {adv.limit} · {tr('الأرقام من بيانات شركتك؛ المستشار لا يخترعها')}</p>
      {me?.learning?.on && <LearningFooter />}
    </div>
  );
}

function OutletSheet({ item, searchId, showMoney, money, minPeers, canAddCustomer, offline, onClose, inRoute, onToggleRoute, onAddCustomer, onOpenCustomer, onOutcome, onAsk }: {
  item: Item; searchId: string | null; showMoney: boolean; money: (n: number) => string; minPeers: number; canAddCustomer: boolean; offline: boolean;
  onClose: () => void; inRoute: boolean; onToggleRoute: () => void;
  onAddCustomer: (p: AiAddPrefill) => void; onOpenCustomer: (id: string) => Promise<boolean>; onOutcome: (kind: string) => void; onAsk?: () => void;
}) {
  const tr = useAiRepTr();
  const [est, setEst] = useState<Estimate | null>(null);
  const [err, setErr] = useState('');
  const [mode, setMode] = useState<'view' | 'outcome'>('view');
  const [kind, setKind] = useState<string>('');
  const [objection, setObjection] = useState('');
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState('');
  const [adding, setAdding] = useState(false);
  const [outcomeErr, setOutcomeErr] = useState('');
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  // زر الرجوع وسحبة الحافة يغلقان الطبقة (لا يُخرجان من الشاشة فتضيع النتائج)
  useBackClose(true, onClose);
  useBackClose(mode === 'outcome', () => setMode('view'));

  useEffect(() => {
    let alive = true;
    if (!searchId || offline) { setErr(offline ? tr('أنت دون اتصال') : tr('ابحث من جديد لحساب التوقّع')); return; }
    repApi.post('/ai-rep/rep/estimate', { searchId, ref: item.ref })
      .then(r => { if (alive) setEst(r.data.data as Estimate); })
      .catch(e => { if (alive) setErr(errMsg(e) || (isNetworkError(e) ? tr('أنت دون اتصال') : tr('تعذّر حساب التوقّع'))); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.placeId, searchId, offline]);

  const submitOutcome = async () => {
    if (!kind) return;
    setSaving(true); setOutcomeErr('');
    const gps = await getGps().catch(() => null);
    const clientRef = newClientRef();
    // السبب زرٌّ اختياري يُرسل مع النتائج المؤهّلة وحدها؛ الجسم نفسه يدخل صفّ الإرسال دون اتصال
    const body = {
      clientRef, placeId: item.placeId, outletType: item.outletType, kind,
      ...(objection && OBJECTION_OUTCOMES.has(kind) ? { objection } : {}),
      ...(name.trim() && { repTypedName: name.trim() }), ...(note.trim() && { note: note.trim() }),
      ...(gps && { lat: gps.lat, lng: gps.lng, accuracyM: gps.accuracy }), occurredAt: new Date().toISOString(),
    };
    try {
      await repApi.post('/ai-rep/rep/outcomes', body);
      setSaved(tr('سُجّلت النتيجة'));
    } catch (e) {
      const status = (e as { response?: { status?: number } })?.response?.status;
      if (isNetworkError(e) || (status != null && status >= 500)) {
        // صفّ الإرسال الرسمي: يبقى بعد الخروج ويُرفع تلقائياً مع بقية مستندات المندوب (الخادم يمنع التكرار بـclientRef)
        await outboxAdd({ clientRef, repId: currentRepId(), kind: 'aiOutcome', payload: body, status: 'queued', clientCreatedAt: body.occurredAt });
        setSaved(tr('حُفظت وسترسل عند عودة الاتصال'));
      } else {
        setOutcomeErr(errMsg(e) || tr('تعذّر التسجيل'));
        setSaving(false);
        return;
      }
    }
    if (!alive.current) return;
    onOutcome(kind);
    setSaving(false); setMode('view');
  };

  const addAsCustomer = async () => {
    setAdding(true);
    // الموقع من GPS المندوب عند الباب فقط (لا من Google): يُعبّأ إن كان قريباً من المحل ودقيقاً، وإلا يلتقطه المندوب بنفسه
    const gps = await getGps().catch(() => null);
    if (!alive.current) return; // أُغلقت الطبقة أثناء انتظار الموقع
    setAdding(false);
    const near = gps && gps.accuracy <= 50 && distKm(gps, item) * 1000 <= ADD_PIN_MAX_M;
    onAddCustomer({ outletType: item.outletType, aiPlaceId: item.placeId, ...(near && gps ? { lat: gps.lat, lng: gps.lng } : {}) });
  };

  const openCustomer = async () => {
    if (!item.customerId) return;
    const ok = await onOpenCustomer(item.customerId);
    if (!ok && alive.current) setErr(tr('تعذّر فتح ملف العميل — تحقّق من الاتصال'));
  };

  return (
    <div className="absolute inset-0 z-40 bg-white flex flex-col" dir="rtl">
      <div className="p-4 flex items-start gap-2 border-b border-gray-100 flex-shrink-0">
        <div className="flex-1 min-w-0">
          <p className="font-bold text-[#1F1A13] flex items-center gap-1.5"><Store size={17} className="text-[#E15A30] shrink-0" /> <span className="truncate">{item.name || tr(item.outletTypeLabel)}</span></p>
          <p className="text-[11px] text-gray-400 mt-0.5">{tr(item.outletTypeLabel)} · {fmtDistance(item.distanceM)}{item.address ? ` · ${item.address}` : ''}</p>
          <GoogleAttribution />
        </div>
        <button onClick={onClose} className="p-2 text-gray-500"><X size={20} /></button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4 pb-40">
        {mode === 'outcome' ? (
          <div className="space-y-3">
            <p className="font-bold text-sm">{tr('نتيجة الزيارة')}</p>
            <div className="grid grid-cols-2 gap-2">
              {OUTCOMES.map(o => (
                <button key={o.kind} onClick={() => setKind(o.kind)}
                  className={`rounded-xl border py-2.5 text-sm ${kind === o.kind ? 'border-[#E15A30] bg-[#FBEBE2] text-[#C94E28] font-semibold' : 'border-gray-200 text-gray-600'}`}>{tr(o.label)}</button>
              ))}
            </div>
            {OBJECTION_OUTCOMES.has(kind) && (
              <div className="space-y-1.5">
                <p className="text-xs text-gray-500">{tr('سبب التردّد أو الرفض (يساعد العقل على التعلّم)')}</p>
                <div className="flex flex-wrap gap-1.5">
                  {OBJECTIONS.map(o => (
                    <button key={o.code} onClick={() => setObjection(x => (x === o.code ? '' : o.code))}
                      className={`text-xs rounded-full px-3 py-1.5 border ${objection === o.code ? 'bg-[#FBEBE2] border-[#F5DACE] text-[#C94E28] font-semibold' : 'bg-white border-gray-200 text-gray-500'}`}>
                      {tr(o.label)}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <input className="w-full rounded-xl border border-gray-200 px-3 py-2.5 text-sm" maxLength={120} placeholder={tr('اسم المحل كما في اللوحة (اختياري)')} value={name} onChange={e => setName(e.target.value)} />
            <textarea className="w-full rounded-xl border border-gray-200 px-3 py-2.5 text-sm min-h-[72px]" maxLength={500} placeholder={tr('ملاحظة (اختياري)')} value={note} onChange={e => setNote(e.target.value)} />
            {outcomeErr && <p className="text-xs text-red-600">{outcomeErr}</p>}
            <div className="flex gap-2">
              <button onClick={() => setMode('view')} className="flex-1 rounded-xl border border-gray-200 py-2.5 text-sm">{tr('رجوع')}</button>
              <button onClick={submitOutcome} disabled={!kind || saving} className="flex-1 rounded-xl bg-[#E15A30] disabled:opacity-50 text-white py-2.5 text-sm font-bold">{saving ? tr('جاري الحفظ') : tr('سجّل')}</button>
            </div>
          </div>
        ) : (
          <>
            {saved && <p className="text-xs text-center text-green-700 bg-green-50 rounded-xl py-2">{saved}</p>}
            {est && err && <p className="text-xs text-center text-red-600 bg-red-50 rounded-xl py-2">{err}</p>}
            {!est ? (
              <p className="text-center text-sm text-gray-400 py-8">{err || tr('أحسب المتوقع من بيانات شركتك…')}</p>
            ) : !est.ok ? (
              <div className="rounded-2xl bg-amber-50 border border-amber-200 p-4 text-sm text-amber-800">{est.why}</div>
            ) : (
              <>
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
                    <p className="text-[10px] text-gray-400 mt-2">{est.products.some(p => p.trialQty && p.trialCalibrated)
                      ? tr('مُعايَر بأول طلبات عملائك الجدد الفعلية')
                      : tr('من أول طلبات المحلات المشابهة أو أدنى مشترياتها الشهرية، للأصناف التي يشتريها نصفها على الأقل')}</p>
                  </div>
                )}
                <div className="rounded-2xl border border-gray-100 p-4">
                  <p className="font-bold text-sm mb-2">{tr('المتوقع لكل منتج')}</p>
                  <div className="space-y-2.5">
                    {est.products?.map(p => (
                      <div key={p.productId} className="border-b border-gray-50 pb-2 last:border-0">
                        <div className="flex justify-between gap-2">
                          <p className="text-sm font-semibold">{p.name}{p.priority && <span className="text-[10px] text-[#E15A30] mr-1">★</span>}</p>
                          {p.buyers != null && <p className="text-[11px] text-gray-500 shrink-0">{p.buyers} {tr('من')} {p.peers} {tr('يشترونه')}</p>}
                        </div>
                        {p.monthlyQty ? (
                          <p className="text-xs text-gray-700 mt-0.5">
                            {tr('شهرياً')}: <b>{fmtRange(p.monthlyQty)}</b> {p.unit} ({tr('الوسيط')} {p.monthlyQty.median})
                            {showMoney && p.monthlyValue && <> · {fmtRange(p.monthlyValue, money)}</>}
                            {p.firstOrderQty != null && <> · {tr('أول طلب')} ~{p.firstOrderQty}</>}
                          </p>
                        ) : (
                          <p className="text-[11px] text-gray-400 mt-0.5">
                            {p.buyers === 0 ? tr('لا تشتريه المحلات المشابهة بعد')
                              : p.hidden === 'DOMINANT' ? tr('مشترٍ واحد يطغى على الكمية — لا رقم موثوق')
                              : `${tr('يشتريه أقل من')} ${est.minPeers ?? minPeers} ${tr('من المحلات المشابهة — لا رقم حفاظاً على الخصوصية')}`}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}
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
            <button onClick={openCustomer} className="flex items-center justify-center gap-1.5 rounded-xl border border-blue-200 text-blue-700 py-2.5 text-sm font-semibold">{tr('ملف العميل')}</button>
          ) : canAddCustomer && item.relation === 'NEW' ? (
            <button onClick={addAsCustomer} disabled={adding} className="flex items-center justify-center gap-1.5 rounded-xl bg-[#E15A30] text-white py-2.5 text-sm font-bold disabled:opacity-60"><UserPlus size={15} /> {adding ? tr('أحدد موقعك…') : tr('أضفه عميلاً')}</button>
          ) : <span />}
        </div>
      )}
    </div>
  );
}

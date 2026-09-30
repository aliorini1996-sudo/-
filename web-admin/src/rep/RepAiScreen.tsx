import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, ChevronUp, MapPin, Navigation, RefreshCw, Sparkles, Star, Store, UserPlus, X, ThumbsUp, ThumbsDown, Lightbulb, ShoppingBag, MessageSquareQuote, Clock } from 'lucide-react';
import repApi from './repApi';
import { cacheGet, cacheSet, currentRepId, newClientRef, outboxAdd } from './offlineDb';
import { isNetworkError } from './offlineSync';
import { useAiRepTr } from '../i18n/aiRepPhrases';
import { useBackClose } from '../lib/useBackClose';
import { loadGoogleMaps } from './googleMaps';
import RepAiMap from './RepAiMap';
import { loadAiSession, onConverted, saveAiSession, type AiAddPrefill } from './aiRepSession';
import { CLOSED_OUTCOMES, OBJECTIONS, OBJECTION_OUTCOMES, OUTCOMES, distKm, fmtDistance, navUrl, refreshHoldMs, shopBadge, type ShopBadgeTone } from './aiRepLogic';

/**
 * المندوب الذكي — شاشة المندوب: **الصفحة كلها خريطة Google**، و**العقل يمسح كل المحلات حول المندوب تلقائياً** عند
 * الفتح (من خرائط Google — بلا أي عمل من المندوب) فيوجّهه: بأي الفرص الجديدة يبدأ وبأي ترتيب ولماذا، وكل محل بدراسته
 * (تقييمه ونوعه وحالة فتحه، وبمراجعاته النصية حين يُضبط مفتاح Google الرسمي). لا من مبيعات الشركة السابقة.
 * بمفتاح الخريطة: الضغط على أي محل في الخريطة يدرسه بمراجعاته. نتائج Google تُعرض ولا تُخزَّن.
 */

interface Item {
  ref: string; placeId: string; name: string; address: string | null; lat: number; lng: number; outletType: string; outletTypeLabel: string;
  distanceM: number; relation: 'NEW' | 'CUSTOMER' | 'POSSIBLE_CUSTOMER'; customerId: string | null;
  lastOutcome: string | null; lastOutcomeAt: string | null; rejectedRecently: boolean; closed?: boolean;
  /** أُبلغ أنه أُغلق نهائياً أو لم يُعثر عليه (من ذاكرة الشركة) — آخر القائمة وخارج الخطة */
  reportedClosed?: boolean;
  profile?: Profile; study?: Study;
  /** دُرس بمراجعاته النصية (المفتاح الرسمي) — لا من المسح العام */
  withReviews?: boolean;
}
interface Review { rating: number | null; text: string; when: string | null; author: string | null; authorUri: string | null }
interface Profile {
  name: string; typeLabel: string | null; address: string | null; mapsUri: string | null; rating: number | null; ratingCount: number;
  openNow: boolean | null; hours: string[]; reviews: Review[];
}
interface Study {
  source: 'AI' | 'RULES'; summary: string; activity: 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN'; activityWhy: string;
  praise: string[]; complaints: string[]; opportunity: string[]; offer: string[];
  openingLine: string | null; objection: string | null; objectionReply: string | null; visitTip: string | null;
}
interface Me {
  placesConfigured: boolean; mapsKey?: string | null;
  targetTypes: { code: string; label: string }[];
}
/** kind: فرصة جديدة أو متابعة (مهتم/عرض سعر/عُد لاحقاً بعد التهدئة) — اختياري لجلسات محفوظة قبل إضافته */
interface Guide { source: 'AI' | 'RULES'; summary: string; stops: { ref: string; why: string; kind?: 'NEW' | 'FOLLOW_UP' }[] }

const BADGE_CLASS: Record<ShopBadgeTone, string> = {
  customer: 'bg-blue-50 text-blue-700', possible: 'bg-sky-50 text-sky-700', followup: 'bg-amber-50 text-amber-700',
  muted: 'bg-gray-100 text-gray-500', new: 'bg-green-50 text-green-700',
};

const ME_KEY = 'ai-rep:me';
const ADD_PIN_MAX_M = 75;
const ACTIVITY_LABEL: Record<Study['activity'], string> = { HIGH: 'محل نشِط', MEDIUM: 'نشاط متوسط', LOW: 'محل هادئ', UNKNOWN: 'النشاط غير معروف' };

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
  const [items, setItems] = useState<Item[]>((restored?.items as Item[] | null) ?? []);
  const [guide, setGuide] = useState<Guide | null>((restored?.guide as Guide | null) ?? null);
  const [searchId, setSearchId] = useState<string | null>(restored?.searchId ?? null);
  const [origin, setOrigin] = useState<{ lat: number; lng: number; accuracy: number } | null>(restored?.origin ?? null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);
  const [msg, setMsg] = useState('');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [g, setG] = useState<any>(null);
  const [mapErr, setMapErr] = useState(false);
  const [mapAttempt, setMapAttempt] = useState(0);
  const [recenter, setRecenter] = useState(0);
  const searchIdRef = useRef(searchId);
  searchIdRef.current = searchId;
  const originRef = useRef(origin);
  originRef.current = origin;
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const busyRef = useRef(false);
  // بعد مسحٍ فشل من جهة Google: «حدّث» يتوقّف لحظات (الخادم يُمهل المندوب أيضاً) — لا طرق متكرّر لخرائط محجوبة
  const [refreshHold, setRefreshHold] = useState(false);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (holdTimer.current) clearTimeout(holdTimer.current); }, []);

  // حالة الشاشة في ذاكرة الجلسة (لا القرص): الرجوع أو «أضفه عميلاً» يفكّكان الشاشة، فتعود كما كانت
  useEffect(() => {
    saveAiSession({ repId, searchId, items, origin, guide, routeIds: [], chat: [], askDraft: '', tab: 'near' });
  }, [repId, searchId, items, origin, guide]);

  // المحل الذي انتهت زيارته يخرج من خطة اليوم المعروضة (لا يبقى رقماً على الخريطة ولا «ابدأ به»)
  const dropStop = useCallback((placeId: string) => {
    const ref = itemsRef.current.find(x => x.placeId === placeId)?.ref;
    if (ref) setGuide(gd => (gd && gd.stops.some(s => s.ref === ref) ? { ...gd, stops: gd.stops.filter(s => s.ref !== ref) } : gd));
  }, []);

  // عميل أُنشئ من محلٍّ مدروس ⇒ يصير «عميلاً حالياً» هنا
  useEffect(() => onConverted((placeId, customerId) => {
    dropStop(placeId);
    setItems(list => list.map(x => (x.placeId === placeId ? { ...x, relation: 'CUSTOMER', customerId, lastOutcome: 'CONVERTED' } : x)));
  }), [dropStop]);

  // الإعداد عند التركيب وعند عودة الاتصال
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
        void cacheSet(ME_KEY, d);
      } catch (e) {
        if (!alive) return;
        if (isNetworkError(e)) {
          const hit = await cacheGet<Me>(ME_KEY).catch(() => null);
          if (hit?.data) { setMe(hit.data); setOffline(true); } else setMeErr('OFFLINE');
        } else setMeErr(errMsg(e) || 'LOAD_FAILED');
      }
    })();
    return () => { alive = false; };
  }, [meTick]);

  // خريطة Google التفاعلية (بمفتاح المنصّة) — بمهلة وإعادة محاولة
  useEffect(() => {
    if (!me?.mapsKey || offline) return;
    let alive = true;
    setMapErr(false);
    loadGoogleMaps(me.mapsKey).then(gg => { if (alive) setG(gg); }).catch(() => { if (alive) setMapErr(true); });
    return () => { alive = false; };
  }, [me?.mapsKey, offline, mapAttempt]);

  const locate = useCallback(async () => {
    const gps = await getGps().catch(() => null);
    if (!gps) { setMsg(tr('فعّل الموقع لنعرف المحلات القريبة منك')); return null; }
    setOrigin(gps);
    setRecenter(n => n + 1);
    return gps;
  }, [tr]);

  // المسح: العقل يفحص كل المحلات حول المندوب في خرائط Google ويوجّهه — بلا أي عمل من المندوب
  const scan = useCallback(async (gps?: { lat: number; lng: number; accuracy: number } | null) => {
    const at = gps ?? originRef.current ?? await locate();
    if (!at || busyRef.current) return;
    busyRef.current = true;
    setScanning(true); setMsg(''); setOpenId(null);
    try {
      const r = await repApi.post('/ai-rep/rep/scan', { lat: at.lat, lng: at.lng, accuracyM: at.accuracy });
      const d = r.data.data as { searchId: string; items: Item[]; guide: Guide; partial?: boolean };
      searchIdRef.current = d.searchId;
      setSearchId(d.searchId);
      setItems(d.items);
      setGuide(d.guide);
      setPanelOpen(true);
      // بعض طلبات Google فشلت: القائمة قد تنقص (لا «لا محلات حولك»)
      if (d.partial) setMsg(tr('القائمة قد تكون ناقصة — بعض نتائج خرائط Google لم تصل، حدّث بعد قليل'));
      else if (!d.items.length) setMsg(tr('لم أجد محلات مستهدفة حولك في خرائط Google — تحرّك قليلاً ثم حدّث'));
    } catch (e) {
      setMsg(errMsg(e) || (isNetworkError(e) ? tr('أنت دون اتصال — الدراسة تحتاج الإنترنت') : tr('تعذّر مسح المحلات حولك')));
      const hold = refreshHoldMs((e as { response?: { data?: { code?: string; retryAfterS?: number } } })?.response?.data);
      if (hold) {
        setRefreshHold(true);
        if (holdTimer.current) clearTimeout(holdTimer.current);
        holdTimer.current = setTimeout(() => setRefreshHold(false), hold);
      }
    } finally { busyRef.current = false; setScanning(false); }
  }, [locate, tr]);

  // عند الفتح: الموقع ثم المسح تلقائياً (إن لم تكن نتائج محفوظة من هذه الجلسة)
  const started = useRef(false);
  useEffect(() => {
    if (started.current || offline || !me) return;
    started.current = true;
    void (async () => {
      const gps = await locate();
      if (gps && !items.length) void scan(gps);
    })();
  }, [locate, scan, offline, me, items.length]);

  // ضغطة على محلٍّ من محلات Google في الخريطة التفاعلية (بمفتاح): دراسته بمراجعاته
  const onPoi = useCallback(async (p: { placeId: string }) => {
    const known = items.find(x => x.placeId === p.placeId && x.study && (x.withReviews || !me?.placesConfigured));
    if (known) { setOpenId(known.placeId); return; }
    if (busyRef.current || !me?.placesConfigured) return;
    busyRef.current = true;
    setBusy(true); setMsg('');
    try {
      const o = originRef.current;
      const r = await repApi.post('/ai-rep/rep/study', { placeId: p.placeId, ...(searchIdRef.current && { searchId: searchIdRef.current }), ...(o && { gps: { lat: o.lat, lng: o.lng } }) });
      const d = r.data.data as { searchId: string; item: Item; profile: Profile; study: Study };
      const item: Item = { ...d.item, profile: d.profile, study: d.study, withReviews: true };
      searchIdRef.current = d.searchId;
      setSearchId(d.searchId);
      setItems(list => (list.some(x => x.placeId === item.placeId) ? list.map(x => (x.placeId === item.placeId ? { ...x, ...item } : x)) : [...list, item]));
      setOpenId(item.placeId);
    } catch (e) {
      setMsg(errMsg(e) || (isNetworkError(e) ? tr('أنت دون اتصال — الدراسة تحتاج الإنترنت') : tr('تعذّرت دراسة المحل')));
    } finally { busyRef.current = false; setBusy(false); }
  }, [items, me?.placesConfigured, tr]);

  // النتيجة تُطبَّق هنا فوراً كما يطبّقها الخادم: وسم آخر نتيجة، والمحل يخرج من الخطة، والمغلق يخرج من القائمة
  const onOutcome = (placeId: string, kind: string) => {
    dropStop(placeId);
    setItems(list => list.map(x => (x.placeId === placeId
      ? { ...x, lastOutcome: kind, lastOutcomeAt: new Date().toISOString(), rejectedRecently: kind === 'NOT_INTERESTED' || kind === 'EXCLUSIVE_SUPPLIER', closed: CLOSED_OUTCOMES.has(kind) || x.closed }
      : x)));
    if (CLOSED_OUTCOMES.has(kind)) setOpenId(null);
  };

  const open = openId ? items.find(x => x.placeId === openId) ?? null : null;
  const byRef = useMemo(() => new Map(items.map(i => [i.ref, i])), [items]);
  // المُبلَّغ عن إغلاقه يُرسم بلون المرفوض (رمادي) — ظاهر لمن يريد التحقّق، خارج الخطة
  const mapItems = useMemo(() => items.filter(i => !i.closed).map(i => ({ placeId: i.placeId, lat: i.lat, lng: i.lng, relation: i.relation, rejectedRecently: i.rejectedRecently || !!i.reportedClosed, name: i.name, closed: i.closed })), [items]);
  const planIds = useMemo(() => (guide?.stops ?? []).map(s => byRef.get(s.ref)?.placeId).filter((x): x is string => !!x), [guide, byRef]);
  const keyed = !!me?.mapsKey && !offline;
  // بلا مفتاح الخريطة: خريطة Google المضمّنة — حول المندوب، أو على المحل المفتوح
  const hl = (document.documentElement.lang || 'ar').slice(0, 2);
  const embedQuery = (me?.targetTypes[0]?.label ?? 'بقالة').split('/')[0].trim();
  const embed = open
    ? `https://maps.google.com/maps?q=${encodeURIComponent(open.name)}&ll=${open.lat.toFixed(5)},${open.lng.toFixed(5)}&z=18&hl=${hl}&output=embed`
    : origin
      ? `https://maps.google.com/maps?q=${encodeURIComponent(tr(embedQuery))}&ll=${origin.lat.toFixed(5)},${origin.lng.toFixed(5)}&z=16&hl=${hl}&output=embed`
      : null;

  if (meErr && !me) {
    return (
      <div className="p-4 h-full flex flex-col">
        <div className="flex items-center gap-2">
          <button onClick={onBack} className="p-2 -mr-2 text-gray-500"><ChevronRight size={20} /></button>
          <p className="flex-1 font-bold text-[#1F1A13] flex items-center gap-1.5"><Sparkles size={17} className="text-[#E15A30]" /> {tr('المندوب الذكي')}</p>
        </div>
        <p className="text-center text-sm text-gray-500 py-10">{meErr === 'OFFLINE' ? tr('أنت دون اتصال') : meErr === 'LOAD_FAILED' ? tr('تعذّر تحميل المندوب الذكي') : meErr}</p>
      </div>
    );
  }

  return (
    <div className="h-full relative overflow-hidden bg-gray-100">
      {/* الخريطة تملأ الصفحة */}
      <div className="absolute inset-0">
        {keyed ? (
          g ? <RepAiMap full g={g} origin={origin} items={mapItems} plan={planIds} fitKey={searchId} onSelect={id => setOpenId(id)} onPoi={p => void onPoi(p)} recenterKey={recenter} />
            : (
              <div className="w-full h-full flex flex-col items-center justify-center gap-2 text-sm text-gray-500">
                {mapErr
                  ? <><span>{tr('تعذّر تحميل خريطة Google — تحقّق من الاتصال')}</span><button onClick={() => setMapAttempt(n => n + 1)} className="rounded-lg border border-gray-300 px-3 py-1.5 font-semibold bg-white">{tr('أعد المحاولة')}</button></>
                  : tr('جاري تحميل الخريطة…')}
              </div>
            )
        ) : embed && !offline ? (
          <iframe title={tr('خريطة Google')} src={embed} className="w-full h-full border-0" loading="lazy" referrerPolicy="no-referrer-when-downgrade" />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-sm text-gray-500">{offline ? tr('أنت دون اتصال') : tr('أحدد موقعك…')}</div>
        )}
      </div>

      {/* شريط علوي عائم */}
      <div className="absolute top-0 inset-x-0 p-3 flex items-center gap-2 pointer-events-none">
        <button onClick={onBack} className="pointer-events-auto w-10 h-10 rounded-full bg-white shadow-md flex items-center justify-center text-gray-700"><ChevronRight size={20} /></button>
        <div className="flex-1 flex justify-center">
          <span className="rounded-full bg-white/95 shadow-md px-4 py-2 text-sm font-bold text-[#1F1A13] flex items-center gap-1.5"><Sparkles size={15} className="text-[#E15A30]" /> {tr('المندوب الذكي')}</span>
        </div>
        <button onClick={() => void scan(null)} disabled={scanning || refreshHold} title={tr('حدّث')} className="pointer-events-auto w-10 h-10 rounded-full bg-white shadow-md flex items-center justify-center text-[#1D4ED8] disabled:opacity-50"><RefreshCw size={18} className={scanning ? 'animate-spin' : ''} /></button>
      </div>

      {/* لوحة المحلات حول المندوب وتوجيه العقل */}
      {!open && (
        <div className="absolute bottom-0 inset-x-0 z-30" dir="rtl">
          {msg && <p className="mx-4 mb-2 rounded-xl bg-white shadow-md p-2.5 text-sm text-center text-gray-700">{msg}</p>}
          {scanning ? (
            <p className="mx-4 mb-4 rounded-full bg-[#1F1A13]/90 text-white text-sm text-center py-2.5 px-4 shadow-md">{tr('العقل يمسح المحلات حولك في خرائط Google…')}</p>
          ) : busy ? (
            <p className="mx-4 mb-4 rounded-full bg-[#1F1A13]/90 text-white text-sm text-center py-2.5 px-4 shadow-md">{tr('أدرس المحل من مراجعاته في خرائط Google…')}</p>
          ) : items.length > 0 && (
            <NearbyPanel items={items} guide={guide} open={panelOpen} onToggle={() => setPanelOpen(v => !v)} onOpen={it => (me?.placesConfigured && !it.withReviews ? void onPoi({ placeId: it.placeId }) : setOpenId(it.placeId))} />
          )}
        </div>
      )}

      {open && (
        <ShopSheet item={open} canAddCustomer={canAddCustomer} onClose={() => setOpenId(null)}
          onAddCustomer={onAddCustomer} onOpenCustomer={onOpenCustomer}
          onOutcome={kind => onOutcome(open.placeId, kind)} />
      )}
    </div>
  );
}

/** المحلات حول المندوب: توجيه العقل (أولاً) ثم القائمة — لوحة سفلية قابلة للطيّ فوق الخريطة. */
function NearbyPanel({ items, guide, open, onToggle, onOpen }: {
  items: Item[]; guide: Guide | null; open: boolean; onToggle: () => void; onOpen: (it: Item) => void;
}) {
  const tr = useAiRepTr();
  // المغلق الذي سُجّل الآن يخرج من القائمة (والخادم يخفيه بقية اليوم)
  const shown = items.filter(i => !i.closed);
  const byRef = new Map(shown.map(i => [i.ref, i]));
  const badges = new Map(shown.map(i => [i.placeId, shopBadge(i)]));
  // «فرص جديدة» ما وسمه «فرصة جديدة» وحده — لا العملاء المحتملون ولا المزور ولا المرفوض
  const newCount = shown.filter(i => badges.get(i.placeId)?.tone === 'new').length;
  return (
    <div className="bg-white rounded-t-3xl shadow-2xl">
      <button onClick={onToggle} className="w-full px-4 pt-3 pb-2 flex items-center gap-2">
        <span className="mx-auto absolute left-1/2 -translate-x-1/2 -mt-1.5 w-10 h-1 rounded-full bg-gray-200" />
        <p className="flex-1 text-right font-bold text-[#1F1A13] text-sm">{tr('المحلات حولك')} ({shown.length}) · {tr('فرص جديدة')} {newCount}</p>
        {open ? <ChevronDown size={18} className="text-gray-400" /> : <ChevronUp size={18} className="text-gray-400" />}
      </button>
      {open && (
        <div className="max-h-[48vh] overflow-y-auto px-4 pb-4 space-y-3">
          {guide && (
            <div className="rounded-2xl bg-[#FBEBE2] border border-[#F5DACE] p-3 space-y-2">
              <p className="text-xs font-bold text-[#C94E28] flex items-center gap-1"><Sparkles size={13} /> {guide.source === 'AI' ? tr('توجيه المستشار الذكي') : tr('ابدأ بهذه المحلات')}</p>
              <p className="text-sm text-[#1F1A13] leading-6">{guide.summary}</p>
              <ol className="space-y-1.5">
                {guide.stops.map((s, i) => {
                  const it = byRef.get(s.ref);
                  if (!it) return null;
                  return (
                    <li key={s.ref}>
                      <button onClick={() => onOpen(it)} className="w-full text-right flex items-start gap-2">
                        <span className="w-6 h-6 rounded-full bg-[#E15A30] text-white text-xs font-bold flex items-center justify-center shrink-0">{i + 1}</span>
                        <span className="min-w-0">
                          <span className="flex items-center gap-1.5 text-sm font-semibold text-[#1F1A13] min-w-0">
                            <span className="truncate">{it.name}</span>
                            {s.kind === 'FOLLOW_UP' && <span className="text-[10px] font-normal rounded-full px-2 py-0.5 bg-amber-50 text-amber-700 shrink-0">{tr('متابعة زيارة')}</span>}
                          </span>
                          {s.why && <span className="block text-[11px] text-gray-600 leading-5">{s.why}</span>}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ol>
            </div>
          )}
          <div className="divide-y divide-gray-50">
            {shown.map(it => (
              <button key={it.placeId} onClick={() => onOpen(it)} className="w-full text-right py-2.5 flex items-center gap-2">
                <Store size={16} className="text-[#E15A30] shrink-0" />
                <span className="flex-1 min-w-0">
                  <span className="block text-sm font-semibold text-[#1F1A13] truncate">{it.name}</span>
                  <span className="block text-[11px] text-gray-500">
                    {it.profile?.rating != null && <>★ {it.profile.rating} · </>}
                    {it.profile?.typeLabel || tr(it.outletTypeLabel)} · {fmtDistance(it.distanceM)}
                    {it.profile?.openNow === false && <> · <span className="text-red-600">{tr('مغلق الآن')}</span></>}
                  </span>
                </span>
                {(() => {
                  // العميل، «ربما عميل»، المُبلَّغ عن إغلاقه، آخر نتيجة زيارة (أي مندوب)، وإلا «فرصة جديدة» — shopBadge
                  const b = badges.get(it.placeId) ?? shopBadge(it);
                  return <span className={`text-[10px] rounded-full px-2 py-0.5 shrink-0 ${BADGE_CLASS[b.tone]}`}>{tr(b.label)}</span>;
                })()}
              </button>
            ))}
          </div>
          <GoogleAttribution />
        </div>
      )}
    </div>
  );
}

/** نسب Google Maps (شرط Google حين يُعرض محتوى الأماكن فوق الخريطة أو بعيداً عنها). */
function GoogleAttribution() {
  return <p className="text-[12px] text-gray-500 text-left" dir="ltr" style={{ fontFamily: 'Roboto, Arial, sans-serif' }}>Google Maps</p>;
}

function Stars({ value }: { value: number | null }) {
  if (value == null) return null;
  return <span className="inline-flex items-center gap-0.5 text-amber-500 text-xs font-bold"><Star size={12} fill="currentColor" /> {value}</span>;
}

function Bullets({ icon, title, items, tone }: { icon: ReactNode; title: string; items: string[]; tone: string }) {
  if (!items.length) return null;
  return (
    <div className="space-y-1">
      <p className={`text-xs font-bold flex items-center gap-1 ${tone}`}>{icon} {title}</p>
      <ul className="space-y-0.5">
        {items.map((x, i) => <li key={i} className="text-sm text-[#1F1A13] leading-6">• {x}</li>)}
      </ul>
    </div>
  );
}

/** دراسة المحل: ملفه في خرائط Google + دراسة العقل (أو الملخّص الحتمي) — لوحة سفلية فوق الخريطة. */
function ShopSheet({ item, canAddCustomer, onClose, onAddCustomer, onOpenCustomer, onOutcome }: {
  item: Item; canAddCustomer: boolean;
  onClose: () => void; onAddCustomer: (p: AiAddPrefill) => void; onOpenCustomer: (id: string) => Promise<boolean>; onOutcome: (kind: string) => void;
}) {
  const tr = useAiRepTr();
  const p = item.profile;
  const s = item.study;
  const [err, setErr] = useState('');
  const [mode, setMode] = useState<'view' | 'outcome'>('view');
  const [kind, setKind] = useState<string>('');
  const [objection, setObjection] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState('');
  const [adding, setAdding] = useState(false);
  const [outcomeErr, setOutcomeErr] = useState('');
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  // زر الرجوع وسحبة الحافة يغلقان اللوحة (لا يُخرجان من الشاشة)
  useBackClose(true, onClose);
  useBackClose(mode === 'outcome', () => setMode('view'));

  const submitOutcome = async () => {
    if (!kind) return;
    setSaving(true); setOutcomeErr('');
    const gps = await getGps().catch(() => null);
    const clientRef = newClientRef();
    // السبب زرٌّ اختياري يُرسل مع النتائج المؤهّلة وحدها؛ الجسم نفسه يدخل صفّ الإرسال دون اتصال.
    // موقع المحل وعلاقته كما رآهما المندوب: احتياط الخادم حين تنتهي جلسة البحث (رفعٌ مؤجَّل) — يقبل الموقع قرب GPS وحده
    const body = {
      clientRef, placeId: item.placeId, outletType: item.outletType, kind,
      ...(objection && OBJECTION_OUTCOMES.has(kind) ? { objection } : {}),
      ...(note.trim() && { note: note.trim() }),
      ...(gps && { lat: gps.lat, lng: gps.lng, accuracyM: gps.accuracy }), occurredAt: new Date().toISOString(),
      placeLat: item.lat, placeLng: item.lng, relation: item.relation,
    };
    try {
      await repApi.post('/ai-rep/rep/outcomes', body);
      setSaved(tr('سُجّلت النتيجة'));
    } catch (e) {
      const status = (e as { response?: { status?: number } })?.response?.status;
      if (isNetworkError(e) || (status != null && status >= 500)) {
        // صفّ الإرسال الرسمي: يبقى بعد الخروج ويُرفع تلقائياً (الخادم يمنع التكرار بـclientRef)
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
    // الموقع من GPS المندوب عند الباب فقط (لا من Google): يُعبّأ إن كان قريباً من المحل ودقيقاً
    const gps = await getGps().catch(() => null);
    if (!alive.current) return;
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
    <div className="absolute inset-x-0 bottom-0 z-40 max-h-[85%] bg-white rounded-t-3xl shadow-2xl flex flex-col" dir="rtl">
      <div className="p-4 pb-3 flex items-start gap-2 border-b border-gray-100 flex-shrink-0">
        <div className="flex-1 min-w-0">
          <p className="font-bold text-[#1F1A13] flex items-center gap-1.5"><Store size={17} className="text-[#E15A30] shrink-0" /> <span className="truncate">{p?.name || item.name || tr(item.outletTypeLabel)}</span></p>
          <p className="text-[11px] text-gray-500 mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
            {p?.rating != null && <><Stars value={p.rating} />{p.ratingCount > 0 && <span>({p.ratingCount} {tr('مقيّماً')})</span>}</>}
            <span>{p?.typeLabel || tr(item.outletTypeLabel)}</span>
            <span>{fmtDistance(item.distanceM)}</span>
            {p?.openNow === true && <span className="text-green-700">{tr('مفتوح الآن')}</span>}
            {p?.openNow === false && <span className="text-red-600">{tr('مغلق الآن')}</span>}
            {item.relation === 'CUSTOMER' && <span className="text-blue-700">{tr('عميل حالي')}</span>}
            {item.relation === 'POSSIBLE_CUSTOMER' && <span className="text-blue-600">{tr('ربما عميل حالي')}</span>}
            {item.reportedClosed && <span className="text-gray-500">{tr('أُبلغ أنه مغلق')}</span>}
          </p>
        </div>
        <button onClick={onClose} className="p-2 text-gray-500"><X size={20} /></button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
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
            {err && <p className="text-xs text-center text-red-600 bg-red-50 rounded-xl py-2">{err}</p>}

            {/* الدراسة */}
            {s ? (
              <div className="rounded-2xl bg-[#FBEBE2] border border-[#F5DACE] p-4 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  {/* بلا مراجعات نصية (المسح العام) لا تدّعي الدراسة أنها منها — ملف المحل وحده */}
                  <p className="text-xs font-bold text-[#C94E28] flex items-center gap-1"><Sparkles size={13} /> {p?.reviews.length
                    ? (s.source === 'AI' ? tr('دراسة بالذكاء الاصطناعي من مراجعات Google') : tr('ملخّص من مراجعات Google'))
                    : (s.source === 'AI' ? tr('دراسة بالذكاء الاصطناعي من ملف المحل في خرائط Google') : tr('ملخّص من ملف المحل في خرائط Google'))}</p>
                  {/* النشاط من عدد المقيّمين: مجهولٌ ⇒ لا وسم */}
                  {s.activity !== 'UNKNOWN' && <span className="text-[11px] rounded-full bg-white/80 px-2 py-0.5 text-[#1F1A13] font-semibold">{tr(ACTIVITY_LABEL[s.activity])}</span>}
                </div>
                <p className="text-sm text-[#1F1A13] leading-6">{s.summary}</p>
                {s.activityWhy && <p className="text-[11px] text-gray-600">{s.activityWhy}</p>}
                <Bullets icon={<ThumbsUp size={12} />} title={tr('ما يمدحه العملاء')} items={s.praise} tone="text-green-700" />
                <Bullets icon={<ThumbsDown size={12} />} title={tr('ما يشتكي منه العملاء')} items={s.complaints} tone="text-red-600" />
                <Bullets icon={<Lightbulb size={12} />} title={tr('فرصتك')} items={s.opportunity} tone="text-[#C94E28]" />
                {s.offer.length > 0 && (
                  <div className="space-y-1">
                    <p className="text-xs font-bold text-[#C94E28] flex items-center gap-1"><ShoppingBag size={12} /> {tr('اعرض عليه')}</p>
                    <div className="flex flex-wrap gap-1.5">{s.offer.map(o => <span key={o} className="text-xs rounded-full bg-white px-2.5 py-1 border border-[#F5DACE]">{o}</span>)}</div>
                  </div>
                )}
                {s.openingLine && (
                  <div className="rounded-xl bg-white p-3">
                    <p className="text-[11px] font-bold text-gray-500 flex items-center gap-1"><MessageSquareQuote size={12} /> {tr('ابدأ الحديث بـ')}</p>
                    <p className="text-sm text-[#1F1A13] mt-0.5">«{s.openingLine}»</p>
                  </div>
                )}
                {s.objection && (
                  <div className="text-sm leading-6">
                    <p><b>{tr('الاعتراض المتوقع')}:</b> {s.objection}</p>
                    {s.objectionReply && <p><b>{tr('ردّك')}:</b> {s.objectionReply}</p>}
                  </div>
                )}
                {s.visitTip && <p className="text-xs text-gray-700 flex items-start gap-1"><Clock size={12} className="mt-1 shrink-0" /> {s.visitTip}</p>}
                {s.source === 'AI' && <p className="text-[10px] text-gray-500">{tr('تحليل آلي من مراجعات العملاء في خرائط Google — تحقّق منه بزيارتك')}</p>}
              </div>
            ) : (
              <p className="text-center text-sm text-gray-400 py-4">{tr('لا دراسة لهذا المحل بعد')}</p>
            )}

            {/* مراجعات Google كما هي */}
            {p && (
              <div className="rounded-2xl border border-gray-100 p-4 space-y-3">
                <p className="font-bold text-sm">{tr('مراجعات العملاء في خرائط Google')}</p>
                {p.reviews.length ? p.reviews.map((r, i) => (
                  <div key={i} className="border-b border-gray-50 pb-2 last:border-0">
                    <div className="flex items-center gap-2 text-[11px] text-gray-500">
                      <Stars value={r.rating} />
                      {r.author && (r.authorUri
                        ? <a href={r.authorUri} target="_blank" rel="noreferrer" className="underline">{r.author}</a>
                        : <span>{r.author}</span>)}
                      {r.when && <span>· {r.when}</span>}
                    </div>
                    {r.text && <p className="text-sm text-[#1F1A13] mt-1 leading-6 whitespace-pre-wrap">{r.text}</p>}
                  </div>
                )) : <p className="text-xs text-gray-500">{item.withReviews ? tr('لا مراجعات نصية لهذا المحل في خرائط Google') : tr('مراجعات العملاء النصية تظهر حين يُضبط مفتاح Google الرسمي — الدراسة الآن من تقييم المحل ونوعه وحالة فتحه')}</p>}
                {p.hours.length > 0 && (
                  <details className="text-xs text-gray-600">
                    <summary className="cursor-pointer font-semibold">{tr('ساعات العمل')}</summary>
                    <ul className="mt-1 space-y-0.5">{p.hours.map((h, i) => <li key={i}>{h}</li>)}</ul>
                  </details>
                )}
                <div className="flex items-center justify-between">
                  {p.mapsUri ? <a href={p.mapsUri} target="_blank" rel="noreferrer" className="text-xs text-[#1D4ED8] underline">{tr('افتح في خرائط Google')}</a> : <span />}
                  <GoogleAttribution />
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {mode === 'view' && (
        <div className="flex-shrink-0 bg-white border-t border-gray-100 p-3 grid grid-cols-3 gap-2">
          <a href={navUrl(item)} target="_blank" rel="noreferrer" className="flex items-center justify-center gap-1.5 rounded-xl bg-[#1F1A13] text-white py-2.5 text-sm font-bold"><Navigation size={15} /> {tr('ابدأ الملاحة')}</a>
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

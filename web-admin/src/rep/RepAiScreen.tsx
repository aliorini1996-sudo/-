import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChevronRight, Crosshair, MapPin, Navigation, Sparkles, Star, Store, UserPlus, X, ThumbsUp, ThumbsDown, Lightbulb, ShoppingBag, MessageSquareQuote, Clock } from 'lucide-react';
import repApi from './repApi';
import { cacheGet, cacheSet, currentRepId, newClientRef, outboxAdd } from './offlineDb';
import { isNetworkError } from './offlineSync';
import { useAiRepTr } from '../i18n/aiRepPhrases';
import { useBackClose } from '../lib/useBackClose';
import { loadGoogleMaps } from './googleMaps';
import RepAiMap from './RepAiMap';
import { loadAiSession, onConverted, saveAiSession, type AiAddPrefill } from './aiRepSession';
import { OBJECTIONS, OBJECTION_OUTCOMES, OUTCOMES, distKm, fmtDistance, navUrl } from './aiRepLogic';

/**
 * المندوب الذكي — شاشة المندوب: **الصفحة كلها خريطة Google**، والضغط على أي محل يدرسه **من ملفه في خرائط Google**
 * (التقييم، عدد المقيّمين، ساعات العمل، ومراجعات العملاء النصية) — لا من مبيعات الشركة السابقة.
 *   - بمفتاح الخريطة: يضغط المندوب المحل على الخريطة. بلا مفتاح الخريطة: خريطة Google المضمّنة وزرّ
 *     «ادرس المحل الذي أنا عنده الآن» (أقرب محل في خرائط Google لموقعه).
 *   - الدراسة من العقل إن ضُبط (مدموغةً «بالذكاء الاصطناعي»)، وإلا ملخّص حتمي من المراجعات نفسها.
 * ملف Google يُعرض ولا يُخزَّن؛ يبقى في ذاكرة الشاشة لإعادة فتح المحل دون نداء جديد.
 */

interface Item {
  ref: string; placeId: string; name: string; address: string | null; lat: number; lng: number; outletType: string; outletTypeLabel: string;
  distanceM: number; relation: 'NEW' | 'CUSTOMER' | 'POSSIBLE_CUSTOMER'; customerId: string | null;
  lastOutcome: string | null; lastOutcomeAt: string | null; rejectedRecently: boolean; closed?: boolean;
  profile?: Profile; study?: Study;
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
type StudyReq = { placeId?: string; here?: { lat: number; lng: number; accuracyM: number } };

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
  const [searchId, setSearchId] = useState<string | null>(restored?.searchId ?? null);
  const [origin, setOrigin] = useState<{ lat: number; lng: number; accuracy: number } | null>(restored?.origin ?? null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
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
  const busyRef = useRef(false);

  // حالة الشاشة في ذاكرة الجلسة (لا القرص): الرجوع أو «أضفه عميلاً» يفكّكان الشاشة، فتعود كما كانت
  useEffect(() => {
    saveAiSession({ repId, searchId, items, origin, guide: null, routeIds: [], chat: [], askDraft: '', tab: 'near' });
  }, [repId, searchId, items, origin]);

  // عميل أُنشئ من محلٍّ مدروس ⇒ يصير «عميلاً حالياً» هنا
  useEffect(() => onConverted((placeId, customerId) => {
    setItems(list => list.map(x => (x.placeId === placeId ? { ...x, relation: 'CUSTOMER', customerId, lastOutcome: 'CONVERTED' } : x)));
  }), []);

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

  // موقع المندوب لتوسيط الخريطة (مرّة عند الفتح، وعند زرّ «موقعي»)
  const locate = useCallback(async () => {
    const gps = await getGps().catch(() => null);
    if (!gps) { setMsg(tr('فعّل الموقع لنعرف المحلات القريبة منك')); return null; }
    setOrigin(gps);
    setRecenter(n => n + 1);
    return gps;
  }, [tr]);
  const located = useRef(false);
  useEffect(() => {
    if (located.current || offline) return;
    located.current = true;
    void locate();
  }, [locate, offline]);

  const study = useCallback(async (req: StudyReq) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true); setMsg(''); setOpenId(null);
    try {
      const o = originRef.current;
      const r = await repApi.post('/ai-rep/rep/study', {
        ...req,
        ...(searchIdRef.current && { searchId: searchIdRef.current }),
        ...(o && { gps: { lat: o.lat, lng: o.lng } }),
      });
      const d = r.data.data as { searchId: string; item: Item; profile: Profile; study: Study };
      const item: Item = { ...d.item, profile: d.profile, study: d.study };
      searchIdRef.current = d.searchId;
      setSearchId(d.searchId);
      // جلسة جديدة (إعادة تشغيل الخادم) لا تمسح المحلات المدروسة سابقاً
      setItems(list => (list.some(x => x.placeId === item.placeId) ? list.map(x => (x.placeId === item.placeId ? { ...x, ...item } : x)) : [...list, item]));
      setOpenId(item.placeId);
    } catch (e) {
      setMsg(errMsg(e) || (isNetworkError(e) ? tr('أنت دون اتصال — الدراسة تحتاج الإنترنت') : tr('تعذّرت دراسة المحل')));
    } finally { busyRef.current = false; setBusy(false); }
  }, [tr]);

  const onPoi = useCallback((p: { placeId: string }) => {
    const known = items.find(x => x.placeId === p.placeId && x.study);
    if (known) { setOpenId(known.placeId); return; } // لا نداء جديد لمحلٍّ دُرس في هذه الجلسة
    void study({ placeId: p.placeId });
  }, [items, study]);
  const studyHere = async () => {
    const gps = await locate();
    if (gps) void study({ here: { lat: gps.lat, lng: gps.lng, accuracyM: gps.accuracy } });
  };

  const onOutcome = (placeId: string, kind: string) => {
    setItems(list => list.map(x => (x.placeId === placeId
      ? { ...x, lastOutcome: kind, lastOutcomeAt: new Date().toISOString(), rejectedRecently: kind === 'NOT_INTERESTED' || kind === 'EXCLUSIVE_SUPPLIER', closed: kind === 'CLOSED' || x.closed }
      : x)));
    if (kind === 'CLOSED') setOpenId(null);
  };

  const open = openId ? items.find(x => x.placeId === openId) ?? null : null;
  const mapItems = useMemo(() => items.filter(i => !i.closed).map(i => ({ placeId: i.placeId, lat: i.lat, lng: i.lng, relation: i.relation, rejectedRecently: i.rejectedRecently, name: i.name, closed: i.closed })), [items]);
  const keyed = !!me?.mapsKey && !offline;
  const canStudy = !!me?.placesConfigured && !offline;
  // بلا مفتاح الخريطة: خريطة Google المضمّنة حول المندوب بمحلات النوع المستهدف الأول
  const embedQuery = (me?.targetTypes[0]?.label ?? 'بقالة').split('/')[0].trim();
  const embed = origin
    ? `https://maps.google.com/maps?q=${encodeURIComponent(tr(embedQuery))}&ll=${origin.lat.toFixed(5)},${origin.lng.toFixed(5)}&z=16&hl=${(document.documentElement.lang || 'ar').slice(0, 2)}&output=embed`
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
          g ? <RepAiMap full g={g} origin={origin} items={mapItems} plan={[]} fitKey={null} onSelect={id => setOpenId(id)} onPoi={onPoi} recenterKey={recenter} />
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
        <button onClick={() => void locate()} title={tr('موقعي')} className="pointer-events-auto w-10 h-10 rounded-full bg-white shadow-md flex items-center justify-center text-[#1D4ED8]"><Crosshair size={18} /></button>
      </div>

      {/* تلميح/زرّ سفلي */}
      {!open && (
        <div className="absolute bottom-4 inset-x-4 space-y-2">
          {msg && <p className="rounded-xl bg-white shadow-md p-2.5 text-sm text-center text-gray-700">{msg}</p>}
          {me && !me.placesConfigured && !offline ? (
            <p className="rounded-xl bg-amber-50 border border-amber-200 text-amber-800 text-xs text-center p-2.5 shadow-md">{tr('دراسة المحل من خرائط Google تحتاج مفتاح Google للمنصّة — لم يُضبط بعد')}</p>
          ) : keyed ? (
            <p className="rounded-full bg-[#1F1A13]/90 text-white text-sm text-center py-2.5 px-4 shadow-md">
              {busy ? tr('أدرس المحل من مراجعاته في خرائط Google…') : tr('اضغط على أي محل في الخريطة لدراسته')}
            </p>
          ) : (
            <button onClick={studyHere} disabled={busy || !canStudy}
              className="w-full rounded-2xl bg-[#E15A30] disabled:opacity-60 text-white py-3.5 font-bold shadow-lg flex items-center justify-center gap-2">
              <Crosshair size={18} /> {busy ? tr('أدرس المحل من مراجعاته في خرائط Google…') : tr('ادرس المحل الذي أنا عنده الآن')}
            </button>
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
    // السبب زرٌّ اختياري يُرسل مع النتائج المؤهّلة وحدها؛ الجسم نفسه يدخل صفّ الإرسال دون اتصال
    const body = {
      clientRef, placeId: item.placeId, outletType: item.outletType, kind,
      ...(objection && OBJECTION_OUTCOMES.has(kind) ? { objection } : {}),
      ...(note.trim() && { note: note.trim() }),
      ...(gps && { lat: gps.lat, lng: gps.lng, accuracyM: gps.accuracy }), occurredAt: new Date().toISOString(),
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
            {p?.rating != null && <><Stars value={p.rating} /><span>({p.ratingCount} {tr('مقيّماً')})</span></>}
            <span>{p?.typeLabel || tr(item.outletTypeLabel)}</span>
            <span>{fmtDistance(item.distanceM)}</span>
            {p?.openNow === true && <span className="text-green-700">{tr('مفتوح الآن')}</span>}
            {p?.openNow === false && <span className="text-red-600">{tr('مغلق الآن')}</span>}
            {item.relation === 'CUSTOMER' && <span className="text-blue-700">{tr('عميل حالي')}</span>}
            {item.relation === 'POSSIBLE_CUSTOMER' && <span className="text-blue-600">{tr('ربما عميل حالي')}</span>}
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
                  <p className="text-xs font-bold text-[#C94E28] flex items-center gap-1"><Sparkles size={13} /> {s.source === 'AI' ? tr('دراسة بالذكاء الاصطناعي من مراجعات Google') : tr('ملخّص من مراجعات Google')}</p>
                  <span className="text-[11px] rounded-full bg-white/80 px-2 py-0.5 text-[#1F1A13] font-semibold">{tr(ACTIVITY_LABEL[s.activity])}</span>
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
                )) : <p className="text-xs text-gray-500">{tr('لا مراجعات نصية لهذا المحل في خرائط Google')}</p>}
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

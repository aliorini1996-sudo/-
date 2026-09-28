import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, Crosshair, MapPin, Navigation, Sparkles, Store, UserPlus, X, ClipboardCheck } from 'lucide-react';
import repApi from './repApi';
import { cacheGet, cacheSet, currentRepId, newClientRef, outboxAdd } from './offlineDb';
import { isNetworkError } from './offlineSync';
import { useAiRepTr } from '../i18n/aiRepPhrases';
import { formatCurrency } from '../utils/format';
import { useBackClose } from '../lib/useBackClose';
import { loadGoogleMaps } from './googleMaps';
import RepAiMap from './RepAiMap';
import { loadAiSession, onConverted, saveAiSession, type AiAddPrefill } from './aiRepSession';
import { CONFIDENCE_LABEL, OBJECTIONS, OBJECTION_OUTCOMES, OUTCOMES, distKm, fmtDistance, fmtRange, navUrl } from './aiRepLogic';

/**
 * المندوب الذكي — شاشة المندوب: **الصفحة كلها خريطة Google**.
 *   - بمفتاح الخريطة: يضغط المندوب أي محل على الخريطة ⇒ يدرسه الخادم (نوعه وموقعه من Google، وتوقّع مشترياته
 *     لكل منتج من محلات شركته المشابهة) وتظهر الدراسة في لوحة سفلية فوق الخريطة.
 *   - بلا مفتاح: خريطة Google مضمّنة (لا تُبلغ التطبيق بالمحل المضغوط) وزرّ «ادرس المحل الذي أنا عنده الآن» بموقعه.
 * لا تبويبات ولا قوائم — الدراسة وحدها، ومنها: الملاحة، وتسجيل نتيجة الزيارة، وإضافته عميلاً.
 * الأسماء من Google تُعرض ولا تُخزَّن؛ المراجع P1… والإحداثيات يثبّتها الخادم في جلسة الدراسة.
 */

interface Range { low: number; median: number; high: number }
interface Item {
  ref: string; placeId: string; name: string; address: string | null; lat: number; lng: number; outletType: string; outletTypeLabel: string;
  distanceM: number; relation: 'NEW' | 'CUSTOMER' | 'POSSIBLE_CUSTOMER'; customerId: string | null;
  lastOutcome: string | null; lastOutcomeAt: string | null; rejectedRecently: boolean; closed?: boolean;
}
interface Me {
  placesConfigured: boolean; mapsKey?: string | null; showMoney: boolean; minPeers?: number;
  targetTypes: { code: string; label: string }[];
}
interface ProductEst {
  productId: string; name: string; unit: string; priority: boolean; buyers: number | null; peers: number; penetration: number | null;
  monthlyQty: Range | null; monthlyValue: Range | null; firstOrderQty: number | null; trialQty: number | null; confidence: string; hidden: null | 'FEW_BUYERS' | 'DOMINANT';
  trialCalibrated?: boolean;
}
interface Estimate { ok: boolean; confidence?: string; peers?: number; ringKm?: number | null; monthlyTotalValue?: Range | null; products?: ProductEst[]; why: string; minPeers?: number }
type StudyReq = { placeId?: string; lat?: number; lng?: number; here?: { lat: number; lng: number; accuracyM: number }; outletType?: string };

const ME_KEY = 'ai-rep:me';
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
  const [open, setOpen] = useState<{ item: Item; estimate?: Estimate } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [askType, setAskType] = useState<{ pending: StudyReq; name: string | null; types: { code: string; label: string }[] } | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [g, setG] = useState<any>(null);
  const [mapErr, setMapErr] = useState(false);
  const [mapAttempt, setMapAttempt] = useState(0);
  const [recenter, setRecenter] = useState(0);
  const searchIdRef = useRef(searchId);
  searchIdRef.current = searchId;
  const originRef = useRef(origin);
  originRef.current = origin;

  // حالة الشاشة في ذاكرة الجلسة: الرجوع أو «أضفه عميلاً» يفكّكان الشاشة، فتعود كما كانت
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
    if (busy) return;
    setBusy(true); setMsg(''); setAskType(null);
    try {
      const o = originRef.current;
      const r = await repApi.post('/ai-rep/rep/study', {
        ...req,
        ...(searchIdRef.current && { searchId: searchIdRef.current }),
        ...(o && { gps: { lat: o.lat, lng: o.lng } }),
      });
      const d = r.data.data as { needsType?: boolean; name?: string | null; types?: { code: string; label: string }[]; searchId: string; item: Item; estimate: Estimate };
      if (d.needsType) { setAskType({ pending: req, name: d.name ?? null, types: d.types ?? me?.targetTypes ?? [] }); return; }
      if (d.searchId !== searchIdRef.current) {
        searchIdRef.current = d.searchId;
        setSearchId(d.searchId);
        setItems([d.item]);
      } else {
        setItems(list => (list.some(x => x.placeId === d.item.placeId) ? list.map(x => (x.placeId === d.item.placeId ? d.item : x)) : [...list, d.item]));
      }
      setOpen({ item: d.item, estimate: d.estimate });
    } catch (e) {
      setMsg(errMsg(e) || (isNetworkError(e) ? tr('أنت دون اتصال — الدراسة تحتاج الإنترنت') : tr('تعذّرت دراسة المحل')));
    } finally { setBusy(false); }
  }, [busy, me?.targetTypes, tr]);

  const onPoi = useCallback((p: { placeId: string; lat: number; lng: number }) => { void study({ placeId: p.placeId, lat: p.lat, lng: p.lng }); }, [study]);
  const studyHere = async () => {
    const gps = await locate();
    if (gps) void study({ here: { lat: gps.lat, lng: gps.lng, accuracyM: gps.accuracy } });
  };
  const selectStudied = useCallback((placeId: string) => {
    const it = items.find(x => x.placeId === placeId);
    if (it) setOpen({ item: it });
  }, [items]);

  const onOutcome = (placeId: string, kind: string) => {
    setItems(list => list.map(x => (x.placeId === placeId
      ? { ...x, lastOutcome: kind, lastOutcomeAt: new Date().toISOString(), rejectedRecently: kind === 'NOT_INTERESTED' || kind === 'EXCLUSIVE_SUPPLIER', closed: kind === 'CLOSED' || x.closed }
      : x)));
    if (kind === 'CLOSED') setOpen(null);
  };

  const money = useCallback((n: number) => formatCurrency(n, undefined, 0), []);
  const mapItems = useMemo(() => items.filter(i => !i.closed).map(i => ({ placeId: i.placeId, lat: i.lat, lng: i.lng, relation: i.relation, rejectedRecently: i.rejectedRecently, name: i.name, closed: i.closed })), [items]);
  const keyed = !!me?.mapsKey && !offline;
  // بلا مفتاح: خريطة Google المضمّنة حول المندوب بمحلات النوع المستهدف الأول
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
          g ? <RepAiMap full g={g} origin={origin} items={mapItems} plan={[]} fitKey={null} onSelect={selectStudied} onPoi={onPoi} recenterKey={recenter} />
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
      {!open && !askType && (
        <div className="absolute bottom-4 inset-x-4 space-y-2">
          {msg && <p className="rounded-xl bg-white shadow-md p-2.5 text-sm text-center text-gray-700">{msg}</p>}
          {keyed ? (
            <p className="rounded-full bg-[#1F1A13]/90 text-white text-sm text-center py-2.5 px-4 shadow-md">
              {busy ? tr('أدرس المحل من بيانات شركتك…') : tr('اضغط على أي محل في الخريطة لدراسته')}
            </p>
          ) : (
            <button onClick={studyHere} disabled={busy || offline || !me}
              className="w-full rounded-2xl bg-[#E15A30] disabled:opacity-60 text-white py-3.5 font-bold shadow-lg flex items-center justify-center gap-2">
              <Crosshair size={18} /> {busy ? tr('أدرس المحل من بيانات شركتك…') : tr('ادرس المحل الذي أنا عنده الآن')}
            </button>
          )}
        </div>
      )}

      {/* نوع المحل حين لا تعرفه Google */}
      {askType && (
        <TypeSheet name={askType.name} types={askType.types} onClose={() => setAskType(null)}
          onPick={code => void study({ ...askType.pending, outletType: code })} />
      )}

      {open && (
        <OutletSheet item={open.item} initial={open.estimate} searchId={searchId} showMoney={!!me?.showMoney} money={money} minPeers={me?.minPeers ?? 5}
          canAddCustomer={canAddCustomer} offline={offline} onClose={() => setOpen(null)}
          onAddCustomer={onAddCustomer} onOpenCustomer={onOpenCustomer}
          onOutcome={kind => onOutcome(open.item.placeId, kind)} />
      )}
    </div>
  );
}

/** نوع المحل حين لم تحدّده Google (زرّ واحد ثم الدراسة). */
function TypeSheet({ name, types, onPick, onClose }: { name: string | null; types: { code: string; label: string }[]; onPick: (code: string) => void; onClose: () => void }) {
  const tr = useAiRepTr();
  useBackClose(true, onClose);
  return (
    <div className="absolute inset-x-0 bottom-0 z-40 bg-white rounded-t-3xl shadow-2xl p-4 space-y-3" dir="rtl">
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <p className="font-bold text-[#1F1A13]">{tr('ما نوع هذا المحل؟')}</p>
          {name && <p className="text-xs text-gray-500 truncate">{name}</p>}
        </div>
        <button onClick={onClose} className="p-1.5 text-gray-500"><X size={18} /></button>
      </div>
      <div className="flex flex-wrap gap-2">
        {types.map(t => (
          <button key={t.code} onClick={() => onPick(t.code)} className="rounded-full border border-[#F5DACE] bg-[#FBEBE2] text-[#C94E28] px-3.5 py-2 text-sm font-semibold">{tr(t.label)}</button>
        ))}
      </div>
    </div>
  );
}

/** نسب Google Maps بجوار أي اسم من Places (شرط Google). */
function GoogleAttribution() {
  return <p className="text-xs text-gray-500 text-left" dir="ltr">Google Maps</p>;
}

/** دراسة المحل: لوحة سفلية فوق الخريطة. */
function OutletSheet({ item, initial, searchId, showMoney, money, minPeers, canAddCustomer, offline, onClose, onAddCustomer, onOpenCustomer, onOutcome }: {
  item: Item; initial?: Estimate; searchId: string | null; showMoney: boolean; money: (n: number) => string; minPeers: number; canAddCustomer: boolean; offline: boolean;
  onClose: () => void; onAddCustomer: (p: AiAddPrefill) => void; onOpenCustomer: (id: string) => Promise<boolean>; onOutcome: (kind: string) => void;
}) {
  const tr = useAiRepTr();
  const [est, setEst] = useState<Estimate | null>(initial ?? null);
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
  // زر الرجوع وسحبة الحافة يغلقان اللوحة (لا يُخرجان من الشاشة)
  useBackClose(true, onClose);
  useBackClose(mode === 'outcome', () => setMode('view'));

  // الدراسة تصل مع الضغطة؛ إعادة فتح محلٍّ مدروس سابقاً تجلبها من جديد
  useEffect(() => {
    if (initial) { setEst(initial); return; }
    let alive = true;
    setEst(null); setErr('');
    if (!searchId || offline) { setErr(offline ? tr('أنت دون اتصال') : tr('تعذّرت دراسة المحل')); return; }
    repApi.post('/ai-rep/rep/estimate', { searchId, ref: item.ref })
      .then(r => { if (alive) setEst(r.data.data as Estimate); })
      .catch(e => { if (alive) setErr(errMsg(e) || (isNetworkError(e) ? tr('أنت دون اتصال') : tr('تعذّر حساب التوقّع'))); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.placeId, searchId, offline, initial]);

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
    <div className="absolute inset-x-0 bottom-0 z-40 max-h-[82%] bg-white rounded-t-3xl shadow-2xl flex flex-col" dir="rtl">
      <div className="p-4 pb-3 flex items-start gap-2 border-b border-gray-100 flex-shrink-0">
        <div className="flex-1 min-w-0">
          <p className="font-bold text-[#1F1A13] flex items-center gap-1.5"><Store size={17} className="text-[#E15A30] shrink-0" /> <span className="truncate">{item.name || tr(item.outletTypeLabel)}</span></p>
          <p className="text-[11px] text-gray-400 mt-0.5">
            {tr(item.outletTypeLabel)} · {fmtDistance(item.distanceM)}
            {item.relation === 'CUSTOMER' ? ` · ${tr('عميل حالي')}` : item.relation === 'POSSIBLE_CUSTOMER' ? ` · ${tr('ربما عميل حالي')}` : ''}
          </p>
          {item.name && <GoogleAttribution />}
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

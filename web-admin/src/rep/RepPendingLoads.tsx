import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, ArrowRight, Check, CheckCircle2, ChevronLeft, FileText, MessageSquareWarning, PenLine, RefreshCw, Truck, WifiOff } from 'lucide-react';
import repApi from './repApi';
import { cacheGet, cacheSet, currentRepId } from './offlineDb';
import { isNetworkError } from './offlineSync';
import SignaturePad from './SignaturePad';
import { DocumentResult, loadNoticeDocFromData, type Company, type LoadNoticeDoc } from './RepDocuments';
import { VAN_CURRENT_CACHE_PREFIX, type VanCurrentCache } from './vanStockOffline';
import { useBackClose } from '../lib/useBackClose';
import { useTr } from '../i18n/strings';
import { activeLocale, formatDateTime } from '../utils/format';
import {
  PENDING_LOAD_MESSAGES, acceptanceOf, fetchPendingDetail, fetchPendingList, normalizePendingLoad, noticeMovementOf, pendingLoadsClient,
  type PendingLoadCounts, type PendingLoadList, type PendingVanLoadView,
} from '../lib/pendingLoads';
import {
  DISPUTE_NOTE_MAX, PENDING_COUNTS_FRESH_MS, acceptBlocked, acceptBodyOf, activeRowStale, disputeNoteOf, lineLotText, lineQtyText,
  pendingCacheEntry, pendingCacheOf, pendingHomeCardOf, pendingLoadsCacheKey, repPendingFailureOf, repPendingFailureText, repPendingSections,
} from './vanLoadAcceptance';

/*
 * «قبول المندوب للتحميل وتوقيعه» (طلب المالك ٢٢ نوفمبر ٢٠٢٦) — شاشة المندوب:
 * - بطاقة الرئيسية «تحميل بانتظار قبولك (n)» وشريط «مخزون سيارتي» — لشركةٍ فعّلت الميزة وحدها (vanLoadAcceptance في /company)،
 *   فالشركة المطفأة لا طلب لها ولا مظهر.
 * - الشاشة: الأصناف بكمياتها ووحداتها وتشغيلاتها، و«قبول وتوقيع» (لوحة التوقيع ونصّ الإقرار) أو «اعتراض» بسببٍ إلزامي.
 * - القبول والاعتراض متصلان وحدهما؛ ودون اتصال آخر قائمةٍ محفوظة بلا أزرار. وبعد القبول تُحدَّث أرصدة السيارة ولقطة اللوط.
 * - المقبول مؤخراً: «إشعار PDF» نسخة المندوب مما وقّعه — إشعار التحميل نفسه بإقراره وتوقيعه ولحظة قبوله (كالإدارة حرفاً).
 * العقد والعميل المشتركان في lib/pendingLoads.ts، وما يخصّ المندوب (الأقسام والكاش والجسمان والرفض) في vanLoadAcceptance.ts.
 */

// ───────── الطلبات ─────────

/** عميل المعلّق المشترك على جلسة المندوب — القائمة والقبول والاعتراض */
const client = pendingLoadsClient(repApi);

/** آخر عدّادٍ معروف لهذا المندوب — الرئيسية تُركَّب مع كل تبديل تبويب، فلا طلب لكل تركيب */
let countsMemo: { repId: string; at: number; counts: PendingLoadCounts } | null = null;

/** يحفظ القائمة لصاحب الجلسة (للعرض دون اتصال) ويحدّث العدّاد — ردٌّ لجلسةٍ خرجت أو تبدّلت أثناء الطلب لا يُخزَّن */
function keepList(me: string | undefined, list: PendingLoadList): void {
  if (!me || currentRepId() !== me) return;
  countsMemo = { repId: me, at: Date.now(), counts: list.counts };
  void cacheSet(pendingLoadsCacheKey(me), pendingCacheEntry(me, list)).catch(() => undefined);
}

/** قائمة المندوب (صفوفه PENDING وDISPUTED والمقبول مؤخراً) — الشاشة بطلبٍ عادي */
async function loadMyList(): Promise<PendingLoadList> {
  const me = currentRepId();
  const list = await fetchPendingList(client);
  keepList(me, list);
  return list;
}

/** العدّاد بطلبٍ خلفيّ: فشلٌ عابر بـ401 لا يُخرج المندوب (بطاقةٌ تلقائية لا فعلٌ منه) */
async function loadMyCounts(): Promise<PendingLoadCounts> {
  const me = currentRepId();
  const list = await fetchPendingList(client, {}, { background: true });
  keepList(me, list);
  return list.counts;
}

async function cachedPendingLoads(): Promise<{ at: number; list: PendingLoadList } | null> {
  const me = currentRepId();
  if (!me) return null;
  const hit = await cacheGet<unknown>(pendingLoadsCacheKey(me)).catch(() => null);
  const c = pendingCacheOf(hit?.data, me);
  return c ? { at: c.at, list: c.list } : null;
}

/** بعد القبول: أرصدة السيارة المحفوظة (البند ١٣) تُجلب من جديد فلا تُعرض دون اتصال بلا التحميل الذي دخلها للتوّ */
async function refreshVanCurrentCache(): Promise<void> {
  const me = currentRepId();
  if (!me) return;
  const startedAt = Date.now();
  try {
    const r = await repApi.get('/van-stock/current', { background: true });
    const rows = (Array.isArray(r.data?.data) ? r.data.data : []) as unknown[];
    if (currentRepId() !== me) return;
    await cacheSet<VanCurrentCache<unknown>>(VAN_CURRENT_CACHE_PREFIX + me, { v: 1, repId: me, fetchedAt: startedAt, rows });
  } catch { /* تُجلب حين تُفتح «مخزون سيارتي» */ }
}

/**
 * عدّاد البطاقة: المعروف حديثاً (٣٠ ثانية) ثم الخادم، ودون اتصال آخر قائمةٍ محفوظة. 403/404 (المحاسبة مطفأة أو خادمٌ أقدم) ⇒
 * لا بطاقة. ورجوع التطبيق إلى الواجهة يعيد السؤال — أرسلت الإدارة تحميلاً والتطبيق في الخلفية.
 */
export function usePendingLoadCounts(enabled: boolean): PendingLoadCounts | null {
  const [counts, setCounts] = useState<PendingLoadCounts | null>(() => {
    const me = currentRepId();
    return enabled && countsMemo && me && countsMemo.repId === me ? countsMemo.counts : null;
  });
  useEffect(() => {
    if (!enabled) { setCounts(null); return; }
    let alive = true;
    let last = 0;
    const run = async (force: boolean) => {
      const me = currentRepId();
      if (!me) return;
      if (!force && countsMemo && countsMemo.repId === me && Date.now() - countsMemo.at < PENDING_COUNTS_FRESH_MS) {
        setCounts(countsMemo.counts);
        return;
      }
      last = Date.now();
      try {
        const c = await loadMyCounts();
        if (alive && currentRepId() === me) setCounts(c);
      } catch (e) {
        if (!alive) return;
        const status = (e as { response?: { status?: number } })?.response?.status;
        if (status === 403 || status === 404) { setCounts(null); return; }
        if (isNetworkError(e)) {
          const c = await cachedPendingLoads();
          if (alive) setCounts(c ? c.list.counts : null);
        }
      }
    };
    void run(false);
    const onVisible = () => {
      if (document.visibilityState === 'visible' && Date.now() - last >= PENDING_COUNTS_FRESH_MS) void run(true);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => { alive = false; document.removeEventListener('visibilitychange', onVisible); };
  }, [enabled]);
  return enabled ? counts : null;
}

// ───────── بطاقة الرئيسية وشريط «مخزون سيارتي» ─────────

/** بطاقة الرئيسية: «تحميل بانتظار قبولك (n)» بارزةً، وإلا «اعتراضك قيد مراجعة الإدارة (n)» هادئةً، ولا شيء بلاهما */
export function PendingLoadsHomeCard({ onOpen }: { onOpen: () => void }) {
  const tr = useTr();
  const card = pendingHomeCardOf(usePendingLoadCounts(true));
  if (!card) return null;
  const n = card.n.toLocaleString(activeLocale());
  if (card.kind === 'disputed') {
    return (
      <button type="button" onClick={onOpen}
        className="w-full text-right bg-amber-50 rounded-2xl px-4 py-3 border border-amber-200 flex items-center gap-3">
        <MessageSquareWarning size={20} className="text-amber-700 shrink-0" />
        <span className="flex-1 text-xs font-semibold text-amber-800">{tr('اعتراضك على التحميل قيد مراجعة الإدارة')} ({n})</span>
        <ChevronLeft size={16} className="text-amber-700 shrink-0" />
      </button>
    );
  }
  return (
    <button type="button" onClick={onOpen}
      className="w-full text-right bg-[#FBEBE2] rounded-3xl p-5 border-2 border-[#E15A30] flex items-center justify-between gap-3 shadow-sm">
      <div className="min-w-0">
        <p className="text-base font-extrabold text-[#1F1A13]">{tr('تحميل بانتظار قبولك')} ({n})</p>
        <p className="text-[11px] text-[#6E6557] mt-1 leading-relaxed">{tr('أرسلت الإدارة بضاعة لسيارتك — راجعها ثم اقبلها ووقّع عليها')}</p>
        <span className="inline-flex items-center gap-1 mt-2 text-xs font-bold text-white bg-[#E15A30] rounded-full px-3 py-1">
          <PenLine size={13} /> {tr('قبول وتوقيع')}
        </span>
      </div>
      <div className="w-14 h-14 bg-white rounded-2xl flex items-center justify-center shrink-0">
        <Truck size={26} className="text-[#E15A30]" />
      </div>
    </button>
  );
}

/** شريط أعلى «مخزون سيارتي» — يظهر بتحميلٍ ينتظر قبوله وحده */
export function PendingLoadsStrip({ onOpen }: { onOpen: () => void }) {
  const tr = useTr();
  const counts = usePendingLoadCounts(true);
  if (!counts || counts.pending <= 0) return null;
  return (
    <button type="button" onClick={onOpen}
      className="shrink-0 w-full bg-[#FBEBE2] text-[#1F1A13] border-b border-[#F5DACE] text-xs font-bold py-2.5 px-3 flex items-center gap-2 text-right">
      <Truck size={16} className="text-[#E15A30] shrink-0" />
      <span className="flex-1">{tr('تحميل بانتظار قبولك')} ({counts.pending.toLocaleString(activeLocale())})</span>
      <span className="shrink-0 text-[#E15A30] inline-flex items-center gap-0.5">{tr('قبول وتوقيع')} <ChevronLeft size={14} /></span>
    </button>
  );
}

// ───────── الشاشة ─────────

/** اللوحة المفتوحة — ومعها revision الصفّ لحظة فتحها: القائمة تتجدّد تحتها، فصفٌّ عدّلته الإدارة يُغلقها */
type Active = { id: string; mode: 'accept' | 'dispute'; revision: number } | null;
type Net = { kind: 'ok' } | { kind: 'cached'; at: number } | { kind: 'none' };

export default function RepPendingLoads({ onBack, onAccepted, onOpenVanStock, company = null, repName = '' }: {
  onBack: () => void;
  /** بعد قبولٍ نجح — التطبيق يحدّث لقطة اللوط (البيع يعرف التشغيلات التي دخلت السيارة) */
  onAccepted?: () => void;
  onOpenVanStock?: () => void;
  /** إعدادات الشركة لترويسة إشعار التحميل الموقَّع */
  company?: Company | null;
  /** اسم المندوب — احتياطٌ لإقرار الإشعار إن غاب من ردّ الخادم */
  repName?: string;
}) {
  const tr = useTr();
  const [list, setList] = useState<PendingLoadList | null>(null);
  const [net, setNet] = useState<Net>({ kind: 'ok' });
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine !== false);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; vanStock?: boolean } | null>(null);
  const [active, setActive] = useState<Active>(null);
  const [signature, setSignature] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  // خطأ القبول على البطاقة نفسها — ومعه دعوة الاعتراض حين الخلل في المستودع أو الأصناف
  const [cardErr, setCardErr] = useState<{ id: string; text: string; dispute: boolean } | null>(null);
  const fix = useRef<{ lat: number; lng: number } | null>(null);
  // إشعار التحميل المقبول (نسخة المندوب الموقَّعة) — يحلّ محلّ القائمة داخل الشاشة، والرجوع يعيدها
  const [notice, setNotice] = useState<LoadNoticeDoc | null>(null);
  const [printing, setPrinting] = useState<string | null>(null);
  useBackClose(active !== null, () => setActive(null));
  useBackClose(notice !== null, () => setNotice(null));

  const fmt = (n: number) => Number(n.toFixed(3)).toLocaleString(activeLocale());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setList(await loadMyList());
      setNet({ kind: 'ok' });
    } catch (e) {
      if (isNetworkError(e)) {
        const c = await cachedPendingLoads();
        if (c) { setList(c.list); setNet({ kind: 'cached', at: c.at }); } else setNet({ kind: 'none' });
      } else {
        setMsg({ ok: false, text: repPendingFailureText(e, tr, 'load') });
      }
    }
    setLoading(false);
  }, [tr]);
  useEffect(() => { void load(); }, [load]);

  // الاتصال يعود ⇒ القائمة من الخادم وتعود الأزرار
  useEffect(() => {
    const on = () => { setOnline(true); void load(); };
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, [load]);

  // رجوع التطبيق إلى الواجهة (لمس إشعار «تحميل بانتظار قبولك» والشاشة مفتوحة، أو عودةٌ بعد مدة) ⇒ القائمة من الخادم —
  // لا أثناء قبولٍ أو اعتراضٍ جارٍ
  const busyRef = useRef(false);
  busyRef.current = busy;
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible' && !busyRef.current) void load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [load]);

  // القائمة تجدّدت واللوحة مفتوحة: صفٌّ عدّلته الإدارة (revision آخر) أو لم يعد مفتوحاً ⇒ تُغلق اللوحة ويُمحى التوقيع —
  // فلا يُقبل بتوقيعٍ رُسم والأصناف المعروضة غير التي يقرّ بها الآن (الخادم يحرس revision المرسَل، وهذا يحرس المرسِل)
  useEffect(() => {
    if (!active || !list) return;
    const row = list.rows.find((r) => r.id === active.id);
    if (!activeRowStale(active, row)) return;
    setActive(null); setSignature(null);
    setMsg({ ok: false, text: tr(row?.status === 'PENDING' ? PENDING_LOAD_MESSAGES.PENDING_LOAD_REVISED : PENDING_LOAD_MESSAGES.PENDING_LOAD_NOT_PENDING) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list]);

  // الموقع اختياريٌّ مع القبول: قراءةٌ تبدأ بفتح لوحة التوقيع فلا ينتظرها الإرسال — وتعذّرها لا يمنع شيئاً
  useEffect(() => {
    fix.current = null;
    if (active?.mode !== 'accept' || typeof navigator === 'undefined' || !navigator.geolocation) return;
    let alive = true;
    try {
      navigator.geolocation.getCurrentPosition(
        (p) => { if (alive) fix.current = { lat: p.coords.latitude, lng: p.coords.longitude }; },
        () => { /* بلا موقع */ },
        { enableHighAccuracy: false, maximumAge: 5 * 60 * 1000, timeout: 10000 },
      );
    } catch { /* بلا موقع */ }
    return () => { alive = false; };
  }, [active]);

  const open = (row: PendingVanLoadView, mode: 'accept' | 'dispute', initialNote = '') => {
    setActive({ id: row.id, mode, revision: row.revision }); setSignature(null); setNote(initialNote); setMsg(null); setCardErr(null);
  };

  const replaceRow = (row: PendingVanLoadView | null) => {
    if (!row) return;
    setList((cur) => (cur ? { ...cur, rows: cur.rows.map((r) => (r.id === row.id ? row : r)) } : cur));
  };

  const accept = async (row: PendingVanLoadView) => {
    const body = acceptBodyOf(signature, row.revision, fix.current);
    if (!body) { setCardErr({ id: row.id, text: tr('وقّع لإقرار استلام البضاعة'), dispute: false }); return; }
    if (!online) { setCardErr({ id: row.id, text: tr('قبول التحميل وتوقيعه يتمّان والجهاز متصل'), dispute: false }); return; }
    setBusy(true); setCardErr(null); setMsg(null);
    try {
      // replay: قبولٌ سابق ضاع ردّه — الخادم يعيد الصفّ المقبول نفسه بلا حركةٍ ثانية
      await client.accept(row.id, body);
      setActive(null); setSignature(null);
      setMsg({ ok: true, text: tr('تم قبول التحميل ودخلت البضاعة سيارتك'), vanStock: !!onOpenVanStock });
      onAccepted?.();
      void refreshVanCurrentCache();
      await load();
    } catch (e) {
      const f = repPendingFailureOf(e);
      const text = repPendingFailureText(e, tr, 'accept');
      if (f.reload) {
        // عدّلتها الإدارة أو ألغتها أو قُبلت من جهازٍ آخر: تُغلق اللوحة وتُعرض الأصناف كما هي الآن ليراجعها ويوقّع من جديد
        setActive(null); setSignature(null);
        replaceRow(f.row);
        setMsg({ ok: false, text });
        await load();
      } else {
        setCardErr({ id: row.id, text, dispute: f.invitesDispute });
      }
    }
    setBusy(false);
  };

  const dispute = async (row: PendingVanLoadView) => {
    const n = disputeNoteOf(note);
    if (!n) { setCardErr({ id: row.id, text: tr('اكتب سبب الاعتراض'), dispute: false }); return; }
    if (!online) { setCardErr({ id: row.id, text: tr('الاعتراض يرسل والجهاز متصل'), dispute: false }); return; }
    setBusy(true); setCardErr(null); setMsg(null);
    try {
      const r = await client.dispute(row.id, n);
      replaceRow(normalizePendingLoad((r.data as { data?: unknown } | null)?.data));
      setActive(null); setNote('');
      setMsg({ ok: true, text: tr('تم إرسال اعتراضك للإدارة') });
      await load();
    } catch (e) {
      const f = repPendingFailureOf(e);
      const text = repPendingFailureText(e, tr, 'dispute');
      if (f.reload) { setActive(null); replaceRow(f.row); setMsg({ ok: false, text }); await load(); }
      else setCardErr({ id: row.id, text, dispute: false });
    }
    setBusy(false);
  };

  /**
   * «إشعار PDF» للمقبول: الصفّ بتوقيعه والحركة التي كتبها القبول (GET /pending-loads/:id — المندوب يقرأ صفوفه وحده)، ثم إشعار
   * التحميل بإقراره وتوقيعه ولحظة قبوله — البانية نفسها التي تطبع بها الإدارة. يحتاج اتصالاً (التوقيع لا يُحفظ في الجهاز)
   */
  const openNotice = async (row: PendingVanLoadView) => {
    setPrinting(row.id); setCardErr(null);
    try {
      const d = await fetchPendingDetail(client, row.id);
      if (!d) throw new Error('missing');
      const v = { ...d.view, repName: d.view.repName || row.repName || repName };
      setNotice(loadNoticeDocFromData(v.repName, noticeMovementOf(v, d.vanLoad), company, acceptanceOf(v)));
    } catch (e) {
      setCardErr({ id: row.id, text: repPendingFailureText(e, tr, 'load'), dispute: false });
    }
    setPrinting(null);
  };

  const sections = repPendingSections(list?.rows ?? []);
  const empty = !!list && sections.pending.length + sections.disputed.length + sections.accepted.length === 0;
  const actionsOn = online && net.kind === 'ok';

  const lines = (row: PendingVanLoadView) => (
    <div className="divide-y divide-gray-100">
      {row.lines.map((l, i) => (
        <div key={`${l.productId}-${i}`} className="py-2 flex items-start gap-2">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-[#1F1A13] truncate">
              {l.name || '—'}
              {l.missing && <span className="ms-1.5 rounded-full bg-red-50 text-red-700 px-1.5 py-0.5 text-[10px] font-semibold">{tr('محذوف')}</span>}
            </p>
            {l.code && <p className="text-[10px] text-gray-400 truncate" dir="ltr">{l.code}</p>}
            {l.lots.map((x, j) => (
              <p key={`${x.lotId ?? x.lotNumber ?? 'u'}-${j}`} className="text-[11px] text-[#6E6557]">
                {tr('التشغيلة')}: <span dir="auto">{lineLotText(x, l, tr, fmt)}</span>
              </p>
            ))}
          </div>
          <p className="shrink-0 text-sm font-bold text-[#1F1A13] tabular-nums text-left">{lineQtyText(l, fmt)}</p>
        </div>
      ))}
      {row.lines.length === 0 && <p className="py-2 text-xs text-gray-400">—</p>}
    </div>
  );

  const head = (row: PendingVanLoadView) => (
    <div className="flex items-start justify-between gap-2">
      <div className="min-w-0">
        <p className="text-sm font-bold text-[#1F1A13] flex items-center gap-1.5"><Truck size={16} className="text-[#E15A30] shrink-0" /> {tr('تحميل بضاعة للسيارة')}</p>
        <p className="text-[11px] text-gray-500 mt-0.5">
          {row.createdAt ? formatDateTime(row.createdAt) : ''}
          {row.createdByName ? ` · ${tr('بواسطة')} ${row.createdByName}` : ''}
        </p>
      </div>
      <span className="shrink-0 text-[10px] text-gray-500 bg-gray-100 rounded-full px-2 py-0.5">{tr('عدد الأصناف')} {row.lines.length.toLocaleString(activeLocale())}</span>
    </div>
  );

  const errBox = (row: PendingVanLoadView) => cardErr && cardErr.id === row.id && (
    <div className="bg-red-50 border border-red-200 text-red-700 text-xs rounded-xl px-3 py-2 space-y-1.5">
      <p className="flex items-start gap-1.5"><AlertTriangle size={14} className="shrink-0 mt-0.5" /> <span>{cardErr.text}</span></p>
      {cardErr.dispute && actionsOn && (
        <button type="button" onClick={() => open(row, 'dispute')} className="font-bold underline">{tr('اعتراض')}</button>
      )}
    </div>
  );

  if (notice) return <DocumentResult doc={notice} onClose={() => setNotice(null)} />;

  return (
    <div className="h-full flex flex-col">
      <div className="p-3 flex items-center gap-2 border-b border-gray-100">
        <button type="button" onClick={onBack} aria-label={tr('رجوع')} className="p-1.5 text-[#6E6557]"><ArrowRight size={18} /></button>
        <span className="font-bold text-[#1F1A13] flex-1">{tr('قبول التحميل')}</span>
        <button type="button" onClick={() => { setMsg(null); void load(); }} aria-label={tr('تحديث')} disabled={loading}
          className="p-1.5 text-[#6E6557] disabled:opacity-50">
          <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {(!online || net.kind !== 'ok') && (
        <div className="mx-3 mt-3 bg-gray-100 text-gray-700 text-xs rounded-lg px-3 py-2 flex items-start gap-1.5">
          <WifiOff size={14} className="shrink-0 mt-0.5" />
          <span>
            {tr('قبول التحميل وتوقيعه يتمّان والجهاز متصل')}
            {net.kind === 'cached' && (
              <> · {tr('غير متصل — آخر تحديث {time}').replace('{time}', () => new Date(net.at).toLocaleString(activeLocale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))}</>
            )}
          </span>
        </div>
      )}
      {msg && (
        <div className={`mx-3 mt-3 text-xs rounded-lg px-3 py-2 flex items-center gap-1.5 ${msg.ok ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
          {msg.ok ? <Check size={14} className="shrink-0" /> : <AlertTriangle size={14} className="shrink-0" />}
          <span className="flex-1">{msg.text}</span>
          {msg.vanStock && onOpenVanStock && (
            <button type="button" onClick={onOpenVanStock} className="shrink-0 font-bold underline inline-flex items-center gap-1">
              <Truck size={13} /> {tr('مخزون سيارتي')}
            </button>
          )}
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-3 space-y-3 pb-24">
        {loading && !list ? <p className="text-center text-gray-400 text-sm py-8">{tr('جار التحميل')}</p>
          : !list && net.kind === 'none' ? (
            <div className="text-center py-10">
              <WifiOff size={36} className="mx-auto text-gray-300 mb-2" />
              <p className="text-gray-400 text-sm">{tr('قبول التحميل وتوقيعه يتمّان والجهاز متصل')}</p>
            </div>
          )
          : empty ? (
            <div className="text-center py-10">
              <CheckCircle2 size={40} className="mx-auto text-gray-300 mb-2" />
              <p className="text-gray-400 text-sm">{tr('لا توجد تحميلات بانتظار قبولك')}</p>
            </div>
          ) : null}

        {sections.pending.map((row) => {
          const isActive = active?.id === row.id;
          const blocked = acceptBlocked(row);
          return (
            <div key={row.id} className="bg-white border-2 border-[#F5DACE] rounded-2xl p-3 shadow-sm space-y-2">
              {head(row)}
              {row.revision > 1 && (
                <p className="text-[11px] font-semibold text-amber-800 bg-amber-50 rounded-lg px-2 py-1">{tr('عدلت الإدارة هذا التحميل راجع الأصناف قبل التوقيع')}</p>
              )}
              {row.note && <p className="text-[11px] text-[#6E6557] bg-[#FAF7F0] rounded-lg px-2 py-1">{tr('ملاحظة')}: {row.note}</p>}
              {lines(row)}
              {/* صنفٌ حُذف بعد الإرسال: القبول سيُرفض — الاعتراض يبلّغ الإدارة لتعدّله أو تلغيه */}
              {blocked && (
                <p className="text-[11px] font-semibold text-red-700 bg-red-50 rounded-lg px-2 py-1">
                  {tr('تغيّرت أصناف هذا التحميل أو وحداتها منذ إرساله — أبلغ الإدارة لتعديله')}
                </p>
              )}
              {errBox(row)}

              {isActive && active?.mode === 'accept' ? (
                <div className="border-t border-gray-100 pt-3 space-y-2">
                  <p className="text-sm font-bold text-[#1F1A13] bg-[#FAF7F0] border border-[#E9E1D3] rounded-xl px-3 py-2 leading-relaxed">
                    {tr('أقرّ باستلام البضاعة الموضحة أعلاه كاملة وسليمة')}
                  </p>
                  <SignaturePad value={signature} onChange={setSignature} clearLabel={tr('مسح التوقيع')} placeholder={tr('توقيع المندوب هنا')} />
                  {!signature && <p className="text-[11px] text-gray-400">{tr('وقّع لإقرار استلام البضاعة')}</p>}
                  <div className="flex gap-2">
                    <button type="button" onClick={() => { void accept(row); }} disabled={busy || !signature || !actionsOn}
                      className="flex-1 bg-[#E15A30] disabled:bg-[#E89B7E] text-white font-bold py-3 rounded-xl flex items-center justify-center gap-2 text-sm">
                      {busy ? <span className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Check size={18} />}
                      {tr('تأكيد القبول')}
                    </button>
                    <button type="button" onClick={() => setActive(null)} disabled={busy}
                      className="px-4 rounded-xl border border-gray-200 text-sm font-semibold text-[#6E6557]">{tr('إلغاء')}</button>
                  </div>
                </div>
              ) : isActive && active?.mode === 'dispute' ? (
                <div className="border-t border-gray-100 pt-3 space-y-2">
                  <label className="text-xs font-semibold text-[#6E6557] block">{tr('سبب الاعتراض')}</label>
                  <textarea value={note} onChange={(e) => setNote(e.target.value.slice(0, DISPUTE_NOTE_MAX))} rows={3} maxLength={DISPUTE_NOTE_MAX}
                    placeholder={tr('اكتب سبب الاعتراض')}
                    className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm resize-none" />
                  <p className="text-[10px] text-gray-400 text-left tabular-nums" dir="ltr">{note.length}/{DISPUTE_NOTE_MAX}</p>
                  <div className="flex gap-2">
                    <button type="button" onClick={() => { void dispute(row); }} disabled={busy || !disputeNoteOf(note) || !actionsOn}
                      className="flex-1 bg-[#1F1A13] disabled:bg-gray-300 text-white font-bold py-3 rounded-xl flex items-center justify-center gap-2 text-sm">
                      {busy ? <span className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <MessageSquareWarning size={18} />}
                      {tr('إرسال الاعتراض')}
                    </button>
                    <button type="button" onClick={() => setActive(null)} disabled={busy}
                      className="px-4 rounded-xl border border-gray-200 text-sm font-semibold text-[#6E6557]">{tr('إلغاء')}</button>
                  </div>
                </div>
              ) : (
                <div className="flex gap-2 pt-1">
                  <button type="button" onClick={() => open(row, 'accept')} disabled={!actionsOn || busy || blocked}
                    className="flex-1 bg-[#E15A30] disabled:bg-[#E89B7E] text-white font-bold py-3 rounded-xl flex items-center justify-center gap-2 text-sm">
                    <PenLine size={18} /> {tr('قبول وتوقيع')}
                  </button>
                  <button type="button" onClick={() => open(row, 'dispute')} disabled={!actionsOn || busy}
                    className="px-4 rounded-xl border-2 border-red-200 text-red-600 disabled:opacity-50 text-sm font-bold flex items-center gap-1.5">
                    <MessageSquareWarning size={16} /> {tr('اعتراض')}
                  </button>
                </div>
              )}
            </div>
          );
        })}

        {sections.disputed.length > 0 && <p className="text-xs font-bold text-[#6E6557] pt-1">{tr('اعتراضك قيد مراجعة الإدارة')}</p>}
        {sections.disputed.map((row) => {
          const editing = active?.id === row.id && active.mode === 'dispute';
          return (
            <div key={row.id} className="bg-white border border-amber-200 rounded-2xl p-3 space-y-2">
              {head(row)}
              <div className="bg-amber-50 text-amber-900 text-xs rounded-lg px-3 py-2">
                <p className="font-semibold">{tr('سبب الاعتراض')}{row.disputedAt ? ` · ${formatDateTime(row.disputedAt)}` : ''}</p>
                <p className="mt-0.5 whitespace-pre-wrap break-words">{row.disputeNote ?? '—'}</p>
                <p className="mt-1 text-[11px] text-amber-700">{tr('تعدل الإدارة التحميل أو تلغيه ثم يعود إليك للقبول')}</p>
              </div>
              {lines(row)}
              {errBox(row)}
              {editing ? (
                <div className="border-t border-gray-100 pt-3 space-y-2">
                  <textarea value={note} onChange={(e) => setNote(e.target.value.slice(0, DISPUTE_NOTE_MAX))} rows={3} maxLength={DISPUTE_NOTE_MAX}
                    placeholder={tr('اكتب سبب الاعتراض')}
                    className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm resize-none" />
                  <div className="flex gap-2">
                    <button type="button" onClick={() => { void dispute(row); }} disabled={busy || !disputeNoteOf(note) || !actionsOn}
                      className="flex-1 bg-[#1F1A13] disabled:bg-gray-300 text-white font-bold py-2.5 rounded-xl text-sm">{tr('إرسال الاعتراض')}</button>
                    <button type="button" onClick={() => setActive(null)} disabled={busy}
                      className="px-4 rounded-xl border border-gray-200 text-sm font-semibold text-[#6E6557]">{tr('إلغاء')}</button>
                  </div>
                </div>
              ) : actionsOn && (
                <button type="button" onClick={() => open(row, 'dispute', row.disputeNote ?? '')} className="text-xs font-semibold text-amber-800 underline">
                  {tr('تعديل الاعتراض')}
                </button>
              )}
            </div>
          );
        })}

        {sections.accepted.length > 0 && <p className="text-xs font-bold text-[#6E6557] pt-1">{tr('قبلتها مؤخرا')}</p>}
        {sections.accepted.map((row) => (
          <details key={row.id} className="bg-white border border-gray-100 rounded-2xl p-3">
            <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden flex items-center gap-2">
              <CheckCircle2 size={18} className="text-[#1E7A52] shrink-0" />
              <span className="flex-1 min-w-0">
                <span className="block text-sm font-semibold text-[#1F1A13]">{tr('قبلته ودخل سيارتك')}</span>
                <span className="block text-[11px] text-gray-500">
                  {row.acceptedAt ? formatDateTime(row.acceptedAt) : ''} · {tr('عدد الأصناف')} {row.lines.length.toLocaleString(activeLocale())}
                </span>
              </span>
              <ChevronLeft size={16} className="text-gray-400 shrink-0" />
            </summary>
            <div className="mt-2">{lines(row)}</div>
            {errBox(row)}
            {/* نسخة المندوب مما وقّعه: إشعار التحميل بإقراره وتوقيعه — من الخادم، فبلا اتصال لا زرّ */}
            {actionsOn && (
              <button type="button" onClick={() => { void openNotice(row); }} disabled={printing !== null}
                className="mt-2 w-full border border-[#cfe8db] bg-[#E4F1EA] text-[#1E7A52] disabled:opacity-60 font-bold py-2.5 rounded-xl flex items-center justify-center gap-2 text-sm">
                {printing === row.id ? <span className="w-4 h-4 border-2 border-[#1E7A52]/30 border-t-[#1E7A52] rounded-full animate-spin" /> : <FileText size={16} />}
                {tr('إشعار PDF')}
              </button>
            )}
          </details>
        ))}
      </div>
    </div>
  );
}

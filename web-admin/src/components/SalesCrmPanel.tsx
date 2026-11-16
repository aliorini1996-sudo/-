import { useEffect, useRef, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { X, Search, RefreshCw, TrendingUp, Phone, Mail, MessageCircle, AlertTriangle, Inbox } from 'lucide-react';
import toast from 'react-hot-toast';
import { salesApi } from '../api/client';
import { useTr } from '../i18n/strings';
import { flagOf } from '../i18n/dialCodes';
import { formatDateTime, formatMoment, formatNumber } from '../utils/format';
import {
  SALES_CHANNELS, SALES_LIMIT_DEFAULT, SALES_LIMIT_MAX, SALES_NOTE_MAX, SALES_STAGES, channelOf, inboxParams, mailHref, stageOf,
  telHref, waHrefForRow, type SalesInbox, type SalesRow, type SalesUpdate,
} from '../lib/salesCrm';

/**
 * «إدارة المبيعات» (طلب المالك ١٦ نوفمبر ٢٠٢٦) — حلّت محلّ «عروض الأسعار» في لوحة المالك: كل عميلٍ تواصل مع المنصة
 * في قائمة واحدة بالاسم والجوال والبريد و«من أين أتى» — التسجيل التجريبي (مباشرةً أو عبر سفير)، و«احجز اجتماع»،
 * و«تواصل معنا»، وطلب الاشتراك وعرض السعر، ومحادثات بوت واتساب. CRM بسيط: حالة متابعة وملاحظة لكل صفّ.
 *
 * عملاء مولّد الفواتير خارجها عمداً (أمر المالك). تُفتح بمفتاح sales.view، وصفوف واتساب لمن يملك waInbox.view وحده —
 * والقرار كله في الخادم (GET /api/leads/sales-inbox)؛ النافذة تعرض ما وصلها.
 */

type ApiErr = { response?: { data?: { message?: string } } };
const errMsg = (e: unknown, fallback: string) => (e as ApiErr)?.response?.data?.message || fallback;

export default function SalesCrmPanel({ onClose }: { onClose: () => void }) {
  const tr = useTr();
  const [channel, setChannel] = useState('');
  const [stage, setStage] = useState('');
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  // حجم الصفحة: افتراضي الخادم، و«عرض المزيد» يرفعه إلى سقفه
  const [limit, setLimit] = useState(SALES_LIMIT_DEFAULT);

  // البحث بعد توقّف الكتابة
  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const { data, isLoading, isError, isFetching, refetch } = useQuery({
    queryKey: ['sales-inbox', channel, stage, q, limit],
    queryFn: async () => (await salesApi.inbox(inboxParams({ channel, stage, q, limit }))).data.data as SalesInbox,
    placeholderData: keepPreviousData,
  });

  const rows = data?.rows ?? [];
  const byChannel = data?.counts.byChannel ?? {};
  const byStage = data?.counts.byStage ?? {};
  const allCount = Object.values(byChannel).reduce((s, n) => s + (Number(n) || 0), 0);
  // قناة واتساب لا تُعرض لمن لا يرى محادثات البوت (الخادم لا يرسل صفوفها أصلاً)
  const channels = SALES_CHANNELS.filter((c) => c.value !== 'WHATSAPP' || data?.whatsapp.included !== false);
  const filtered = !!(channel || stage || q);

  return (
    <div className="fixed inset-0 z-50 bg-[#FAF7F0] overflow-y-auto" dir="rtl">
      {/* الترويسة */}
      <header className="bg-[#1F1A13] text-white sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 rounded-lg bg-[#E15A30] flex items-center justify-center flex-shrink-0"><TrendingUp size={20} /></div>
            <div className="min-w-0">
              <h1 className="font-bold flex items-center gap-2">
                {tr('إدارة المبيعات')}
                {data && <span className="text-xs font-semibold bg-white/10 rounded-full px-2 py-0.5">{formatNumber(allCount)}</span>}
              </h1>
              <p className="text-slate-400 text-xs truncate">{tr('كل من تواصل مع المنصة في مكان واحد ومن أين أتى')}</p>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <button onClick={() => refetch()} disabled={isFetching} className="text-slate-300 hover:text-white p-2 disabled:opacity-60" title={tr('تحديث')} aria-label={tr('تحديث')}>
              <RefreshCw size={18} className={isFetching ? 'animate-spin' : ''} />
            </button>
            <button onClick={onClose} className="text-slate-300 hover:text-white flex items-center gap-1 text-sm"><X size={18} /> {tr('إغلاق')}</button>
          </div>
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6">
        {/* القنوات بأعدادها — العدّ على كل الصفوف لا على المرشَّح */}
        <div className="flex flex-wrap items-center gap-2 mb-4">
          <ChannelChip active={!channel} label={tr('الكل')} count={allCount} onClick={() => setChannel('')} />
          {channels.map((c) => (
            <ChannelChip key={c.value} active={channel === c.value} label={tr(c.label)} count={byChannel[c.value] ?? 0}
              onClick={() => setChannel(channel === c.value ? '' : c.value)} />
          ))}
        </div>

        {/* البحث والحالة */}
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <div className="relative flex-1 min-w-[220px]">
            <Search size={16} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} className="input pr-9"
              placeholder={tr('بحث بالاسم أو الشركة أو الجوال أو البريد')} />
          </div>
          <select value={stage} onChange={(e) => setStage(e.target.value)} className="input w-auto" aria-label={tr('الحالة')}>
            <option value="">{tr('كل الحالات')}</option>
            {SALES_STAGES.map((s) => <option key={s.value} value={s.value}>{tr(s.label)} ({formatNumber(byStage[s.value] ?? 0)})</option>)}
          </select>
          {filtered && (
            <button onClick={() => { setChannel(''); setStage(''); setSearch(''); setQ(''); }} className="text-xs text-[#E15A30] hover:underline">
              {tr('مسح الكل')}
            </button>
          )}
        </div>

        {/* ملاحظات المصادر */}
        <div className="space-y-1.5 mb-4">
          {data?.whatsapp.included && !data.whatsapp.ok && (
            <p className="flex items-center gap-1.5 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              <AlertTriangle size={14} className="flex-shrink-0" /> {tr('تعذر جلب محادثات واتساب الآن — أعد التحميل بعد قليل')}
            </p>
          )}
          <p className="text-xs text-gray-400">
            {tr('البريد الوارد غير مربوط بالمنصة بعد')}
            {data?.syncedAt && <> · {tr('آخر مزامنة')} {formatMoment(data.syncedAt)}</>}
          </p>
        </div>

        {/* القائمة */}
        <div className="card p-0 overflow-hidden">
          <div className="table-wrapper border-0 rounded-none">
            <table className="table">
              <thead>
                <tr>
                  <th className="min-w-[150px]">{tr('العميل')}</th>
                  <th>{tr('الجوال')}</th>
                  <th>{tr('البريد')}</th>
                  <th>{tr('من أين أتى')}</th>
                  <th>{tr('وقت التسجيل')}</th>
                  <th>{tr('الحالة')}</th>
                  <th className="min-w-[200px]">{tr('ملاحظة')}</th>
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  <tr><td colSpan={7} className="text-center py-12 text-gray-400">{tr('جاري التحميل')}</td></tr>
                ) : isError && !data ? (
                  <tr><td colSpan={7} className="text-center py-12 text-red-500">{tr('تعذر التحميل')}</td></tr>
                ) : rows.length === 0 ? (
                  <tr><td colSpan={7} className="py-14">
                    <div className="flex flex-col items-center gap-2 text-gray-400">
                      <Inbox size={28} />
                      <p className="text-sm">{filtered ? tr('لا نتائج مطابقة') : tr('لا أحد تواصل مع المنصة بعد')}</p>
                    </div>
                  </td></tr>
                ) : rows.map((r) => <SalesRowView key={r.id} row={r} />)}
              </tbody>
            </table>
          </div>
          {data && rows.length > 0 && (
            <div className="px-4 py-2 text-xs text-gray-400 border-t border-[#E9E1D3] flex items-center justify-between gap-2">
              <span>{tr('المعروض')} {formatNumber(rows.length)} / {formatNumber(data.total)}</span>
              {data.total > rows.length && limit < SALES_LIMIT_MAX && (
                <button onClick={() => setLimit(SALES_LIMIT_MAX)} disabled={isFetching} className="text-[#E15A30] font-semibold hover:underline disabled:opacity-60">
                  {tr('عرض المزيد')}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ChannelChip({ active, label, count, onClick }: { active: boolean; label: string; count: number; onClick: () => void }) {
  return (
    <button onClick={onClick}
      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm border transition ${active
        ? 'bg-[#1F1A13] text-white border-[#1F1A13]'
        : 'bg-white text-[#44403a] border-[#E9E1D3] hover:border-[#E15A30]'}`}>
      <span>{label}</span>
      <span className={`text-xs font-bold rounded-full px-1.5 ${active ? 'bg-[#E15A30] text-white' : 'bg-[#FAF7F0] text-[#6E6557]'}`}>{formatNumber(count)}</span>
    </button>
  );
}

/** صفّ عميل — الحالة تُحفظ عند الاختيار، والملاحظة عند مغادرة الحقل */
function SalesRowView({ row }: { row: SalesRow }) {
  const tr = useTr();
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: (body: SalesUpdate) => salesApi.update(row.id, body),
    onSuccess: (res) => {
      // الصفّ المحفوظ في الذاكرة فوراً — وإلا عادت الحالة القديمة حتى يرجع التحديث (وقد ينتظر مزامنة التجارب وواتساب)
      const fresh = res.data.data as SalesRow;
      qc.setQueriesData<SalesInbox>({ queryKey: ['sales-inbox'] }, (old) => old && { ...old, rows: old.rows.map((x) => (x.id === fresh.id ? fresh : x)) });
      qc.invalidateQueries({ queryKey: ['sales-inbox'] });
      toast.success(tr('تم الحفظ'));
    },
    onError: (e) => toast.error(errMsg(e, tr('تعذر الحفظ'))),
  });

  const ch = channelOf(row.channel);
  const pendingStage = m.isPending ? m.variables?.stage : undefined;
  const st = stageOf(pendingStage ?? row.stage);
  const tel = telHref(row.phone);
  const wa = waHrefForRow(row);
  const mail = mailHref(row.email);

  return (
    <tr className="align-top">
      <td>
        <p className="font-semibold text-gray-800">{row.name || <span className="text-gray-300">—</span>}</p>
        {row.company && <p className="text-xs text-gray-500">{row.company}</p>}
        {/* الدولة رمزاً (ISO) بعلمها، أو نصّاً كما كُتب في النموذج */}
        {row.country && <p className="text-[11px] text-gray-400">{/^[A-Za-z]{2}$/.test(row.country) ? `${flagOf(row.country)} ${row.country.toUpperCase()}` : row.country}</p>}
      </td>
      <td className="text-sm whitespace-nowrap">
        {row.phone ? (
          <div className="flex items-center gap-2">
            {tel
              ? <a href={tel} dir="ltr" className="inline-flex items-center gap-1 text-gray-700 hover:text-[#E15A30]"><Phone size={12} />{row.phone}</a>
              : <span dir="ltr" className="text-gray-700">{row.phone}</span>}
            {wa && (
              <a href={wa} target="_blank" rel="noopener noreferrer" title={tr('واتساب')} aria-label={tr('واتساب')}
                className="p-1 rounded text-[#128C7E] hover:bg-[#E7F8EE]"><MessageCircle size={14} /></a>
            )}
          </div>
        ) : <span className="text-gray-300">—</span>}
      </td>
      <td className="text-sm">
        {row.email ? (mail
          ? <a href={mail} dir="ltr" className="inline-flex items-center gap-1 max-w-[200px] truncate align-bottom text-blue-600 hover:underline"><Mail size={12} className="flex-shrink-0" />{row.email}</a>
          : <span dir="ltr" className="text-gray-600">{row.email}</span>) : <span className="text-gray-300">—</span>}
      </td>
      <td className="text-sm max-w-[280px]">
        <span className={`badge ${ch.cls}`}>{tr(ch.label)}</span>
        {row.origin && <p className="text-xs text-gray-600 mt-1">{row.origin}</p>}
        {row.message && <p className="text-xs text-gray-400 mt-0.5 line-clamp-2 break-words" title={row.message}>{row.message}</p>}
      </td>
      {/* «وقت التسجيل» (طلب المالك ١٦ نوفمبر ٢٠٢٦): أوّل ظهورٍ للعميل — وآخر تواصلٍ تحته إن اختلف */}
      <td className="text-xs text-gray-500 whitespace-nowrap">
        {formatDateTime(row.firstAt)}
        {row.firstAt !== row.lastAt && <p className="text-[11px] text-gray-400 mt-0.5">{tr('آخر تواصل')} {formatDateTime(row.lastAt)}</p>}
      </td>
      <td>
        <select
          value={st.value}
          disabled={m.isPending}
          onChange={(e) => m.mutate({ stage: e.target.value as SalesUpdate['stage'] })}
          aria-label={tr('الحالة')}
          className={`text-xs font-medium rounded-full border px-2 py-1 max-w-[9.5rem] cursor-pointer outline-none focus:ring-2 focus:ring-[#E15A30]/30 ${st.cls}`}
        >
          {SALES_STAGES.map((s) => <option key={s.value} value={s.value}>{tr(s.label)}</option>)}
        </select>
      </td>
      <td>
        <NoteInput note={row.note} saving={m.isPending} onSave={(note) => m.mutate({ note })} />
      </td>
    </tr>
  );
}

/** ملاحظة تُعدَّل في مكانها — تُحفظ عند مغادرة الحقل (أو Enter) إن تغيّرت، وEsc يتراجع */
function NoteInput({ note, saving, onSave }: { note: string | null; saving: boolean; onSave: (note: string | null) => void }) {
  const tr = useTr();
  const [value, setValue] = useState(note ?? '');
  const skipBlur = useRef(false);
  // ما يصل من الخادم (بعد الحفظ أو التحديث) يحلّ محلّ المكتوب
  useEffect(() => { setValue(note ?? ''); }, [note]);

  const commit = () => {
    if (skipBlur.current) { skipBlur.current = false; return; }
    const next = value.trim();
    if (next === (note ?? '').trim()) return;
    onSave(next ? next : null);
  };

  return (
    <input
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') { skipBlur.current = true; setValue(note ?? ''); e.currentTarget.blur(); }
      }}
      disabled={saving}
      maxLength={SALES_NOTE_MAX}
      placeholder={tr('أضف ملاحظة')}
      aria-label={tr('ملاحظة')}
      className="w-full text-xs border border-transparent hover:border-[#E9E1D3] focus:border-[#E15A30] rounded-lg px-2 py-1.5 bg-transparent focus:bg-white outline-none disabled:opacity-60"
    />
  );
}

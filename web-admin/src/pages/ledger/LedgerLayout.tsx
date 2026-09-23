import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, Hourglass, Landmark } from 'lucide-react';
import { useTr } from '../../i18n/strings';
import { useAuthStore } from '../../store/authStore';
import { canLedger } from '../../lib/ledgerPerms';
import { LockDatesDialog } from '../../components/ledger/LockDatesDialog';
import { ledgerConfigApi, ledgerKeys } from '../../api/ledgerConfig';
import { ledgerSetupApi, ledgerSetupKeys } from '../../api/ledgerSetup';
import {
  computeSetupProgress, setupProgressPercent, setupStepLabel, setupWizardHref, type SetupProgress,
} from '../../lib/ledger/setupProgress';
import { ledgerMenus, visibleLedgerMenus, ledgerHref, LEDGER_BASE, type LedgerDialogKey } from './routes';

/**
 * هيكل الدفاتر: شريط قوائم مرآة Odoo فوق كل صفحات `/app/ledger/**` (§8.2).
 * القوائم والعناصر من `routes.ts` (مصدر التسجيل نفسه)، وقاعدة الظهور بـ`canLedger`: العنصر يظهر
 * بصلاحية عرضه، والقائمة بلا عنصر ظاهر تُخفى كلها. «تواريخ الإقفال…» يفتح `LockDatesDialog`.
 *
 * ظ‑2 (مراجعة الخبير 2026‑09‑18): شارة «الدفاتر بانتظار الإعداد» كانت نصاً ساكناً مكرراً في كل شاشة
 * بلا تقدّم ولا رابط. صارت هنا في موضع واحد مشترك (`LedgerSetupBadge`) يحمل التقدّم («٣ من ٦ خطوات»)
 * ورابط «أكمل الإعداد» إلى **أوّل خطوة ناقصة**، وتستعمله الشاشات بصيغته المضغوطة بجانب أزرارها.
 */
export default function LedgerLayout() {
  const tr = useTr();
  const { user } = useAuthStore();
  const location = useLocation();
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [dialog, setDialog] = useState<LedgerDialogKey | null>(null);
  const barRef = useRef<HTMLDivElement>(null);

  const menus = useMemo(() => visibleLedgerMenus(ledgerMenus(tr), k => canLedger(user, k)), [tr, user]);

  // تغيّر المسار أو النقر خارج الشريط يغلق القائمة
  useEffect(() => setOpenMenu(null), [location.pathname]);
  useEffect(() => {
    if (!openMenu) return;
    const h = (e: MouseEvent) => { if (barRef.current && !barRef.current.contains(e.target as Node)) setOpenMenu(null); };
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpenMenu(null); };
    document.addEventListener('mousedown', h);
    document.addEventListener('keydown', k);
    return () => { document.removeEventListener('mousedown', h); document.removeEventListener('keydown', k); };
  }, [openMenu]);

  const activeMenu = (key: string) => menus.find(m => m.key === key)?.sections
    .some(s => s.items.some(i => i.kind === 'route' && (location.pathname === ledgerHref(i.path) || location.pathname.startsWith(`${ledgerHref(i.path)}/`))));

  return (
    <div className="space-y-4">
      <div ref={barRef} className="flex flex-wrap items-center gap-1 rounded-2xl bg-white border border-[#E8E0D2] px-2 py-1.5">
        <NavLink to={LEDGER_BASE} end className={({ isActive }) => `inline-flex items-center gap-2 px-3 py-1.5 rounded-xl text-sm font-bold ${isActive ? 'text-[#E15A30]' : 'text-[#1F1A13] hover:bg-[#FBF7F0]'}`}>
          <Landmark size={16} />{tr('الدفاتر')}
        </NavLink>
        <nav className="flex flex-wrap items-center gap-1" aria-label={tr('قوائم الدفاتر')}>
          {menus.map(m => (
            <div key={m.key} className="relative">
              <button type="button" aria-haspopup="menu" aria-expanded={openMenu === m.key}
                className={`inline-flex items-center gap-1 px-3 py-1.5 rounded-xl text-sm ${openMenu === m.key ? 'bg-[#F1EBDF]' : 'hover:bg-[#FBF7F0]'} ${activeMenu(m.key) ? 'text-[#E15A30] font-semibold' : 'text-[#1F1A13]'}`}
                onClick={() => setOpenMenu(o => (o === m.key ? null : m.key))}>
                {m.label}<ChevronDown size={14} />
              </button>
              {openMenu === m.key && (
                <div role="menu" className="absolute z-40 mt-1 start-0 min-w-[14rem] bg-white rounded-xl shadow-xl border border-[#E8E0D2] py-1">
                  {m.sections.map((s, si) => (
                    <div key={si} className={si > 0 ? 'border-t border-[#F1EBDF] mt-1 pt-1' : ''}>
                      {s.label && <p className="px-3 pt-1.5 pb-0.5 text-[11px] font-bold text-[#9A8F7E]">{s.label}</p>}
                      {s.items.map(i => i.kind === 'route' ? (
                        <NavLink key={i.path} role="menuitem" to={ledgerHref(i.path)}
                          className={({ isActive }) => `block px-4 py-1.5 text-sm ${isActive ? 'text-[#E15A30] bg-[#FBEBE2]/60' : 'hover:bg-[#FBF7F0]'}`}>
                          {i.label}
                        </NavLink>
                      ) : i.kind === 'link' ? (
                        <NavLink key={i.href} role="menuitem" to={i.href} className="block px-4 py-1.5 text-sm hover:bg-[#FBF7F0]">
                          {i.label}
                        </NavLink>
                      ) : (
                        <button key={i.dialog} role="menuitem" type="button" className="block w-full text-start px-4 py-1.5 text-sm hover:bg-[#FBF7F0]"
                          onClick={() => { setOpenMenu(null); setDialog(i.dialog); }}>
                          {i.label}
                        </button>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </nav>
      </div>

      {/* الفهرس يعرض المعالج نفسه بخطواته، فلا تُكرَّر الشارة فوقه */}
      {location.pathname !== LEDGER_BASE && location.pathname !== `${LEDGER_BASE}/` && <LedgerSetupBadge />}

      <Suspense fallback={<div className="text-sm text-[#9A8F7E] py-10 text-center">{tr('جاري التحميل...')}</div>}>
        <Outlet />
      </Suspense>

      {dialog === 'lockDates' && canLedger(user, 'canCloseLedgerPeriods') && <LockDatesDialog onClose={() => setDialog(null)} />}
    </div>
  );
}

/**
 * حالة الإعداد وتقدّمه لكل شاشات الدفاتر — مصدر واحد بذاكرة الاستعلام نفسها (`ledgerKeys.status`
 * و`ledgerSetupKeys.setup`) فلا طلب زائد. المسودة تحتاج `canConfigureLedger`: من لا يملكها يرى
 * الحالة بلا عدّاد (`progress.known === false`) لا رقماً مخترعاً.
 */
export function useLedgerSetupProgress(): { ready: boolean; canConfigure: boolean; progress: SetupProgress } {
  const { user } = useAuthStore();
  const canConfigure = canLedger(user, 'canConfigureLedger');
  const statusQ = useQuery({
    queryKey: ledgerKeys.status,
    queryFn: async () => (await ledgerConfigApi.status()).data.data,
    staleTime: 60_000,
  });
  const activatedAt = statusQ.data?.activatedAt ?? null;
  const setupQ = useQuery({
    queryKey: ledgerSetupKeys.setup,
    queryFn: async () => (await ledgerSetupApi.get()).data.data,
    enabled: canConfigure && !!statusQ.data && !activatedAt,
    staleTime: 30_000,
  });
  const draft = setupQ.data && !setupQ.data.activated ? setupQ.data.draft : null;
  return { ready: !!statusQ.data, canConfigure, progress: computeSetupProgress({ activatedAt, draft }) };
}

/**
 * شارة «بانتظار الإعداد» المشتركة (م‑2، ظ‑2): السبب ظاهرٌ مكتوباً لا في `title`، ومعه التقدّم
 * وزرّ «أكمل الإعداد» إلى أوّل خطوة ناقصة. `variant="inline"` صيغة مضغوطة تُوضع بجانب زرّ معطّل
 * (زرّ الترحيل في نموذج القيد)، و`title` يستبدل العنوان بسبب الشاشة نفسها.
 * لا تغيّر الشارة أيّ شرط تعطيل ولا صلاحية — عرضٌ فقط.
 */
export function LedgerSetupBadge({ variant = 'banner', title }: { variant?: 'banner' | 'inline'; title?: string }) {
  const tr = useTr();
  const { ready, canConfigure, progress } = useLedgerSetupProgress();
  if (!ready || progress.activated) return null;

  const head = title ?? tr('الدفاتر بانتظار الإعداد');
  const counter = progress.known
    ? tr('{done} من {total} خطوات').replace('{done}', String(progress.done)).replace('{total}', String(progress.total))
    : null;
  const remaining = progress.known && progress.remaining > 0
    ? tr('بقيت {count} خطوات').replace('{count}', String(progress.remaining))
    : null;
  const nextLabel = progress.known ? setupStepLabel(tr, progress.firstIncomplete) : null;
  const action = canConfigure ? (
    <Link
      to={setupWizardHref(progress.known ? progress.firstIncomplete : null)}
      className="shrink-0 inline-flex items-center gap-1 rounded-xl bg-[#E15A30] text-white px-3 py-1 text-xs font-bold hover:bg-[#C94A24]">
      {tr('أكمل الإعداد')}
      {nextLabel && <span className="font-normal opacity-90">· {nextLabel}</span>}
    </Link>
  ) : null;

  if (variant === 'inline') {
    return (
      <span className="inline-flex flex-wrap items-center gap-2 rounded-xl border border-[#F3D3C4] bg-[#FBEBE2] px-2.5 py-1 text-xs text-[#1F1A13]" role="status">
        <Hourglass size={13} className="text-[#E15A30] shrink-0" />
        <span className="font-semibold">{head}</span>
        {remaining && <bdi className="tabular-nums text-[#6E6557]">{remaining}</bdi>}
        {action}
      </span>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl border border-[#F3D3C4] bg-[#FBEBE2] px-3 py-2 text-sm text-[#1F1A13]" role="status">
      <Hourglass size={16} className="text-[#E15A30] shrink-0" />
      <span className="font-semibold">{head}</span>
      {counter && (
        <span className="flex items-center gap-2 min-w-[10rem]">
          <span className="h-1.5 flex-1 rounded-full bg-white/70 overflow-hidden" role="progressbar"
            aria-valuenow={progress.done} aria-valuemin={0} aria-valuemax={progress.total} aria-label={tr('خطوات الإعداد')}>
            <span className="block h-full bg-[#E15A30]" style={{ width: `${setupProgressPercent(progress)}%` }} />
          </span>
          <bdi className="tabular-nums text-xs text-[#6E6557] whitespace-nowrap">{counter}</bdi>
        </span>
      )}
      <span className="flex-1" />
      {action}
    </div>
  );
}

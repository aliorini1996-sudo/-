import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { ChevronDown, Landmark } from 'lucide-react';
import { useTr } from '../../i18n/strings';
import { useAuthStore } from '../../store/authStore';
import { canLedger } from '../../lib/ledgerPerms';
import { LockDatesDialog } from '../../components/ledger/LockDatesDialog';
import { ledgerMenus, visibleLedgerMenus, ledgerHref, LEDGER_BASE, type LedgerDialogKey } from './routes';

/**
 * هيكل الدفاتر: شريط قوائم مرآة Odoo فوق كل صفحات `/app/ledger/**` (§8.2).
 * القوائم والعناصر من `routes.ts` (مصدر التسجيل نفسه)، وقاعدة الظهور بـ`canLedger`: العنصر يظهر
 * بصلاحية عرضه، والقائمة بلا عنصر ظاهر تُخفى كلها. «تواريخ الإقفال…» يفتح `LockDatesDialog`.
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

      <Suspense fallback={<div className="text-sm text-[#9A8F7E] py-10 text-center">{tr('جاري التحميل...')}</div>}>
        <Outlet />
      </Suspense>

      {dialog === 'lockDates' && canLedger(user, 'canCloseLedgerPeriods') && <LockDatesDialog onClose={() => setDialog(null)} />}
    </div>
  );
}

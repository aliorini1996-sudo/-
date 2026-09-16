import { ShieldCheck } from 'lucide-react';
import { useAuthStore } from '../../store/authStore';
import { useTr } from '../../i18n/strings';
import { useLedgerOn, LedgerOffNotice } from '../LedgerGate';
import { canLedger, LedgerKey } from '../../lib/ledgerPerms';

/** بطاقة «غير مسموح» — نص PermissionRoute نفسه، مترجماً. */
function NotAllowedCard() {
  const tr = useTr();
  return (
    <div className="card max-w-xl">
      <div className="flex items-center gap-3">
        <div className="w-11 h-11 rounded-xl bg-amber-50 text-amber-600 flex items-center justify-center"><ShieldCheck size={20} /></div>
        <div>
          <h1 className="text-lg font-bold text-[#1F1A13]">{tr('غير مسموح')}</h1>
          <p className="text-sm text-gray-500 mt-1">{tr('لا تملك صلاحية الوصول لهذا القسم')}</p>
        </div>
      </div>
    </div>
  );
}

/**
 * غلاف كل مسارات `/app/ledger/**` **بدل `PermissionRoute`** (§8.1): ذاك يمنع عند
 * `=== false` وحدها ويتجاهل الدور، فيحجب مالك الشركة الذي أعمدته `false` افتراضياً.
 */
export function LedgerRoute({ perm, children }: { perm: LedgerKey; children: React.ReactNode }) {
  const { user } = useAuthStore();
  const { on, ready } = useLedgerOn();
  if (!ready) return null;
  if (!on) return <LedgerOffNotice />;
  if (!canLedger(user, perm)) return <NotAllowedCard />;
  return <>{children}</>;
}

export default LedgerRoute;

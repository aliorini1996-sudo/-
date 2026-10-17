import { Users } from 'lucide-react';
import { useTr } from '../i18n/strings';
import { repTeams, setActiveTeam, useActiveTeam, type RepTeamsUser } from './repTeam';

/**
 * مبدّل «الفريق الحالي» في تطبيق المندوب — يظهر حين فعّلت الشركة الفرق وكان المندوب في فريقٍ أو أكثر: فريقٌ واحد اسمٌ
 * للعلم، وأكثر قائمةٌ يختار منها الفريق الذي يعمل له الآن (تُوسم به مستنداته وتُصفّى به أصنافه).
 */
export default function RepTeamSwitch({ user, tone = 'dark' }: { user: RepTeamsUser | null; tone?: 'dark' | 'light' }) {
  const tr = useTr();
  const teams = repTeams(user);
  const active = useActiveTeam(user);
  if (!user || !teams.length) return null;
  const cls = tone === 'dark'
    ? 'bg-white/10 text-white border-white/20'
    : 'bg-[#FBEBE2] text-[#C94E28] border-[#F5C9BA]';
  if (teams.length === 1) {
    return (
      <span className={`inline-flex items-center gap-1 text-[11px] font-semibold rounded-full px-2.5 py-1 border ${cls}`} title={tr('الفريق الحالي')}>
        <Users size={12} /> {teams[0].name}
      </span>
    );
  }
  return (
    <label className={`inline-flex items-center gap-1 text-[11px] font-semibold rounded-full ps-2.5 pe-1 py-0.5 border ${cls}`} title={tr('الفريق الذي تعمل له الآن')}>
      <Users size={12} />
      <select value={active ?? ''} onChange={(e) => setActiveTeam(user.id, e.target.value)}
        className="bg-transparent outline-none text-[11px] font-semibold max-w-[9rem] truncate" aria-label={tr('الفريق الحالي')}>
        {teams.map((t) => <option key={t.id} value={t.id} className="text-[#1F1A13]">{t.name}</option>)}
      </select>
    </label>
  );
}

/**
 * «الفرق» في تطبيق المندوب (طلب المالك ١٧ أكتوبر ٢٠٢٦) — مرآة backend/src/services/teams.ts.
 *
 * المندوب في فريقٍ أو أكثر (حين فعّلت الشركة الفرق من «إعدادات الشركة»)، ويختار الفريق الذي يعمل له الآن: يُحفظ على
 * الجهاز لكل مندوب، ويُرسل مع كل فاتورة ومرتجع وسند وزيارة (teamId) — والخادم يتحقّق منه بعضويته ولا يرفض أبداً (مستندٌ
 * أوف-لاين تغيّرت عضويته يرجع لفريقه الوحيد أو «بلا فريق»). وأصناف الفريق تقيّد البيع: يرى أصناف فريقه + العامة.
 */
import { useEffect, useState } from 'react';

export interface RepTeam { id: string; name: string }
export interface RepTeamsUser { id: string; teamsEnabled?: boolean; teams?: RepTeam[] }

const KEY = (repId: string) => `rep_team:${repId}`;
const EVENT = 'rep-team-change';

/** فرق المندوب حين الميزة مفعّلة للشركة، وإلا لا شيء */
export function repTeams(user: RepTeamsUser | null | undefined): RepTeam[] {
  return user?.teamsEnabled === true && Array.isArray(user.teams) ? user.teams : [];
}

/** الفريق الحالي: المحفوظ إن بقي من فرقه، وإلا أولها — وnull بلا فرق */
export function activeTeamOf(user: RepTeamsUser | null | undefined, stored: string | null): string | null {
  const teams = repTeams(user);
  if (!teams.length) return null;
  return teams.some((t) => t.id === stored) ? stored : teams[0].id;
}

function readStored(repId: string): string | null {
  try { return localStorage.getItem(KEY(repId)); } catch { return null; }
}

export function setActiveTeam(repId: string, teamId: string): void {
  try { localStorage.setItem(KEY(repId), teamId); } catch { /* تخزينٌ محجوب: يبقى للجلسة */ }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { repId, teamId } }));
}

/** الفريق الحالي لمندوب — يتبع التبديل من أي شاشة */
export function useActiveTeam(user: RepTeamsUser | null | undefined): string | null {
  const repId = user?.id ?? '';
  const [stored, setStored] = useState<string | null>(() => (repId ? readStored(repId) : null));
  useEffect(() => {
    setStored(repId ? readStored(repId) : null);
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ repId: string; teamId: string }>).detail;
      if (d?.repId === repId) setStored(d.teamId);
    };
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, [repId]);
  return activeTeamOf(user, stored);
}

/** الفريق الحالي خارج React (مؤقّت الزيارة يلتقطه عند البدء) */
export function currentActiveTeam(user: RepTeamsUser | null | undefined): string | null {
  return activeTeamOf(user, user?.id ? readStored(user.id) : null);
}

/** هل يبيع الفريق هذا الصنف؟ صنفٌ بلا فرق عامّ، وبلا فريقٍ حالي لا تقييد */
export function productInTeam(p: { teams?: { teamId: string }[] | null }, teamId: string | null): boolean {
  if (!teamId || !p.teams || !p.teams.length) return true;
  return p.teams.some((t) => t.teamId === teamId);
}

/**
 * ما يبيعه المندوب الآن — مرآة الخادم (catalogTeamsFor): الميزة مطفأة ⇒ كل الأصناف؛ فريقٌ حالي ⇒ أصنافه + العامة؛
 * مندوبٌ بلا فرق في شركةٍ فعّلتها ⇒ العامة وحدها («الصنف المسند لا يبيعه إلا من يعمل لأحد فرقه»).
 */
export function sellableNow(p: { teams?: { teamId: string }[] | null }, user: RepTeamsUser | null | undefined, activeTeam: string | null): boolean {
  if (user?.teamsEnabled !== true) return true;
  if (activeTeam) return productInTeam(p, activeTeam);
  return !p.teams || !p.teams.length;
}

/** الفريق الحالي لمندوب الجهاز المحفوظ (rep_user) — لشاشاتٍ لا تحمل المستخدم */
export function storedUserActiveTeam(): string | null {
  try { return currentActiveTeam(JSON.parse(localStorage.getItem('rep_user') || 'null')); } catch { return null; }
}

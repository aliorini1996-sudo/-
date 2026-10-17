/**
 * «الفرق» داخل الشركة (طلب المالك ١٧ أكتوبر ٢٠٢٦) — مطفأة افتراضياً لكل الشركات، ويفعّلها مدير الشركة من «إعدادات
 * الشركة» (CompanySettings.teamsEnabled).
 *
 * نشاطٌ أو فريق مناديب بمشرفين وأصناف خاصة. المندوب في فريقٍ أو أكثر، ويختار في تطبيقه الفريق الذي يعمل له الآن، فتُوسم
 * به فواتيره ومرتجعاته وسنداته وزياراته (`teamId`) — والتقارير تُفصل وتُجمَّع بالوسم لا بعضوية المندوب الحالية، فمجموع
 * أقسام الفرق يساوي إجمالي الشركة بلا ازدواج، ويبقى تاريخ الفريق ثابتاً إن انتقل المندوب.
 *
 * قرارات المالك: الفريق يختاره المندوب؛ أصناف الفريق تقيّد البيع (صنفٌ بلا فرق عامٌّ للجميع)؛ العملاء مشتركون (المشرف
 * يراهم كلهم)؛ والمستندات القديمة تبقى «بلا فريق».
 *
 * دوالٌ صافية بلا قاعدة بيانات — تُغذّى من قراءات المسارات القائمة (`include` على قراءة المندوب والأصناف) فلا يضيف
 * الوسم استعلاماً إلى مسار الإصدار.
 */

/** عضويات المندوب كما تُقرأ مع صفّه: `teamMemberships: { select: TEAM_MEMBERSHIP_SELECT }` */
export const TEAM_MEMBERSHIP_SELECT = { teamId: true, team: { select: { isActive: true } } } as const;

/**
 * عضويات المندوب مع إشراف الطالب عليها (في القراءة نفسها، بلا استعلام): مستخدم شركةٍ يشرف على بعض فرق المندوب لا يكتب
 * مستنداً إلا بوسم أحدها — وإلا خرج المستند من رؤيته فور كتابته أو وُسم بفريقٍ لا يخصّه. المندوب وجلسة المالك: بلا إشراف.
 */
export function teamMembershipSelectFor(viewerAdminId: string | null) {
  return {
    teamId: true,
    team: { select: { isActive: true, ...(viewerAdminId && { supervisors: { where: { adminId: viewerAdminId }, select: { adminId: true } } }) } },
  } as const;
}

/** المشرف المحتمل للطلب: مستخدم شركة (لا مندوب ولا جلسة مالك) */
export const supervisorViewerOf = (user: { id: string; role: string; impersonated?: boolean } | undefined) =>
  user && user.role !== 'SALES_REP' && user.impersonated !== true ? user.id : null;

export interface RepTeams {
  tenant?: { settings?: { teamsEnabled?: boolean | null } | null } | null;
  teamMemberships?: { teamId: string; team?: { isActive?: boolean | null; supervisors?: { adminId: string }[] | null } | null }[] | null;
}

/** فرق المندوب الفعّالة — والميزة المطفأة للشركة لا فرق لها (لا وسم ولا تقييد) */
export function activeTeamIdsOf(rep: RepTeams | null | undefined): string[] {
  if (!rep || rep.tenant?.settings?.teamsEnabled !== true) return [];
  return (rep.teamMemberships ?? []).filter((m) => m.team?.isActive !== false).map((m) => m.teamId);
}

/**
 * فريق المستند الجديد: ما اختاره المندوب إن كان من فرقه الفعّالة، وإلا فريقه الوحيد، وإلا null («بلا فريق»).
 *
 * لا رفض هنا أبداً: مستندٌ أوف-لاين يُعاد رفعه بفريقٍ تغيّرت عضويته بعد إنشائه يصير «مرفوضاً» نهائياً في صندوق الإرسال
 * لو رُدّ بـ4xx — فالاختيار غير الصالح يرجع إلى الافتراضي بصمت.
 */
export function resolveDocTeam(rep: RepTeams | null | undefined, requested?: string | null): string | null {
  const ids = activeTeamIdsOf(rep);
  // مشرفٌ يكتب لمندوب فرقه: بوسم أحد الفرق التي يشرف عليها وحدها (المطلوب إن كان منها، وإلا أولها)
  const supervisedAll = rep?.tenant?.settings?.teamsEnabled === true
    ? (rep.teamMemberships ?? []).filter((m) => (m.team?.supervisors?.length ?? 0) > 0)
    : [];
  const supervised = supervisedAll.filter((m) => m.team?.isActive !== false).map((m) => m.teamId);
  if (supervised.length) return requested && supervised.includes(requested) ? requested : supervised[0];
  // مشرفٌ فريقُه (المشترك مع المندوب) مؤرشف: «بلا فريق» — لا يسقط إلى فرق المندوب الأخرى التي لا يشرف عليها
  if (supervisedAll.length) return null;
  if (requested && ids.includes(requested)) return requested;
  return ids.length === 1 ? ids[0] : null;
}

/**
 * فريق استلام التحصيل (RepSettlement) — مالٌ يُكتب من اللوحة حيّاً لا مستندٌ أوف-لاين، فالرفض هنا صحيح بخلاف resolveDocTeam:
 * فريقٌ يُخمَّن يُنقص عهدة فريقٍ لم يُسلِّم ويُبقي عهدة الذي سلّم فيُستلم المبلغ مرّتين.
 *  • المشرف (وضع TEAMS — `supervisor`): فريقٌ من فرقه المشتركة مع المندوب (ولو مؤرشفاً) أو من فرقه التي ما زالت تحمل
 *    عهدةً للمندوب: المطلوب منها، وإلا الوحيد، وإلا يُطلب الاختيار. وطلبُ فريقٍ ليس منها يُرفض ولا يُستبدل بغيره بصمت.
 *  • غيره (المدير غير المقيَّد، المقيَّد بالقوائم، جلسة المالك): ما طلبه صراحةً من فرق المندوب (والميزة مفعّلة) أو من فرق
 *    عهدته القائمة (ولو تركها أو أُطفئت الميزة)، و'none' أو بلا طلب = بلا فريق (يُنقص الإجمالي وحده — والعميل البرمجيّ
 *    القديم لا يُكسر). وغير ذلك يُرفض ولا يُخزَّن.
 * `custodyTeamIds`: فرقٌ عليها عهدةٌ موسومة لهذا المندوب لم تُستلم بعد (للمشرف: من فرقه وحدها) — يحسبها المستدعي.
 */
export function settlementTeamOf(
  rep: RepTeams | null | undefined, supervisor: boolean, requested?: string | null, custodyTeamIds: readonly string[] = [],
): { teamId: string | null } | { error: string } {
  const memberships = rep?.teamMemberships ?? [];
  if (supervisor) {
    const supIds = [...new Set([...memberships.filter((m) => (m.team?.supervisors?.length ?? 0) > 0).map((m) => m.teamId), ...custodyTeamIds])];
    if (requested) return supIds.includes(requested) ? { teamId: requested } : { error: 'الفريق المختار ليس من فرقك' };
    if (supIds.length === 1) return { teamId: supIds[0] };
    return { error: supIds.length ? 'اختر الفريق الذي تستلم عهدته' : 'لا فريق تشرف عليه لهذا المندوب' };
  }
  if (!requested || requested === 'none') return { teamId: null };
  const current = rep?.tenant?.settings?.teamsEnabled === true ? memberships.map((m) => m.teamId) : [];
  if (current.includes(requested) || custodyTeamIds.includes(requested)) return { teamId: requested };
  return { error: 'الفريق المختار ليس من فرق المندوب' };
}

/** سند القبض كما يُقرأ لحصّة الفريق: مبلغه ووسمه وتوزيعه على الفواتير (ReceiptInvoice) بوسم كل فاتورة */
export interface ReceiptTeamSplit {
  amount: number;
  teamId: string | null;
  invoiceItems: { amount: number; invoice: { teamId: string | null } | null }[];
}

/**
 * نسبة سند القبض التي تخصّ فرق المشرف في كشف حساب العميل (٠..١): ما وُزّع منه على فواتير فرقه، وما لم يُوزَّع (دفعةٌ
 * مقدّمة) إن كان السند نفسه موسوماً بأحد فرقه. السند يُوسم بفريق المحصِّل والتوزيع FIFO يعبر الفرق — فسندٌ لفريقٍ آخر سدّد
 * فاتورة الفريق يظهر في كشفه بحصّته، ولا يظهر في كشف فريقه بما سدّد غيره. ونسبةٌ لا مبلغ: قيد العكس (RECEIPT_DEBIT) للسند
 * نفسه يُضرب بها أيضاً فيبقى زوجاه متقابلين.
 */
export function teamReceiptShare(receipt: ReceiptTeamSplit, supTeamIds: ReadonlySet<string>): number {
  const own = !!receipt.teamId && supTeamIds.has(receipt.teamId);
  const total = Number(receipt.amount) || 0;
  if (total <= 0) return own ? 1 : 0;
  let allocAll = 0;
  let allocSup = 0;
  for (const it of receipt.invoiceItems ?? []) {
    const a = Number(it.amount) || 0;
    allocAll += a;
    if (it.invoice?.teamId && supTeamIds.has(it.invoice.teamId)) allocSup += a;
  }
  const share = allocSup + (own ? Math.max(0, total - allocAll) : 0);
  return Math.min(1, Math.max(0, share / total));
}

const r6 = (n: number) => Math.round(n * 1e6) / 1e6;

/**
 * قيود كشف المشرف بحصّة فرقه: قيد السند يُضرب بنسبته من `shares` (معرّف السند ← teamReceiptShare)، وما صار صفراً لا يُعرض.
 * قيد الفاتورة يبقى كما هو (لم يُختر إلا لأن فاتورته لفرقه).
 */
export function scaleTeamRows<T extends { debit: number; credit: number; receiptId: string | null }>(rows: T[], shares: ReadonlyMap<string, number>): T[] {
  const out: T[] = [];
  for (const r of rows) {
    if (!r.receiptId) { out.push(r); continue; }
    const k = shares.get(r.receiptId) ?? 0;
    if (k >= 1) out.push(r);
    else if (k > 0) out.push({ ...r, debit: r6(Number(r.debit) * k), credit: r6(Number(r.credit) * k) });
  }
  return out;
}

/**
 * ملخّص كشف الفريق بأنواع القيود كما يحدّث الخادم totalSales/totalCollected (services/accounting.ts) — لا مجموع المدين
 * والدائن: الإلغاء والمرتجع (INVOICE_CREDIT) يُنقصان المبيعات لا يُعدّان تحصيلاً، وعكس السند (RECEIPT_DEBIT) يُنقص التحصيل.
 */
export function teamStatementTotals(rows: { type: string; debit: number; credit: number }[]): { totalSales: number; totalCollected: number; balance: number } {
  let sales = 0, collected = 0, balance = 0;
  for (const r of rows) {
    const d = Number(r.debit) || 0, c = Number(r.credit) || 0;
    balance += d - c;
    if (r.type === 'INVOICE_DEBIT') sales += d;
    else if (r.type === 'INVOICE_CREDIT') sales -= c;
    else if (r.type === 'RECEIPT_CREDIT') collected += c;
    else if (r.type === 'RECEIPT_DEBIT') collected -= d;
  }
  return { totalSales: r6(sales), totalCollected: r6(collected), balance: r6(balance) };
}

/** فرق الصنف كما تُقرأ معه: `teams: { select: { teamId: true } }` — بلا صفوف = صنفٌ عامّ لكل الفرق */
export interface ProductTeams { id?: string; name?: string; teams?: { teamId: string }[] | null }

export const isGeneralProduct = (p: ProductTeams) => !(p.teams && p.teams.length);

/** هل يبيع من يعمل لهذا الفريق هذا الصنف؟ مستندٌ بلا فريق لا يُقيَّد */
export function productAllowedInTeam(p: ProductTeams, teamId: string | null | undefined): boolean {
  if (!teamId || isGeneralProduct(p)) return true;
  return p.teams!.some((t) => t.teamId === teamId);
}

/**
 * الفرق التي يُفحص بها كتالوج بيع المندوب الحيّ — null = بلا تقييد (الميزة مطفأة).
 *
 * فريق المستند إن حُسم ⇒ أصنافه + العامة. بلا فريقٍ محسوم (مندوبٌ في فريقين لم يختر، أو أرسل فريقاً ليس له) ⇒ أصناف
 * كل فرقه + العامة — فلا يتجاوز القيدَ بحذف الفريق من طلبه. ومندوبٌ بلا فرق في شركةٍ فعّلتها ⇒ العامة وحدها («الصنف
 * المسند لا يبيعه إلا من يعمل لأحد فرقه»).
 */
export function catalogTeamsFor(rep: RepTeams | null | undefined, docTeamId: string | null): string[] | null {
  if (!rep || rep.tenant?.settings?.teamsEnabled !== true) return null;
  return docTeamId ? [docTeamId] : activeTeamIdsOf(rep);
}

/** أول صنفٍ لا تبيعه هذه الفرق — رسالة الرفض عربية باسمه، أو null. allowed=null بلا تقييد، و[] للعامة وحدها */
export function teamCatalogProblem(products: ProductTeams[], allowed: string[] | null): string | null {
  if (!allowed) return null;
  const bad = products.find((p) => !isGeneralProduct(p) && !p.teams!.some((t) => allowed.includes(t.teamId)));
  if (!bad) return null;
  return allowed.length
    ? `الصنف «${bad.name ?? ''}» ليس من أصناف فريقك الحالي — بدّل الفريق أو احذف الصنف`
    : `الصنف «${bad.name ?? ''}» خاص بفريقٍ لست من أعضائه — احذفه من الفاتورة`;
}

/** اسم فريقٍ صالح: يُشذَّب ويُطوى فراغه، ولا يتجاوز ٦٠ حرفاً */
export const teamName = (s: string) => s.trim().replace(/\s+/g, ' ').slice(0, 60);

/**
 * فلتر التقارير بالفريق من `?teamId=` — نصاً وحده (كائن qs مثل teamId[not]=x يُهمل فلا يصير شرط Prisma):
 * غائب/فارغ ⇒ undefined (كل الفرق)، `none` ⇒ null («بلا فريق»)، وإلا معرّف الفريق.
 */
export function reportTeamOf(raw: unknown): string | null | undefined {
  if (typeof raw !== 'string' || !raw) return undefined;
  return raw === 'none' ? null : raw;
}

/** المستندات الموسومة (فاتورة، سند، زيارة): بوسمها — فمجموع أقسام الفرق إجمالي الشركة بلا ازدواج */
export const teamDocWhere = (team: string | null | undefined) => (team === undefined ? {} : { teamId: team });

/** التقارير القائمة على المندوب (ساعات، حضور، مسافة، مديونيات): بعضويته الحالية — ومندوبٌ في فريقين يظهر تحت كليهما */
export const teamRepWhere = (team: string | null | undefined) =>
  team === undefined ? {} : team === null ? { teamMemberships: { none: {} } } : { teamMemberships: { some: { teamId: team } } };

/**
 * مناديب تقريرٍ مقاييسه من المستندات (الأداء، التقييم): العضو الحالي **أو** من له مستندٌ موسومٌ بالفريق — فلا يسقط عمل
 * مندوبٍ انتقل من الفريق من تقريره، ولا مستندات «بلا فريق» القديمة لمناديب صاروا في فرق.
 */
export const teamRepOrDocsWhere = (team: string | null | undefined) =>
  team === undefined ? {} : {
    OR: [
      teamRepWhere(team),
      { invoices: { some: { teamId: team } } },
      { receipts: { some: { teamId: team } } },
      { RepVisit: { some: { teamId: team } } },
    ],
  };

/** اسم الفريق مع الصفّ (للعرض والتصدير ورقةً لكل فريق) */
export const TEAM_NAME_SELECT = { select: { id: true, name: true } } as const;

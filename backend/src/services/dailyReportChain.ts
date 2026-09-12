/**
 * سلسلة اعتماد التقرير اليومي — المنطق كلّه صرفٌ بلا قاعدة بيانات.
 *
 * لماذا مستخرَجٌ هنا لا مكتوبٌ داخل المسار: هذه آلة حالةٍ تحكم مستنداً يُوقَّع.
 * أخطاؤها لا تظهر خطأً في الشاشة بل تقريراً «مُعتمَداً» لم يره من يُفترض أنه
 * اعتمده، أو تقريراً عالقاً لا يظهر في صندوق أحد. وكلاهما لا يُكتشف إلا بعد
 * أسبوع. فالمنطق يُختبَر وحده بمدخلات مصنوعة، على سنّة workDay.ts
 * وvisitDuration.ts وsuggestAccuracy.ts في هذا المستودع.
 *
 * قاعدتان حاكمتان:
 *  • **المستوى يُملَك بمعرّف مستخدمٍ بعينه لا بدور.** `Admin.role` نصٌّ بثلاث
 *    قيم بلا قيد تفرّد، ومسار مستخدمي الشركة يسمح بعددٍ غير محدود من MANAGER.
 *    فقاعدة «إن غاب صاحب الدور يتولّاه ADMIN تلقائياً» مرفوضةٌ رفضاً باتّاً:
 *    هي بعينها ثقب الاعتماد الذاتي.
 *  • **مصدر الحقيقة الخطواتُ والمهامّ**، وعمودا الحالة في التقرير مؤشّرٌ هادٍ
 *    يُشتقّ منهما بـderiveCursor ويُكتب في المعاملة نفسها.
 *  • **ما يُعرَض على المالك يُفرَض عليه.** المحاكي يقول «يوقّعان معاً»، فلا
 *    يجوز أن يعبر المستوى بتوقيعٍ واحد؛ ووسم «اعتمده شخص واحد» يقول حقيقة
 *    هذه النسخة من التقرير لا حصيلة جولاتٍ أُعيدت. وعدٌ معروضٌ بلا تنفيذ
 *    أسوأ من ميزةٍ غائبة: الغائبةُ يُحتاط لها، والمعروضةُ يُطمأنّ إليها.
 */

/** مستوىً في السلسلة كما تعرّفه الشركة */
export interface ChainLevel {
  id: string;
  seq: number;
  name: string;
  /** REVIEW = يعلّق ويعتمد | ENTER = يسجّل بياناته هو ثم يعتمد */
  kind: string;
  /** ALL = يوقّع كل الملّاك | ANY = يكفي أوّلهم */
  quorum: string;
}

/** صاحب مستوىً بعينه */
export interface ChainOwner {
  id: string;
  levelId: string;
  adminId: string;
  adminName: string;
  isDefault: boolean;
  /**
   * هل حساب هذا المالك حيٌّ نشط؟ يملؤه القارئ من `Admin.isActive`.
   *
   * لماذا هنا: لا مفتاح أجنبيّ يربط `adminId` بجدول المستخدمين، فحذفُ مستخدمٍ
   * يترك العقدة قائمةً باسمه المُلتقَط بينما لا يستطيع أحد فتحها. و`undefined`
   * = «غير معلوم» تُعامل معاملة الحيّ عمداً: استدعاءٌ لا يمرّر الحياة يجب ألّا
   * يُفرغ السلسلة من ملّاكها فيوقف تقارير الشركة كلّها.
   */
  adminActive?: boolean;
}

/** توجيه: هذا المالك يستقبل تقارير هذا المندوب */
export interface OwnerRep {
  ownerId: string;
  salesRepId: string;
}

/** مهمّة مفتوحة أو منتهية */
export interface ChainTask {
  reportId: string;
  levelId: string;
  levelSeq: number;
  round: number;
  /** PENDING | DONE | SKIPPED */
  state: string;
}

/** خطوةٌ وقعت فعلاً */
export interface ChainStep {
  levelSeq: number;
  round: number;
  /** SUBMIT | APPROVE | RETURN | ENTER | REASSIGN */
  action: string;
  actorAdminId: string | null;
  actorSalesRepId: string | null;
}

/** الفاعل الذي يحاول فعلاً */
export interface Actor {
  adminId?: string | null;
  salesRepId?: string | null;
  /** ADMIN | MANAGER | ACCOUNTANT — للعرض فقط، لا يُبنى عليه إذن */
  role?: string | null;
}

/** مؤشّر التقرير المُشتقّ */
export interface Cursor {
  status: string;
  currentLevelId: string | null;
  currentLevelSeq: number | null;
}

/** أسماء ملّاكٍ في جملةٍ عربية واحدة */
const ownerNames = (list: ChainOwner[]): string => list.map(o => o.adminName).join(' و');

/** رتّب المستويات تصاعدياً بلا افتراض ترتيب الوارد */
export const sortLevels = (levels: ChainLevel[]): ChainLevel[] =>
  [...levels].sort((a, b) => a.seq - b.seq);

/**
 * المستوى التالي بعد `afterSeq`.
 *
 * لا يفترض تسلسلاً بلا فجوات: حذف مستوىً وسط السلسلة قد يترك ١ ثم ٣ لحظةً
 * قبل إعادة الترقيم، وافتراضُ `seq + 1` يُعلّق التقرير عند لا شيء.
 */
export function nextLevel(levels: ChainLevel[], afterSeq: number): ChainLevel | null {
  const sorted = sortLevels(levels);
  return sorted.find(l => l.seq > afterSeq) ?? null;
}

/** أول مستوى في السلسلة — من يستقبل التقرير فور رفعه */
export function firstLevel(levels: ChainLevel[]): ChainLevel | null {
  return nextLevel(levels, -1);
}

/**
 * من يستقبل تقرير هذا المندوب عند هذا المستوى — **التشعّب**.
 *
 * الترتيب مقصود: المُوجَّه له صراحةً أولاً، فإن لم يوجد فالمالك الافتراضي.
 * وإن لم يوجد أيٌّ منهما فالمستوى بلا صاحب: تُعاد قائمةٌ فارغة ويردّ المسار
 * خطأً مفهوماً بدل أن يُنشئ مهمّةً لا يراها أحد أبداً.
 *
 * ومالكٌ عُطِّل حسابه أو حُذف **ليس مستقبِلاً**: المصادقة تردّه عند الباب،
 * فإبقاؤه مؤهَّلاً يبتلع التقرير في صندوقٍ لا يفتحه أحد. وإسقاطُه هنا يُسقط
 * توجيهَه معه، فيقع مندوبه على المالك الافتراضي بدل أن يعلق.
 */
export function ownersFor(
  owners: ChainOwner[],
  ownerReps: OwnerRep[],
  levelId: string,
  salesRepId: string,
): ChainOwner[] {
  const atLevel = owners.filter(o => o.levelId === levelId && o.adminActive !== false);
  const routed = atLevel.filter(o => ownerReps.some(r => r.ownerId === o.id && r.salesRepId === salesRepId));
  if (routed.length) return routed;
  return atLevel.filter(o => o.isDefault);
}

/**
 * هل السلسلة صالحة للاستعمال؟ (مستوىً واحدٌ على الأقل، ولكلٍّ صاحبٌ **حيّ**)
 *
 * حياة المالك جزءٌ من صحّة السلسلة لا تفصيلٌ إداريّ: مستخدمٌ يستقيل فيُحذف
 * حسابه يترك عقدته قائمةً باسمه، فتتراكم عندها مهامّ لا تظهر في صندوق أحد،
 * ولا تصدر حصيلة أيّامها، ولا تُحذف العقدة (مهامّها واقفة) — أسبوعاً كاملاً
 * بلا شكوى من أيّ شيء. فالبنية وحدها لا تكفي حارساً.
 */
export function chainIssues(levels: ChainLevel[], owners: ChainOwner[]): string[] {
  const out: string[] = [];
  if (!levels.length) { out.push('لا مستويات معرّفة'); return out; }
  for (const l of sortLevels(levels)) {
    const atLevel = owners.filter(o => o.levelId === l.id);
    if (!atLevel.length) { out.push(`المستوى «${l.name}» بلا صاحب`); continue; }
    const dead = atLevel.filter(o => o.adminActive === false);
    const live = atLevel.filter(o => o.adminActive !== false);
    if (!live.length) {
      out.push(`المستوى «${l.name}» صاحبه ${ownerNames(dead)} لم يعد مستخدماً نشطاً — عيّن صاحباً غيره`);
      continue;
    }
    // مالكٌ ميّت بين أحياء: مناديبه المُوجَّهون يقعون على الافتراضي، لكنّ
    // التوجيه المعروض في الشبكة صار كذباً — يُقال صراحةً ليُصحَّح
    if (dead.length) out.push(`المستوى «${l.name}»: ${ownerNames(dead)} لم يعد مستخدماً نشطاً — أعد توجيه مناديبه`);
    // مستوىً كل ملّاكه الأحياء موجَّهون: مندوبٌ خارج كل القوائم يعلق بلا مستقبِل
    if (!live.some(o => o.isDefault)) {
      out.push(`المستوى «${l.name}» بلا مالك افتراضي — تقرير مندوبٍ غير موجَّه سيعلق`);
    }
  }
  return out;
}

/**
 * المهمّة الأولى عند الرفع: مهمّةٌ واحدة للمستوى الأول.
 *
 * مهمّة **لكل مستوى** لا لكل موقّع: صندوق «بانتظارك» يصير عندها استعلاماً
 * واحداً بفهرس، بدل استعلامٍ لكل تقرير يسأل من ملّاك مستواه.
 */
export function planFirstTask(levels: ChainLevel[], reportId: string, round = 1): ChainTask | null {
  const first = firstLevel(levels);
  if (!first) return null;
  return { reportId, levelId: first.id, levelSeq: first.seq, round, state: 'PENDING' };
}

/**
 * يشتقّ مؤشّر التقرير من مهامّه — **مصدر الحقيقة**.
 *
 * التوازن المقصود مع قاعدة «لا عدّاداً يمكن أن ينقصّا»: اشتقاق الحالة آنياً
 * لكل تقرير قراءةٌ في N+1 تؤذي صندوق «بانتظارك». فالعمودان يُكتبان مؤشّراً،
 * وهذه الدالّة تشتقّ الحقيقة، والاختبار يتحقّق من تطابقهما.
 */
export function deriveCursor(tasks: ChainTask[], levels: ChainLevel[], returned: boolean): Cursor {
  if (returned) return { status: 'RETURNED', currentLevelId: null, currentLevelSeq: null };
  const pending = tasks.filter(t => t.state === 'PENDING').sort((a, b) => a.levelSeq - b.levelSeq)[0];
  if (!pending) {
    // لا مهمّة مفتوحة: إمّا اعتُمد نهائياً وإمّا لم تُعرَّف مستويات أصلاً
    const anyDone = tasks.some(t => t.state === 'DONE');
    return { status: anyDone ? 'APPROVED' : 'SUBMITTED', currentLevelId: null, currentLevelSeq: null };
  }
  const acted = tasks.some(t => t.state === 'DONE');
  const lvl = levels.find(l => l.id === pending.levelId);
  return {
    status: acted ? 'IN_REVIEW' : 'SUBMITTED',
    currentLevelId: pending.levelId,
    currentLevelSeq: lvl?.seq ?? pending.levelSeq,
  };
}

/**
 * هل يملك هذا الفاعل أن يفعل بهذا التقرير الآن؟
 *
 * الإذن من **مِلكيّة المستوى المفتوح** لا من الدور. ومندوبٌ لا يملك شيئاً في
 * السلسلة إطلاقاً: صاحبُ التقرير لا يعتمد تقريره.
 */
export function canAct(
  actor: Actor,
  tasks: ChainTask[],
  levels: ChainLevel[],
  owners: ChainOwner[],
  ownerReps: OwnerRep[],
  salesRepId: string,
): { allowed: boolean; levelId: string | null; levelSeq: number | null; reason?: string } {
  if (!actor.adminId) return { allowed: false, levelId: null, levelSeq: null, reason: 'الفاعل ليس مستخدماً إدارياً' };
  const cursor = deriveCursor(tasks, levels, false);
  if (!cursor.currentLevelId) return { allowed: false, levelId: null, levelSeq: null, reason: 'لا مستوى مفتوح' };
  const eligible = ownersFor(owners, ownerReps, cursor.currentLevelId, salesRepId);
  const ok = eligible.some(o => o.adminId === actor.adminId);
  return ok
    ? { allowed: true, levelId: cursor.currentLevelId, levelSeq: cursor.currentLevelSeq }
    : { allowed: false, levelId: cursor.currentLevelId, levelSeq: cursor.currentLevelSeq, reason: 'التقرير ليس عند مستواك' };
}

/**
 * عدد الفاعلين المتمايزين الذين وقّعوا فعلاً في السلسلة.
 *
 * لا يُمنع أن يوقّع شخصٌ واحد كل المستويات — شركةٌ بمستخدمٍ واحد حقيقةٌ قائمة،
 * وأكثرُ حسابات المنصّة كذلك. لكنّه **لا يُخفى**: الرقم يُخزَّن لحظة الاعتماد
 * ويُعرض وسماً «اعتمده شخص واحد» في التقرير الشامل، فلا يبدو مُدقَّقاً من ثلاثة.
 * ورفعُ المندوب لا يُحسب اعتماداً.
 *
 * والعدّ **بقائمةٍ بيضاء** (APPROVE وحدها) لا بقائمةٍ سوداء: من أعاد التقرير
 * لم يعتمده، ومن سجّل بياناته لم يعتمدها، واستثناءُ نوعين وترك الباقي يجعل
 * كل نوعٍ يُضاف لاحقاً توقيعاً بلا سطرٍ يتغيّر.
 *
 * و**بالجولة الجارية وحدها**: الجولة السابقة نسخةٌ أُعيدت وصُحّحت، ومن وقّعها
 * لم يرَ ما اعتُمد. جمعُ الجولات كان يطفئ وسم «اعتمده شخص واحد» عن تقريرٍ
 * وقّعه شخصٌ واحد — عكسُ ما وُضع الوسم له بالضبط.
 *
 * تُستنتَج الجولة من الخطوات إن لم تُمرَّر، وخطوةٌ بلا رقم جولة (يُلحقها
 * المسار بالقائمة قبل كتابتها في المعاملة) تُحسب في الجولة الجارية.
 */
export function countDistinctApprovers(steps: ChainStep[], round?: number): number {
  const target = round ?? steps.reduce((m, s) => (Number.isFinite(s.round) && s.round > m ? s.round : m), 0);
  const ids = new Set<string>();
  for (const s of steps) {
    if (s.action !== 'APPROVE') continue;
    if (Number.isFinite(s.round) && s.round !== target) continue;
    if (s.actorAdminId) ids.add(s.actorAdminId);
  }
  return ids.size;
}

/**
 * ما الذي يحدث للمهامّ بعد فعلٍ ما — الانتقالات كلّها في مكانٍ واحد.
 *
 * تُعيد وصفاً خالصاً ينفّذه المسار داخل معاملة، فتبقى القواعد مقروءةً
 * ومختبَرةً بمعزلٍ عن Prisma.
 */
export interface Transition {
  /** المهمّة الحالية تُغلق بهذه الحالة */
  closeCurrentAs: string;
  /** مهمّة جديدة تُفتح (أو null) */
  openNext: { levelId: string; levelSeq: number; round: number } | null;
  /** الحالة الجديدة للتقرير */
  status: string;
  /** هل هذا هو الاعتماد النهائي؟ */
  finalApproval: boolean;
  /** ترتفع جولة المراجعة؟ */
  bumpRound: boolean;
  /**
   * معرّفات من بقي عليهم توقيع هذا المستوى في هذه الجولة (نصاب ALL).
   * فارغةٌ في كل حالةٍ أخرى. غير فارغة ⇒ التقرير بقي عند مستواه نفسه.
   */
  awaitingQuorum: string[];
}

/**
 * سياق النِّصاب — ما تحتاجه `applyAction` كي تعرف هل اكتمل توقيع المستوى.
 *
 * اختياريّ في التوقيع عمداً لا تهاوناً: هو معلومةٌ يملكها القارئ وحده
 * (الملّاك والخطوات)، ولا معنى لأن تُفرض على `RETURN` و`RESUBMIT`. وحين لا
 * يُمرَّر يسلك APPROVE سلوك «يكفي توقيعٌ واحد» — وهو بالضبط ما يجعل تمريره
 * واجباً على مسار الاعتماد: الوعد المعروض في المحاكي «يوقّعان معاً» لا يصير
 * حقيقةً بدونه.
 */
export interface QuorumContext {
  /** المؤهَّلون لهذا المستوى ولهذا المندوب — مخرَج `ownersFor` نفسه */
  eligible: ChainOwner[];
  /** خطوات التقرير كما هي مخزَّنة — تُصفّى بالمستوى والجولة هنا */
  steps: ChainStep[];
  /** الموقّع الآن — توقيعه لم يُكتب في الخطوات بعد */
  actorAdminId?: string | null;
}

/**
 * من بقي عليه أن يوقّع هذا المستوى في هذه الجولة.
 *
 * بالجولة لا بالتقرير: تقريرٌ أُعيد وصُحّح تبدّل مضمونه، وتوقيعُ جولةٍ ماضية
 * على نصٍّ آخر ليس توقيعاً على هذا.
 */
export function missingSigners(ctx: QuorumContext, levelSeq: number, round: number): string[] {
  const signed = new Set<string>();
  for (const s of ctx.steps) {
    if (s.action !== 'APPROVE' || s.levelSeq !== levelSeq || s.round !== round) continue;
    if (s.actorAdminId) signed.add(s.actorAdminId);
  }
  if (ctx.actorAdminId) signed.add(ctx.actorAdminId);
  return ctx.eligible.filter(o => !signed.has(o.adminId)).map(o => o.adminId);
}

export function applyAction(
  action: 'APPROVE' | 'RETURN' | 'RESUBMIT',
  levels: ChainLevel[],
  currentSeq: number,
  round: number,
  ctx?: QuorumContext,
): Transition {
  if (action === 'RETURN') {
    return { closeCurrentAs: 'SKIPPED', openNext: null, status: 'RETURNED', finalApproval: false, bumpRound: false, awaitingQuorum: [] };
  }
  if (action === 'RESUBMIT') {
    const first = firstLevel(levels);
    return {
      closeCurrentAs: 'SKIPPED',
      openNext: first ? { levelId: first.id, levelSeq: first.seq, round: round + 1 } : null,
      status: 'SUBMITTED',
      finalApproval: false,
      bumpRound: true,
      awaitingQuorum: [],
    };
  }

  /* النِّصاب **قبل** أي انتقال: مستوىً عرّفته الشركة بتوقيعين لا يعبره توقيع.
   * وما ليس 'ANY' يُشدَّد معاملة ALL عمداً — الافتراض في المخطّط ALL، وقيمةٌ
   * مجهولة يجب أن تطلب التوقيع الناقص لا أن تتنازل عنه. */
  const level = sortLevels(levels).find(l => l.seq === currentSeq);
  const waiting = ctx && level && level.quorum !== 'ANY'
    ? missingSigners(ctx, currentSeq, round)
    : [];
  if (waiting.length && level) {
    /* يبقى التقرير عند مستواه: تُغلق المهمّة الحالية وتُفتح أخرى **للمستوى
     * نفسه وجولته نفسها**، فيظلّ في صندوق من بقي توقيعه، ويبقى مؤشّرا التقرير
     * مطابقين لما تشتقّه deriveCursor. ولا يُترك المؤشّر فارغاً ولا المهمّة
     * مفتوحةً بحالتها الأولى: كلاهما ينزاح عن الحقيقة في المعاملة نفسها. */
    return {
      closeCurrentAs: 'DONE',
      openNext: { levelId: level.id, levelSeq: level.seq, round },
      status: 'IN_REVIEW',
      finalApproval: false,
      bumpRound: false,
      awaitingQuorum: waiting,
    };
  }

  const nxt = nextLevel(levels, currentSeq);
  if (!nxt) {
    return { closeCurrentAs: 'DONE', openNext: null, status: 'APPROVED', finalApproval: true, bumpRound: false, awaitingQuorum: [] };
  }
  return {
    closeCurrentAs: 'DONE',
    openNext: { levelId: nxt.id, levelSeq: nxt.seq, round },
    status: 'IN_REVIEW',
    finalApproval: false,
    bumpRound: false,
    awaitingQuorum: [],
  };
}

/**
 * وصفٌ عربيّ للسلسلة يُعرض تحت شاشة الإعداد — «المحاكي».
 *
 * أرخص عنصر في التصميم كلّه وأعلاه قيمة: بدونه يضبط المالك شبكة توجيهٍ لا يرى
 * أثرها إلا بعد أن يعلق تقرير مندوبٍ أسبوعاً.
 */
export function describeChain(
  levels: ChainLevel[],
  owners: ChainOwner[],
  ownerReps: OwnerRep[],
  repName: string,
  salesRepId: string,
): string[] {
  const out: string[] = [`${repName} يرفع تقريره`];
  for (const l of sortLevels(levels)) {
    const who = ownersFor(owners, ownerReps, l.id, salesRepId);
    const names = ownerNames(who);
    if (!who.length) out.push(`${l.name}: لا أحد يستقبله — التقرير يعلق هنا`);
    // الصيغة تتبع العدد: «يوقّعان» عن ثلاثةٍ وعدٌ بغير ما يُنفَّذ في عين قارئه
    else if (who.length > 1 && l.quorum === 'ANY') out.push(`${l.name}: ${names} — يكفي توقيع ${who.length > 2 ? 'أحدهم' : 'أحدهما'}`);
    else if (who.length > 2) out.push(`${l.name}: ${names} — يوقّعون جميعاً`);
    else if (who.length > 1) out.push(`${l.name}: ${names} — يوقّعان معاً`);
    else out.push(`${l.name}: ${names}`);
  }
  out.push('يُعتمد ويدخل التقرير الشامل');
  return out;
}

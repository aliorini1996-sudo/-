import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  nextLevel, firstLevel, ownersFor, chainIssues, planFirstTask, deriveCursor,
  canAct, countDistinctApprovers, applyAction, describeChain, missingSigners,
  ChainLevel, ChainOwner, OwnerRep, ChainTask, ChainStep,
} from '../services/dailyReportChain';

/**
 * سلسلة اعتماد التقرير اليومي — اختبارات بمدخلات مصنوعة بلا قاعدة بيانات.
 *
 * ما تحرسه هذه الاختبارات ليس شكل الدوال بل ثلاثة أخطاء لا تظهر في الشاشة:
 * تقريرٌ يعلق في صندوق لا أحد · تقريرٌ يعتمده من ليس صاحب مستواه · وتقريرٌ
 * وقّعه شخصٌ واحد فيبدو مُدقَّقاً من ثلاثة.
 */

const L = (seq: number, name: string, kind = 'REVIEW', quorum = 'ALL'): ChainLevel =>
  ({ id: `lvl${seq}`, seq, name, kind, quorum });
const O = (levelId: string, adminId: string, isDefault = false, name = adminId, adminActive?: boolean): ChainOwner =>
  ({ id: `own-${levelId}-${adminId}`, levelId, adminId, adminName: name, isDefault, adminActive });
const S = (action: string, actorAdminId: string | null, levelSeq = 1, round = 1): ChainStep =>
  ({ levelSeq, round, action, actorAdminId, actorSalesRepId: null });
const T = (levelSeq: number, state: string, round = 1): ChainTask =>
  ({ reportId: 'r1', levelId: `lvl${levelSeq}`, levelSeq, round, state });

const LEVELS = [L(1, 'مشرف المبيعات'), L(2, 'المحاسب')];

// ————— الترتيب والتالي —————

test('nextLevel لا يفترض تسلسلاً بلا فجوات', () => {
  // حذف مستوىً وسط السلسلة يترك ١ ثم ٣ لحظةً قبل إعادة الترقيم؛
  // افتراض seq+1 يُعلّق التقرير عند لا شيء.
  const gapped = [L(1, 'أ'), L(3, 'ج')];
  assert.equal(nextLevel(gapped, 1)?.seq, 3);
  assert.equal(nextLevel(gapped, 3), null);
});

test('nextLevel يرتّب الوارد ولا يثق بترتيبه', () => {
  const shuffled = [L(2, 'ب'), L(1, 'أ')];
  assert.equal(firstLevel(shuffled)?.seq, 1);
  assert.equal(nextLevel(shuffled, 1)?.seq, 2);
});

test('سلسلة فارغة: لا مستوى أول ولا مهمّة', () => {
  assert.equal(firstLevel([]), null);
  assert.equal(planFirstTask([], 'r1'), null);
});

// ————— التشعّب —————

test('المُوجَّه له صراحةً يسبق المالك الافتراضي', () => {
  const owners = [O('lvl1', 'admA', true), O('lvl1', 'admB')];
  const reps: OwnerRep[] = [{ ownerId: 'own-lvl1-admB', salesRepId: 'rep1' }];
  assert.deepEqual(ownersFor(owners, reps, 'lvl1', 'rep1').map(o => o.adminId), ['admB']);
  // مندوبٌ غير موجَّه يقع على الافتراضي
  assert.deepEqual(ownersFor(owners, reps, 'lvl1', 'rep9').map(o => o.adminId), ['admA']);
});

test('مستوىً بلا صاحب يعيد قائمة فارغة لا يخترع أحداً', () => {
  // «إن غاب صاحب الدور يتولّاه ADMIN تلقائياً» هي بعينها ثقب الاعتماد الذاتي
  assert.deepEqual(ownersFor([], [], 'lvl1', 'rep1'), []);
});

test('chainIssues يكشف مستوىً كل ملّاكه موجَّهون — فمندوبٌ خارج القوائم يعلق', () => {
  const owners = [O('lvl1', 'admB')]; // بلا isDefault
  const issues = chainIssues([L(1, 'مشرف')], owners);
  assert.equal(issues.length, 1);
  assert.match(issues[0], /بلا مالك افتراضي/);
});

test('chainIssues يكشف السلسلة الفارغة ومستوىً بلا صاحب', () => {
  assert.match(chainIssues([], [])[0], /لا مستويات/);
  assert.match(chainIssues([L(1, 'مشرف')], [])[0], /بلا صاحب/);
});

// ————— حياة المالك: العقدة تبقى بعد أن يذهب صاحبها —————

test('ownersFor: مالكٌ عُطِّل حسابه ليس مستقبِلاً — ومندوبه يقع على الافتراضي', () => {
  // سعد استقال فحُذف حسابه: لا مفتاح أجنبيّ يمنع ذلك، والمصادقة تردّه عند
  // الباب. إبقاؤه مؤهَّلاً يفتح مهمّةً PENDING لا تظهر في صندوق أحد أبداً.
  const owners = [O('lvl1', 'admDefault', true, 'خالد'), O('lvl1', 'saad', false, 'سعد', false)];
  const reps: OwnerRep[] = [{ ownerId: 'own-lvl1-saad', salesRepId: 'rep1' }];
  assert.deepEqual(ownersFor(owners, reps, 'lvl1', 'rep1').map(o => o.adminId), ['admDefault']);
});

test('ownersFor: غياب معلومة الحياة لا يُفرغ المستوى', () => {
  // undefined = «غير معلوم»: قارئٌ لا يمرّر الحياة يجب ألّا يوقف تقارير الشركة
  const owners = [O('lvl1', 'admA', true)];
  assert.deepEqual(ownersFor(owners, [], 'lvl1', 'rep1').map(o => o.adminId), ['admA']);
});

test('chainIssues: مستوىً كل ملّاكه معطّلون يُعلَن صراحةً لا يبتلع التقارير صامتاً', () => {
  const issues = chainIssues([L(2, 'المحاسب')], [O('lvl2', 'saad', true, 'سعد', false)]);
  assert.equal(issues.length, 1);
  assert.match(issues[0], /سعد/);
  assert.match(issues[0], /لم يعد مستخدماً نشطاً/);
});

test('chainIssues: مالكٌ معطّل بين أحياء يُعلَن — التوجيه المعروض صار كذباً', () => {
  const owners = [O('lvl1', 'admA', true, 'خالد'), O('lvl1', 'saad', false, 'سعد', false)];
  const issues = chainIssues([L(1, 'مشرف')], owners);
  assert.equal(issues.length, 1);
  assert.match(issues[0], /أعد توجيه مناديبه/);
});

test('chainIssues: تعطيل المالك الافتراضي يترك المستوى بلا افتراضيّ', () => {
  // الحيّ الوحيد موجَّهٌ لمندوبٍ بعينه: من عداه يعلق
  const owners = [O('lvl1', 'saad', true, 'سعد', false), O('lvl1', 'admB', false, 'نورة')];
  const issues = chainIssues([L(1, 'مشرف')], owners);
  assert.equal(issues.length, 2);
  assert.match(issues.join(' | '), /لم يعد مستخدماً نشطاً/);
  assert.match(issues.join(' | '), /بلا مالك افتراضي/);
});

// ————— المؤشّر المُشتقّ —————

test('deriveCursor: بعد الرفع مباشرةً = SUBMITTED عند المستوى الأول', () => {
  const c = deriveCursor([T(1, 'PENDING')], LEVELS, false);
  assert.deepEqual(c, { status: 'SUBMITTED', currentLevelId: 'lvl1', currentLevelSeq: 1 });
});

test('deriveCursor: بعد أوّل فعل = IN_REVIEW عند المستوى التالي', () => {
  const c = deriveCursor([T(1, 'DONE'), T(2, 'PENDING')], LEVELS, false);
  assert.deepEqual(c, { status: 'IN_REVIEW', currentLevelId: 'lvl2', currentLevelSeq: 2 });
});

test('deriveCursor: لا مهمّة مفتوحة بعد فعلٍ = APPROVED بلا مستوى', () => {
  const c = deriveCursor([T(1, 'DONE'), T(2, 'DONE')], LEVELS, false);
  assert.deepEqual(c, { status: 'APPROVED', currentLevelId: null, currentLevelSeq: null });
});

test('deriveCursor: الإعادة تمحو المستوى ولا تُبقيه معلّقاً', () => {
  const c = deriveCursor([T(1, 'SKIPPED')], LEVELS, true);
  assert.deepEqual(c, { status: 'RETURNED', currentLevelId: null, currentLevelSeq: null });
});

test('deriveCursor يتجاهل المهامّ المُلغاة ويأخذ أقلّ مستوىً مفتوح', () => {
  const tasks = [T(2, 'PENDING'), T(1, 'SKIPPED'), T(1, 'PENDING', 2)];
  assert.equal(deriveCursor(tasks, LEVELS, false).currentLevelSeq, 1);
});

// ————— الإذن —————

test('canAct: صاحب المستوى المفتوح وحده يملك الفعل', () => {
  const owners = [O('lvl1', 'admA', true), O('lvl2', 'admC', true)];
  const tasks = [T(1, 'PENDING')];
  assert.equal(canAct({ adminId: 'admA' }, tasks, LEVELS, owners, [], 'rep1').allowed, true);
  // صاحب المستوى الثاني لا يملك التقرير وهو عند الأول — لا تخطّي
  const c = canAct({ adminId: 'admC' }, tasks, LEVELS, owners, [], 'rep1');
  assert.equal(c.allowed, false);
  assert.match(c.reason!, /ليس عند مستواك/);
});

test('canAct: المندوب لا يعتمد تقريره ولو كان صاحبه', () => {
  const owners = [O('lvl1', 'admA', true)];
  const r = canAct({ salesRepId: 'rep1' }, [T(1, 'PENDING')], LEVELS, owners, [], 'rep1');
  assert.equal(r.allowed, false);
  assert.match(r.reason!, /ليس مستخدماً إدارياً/);
});

test('canAct: الدور لا يمنح إذناً — ADMIN غير المالك يُمنع', () => {
  const owners = [O('lvl1', 'admA', true)];
  const r = canAct({ adminId: 'admZ', role: 'ADMIN' }, [T(1, 'PENDING')], LEVELS, owners, [], 'rep1');
  assert.equal(r.allowed, false);
});

test('canAct: التشعّب يُحترم — مالك مندوبٍ آخر يُمنع', () => {
  const owners = [O('lvl1', 'admA'), O('lvl1', 'admB')];
  const reps: OwnerRep[] = [
    { ownerId: 'own-lvl1-admA', salesRepId: 'rep1' },
    { ownerId: 'own-lvl1-admB', salesRepId: 'rep2' },
  ];
  assert.equal(canAct({ adminId: 'admA' }, [T(1, 'PENDING')], LEVELS, owners, reps, 'rep1').allowed, true);
  assert.equal(canAct({ adminId: 'admB' }, [T(1, 'PENDING')], LEVELS, owners, reps, 'rep1').allowed, false);
});

// ————— الانتقالات —————

test('applyAction APPROVE في مستوىً وسط: يفتح التالي ولا يعتمد', () => {
  const t = applyAction('APPROVE', LEVELS, 1, 1);
  // awaitingQuorum أُضيفت للعقد: فارغةٌ هنا لأن المستوى عبر فعلاً
  assert.deepEqual(t, {
    closeCurrentAs: 'DONE',
    openNext: { levelId: 'lvl2', levelSeq: 2, round: 1 },
    status: 'IN_REVIEW', finalApproval: false, bumpRound: false, awaitingQuorum: [],
  });
});

test('applyAction APPROVE في آخر مستوى: اعتماد نهائي بلا مهمّة جديدة', () => {
  const t = applyAction('APPROVE', LEVELS, 2, 1);
  assert.equal(t.finalApproval, true);
  assert.equal(t.status, 'APPROVED');
  assert.equal(t.openNext, null);
});

test('applyAction RETURN: تُلغى المهمّة ولا تُفتح أخرى', () => {
  const t = applyAction('RETURN', LEVELS, 2, 1);
  assert.equal(t.closeCurrentAs, 'SKIPPED');
  assert.equal(t.openNext, null);
  assert.equal(t.status, 'RETURNED');
});

test('applyAction RESUBMIT: يعود للمستوى الأول بجولة جديدة', () => {
  // الإعادة من المستوى الثاني لا تعيده للثاني: المشرف يجب أن يرى التصحيح
  const t = applyAction('RESUBMIT', LEVELS, 2, 1);
  assert.deepEqual(t.openNext, { levelId: 'lvl1', levelSeq: 1, round: 2 });
  assert.equal(t.bumpRound, true);
  assert.equal(t.status, 'SUBMITTED');
});

test('applyAction APPROVE بلا مستويات لاحقة في سلسلة من مستوىً واحد', () => {
  const t = applyAction('APPROVE', [L(1, 'مشرف')], 1, 1);
  assert.equal(t.finalApproval, true);
});

// ————— النِّصاب: «يوقّعان معاً» وعدٌ يُفرَض لا يُعرَض —————

const FIN = [L(1, 'الاعتماد المالي', 'REVIEW', 'ALL')];
const SAAD = O('lvl1', 'saad', true, 'سعد');
const NOURA = O('lvl1', 'noura', true, 'نورة');

test('النِّصاب ALL: توقيعٌ واحد من اثنين لا يعبر بالمستوى ولا يقفل التقرير', () => {
  // الشركة عرّفت المستوى بتوقيعين والمحاكي قالهما للمالك؛ فمضيُّ التقرير
  // بتوقيعٍ واحد مستندٌ مُوقَّعٌ بنصف ما فرضته الشركة، ولا سبيل لإعادته بعدها.
  const t = applyAction('APPROVE', FIN, 1, 1, { eligible: [SAAD, NOURA], steps: [], actorAdminId: 'saad' });
  assert.equal(t.finalApproval, false);
  assert.equal(t.status, 'IN_REVIEW');
  assert.deepEqual(t.awaitingQuorum, ['noura']);
  // ويبقى عند مستواه نفسه لا عند لا شيء
  assert.deepEqual(t.openNext, { levelId: 'lvl1', levelSeq: 1, round: 1 });
});

test('النِّصاب ALL: التوقيع الثاني يُكمله فيعتمد نهائياً', () => {
  const t = applyAction('APPROVE', FIN, 1, 1, {
    eligible: [SAAD, NOURA], steps: [S('APPROVE', 'saad')], actorAdminId: 'noura',
  });
  assert.equal(t.finalApproval, true);
  assert.equal(t.status, 'APPROVED');
  assert.deepEqual(t.awaitingQuorum, []);
});

test('النِّصاب ALL: تكرار التوقيع نفسه لا يُكمل النصاب', () => {
  const t = applyAction('APPROVE', FIN, 1, 1, {
    eligible: [SAAD, NOURA], steps: [S('APPROVE', 'saad')], actorAdminId: 'saad',
  });
  assert.deepEqual(t.awaitingQuorum, ['noura']);
  assert.equal(t.finalApproval, false);
});

test('النِّصاب ALL: توقيع جولةٍ ماضية لا يُكمل نصاب هذه الجولة', () => {
  // الجولة السابقة نسخةٌ أُعيدت وصُحّحت؛ من وقّعها لم يرَ ما يُعتمد الآن
  const t = applyAction('APPROVE', FIN, 1, 2, {
    eligible: [SAAD, NOURA], steps: [S('APPROVE', 'saad', 1, 1)], actorAdminId: 'noura',
  });
  assert.deepEqual(t.awaitingQuorum, ['saad']);
});

test('النِّصاب ALL: توقيع مستوىً آخر لا يُحسب لهذا المستوى', () => {
  assert.deepEqual(
    missingSigners({ eligible: [SAAD, NOURA], steps: [S('APPROVE', 'noura', 2, 1)], actorAdminId: 'saad' }, 1, 1),
    ['noura'],
  );
});

test('النِّصاب ANY: يكفي أوّلهما فيمضي', () => {
  const any = [L(1, 'الاعتماد المالي', 'REVIEW', 'ANY')];
  const t = applyAction('APPROVE', any, 1, 1, { eligible: [SAAD, NOURA], steps: [], actorAdminId: 'saad' });
  assert.equal(t.finalApproval, true);
  assert.deepEqual(t.awaitingQuorum, []);
});

test('النِّصاب ALL بمالكٍ واحد = توقيعٌ واحد يكفي', () => {
  const t = applyAction('APPROVE', FIN, 1, 1, { eligible: [SAAD], steps: [], actorAdminId: 'saad' });
  assert.equal(t.finalApproval, true);
});

test('النِّصاب لا يُفرَض بلا سياق — فتمريره واجبٌ على مسار الاعتماد', () => {
  // يُوثَّق التنازل صراحةً: استدعاءٌ بلا ctx يمضي بتوقيعٍ واحد مهما كان quorum.
  // فإن سقط السياق يوماً من المسار سقط الوعد معه بلا صوت.
  const t = applyAction('APPROVE', FIN, 1, 1);
  assert.equal(t.finalApproval, true);
});

test('المستوى المنتظِر يبقى في صندوق من بقي توقيعه، والمؤشّر يطابق الحقيقة', () => {
  let tasks: ChainTask[] = [planFirstTask(FIN, 'r1')!];
  const ctx = { eligible: [SAAD, NOURA], steps: [] as ChainStep[], actorAdminId: 'saad' };
  const t = applyAction('APPROVE', FIN, 1, 1, ctx);
  tasks = tasks.map(x => (x.levelSeq === 1 ? { ...x, state: t.closeCurrentAs } : x));
  if (t.openNext) tasks.push({ reportId: 'r1', ...t.openNext, state: 'PENDING' });

  const c = deriveCursor(tasks, FIN, false);
  assert.equal(c.status, t.status);
  assert.equal(c.currentLevelId, 'lvl1');
  // ونورة تفتحه: مهمّة مستواها ما زالت مفتوحة
  assert.equal(canAct({ adminId: 'noura' }, tasks, FIN, [SAAD, NOURA], [], 'rep1').allowed, true);
});

// ————— عدّاد الموقّعين —————

test('countDistinctApprovers: شخصٌ واحد وقّع المستويين = 1', () => {
  const steps: ChainStep[] = [
    { levelSeq: 0, round: 1, action: 'SUBMIT', actorAdminId: null, actorSalesRepId: 'rep1' },
    { levelSeq: 1, round: 1, action: 'APPROVE', actorAdminId: 'admA', actorSalesRepId: null },
    { levelSeq: 2, round: 1, action: 'APPROVE', actorAdminId: 'admA', actorSalesRepId: null },
  ];
  assert.equal(countDistinctApprovers(steps), 1);
});

test('countDistinctApprovers: رفع المندوب لا يُحسب اعتماداً', () => {
  const steps: ChainStep[] = [
    { levelSeq: 0, round: 1, action: 'SUBMIT', actorAdminId: null, actorSalesRepId: 'rep1' },
    { levelSeq: 1, round: 1, action: 'APPROVE', actorAdminId: 'admA', actorSalesRepId: null },
  ];
  assert.equal(countDistinctApprovers(steps), 1);
});

test('countDistinctApprovers: من أعاد التقرير ليس موقّعاً عليه', () => {
  // سارة أعادته للتصحيح ثم بُدّلت عقدتها لعليّ؛ فالنسخة المعتمَدة وقّعها عليٌّ
  // وحده. عدُّ RETURN اعتماداً كان يُطفئ وسم «اعتمده شخص واحد» عن تقريرٍ
  // اعتمده شخصٌ واحد — عكس ما وُضع الوسم له.
  const steps: ChainStep[] = [
    S('SUBMIT', null, 0, 2),
    S('RETURN', 'sara', 1, 2),
    S('APPROVE', 'ali', 1, 2),
  ];
  assert.equal(countDistinctApprovers(steps), 1);
});

test('countDistinctApprovers: تسجيل البيانات (ENTER) ليس اعتماداً', () => {
  const steps: ChainStep[] = [S('ENTER', 'acc', 2, 1), S('APPROVE', 'ali', 1, 1)];
  assert.equal(countDistinctApprovers(steps), 1);
});

test('countDistinctApprovers: موقّعو جولةٍ أُعيدت لا يُحسبون على النسخة المعتمَدة', () => {
  const steps: ChainStep[] = [
    S('APPROVE', 'ali', 1, 1), S('APPROVE', 'bob', 2, 1), S('RETURN', 'carol', 3, 1),
    S('SUBMIT', null, 0, 2),
    S('APPROVE', 'ali', 1, 2), S('APPROVE', 'ali', 2, 2), S('APPROVE', 'ali', 3, 2),
  ];
  assert.equal(countDistinctApprovers(steps), 1);
  // وبطلبٍ صريح للجولة الأولى: من وقّعها فعلاً
  assert.equal(countDistinctApprovers(steps, 1), 2);
});

test('countDistinctApprovers: خطوة الاعتماد الجارية بلا رقم جولة تُحسب في الجولة الجارية', () => {
  // شكل استدعاء المسار: يُلحق خطوته بالقائمة قبل كتابتها في المعاملة، وهي
  // بلا round. إسقاطها كان سيعطي صفراً على تقريرٍ اعتمده اثنان.
  const steps = [
    S('SUBMIT', null, 0, 2), S('APPROVE', 'ali', 1, 2),
    { action: 'APPROVE', actorAdminId: 'bob' } as unknown as ChainStep,
  ];
  assert.equal(countDistinctApprovers(steps), 2);
});

test('countDistinctApprovers: شخصان = 2، وإعادة التوجيه لا تُحسب', () => {
  const steps: ChainStep[] = [
    { levelSeq: 1, round: 1, action: 'APPROVE', actorAdminId: 'admA', actorSalesRepId: null },
    { levelSeq: 2, round: 1, action: 'REASSIGN', actorAdminId: 'admZ', actorSalesRepId: null },
    { levelSeq: 2, round: 1, action: 'APPROVE', actorAdminId: 'admB', actorSalesRepId: null },
  ];
  assert.equal(countDistinctApprovers(steps), 2);
});

// ————— المحاكي —————

test('describeChain يقول صراحةً أين يعلق التقرير', () => {
  const lines = describeChain([L(1, 'مشرف'), L(2, 'محاسب')], [O('lvl1', 'admA', true, 'خالد')], [], 'سالم', 'rep1');
  assert.equal(lines[0], 'سالم يرفع تقريره');
  assert.match(lines[1], /خالد/);
  assert.match(lines[2], /يعلق هنا/);
});

test('describeChain يميّز «يوقّعان معاً» عن «يكفي أحدهما»', () => {
  const all = describeChain([L(1, 'مشرف', 'REVIEW', 'ALL')], [O('lvl1', 'a', true, 'أ'), O('lvl1', 'b', true, 'ب')], [], 'س', 'rep1');
  assert.match(all[1], /يوقّعان معاً/);
  const any = describeChain([L(1, 'مشرف', 'REVIEW', 'ANY')], [O('lvl1', 'a', true, 'أ'), O('lvl1', 'b', true, 'ب')], [], 'س', 'rep1');
  assert.match(any[1], /يكفي توقيع أحدهما/);
});

test('describeChain: الصيغة تتبع العدد — ثلاثةٌ «يوقّعون جميعاً»', () => {
  const three = [O('lvl1', 'a', true, 'أ'), O('lvl1', 'b', true, 'ب'), O('lvl1', 'c', true, 'ج')];
  assert.match(describeChain([L(1, 'المالية')], three, [], 'س', 'rep1')[1], /يوقّعون جميعاً/);
  assert.match(describeChain([L(1, 'المالية', 'REVIEW', 'ANY')], three, [], 'س', 'rep1')[1], /يكفي توقيع أحدهم/);
});

test('describeChain: عقدةٌ صاحبها معطّل تُقال «لا أحد يستقبله» لا باسمه', () => {
  const lines = describeChain([L(1, 'المحاسب')], [O('lvl1', 'saad', true, 'سعد', false)], [], 'سالم', 'rep1');
  assert.match(lines[1], /يعلق هنا/);
});

// ————— التطابق بين المؤشّر والحقيقة —————

test('المؤشّر المُشتقّ يطابق ما يكتبه applyAction بعد كل انتقال', () => {
  // هذا هو التوازن مع «لا عدّاداً يمكن أن ينقصّا»: العمودان مؤشّرٌ هادٍ،
  // والمهامّ حقيقة، وهذا الاختبار يمنع انزياحهما.
  let tasks: ChainTask[] = [planFirstTask(LEVELS, 'r1')!];
  assert.equal(deriveCursor(tasks, LEVELS, false).currentLevelSeq, 1);

  const t1 = applyAction('APPROVE', LEVELS, 1, 1);
  tasks = tasks.map(t => t.levelSeq === 1 ? { ...t, state: t1.closeCurrentAs } : t);
  if (t1.openNext) tasks.push({ reportId: 'r1', ...t1.openNext, state: 'PENDING' });
  const c1 = deriveCursor(tasks, LEVELS, false);
  assert.equal(c1.status, t1.status);
  assert.equal(c1.currentLevelSeq, 2);

  const t2 = applyAction('APPROVE', LEVELS, 2, 1);
  tasks = tasks.map(t => t.levelSeq === 2 ? { ...t, state: t2.closeCurrentAs } : t);
  const c2 = deriveCursor(tasks, LEVELS, false);
  assert.equal(c2.status, 'APPROVED');
  assert.equal(c2.status, t2.status);
});

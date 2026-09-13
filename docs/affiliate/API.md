# واجهات «سفير فيلد سيلز» — الأشكال الدقيقة (يعلو على CONTRACT §6 في التفاصيل)

كل ردّ ناجح: `{ success: true, data: ... }`. كل خطأ: `{ success: false, message: string }` بالعربية.
الأخطاء: 400 بيانات، 401 جلسة، 403 غير مسموح/حالة، 404، 409 تعارض حالة، 429 محدِّد.
المبالغ **بالهللات** (`*Halalas: number`). التواريخ ISO نصّاً أو `null`.

## الأنواع المشتركة

```ts
type UserStatus = 'pending_email' | 'pending_review' | 'approved' | 'rejected' | 'suspended';
type ClaimStatus = 'under_review' | 'approved' | 'rejected' | 'withdrawn' | 'expired' | 'converted';
type AttributionStatus = 'active' | 'disputed' | 'void';
type CommissionStatus = 'pending' | 'on_hold' | 'approved' | 'paid' | 'reversed' | 'declined';
type PayoutStatus = 'draft' | 'recorded' | 'void';
type ClaimHow = 'visit' | 'relationship' | 'event' | 'online' | 'other';
type ClaimReason = 'existing_customer' | 'duplicate' | 'self_referral' | 'insufficient' | 'other';
type Flag = 'self_email' | 'self_phone' | 'returning_company' | 'ip_match' | 'terms_outdated' | 'link_expired';
```

---

## 1) البوابة — `BASE/api/affiliate` — توكن `Authorization: Bearer <ax_token>`

### عام
- `GET /terms/public` ⇒
  `{ version: string, body: string, disclosureText: string, rateBps: number, holdDays: number, minPayoutHalalas: number, refWindowDays: number, intakeOpen: boolean }`
  (`body` نص عادي بأسطر `\n` — يُعرض مُهرَّباً مع `white-space: pre-wrap`.)
- `POST /register` جسم:
  ```ts
  { fullName: string /*2..80*/, email: string, phone: string /*جوال سعودي*/, city?: string, password: string /*8..128*/,
    vatNumber?: string /*15 رقماً*/, marketingConsent: boolean,
    acceptTerms: true, termsVersion: string }
  // أُلغيت بقرار المالك («لا نريد تقييد السفير»): الإقرارات، و«سأنشر علناً»، وترخيص موثوق —
  // تُقبل من نسخةٍ قديمة وتُهمل (publicPromoter/mawthooqNo/mawthooqExpiry/declarations)
  ```
  - ⇒ **202** `{ message }` دائماً (حتى لو البريد مسجَّل). بريدٌ مسجَّل **لم يؤكَّد** يُحدَّث بآخر طلب (كلمة المرور والبيانات)؛ والتأكيد يطلب كلمة مرور آخر طلب، فلا يُفعِّل أحدٌ طلباً لا يعرف كلمة مروره.
  - البريد (تأكيد/استعادة/إعادة إرسال) مرّةً كلّ ٥ دقائق لكلّ عنوان على الأكثر، والردّ 202 في كلّ الأحوال.
  - 403 إن كان الانضمام مغلقاً `intakeOpen=false`. 409 إن كان `termsVersion` لا يطابق الحالي (أعد تحميل الشروط).
- `POST /verify-email` `{ token, password }` ⇒ `{ status }` = الحالة الفعلية الآن (`pending_review` | `approved` | `rejected` | `suspended`) · 400 رابط غير صالح · 400 `code: 'password_mismatch'` كلمة المرور لا تطابق آخر طلبٍ بهذا البريد · 409 تغيّر الطلب للتوّ.
- `POST /login` `{ email, password }` ⇒ `{ token: string, user: AffiliateMe }` · **كلّ فشل 401 برسالةٍ واحدة** (بريد غير مسجّل، كلمة مرور خاطئة، بريد غير مؤكَّد، قفل مؤقّت ربع ساعة بعد ٥ محاولات) — لا 423 ولا رسالة مميّزة. المحاولة تُحجز ذرّياً قبل فحص كلمة المرور، فالتخمين المتزامن لا يتجاوز القفل.
  - الدخول مسموح بكل الحالات **عدا** `pending_email`.
- `POST /resend-verification` `{ email }` ⇒ 202 موحّد.
- `POST /forgot` `{ email }` ⇒ 202 موحّد.
- `POST /reset` `{ token, password }` ⇒ `{ ok: true, token?: string, user?: AffiliateMe }` — الرمز يُعاد لكلّ حسابٍ مؤكَّد البريد، فالاستعادة تُدخل صاحبها **وتفكّ القفل** · 400.
- `POST /click` `{ code }` ⇒ 204 دائماً (حتى للرمز الخاطئ).

### بجلسة (أي حالة عدا pending_email)
- `GET /me` ⇒
  ```ts
  { user: AffiliateMe, settings: { disclosureText: string, rateBps: number, holdDays: number, minPayoutHalalas: number, currentTermsVersion: string },
    link: string /* https://fieldsa.net/?ref=CODE */, canSetPayout: boolean }
  AffiliateMe = { id, email, fullName, phone: string|null, city: string|null, code: string, status: UserStatus, statusReason: string|null,
    publicPromoter: boolean, mawthooqNo: string|null, mawthooqExpiry: string|null, vatNumber: string|null, marketingConsent: boolean,
    termsVersion: string, payout: { holderName: string, bankName: string|null, ibanLast4: string, updatedAt: string } | null, createdAt: string }
  ```
- `PUT /me` `{ city?, marketingConsent?, vatNumber? }` ⇒ `{ user: AffiliateMe }` — `''` يمسح الحقل. (لا «سأنشر علناً» ولا ترخيص موثوق.)
- `POST /accept-terms` `{ termsVersion }` ⇒ `{ user: AffiliateMe }` (عند نشر إصدار جديد)

### بجلسة **approved** وبالشروط الحالية مقبولة (غير ذلك 403 `{message}`؛ و`code: 'terms_outdated'` إن نُشرت شروطٌ لم يقبلها)
- `GET /dashboard` ⇒ `{ clicks30d: number, signups: number, paidCompanies: number, pendingHalalas: number, approvedHalalas: number, paidHalalas: number, adjustmentsHalalas: number /* غير المسوّاة فقط */ }`
- `GET /companies` ⇒ `Array<{ id: string /*attributionId*/, tenantName: string, source: 'signup_code'|'claim'|'owner', status: 'trial'|'paid'|'disputed'|'void'|'expired', signedUpAt: string, firstPaymentDeadline: string, firstPaidAt: string|null, commission: { status: CommissionStatus, commissionHalalas: number, eligibleAt: string } | null /* عمولة السفير نفسه فقط */ }>`
- `POST /claims` `{ companyName: string /*2..120*/, crNumber: string /*10 أرقام*/, contactPhone: string /*إلزامي: جوال سعودي أو 8–15 رقماً*/, city?: string, how: ClaimHow, note?: string /*≤200*/ }` ⇒ **201** `{ id: string, message: 'استلمنا الترشيح وسيُراجع' }` — يُرفض (400) بريدٌ أو سلسلة أرقامٍ بأيّ فواصل فيها ٨ أرقامٍ فأكثر (عدا التاريخ) في الاسم أو المدينة أو الملاحظة.
- `GET /claims` ⇒ `Array<{ id, companyName, crNumber, contactPhone: string|null, city: string|null, how: ClaimHow, status: ClaimStatus, lockedUntil: string|null, submittedAt: string }>`
- `POST /claims/:id/withdraw` ⇒ `{ ok: true }` (فقط `under_review`، وإلا 409)
- `GET /commissions` ⇒ `Array<{ id, tenantName, paymentAmountHalalas, refundedHalalas, commissionHalalas, rateBps, status: CommissionStatus, paymentPaidAt: string, eligibleAt: string, reasonNote: string|null, paidAt: string|null }>`
- `GET /adjustments` ⇒ `Array<{ id, kind: 'clawback_refund'|'correction', amountHalalas: number, note: string|null, createdAt: string, settled: boolean }>`
- `GET /payouts` ⇒ `Array<{ id, netHalalas, commissionsHalalas, adjustmentsHalalas, status: 'recorded', transferredAt: string|null, bankReference: string|null, ibanLast4: string, createdAt: string }>` (المسودّات والملغاة لا تظهر للسفير)
- `PUT /payout-profile` `{ iban: string, holderName: string /*2..120*/, bankName?: string }` ⇒ `{ user: AffiliateMe }` · 403 إن لم تكن له عمولة معتمدة أو مدفوعة بعد (`canSetPayout=false`) · 400 آيبان غير صالح.

---

## 2) المالك — `BASE/api/affiliate-admin` — توكن لوحة المنصّة (SUPER_ADMIN) عبر `api/client.ts`

- `GET /overview` ⇒ `{ affiliates: { pending_review, approved, suspended, total }, claimsUnderReview, attributions: { active, disputed }, commissions: { pendingHalalas, onHoldHalalas, readyToApprove /*عدد pending تجاوزت eligibleAt*/, approvedUnpaidHalalas, paidHalalas }, payoutCandidates: number }`
- `GET /settings` ⇒ `AffiliateSettings` (كل الحقول في المخطّط) · `PUT /settings` **تشغيليّ فقط** `{ intakeOpen?, disclosureText? /*10..300*/ }` ⇒ الإعدادات. إرسال أيٍّ من **قيم الشروط** بقيمةٍ مختلفة ⇒ 409 `code: 'terms_bound'`.
- **قيم الشروط** (تتغيّر بنشر إصدار فقط): `rateBps 0..10000` · `holdDays 0..365` · `minPayoutHalalas 0..100000000` · `refWindowDays 1..365` · `claimLockDays 1..365` · `firstPaymentWithinDays 1..730`.
- `GET /terms` ⇒ `Array<{ version, body, publishedAt, publishedBy, rules: {…القيم الست…} }>` · `POST /terms` `{ version /*^[\w.-]{3,40}$*/, body /*≥50*/, rules?: {…أيٌّ من الست…} }` ⇒ الإصدار (ويصبح الحالي، وتسري قواعده في المعاملة نفسها). النسبة والحجز ومهلة الدفعة الأولى تُؤخذ لكل إسنادٍ **من إصدار الشروط الذي قبله السفير** وتُخزَّن عليه.
- `GET /affiliates?status=&q=` ⇒ `Array<{ id, fullName, email, phone, city, code, status, statusReason, publicPromoter, mawthooqNo, mawthooqExpiry /*'YYYY-MM-DD' بالرياض*/, createdAt, lastLoginAt, counts: { claims, attributions, commissions }, earnedHalalas /*pending+on_hold+approved+paid*/, paidHalalas, hasPayout: boolean }>`
- `GET /affiliates/:id` ⇒ `{ affiliate: (مثل عنصر القائمة + vatNumber, termsVersion, termsAcceptedAt, marketingConsent, payout: {holderName, bankName, ibanLast4, updatedAt}|null), claims: [...], attributions: [...], commissions: [...], adjustments: [...{ settled: boolean /*في دفعة مسجَّلة*/, inDraft: boolean }], payouts: [...{ transferredAt: 'YYYY-MM-DD'|null }], events: AffiliateEvent[] }` (صفوف خام من المخطّط)
- `POST /affiliates/:id/approve` · `POST /affiliates/:id/reject {reason}` · `POST /affiliates/:id/suspend {reason}` · `POST /affiliates/:id/reactivate` (موقوف ⇒ مقبول، مرفوض ⇒ قيد المراجعة) ⇒ `{ status }` (409 انتقال غير مسموح)
- `POST /affiliates/:id/reveal-iban` ⇒ `{ iban: string, holderName, bankName }` (يُسجَّل حدثاً)
- `GET /claims?status=` ⇒ `Array<{ id, affiliate: {id, fullName, code}, companyName, crNumber, contactPhone: string|null, city, how, note, status, reasonCode, submittedAt, reviewedAt, lockedUntil, tenantId, tenantName: string|null, conflicts: Array<{ claimId, affiliateName, status }> /*ترشيحات أخرى بالسجل نفسه*/, suggestions: Array<{ tenantId, tenantName, match: 'cr'|'name', createdAt }> }>`
- `POST /claims/:id/approve` ⇒ `{ status: 'approved', lockedUntil }` · 409 إن وُجد ترشيح معتمد ساري بالسجل نفسه
- `POST /claims/:id/reject {reasonCode: ClaimReason}` ⇒ `{ status: 'rejected' }`
- `POST /claims/:id/link-tenant {tenantId}` ⇒ `{ attribution: {id, status}, commission: {id, status}|null, commissionCreated: boolean, accrualReason: string|null, conflict: { attributionStatus: string, commissionHeld: boolean } | null }` — الترشيح `approved`، أو `expired` إن سجّلت الشركة داخل قفله. بداية الإسناد = لحظة **تقديم** الترشيح (وتُسحب إليها بداية إسنادٍ قائم للسفير نفسه إن لم تنشأ عمولة). مدّة القفل عند الاعتماد من شروط صاحب الترشيح.
- `GET /attributions?status=` ⇒ `Array<{ id, tenantId, tenantName /*لقطة*/, affiliate: {id, fullName, code}, source, status, flags: Flag[], codeUsed, refVia, reasonNote, effectiveFrom, firstPaymentDeadline, rateBps, createdAt, commission: {id, status, commissionHalalas}|null }>`
- ردود الإسناد كلّها: `{ attribution: {id, status}, commission: {id, status, commissionHalalas}|null, commissionCreated: boolean, accrualReason: string|null }`
- رموز `accrualReason`: `not_paid_or_unlinked` · `zero_amount` · `no_attribution` · `exists` · `not_first_payment` · `outside_window` · `zero_commission` · `no_payment` · `first_payment_reversed` · `earlier_payment_linked` (دفعةٌ أقدم رُبطت بعد نشوء العمولة على لاحقة — أُوقفت القائمة) · `earlier_payment_committed` (القائمة مصروفة أو في مسودّة — تصحيحٌ يدوي) · `earlier_payment_no_commission` (القائمة مستردّة أو مرفوضة) · `error` — و`null` حين كانت للإسناد عمولةٌ قائمة.
- `POST /attributions {tenantId, affiliateId, reason, effectiveFrom?: 'YYYY-MM-DD'}` · 409 إن كان للشركة **أيّ** إسناد (ولو مُبطلاً) — استعمل «إعادة إسناد»
- `POST /attributions/:id/void {reason}` — العمولة غير المصروفة تُوقف (إلا إن أوقفها المالك يدوياً فتبقى بسببه) · `POST /attributions/:id/activate {reason}`
- `POST /attributions/:id/reassign {affiliateId, reason, effectiveFrom?: 'YYYY-MM-DD', claimId?}` — لإسنادٍ `disputed` أو `void` فقط: ينقله للسفير ويُعيد لقطة عمولته غير المصروفة **والمرفوضة** بشروطه (إيقاف المالك اليدويّ يبقى). المصروفة: يُقيَّد تلقائياً سالبٌ على السابق وموجبٌ للجديد بصافيها، ويتحمّل الجديد أيّ استردادٍ لاحق.
- `POST /attributions/:id/window {effectiveFrom: 'YYYY-MM-DD', reason}` — لإسنادٍ بلا عمولة: تعديل بدايته ثم محاولة الاحتساب
- `GET /commissions?status=` ⇒ `Array<{ id, tenantId, tenantName, affiliate: {id, fullName, code}, paymentLinkId, paymentAmountHalalas, refundedHalalas, coveredMonths, rateBps, commissionHalalas, paymentPaidAt, eligibleAt, status, reasonNote, approvedAt, payoutId, linkStatus: string /*حالة رابط الدفع الآن*/, readyToApprove: boolean }>`
- `POST /commissions/:id/approve` ⇒ `{ status }` · 409 `{message}` مع سبب (`hold_not_over`/`payment_not_paid`/`not_pending`) — وإن لم يعد الرابط مدفوعاً تُعكس العمولة ويُردّ 409.
- `POST /commissions/:id/hold {reason}` · `POST /commissions/:id/release` · `POST /commissions/:id/decline {reason}` ⇒ `{ status }` — أيّ قرارٍ يمسّ عمولةً **داخل مسودّة دفعة** ⇒ 409 «ألغِ مسودّة الدفعة أولاً».
- الاسترداد الكامل قبل الالتزام يعكس العمولة، والجزئي يخفّضها بقدره؛ بعد الالتزام (مصروفة **أو داخل مسودّة**) يُقيَّد الفرق سالباً. المصدر `payment_links.refundedHalalas` (تراكميّ من ميسر)، والعمولة تُنشأ عليه أصلاً إن سبقها الاسترداد، والمصالحة تلتقط ما فات الخطاف.
- `GET /payouts/candidates` ⇒ `Array<{ affiliate: {id, fullName, code, email}, commissionsHalalas, adjustmentsHalalas, netHalalas, commissionCount, eligible: boolean, hasPayout: boolean, ibanLast4: string|null, holderName: string|null }>`
- `POST /payouts {affiliateId}` ⇒ الدفعة (`draft`) · 409 إن كان الصافي دون الحدّ أو بلا آيبان أو له مسودّة قائمة. تصحيحٌ موجبٌ وحده (بلا عمولات) يُصرف إن بلغ الحدّ.
- **المسودّة لقطةٌ مجمَّدة**: صافيها لا يتغيّر بعد إنشائها، وما يُستردّ بعدها قيدٌ سالب للدفعة القادمة.
- `GET /payouts?status=` ⇒ `Array<{ id, affiliate: {id, fullName, code}, commissionsHalalas, adjustmentsHalalas, netHalalas, status, ibanLast4, holderName, transferredAt, bankReference, createdAt, voidReason, commissionCount }>`
- `POST /payouts/:id/record {bankReference /*3..80*/, transferredAt: 'YYYY-MM-DD'}` ⇒ الدفعة (`recorded`) بصافي المسودّة كما جُهِّز — لا يُرفض بسبب استرداد.
- `GET /payouts` ⇒ `transferredAt` بصيغة `'YYYY-MM-DD'`.
- `POST /payouts/:id/void {reason}` ⇒ الدفعة (`void`)
- `POST /adjustments {affiliateId, amountHalalas /*≠0 عدد صحيح*/, note /*≥3*/}` ⇒ القيد
- `GET /events?entity=&entityId=` ⇒ آخر 200 `Array<{ id, entity, entityId, action, fromState, toState, actorType, actorId, reason, meta, createdAt }>`
- `GET /tenants/search?q=` ⇒ `Array<{ id, name, commercialReg: string|null, createdAt, attributed: boolean }>` (حدّ 20)

و`POST BASE/api/payments/:id/link-tenant {tenantId}` (SUPER_ADMIN) ⇒ `{ link, commission|null, commissionCreated, accrualReason }` — رابط `paid` بلا شركة فقط.

## 3) تسجيل الشركة — `POST BASE/api/auth/signup`
حقول إضافية متسامحة (لا تُفشل التسجيل أبداً): `ref?: string` (≤40)، `refVia?: 'link'|'typed'`، `refAt?: number` (لحظة التقاط الرابط بالملّي ثانية — الخادم يفرض `refWindowDays` على `refVia='link'`).

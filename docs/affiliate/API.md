# واجهات «سفير فيلد سيلز» — الأشكال الدقيقة (يعلو على CONTRACT §6 في التفاصيل)

> **v2 (١٨ نوفمبر ٢٠٢٦)** — الانضمام فوريّ، الحجز ١٠ أيام، دورة تسوية كل ١٠ أيام (١ و١١ و٢١) بحدٍّ أدنى ٥٠ ر.س،
> الاعتماد التلقائي، ملف السفير الكامل شرطٌ للتسوية، المطالبة بإحالة فائتة، والمواد التسويقية. المرجع الحاكم
> `V2_SPEC.md`؛ هذا الملف يطابقه بالأشكال الدقيقة.

كل ردّ ناجح: `{ success: true, data: ... }`. كل خطأ: `{ success: false, message: string, code?: string }` بالعربية.
الأخطاء: 400 بيانات، 401 جلسة، 403 غير مسموح/حالة، 404، 409 تعارض حالة، 429 محدِّد.
المبالغ **بالهللات** (`*Halalas: number`). التواريخ ISO نصّاً أو `null`.

## الأنواع المشتركة

```ts
type UserStatus = 'pending_email' | 'pending_review' | 'approved' | 'rejected' | 'suspended';
// v2: التسجيل يُنشئ 'approved' مباشرةً. pending_email/pending_review **إرثٌ** يُرقّى إلى approved مرّةً عند الإقلاع
// (OpsMarker 'ax-v2-instant') وعند أيّ دخولٍ ناجح لصاحبه. الانتقالات: approved→suspended، suspended→approved، rejected→approved.
type PartnerType = 'individual' | 'company' | 'influencer';
type SocialPlatform = 'x' | 'instagram' | 'snapchat' | 'tiktok' | 'youtube' | 'linkedin' | 'website' | 'other';
type SocialLink = { platform: SocialPlatform; url: string /* https?:// ≤300 — حتى ٨ روابط */ };
type DocKind = 'national_id' | 'commercial_reg';            // jpeg/png/webp/pdf مفحوصة بالبايتات ≤ ٥ ميغابايت، مشفّرة AES-256-GCM
type ProfileMissing = 'partnerType' | 'iban' | 'national_id' | 'commercial_reg';
type ClaimStatus = 'under_review' | 'approved' | 'rejected' | 'withdrawn' | 'expired' | 'converted';   // الترشيح المسبق (Nomination)
type MissedClaimStatus = 'under_review' | 'accepted' | 'rejected' | 'withdrawn';                      // المطالبة بإحالة فائتة
type AttributionStatus = 'active' | 'disputed' | 'void';
type CommissionStatus = 'pending' | 'on_hold' | 'approved' | 'paid' | 'reversed' | 'declined';
type PayoutStatus = 'draft' | 'recorded' | 'void' | 'failed';   // للسفير: قيد المعالجة / مدفوعة / ملغاة / فشل التحويل
type PayoutBlock = 'not_approved' | 'below_min' | 'no_iban' | 'profile_incomplete' | 'has_draft' | 'iban_failed';
type MaterialCategory = 'image' | 'video' | 'document' | 'text' | 'link';
type ClaimHow = 'visit' | 'relationship' | 'event' | 'online' | 'other';
type ClaimReason = 'existing_customer' | 'duplicate' | 'self_referral' | 'insufficient' | 'other';
type Flag = 'self_email' | 'self_phone' | 'returning_company' | 'ip_match' | 'terms_outdated' | 'link_expired' | 'claim_conflict';
```

**اكتمال الملف** `profileComplete = partnerType && ibanEnc && national_id && (partnerType !== 'company' || commercial_reg)` — يُختم `profileCompletedAt` حين يكتمل ويُمسح حين ينقص. **شرطٌ لدخول دورة التسوية (والصرف اليدويّ) فقط** — لا يحجب الحساب.

**دورة التسوية**: نهاياتها أيام **1 و11 و21** من كلّ شهر 00:00 بتوقيت الرياض. `cycleKey` = تاريخ النهاية `YYYY-MM-DD`، و`periodStart` = النهاية السابقة. `nextSettlementAt` = نهاية الدورة القادمة (ISO).

---

## 1) البوابة — `BASE/api/affiliate` — توكن `Authorization: Bearer <ax_token>`

### عام
- `GET /terms/public` ⇒
  `{ version: string, body: string, disclosureText: string, rateBps: number, holdDays: number, minPayoutHalalas: number, refWindowDays: number, intakeOpen: boolean }`
  (`body` نص عادي بأسطر `\n` — يُعرض مُهرَّباً مع `white-space: pre-wrap`.) الإصدار الحاليّ المدمج `2026-11-v4`: حجز ١٠ أيام وحدٌّ أدنى ٥٠٠٠ هللة.
- `POST /register` — **انضمامٌ فوريّ** (v2) جسم:
  ```ts
  { fullName: string /*2..80*/, email: string, phone: string /*جوال سعودي أو دولي بمفتاحه*/, password: string /*8..128*/,
    partnerType: PartnerType, companyName?: string /*2..120 — إلزاميّ للشركة*/, socialLinks?: SocialLink[],
    acceptTerms: true, termsVersion: string, marketingConsent?: boolean }
  ```
  - ⇒ **201** `{ token: string, user: AffiliateMe }` (`status: 'approved'`، `emailVerifiedAt: null`) — يدخل البوابة فوراً، بلا تأكيد بريد ولا موافقة. بريد ترحيب للسفير (برابطه) وبريد «سفير جديد» للمالك.
  - بريدٌ مسجَّل ⇒ **409** `{ code: 'email_taken', message: 'يوجد حساب بهذا البريد — سجّل الدخول' }` (كتسجيل الشركات).
  - 403 إن كان الانضمام مغلقاً `intakeOpen=false`. 409 `code: 'terms_outdated'` إن كان `termsVersion` لا يطابق الحالي. المحدِّد `axRegisterLimiter` (٦/ساعة/IP).
- ~~`POST /verify-email`~~ و~~`POST /resend-verification`~~ — **حُذفتا في v2**؛ روابط البريد القديمة (`?verify=`) تحوّلها الواجهة إلى الدخول.
- `POST /login` `{ email, password }` ⇒ `{ token: string, user: AffiliateMe }` · **كلّ فشل 401 برسالةٍ واحدة** (بريد غير مسجّل، كلمة مرور خاطئة، قفل مؤقّت ربع ساعة بعد ٥ محاولات) — لا 423 ولا رسالة مميّزة. المحاولة تُحجز ذرّياً قبل فحص كلمة المرور.
  - الدخول مسموح بكل الحالات (الموقوف يرى حالته). حسابٌ إرثيّ `pending_email`/`pending_review` يُرقّى إلى `approved` عند الدخول الناجح ويُعطى التوكن.
- `POST /forgot` `{ email }` ⇒ 202 موحّد.
- `POST /reset` `{ token, password }` ⇒ `{ ok: true, token?: string, user?: AffiliateMe }` — الاستعادة تُدخل صاحبها **وتفكّ القفل** · 400.
- `POST /click` `{ code }` ⇒ 204 دائماً (حتى للرمز الخاطئ).

### بجلسة
- `GET /me` ⇒
  ```ts
  { user: AffiliateMe,
    settings: { disclosureText: string, rateBps: number, holdDays: number, minPayoutHalalas: number, currentTermsVersion: string,
      portalTrialEnabled: boolean /* AX_PORTAL_TRIAL_ENABLED=0 يطفئه */,
      nextSettlementAt: string /* ISO — نهاية الدورة القادمة */, settlementEveryDays: 10 },
    link: string /* https://fieldsa.net/signup?ref=CODE — رابط مباشر لصفحة التسجيل */ }
  AffiliateMe = { id, email, fullName, phone: string|null, city: string|null, code: string, status: UserStatus, statusReason: string|null,
    publicPromoter: boolean, mawthooqNo: string|null, mawthooqExpiry: string|null, vatNumber: string|null, marketingConsent: boolean,
    termsVersion: string, payout: { holderName: string, bankName: string|null, ibanLast4: string, updatedAt: string } | null, createdAt: string,
    // v2
    partnerType: PartnerType|null, companyName: string|null, socialLinks: SocialLink[],
    documents: Array<{ kind: DocKind, mime: string, sizeBytes: number, createdAt: string }>,
    profileComplete: boolean, missing: ProfileMissing[] }
  ```
- `PUT /me` `{ city?, marketingConsent?, vatNumber?, partnerType?, companyName?, socialLinks? }` ⇒ `{ user: AffiliateMe }` — `''` يمسح الحقل.
- `POST /accept-terms` `{ termsVersion }` ⇒ `{ user: AffiliateMe }` (عند نشر إصدار جديد — بوابة TermsGate)
- `PUT /payout-profile` `{ iban: string, holderName: string /*2..120*/, bankName?: string }` ⇒ `{ user: AffiliateMe }` — **متاحٌ دائماً** (v2: أُلغي شرط «بعد أول عمولة»). آيبان سعودي `SA`+22 بفحص mod-97 · 400 آيبان غير صالح · 409 إن كانت للسفير مسودّة دفعة قائمة. تحديثه بعد «فشل التحويل» يُعيده لدورة التسوية التالية.
- `POST /documents` `{ kind: DocKind, dataUrl: string }` ⇒ **201** `{ kind, mime, sizeBytes, createdAt }` — يستبدل السابق من النوع نفسه، مشفّراً، ويحدّث `profileCompletedAt`.
- `GET /documents/:kind` ⇒ `{ dataUrl }` (السفير نفسه لمعاينة ما رفعه) · `DELETE /documents/:kind` ⇒ حذفٌ حقيقي.

### بجلسة **approved** وبالشروط الحالية مقبولة (غير ذلك 403 `{message}`؛ و`code: 'terms_outdated'` إن نُشرت شروطٌ لم يقبلها)
- `GET /dashboard` ⇒
  ```ts
  { clicks30d: number, signups: number, paidCompanies: number, pendingHalalas: number, approvedHalalas: number, paidHalalas: number,
    adjustmentsHalalas: number /* غير المسوّاة فقط */,
    // v2
    totalEarnedHalalas: number /* approved + paid صافياً */, pendingSettlementHalalas: number /* approved بلا دفعة + في دفعة draft */,
    activeReferrals: number /* إسنادات active */, conversionRate: number|null /* paidCompanies / signups */,
    earningsByMonth: Array<{ month: 'YYYY-MM', halalas: number }> /* آخر ٦ أشهر بتاريخ الدفعة */,
    nextSettlementAt: string, steps: { account: true, shared: boolean /* clicks30d>0 || signups>0 */, firstPaid: boolean } }
  ```
- `GET /companies` ⇒ `Array<{ id: string /*attributionId*/, tenantName: string, source: 'signup_code'|'claim'|'owner'|'portal', activation: 'pending'|'active'|null /*لمصدر portal وحده*/, status: 'trial'|'paid'|'disputed'|'void'|'expired', signedUpAt: string, firstPaymentDeadline: string, firstPaidAt: string|null, commission: { status: CommissionStatus, commissionHalalas: number, eligibleAt: string } | null /* عمولة السفير نفسه فقط */ }>`
- `POST /claims` (الترشيح المسبق) `{ companyName: string /*2..120*/, crNumber: string /*10 أرقام*/, contactPhone: string /*إلزامي: جوال سعودي أو 8–15 رقماً*/, city?: string, how: ClaimHow, note?: string /*≤200*/ }` ⇒ **201** `{ id: string, message: 'استلمنا الترشيح وسيُراجع' }` — يُرفض (400) بريدٌ أو سلسلة أرقامٍ بأيّ فواصل فيها ٨ أرقامٍ فأكثر (عدا التاريخ) في الاسم أو المدينة أو الملاحظة.
- `GET /claims` ⇒ `Array<{ id, companyName, crNumber, contactPhone: string|null, city: string|null, how: ClaimHow, status: ClaimStatus, lockedUntil: string|null, submittedAt: string }>`
- `POST /claims/:id/withdraw` ⇒ `{ ok: true }` (فقط `under_review`، وإلا 409)
- `POST /missed-claims` — **مطالبة بإحالة فائتة** (v2): شركةٌ سجّلت دون رابطك أو رمزك خلال آخر ٣٠ يوماً. جسم `{ companyName: string /*2..120*/, contactPhone?: string, crNumber?: string /*10 أرقام*/, note?: string /*≤200*/ }` ⇒ **201** `{ id }` — الاسم والملاحظة بلا جوالٍ ولا بريد (400 `contact_in_text`) · 400 `invalid_phone` · 400 `invalid_cr` · 409 `open_limit` (٢٠ مطالبةً مفتوحة).
- `GET /missed-claims` ⇒ `Array<{ id, companyName, contactPhone: string|null, crNumber: string|null, note: string|null, status: MissedClaimStatus, reasonNote: string|null, submittedAt: string, reviewedAt: string|null }>`
- `POST /missed-claims/:id/withdraw` ⇒ `{ ok: true }` — ما تحت المراجعة فقط (404 `not_found` · 409 `not_under_review`).
- `GET /materials` ⇒ `Array<{ id, title, category: MaterialCategory, fileName: string|null, mime: string|null, sizeBytes: number|null, url: string|null, textBody: string|null, createdAt: string }>` (بترتيب المالك ثمّ الأحدث)
- `GET /materials/:id/file` ⇒ `{ dataUrl: string }` · 404 لمادّةٍ بلا ملف.
- `POST /trials` — **حسابٌ تجريبي يفتحه السفير لمنشأة** (محدِّدٌ لكلّ سفير: ٢٠ طلباً في الساعة مع إعادة الإرسال) جسم:
  ```ts
  { companyName: string /*2..120*/, countryCode?: string /*حرفان — منه العملة والضريبة*/, adminName: string /*2..80*/,
    adminEmail: string /*≤160 — يُخزَّن صغيراً وهو اسم الدخول*/, adminPhone: string /*'+'+مفتاح الدولة+الرقم ≤30*/,
    crNumber?: string | null /*اختياري — إن كُتب فعشرة أرقام*/, consent: true /*المنشأة طلبت الحساب ووافقت على بريد التفعيل*/, dryRun?: boolean }
  ```
  - ⇒ **202** `{ message: string, dryRun?: true }` **دائماً**: فُتح الحساب، أو حُجب لأنّ المنشأة عميلٌ قائم (بريد مديرٍ أو جوال شركةٍ أو سجلٌّ تجاري مطابق — يراه المالك حدثاً `user/portal_trial_blocked`)، أو فحصٌ جاف (`dryRun`: كلّ البوابات بلا أيّ كتابة). **لا** رابط ولا رمز ولا كلمة مرور ولا معرّف شركة ولا بريد في الردّ أبداً، ولا 409.
  - المدير يُنشأ **بلا كلمة مرور**، ورابط التفعيل (٧ أيام، مرّةً واحدة) يصل **بريد المسؤول وحده** — انظر §4. ولا واتساب قبل أن تفعّل الشركة وتؤكّد جوالها.
  - الإسناد في معاملة الإنشاء نفسها: `source: 'portal'`، `codeUsed`/`refVia` فارغان، ولقطة النسبة والحجز ومهلة الدفعة الأولى من شروط السفير. ترشيحٌ معتمد ساري القفل (أو متحوّل) **لسفيرٍ آخر** بالسجل أو بالاسم المُطبَّع ⇒ `status: 'disputed'` و`flags: ['claim_conflict']` يحسمه المالك. وترشيح السفير نفسه المعتمد بالسجل نفسه يتحوّل `converted`.
  - 400: جوال غير صحيح · سجلٌّ ليس 10 أرقام · رقمٌ أو بريدٌ أو رابط في اسم المنشأة أو المسؤول · `code: 'self_contact'` بريد السفير أو جواله مكان المسؤول. 403 `code: 'portal_trial_disabled'`. 429 `code: 'trial_daily_cap'` (١٠ محاولات في ٢٤ ساعة متحرّكة: ما فُتح + ما حُجب) · `code: 'trial_pending_cap'` (٢٠ حساباً لم تفعّلها شركاتها).
- `POST /trials/:id/resend` (`id` = معرّف الإسناد من «شركاتي») ⇒ `{ message: string }` — رابطٌ جديد إلى **البريد المسجَّل** يُبطل كلّ رابطٍ أقدم. 404 `code: 'not_found'` · 409 `code: 'not_pending'` (فعّلت الشركة) · 409 `code: 'resend_window'` (مضى ٣٠ يوماً على الفتح) · 429 `code: 'resend_limit'` (٥ مرّات) · 429 `code: 'resend_cooldown'` (١٠ دقائق بين إرسالين) · 403 `portal_trial_disabled`.
- `POST /trials/:id/withdraw` ⇒ `{ ok: true }` — سحب حسابٍ فُتح بخطأ قبل تفعيله: الشركة تُوقف، والمدير يُعطَّل ويتحرّر بريده، والجوال يُمسح، والإسناد `void` (لا حذف). 404 `not_found` · 409 `not_pending` · 409 `code: 'has_payment'`. متاحٌ ولو أُطفئ فتح الحسابات.
- `GET /commissions` ⇒ `Array<{ id, tenantName, paymentAmountHalalas, refundedHalalas, commissionHalalas, rateBps, status: CommissionStatus, paymentPaidAt: string, eligibleAt: string, reasonNote: string|null, paidAt: string|null }>`
- `GET /adjustments` ⇒ `Array<{ id, kind: 'clawback_refund'|'correction', amountHalalas: number, note: string|null, createdAt: string, settled: boolean }>`
- `GET /payouts` ⇒ v2: **كلّ** دفعاته عدا الملغاة (`draft` = قيد المعالجة، `recorded` = مدفوعة، `failed` = فشل التحويل) `Array<{ id, status: 'draft'|'recorded'|'failed', commissionsHalalas, adjustmentsHalalas, netHalalas, periodStart: string|null, periodEnd: string|null, transferredAt: string|null, bankReference: string|null, ibanLast4: string, failedReason: string|null }>`

---

## 2) المالك — `BASE/api/affiliate-admin` — لوحة المنصّة عبر `api/client.ts`

كلّها خلف `platformGate`: المالك (SUPER_ADMIN) وموظفو المنصّة بصلاحياتهم (`services/platformAccess.ts` — المفاتيح `affiliates.view|manage|payouts|iban`، لا مفتاح جديد في v2). المفتاح بين قوسين.

- `GET /overview` (view) ⇒
  ```ts
  { affiliates: { approved, suspended, total },            // v2: حُذف pending_review (الانضمام فوريّ)
    newAffiliates7d: number, incompleteProfiles: number /* approved بلا profileCompletedAt */, missedClaimsUnderReview: number,
    claimsUnderReview, attributions: { active, disputed },
    commissions: { pendingHalalas, onHoldHalalas, readyToApprove /*عدد pending تجاوزت eligibleAt*/, approvedUnpaidHalalas, paidHalalas },
    payoutCandidates: number /* المؤهَّلون لدورة التسوية الآن */,
    nextSettlementAt: string, settlementDays: [1, 11, 21], settlementEveryDays: 10,
    lastCycle: { cycleKey: string, payouts: number /*عدا الملغاة*/, totalHalalas: number, ranAt: string|null /*null: لم تُنجز بعد*/ } }
  ```
- `GET /settings` (view) ⇒ `AffiliateSettings` (كل الحقول في المخطّط) · `PUT /settings` (manage) **تشغيليّ فقط** `{ intakeOpen?, disclosureText? /*10..300*/ }` ⇒ الإعدادات. إرسال أيٍّ من **قيم الشروط** بقيمةٍ مختلفة ⇒ 409 `code: 'terms_bound'`.
- **قيم الشروط** (تتغيّر بنشر إصدار فقط): `rateBps 0..10000` · `holdDays 0..365` · `minPayoutHalalas 0..100000000` · `refWindowDays 1..365` · `claimLockDays 1..365` · `firstPaymentWithinDays 1..730`. قواعد كلّ إصدارٍ مدمج من خريطته (v1–v3: 3000/30/10000/90/90/180؛ **v4: 3000/10/5000/90/90/180**).
- `GET /terms` (view) ⇒ `Array<{ version, body, publishedAt, publishedBy, rules: {…القيم الست…} }>` · `POST /terms` (manage) `{ version /*^[\w.-]{3,40}$*/, body /*≥50*/, rules?: {…أيٌّ من الست…} }` ⇒ الإصدار (ويصبح الحالي، وتسري قواعده في المعاملة نفسها). النسبة والحجز ومهلة الدفعة الأولى تُؤخذ لكل إسنادٍ **من إصدار الشروط الذي قبله السفير** وتُخزَّن عليه.
- `GET /affiliates?status=&q=` (view) ⇒ `Array<{ id, fullName, email, phone, city, code, status, statusReason, publicPromoter, mawthooqNo, mawthooqExpiry /*'YYYY-MM-DD' بالرياض*/, createdAt, lastLoginAt, counts: { claims, attributions, commissions }, earnedHalalas /*pending+on_hold+approved+paid*/, paidHalalas, hasPayout: boolean, partnerType: PartnerType|null, companyName: string|null, profileComplete: boolean, missing: ProfileMissing[] }>` (`q` يبحث في الاسم والبريد والرمز والجوال واسم الشركة)
- `GET /affiliates/:id` (view) ⇒ `{ affiliate: (مثل عنصر القائمة + vatNumber, termsVersion, termsAcceptedAt, marketingConsent, payout: {holderName, bankName, ibanLast4, updatedAt}|null, socialLinks: SocialLink[], profileCompletedAt, documents: Array<{ kind: DocKind, mime, sizeBytes, createdAt }> /*أحدثها لكلّ نوع — بياناتٌ وصفية فقط*/), claims: [...], attributions: [...{ activation: 'pending'|'active'|null /*portal وحده*/ }], commissions: [...], adjustments: [...{ settled: boolean /*في دفعة مسجَّلة*/, inDraft: boolean }], payouts: [...{ transferredAt: 'YYYY-MM-DD'|null, cycleKey, periodStart, periodEnd, failedReason, failedAt }], missedClaims: [...], events: AffiliateEvent[] }` (صفوف خام من المخطّط)
- `GET /affiliates/:id/documents/:kind` (**iban**، قراءةٌ حساسة تُسجَّل) ⇒ `{ dataUrl: string }` — المستند مفكوكاً، وكلّ عرضٍ حدث `user/document_viewed` بمنفّذه و`meta.kind` · 400 نوعٌ غير معروف · 404 لم يُرفع.
- `POST /affiliates/:id/suspend {reason}` · `POST /affiliates/:id/reactivate` (manage) — **v2**: موقوف ⇒ مقبول، و**مرفوض (إرثاً) ⇒ مقبول** (لا «قيد المراجعة» بعد اليوم) ⇒ `{ status }` (409 انتقال غير مسموح). `POST /affiliates/:id/approve` · `/reject {reason}` تبقيان **للإرث** `pending_review` وحده — الرفض في v2 = الإيقاف.
- `POST /affiliates/:id/reveal-iban` (iban) ⇒ `{ iban: string, holderName, bankName }` (يُسجَّل حدثاً)
- `GET /claims?status=` (view) ⇒ `Array<{ id, affiliate: {id, fullName, code}, companyName, crNumber, contactPhone: string|null, city, how, note, status, reasonCode, submittedAt, reviewedAt, lockedUntil, tenantId, tenantName: string|null, conflicts: Array<{ claimId, affiliateName, status }> /*ترشيحات أخرى بالسجل نفسه*/, suggestions: Array<{ tenantId, tenantName, match: 'cr'|'name', createdAt }> }>`
- `POST /claims/:id/approve` (manage) ⇒ `{ status: 'approved', lockedUntil }` · 409 إن وُجد ترشيح معتمد ساري بالسجل نفسه
- `POST /claims/:id/reject {reasonCode: ClaimReason}` (manage) ⇒ `{ status: 'rejected' }`
- `POST /claims/:id/link-tenant {tenantId}` (manage) ⇒ `{ attribution: {id, status}, commission: {id, status}|null, commissionCreated: boolean, accrualReason: string|null, conflict: { attributionStatus: string, commissionHeld: boolean } | null }` — الترشيح `approved`، أو `expired` إن سجّلت الشركة داخل قفله. بداية الإسناد = لحظة **تقديم** الترشيح (وتُسحب إليها بداية إسنادٍ قائم للسفير نفسه إن لم تنشأ عمولة). مدّة القفل عند الاعتماد من شروط صاحب الترشيح.
- `GET /missed-claims?status=` (view) ⇒ `Array<{ id, affiliate: {id, fullName, code}, companyName, contactPhone, crNumber, note, status: MissedClaimStatus, reasonNote, submittedAt, reviewedAt, reviewedBy, tenantId, tenantName: string|null, suggestions: Array<{ tenantId, tenantName, match: 'cr'|'phone'|'name', createdAt, attributed: boolean, daysFromSignup: number, withinWindow: boolean /*≤ ٣٠ يوماً*/ }> /*لما تحت المراجعة*/ }>`
- `POST /missed-claims/:id/accept {tenantId, reason /*3..500*/}` (manage) ⇒ `{ status: 'accepted', attribution: {id, status}, commission, commissionCreated, accrualReason }` — إسنادٌ يدويّ (`createOwnerAttribution`، `source: 'owner'`) للشركة إلى صاحب المطالبة **من لحظة تسجيلها**، ثمّ المطالبة `accepted` بالشركة والسبب. 409 `not_under_review` · 409 `claim_late` (قُدّمت بعد ٣٠ يوماً من تسجيل الشركة — الإسناد اليدويّ من تبويب الإسناد يبقى متاحاً) · 409 `exists` (للشركة إسنادٌ قائم — «إعادة إسناد») · 409 السفير ليس مقبولاً. فشل الإسناد يُبقي المطالبة قيد المراجعة.
- `POST /missed-claims/:id/reject {reason}` (manage) ⇒ `{ status: 'rejected' }` · 409 `not_under_review`.
- `GET /attributions?status=` (view) ⇒ `Array<{ id, tenantId, tenantName /*لقطة*/, affiliate: {id, fullName, code}, source, status, activation: 'pending'|'active'|null /*portal وحده*/, flags: Flag[], codeUsed, refVia, reasonNote, effectiveFrom, firstPaymentDeadline, rateBps, createdAt, commission: {id, status, commissionHalalas}|null }>`
- ردود الإسناد كلّها: `{ attribution: {id, status}, commission: {id, status, commissionHalalas}|null, commissionCreated: boolean, accrualReason: string|null }`
- رموز `accrualReason`: `not_paid_or_unlinked` · `zero_amount` · `no_attribution` · `exists` · `not_first_payment` · `outside_window` · `zero_commission` · `no_payment` · `first_payment_reversed` · `earlier_payment_linked` (دفعةٌ أقدم رُبطت بعد نشوء العمولة على لاحقة — أُوقفت القائمة) · `earlier_payment_committed` (القائمة مصروفة أو في مسودّة — تصحيحٌ يدوي) · `earlier_payment_no_commission` (القائمة مستردّة أو مرفوضة) · `error` — و`null` حين كانت للإسناد عمولةٌ قائمة.
- `POST /attributions {tenantId, affiliateId, reason, effectiveFrom?: 'YYYY-MM-DD'}` (manage) · 409 إن كان للشركة **أيّ** إسناد (ولو مُبطلاً) — استعمل «إعادة إسناد»
- `POST /attributions/:id/void {reason}` (manage) — العمولة غير المصروفة تُوقف (إلا إن أوقفها المالك يدوياً فتبقى بسببه) · `POST /attributions/:id/activate {reason}`
- `POST /attributions/:id/reassign {affiliateId, reason, effectiveFrom?: 'YYYY-MM-DD', claimId?}` (manage) — لإسنادٍ `disputed` أو `void` فقط: ينقله للسفير ويُعيد لقطة عمولته غير المصروفة **والمرفوضة** بشروطه (إيقاف المالك اليدويّ يبقى). المصروفة: يُقيَّد تلقائياً سالبٌ على السابق وموجبٌ للجديد بصافيها، ويتحمّل الجديد أيّ استردادٍ لاحق.
- `POST /attributions/:id/window {effectiveFrom: 'YYYY-MM-DD', reason}` (manage) — لإسنادٍ بلا عمولة: تعديل بدايته ثم محاولة الاحتساب
- `GET /commissions?status=` (view) ⇒ `Array<{ id, tenantId, tenantName, affiliate: {id, fullName, code}, paymentLinkId, paymentAmountHalalas, refundedHalalas, coveredMonths, rateBps, commissionHalalas, paymentPaidAt, eligibleAt, status, reasonNote, approvedAt, payoutId, linkStatus: string /*حالة رابط الدفع الآن*/, readyToApprove: boolean }>`
- **الاعتماد التلقائي** (v2): كلّ عمولة `pending` انقضى حجزها تُعتمد آلياً (نبضةٌ كلّ ساعة وفي كلّ دورة) بفحوص الاعتماد اليدويّ نفسها، و`approvedBy = 'system'` وحدثٌ `actorType: 'system'` و`meta.auto: true`. ما لا يجتاز فحصاً يبقى معلّقاً لقرار المالك.
- `POST /commissions/:id/approve` (payouts) — يدويّ اختياري ⇒ `{ status }` · 409 `{message}` مع سبب (`hold_not_over`/`payment_not_paid`/`not_pending`/`attribution_not_active`/`affiliate_not_approved`/`zero_commission`/`earlier_payment`) — وإن لم يعد الرابط مدفوعاً تُعكس العمولة ويُردّ 409.
- `POST /commissions/:id/hold {reason}` · `POST /commissions/:id/release` · `POST /commissions/:id/decline {reason}` (payouts) ⇒ `{ status }` — أيّ قرارٍ يمسّ عمولةً **داخل مسودّة دفعة** ⇒ 409 «ألغِ مسودّة الدفعة أولاً».
- الاسترداد الكامل قبل الالتزام يعكس العمولة، والجزئي يخفّضها بقدره؛ بعد الالتزام (مصروفة **أو داخل مسودّة**) يُقيَّد الفرق سالباً. المصدر `payment_links.refundedHalalas` (تراكميّ من ميسر)، والعمولة تُنشأ عليه أصلاً إن سبقها الاسترداد، والمصالحة تلتقط ما فات الخطاف.
- `GET /payouts/candidates` (view) ⇒ `Array<{ affiliate: {id, fullName, code, email}, commissionsHalalas, adjustmentsHalalas, netHalalas, commissionCount, minPayoutHalalas, eligible: boolean /* blockedBy === null */, blockedBy: PayoutBlock|null, profileComplete: boolean, missing: ProfileMissing[], ibanNeedsUpdate: boolean, hasPayout: boolean, ibanLast4: string|null, holderName: string|null }>` — `iban_failed`: فشل آخر تحويلٍ ولم يحدّث السفير بيانات استلامه بعده (يحجب الدورة الآلية وحدها).
- `POST /payouts {affiliateId}` (payouts) ⇒ الدفعة (`draft`) · 409 بأحد الرموز: `not_approved` · `no_iban` · `profile_incomplete` (v2: الملف المكتمل شرطٌ للصرف) · `has_draft` · `below_min` (الصافي دون الحدّ من شروط السفير). تصحيحٌ موجبٌ وحده (بلا عمولات) يُصرف إن بلغ الحدّ.
- **المسودّة لقطةٌ مجمَّدة**: صافيها لا يتغيّر بعد إنشائها، وما يُستردّ بعدها قيدٌ سالب للدفعة القادمة.
- `GET /payouts?status=` (view) ⇒ `Array<{ id, affiliate: {id, fullName, code}, commissionsHalalas, adjustmentsHalalas, netHalalas, status: PayoutStatus, ibanLast4, holderName, transferredAt: 'YYYY-MM-DD'|null, bankReference, createdAt, voidReason, commissionCount, cycleKey: string|null /*null للدفعة اليدوية*/, periodStart: string|null, periodEnd: string|null, failedReason: string|null, failedAt: string|null, createdBy: string /*'system' لدفعات الدورة*/ }>`
- `POST /payouts/:id/record {bankReference /*3..80*/, transferredAt: 'YYYY-MM-DD'}` (payouts) ⇒ الدفعة (`recorded`) بصافي المسودّة كما جُهِّز — لا يُرفض بسبب استرداد. بريد «حُوِّلت مستحقّاتك» للسفير.
- `POST /payouts/:id/void {reason}` (payouts) ⇒ الدفعة (`void`) — بنودها تعود «معتمدة» بلا دفعة.
- `POST /payouts/:id/fail {reason /*3..300*/}` (payouts) — **فشل التحويل** (v2) ⇒ الدفعة (`failed`، `failedReason`، `failedAt`) — بنودها تُفكّ كالإلغاء وتعود «معتمدة»، وبريد «تعذّر التحويل — تحقّق من بيانات الآيبان» للسفير، وتدخل الدورة التالية تلقائياً بعد تحديثه بيانات الاستلام. 404 · 409 `not_draft`.
- `POST /settlement/run` (payouts) — **تشغيل الدورة الآن** ⇒ `{ cycleKey, periodStart, periodEnd, ran: boolean, reason: 'already_ran'|null, manual: true, autoApproved: number, reconciled: { accrued, synced }, payouts: Array<{ id, affiliateId, netHalalas }>, totalHalalas, skipped: Record<PayoutBlock|'cycle_done'|'error', number>, nextSettlementAt }` — دورة آخر نهايةٍ مرّت بمفتاحها نفسه: آمنةٌ للتكرار (دفعةٌ واحدة لكلّ سفيرٍ في الدورة — `cycle_done`)، وتلتقط من صار مؤهَّلاً بعد مرورها. تنشئ **مسودّات** فقط.
- `POST /adjustments {affiliateId, amountHalalas /*≠0 عدد صحيح*/, note /*≥3*/}` (payouts) ⇒ القيد
- `GET /materials` (view) ⇒ `Array<{ id, title, category, fileName, mime, sizeBytes, url, textBody, createdAt, sortOrder, createdBy }>` · `GET /materials/:id/file` (view) ⇒ `{ dataUrl }`
- `POST /materials` (manage) `{ title /*2..120*/, category: MaterialCategory, dataUrl?: string, fileName?: string, url?: string /*https?:// ≤500*/, textBody?: string /*≤4000*/, sortOrder?: number }` ⇒ **201** المادّة. الصورة والمستند **ملفٌّ** إلزاماً، والفيديو ملفٌّ قصير **أو** رابط، والرابط رابطٌ، والنصّ نصٌّ؛ ونصٌّ مرافقٌ مسموحٌ مع أيّ فئة. الملف data URL **≤ ٨ ميغابايت** بعد الفكّ ونوعه **من بايتاته** (JPEG/PNG/WebP/GIF · MP4/MOV/WebM · PDF — لا SVG ولا HTML) ويطابق الفئة؛ والاسم يُنظَّف وامتداده من النوع المفحوص. 400 بسببٍ عربيّ · 409 `materials_quota` (٢٠٠ مادّة أو ٢٠٠ ميغابايت). ⚠️ حدّ جسم JSON العامّ في `index.ts` ‏10mb (≈ ٧٫٤ ميغابايت ملفاً بعد base64)؛ ما فوقه يُرفض 413 قبل المسار.
- `DELETE /materials/:id` (manage) ⇒ `{ ok: true }` — حذفٌ حقيقيّ (الملف معه).
- `GET /events?entity=&entityId=` (view) ⇒ آخر 200 `Array<{ id, entity, entityId, action, fromState, toState, actorType, actorId, reason, meta, createdAt }>` — أحداث v2 الجديدة: `payout/failed`، `user/document_viewed`، `user/missed_claim_submitted|accepted|rejected|withdrawn` (`meta.missedClaimId`)، `settings/material_created|material_deleted`، `settings/settlement_run`، و`commission/approved` بـ`actorType: 'system'`.
- `GET /tenants/search?q=` (view) ⇒ `Array<{ id, name, commercialReg: string|null, createdAt, attributed: boolean }>` (حدّ 20)

و`POST BASE/api/payments/:id/link-tenant {tenantId}` (SUPER_ADMIN) ⇒ `{ link, commission|null, commissionCreated, accrualReason }` — رابط `paid` بلا شركة فقط.

### دورة التسوية (المجدول)
`startAffiliateSettlementScheduler()` في `index.ts` (مع المجدولات الأخرى بعد الإقلاع): نبضةٌ كلّ ساعة بعد تأخير دقيقتين، `unref`، ومفتاح الإطفاء `AX_SETTLEMENT_ENABLED=0` (يطفئ المجدول وحده؛ زرّ المالك يبقى). في كلّ نبضة: الاعتماد التلقائي، ثمّ `runSettlementCycle(now)` لآخر نهايةٍ مرّت — مرّةً واحدة بعلامة `OpsMarker 'ax-settle:<cycleKey>'` (القيمة `running` ثمّ ملخّص JSON؛ `running` أقدم من ٣٠ دقيقة = نسخةٌ ماتت فتُستأنف): المصالحة ← الاعتماد التلقائي ← لكلّ مرشّحٍ مؤهَّل مسودّة `draft` بـ`cycleKey/periodStart/periodEnd` و`createdBy='system'` ← بريدٌ للمالك بالعدد والمجموع وكلّ دفعة (ومن ينتظر إكمال ملفه أو تحديث آيبانه). ما دون الحدّ الأدنى يبقى معتمداً ويُرحَّل. **المنصّة لا تحرّك مالاً.**

## 3) تسجيل الشركة — `POST BASE/api/auth/signup`
حقول إضافية متسامحة (لا تُفشل التسجيل أبداً): `ref?: string` (≤40)، `refVia?: 'link'|'typed'`، `refAt?: number` (لحظة التقاط الرابط بالملّي ثانية — الخادم يفرض `refWindowDays` على `refVia='link'`). رابط السفير v2 `https://fieldsa.net/signup?ref=CODE` يُلتقط كأيّ `?ref=`.
بريدٌ لحسابٍ **فتحه سفيرٌ ولم يُفعَّل** (بأيّ حالة أحرف) ⇒ 409 «هذا البريد له حساب بانتظار التفعيل — أرسلنا لك رابط التفعيل مجدداً، افحص بريدك»، ويُعاد رابط التفعيل إلى البريد المخزَّن (مرّةً كلّ ١٠ دقائق على الأكثر، و٥ مرّاتٍ لكلّ حساب) — لا حساب ثانٍ. ورسالة الحساب النشط كما هي.

## 4) تفعيل حساب شركةٍ فتحه سفير — `BASE/api/auth` (عام، `authLimiter`)
الرابط في بريد المسؤول وحده: `https://fieldsa.net/activate#t=<token>` — الرمز في **المقطع** فلا يصل الخادم ولا السجلّات ولا Referer، والصفحة ترسله في الجسم. سرٌّ مشتقّ (`COMPANY_ACTIVATION_SECRET` أو `JWT_SECRET::company-activate`) وحمولة `{ aid, purpose: 'company-activate', fp }` بلا `id/role/tenantId` — لا يصلح جلسةً في أيّ مكان. صالحٌ ٧ أيام ومرّةً واحدة، وإعادة الإرسال تُبطل الأقدم. السفير لا يراه أبداً.
- `POST /api/auth/activation/preview` `{ token }` ⇒ `{ state: 'ready', companyName: string, adminName: string, email: string /*اسم الدخول كما خُزِّن*/, phoneMasked: string|null /*تلميحٌ مُقنَّع لما كتبه السفير — لا يُبقى صامتاً*/, countryCode: string|null, openedBy: string|null /*اسم السفير لمصدر portal*/, trialDays: number }` · `{ state: 'already_active' }` · `{ state: 'superseded' }` (أُرسل رابطٌ أحدث) · `{ state: 'locked' }` (أوقفه تكرار `phone_taken` — يُطلب رابطٌ جديد) · 400 `code: 'invalid'` (غير صالح أو منتهٍ أو حسابٌ مسحوب).
- `POST /api/auth/activate` `{ token, password /*8..128*/, acceptTerms: true, phone: string /*مطلوب: تكتبه الشركة كاملاً — بمطبِّع جوال البوابة نفسه (سعوديٌّ 05… أو دوليٌّ بمفتاحه)*/ }` ⇒ `{ token: string, user }` بشكل `POST /login` نفسه و`emailVerified: true`. التجربة تبدأ الآن (`subscriptionEndsAt = max(الحالي، الآن + 10 أيام)` — لا يُقصَّر تاريخٌ مدفوع)، ثمّ ترحيب واتساب للجوال الذي كتبته الشركة وبريدٌ للمالك وللسفير. 400 `code: 'invalid'` · 400 `invalid_phone` · 409 `already_active` · 409 `superseded` · 409 `phone_taken` (الجوال مربوطٌ بشركةٍ فعّالة أخرى، يُفحص في كلّ تفعيل ولو أُعيد الرقم كما كتبه السفير — والمنتظر تفعيلها لا يحجب؛ كلّ رفضٍ حدث `activation_phone_taken` على الإسناد) · 409 `link_locked` (بلغ الرفض ٣ لهذا الرابط فدُوِّر الحارس «موقوفاً» — يُطلب رابطٌ جديد ويبدأ عدّاً جديداً) · 403 `tenant_inactive`.
- بعدها يدخل المسؤول بـ`POST /login` بالبريد المخزَّن (صغيراً، المعروض في صفحة التفعيل) وكلمة مروره. وبدائل المالك قائمة: الانتحال، و`POST /api/tenants/:id/reset-admin` (يستبدل الحارس فيُعدّ مفعّلاً، والروابط القديمة تقول `already_active`).

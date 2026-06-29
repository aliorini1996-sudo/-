# 🔗 تسويق FieldSales على LinkedIn (صفحة الشركة · مجاني)

ينشر **يوميًا 11ص** منشورًا احترافيًا + بطاقة بهويتك على **صفحة شركة FieldSales** — تلقائيًا عبر GitHub Actions، **مجانًا** (LinkedIn API لا يفرض رسومًا على النشر).

**الملفات:** [`marketing/linkedin_post.py`](linkedin_post.py) · [`.github/workflows/linkedin.yml`](../.github/workflows/linkedin.yml)
**يعيد استخدام** نفس البطاقة بهويتك ونفس بنك المواضيع من سكربت X.

---

## ✅ المتطلبات
1. **صفحة شركة FieldSales على LinkedIn** وأنت **مشرف (Admin)** عليها. (إن لم تكن موجودة، أنشئها أولًا من LinkedIn.)
2. حساب على [developer.linkedin.com](https://developer.linkedin.com).

---

## 1️⃣ أنشئ تطبيق LinkedIn واربطه بالصفحة
1. [developer.linkedin.com/apps](https://www.linkedin.com/developers/apps) → **Create app**.
2. **App name:** FieldSales Marketing · **LinkedIn Page:** اختر صفحة شركتك (مهم — يربط التطبيق بالصفحة).
3. ارفع شعارًا ووافق → **Create app**.
4. تبويب **Settings** → **Verify** التطبيق مع الصفحة (زر Verify → يولّد رابطًا تؤكّده كمشرف صفحة).

## 2️⃣ فعّل صلاحية النشر باسم الشركة
1. تبويب **Products** → اطلب **«Community Management API»** (يمنح صلاحية `w_organization_social` للنشر باسم الصفحة).
   - قد يُمنح فورًا لمشرف صفحة مُتحقَّق، وقد يتطلّب مراجعة قصيرة من LinkedIn.
2. *(عادةً)* فعّل أيضًا **«Sign In with LinkedIn using OpenID Connect»** (لتسهيل توليد الرمز).

## 3️⃣ احصل على معرّف الصفحة `LINKEDIN_ORG_ID`
- افتح صفحة شركتك → **Admin view** → الرقم في الرابط: `linkedin.com/company/**XXXXXXX**/admin` → هذا الرقم هو `LINKEDIN_ORG_ID`.
  *(أو من تبويب التطبيق، أو عبر API.)*

## 4️⃣ ولّد رمز الوصول `LINKEDIN_ACCESS_TOKEN`
1. في تطبيقك → تبويب **Auth** → اقسم **OAuth 2.0 tools** → **Create token** (أو «Token Generator»).
2. اختر الصلاحية **`w_organization_social`** (وإن ظهرت `r_organization_social` أو `openid profile` فلا بأس بإضافتها).
3. سجّل دخول ووافق → **انسخ الرمز** (Access Token).
   - ⚠️ صالح **~60 يومًا**. (انظر «التجديد» أسفل.)

## 5️⃣ أضِف السرّين في GitHub
في مستودعك: **Settings → Secrets and variables → Actions → New repository secret**:

| الاسم | القيمة |
|---|---|
| `LINKEDIN_ACCESS_TOKEN` | الرمز من الخطوة 4 |
| `LINKEDIN_ORG_ID` | رقم الصفحة من الخطوة 3 |

> `ANTHROPIC_API_KEY` موجود مسبقًا (نفس مفتاح X) — لا حاجة لإعادته.

## 6️⃣ اختبر
**Actions → «FieldSales — تسويق LinkedIn اليومي» → Run workflow** → راقب السجل → تحقّق من المنشور على صفحة الشركة.
- ✅ نجاح = نُشر منشور + بطاقة.
- ❌ خطأ = انسخ آخر سطور السجل (بلا الرمز).

---

## ⏳ تجديد الرمز (كل ~60 يومًا)
رمز LinkedIn ينتهي بعد ~60 يومًا. عندها:
- كرّر **الخطوة 4** (Create token) → حدّث `LINKEDIN_ACCESS_TOKEN` في GitHub.
- *(لاحقًا يمكن أتمتة التجديد عبر refresh token إن فعّلناه — أخبرني.)*

## 🛠️ حلّ المشكلات
| المشكلة | الحل |
|---|---|
| **403 / ACCESS_DENIED** | صلاحية `w_organization_social` غير مفعّلة، أو لست مشرف الصفحة، أو Community Management API لم يُعتمد بعد. |
| **401 / Unauthorized** | الرمز منتهٍ → ولّد رمزًا جديدًا. |
| **رفع الصورة فشل** | السكربت **ينشر نصًا تلقائيًا** (لا يتعطّل). |
| **`LINKEDIN_ORG_ID` خاطئ** | تأكّد أنه رقم الصفحة فقط (أو `urn:li:organization:RECID`). |

## 🔒 ملاحظات
- **لا أتمتة متصفّح ولا كلمة مرور** — فقط الـAPI الرسمي الآمن.
- **ميزات حقيقية فقط** في بنك المواضيع.
- النشر مجاني تمامًا على LinkedIn (لا رسوم لكل منشور مثل X).

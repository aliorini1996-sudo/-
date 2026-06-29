# 📘 تسويق FieldSales على فيسبوك (مجاني · GitHub Actions)

ينشر **يوميًا** منشورًا عربيًا + بطاقة بهوية FieldSales على **صفحة شركتك في فيسبوك**، تلقائيًا.

`اختيار ميزة حقيقية → Claude يكتب المنشور → بطاقة FieldSales (تُرسم بالكود) → نشر على صفحة فيسبوك`

- المنطق: [`marketing/facebook_post.py`](facebook_post.py) · الجدولة: [`.github/workflows/facebook.yml`](../.github/workflows/facebook.yml) (يوميًا 8م السعودية).
- **مجاني تمامًا:** Graph API للنشر على صفحتك مجاني · البطاقة تُرسم بالكود · Claude ~سنتات/شهر.

---

## ✅ المتطلبات
1. **صفحة فيسبوك** أنت مشرفها (Admin).
2. **تطبيق فيسبوك للمطوّرين** (مجاني) من [developers.facebook.com](https://developers.facebook.com).

ستضيف **سرّين** في GitHub: `FB_PAGE_ID` و`FB_PAGE_ACCESS_TOKEN`. *(`ANTHROPIC_API_KEY` مضاف مسبقًا.)*

---

## 1️⃣ أنشئ تطبيق فيسبوك
1. [developers.facebook.com](https://developers.facebook.com) → **My Apps** → **Create App**.
2. النوع: **Business** → سمّه `FieldSales Marketing` → Create.
3. من **App settings → Basic** انسخ **App ID** و**App Secret** (مؤقتًا، لتوليد الرمز).

## 2️⃣ ولّد رمز المستخدم بالصلاحيات
1. افتح **Graph API Explorer**: [developers.facebook.com/tools/explorer](https://developers.facebook.com/tools/explorer).
2. أعلى يمين: اختر تطبيقك **FieldSales Marketing**.
3. **Add a Permission** فعّل: `pages_show_list` · `pages_read_engagement` · `pages_manage_posts`.
4. **Generate Access Token** → وافِق على الصلاحيات (سجّل دخول حسابك الذي يدير الصفحة).
5. انسخ الرمز المؤقّت الظاهر (User Token قصير العمر).

## 3️⃣ حوّله إلى رمز صفحة دائم (لا ينتهي)
1. **رمز مستخدم طويل العمر:** في المتصفّح افتح (استبدل القيم):
   ```
   https://graph.facebook.com/v21.0/oauth/access_token?grant_type=fb_exchange_token&client_id=APP_ID&client_secret=APP_SECRET&fb_exchange_token=SHORT_USER_TOKEN
   ```
   انسخ `access_token` من الرد (= رمز مستخدم طويل العمر).
2. **رموز الصفحات + معرّفها:** افتح:
   ```
   https://graph.facebook.com/v21.0/me/accounts?access_token=LONG_USER_TOKEN
   ```
   ستجد صفحتك مع:
   - `id` → هذا **`FB_PAGE_ID`**
   - `access_token` → هذا **`FB_PAGE_ACCESS_TOKEN`** (رمز صفحة **دائم لا ينتهي** 🎉)

## 4️⃣ أضِف السرّين في GitHub
**Settings → Secrets and variables → Actions → New repository secret** (مرّتين):
| Name | Secret |
|---|---|
| `FB_PAGE_ID` | معرّف الصفحة (id) |
| `FB_PAGE_ACCESS_TOKEN` | رمز الصفحة (access_token) |

## 5️⃣ اختبر
**Actions → «FieldSales — تسويق فيسبوك اليومي» → Run workflow** → تابع → تحقّق من صفحتك.

---

## 🛠️ ملاحظات
- رمز الصفحة المُستخرَج من رمز مستخدم طويل العمر **لا ينتهي** عادةً — أفضل من X وLinkedIn.
- إن منع نشر الصورة، **يَنشر السكربت نصًا تلقائيًا** (لا يتعطّل).
- النشر على **صفحتك التي تديرها** يعمل في وضع التطوير دون مراجعة تطبيق كاملة.
- **ميزات حقيقية فقط** — البنك في `post.py`.

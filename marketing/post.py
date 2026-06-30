#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
تسويق FieldSales على X — يعمل يوميًا عبر GitHub Actions (مجاني).
ثنائي اللغة: كل منشور إمّا عربي بالكامل (بطاقة + تغريدة) أو إنجليزي بالكامل — لغة البطاقة = لغة التغريدة.
المسار: اختيار ميزة + لغة → Claude يكتب التغريدة بنفس اللغة → تُركّب بطاقة بهوية FieldSales
وتُصوَّر إلى PNG (16:9) عبر متصفّح headless → تُنشر على X. لا ذكاء اصطناعي للصور (مطابقة للهوية).
"""
import os
import sys
import random

import requests
import tweepy
from playwright.sync_api import sync_playwright

# نسبة اللغات: عربي:إنجليزي (الجمهور سعودي). غيّرها كما تشاء، أو اضبط POST_LANG=ar/en لفرض لغة.
LANG_WEIGHTS = {"ar": 3, "en": 1}

# ------------------------------ الهوية ------------------------------ #
CORAL, INK, CREAM, GRAY, LCORAL = "#E15A30", "#1F1A13", "#FAF7F0", "#6E6557", "#FBEBE2"
ACCENTS = {"coral": ("#E15A30", "#FBEBE2"), "green": ("#1E7A52", "#E4F1EA"), "amber": ("#E0A02C", "#FBF0D8")}

IC = {
    "invoice": '<path d="M6 2h9l4 4v16H6z"/><path d="M14 2v5h5"/><rect x="9" y="12" width="6" height="6" rx="1"/>',
    "coins": '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>',
    "van": '<path d="M2 5h11v10H2z"/><path d="M13 8h4l3 3v4h-7z"/><circle cx="6" cy="17.5" r="1.6"/><circle cx="17" cy="17.5" r="1.6"/>',
    "pin": '<path d="M12 21s7-6 7-11a7 7 0 1 0-14 0c0 5 7 11 7 11z"/><circle cx="12" cy="10" r="2.6"/>',
    "shield": '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><circle cx="12" cy="9.5" r="2"/><path d="M8.5 16a3.5 3.5 0 0 1 7 0"/>',
    "chart": '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    "users": '<circle cx="9" cy="8" r="3.4"/><path d="M3 20a6 6 0 0 1 12 0"/><path d="M16 5a3.4 3.4 0 0 1 0 7M22 20a6 6 0 0 0-5-5.9"/>',
    "clipboard": '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4.5V3h6v1.5"/><path d="M8 10h8M8 14h8M8 18h5"/>',
    "box": '<path d="M21 16V8l-9-5-9 5v8l9 5z"/><path d="M3.3 7L12 12l8.7-5M12 22V12"/>',
    "receipt": '<path d="M6 2h12v20l-3-2-3 2-3-2-3 2z"/><path d="M9 7h6M9 11h6M9 15h4"/>',
    "sync": '<path d="M21 12a9 9 0 0 1-14 7.5"/><path d="M3 12a9 9 0 0 1 14-7.5"/><path d="M21 4v5h-5M3 20v-5h5"/>',
    "team": '<circle cx="12" cy="7" r="3"/><path d="M5 21a7 7 0 0 1 14 0"/>',
    "printer": '<path d="M6 9V3h12v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M6 14h12v7H6z"/>',
    "star": '<path d="M12 2l2.6 6.3L21 9l-5 4.4L17.5 21 12 17.2 6.5 21 8 13.4 3 9l6.4-.7z"/>',
    "gift": '<rect x="3" y="8" width="18" height="13" rx="1"/><path d="M3 12h18M12 8v13"/><path d="M12 8S9.5 3 7.5 4.5 9 8 12 8zM12 8s2.5-5 4.5-3.5S15 8 12 8z"/>',
}

# بنك المواضيع — ميزات حقيقية فقط، بنسختين عربية/إنجليزية
TOPICS = [
    {"icon": "invoice", "accent": "amber",
     "eyebrow": "الفوترة الإلكترونية ZATCA", "title": "فاتورة ضريبية برمز QR من الميدان", "benefit": "أصدر فاتورة متوافقة مع هيئة الزكاة والضريبة برمز QR وأرسلها للعميل واطبعها حراريًا — مباشرةً من جوال المندوب.", "pain": "الفواتير اليدوية ومخالفات هيئة الزكاة والضريبة",
     "eyebrow_en": "ZATCA E-Invoicing", "title_en": "ZATCA-compliant QR invoices from the field", "benefit_en": "Issue tax invoices with a QR code, send them to the customer and print thermally — straight from the rep's phone.", "pain_en": "manual invoices and ZATCA compliance fines"},
    {"icon": "coins", "accent": "green",
     "eyebrow": "التحصيل والذمم", "title": "تحصيل أوضح وديون أقل", "benefit": "سند قبض رقمي لكل دفعة وكشف حساب لحظي لكل عميل — لا مبالغ بلا أثر ولا ديون متعثّرة.", "pain": "ضياع التحصيل وتراكم الديون المتعثرة",
     "eyebrow_en": "Collections & Receivables", "title_en": "Clearer collections, fewer bad debts", "benefit_en": "A digital receipt for every payment and a live statement per customer — no untracked cash, no overdue debt.", "pain_en": "lost collections and mounting bad debt"},
    {"icon": "van", "accent": "coral",
     "eyebrow": "مخزون السيارة · Van Sales", "title": "اعرف ما في كل سيارة لحظيًا", "benefit": "سجّل ما حُمّل في سيارة المندوب، فينقص تلقائيًا مع كل بيع، وتابع المتبقّي والحركة بلا عجز ولا فروقات.", "pain": "عجز وفروقات في بضاعة سيارات المناديب",
     "eyebrow_en": "Van Sales", "title_en": "Know what's in every van, live", "benefit_en": "Log what's loaded in each van; it drops automatically with every sale, so you track stock with no shortages.", "pain_en": "stock shortages and discrepancies in vans"},
    {"icon": "pin", "accent": "green",
     "eyebrow": "التتبّع عبر GPS", "title": "تابع مناديبك على الخريطة", "benefit": "مواقع حيّة وخطوط سير لكل مندوب خلال يومه — تحسّن التغطية وتقلّل الوقت الضائع.", "pain": "غياب الرؤية عن حركة الفريق الميداني",
     "eyebrow_en": "GPS Tracking", "title_en": "Track your reps on the map", "benefit_en": "Live locations and daily routes for each rep — improve coverage and cut wasted time.", "pain_en": "no visibility over the field team"},
    {"icon": "shield", "accent": "coral",
     "eyebrow": "صلاحيات المناديب", "title": "تحكّم دقيق بكل مندوب", "benefit": "اضبط الخصم والبيع بأقل من السعر وإضافة العملاء لكل مندوب — فتحمي هوامشك من التلاعب.", "pain": "تلاعب بالخصومات والبيع بأقل من السعر",
     "eyebrow_en": "Rep Permissions", "title_en": "Precise control over every rep", "benefit_en": "Set discounts, below-price selling and customer creation per rep — protecting your margins from misuse.", "pain_en": "discount abuse and below-price selling"},
    {"icon": "chart", "accent": "amber",
     "eyebrow": "التقارير اللحظية", "title": "قرارات بالأرقام لا بالتخمين", "benefit": "مبيعات اليوم والتحصيل وأداء كل مندوب على لوحة واحدة بضغطة زر.", "pain": "قرارات بالتخمين لا بالبيانات",
     "eyebrow_en": "Live Reports", "title_en": "Decisions by numbers, not guesswork", "benefit_en": "Today's sales, collections and every rep's performance on one dashboard, instantly.", "pain_en": "decisions made on guesses, not data"},
    {"icon": "users", "accent": "coral",
     "eyebrow": "إدارة العملاء", "title": "حدود ائتمان وتنبيهات ذكية", "benefit": "حدّ ائتمان لكل عميل وكشف حساب يُحدَّث تلقائيًا، مع تنبيه فوري عند تجاوز الحدّ.", "pain": "تجاوز العملاء حدود ائتمانهم دون تنبيه",
     "eyebrow_en": "Customer Management", "title_en": "Smart credit limits and alerts", "benefit_en": "A credit limit per customer and an auto-updated statement, with an instant alert when the limit is exceeded.", "pain_en": "customers exceeding credit limits unnoticed"},
    {"icon": "clipboard", "accent": "green",
     "eyebrow": "الطلبات الميدانية", "title": "الطلب يصل للإدارة فورًا", "benefit": "ينشئ المندوب الطلب من جواله مع الكتالوج والأسعار، فيصل لحظيًا للإدارة والمستودع.", "pain": "بطء وصول الطلبات للإدارة والمستودع",
     "eyebrow_en": "Field Orders", "title_en": "Orders reach the office instantly", "benefit_en": "The rep creates an order from their phone with the catalog and prices — it reaches the office and warehouse live.", "pain_en": "slow order flow to office and warehouse"},
    {"icon": "box", "accent": "amber",
     "eyebrow": "كتالوج المنتجات", "title": "أسعار دقيقة لكل عميل", "benefit": "كتالوج موحّد بأسعار متدرّجة حسب الكمية وأسعار خاصة لكل عميل، يصل للميدان لحظيًا.", "pain": "أخطاء التسعير اليدوي",
     "eyebrow_en": "Product Catalog", "title_en": "Accurate pricing for every customer", "benefit_en": "A unified catalog with quantity-tiered and customer-specific prices, reaching the field in real time.", "pain_en": "manual pricing errors"},
    {"icon": "receipt", "accent": "green",
     "eyebrow": "سندات القبض", "title": "كل ريال محصّل موثّق", "benefit": "سند قبض رقمي يُرسل للعميل ويُخصم من رصيده تلقائيًا — شفافية كاملة في التحصيل.", "pain": "مبالغ محصّلة بلا أثر موثّق",
     "eyebrow_en": "Receipt Vouchers", "title_en": "Every payment, documented", "benefit_en": "A digital receipt sent to the customer and deducted from their balance automatically — full collection transparency.", "pain_en": "collected cash with no documented trail"},
    {"icon": "sync", "accent": "coral",
     "eyebrow": "التكامل مع ERP", "title": "بلا إدخال مزدوج", "benefit": "زامن عملاءك ومنتجاتك وفواتيرك وسنداتك مع نظام ERP لديك عبر اتصال آمن.", "pain": "إدخال مزدوج بين الميدان والمحاسبة",
     "eyebrow_en": "ERP Integration", "title_en": "No double data entry", "benefit_en": "Sync your customers, products, invoices and receipts with your ERP over a secure connection.", "pain_en": "double entry between field and accounting"},
    {"icon": "team", "accent": "amber",
     "eyebrow": "فريق الشركة والصلاحيات", "title": "كل دور يرى ما يخصّه", "benefit": "أضف مديرًا ومشرفًا ومحاسبًا بصلاحيات دقيقة لكل قسم — لا وصول مفتوح للجميع.", "pain": "وصول الجميع لكل شيء",
     "eyebrow_en": "Team & Permissions", "title_en": "Each role sees only its part", "benefit_en": "Add managers, supervisors and accountants with precise per-section permissions — no open access for all.", "pain_en": "everyone having access to everything"},
    {"icon": "printer", "accent": "coral",
     "eyebrow": "الطباعة الحرارية", "title": "اطبع فواتيرك من الميدان", "benefit": "طباعة فورية للفواتير والسندات من طابعة حرارية 58مم بلوتوث — بلا أجهزة مكلفة.", "pain": "الحاجة لأجهزة خاصة ومكلفة",
     "eyebrow_en": "Thermal Printing", "title_en": "Print invoices from the field", "benefit_en": "Instantly print invoices and receipts from a 58mm Bluetooth thermal printer — no costly hardware.", "pain_en": "needing special, costly hardware"},
    {"icon": "star", "accent": "green",
     "eyebrow": "منصّة سعودية", "title": "مصمّمة لشركات التوزيع السعودية", "benefit": "دعم عربي كامل وتوافق محلي — لا أنظمة أجنبية لا تناسب سوقك.", "pain": "أنظمة أجنبية لا تناسب السوق المحلي",
     "eyebrow_en": "Saudi Platform", "title_en": "Built for Saudi distribution companies", "benefit_en": "Full Arabic support and local compliance — no foreign systems that don't fit your market.", "pain_en": "foreign systems that don't fit the local market"},
    {"icon": "gift", "accent": "coral",
     "eyebrow": "التجربة المجانية", "title": "جرّب كل المميزات ١٠ أيام مجانًا", "benefit": "ابدأ اليوم بلا بطاقة ائتمان، وجهّز شركتك ومناديبك خلال دقائق.", "pain": "الخوف من الالتزام قبل التجربة",
     "eyebrow_en": "Free Trial", "title_en": "Try every feature free for 10 days", "benefit_en": "Start today with no credit card, and set up your company and reps in minutes.", "pain_en": "fear of committing before trying"},
]


def env(name: str) -> str:
    v = os.environ.get(name, "").strip()
    if not v:
        sys.exit(f"❌ سرّ مفقود: {name} (أضِفه في GitHub Secrets)")
    return v


def pick_lang() -> str:
    forced = os.environ.get("POST_LANG", "").strip().lower()
    if forced in ("ar", "en"):
        return forced
    langs = list(LANG_WEIGHTS.keys())
    return random.choices(langs, weights=[LANG_WEIGHTS[l] for l in langs])[0]


# ------------------------------ النص (Claude) ------------------------------ #
def ask_claude(topic: dict, lang: str) -> str:
    if lang == "en":
        system = (
            "You are a professional marketing copywriter for \"Field Sales\" (fieldsa.net), a Saudi "
            "field-sales management system for distribution reps.\n"
            "Write ONE short, punchy English marketing tweet (under 270 characters incl. hashtags) that "
            "highlights the feature and solves a real pain.\n"
            "Rules: real features only, no fabrication; confident professional tone, no hype; a soft CTA + the "
            "link fieldsa.net; mention \"10-day free trial\" when fitting.\n"
            "The tweet MUST end with 4-6 strong, relevant hashtags (mix broad discovery tags with niche ones) to "
            "maximize reach — pick the best fit from: #FieldSales #SalesTech #SalesAutomation #Distribution "
            "#FieldService #VanSales #SaaS #B2B #CRM #RetailTech #SupplyChain #SaudiArabia #KSA #Vision2030 #ZATCA "
            "#eInvoicing — while keeping the whole tweet under 270 characters.\n"
            "Return only the tweet text, no preamble or quotes."
        )
        user = f"Feature: {topic['title_en']}\nBenefit: {topic['benefit_en']}\nCustomer pain: {topic['pain_en']}\nWrite the tweet now."
    else:
        system = (
            "أنت كاتب محتوى تسويقي محترف لمنصّة \"Field Sales\" (فيلد سيلز) — نظام سعودي لإدارة مبيعات "
            "مناديب التوزيع الميدانيين، موقعه fieldsa.net.\n"
            "اكتب تغريدة عربية واحدة قصيرة وجذّابة (أقل من 270 حرفًا شاملة الهاشتاقات) تبرز الميزة وتحلّ ألمًا حقيقيًا.\n"
            "قواعد: ميزات حقيقية فقط بلا اختلاق؛ نبرة احترافية بلا مبالغة؛ دعوة لفعل ناعمة + الرابط fieldsa.net؛ "
            "اذكر \"تجربة مجانية 10 أيام\" عند المناسبة.\n"
            "يجب أن تنتهي التغريدة بـ4–6 هاشتاقات قوية وذات صلة (مزيج بين الواسع للاكتشاف والمتخصّص) لتحقيق أعلى وصول — "
            "اختر الأنسب من: #المبيعات #المبيعات_الميدانية #التوزيع #مناديب_المبيعات #فان_سيل #فواتير_ZATCA "
            "#الفوترة_الإلكترونية #السعودية #رؤية_2030 #التحول_الرقمي #ريادة_الأعمال #FieldSales #SalesTech — "
            "مع الالتزام بحدّ 270 حرفًا.\n"
            "أعِد نصّ التغريدة فقط، دون أي مقدّمات أو علامات اقتباس."
        )
        user = f"الميزة: {topic['title']}\nالفائدة: {topic['benefit']}\nألم العميل: {topic['pain']}\nاكتب التغريدة الآن."

    r = requests.post(
        "https://api.anthropic.com/v1/messages",
        headers={"x-api-key": env("ANTHROPIC_API_KEY"), "anthropic-version": "2023-06-01", "content-type": "application/json"},
        json={"model": "claude-haiku-4-5", "max_tokens": 500, "system": system, "messages": [{"role": "user", "content": user}]},
        timeout=60,
    )
    if not r.ok:
        sys.exit(f"❌ خطأ Claude API {r.status_code}: {r.text[:600]}")
    return r.json()["content"][0]["text"].strip().strip('"').strip()[:277]


# ------------------------------ البطاقة (بهوية FieldSales) ------------------------------ #
LOGO_SVG = (
    '<svg width="60" height="60" viewBox="0 0 120 120"><rect width="120" height="120" rx="28" fill="#E15A30"/>'
    '<polyline points="32,88 60,60 90,32" stroke="#1F1A13" stroke-width="13" stroke-linecap="round" stroke-linejoin="round" fill="none"/>'
    '<circle cx="32" cy="88" r="8" fill="#FAF7F0"/><circle cx="60" cy="60" r="6" fill="#FAF7F0"/>'
    '<circle cx="90" cy="32" r="12" fill="#1F1A13"/><circle cx="90" cy="32" r="5.5" fill="#FAF7F0"/></svg>'
)


def build_card_html(topic: dict, lang: str) -> str:
    ar = lang == "ar"
    stroke, tint = ACCENTS[topic["accent"]]
    eyebrow = topic["eyebrow"] if ar else topic["eyebrow_en"]
    title = topic["title"] if ar else topic["title_en"]
    benefit = topic["benefit"] if ar else topic["benefit_en"]
    cta = "ابدأ تجربتك المجانية ١٠ أيام" if ar else "Start your free 10-day trial"
    cta_sub = "بدون بطاقة ائتمان" if ar else "No credit card"
    direction = "rtl" if ar else "ltr"
    body_font = "'IBM Plex Sans Arabic'" if ar else "'IBM Plex Sans'"
    title_size = 58 if ar else 54
    cta_side = "right" if ar else "left"
    icon = (
        f'<svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="{stroke}" '
        f'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">{IC[topic["icon"]]}</svg>'
    )
    return f"""<!doctype html><html dir="{direction}" lang="{lang}"><head><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Serif:wght@600&display=swap" rel="stylesheet">
<style>*{{margin:0;padding:0;box-sizing:border-box}}html,body{{width:1200px;height:675px}}
body{{font-family:{body_font},sans-serif;background:{CREAM}}}</style></head><body>
<div style="position:relative;width:1200px;height:675px;overflow:hidden;padding:64px 72px;background:{CREAM}">
  <div style="position:absolute;top:-180px;right:-120px;width:520px;height:520px;border-radius:50%;background:radial-gradient(circle,rgba(225,90,48,.13),transparent 65%)"></div>
  <div style="position:absolute;bottom:-160px;left:-120px;width:460px;height:460px;border-radius:50%;background:radial-gradient(circle,rgba(30,122,82,.10),transparent 65%)"></div>
  <div style="position:relative;display:flex;align-items:center;justify-content:space-between">
    <div style="display:flex;align-items:center;gap:16px">{LOGO_SVG}
      <span style="font-family:'IBM Plex Serif',serif;font-size:30px;font-weight:600;letter-spacing:-.3px"><span style="color:{INK}">Field</span> <span style="color:{CORAL}">Sales</span></span>
    </div>
    <span style="background:{LCORAL};color:#C94E28;font-size:20px;font-weight:600;padding:10px 20px;border-radius:30px;font-family:'IBM Plex Sans',sans-serif">fieldsa.net</span>
  </div>
  <div style="position:relative;display:flex;align-items:center;gap:40px;margin-top:70px">
    <span style="flex-shrink:0;width:128px;height:128px;border-radius:30px;background:{tint};display:flex;align-items:center;justify-content:center">{icon}</span>
    <div>
      <div style="color:{CORAL};font-size:22px;font-weight:600;margin-bottom:10px">{eyebrow}</div>
      <h1 style="color:{INK};font-size:{title_size}px;font-weight:700;line-height:1.18;letter-spacing:-1px">{title}</h1>
    </div>
  </div>
  <p style="position:relative;color:{GRAY};font-size:28px;line-height:1.5;margin-top:28px;max-width:1000px">{benefit}</p>
  <div style="position:absolute;bottom:60px;{cta_side}:72px;display:flex;align-items:center;gap:20px">
    <span style="background:{CORAL};color:#fff;font-size:25px;font-weight:600;padding:16px 34px;border-radius:14px">{cta}</span>
    <span style="color:#9A8F7E;font-size:21px">{cta_sub}</span>
  </div>
</div></body></html>"""


def render_card_png(html: str, path: str) -> str:
    """يصوّر البطاقة إلى PNG بمقاس X القياسي 16:9 عالي الدقّة (1200×675 ×2 = 2400×1350)."""
    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--no-sandbox"])
        page = browser.new_page(viewport={"width": 1200, "height": 675}, device_scale_factor=2)
        page.set_content(html, wait_until="networkidle")
        page.wait_for_timeout(500)
        page.screenshot(path=path, type="jpeg", quality=92)
        browser.close()
    return path


# ------------------------------ النشر على X ------------------------------ #
def post_to_x(tweet: str, image_path: str):
    ck, cs = env("X_API_KEY"), env("X_API_SECRET")
    at, ats = env("X_ACCESS_TOKEN"), env("X_ACCESS_SECRET")
    media_ids = None
    if image_path:
        try:
            api_v1 = tweepy.API(tweepy.OAuth1UserHandler(ck, cs, at, ats))
            media_ids = [api_v1.media_upload(image_path).media_id]
            print("uploaded card to X")
        except Exception as e:  # noqa: BLE001
            print(f"media upload failed, posting text-only: {e}")
    client = tweepy.Client(consumer_key=ck, consumer_secret=cs, access_token=at, access_token_secret=ats)
    res = client.create_tweet(text=tweet, media_ids=media_ids)
    print(f"posted (id={res.data.get('id') if res and res.data else '?'}):\n{tweet}")


def main():
    lang = pick_lang()
    topic = random.choice(TOPICS)
    title = topic["title"] if lang == "ar" else topic["title_en"]
    print(f"lang={lang} | topic: {title}")
    tweet = ask_claude(topic, lang)
    img = render_card_png(build_card_html(topic, lang), "card.jpg")
    post_to_x(tweet, img)


if __name__ == "__main__":
    main()

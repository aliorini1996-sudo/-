#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
تسويق FieldSales على X — يعمل يوميًا عبر GitHub Actions (مجاني).
المسار: اختيار ميزة حقيقية → Claude يكتب التغريدة → تُركّب بطاقة تسويقية بهوية FieldSales
(شعار + ألوان + خطوط) وتُصوَّر إلى PNG عبر متصفّح headless → تُنشر على X.
لا ذكاء اصطناعي للصور: البطاقة مرسومة بالكود فتطابق الهوية 100% وتكون ثابتة.
"""
import os
import sys
import random

import requests
import tweepy
from playwright.sync_api import sync_playwright

# ------------------------------ الهوية ------------------------------ #
CORAL, INK, CREAM, GREEN, AMBER, GRAY, LCORAL = (
    "#E15A30", "#1F1A13", "#FAF7F0", "#1E7A52", "#E0A02C", "#6E6557", "#FBEBE2"
)
ACCENTS = {
    "coral": ("#E15A30", "#FBEBE2"),
    "green": ("#1E7A52", "#E4F1EA"),
    "amber": ("#E0A02C", "#FBF0D8"),
}

# أيقونات (محتوى SVG داخلي 24×24، يُطبَّق عليها لون التمييز)
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

# بنك المواضيع — ميزات حقيقية فقط. لكل ميزة: عنوان البطاقة + الفائدة + الأيقونة + لون التمييز + (الألم للتغريدة)
TOPICS = [
    {"eyebrow": "الفوترة الإلكترونية ZATCA", "title": "فاتورة ضريبية برمز QR من الميدان", "benefit": "أصدر فاتورة متوافقة مع هيئة الزكاة والضريبة برمز QR وأرسلها للعميل واطبعها حراريًا — مباشرةً من جوال المندوب.", "pain": "الفواتير اليدوية ومخالفات هيئة الزكاة والضريبة", "icon": "invoice", "accent": "amber"},
    {"eyebrow": "التحصيل والذمم", "title": "تحصيل أوضح وديون أقل", "benefit": "سند قبض رقمي لكل دفعة وكشف حساب لحظي لكل عميل — لا مبالغ بلا أثر ولا ديون متعثّرة.", "pain": "ضياع التحصيل وتراكم الديون المتعثرة", "icon": "coins", "accent": "green"},
    {"eyebrow": "مخزون السيارة · Van Sales", "title": "اعرف ما في كل سيارة لحظيًا", "benefit": "سجّل ما حُمّل في سيارة المندوب، فينقص تلقائيًا مع كل بيع، وتابع المتبقّي والحركة بلا عجز ولا فروقات.", "pain": "عجز وفروقات في بضاعة سيارات المناديب", "icon": "van", "accent": "coral"},
    {"eyebrow": "التتبّع عبر GPS", "title": "تابع مناديبك على الخريطة", "benefit": "مواقع حيّة وخطوط سير لكل مندوب خلال يومه — تحسّن التغطية وتقلّل الوقت الضائع.", "pain": "غياب الرؤية عن حركة الفريق الميداني", "icon": "pin", "accent": "green"},
    {"eyebrow": "صلاحيات المناديب", "title": "تحكّم دقيق بكل مندوب", "benefit": "اضبط الخصم والبيع بأقل من السعر وإضافة العملاء لكل مندوب — فتحمي هوامشك من التلاعب.", "pain": "تلاعب بالخصومات والبيع بأقل من السعر", "icon": "shield", "accent": "coral"},
    {"eyebrow": "التقارير اللحظية", "title": "قرارات بالأرقام لا بالتخمين", "benefit": "مبيعات اليوم والتحصيل وأداء كل مندوب على لوحة واحدة بضغطة زر.", "pain": "قرارات بالتخمين لا بالبيانات", "icon": "chart", "accent": "amber"},
    {"eyebrow": "إدارة العملاء", "title": "حدود ائتمان وتنبيهات ذكية", "benefit": "حدّ ائتمان لكل عميل وكشف حساب يُحدَّث تلقائيًا، مع تنبيه فوري عند تجاوز الحدّ.", "pain": "تجاوز العملاء حدود ائتمانهم دون تنبيه", "icon": "users", "accent": "coral"},
    {"eyebrow": "الطلبات الميدانية", "title": "الطلب يصل للإدارة فورًا", "benefit": "ينشئ المندوب الطلب من جواله مع الكتالوج والأسعار، فيصل لحظيًا للإدارة والمستودع.", "pain": "بطء وصول الطلبات للإدارة والمستودع", "icon": "clipboard", "accent": "green"},
    {"eyebrow": "كتالوج المنتجات", "title": "أسعار دقيقة لكل عميل", "benefit": "كتالوج موحّد بأسعار متدرّجة حسب الكمية وأسعار خاصة لكل عميل، يصل للميدان لحظيًا.", "pain": "أخطاء التسعير اليدوي", "icon": "box", "accent": "amber"},
    {"eyebrow": "سندات القبض", "title": "كل ريال محصّل موثّق", "benefit": "سند قبض رقمي يُرسل للعميل ويُخصم من رصيده تلقائيًا — شفافية كاملة في التحصيل.", "pain": "مبالغ محصّلة بلا أثر موثّق", "icon": "receipt", "accent": "green"},
    {"eyebrow": "التكامل مع ERP", "title": "بلا إدخال مزدوج", "benefit": "زامن عملاءك ومنتجاتك وفواتيرك وسنداتك مع نظام ERP لديك عبر اتصال آمن.", "pain": "إدخال مزدوج بين الميدان والمحاسبة", "icon": "sync", "accent": "coral"},
    {"eyebrow": "فريق الشركة والصلاحيات", "title": "كل دور يرى ما يخصّه", "benefit": "أضف مديرًا ومشرفًا ومحاسبًا بصلاحيات دقيقة لكل قسم — لا وصول مفتوح للجميع.", "pain": "وصول الجميع لكل شيء", "icon": "team", "accent": "amber"},
    {"eyebrow": "الطباعة الحرارية", "title": "اطبع فواتيرك من الميدان", "benefit": "طباعة فورية للفواتير والسندات من طابعة حرارية 58مم بلوتوث — بلا أجهزة مكلفة.", "pain": "الحاجة لأجهزة خاصة ومكلفة", "icon": "printer", "accent": "coral"},
    {"eyebrow": "منصّة سعودية", "title": "مصمّمة لشركات التوزيع السعودية", "benefit": "دعم عربي كامل وتوافق محلي — لا أنظمة أجنبية لا تناسب سوقك.", "pain": "أنظمة أجنبية لا تناسب السوق المحلي", "icon": "star", "accent": "green"},
    {"eyebrow": "التجربة المجانية", "title": "جرّب كل المميزات ١٠ أيام مجانًا", "benefit": "ابدأ اليوم بلا بطاقة ائتمان، وجهّز شركتك ومناديبك خلال دقائق.", "pain": "الخوف من الالتزام قبل التجربة", "icon": "gift", "accent": "coral"},
]


def env(name: str) -> str:
    v = os.environ.get(name, "").strip()
    if not v:
        sys.exit(f"❌ سرّ مفقود: {name} (أضِفه في GitHub Secrets)")
    return v


# ------------------------------ النص (Claude) ------------------------------ #
def ask_claude(topic: dict) -> str:
    system = (
        "أنت كاتب محتوى تسويقي محترف لمنصّة \"Field Sales\" (فيلد سيلز) — نظام سعودي لإدارة مبيعات "
        "مناديب التوزيع الميدانيين، موقعه fieldsa.net.\n"
        "اكتب تغريدة عربية واحدة قصيرة وجذّابة (أقل من 270 حرفًا شاملة الهاشتاقات) تبرز الميزة وتحلّ ألمًا حقيقيًا.\n"
        "قواعد: ميزات حقيقية فقط بلا اختلاق؛ نبرة احترافية بلا مبالغة؛ دعوة لفعل ناعمة + الرابط fieldsa.net؛ "
        "اذكر \"تجربة مجانية 10 أيام\" عند المناسبة؛ أضف 2–4 هاشتاقات عربية ملائمة.\n"
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
    tweet = r.json()["content"][0]["text"].strip().strip('"').strip()
    return tweet[:277]


# ------------------------------ البطاقة (بهوية FieldSales) ------------------------------ #
LOGO_SVG = (
    '<svg width="60" height="60" viewBox="0 0 120 120"><rect width="120" height="120" rx="28" fill="#E15A30"/>'
    '<polyline points="32,88 60,60 90,32" stroke="#1F1A13" stroke-width="13" stroke-linecap="round" stroke-linejoin="round" fill="none"/>'
    '<circle cx="32" cy="88" r="8" fill="#FAF7F0"/><circle cx="60" cy="60" r="6" fill="#FAF7F0"/>'
    '<circle cx="90" cy="32" r="12" fill="#1F1A13"/><circle cx="90" cy="32" r="5.5" fill="#FAF7F0"/></svg>'
)


def build_card_html(topic: dict) -> str:
    stroke, tint = ACCENTS[topic["accent"]]
    icon = (
        f'<svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="{stroke}" '
        f'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">{IC[topic["icon"]]}</svg>'
    )
    return f"""<!doctype html><html dir="rtl" lang="ar"><head><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&family=IBM+Plex+Serif:wght@600&display=swap" rel="stylesheet">
<style>*{{margin:0;padding:0;box-sizing:border-box}}html,body{{width:1200px;height:675px}}
body{{font-family:'IBM Plex Sans Arabic',sans-serif;background:{CREAM}}}</style></head><body>
<div style="position:relative;width:1200px;height:675px;overflow:hidden;padding:64px 72px;background:{CREAM}">
  <div style="position:absolute;top:-180px;right:-120px;width:520px;height:520px;border-radius:50%;background:radial-gradient(circle,rgba(225,90,48,.13),transparent 65%)"></div>
  <div style="position:absolute;bottom:-160px;left:-120px;width:460px;height:460px;border-radius:50%;background:radial-gradient(circle,rgba(30,122,82,.10),transparent 65%)"></div>
  <div style="position:relative;display:flex;align-items:center;justify-content:space-between">
    <div style="display:flex;align-items:center;gap:16px">{LOGO_SVG}
      <span style="font-family:'IBM Plex Serif',serif;font-size:30px;font-weight:600;letter-spacing:-.3px"><span style="color:{INK}">Field</span> <span style="color:{CORAL}">Sales</span></span>
    </div>
    <span style="background:{LCORAL};color:#C94E28;font-size:20px;font-weight:600;padding:10px 20px;border-radius:30px">fieldsa.net</span>
  </div>
  <div style="position:relative;display:flex;align-items:center;gap:40px;margin-top:70px">
    <span style="flex-shrink:0;width:128px;height:128px;border-radius:30px;background:{tint};display:flex;align-items:center;justify-content:center">{icon}</span>
    <div>
      <div style="color:{CORAL};font-size:22px;font-weight:600;margin-bottom:10px">{topic['eyebrow']}</div>
      <h1 style="color:{INK};font-size:58px;font-weight:700;line-height:1.18;letter-spacing:-1px">{topic['title']}</h1>
    </div>
  </div>
  <p style="position:relative;color:{GRAY};font-size:29px;line-height:1.5;margin-top:28px;max-width:1000px">{topic['benefit']}</p>
  <div style="position:absolute;bottom:60px;right:72px;display:flex;align-items:center;gap:20px">
    <span style="background:{CORAL};color:#fff;font-size:26px;font-weight:600;padding:16px 34px;border-radius:14px">ابدأ تجربتك المجانية ١٠ أيام</span>
    <span style="color:#9A8F7E;font-size:21px">بدون بطاقة ائتمان</span>
  </div>
</div></body></html>"""


def render_card_png(html: str, path: str) -> str:
    """يصوّر البطاقة إلى PNG بمقاس X القياسي 16:9 عالي الدقّة (1200×675 ×2 = 2400×1350)."""
    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--no-sandbox"])
        page = browser.new_page(viewport={"width": 1200, "height": 675}, device_scale_factor=2)
        page.set_content(html, wait_until="networkidle")
        page.wait_for_timeout(500)  # ضمان رسم الخطوط
        page.screenshot(path=path, type="jpeg", quality=92)
        browser.close()
    print(f"🖼️  البطاقة جاهزة بهوية FieldSales (16:9): {path}")
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
            print("⬆️  رُفعت البطاقة إلى X")
        except Exception as e:  # noqa: BLE001
            print(f"⚠️  رفع الصورة فشل — نشر نصّي: {e}")
    client = tweepy.Client(consumer_key=ck, consumer_secret=cs, access_token=at, access_token_secret=ats)
    res = client.create_tweet(text=tweet, media_ids=media_ids)
    print(f"✅ نُشرت التغريدة (id={res.data.get('id') if res and res.data else '?'}):\n{tweet}")


def main():
    topic = random.choice(TOPICS)
    print(f"📌 موضوع اليوم: {topic['title']}")
    tweet = ask_claude(topic)
    img = render_card_png(build_card_html(topic), "card.jpg")
    post_to_x(tweet, img)


if __name__ == "__main__":
    main()

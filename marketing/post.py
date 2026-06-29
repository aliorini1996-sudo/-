#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
تسويق FieldSales التلقائي على X — يعمل يوميًا عبر GitHub Actions (مجاني).
المسار: اختيار ميزة حقيقية → Claude يكتب تغريدة + وصف صورة → Pollinations يولّد الصورة → نشر على X.
لا يُختلق أي ميزة. الأسرار تأتي من متغيّرات البيئة (GitHub Secrets).
"""
import os
import re
import json
import random
import sys

import requests
import tweepy

# ------------------------------------------------------------------ #
# بنك المواضيع — ميزات حقيقية فقط في النظام (عدّلها كما تشاء)
TOPICS = [
    {"feature": "الفوترة الإلكترونية ZATCA برمز QR من الميدان", "pain": "الفواتير اليدوية ومخالفات هيئة الزكاة والضريبة", "benefit": "فاتورة ضريبية متوافقة برمز QR من جوال المندوب فورًا"},
    {"feature": "تحصيل المدفوعات وإدارة الذمم المدينة", "pain": "ضياع التحصيل وتراكم الديون المتعثرة", "benefit": "سند قبض رقمي وكشف حساب لحظي لكل عميل"},
    {"feature": "مخزون سيارة المندوب (البيع المتنقّل Van Sales)", "pain": "عجز وفروقات في بضاعة سيارات المناديب", "benefit": "متابعة ما حُمّل وما بِيع وما تبقّى لحظيًا"},
    {"feature": "تتبّع المناديب على الخريطة عبر GPS", "pain": "غياب الرؤية عن حركة الفريق الميداني", "benefit": "مواقع حيّة وخطوط سير لتحسين التغطية"},
    {"feature": "إدارة المناديب وصلاحياتهم بدقّة", "pain": "تلاعب بالخصومات والبيع بأقل من السعر", "benefit": "تحكّم دقيق بصلاحية كل مندوب وحدّ الخصم"},
    {"feature": "التقارير وكشوف الحساب اللحظية", "pain": "قرارات بالتخمين لا بالبيانات", "benefit": "مبيعات وتحصيل وأداء كل مندوب بضغطة زر"},
    {"feature": "إدارة العملاء وحدود الائتمان", "pain": "تجاوز العملاء حدود ائتمانهم دون تنبيه", "benefit": "حدّ ائتمان وتنبيه فوري عند التجاوز"},
    {"feature": "إدارة الطلبات الميدانية", "pain": "بطء وصول الطلبات للإدارة والمستودع", "benefit": "الطلب من جوال المندوب يصل للإدارة فورًا"},
    {"feature": "كتالوج المنتجات والأسعار المتدرّجة", "pain": "أخطاء التسعير اليدوي", "benefit": "أسعار متدرّجة وأسعار خاصة لكل عميل تصل للميدان"},
    {"feature": "سندات القبض الرقمية الموثّقة", "pain": "مبالغ محصّلة بلا أثر موثّق", "benefit": "سند قبض رقمي يُرسل للعميل ويُخصم تلقائيًا"},
    {"feature": "التكامل مع أنظمة ERP", "pain": "إدخال مزدوج بين الميدان والمحاسبة", "benefit": "مزامنة العملاء والمنتجات والفواتير مع نظام ERP"},
    {"feature": "فريق الشركة والصلاحيات (مدير/مشرف/محاسب)", "pain": "وصول الجميع لكل شيء", "benefit": "صلاحيات دقيقة لكل دور وقسم"},
    {"feature": "الطباعة الحرارية للفواتير 58مم", "pain": "الحاجة لأجهزة خاصة ومكلفة", "benefit": "طباعة فورية من طابعة حرارية بلوتوث"},
    {"feature": "منصّة سعودية بدعم عربي كامل", "pain": "أنظمة أجنبية لا تناسب السوق المحلي", "benefit": "مصمّمة لشركات التوزيع السعودية"},
    {"feature": "التجربة المجانية 10 أيام", "pain": "الخوف من الالتزام قبل التجربة", "benefit": "جرّب كل المميزات مجانًا 10 أيام بلا بطاقة ائتمان"},
]

FALLBACK_IMAGE_PROMPT = (
    "Clean modern flat vector marketing illustration of a field sales mobile app and dashboard, "
    "brand colors coral #E15A30 and dark ink #1F1A13 on a cream #FAF7F0 background "
    "with a green #1E7A52 accent, no text"
)


def env(name: str) -> str:
    val = os.environ.get(name, "").strip()
    if not val:
        sys.exit(f"❌ المتغيّر السرّي مفقود: {name} (أضِفه في GitHub Secrets)")
    return val


def build_prompts(topic: dict):
    system = (
        "أنت كاتب محتوى تسويقي محترف لمنصّة \"Field Sales\" (فيلد سيلز) — نظام سعودي لإدارة مبيعات "
        "مناديب التوزيع الميدانيين، موقعه fieldsa.net.\n"
        "مهمتك: تغريدة تسويقية عربية واحدة قصيرة وجذّابة (أقل من 270 حرفًا شاملة الهاشتاقات) تبرز ميزة "
        "محددة وتحلّ ألمًا حقيقيًا للعميل.\n"
        "قواعد صارمة:\n"
        "- اذكر ميزات حقيقية فقط، لا تختلق أي ميزة أو رقم.\n"
        "- نبرة احترافية واثقة بلا مبالغة أو وعود زائفة.\n"
        "- أضف دعوة لفعل ناعمة + الرابط fieldsa.net، واذكر \"تجربة مجانية 10 أيام\" عند المناسبة.\n"
        "- أضف 2–4 هاشتاقات عربية ملائمة (مثل #مبيعات_ميدانية #التوزيع #فواتير_ZATCA #السعودية).\n"
        "ثم صف صورة تسويقية احترافية (بالإنجليزية) لمولّد صور:\n"
        "- نظيفة وعصرية بهوية العلامة: مرجاني #E15A30، حبر داكن #1F1A13، خلفية كريمية #FAF7F0، لمسة خضراء #1E7A52.\n"
        "- تمثّل الميزة بشكل تجريدي/توضيحي (mobile app UI, dashboard, charts, delivery van, map pins, invoice…).\n"
        "- مهم: لا تضع أي نص عربي في الصورة. الأسلوب: flat modern vector illustration، بلا أشخاص واقعيين.\n"
        "أعد ردّك بصيغة JSON خام فقط، دون أي نص أو أسوار ماركداون، بهذا الشكل بالضبط:\n"
        '{"tweet": "...", "imagePrompt": "..."}'
    )
    user = (
        f"الميزة: {topic['feature']}\n"
        f"ألم العميل: {topic['pain']}\n"
        f"الفائدة: {topic['benefit']}\n"
        "اكتب التغريدة ووصف الصورة الآن (JSON فقط)."
    )
    return system, user


def ask_claude(system: str, user: str) -> dict:
    resp = requests.post(
        "https://api.anthropic.com/v1/messages",
        headers={
            "x-api-key": env("ANTHROPIC_API_KEY"),
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        json={
            "model": "claude-haiku-4-5",
            "max_tokens": 700,
            "system": system,
            "messages": [{"role": "user", "content": user}],
        },
        timeout=60,
    )
    resp.raise_for_status()
    text = resp.json()["content"][0]["text"].strip()
    text = re.sub(r"^```(?:json)?", "", text).strip()
    text = re.sub(r"```$", "", text).strip()
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        m = re.search(r"\{[\s\S]*\}", text)
        data = json.loads(m.group(0)) if m else {"tweet": text[:270], "imagePrompt": FALLBACK_IMAGE_PROMPT}
    tweet = str(data.get("tweet", "")).strip()[:277]
    image_prompt = str(data.get("imagePrompt", "") or FALLBACK_IMAGE_PROMPT).strip()[:500]
    if not tweet:
        sys.exit("❌ لم يُنتج النموذج تغريدة")
    return {"tweet": tweet, "imagePrompt": image_prompt}


def generate_image(image_prompt: str) -> str | None:
    """يولّد الصورة عبر Pollinations (مجاني، بلا مفتاح). يعيد مسار الملف أو None عند الفشل."""
    try:
        url = "https://image.pollinations.ai/prompt/" + requests.utils.quote(image_prompt, safe="")
        r = requests.get(url, params={"width": 1280, "height": 720, "nologo": "true"}, timeout=150)
        r.raise_for_status()
        path = "image.jpg"
        with open(path, "wb") as f:
            f.write(r.content)
        print(f"🖼️  الصورة جاهزة ({len(r.content)} بايت)")
        return path
    except Exception as e:  # noqa: BLE001
        print(f"⚠️  تعذّر توليد الصورة، سيُنشر نصًا فقط: {e}")
        return None


def post_to_x(tweet: str, image_path: str | None):
    ck, cs = env("X_API_KEY"), env("X_API_SECRET")
    at, ats = env("X_ACCESS_TOKEN"), env("X_ACCESS_SECRET")

    media_ids = None
    if image_path:
        try:
            api_v1 = tweepy.API(tweepy.OAuth1UserHandler(ck, cs, at, ats))
            media = api_v1.media_upload(image_path)
            media_ids = [media.media_id]
            print("⬆️  رُفعت الصورة إلى X")
        except Exception as e:  # noqa: BLE001
            print(f"⚠️  رفع الصورة فشل (قد لا تتيحه الطبقة المجانية) — نشر نصّي: {e}")

    client = tweepy.Client(consumer_key=ck, consumer_secret=cs,
                           access_token=at, access_token_secret=ats)
    res = client.create_tweet(text=tweet, media_ids=media_ids)
    tid = res.data.get("id") if res and res.data else "?"
    print(f"✅ نُشرت التغريدة (id={tid}):\n{tweet}")


def main():
    topic = random.choice(TOPICS)
    print(f"📌 موضوع اليوم: {topic['feature']}")
    system, user = build_prompts(topic)
    content = ask_claude(system, user)
    image_path = generate_image(content["imagePrompt"])
    post_to_x(content["tweet"], image_path)


if __name__ == "__main__":
    main()

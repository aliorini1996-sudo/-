#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
تسويق FieldSales على تيليجرام — يعمل يوميًا عبر GitHub Actions (مجاني تمامًا، Bot API بلا حدود عملية).
يعيد استخدام بنك المواضيع ومولّد البطاقات من post.py (نفس الهوية البصرية 100%).

المطلوب سرّان فقط:
 - TELEGRAM_BOT_TOKEN : توكن البوت من @BotFather
 - TELEGRAM_CHAT_ID   : معرّف القناة (مثل @fieldsales أو -100xxxxxxxxxx) — البوت مشرف فيها
"""
import os
import random
import sys

import requests

from post import TOPICS, build_card_html, render_card_png, pick_lang, env, ask_gemini


def ask_claude_telegram(topic: dict, lang: str) -> str:
    """نص منشور قناة تيليجرام — أطول من التغريدة وأغنى، بلا حشو هاشتاقات."""
    if lang == "en":
        system = (
            "You are a marketing copywriter for \"Field Sales\" (fieldsa.net), a field-sales & distribution "
            "management platform for the Arab world.\n"
            "Write ONE Telegram channel post in English (3-5 short lines, under 700 characters): a hook line, "
            "2-3 lines on the feature solving a real pain, then a CTA line with the link fieldsa.net and "
            "\"free trial, no credit card\". Real features only; confident, no hype. End with 2-3 relevant "
            "hashtags max. Return only the post text."
        )
        user = f"Feature: {topic['title_en']}\nBenefit: {topic['benefit_en']}\nPain: {topic['pain_en']}"
    else:
        system = (
            "أنت كاتب محتوى تسويقي لمنصّة \"Field Sales\" (fieldsa.net) — نظام إدارة مبيعات مناديب التوزيع "
            "الميدانيين للعالم العربي.\n"
            "اكتب منشور قناة تيليجرام واحدًا بالعربية (3-5 أسطر قصيرة، أقل من 700 حرف): سطر خطّاف، "
            "سطران-ثلاثة عن الميزة وحلّ الألم الحقيقي، ثم سطر دعوة لفعل مع الرابط fieldsa.net و«تجربة مجانية "
            "بلا بطاقة». ميزات حقيقية فقط؛ نبرة واثقة بلا مبالغة. اختمه بـ2-3 هاشتاقات كحد أقصى. "
            "أعِد نص المنشور فقط."
        )
        user = f"الميزة: {topic['title']}\nالفائدة: {topic['benefit']}\nالألم: {topic['pain']}"

    return ask_gemini(system, user, max_tokens=700)[:1000]


def post_to_telegram(text: str, image_path: str):
    token = env("TELEGRAM_BOT_TOKEN")
    chat_id = env("TELEGRAM_CHAT_ID")
    base = f"https://api.telegram.org/bot{token}"
    if image_path and os.path.exists(image_path):
        with open(image_path, "rb") as f:
            r = requests.post(f"{base}/sendPhoto", data={"chat_id": chat_id, "caption": text}, files={"photo": f}, timeout=90)
        if r.ok:
            print("posted photo+caption to Telegram")
            return
        print(f"sendPhoto failed ({r.status_code}: {r.text[:300]}), falling back to text")
    r = requests.post(f"{base}/sendMessage", data={"chat_id": chat_id, "text": text, "disable_web_page_preview": False}, timeout=60)
    if not r.ok:
        sys.exit(f"❌ فشل النشر على تيليجرام {r.status_code}: {r.text[:300]}")
    print("posted text to Telegram")


def main():
    lang = pick_lang()
    topic = random.choice(TOPICS)
    print(f"lang={lang} | topic: {topic['title'] if lang == 'ar' else topic['title_en']}")
    text = ask_claude_telegram(topic, lang)
    img = render_card_png(build_card_html(topic, lang), "card_tg.jpg")
    post_to_telegram(text, img)


if __name__ == "__main__":
    main()

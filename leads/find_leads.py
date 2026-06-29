#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
صيد العملاء المحتملين لـFieldSales — يبحث يوميًا عن شركات التوزيع/الجملة في السعودية
عبر HERE Maps (مجاني، بلا موزّع)، يؤهّلها بـClaude، ويحفظ الجدد فقط في Google Sheet خاص.
بيانات أعمال عامّة فقط — قائمة لمراجعة فريق المبيعات (لا تواصل آلي).

وضع الاختبار: إن لم تُضبط أسرار Google (الجدول)، يطبع عدد ونماذج النتائج فقط (لفحص التغطية).
"""
import os
import sys
import json
import time
import datetime

import requests

# مدن السعودية + إحداثيات مراكزها (لبحث HERE)
CITIES = {
    "الرياض": (24.7136, 46.6753), "جدة": (21.5433, 39.1728), "الدمام": (26.4207, 50.0888),
    "مكة المكرمة": (21.3891, 39.8579), "المدينة المنورة": (24.5247, 39.5692), "الخبر": (26.2794, 50.2083),
    "الطائف": (21.2854, 40.4183), "تبوك": (28.3838, 36.5550), "بريدة": (26.3260, 43.9750),
    "خميس مشيط": (18.3060, 42.7290), "حائل": (27.5114, 41.7208), "الأحساء": (25.3833, 49.5867),
    "نجران": (17.4924, 44.1277), "الجبيل": (27.0174, 49.6225), "ينبع": (24.0890, 38.0618),
    "أبها": (18.2169, 42.5053),
}

QUERIES = [
    "شركة توزيع مواد غذائية",
    "تجارة جملة",
    "موزع مواد استهلاكية",
    "مستودع توزيع",
    "شركة توزيع مشروبات",
    "موزع مستلزمات",
    "تاجر جملة",
    "شركة توريدات",
    "موزع منتجات تنظيف",
    "توزيع أدوية ومستلزمات طبية",
]

HEADERS = ["here_id", "الاسم", "الهاتف", "الموقع الإلكتروني", "العنوان",
           "المدينة", "النوع", "رابط الخريطة", "الملاءمة (1-10)", "ملاحظة", "تاريخ الإضافة"]


def env(name: str) -> str:
    v = os.environ.get(name, "").strip()
    if not v:
        sys.exit(f"❌ سرّ مفقود: {name} (أضِفه في GitHub Secrets)")
    return v


# ------------------------------ HERE Discover ------------------------------ #
def search_here(query: str, lat: float, lng: float, api_key: str) -> list:
    try:
        r = requests.get(
            "https://discover.search.hereapi.com/v1/discover",
            params={"q": query, "at": f"{lat},{lng}", "in": "countryCode:SAU",
                    "limit": 100, "lang": "ar-SA", "apiKey": api_key},
            timeout=40,
        )
        if not r.ok:
            print(f"⚠️  بحث فشل ({query}): {r.status_code} {r.text[:160]}")
            return []
        return r.json().get("items", [])
    except Exception as e:  # noqa: BLE001
        print(f"⚠️  بحث فشل ({query}): {e}")
        return []


def parse_item(it: dict, city: str) -> dict | None:
    name = it.get("title")
    if not name or not it.get("id"):
        return None
    contacts = (it.get("contacts") or [{}])[0]
    phone = ((contacts.get("phone") or [{}])[0]).get("value", "")
    www = ((contacts.get("www") or [{}])[0]).get("value", "")
    pos = it.get("position") or {}
    cat = ((it.get("categories") or [{}])[0]).get("name", "")
    return {
        "id": it["id"],
        "name": name,
        "phone": phone,
        "website": www,
        "address": (it.get("address") or {}).get("label", ""),
        "city": (it.get("address") or {}).get("city", "") or city,
        "type": cat,
        "maps": f"https://www.google.com/maps/search/?api=1&query={pos.get('lat')},{pos.get('lng')}" if pos else "",
    }


# ------------------------------ Google Sheet ------------------------------ #
def open_sheet():
    import gspread
    from google.oauth2.service_account import Credentials
    info = json.loads(env("GOOGLE_SERVICE_ACCOUNT_JSON"))
    creds = Credentials.from_service_account_info(
        info, scopes=["https://www.googleapis.com/auth/spreadsheets"]
    )
    return gspread.authorize(creds).open_by_key(env("GOOGLE_SHEET_ID")).sheet1


# ------------------------------ تأهيل (Claude) ------------------------------ #
def qualify(leads: list) -> dict:
    key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if not key or not leads:
        return {}
    items = [{"i": i, "name": l["name"], "type": l["type"], "city": l["city"]} for i, l in enumerate(leads)]
    system = (
        "أنت محلّل مبيعات لمنصّة FieldSales (نظام سعودي لإدارة مبيعات مناديب التوزيع الميدانيين). "
        "قيّم ملاءمة كل نشاط: شركات التوزيع/الجملة التي لديها مناديب ميدانيون = الأعلى؛ التجزئة الصغيرة/غير المتعلق = الأقل. "
        "أعِد JSON فقط: مصفوفة {\"i\":رقم, \"score\":1-10, \"note\":\"سبب موجز جدًا بالعربية\"}."
    )
    user = "النشاطات:\n" + json.dumps(items, ensure_ascii=False)
    try:
        r = requests.post(
            "https://api.anthropic.com/v1/messages",
            headers={"x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json"},
            json={"model": "claude-haiku-4-5", "max_tokens": 3000, "system": system,
                  "messages": [{"role": "user", "content": user}]},
            timeout=90,
        )
        if not r.ok:
            return {}
        import re
        m = re.search(r"\[.*\]", r.json()["content"][0]["text"], re.S)
        arr = json.loads(m.group(0)) if m else []
        return {int(x["i"]): (x.get("score", ""), x.get("note", "")) for x in arr}
    except Exception as e:  # noqa: BLE001
        print("⚠️  تأهيل Claude فشل:", e)
        return {}


# ------------------------------ الرئيسية ------------------------------ #
def main():
    api_key = env("HERE_API_KEY")
    dry = not (os.environ.get("GOOGLE_SHEET_ID", "").strip() and os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON", "").strip())

    if dry:
        print("🧪 وضع الاختبار: لا أسرار Google بعد — سأطبع التغطية فقط دون الكتابة في الجدول.")
        sh, existing_ids = None, set()
    else:
        sh = open_sheet()
        rows_all = sh.get_all_values()
        if not rows_all:
            sh.append_row(HEADERS); existing_ids = set()
        else:
            existing_ids = {row[0] for row in rows_all[1:] if row and row[0]}

    query = QUERIES[datetime.date.today().toordinal() % len(QUERIES)]
    print(f"🔎 بحث اليوم: «{query}» في {len(CITIES)} مدينة (HERE)")

    found = {}
    for city, (lat, lng) in CITIES.items():
        for it in search_here(query, lat, lng, api_key):
            lead = parse_item(it, city)
            if not lead or lead["id"] in existing_ids or lead["id"] in found:
                continue
            found[lead["id"]] = lead
        time.sleep(0.15)

    leads = list(found.values())
    with_phone = sum(1 for l in leads if l["phone"])
    print(f"🆕 نتائج: {len(leads)} | منها بهاتف: {with_phone}")

    if dry:
        for l in leads[:12]:
            print(f"  - {l['name']} | {l['phone'] or 'بلا هاتف'} | {l['city']}")
        print("✅ انتهى الاختبار. إن أعجبتك التغطية، أكمل إعداد Google Sheet لتُحفظ تلقائيًا.")
        return

    if not leads:
        print("لا عملاء محتملين جدد اليوم.")
        return

    scores = qualify(leads)
    today = datetime.date.today().isoformat()
    rows = []
    for i, l in enumerate(leads):
        score, note = scores.get(i, ("", ""))
        rows.append([l["id"], l["name"], l["phone"], l["website"], l["address"],
                     l["city"], l["type"], l["maps"], score, note, today])
    rows.sort(key=lambda r: r[8] if isinstance(r[8], (int, float)) else 0, reverse=True)
    sh.append_rows(rows, value_input_option="RAW")
    print(f"✅ أُضيف {len(rows)} عميلًا محتملاً إلى Google Sheet (الأعلى ملاءمة أولًا).")


if __name__ == "__main__":
    main()

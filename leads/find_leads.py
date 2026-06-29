#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
صيد العملاء المحتملين لـFieldSales — يبحث يوميًا عن شركات التوزيع/الجملة في السعودية،
يؤهّلها بـClaude، ويحفظ الجدد فقط في Google Sheet خاص.

يدعم مصدرين تلقائيًا:
- إن وُجد GOOGLE_MAPS_API_KEY → يستخدم Google Places (تغطية أفضل).
- وإلا إن وُجد HERE_API_KEY → يستخدم HERE Maps (مجاني، بلا موزّع).
فابدأ بـHERE اليوم، وأضِف مفتاح Google لاحقًا فيتحوّل تلقائيًا.

وضع الاختبار: إن لم تُضبط أسرار Google Sheet، يطبع عدد ونماذج النتائج فقط (لفحص التغطية).
بيانات أعمال عامّة فقط — قائمة لمراجعة فريق المبيعات (لا تواصل آلي).
"""
import os
import sys
import json
import time
import datetime

import requests

# مدن السعودية + إحداثيات مراكزها
CITIES = {
    "الرياض": (24.7136, 46.6753), "جدة": (21.5433, 39.1728), "الدمام": (26.4207, 50.0888),
    "مكة المكرمة": (21.3891, 39.8579), "المدينة المنورة": (24.5247, 39.5692), "الخبر": (26.2794, 50.2083),
    "الطائف": (21.2854, 40.4183), "تبوك": (28.3838, 36.5550), "بريدة": (26.3260, 43.9750),
    "خميس مشيط": (18.3060, 42.7290), "حائل": (27.5114, 41.7208), "الأحساء": (25.3833, 49.5867),
    "نجران": (17.4924, 44.1277), "الجبيل": (27.0174, 49.6225), "ينبع": (24.0890, 38.0618),
    "أبها": (18.2169, 42.5053),
}

QUERIES = [
    "شركة توزيع مواد غذائية", "تجارة جملة", "موزع مواد استهلاكية", "مستودع توزيع",
    "شركة توزيع مشروبات", "موزع مستلزمات", "تاجر جملة", "شركة توريدات",
    "موزع منتجات تنظيف", "توزيع أدوية ومستلزمات طبية",
]

HEADERS = ["id", "الاسم", "الهاتف", "الموقع الإلكتروني", "العنوان", "المدينة",
           "النوع", "رابط الخريطة", "المصدر", "الملاءمة (1-10)", "ملاحظة", "تاريخ الإضافة"]


def env(name: str) -> str:
    v = os.environ.get(name, "").strip()
    if not v:
        sys.exit(f"❌ سرّ مفقود: {name}")
    return v


# --------------------------- مصدر 1: Google Places (New) --------------------------- #
def search_google(query: str, city: str, coords, key: str) -> list:
    r = requests.post(
        "https://places.googleapis.com/v1/places:searchText",
        headers={
            "Content-Type": "application/json", "X-Goog-Api-Key": key,
            "X-Goog-FieldMask": ("places.id,places.displayName,places.formattedAddress,"
                                 "places.internationalPhoneNumber,places.nationalPhoneNumber,"
                                 "places.websiteUri,places.googleMapsUri,places.primaryTypeDisplayName"),
        },
        json={"textQuery": f"{query} في {city}", "regionCode": "SA", "languageCode": "ar", "maxResultCount": 20},
        timeout=60,
    )
    if not r.ok:
        print(f"⚠️  Google فشل ({city}): {r.status_code} {r.text[:120]}")
        return []
    out = []
    for p in r.json().get("places", []):
        if not p.get("id"):
            continue
        out.append({
            "id": f"g:{p['id']}", "name": (p.get("displayName") or {}).get("text", ""),
            "phone": p.get("internationalPhoneNumber") or p.get("nationalPhoneNumber") or "",
            "website": p.get("websiteUri", ""), "address": p.get("formattedAddress", ""),
            "city": city, "type": (p.get("primaryTypeDisplayName") or {}).get("text", ""),
            "maps": p.get("googleMapsUri", ""), "source": "Google",
        })
    return out


# --------------------------- مصدر 2: HERE Discover --------------------------- #
def search_here(query: str, city: str, coords, key: str) -> list:
    lat, lng = coords
    try:
        r = requests.get(
            "https://discover.search.hereapi.com/v1/discover",
            params={"q": query, "at": f"{lat},{lng}", "in": "countryCode:SAU",
                    "limit": 100, "lang": "ar-SA", "apiKey": key},
            timeout=40,
        )
        if not r.ok:
            print(f"⚠️  HERE فشل ({city}): {r.status_code} {r.text[:120]}")
            return []
    except Exception as e:  # noqa: BLE001
        print(f"⚠️  HERE فشل ({city}): {e}")
        return []
    out = []
    for it in r.json().get("items", []):
        if not it.get("id") or not it.get("title"):
            continue
        c = (it.get("contacts") or [{}])[0]
        pos = it.get("position") or {}
        out.append({
            "id": f"h:{it['id']}", "name": it["title"],
            "phone": ((c.get("phone") or [{}])[0]).get("value", ""),
            "website": ((c.get("www") or [{}])[0]).get("value", ""),
            "address": (it.get("address") or {}).get("label", ""),
            "city": (it.get("address") or {}).get("city", "") or city,
            "type": ((it.get("categories") or [{}])[0]).get("name", ""),
            "maps": f"https://www.google.com/maps/search/?api=1&query={pos.get('lat')},{pos.get('lng')}" if pos else "",
            "source": "HERE",
        })
    return out


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
    try:
        r = requests.post(
            "https://api.anthropic.com/v1/messages",
            headers={"x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json"},
            json={"model": "claude-haiku-4-5", "max_tokens": 3000, "system": system,
                  "messages": [{"role": "user", "content": "النشاطات:\n" + json.dumps(items, ensure_ascii=False)}]},
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
    gkey = os.environ.get("GOOGLE_MAPS_API_KEY", "").strip()
    hkey = os.environ.get("HERE_API_KEY", "").strip()
    if gkey:
        provider, key, fn = "Google Places", gkey, search_google
    elif hkey:
        provider, key, fn = "HERE Maps", hkey, search_here
    else:
        sys.exit("❌ أضِف أحد المفتاحين: GOOGLE_MAPS_API_KEY أو HERE_API_KEY")

    dry = not (os.environ.get("GOOGLE_SHEET_ID", "").strip() and os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON", "").strip())
    print(f"📍 المصدر: {provider}" + (" | 🧪 وضع الاختبار (بلا كتابة)" if dry else ""))

    if dry:
        sh, existing_ids = None, set()
    else:
        sh = open_sheet()
        rows_all = sh.get_all_values()
        if not rows_all:
            sh.append_row(HEADERS); existing_ids = set()
        else:
            existing_ids = {row[0] for row in rows_all[1:] if row and row[0]}

    query = QUERIES[datetime.date.today().toordinal() % len(QUERIES)]
    print(f"🔎 بحث اليوم: «{query}» في {len(CITIES)} مدينة")

    found = {}
    for city, coords in CITIES.items():
        for lead in fn(query, city, coords, key):
            if lead["id"] in existing_ids or lead["id"] in found:
                continue
            found[lead["id"]] = lead
        time.sleep(0.2)

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
        rows.append([l["id"], l["name"], l["phone"], l["website"], l["address"], l["city"],
                     l["type"], l["maps"], l["source"], score, note, today])
    rows.sort(key=lambda r: r[9] if isinstance(r[9], (int, float)) else 0, reverse=True)
    sh.append_rows(rows, value_input_option="RAW")
    print(f"✅ أُضيف {len(rows)} عميلًا محتملاً إلى Google Sheet (الأعلى ملاءمة أولًا).")


if __name__ == "__main__":
    main()

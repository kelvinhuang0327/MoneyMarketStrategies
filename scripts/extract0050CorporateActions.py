"""Extract factual 0050 distributions from an already downloaded public page.

No network requests. Example:
python3 scripts/extract0050CorporateActions.py page.html --retrieved-date 2026-10-05
"""
import argparse
from datetime import date
from decimal import Decimal
import hashlib
import json
from pathlib import Path
import re


def extract(raw: bytes, retrieved_date: str) -> dict:
    date.fromisoformat(retrieved_date)
    match = re.search(r'<script[^>]*id="__NUXT_DATA__"[^>]*>(.*?)</script>', raw.decode("utf-8"), re.S)
    if not match:
        raise ValueError("public Nuxt data missing; no dividend schedule fabricated")
    nodes = json.loads(match.group(1))
    records = []
    seen = set()
    for node in nodes:
        if not isinstance(node, dict) or "DIVIDEN_PER_UNIT" not in node:
            continue
        record = {key: nodes[node[key]] for key in ("FUND_ID", "FUND_SH_NM", "SHARE_DATE", "PAY_DATE", "DIVIDEN_PER_UNIT")}
        ex = record["SHARE_DATE"].replace("/", "-")
        if not "2020-01-01" <= ex <= "2026-08-11":
            continue
        if record["FUND_ID"] != "1066" or record["FUND_SH_NM"] != "元大台灣卓越50基金":
            raise ValueError("unexpected fund identity in required coverage")
        pay = record["PAY_DATE"].replace("/", "-")
        date.fromisoformat(ex)
        date.fromisoformat(pay)
        amount = Decimal(str(record["DIVIDEN_PER_UNIT"])) * 100
        if amount <= 0 or amount != amount.to_integral_value() or pay < ex or ex in seen:
            raise ValueError("invalid or duplicate corporate action")
        seen.add(ex)
        records.append({"exDate": ex, "payDate": pay, "amountPerShareMinor": str(int(amount)), "sourceRecord": record})
    records.sort(key=lambda row: row["exDate"])
    if len(records) != 14:
        raise ValueError("complete required 14-event source coverage missing")
    return {
        "schemaVersion": 1, "symbol": "0050", "fundId": "1066",
        "source": "https://www.yuantafunds.com/myfund/information/1066?tab=3",
        "retrievedDate": retrieved_date, "sourcePageSha256": hashlib.sha256(raw).hexdigest(),
        "extraction": "Public __NUXT_DATA__ indexed object; SHARE_DATE is ex date, PAY_DATE payment date, DIVIDEN_PER_UNIT TWD per raw share. Only records through archive cutoff retained.",
        "coverage": {"start": "2020-01-01", "end": "2026-08-11", "eventCount": 14}, "events": records,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("html", type=Path)
    parser.add_argument("--retrieved-date", required=True)
    args = parser.parse_args()
    print(json.dumps(extract(args.html.read_bytes(), args.retrieved_date), ensure_ascii=False, indent=2))

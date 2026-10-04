# Shared secrets for MyFTB registration, read from filed CA returns (PDF).
# Usage: python3 ftb-extract.py <dir>...   prints a JSON array; needs PyMuPDF.
# Called by src/ftb.ts; see there for what each record means.
import sys, json, re, glob, os
import pymupdf
NUM = re.compile(r'^-?[\d,]+\.?$')
def amount(s): return int(s.replace(',', '').rstrip('.'))
def line_value(page, label, minx=300):
    W = page.get_text("words")
    for l in [w for w in W if w[4] == label and w[0] < 80]:
        row = [w for w in W if abs(w[1] - l[1]) < 4 and w[0] > minx and NUM.match(w[4]) and w[4] != label]
        if row: return amount(sorted(row, key=lambda w: w[0])[-1][4])
    return None
STATUSES = {'1': 'single', '2': 'married-joint', '3': 'married-separate', '4': 'head-of-household', '5': 'qualifying-surviving-spouse'}
def filing_status(page):
    """The X nearest a numbered filing-status box (1-5) under the Filing Status heading."""
    W = page.get_text("words")
    head = next((w for w in W if w[4] == 'Filing'), None)
    if not head: return None
    boxes = [w for w in W if w[4] in STATUSES and head[1] - 5 < w[1] < head[1] + 120]
    for m in [w for w in W if w[4] in ('X', 'x') and head[1] - 5 < w[1] < head[1] + 120]:
        near = min(boxes, key=lambda b: abs(b[0] - m[0]) + abs(b[1] - m[1]), default=None)
        if near and abs(near[0] - m[0]) + abs(near[1] - m[1]) < 40: return STATUSES[near[4]]
    return None
out = []
for root in sys.argv[1:]:
    for f in sorted(glob.glob(os.path.join(os.path.expanduser(root), '**', '*.pdf'), recursive=True)):
        try:
            d = pymupdf.open(f)
            if d.needs_pass and not d.authenticate(''): continue
        except Exception: continue
        year540 = None
        for i, pg in enumerate(d):
            t = pg.get_text()
            h = re.search(r'TAXABLE YEAR\s*FORM\s*California Resident\s*(20\d\d)\s*540\b', t)
            if h: year540 = int(h.group(1))
            elif re.search(r'TAXABLE\s*YEAR', t): year540 = None
            m = re.search(r'Form 100S (20\d\d)', t)
            if m and 'Net income for tax purposes' in t:
                ident = re.search(r'^(\S.*?\S)\s{2,}(\d{7})$', t, re.M)
                out.append({'kind': 'business', 'form': '100S', 'year': int(m.group(1)), 'file': f, 'page': i + 1,
                            'netIncomeForState': line_value(pg, '15'), 'netIncomeForTax': line_value(pg, '20'),
                            'corpId': ident.group(2) if ident else None})
            if year540 and 'California adjusted gross income' in t and line_value(pg, '17') is not None:
                out.append({'kind': 'personal', 'form': '540', 'year': year540, 'file': f, 'page': i + 1, 'caAgi': line_value(pg, '17')})
            if h:
                W = pg.get_text("words")
                ssn = next((w[4] for w in W if re.match(r'^\d{3}-\d{2}-\d{4}$', w[4]) and w[1] < 120), None)
                first = next((w for w in W if 100 < w[1] < 115 and w[0] < 60), None)
                last = next((w for w in W if first and abs(w[1] - first[1]) < 3 and w[0] > first[0] + 20), None)
                street = [w[4] for w in W if 138 < w[1] < 148 and w[0] < 250]
                city = [w for w in W if 150 < w[1] < 160]
                zipw = next((w[4] for w in city if re.match(r'^\d{5}(-\d{4})?$', w[4])), None)
                out.append({'kind': 'identity', 'year': year540, 'file': f, 'page': i + 1, 'ssn': ssn,
                            'firstName': first[4] if first else None, 'lastName': last[4] if last else None,
                            'street': ' '.join(street) or None, 'zip': zipw, 'filingStatus': filing_status(pg)})
print(json.dumps(out))

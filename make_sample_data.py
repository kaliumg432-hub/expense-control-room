"""Generate synthetic data for the Expense Control Room demo.

Writes, next to this script:
  demo_tende_payments_2026-MM.csv     Tende wallet payment exports (expenses, transfers, funding)
  demo_utility_statement_2026-MM.csv  M-Pesa utility statements (customer revenue)

Every person, payee, phone number, reference and amount is invented. The people and
amounts match the demo defaults inside happynet-expense-control.jsx, so the payment
calendar and payroll screens find their payments. The demo page shifts all dates so the
newest month is always the current month.

Usage:  python make_sample_data.py
"""
import csv, os, random, string, calendar
from datetime import datetime, timedelta

random.seed(4242)
OUT = os.path.dirname(os.path.abspath(__file__))
MONTHS = [(2026, 7), (2026, 8), (2026, 9), (2026, 10)]
MONTH_NAMES = [calendar.month_name[i].lower() for i in range(13)]

WALLET = {
    "overall": "Overall Account (KOC2000)",
    "payroll": "Payroll Wallet (KOC2001)",
    "inventory": "Inventory Wallet (KOC2002)",
    "linkrent": "Internet Link & Rent Wallet (KOC2003)",
    "float": "Variable Float Wallet (KOC2004)",
}
INTERNAL_NAME = "HAPPYNET TECHNOLOGIES LIMITED LIABILITY"
COLS = ["DATE INITIATED", "REF", "ACCOUNT", "SERVICE", "AMOUNT", "CHARGE", "RECEIVER", "NAME",
        "ACCOUNT REF", "REMARK", "INITIATED BY", "APPROVED BY", "REF NO", "STATUS"]

# same invented people as the demo defaults in the app
EMPLOYEES = [  # name, gross, advance, other, addition
    ("Alice Wanjiru Kariuki", 32000, 0, 0, 0), ("Daniel Omondi Okoth", 28000, 3000, 0, 0),
    ("Esther Chebet Koech", 24000, 0, 2000, 0), ("Hassan Abdi Ali", 20000, 0, 0, 2500),
    ("Lucy Nyambura Kinyua", 18000, 0, 0, 0), ("Martin Kiprop Cheruiyot", 16000, 2000, 0, 0),
    ("Naomi Akinyi Otieno", 15000, 0, 0, 0), ("Victor Musyoka Mutiso", 12000, 0, 0, 0),
]
phone_book = {}
def phone(name):
    if name not in phone_book:
        phone_book[name] = f"2547000{len(phone_book) + 101:05d}"
    return phone_book[name]

refs = set()
def ref():
    while True:
        r = "KC" + "".join(random.choices(string.digits, k=8))
        if r not in refs:
            refs.add(r); return r
def mpesa_ref():
    return "U" + "".join(random.choices(string.ascii_uppercase + string.digits, k=9))
def charge(service, amount):
    if service == "SEND M-PESA": return 0 if amount <= 100 else 15 if amount <= 1000 else 30 if amount <= 5000 else 60
    if service in ("PAY BILL", "BUYGOODS"): return 0 if amount <= 1000 else 20
    return 0

rows_by_month = {mk: [] for mk in MONTHS}
def add(mk, day, hour, wallet, service, amount, name, remark, receiver=None, acc_ref="", status="SUCCESS", minute=None):
    y, m = mk
    dt = datetime(y, m, day, hour, minute if minute is not None else random.randint(0, 59), random.randint(0, 59))
    rows_by_month[mk].append({
        "DATE INITIATED": dt.strftime("%Y-%m-%d %H:%M:%S"), "REF": ref(), "ACCOUNT": WALLET[wallet],
        "SERVICE": service, "AMOUNT": f"{amount:.2f}", "CHARGE": f"{charge(service, amount):.2f}",
        "RECEIVER": receiver if receiver is not None else (phone(name) if service == "SEND M-PESA" else ""),
        "NAME": name.upper(), "ACCOUNT REF": acc_ref, "REMARK": remark,
        "INITIATED BY": "Demo Administrator", "APPROVED BY": "Demo Director",
        "REF NO": mpesa_ref() if service != "INCOMING" else "", "STATUS": status,
    })
    return dt

def transfer(mk, day, hour, to_wallet, amount, remark):
    """Wallet-to-wallet move: a send from Overall and the matching receipt."""
    y, m = mk
    minute = random.randint(0, 50)
    add(mk, day, hour, "overall", "SND_TENDE", amount, INTERNAL_NAME, remark, receiver=WALLET[to_wallet], minute=minute)
    add(mk, day, hour, to_wallet, "INCOMING", amount, INTERNAL_NAME, remark, receiver="", minute=minute + 1)

for mi, mk in enumerate(MONTHS):
    y, m = mk
    dim = calendar.monthrange(y, m)[1]
    prev_name = MONTH_NAMES[m - 1 if m > 1 else 12]
    last = mi == len(MONTHS) - 1

    # money in: weekly sweeps from the M-Pesa utility account, one owner loan
    for d in range(1, dim + 1):
        if datetime(y, m, d).weekday() == 0:
            add(mk, d, 9, "overall", "INCOMING", random.choice([95000, 105000, 115000, 125000]), "MPESA UTILITY SETTLEMENT", "weekly revenue sweep", receiver="")
    if mi == 1:
        add(mk, 3, 11, "overall", "INCOMING", 30000, "OWNER LOAN ACCOUNT", "owner loan for payroll", receiver="")

    # wallet funding
    transfer(mk, 1, 8, "linkrent", 100000, "link and rent float")
    transfer(mk, 4, 8, "payroll", 170000, "payroll funding")
    for d in (2, 9, 16, 23):
        transfer(mk, d, 10, "inventory", 25000 + 5000 * mi, "inventory float")
        transfer(mk, d, 10, "float", 12000, "weekly variable float")

    # fixed obligations
    add(mk, random.choice([1, 2]), 10, "linkrent", "PAY BILL", 60000, "Upstream Fibre Ltd", f"internet link {MONTH_NAMES[m]}", receiver="400200", acc_ref="NET-0042")
    add(mk, random.choice([4, 5]), 11, "linkrent", "PAY BILL", 15000, "Greenview Properties", "office rent", receiver="300100", acc_ref="GV-12")
    late = 2 if mi == 2 else 0  # paid late once, with the late fee
    add(mk, 5 + late, 12, "linkrent", "SEND M-PESA", 6000 + 30 * late, "Peter Otieno Ouma", "north site rent")
    add(mk, 7, 9, "linkrent", "PAY BILL", 900, "KPLC Prepaid", "office electricity tokens", receiver="888880", acc_ref="54100099999")
    for rider in ("Brian Kiprono Lagat", "Kevin Mutua Mwangangi"):
        add(mk, 9, 14, "float", "SEND M-PESA", 8000, rider, "bike rent")
    add(mk, 10, 15, "payroll", "SEND M-PESA", 4000, "Grace Achieng Odhiambo", "sunrise court caretaker commission")
    add(mk, 10, 15, "payroll", "SEND M-PESA", [2000, 4000][mi % 2], "Joseph Wekesa Simiyu", "hillview caretaker commission")
    if not last:  # Riverside is left unpaid this month so the demo shows an overdue bill
        add(mk, 10, 16, "payroll", "SEND M-PESA", 1500, "Mercy Nduta Kamau", "riverside caretaker commission")
    add(mk, 13, 10, "linkrent", "SEND M-PESA", 3500, "Samuel Kiptoo Rotich", "link carrier east route")
    add(mk, 19, 11, "float", "PAY BILL", [8000, 8200, 8200, 8500][mi], "NetBill Systems", "oneisp licence", receiver="700700", acc_ref="HN-ISP")

    # payroll for last month's work, on the 5th; advances mid-month
    for i, (name, gross, adv, other, addn) in enumerate(EMPLOYEES):
        net = gross + addn - adv - other
        remark = "staff payments" if name.startswith("Victor") else f"{prev_name} salary"
        add(mk, 5 if i < 6 else 6, 9 + i % 3, "payroll", "SEND M-PESA", net, name, remark)
    add(mk, 18, 12, "payroll", "SEND M-PESA", 3000, "Daniel Omondi Okoth", "salary advance")
    add(mk, 20, 12, "payroll", "SEND M-PESA", 2000, "Martin Kiprop Cheruiyot", "salary advance")

    # inventory purchases, more each month as the network grows
    tenda_price = 900 if mi < 2 else 1000  # supplier raised the price in September
    catalogue = [
        ("{q} tenda routers", (3, 8), tenda_price, "Supplier B Electronics", "BUYGOODS", "600400"),
        ("{q} xpon router", (2, 5), random.choice([1250, 1300]), "Supplier A Networks Ltd", "PAY BILL", "500300"),
        ("fat box 1:8 {q} pcs", (2, 6), 800, "Supplier A Networks Ltd", "PAY BILL", "500300"),
        ("splitter 1:8 {q}", (3, 10), 300, "Supplier C Fibre Supplies", "SEND M-PESA", None),
        ("patch cord {q}", (10, 30), 120, "Supplier A Networks Ltd", "PAY BILL", "500300"),
        ("cable ties {q} pkts", (2, 5), 200, "Supplier C Fibre Supplies", "SEND M-PESA", None),
        ("tension clamp {q}", (5, 15), 250, "Supplier C Fibre Supplies", "SEND M-PESA", None),
        ("atb {q}", (5, 20), 50, "Supplier A Networks Ltd", "PAY BILL", "500300"),
        ("drop cable {q} drums", (1, 2), 7500, "Supplier A Networks Ltd", "PAY BILL", "500300"),
    ]
    for _ in range(8 + 3 * mi):
        text, (lo, hi), price, supplier, svc, till = random.choice(catalogue)
        q = random.randint(lo, hi)
        add(mk, random.randint(1, dim), random.randint(9, 17), "inventory", svc, q * price, supplier, text.format(q=q),
            receiver=till if till else None, acc_ref="HAPPYNET" if svc == "PAY BILL" else "")

    # fuel, transport, welfare, admin, data
    for d in range(1, dim + 1):
        wd = datetime(y, m, d).weekday()
        if wd == 0:
            add(mk, d, 8, "float", "BUYGOODS", random.choice([1000, 1500, 2000]), random.choice(["Rubis Ruiru", "Shell Thika Road"]), "car fuel", receiver="711711")
            add(mk, d, 13, "float", "PAY BILL", random.choice([2000, 3000, 5000]), "Advanta Africa", "advanta bundles", receiver="222222", acc_ref="HN-DATA")
        if wd in (1, 4):
            for amt in random.sample([300, 350, 400, 450, 500], 2):  # two bikes, different top-ups
                add(mk, d, 8, "float", "BUYGOODS", amt, "Total Energies Kimbo", "technicians bike fuel", receiver="733733")
        if wd == 2:
            add(mk, d, 13, "float", "SEND M-PESA", random.choice([600, 900, 1200, 1500]), "Mama Njeri Hotel", "lunch for technicians")
        if wd == 3 and random.random() < 0.7:
            add(mk, d, 15, "float", "SEND M-PESA", random.choice([200, 300, 450, 600]), "City Cabs Rider", "transport to site")
        if random.random() < 0.12:
            add(mk, d, 11, "float", "BUYGOODS", random.choice([100, 200, 350, 500]), "Quickprint Bureau", "printing customer forms", receiver="744744")
        if random.random() < 0.10:
            add(mk, d, 12, "float", "AIRTIME", random.choice([100, 200, 500]), "Safaricom", "airtime for call centre", receiver="")
    add(mk, random.randint(10, 25), 16, "float", "BUYGOODS", random.choice([350, 450]), "Naivas Supermarket", "office supplies toilet paper and detergent", receiver="755755")
    add(mk, random.choice([5, 12, 19, 26]), 10, "float", "PAY BILL", random.choice([2500, 3000]), "KPLC Prepaid", "hotspot tokens week", receiver="888880", acc_ref="54100088888")

    # things the app should flag for review
    add(mk, random.randint(3, 25), 18, "float", "SEND M-PESA", random.choice([1500, 2500]), "James Mwangi Njuguna", "payment")
    if mi == 2:
        add(mk, 22, 9, "float", "BUYGOODS", 4500, "Rubis Ruiru", "car fuel", receiver="711711")      # above the usual fuel range
        add(mk, 24, 14, "float", "SEND M-PESA", 7000, "Welding Works Ruiru", "welding at north site")
        add(mk, 12, 11, "float", "PAY BILL", 3000, "Brightsign Media", "posters advert", receiver="766766")
    if last:  # a couple of odd payments in the newest month too, so the review list is never empty
        add(mk, 6, 9, "float", "BUYGOODS", 4800, "Shell Thika Road", "car fuel", receiver="711711")
        add(mk, 8, 14, "float", "SEND M-PESA", 6500, "Welding Works Ruiru", "welding at north site")
    add(mk, random.randint(2, 26), 17, "float", "SEND M-PESA", 800, "City Cabs Rider", "transport to site", status="FAILED")
    if last:
        add(mk, dim, 16, "float", "SEND M-PESA", 1200, "Mama Njeri Hotel", "lunch for technicians", status="PENDING")

# ---- write Tende exports -----------------------------------------------------------
for mk in MONTHS:
    y, m = mk
    rows = sorted(rows_by_month[mk], key=lambda r: r["DATE INITIATED"])
    name = f"demo_tende_payments_{y}-{m:02d}.csv"
    with open(os.path.join(OUT, name), "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=COLS)
        w.writeheader(); w.writerows(rows)
    print(name, len(rows), "rows")

# ---- M-Pesa utility statements (customer revenue) -----------------------------------------
random.seed(2026)
customers = []
for i in range(520):
    kind = "hotspot" if i < 280 else "ppoe" if i < 495 else "mixed"
    customers.append({"kind": kind, "join": random.choice([0, 0, 0, 1, 2, 3]), "rate": random.uniform(3, 14),
                      "plan": random.choice([1500, 2000, 2500, 3500]), "payday": random.randint(1, 28),
                      "churn": random.random() < 0.15, "id": f"DEMO{1001 + i}"})
balance = 250000.0
for mi, (y, m) in enumerate(MONTHS):
    dim = calendar.monthrange(y, m)[1]
    pays = []
    for c in customers:
        if mi < c["join"] or (c["churn"] and mi - c["join"] >= 2):
            continue
        if c["kind"] in ("hotspot", "mixed"):
            for _ in range(max(0, int(random.gauss(c["rate"], c["rate"] * 0.25)))):
                pays.append((datetime(y, m, random.randint(1, dim), random.randint(6, 22), random.randint(0, 59)), random.choice([10, 20, 30, 50]), c["id"]))
        if c["kind"] in ("ppoe", "mixed"):
            pays.append((datetime(y, m, c["payday"], random.randint(7, 21), random.randint(0, 59)), c["plan"], c["id"]))
    pays.sort()
    name = f"demo_utility_statement_{y}-{m:02d}.csv"
    with open(os.path.join(OUT, name), "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["Account Holder", "DEMO ISP LTD (synthetic data)"])
        w.writerow(["Short Code", "000000"])
        w.writerow(["Time Period", "From", f"01-{m:02d}-{y} 00:00:00", "To", f"{dim:02d}-{m:02d}-{y} 23:59:59"])
        w.writerow([])
        w.writerow(["Receipt No.", "Completion Time", "Initiation Time", "Details", "Transaction Status", "Paid In",
                    "Withdrawn", "Balance", "Balance Confirmed", "Reason Type", "Other Party Info", "Linked Transaction ID", "A/C No.", "Currency"])
        week = 0.0
        for dt, amt, acc in pays:
            balance += amt; week += amt
            ts = dt.strftime("%d-%m-%Y %H:%M:%S")
            w.writerow(["T" + "".join(random.choices(string.ascii_uppercase + string.digits, k=9)), ts, ts, "Pay Bill Online", "Completed",
                        f"{amt:.2f}", "", f"{balance:.2f}", "true", "Pay Utility", "Demo customer", "", acc, "KES"])
            if dt.weekday() == 0 and dt.hour >= 9 and week > 20000:
                balance -= week
                w.writerow(["T" + "".join(random.choices(string.ascii_uppercase + string.digits, k=9)), ts, ts, "Settlement", "Completed",
                            "", f"-{week:.2f}", f"{balance:.2f}", "true", "Utility Account to Organization Settlement Account", "", "", "", "KES"])
                week = 0.0
    print(name, len(pays), "payments")

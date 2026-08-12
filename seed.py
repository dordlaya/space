#!/usr/bin/env python3
"""Seed the live Space Map with N accounts by calling the server's own API.

This talks to the running server over HTTP (POST /api/register), so it reuses the
server's unique name/email enforcement, password hashing and planet placement —
no direct DB poking. Each seeded account gets an email (`<name>@<domain>`) and a
shared password so you can actually log in as any of them afterwards. Stdlib only
(urllib), so it runs anywhere Python does, including inside the pod.

Examples
    python seed.py                          # 100 accounts -> http://127.0.0.1:5173
    python seed.py --count 250              # 250 accounts
    python seed.py --url http://NODE-IP:30081
    python seed.py --prefix Pilot --random  # unique names even across re-runs
    python seed.py --password hunter2        # override the shared password (default 1234)
    python seed.py --email-domain demo.test  # emails become <name>@demo.test
    python seed.py --offline-ratio 0.5      # take ~half offline after registering
"""
import argparse
import json
import random
import time
import urllib.error
import urllib.request

CALLSIGNS = [
    "Nova", "Orion", "Vega", "Lyra", "Draco", "Rigel", "Atlas", "Comet", "Nebula",
    "Pulsar", "Quasar", "Zenith", "Astra", "Cosmo", "Solaris", "Halcyon", "Aurora",
    "Cygnus", "Perseus", "Phoenix", "Titan", "Helios", "Corvus", "Mira", "Sirius",
]


def _post(url, payload):
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url, data=data, headers={"Content-Type": "application/json"}, method="POST"
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read() or b"{}")


def _get(url):
    with urllib.request.urlopen(url, timeout=10) as resp:
        return json.loads(resp.read() or b"{}")


def main():
    ap = argparse.ArgumentParser(description="Seed users into the live Space Map.")
    ap.add_argument("--url", default="http://127.0.0.1:5173",
                    help="base server URL (default: %(default)s)")
    ap.add_argument("--count", type=int, default=100,
                    help="how many users to add (default: %(default)s)")
    ap.add_argument("--prefix", default=None,
                    help="name prefix; default uses random callsigns")
    ap.add_argument("--random", action="store_true",
                    help="append a random suffix so names are unique across re-runs")
    ap.add_argument("--password", default="1234",
                    help="shared password for every seeded account (default: 1234)")
    ap.add_argument("--email-domain", default="spacemap.test",
                    help="emails are <name>@<domain> (not verified for real)")
    ap.add_argument("--offline-ratio", type=float, default=0.0,
                    help="fraction (0..1) to take offline after registering (default: 0)")
    ap.add_argument("--delay", type=float, default=0.0,
                    help="seconds to sleep between registrations (default: 0)")
    args = ap.parse_args()

    if len(args.password) < 4:
        ap.error("--password must be at least 4 characters")

    base = args.url.rstrip("/")
    register_url = f"{base}/api/register"
    status_url = f"{base}/api/status"

    created, taken, failed = 0, 0, 0
    ids = []
    print(f"Seeding {args.count} accounts -> {base} "
          f"(password='{args.password}', emails @{args.email_domain})")
    for i in range(1, args.count + 1):
        if args.prefix:
            name = f"{args.prefix}-{i:03d}"
        else:
            name = f"{random.choice(CALLSIGNS)}-{i:03d}"
        if args.random:
            name = f"{name}-{random.randint(1000, 9999)}"
        # names are capped at 16 chars server-side
        name = name[:16]
        email = f"{name.lower()}@{args.email_domain}"

        try:
            res = _post(register_url, {
                "name": name, "email": email, "password": args.password,
            })
        except urllib.error.HTTPError as e:
            # The server returns 400 with a JSON body for taken names/emails.
            try:
                res = json.loads(e.read() or b"{}")
            except ValueError:
                res = {"ok": False, "error": f"http_{e.code}"}
        except urllib.error.URLError as e:
            failed += 1
            print(f"  [{i}] network error: {e}")
            continue

        if res.get("ok"):
            created += 1
            ids.append(res.get("id"))
        elif res.get("error") in ("name_taken", "email_taken"):
            taken += 1
        else:
            failed += 1

        if i % 25 == 0 or i == args.count:
            print(f"  ...{i}/{args.count}  (created={created} taken={taken} failed={failed})")
        if args.delay:
            time.sleep(args.delay)

    # Optionally take some of the freshly created accounts offline.
    if args.offline_ratio > 0 and ids:
        k = int(len(ids) * min(1.0, args.offline_ratio))
        for uid in random.sample(ids, k):
            try:
                _post(status_url, {"id": uid, "value": False})
            except urllib.error.URLError:
                pass
        print(f"Took {k} accounts offline (offline-ratio={args.offline_ratio}).")

    try:
        total = len(_get(f"{base}/api/state").get("users", []))
        print(f"Done. created={created} taken={taken} failed={failed} | roster now has {total} users.")
    except urllib.error.URLError:
        print(f"Done. created={created} taken={taken} failed={failed}.")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Phase-0 grounding spike: score local vision models on click-grounding.

For each (model, test case): send screenshot + instruction, parse a click
coordinate from the reply, and check whether it lands inside the target box
(ScreenSpot-style click accuracy). Also records latency and decode tok/s.

Stdlib only. Usage: python3 run.py "model1" "model2" ...
"""
import base64, json, os, re, sys, time, urllib.request

DIR = os.path.dirname(os.path.abspath(__file__))
GT = json.load(open(os.path.join(DIR, "ground_truth.json")))
VW, VH = GT["viewport"]["w"], GT["viewport"]["h"]
OLLAMA = os.environ.get("OLLAMA_ENDPOINT", "http://localhost:11434") + "/api/chat"

PROMPT = (
    "You are a web UI grounding model. The image is a {w}x{h} pixel screenshot "
    "of a web page. Task: {instr}\n"
    "Reply with ONLY the pixel coordinates of the single point to click, as "
    "JSON: {{\"x\": <int>, \"y\": <int>}}. Coordinates are in image pixels "
    "(0,0 = top-left, max x={w}, max y={h})."
)

def b64(path):
    with open(path, "rb") as f:
        return base64.b64encode(f.read()).decode()

def ask(model, img_b64, instr):
    body = {
        "model": model,
        "messages": [{
            "role": "user",
            "content": PROMPT.format(w=VW, h=VH, instr=instr),
            "images": [img_b64],
        }],
        "stream": False,
        "options": {"temperature": 0},
    }
    req = urllib.request.Request(
        OLLAMA, data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"})
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=600) as r:
        data = json.load(r)
    wall = time.time() - t0
    txt = data.get("message", {}).get("content", "")
    ec = data.get("eval_count", 0)
    ed = data.get("eval_duration", 0) or 1
    toks = ec / (ed / 1e9) if ed else 0
    return txt, wall, toks

def parse_xy(txt):
    # Prefer explicit JSON x/y
    mx = re.search(r'"?x"?\s*[:=]\s*(-?\d+(?:\.\d+)?)', txt, re.I)
    my = re.search(r'"?y"?\s*[:=]\s*(-?\d+(?:\.\d+)?)', txt, re.I)
    if mx and my:
        return float(mx.group(1)), float(my.group(1))
    # Fallback: first pair of numbers
    nums = re.findall(r'-?\d+(?:\.\d+)?', txt)
    if len(nums) >= 2:
        return float(nums[0]), float(nums[1])
    return None

def in_box(x, y, box):
    return box[0] <= x <= box[2] and box[1] <= y <= box[3]

def score_point(xy, box):
    """Try raw-pixel and 0-1000-normalized interpretations; return (hit, mode)."""
    if not xy:
        return False, "noparse"
    x, y = xy
    if in_box(x, y, box):
        return True, "raw"
    # normalized 0..1000 -> scale to viewport
    xn, yn = x / 1000 * VW, y / 1000 * VH
    if in_box(xn, yn, box):
        return True, "norm1000"
    return False, "raw"

def main():
    models = sys.argv[1:]
    if not models:
        print("usage: run.py <model> [model ...]"); return
    results = {}
    for model in models:
        print(f"\n===== {model} =====")
        rows = []
        for c in GT["cases"]:
            img = b64(os.path.join(DIR, "shots", c["id"] + ".png"))
            try:
                txt, wall, toks = ask(model, img, c["instruction"])
            except Exception as e:
                print(f"  {c['id']:10s} ERROR {e}")
                rows.append({"id": c["id"], "hit": False, "err": str(e)})
                continue
            xy = parse_xy(txt)
            hit, mode = score_point(xy, c["bbox"])
            rows.append({"id": c["id"], "hit": hit, "mode": mode, "xy": xy,
                         "bbox": c["bbox"], "wall": wall, "toks": toks,
                         "raw": txt.strip()[:120]})
            flag = "HIT " if hit else "miss"
            print(f"  {c['id']:10s} {flag} xy={xy} ({mode})  {wall:.1f}s  "
                  f"{toks:.0f} tok/s  :: {txt.strip()[:80]!r}")
        hits = sum(1 for r in rows if r.get("hit"))
        walls = [r["wall"] for r in rows if "wall" in r]
        avg = sum(walls) / len(walls) if walls else 0
        print(f"  ---- {hits}/{len(GT['cases'])} hits, avg {avg:.1f}s/call")
        results[model] = {"hits": hits, "n": len(GT["cases"]),
                          "avg_wall": avg, "rows": rows}
    json.dump(results, open(os.path.join(DIR, "out", "results.json"), "w"), indent=2)
    print("\nSaved -> out/results.json")

if __name__ == "__main__":
    main()

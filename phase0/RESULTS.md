# Phase 0 — Feasibility spike results

Date: 2026-06-28 · Hardware: Mac M3 Pro, 18GB · Engine: Ollama **0.30.10** (isolated, port 11436)

## TL;DR
- **Vision grounding on a local 3B model is viable on 18GB.** Holo1.5-3B hit **3/4** of the
  grounding cases at **~55–59 tok/s** decode, ~5s/call (image-prefill dominated).
- **Engine ≥ 0.30.x is mandatory.** Ollama 0.22.1 cannot run Qwen2.5-VL-class models
  (fails `GGML_ASSERT(n_pos_per_embd()==1)` — no M-RoPE support). koretex already pins 0.30.10.
- **Holo1.5-3B is the validated default grounder.** It works out-of-the-box with a simple
  JSON-coordinate prompt and disambiguates among distractors.

## Test set
4 realistic pages rendered at exactly 1280×800 (search, login, cookie-banner w/ distractor,
product grid w/ 2 distractors). Metric = ScreenSpot-style: does the predicted click land inside
the target element's box? See `pages/`, `shots/`, `ground_truth.json`, `run.py`.

## Results

| Model | Result | Notes |
|---|---|---|
| **Holo1.5-3B** Q4_K_M (`hf.co/mradermacher/Holo1.5-3B-GGUF`) | **3/4 hits**, 55–59 tok/s, ~5s/call | search ✅ login ✅ **products ✅ (picked correct 2nd-of-3 button)** · cookie ❌ (clicked banner text region, not Reject) |
| UI-TARS-1.5-7B Q4_K_M (`hf.co/mradermacher/UI-TARS-1.5-7B-GGUF`) | 0/4, 38–67s/call | Garbage output (`@@@`, repetition loops, malformed JSON) + a 500. Needs UI-TARS *native* action-prompt format, not generic JSON; 7B heavy on 18GB. Deprioritized for v1. |
| qwen2.5vl:3b (Ollama library, baseline) | 0/4, empty output | Library packaging embeds vision (no separate projector layer); returns empty on 0.30.10 even for "describe this image". Packaging quirk, not hardware. Fair base-vs-finetune control deferred (would need a GGUF with separate mmproj). |

Raw per-case output in `out/results.json`.

## Per-case detail (Holo1.5-3B)
- **search** → (867,394) ∈ [830,360,940,408] ✅
- **login** → (597,496) ∈ [540,470,740,516] ✅
- **products** → (579,546) ∈ [500,520,700,564] ✅ — correctly chose the *middle* card's button despite two identical distractors
- **cookie** → (749,735); target Reject [980,720,1090,762] ❌ — landed in the banner text, not the button (distractor/edge case)

## Findings that shape the build
1. **Default grounder = Holo1.5-3B.** Accurate, fast, simple prompting, fits 18GB with headroom.
2. **Engine requirement locked: Ollama ≥ 0.30.x** (0.30.10 verified). This is the same build
   koretex now pins, so the browser-use grounder and a koretex VLM node run the *identical* engine.
3. **Latency is image-prefill bound (~5s/call).** Downscaling / viewport-cropping screenshots is a
   first-class lever for Phase 2, not an afterthought.
4. **UI-TARS-7B deprioritized** — needs native prompting + better quant; revisit only if we need a
   single end-to-end model.
5. **koretex VLM path is effectively dogfooded** — Holo serves over `/v1/chat/completions` on the
   pinned engine, exactly as a koretex VLM node would.

## How to reproduce
```
# isolated engine (already downloaded under scratchpad/ollama030):
OLLAMA_HOST=127.0.0.1:11436 DYLD_LIBRARY_PATH=<dir> ./ollama serve &
cd phase0
OLLAMA_ENDPOINT=http://127.0.0.1:11436 python3 run.py "hf.co/mradermacher/Holo1.5-3B-GGUF:Q4_K_M"
```

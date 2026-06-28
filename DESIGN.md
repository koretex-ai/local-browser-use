# Local Browser Use — Architecture & Implementation Plan

> Status: **Design draft** (no implementation yet). Last updated 2026-06-28.
>
> A vision-native AI agent that lives as a sidebar in your existing browser, runs
> entirely on a local Ollama model, and performs web tasks on your behalf inside
> your real, logged-in session.

---

## 1. Goals & non-goals

**Goals**
- Chat with a local model (Ollama on M3 Pro / 18GB) and have it drive the browser.
- Operate as a **side panel** docked next to the user's current tab.
- Act inside the user's **real, authenticated** browser session (no fresh sandbox).
- **Vision-native** architecture, with models swappable per role.
- Capture every interaction as clean **training data** from commit #1 (the flywheel).

**Non-goals (v1)**
- No cloud models, no account/login system, no multi-user backend.
- No Chromium fork (kept as a possible future escape hatch).
- No headless/server automation — this is about the user's live browser.

---

## 2. Locked decisions (from research phase)

| Area | Decision |
|---|---|
| **Hardware target** | Mac M3 Pro, 18GB unified memory. ~8–10GB usable for models. |
| **Model strategy** | Swappable core. **Default: Holo1.5-3B grounder + small text planner.** UI-TARS-1.5-7B kept as the single-model Phase-0 benchmark. |
| **Perception** | **Hybrid**: DOM / set-of-marks default, pixel-vision grounding fallback. Capture **both** signals per action (vision-superset data). |
| **Shell** | Fork Nanobrowser for MV3 side-panel + plumbing **only**. Agent core built fresh. |
| **Reference architecture** | Surfer-H + Holo1 (policy / localizer / validator separation). |
| **Cross-cutting** | Typed action space == training-label schema. Trajectory + human-correction logging from day one. |
| **Runtime** | Ollama (MLX-backed on Apple Silicon). OpenAI-compatible endpoint. |

---

## 3. High-level architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Browser (user's real Chrome, logged-in session)             │
│                                                               │
│  ┌───────────────┐        ┌──────────────────────────────┐   │
│  │  Active tab    │◄──────►│  Side Panel (UI shell)       │   │
│  │  (content      │ actions│  - chat                      │   │
│  │   script /     │ + obs  │  - task status / steps       │   │
│  │   CDP)         │        │  - approve/correct controls  │   │
│  └───────┬────────┘        └──────────────┬───────────────┘   │
│          │                                │                   │
│  ┌───────▼────────────────────────────────▼───────────────┐  │
│  │  Background service worker  =  AGENT CORE                │  │
│  │                                                          │  │
│  │   Perception → Planner → Grounder → Executor → Validator │  │
│  │                      ▲                    │              │  │
│  │                      └──── loop ──────────┘              │  │
│  │                                                          │  │
│  │   Trajectory Logger (taps every stage)                   │  │
│  └───────────────┬──────────────────────────┬──────────────┘  │
└──────────────────┼──────────────────────────┼─────────────────┘
                   │                          │
        ┌──────────▼─────────┐     ┌──────────▼──────────┐
        │  Model Runtime     │     │  Local Data Store    │
        │  (Ollama / MLX)    │     │  (trajectories,      │
        │  grounder + planner│     │   corrections)       │
        └────────────────────┘     └──────────────────────┘
```

The agent core is a set of **decoupled modules behind clean interfaces** so any
model or perception strategy can be swapped without touching the loop.

---

## 4. Component breakdown

### 4.1 Extension shell (forked from Nanobrowser — plumbing only)
- MV3 manifest, `sidePanel` API, message passing, options/config page.
- Content script for DOM extraction + action execution in-page.
- **What we keep:** boilerplate, side-panel wiring, provider config UI.
- **What we discard/replace:** the LangChain-based, text/DOM-centric agent loop.

### 4.2 Agent core (orchestrator) — built fresh
The control loop. Owns state (current task, step history, retry budget) and
sequences the modules. Lives in the background service worker.

### 4.3 Perception module (hybrid)
Produces an **Observation** for the current page state:
- **DOM / accessibility path (default):** extract interactive elements, assign
  set-of-marks IDs, capture role/text/bounding-box.
- **Vision path (fallback + always-captured):** downscaled screenshot, optionally
  with SoM overlay. Used for grounding when DOM is opaque; *always* recorded for
  training even when DOM path is used.
- Emits both representations so every action has a DOM label **and** pixel coords.

### 4.4 Grounder module
Maps a target description → a concrete element / coordinate.
- Default model: **Holo1.5-3B** (web-tuned visual grounding).
- Interface accepts (observation, target intent) → returns element ID + coords +
  confidence. Swappable to UI-TARS, GUI-Actor, UGround, or DOM-only matching.

### 4.5 Planner module
Decides the next high-level action from task + history + observation.
- Default: small local text model (reasons over SoM-labelled element list).
- Outputs a single typed action from the action space (§5.1).
- Swappable; in the UI-TARS single-model benchmark, planner+grounder collapse
  into one model call.

### 4.6 Action executor
Performs the action in the page.
- v1: content-script DOM events + synthetic input.
- Abstracted so a **CDP / native-messaging** backend can replace it later for
  things the extension sandbox blocks (downloads, file choosers, cross-tab).

### 4.7 Validator
After each action, checks whether it had the intended effect; drives retry /
replan / ask-the-human. Mirrors the Surfer-H validator role.

### 4.8 Trajectory logger (cross-cutting)
Taps every stage and writes a structured record (§5.3) to the local store.
Captures human approvals/corrections as preference signal.

### 4.9 Model runtime
Ollama with MLX backend, OpenAI-compatible API. Handles the `OLLAMA_ORIGINS`
CORS config for the extension origin. Manages which model serves which role.

---

## 5. Data contracts (designed to double as training schemas)

### 5.1 Action space (typed; this IS the training label format)
```
navigate(url)
click(target)            # target = {som_id, coords:[x,y], description}
type(target, text)
scroll(direction, amount)
select(target, option)
key(combo)               # e.g. "Enter", "Cmd+L"
wait(ms | condition)
extract(query) -> data   # read info back to the user
ask_user(question)       # clarify / confirm
done(summary)
```
Every action carries enough to replay it **and** to train on it.

### 5.2 Observation record
```
{
  url, title, timestamp,
  dom_elements: [{ som_id, role, text, bbox, attrs }],
  screenshot: { ref, width, height, scale },   # downscaled
  viewport: { w, h, scroll_x, scroll_y }
}
```

### 5.3 Trajectory record (the flywheel unit)
```
{
  task_id, step_index,
  observation,                      # §5.2
  planner_input, planner_reasoning, # for SFT on planning
  chosen_action,                    # §5.1 — the label
  grounder_target, grounder_conf,   # for ScreenSpot-style grounding SFT
  outcome: success | fail | corrected,
  human_correction?: { corrected_action, note },  # DPO/RLHF signal
}
```
Aligned to **ScreenSpot** (grounding) and **WebVoyager / Mind2Web** (trajectory)
formats so data is trainable without reprocessing.

---

## 6. The agent control loop

```
1. Receive task (chat) → Planner sets intent.
2. Perceive: build Observation (DOM SoM + downscaled screenshot).
3. Plan: Planner picks next typed action.
4. Ground (if action targets an element): Grounder resolves target.
5. Confirm if action is destructive/sensitive (§7) → else proceed.
6. Execute via Action Executor.
7. Validate: did it work? 
      success → log, goto 2
      fail    → retry / replan (bounded) → if exhausted, ask_user
8. done() → summarize to user.
   (Every step → Trajectory Logger.)
```

---

## 7. Safety & guardrails

- **Human-in-the-loop confirmation** for irreversible/sensitive actions:
  purchases, sends (email/message/post), deletes, payments, auth changes.
- **No financial transactions** executed autonomously — always confirm.
- **URL/link safety:** verify unfamiliar destinations before navigating.
- **Bounded autonomy:** max steps / retries per task; visible stop button.
- **Visibility:** every step shown in the side panel before/after execution.
- Confirmations and corrections are *also* logged as training signal.

---

## 8. Data flywheel pipeline (future, but designed-for now)

```
sidebar usage → trajectory records → local store
   → (opt-in) export → curate/filter → 
      SFT (Qwen2.5-VL backbone, like Holo1/PAL-UI)
      → DPO from human corrections
      → RL (rule-based reward, GUI-R1 style) on task success
   → improved local model → ship back to sidebar
```
Backbone parity matters: Holo1 is built on Qwen2.5-VL, and PAL-UI / GUI-R1 show
SFT/RL working on that same backbone — so our collected data trains the model we
already run.

---

## 9. Phased implementation plan

> Each phase ends with a concrete, testable artifact. Still design-gated —
> implementation begins only after plan sign-off.

**Phase 0 — Feasibility spike (decide before building). ✅ DONE — see `phase0/RESULTS.md`.**
- Stand up Ollama with Holo1.5-3B and UI-TARS-1.5-7B (4-bit) on the M3.
- Run a fixed set of real web tasks through each, measuring grounding accuracy,
  latency/tok-s, memory headroom, failure modes.
- **Outcome:** Holo1.5-3B validated as default grounder (3/4 hits, ~55 tok/s, ~5s/call,
  fits 18GB). **Engine ≥ Ollama 0.30.x is mandatory** (0.22.1 can't run Qwen2.5-VL — no
  M-RoPE); 0.30.10 verified (same build koretex pins). UI-TARS-7B deprioritized (needs
  native prompting). Latency is image-prefill bound → screenshot downscaling is a Phase-2 lever.

**Phase 1 — Shell + chat loop.**
- Fork Nanobrowser, strip to side-panel + messaging + Ollama provider.
- End-to-end chat with the local model in the side panel (no actions yet).
- **Exit:** can converse with the local model docked beside a tab.

**Phase 2 — Perception + action executor.**
- DOM/SoM extraction; downscaled screenshot capture; basic action executor
  (click/type/scroll/navigate) via content script.
- **Exit:** can manually trigger each action type on a live page.

**Phase 3 — Agent loop (single model first).**
- Wire Planner→Grounder→Executor→Validator with the UI-TARS single-model path.
- Bounded retries; step display in side panel.
- **Exit:** completes a simple multi-step task (e.g. search + open result).

**Phase 4 — Modular models + hybrid grounding.**
- Split into Holo1.5-3B grounder + text planner; add vision fallback grounding.
- Benchmark modular vs single-model on the Phase-0 task set; lock the default.
- **Exit:** robust on the task set; default config chosen by measurement.

**Phase 5 — Trajectory logging + guardrails.**
- Implement trajectory records (§5.3), human-correction capture, confirmation
  gates for sensitive actions.
- **Exit:** every run produces clean, training-ready records; safety gates live.

**Phase 6 (optional) — CDP/native escape hatch.**
- Add CDP backend behind the executor interface for sandbox-blocked actions.

---

## 10. Risks & open questions

- **Small-model reliability.** 3B grounding on dense real-world pages may be
  shaky; hybrid + validator is the mitigation, Phase 0 is the proof.
- **Vision token latency.** Full screenshots are token-heavy; downscale/tile/crop
  is mandatory. Measure in Phase 0.
- **Memory pressure** running planner + grounder + Chrome on 18GB; may force
  3B-only or a single-model config.
- **Set-of-marks quality** on complex SPAs (shadow DOM, iframes) — vision
  fallback covers gaps.
- **MV3 sandbox limits** (file uploads/downloads, cross-tab) — deferred to the
  Phase-6 CDP path.
- **Open:** local store format for trajectories (IndexedDB vs file export) and
  the opt-in/export UX for the flywheel.

---

## 11. Tentative tech stack

- **Extension:** TypeScript, MV3, React side panel (inherited from Nanobrowser).
- **Models:** Holo1.5-3B (grounder), small text planner, UI-TARS-1.5-7B (bench).
- **Runtime:** Ollama + MLX, OpenAI-compatible API.
- **Data:** typed schemas (§5); local store TBD (Phase 5).
- **Build:** keep Nanobrowser's Turbo/Vite/pnpm setup unless it fights us.
```

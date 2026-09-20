# Opportunist Research Agent

A local-first research and opportunity-discovery agent: **the model is the brain; your PC is the body.**

The runtime is designed to hunt for concrete opportunities rather than merely explain how a user could find them.

## Configurable brain

The agent supports two API paths behind the `BrainProvider` interface:

- **OpenRouter** — use one OpenRouter key and select an OpenRouter model such as `deepseek/deepseek-v4.1-flash`.
- **Direct DeepSeek** — send requests straight to `https://api.deepseek.com` using `deepseek-flash`, the current API name for DeepSeek V4.1 Flash.

DeepSeek's current API supports OpenAI-compatible Chat Completions, Responses API, and tool calls. The current `deepseek-flash` model has a 1M-token context window and supports tool calls.

Choose the provider with:

```env
BRAIN_PROVIDER=openrouter
```

or:

```env
BRAIN_PROVIDER=deepseek
```

Direct DeepSeek does **not** route through OpenRouter.

The provider is selected at startup; discovery, evidence, scoring, storage, and the CLI stay unchanged.

## Local-first efficiency

The model is **not** called for ordinary computation or web transport.

- Web search, HTTP fetching, DNS, contact extraction, crawling, scoring, persistence, and deduplication run locally.
- The default agent uses **3 model phases**: discovery, verification, final synthesis.
- Phase 1 exposes only discovery tools; phase 2 exposes verification tools; phase 3 exposes no tools.
- Independent tool calls are batched in parallel.
- Raw HTML and large tool payloads are compacted locally before being returned to the model.
- An optional fallback model is used only when the primary model/provider fails.

This keeps the API for tasks that genuinely benefit from reasoning rather than using it as a general-purpose data pipeline.

## What is implemented

- **Provider-isolated brain** with selectable OpenRouter or direct DeepSeek.
- **DeepSeek V4.1 Flash** as the default cost-efficient agentic model.
- **Tool-driven research loop** with bounded phases and parallel independent tool calls.
- **Free/configurable web discovery** using DuckDuckGo HTML search by default, or a SearXNG endpoint.
- **Business discovery** across multiple public-web query patterns.
- **Evidence gathering** from public pages, contacts, domains, and social profiles.
- **Website classification** that treats absence cautiously instead of equating one HTTP failure with “no website.”
- **Robots-aware bounded crawling** with same-origin page limits.
- **Deterministic opportunity scoring** so the LLM does not invent the ranking logic.
- **Validated local persistence** in `data/opportunities.jsonl` for reusable research memory.
- **GitHub Actions CI** for TypeScript build and core tests.

## First target workflow

Example request:

```text
Find businesses in Abuja that appear to operate without an independent website. Return 20 strong opportunities with evidence, public source links, contact information where available, confidence, and an opportunity score.
```

The agent should:

```text
USER INTENT
    ↓
OPPORTUNITY DEFINITION
    ↓
LOCAL DISCOVERY
    ↓
LOCAL INVESTIGATION
    ↓
LOCAL VERIFICATION
    ↓
DETERMINISTIC SCORING
    ↓
ONE COMPACT FINAL SYNTHESIS
    ↓
ACTIONABLE RESULTS + SOURCE LINKS
```

A “no website” result is treated as a classification supported by multiple observations such as public business listings, social presence, candidate-domain checks, and reachable-site checks. It is not inferred from a single failed request.

## Setup

Requirements: Node.js 20+.

```bash
npm install
cp .env.example .env
```

On Windows Git Bash, `cp` works; PowerShell users can use `Copy-Item .env.example .env`.

### OpenRouter

```env
BRAIN_PROVIDER=openrouter
OPENROUTER_API_KEY=your_key_here
OPENROUTER_MODEL=deepseek/deepseek-v4.1-flash
OPENROUTER_FALLBACK_MODELS=
```

### Direct DeepSeek

```env
BRAIN_PROVIDER=deepseek
DEEPSEEK_API_KEY=your_key_here
DEEPSEEK_MODEL=deepseek-flash
```

DeepSeek's official documentation lists `https://api.deepseek.com` as the OpenAI-compatible base URL and `deepseek-flash` as the current V4.1 Flash API model name.

Shared runtime settings:

```env
SEARCH_BACKEND=duckduckgo
MAX_AGENT_STEPS=3
MAX_REQUESTS=40
BRAIN_MIN_INTERVAL_MS=750
BRAIN_MAX_OUTPUT_TOKENS=900
REQUEST_TIMEOUT_MS=15000
DATA_DIR=./data
```

Run:

```bash
npm run build
npm test
npm start -- "Find 5 Abuja businesses that appear to have no independent website. Verify each lead and return source links."
```

Development mode:

```bash
npm run dev -- "Find 10 salons in Abuja with active social profiles but no independent website."
```

## Search backends

The default backend is DuckDuckGo HTML because it requires no separate search API key. For stronger control, configure SearXNG:

```env
SEARCH_BACKEND=searxng
SEARXNG_URL=https://your-searxng-instance/search
```

Search availability, ranking, and rate limits vary by backend. The agent treats search as discovery evidence, not ground truth.

## Architecture

```text
                    CONFIGURED BRAIN
              ┌───────────┴────────────┐
              │                        │
        OpenRouter              Direct DeepSeek
              │                        │
              └──────────┬─────────────┘
                         │ only at decision points
                         ▼
                LOCAL RESEARCH BODY
        ┌─────────────────┼─────────────────┐
        ▼                 ▼                 ▼
     Discovery          Evidence          Memory
     ├ search           ├ fetch            └ opportunities.jsonl
     ├ businesses       ├ contacts
     └ socials          ├ domain checks
                        └ website status
        │                 │
        └─────────┬───────┘
                  ▼
           Opportunity Engine
           ├ score
           ├ rank
           └ explain with sources
```

## Important boundaries

This project is local-first and evidence-driven. It works with public information and does not bypass authentication, paywalls, CAPTCHAs, or access controls. Crawling is bounded and respects fetched robots rules.

The brain is deliberately replaceable. The next provider can implement the same `BrainProvider` interface without changing discovery, evidence, scoring, storage, or the CLI.

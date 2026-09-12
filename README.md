# Opportunist Research Agent

A local-first research and opportunity-discovery agent: **Grok is the brain; your PC is the body.**

The runtime is designed to hunt for concrete opportunities rather than merely explain how a user could find them.

## What is implemented

- **Grok/xAI brain** using the xAI OpenAI-compatible Responses API.
- **Tool-driven research loop** with bounded steps and parallel independent tool calls.
- **Free/configurable web discovery** using DuckDuckGo HTML search by default, or a self-hosted/selected SearXNG endpoint.
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
DISCOVERY
    ↓
INVESTIGATION
    ↓
VERIFICATION
    ↓
DETERMINISTIC SCORING
    ↓
PERSISTENCE
    ↓
ACTIONABLE RESULTS + SOURCE LINKS
```

A “no website” result is treated as a classification supported by multiple observations such as public business listings, social presence, candidate-domain checks, and reachable-site checks. It is not inferred from a single failed request.

## Setup

Requirements: Node.js 20+.

```bash
npm install
copy .env.example .env
```

On PowerShell, `copy` works as the alias for `Copy-Item`; on macOS/Linux use `cp .env.example .env`.

Put your xAI API key in `.env`:

```env
XAI_API_KEY=your_key_here
XAI_MODEL=grok-4.6
SEARCH_BACKEND=duckduckgo
MAX_AGENT_STEPS=20
MAX_REQUESTS=60
REQUEST_TIMEOUT_MS=15000
DATA_DIR=./data
```

xAI currently documents `grok-4.6` as its flagship model for agentic tasks, and the xAI API is OpenAI-compatible. New integrations are directed toward the Responses API. citeturn478059search0turn478059search2turn478059search8

Run:

```bash
npm run build
npm test
npm start -- "Find 20 Abuja businesses that appear to have no independent website. Verify each lead and return source links."
```

Development mode:

```bash
npm run dev -- "Find 10 salons in Abuja with active social profiles but no independent website."
```

## Search backends

The default backend is DuckDuckGo HTML because it requires no separate search API key. For stronger control, run or use a SearXNG instance:

```env
SEARCH_BACKEND=searxng
SEARXNG_URL=https://your-searxng-instance/search
```

Search availability, ranking, and rate limits vary by backend. The agent treats search as discovery evidence, not ground truth.

## Architecture

```text
                  GROK / xAI
                 ┌───────────┐
                 │   BRAIN   │
                 │ planning  │
                 │ reasoning │
                 │ decisions │
                 └─────┬─────┘
                       │ tool calls
                       ▼
              LOCAL RESEARCH RUNTIME
        ┌──────────────┼────────────────┐
        ▼              ▼                ▼
     Discovery      Evidence         Memory
     ├ search       ├ fetch           └ opportunities.jsonl
     ├ businesses   ├ contacts
     └ socials      ├ domain checks
                    └ website status
                       │
                       ▼
                Opportunity Engine
                ├ score
                ├ rank
                └ explain with sources
```

## Important boundaries

This project is intentionally local-first and evidence-driven. It works with public information and does not bypass authentication, paywalls, CAPTCHAs, or access controls. Crawling is bounded and respects fetched robots rules.

For production-grade research, the next upgrades are richer entity resolution, source-specific parsers, browser automation for JavaScript-heavy sites, structured claim graphs, multi-provider brain adapters, exports, scheduled hunts, and a desktop UI. The current architecture is deliberately prepared for those additions without replacing the local execution model.

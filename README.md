# Opportunist Research Agent

A local-first research and opportunity-discovery agent: **the model is the brain; your PC is the body.**

The runtime is designed to hunt for concrete opportunities rather than merely explain how a user could find them.

## Current brain

The default brain is **Groq + `openai/gpt-oss-120b`**. Groq exposes an OpenAI-compatible API, and its current GPT-OSS 120B model supports tool use, browser search, code execution, structured outputs, reasoning, and a 131K context window. The code keeps the model configurable so other compatible providers/models can be added without changing the research runtime.

## What is implemented

- **Provider-isolated brain** with Groq as the first provider.
- **GPT-OSS 120B** as the default agentic model.
- **Tool-driven research loop** with bounded steps and parallel independent tool calls.
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
cp .env.example .env
```

On Windows Git Bash, `cp` works; PowerShell users can use `Copy-Item .env.example .env`.

Put your Groq API key in `.env`:

```env
GROQ_API_KEY=your_key_here
GROQ_MODEL=openai/gpt-oss-120b
SEARCH_BACKEND=duckduckgo
MAX_AGENT_STEPS=20
MAX_REQUESTS=60
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
                 ┌───────────────┐
                 │ Groq / GPT-OSS│
                 │ reasoning     │
                 │ planning      │
                 │ tool calls    │
                 └───────┬───────┘
                         │
                         ▼
                LOCAL RESEARCH BODY
        ┌────────────────┼────────────────┐
        ▼                ▼                ▼
     Discovery        Evidence         Memory
     ├ search         ├ fetch           └ opportunities.jsonl
     ├ businesses     ├ contacts
     └ socials        ├ domain checks
                      └ website status
                         │
                         ▼
                  Opportunity Engine
                  ├ score
                  ├ rank
                  └ explain with sources
```

## Important boundaries

This project is local-first and evidence-driven. It works with public information and does not bypass authentication, paywalls, CAPTCHAs, or access controls. Crawling is bounded and respects fetched robots rules.

The brain is deliberately replaceable. The next provider can implement the same `BrainProvider` interface without changing discovery, evidence, scoring, storage, or the CLI.

# Opportunist Research Agent

A local-first **opportunity hunting engine**: the model is the decision brain, while your PC performs the high-volume research.

The goal is not to answer “how could I find an opportunity?” It is to **find concrete opportunities**, verify the underlying evidence, remove duplicates, score them, and return source-linked targets.

## What this version does

The runtime now uses a three-layer research architecture:

```text
USER OBJECTIVE
      │
      ▼
LLM STRATEGY PLAN
      │
      ▼
LOCAL DISCOVERY (parallel)
      │
      ├── web search
      ├── source diversity
      └── candidate extraction
      │
      ▼
ENTITY RESOLUTION
      │
      ├── name normalization
      ├── phone normalization
      ├── URL canonicalization
      └── duplicate merging
      │
      ▼
LOCAL VERIFICATION (parallel)
      │
      ├── source cross-checks
      ├── page fetching
      ├── website checks
      ├── contact extraction
      ├── freshness signals
      └── contradiction-aware evidence
      │
      ▼
OPPORTUNITY ENGINE
      │
      ├── confidence
      ├── evidence strength
      ├── commercial/job signals
      └── deterministic score
      │
      ▼
OPTIONAL LOCAL/LLM REFINEMENT
      │
      ▼
ONE COMPACT FINAL SYNTHESIS
```

The model is **not** used as a web transport layer. Search, fetching, normalization, deduplication, verification, scoring, and persistence happen locally.

## Opportunity domains

### Job hunting

The job strategy searches multiple source families instead of relying on one website:

- LinkedIn Jobs
- Jobberman
- HotNigerianJobs
- MyJobMag
- Indeed Nigeria
- LEEP Jobs

It looks for job title, employer, location, freshness, application signals, source diversity, and duplicate listings.

### Business / digital-gap opportunities

The business strategy is designed for opportunities such as:

- businesses that appear to have no independent website
- businesses with active social presence but weak web presence
- businesses whose online identity is inconsistent
- possible website/digital-presence leads

A business is not classified as “no website” because one request fails. The engine looks for multiple observations and avoids treating generic listicles or lead-generation landing pages as a verified business entity.

## Brain providers

The same research engine can use different LLM providers:

### Direct DeepSeek

```env
BRAIN_PROVIDER=deepseek
DEEPSEEK_API_KEY=your_key_here
DEEPSEEK_MODEL=deepseek-flash
```

This talks directly to DeepSeek rather than routing through OpenRouter.

### OpenRouter

```env
BRAIN_PROVIDER=openrouter
OPENROUTER_API_KEY=your_key_here
OPENROUTER_MODEL=deepseek/deepseek-v4.1-flash
OPENROUTER_FALLBACK_MODELS=
```

Provider selection does not change the local discovery and verification engine.

## Token and request efficiency

The primary optimization target is **capability per model call**, not minimizing calls at any cost.

The current design therefore:

- uses the LLM for strategy and interpretation rather than raw crawling
- runs independent searches in parallel
- batches local verification
- keeps only compact evidence envelopes for model input
- uses a single final synthesis call
- makes a refinement call only when the first pass is weak
- avoids repeatedly sending whole HTML pages to the model
- verifies only a bounded set of candidates
- keeps HTTP budgets separate from LLM budgets

This makes it possible to perform much more web research than a loop that calls the model after every individual search or fetch.

## Research state

Candidates carry structured state rather than existing only in a temporary prompt:

```text
candidate
├── identity
├── job/business type
├── location
├── source URLs
├── observed facts
├── evidence
├── status
├── confidence
└── opportunity score
```

That state is then converted into a compact evidence envelope for final synthesis.

## Running it

Requirements: Node.js 20+.

```bash
npm install
cp .env.example .env
```

### Direct DeepSeek

```env
BRAIN_PROVIDER=deepseek
DEEPSEEK_API_KEY=your_key_here
DEEPSEEK_MODEL=deepseek-flash
```

### OpenRouter

```env
BRAIN_PROVIDER=openrouter
OPENROUTER_API_KEY=your_key_here
OPENROUTER_MODEL=deepseek/deepseek-v4.1-flash
OPENROUTER_FALLBACK_MODELS=
```

Shared settings:

```env
SEARCH_BACKEND=duckduckgo
MAX_REQUESTS=40
BRAIN_MIN_INTERVAL_MS=750
BRAIN_MAX_OUTPUT_TOKENS=900
REQUEST_TIMEOUT_MS=15000
DATA_DIR=./data
```

Build and test:

```bash
npm test
```

Run a business hunt:

```bash
npm start -- "Find 5 businesses in Abuja that appear to have no independent website. Verify each lead using multiple public sources and return source links and public contact information."
```

Run a job hunt:

```bash
npm start -- "Find 10 software engineering jobs in Abuja or remote Nigeria posted recently. Deduplicate repeated listings, verify the employer and source, and return application URLs."
```

## Search backends

The default search backend is DuckDuckGo HTML and requires no separate search API key.

For a self-hosted SearXNG instance:

```env
SEARCH_BACKEND=searxng
SEARXNG_URL=https://your-searxng-instance/search
```

Search engines are treated as discovery sources rather than unquestioned ground truth.

## Important boundaries

The project works with public information and does not bypass authentication, CAPTCHAs, paywalls, or access controls.

A failed request, missing search result, or DNS failure alone is never sufficient to establish that something does not exist.

## Roadmap

The architecture is now ready for deeper opportunity domains:

- user profile / CV-based job matching
- company and employer resolution
- stronger job-posting extraction
- recency/deadline detection
- application-path verification
- source reliability models
- contradiction graphs
- persistent entity memory
- scheduled opportunity hunts
- richer local source adapters
- browser automation for public pages where permitted
- additional opportunity types such as grants, contracts, procurement, internships, and freelance demand

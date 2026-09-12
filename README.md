# Opportunist Research Agent

A local-first research and opportunity-discovery agent.

The design is intentionally split into:

- **Brain**: an LLM provider (Grok/xAI first) that plans, reasons, decides which tools to call, evaluates evidence, and synthesizes results.
- **Body**: a local TypeScript runtime that executes research tools on the user's PC.
- **Evidence**: persistent, structured source and claim records so results are traceable.
- **Opportunity engine**: turns user intent into concrete, ranked, actionable targets rather than generic advice.

## First target workflow

Example request:

> Find businesses in Abuja that appear to operate without an independent website.

The agent should discover candidates, investigate them, verify the website status using multiple public signals, preserve source links, and return ranked opportunities.

## v1 provider

Grok/xAI is the initial brain provider. Keep provider interfaces generic so Anthropic, OpenAI, Gemini, or local models can be added later without changing the research runtime.

Set:

```bash
XAI_API_KEY=...
XAI_MODEL=grok-4.6
```

## Local development

Requirements: Node.js 20+.

```bash
npm install
npm run build
npm start
```

For development:

```bash
npm run dev
```

## Architecture

```text
User intent
   ↓
Planner / Brain (Grok)
   ↓ function/tool calls
Local Research Runtime
   ├── discovery
   ├── HTTP fetching
   ├── browser automation (later)
   ├── parsing / extraction
   ├── website checks
   ├── evidence store
   └── opportunity scoring
   ↓
Verified opportunities + source links
```

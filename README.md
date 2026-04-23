# ResearchAI

Full‑stack research assistant that turns a **topic + goal** into a structured **plan**, then runs web retrieval + LLM synthesis to generate an exportable **research brief**.

## What it does

- **Phase 1 — Planning**: scores ambiguity, infers audience/depth, generates a step outline and 6–10 prioritized sub‑questions.
- **Phase 2 — Execution (streaming)**: for each sub‑question, retrieves web results, summarizes evidence, then synthesizes a final brief.
- **Exports**: download the generated brief as **Markdown** or **DOCX**.

## Tech stack

- **Client**: React + TypeScript + Vite (proxying `/api` in development)
- **Server**: Node.js + TypeScript + Express, Zod validation, SSE streaming
- **AI / Orchestration**: LangChain + LangGraph (planning + synthesis)
- **Web retrieval**: Tavily Search API
- **Observability (optional)**: Langfuse tracing

## Project structure

- `client/`: UI and export utilities
- `server/`: API, orchestration graphs, prompts, and services

## Orchestration graph

```mermaid
flowchart LR
  UI[Client UI<br/>topic + goal input] -->|POST| PLAN["/api/research/plan"]
  UI -->|POST (optional)| PRE["/api/research/precheck"]

  PLAN --> AMB[LangGraph: ambiguityNode<br/>ambiguity score → audience/depth]
  AMB --> PLNR[LangGraph: plannerNode<br/>planSteps + prioritized sub-questions]
  PLNR --> UI

  UI -->|Approve & Start| EXEC["/api/research/execute<br/>(SSE stream)"]
  EXEC --> KEY{Has TAVILY_API_KEY?}
  KEY -- no --> SSEERR[Emit SSE: error]
  KEY -- yes --> SEARCH[LangGraph: searchAllNode<br/>retrieve web results + summarize per sub-question]
  SEARCH --> SSE1[Emit SSE: subquestion_start / subquestion_done]
  SEARCH --> SYN[LangGraph: synthesisNode<br/>final brief synthesis]
  SYN --> SSE2[Emit SSE: synthesis_start]
  SYN --> DONE[Emit SSE: complete (brief)]

  DONE --> EXP[Client exports: Markdown / DOCX]
```

## Architecture (AI engineer view)

### Architecture diagram (end-to-end)

```
                         ┌─────────────────────────────────────────────────────┐
                         │                    Client (React + Vite)            │
                         │  - Topic/goal intake                                │
                         │  - Plan review + approval                            │
                         │  - Streaming progress UI (SSE reader)                │
                         │  - Export: Markdown / DOCX                           │
                         └───────────────────────────────┬─────────────────────┘
                                                         │
                                             HTTP `/api/*`│ (dev proxy)
                                                         ▼
                         ┌─────────────────────────────────────────────────────┐
                         │                 Server (Express + TypeScript)        │
                         │  Routes                                               │
                         │   - POST /api/research/precheck                       │
                         │   - POST /api/research/plan                           │
                         │   - POST /api/research/execute  (SSE)                 │
                         │                                                       │
                         │  Validation: Zod at request boundary                  │
                         └───────────────┬───────────────────────────────┬─────┘
                                         │                               │
                                         │                               │ optional
                                         ▼                               ▼
                 ┌──────────────────────────────────────┐   ┌──────────────────────┐
                 │     LangGraph: Planner workflow       │   │   Langfuse tracing    │
                 │  ambiguityNode → plannerNode          │   │  (spans + generations)│
                 │  output: planSteps + subQuestions     │   └──────────────────────┘
                 └──────────────────────┬───────────────┘
                                        │
                                        ▼
                 ┌──────────────────────────────────────────────────────────────┐
                 │         LangGraph: Execution workflow (streamed)              │
                 │  searchAllNode → synthesisNode                                │
                 │    - retrieve web docs per sub-question (Tavily)              │
                 │    - summarize evidence per sub-question (LLM)                │
                 │    - synthesize final brief (LLM)                             │
                 │  SSE events: start/done per sub-question → synthesis → complete│
                 └──────────────────────┬───────────────────────────────────────┘
                                        │
                                        ▼
                          ┌────────────────────────────────────┐
                          │    External services (pluggable)    │
                          │  - Web retrieval: Tavily             │
                          │  - LLM: OpenAI via LangChain         │
                          └────────────────────────────────────┘
```

### Core design goals

- **Structured planning before retrieval**: force the system to generate a plan + sub‑questions first, then retrieve evidence per sub‑question.
- **Typed contracts at boundaries**: Zod validation at the API edge; explicit SSE event types for streaming UX.
- **Deterministic orchestration**: LangGraph nodes define the “shape” of the workflow; each node has a single responsibility.
- **Graceful degradation**: if a model returns malformed structured output, the planner falls back to a safe default plan.

### Server orchestration (LangGraph)

The server builds two LangGraph workflows:

- **Planning workflow** (called by `POST /api/research/plan`)
  - **`ambiguityNode`**: produces an ambiguity score and uses it to infer `audience` + `depth` defaults.
  - **`plannerNode`**: generates `planSteps` (3–8) and `subQuestions` (6–10), then normalizes priorities.
  - **Fallback**: if JSON extraction / schema parsing fails, a deterministic fallback plan/sub‑questions is returned so the UI can continue.

- **Execution workflow** (called by `POST /api/research/execute`, streamed)
  - **`searchAllNode`**: iterates over sub‑questions in priority order, runs web retrieval, then summarizes results into per‑question “evidence summaries”.
  - **`synthesisNode`**: combines all summaries + context (topic/goal/audience/depth/planSteps) into a final brief.

### Streaming contract (SSE)

The execute endpoint is designed for a responsive UI and long‑running jobs:

- **Transport**: Server‑Sent Events (SSE) over `POST /api/research/execute`
- **Event types**:
  - `subquestion_start`: emitted when a sub‑question begins
  - `subquestion_done`: emitted with the summary for that sub‑question
  - `synthesis_start`: emitted before final synthesis
  - `complete`: emitted once with the final brief text
  - `error`: emitted on recoverable preconditions (e.g., missing retrieval key) or runtime failures

### Retrieval + synthesis strategy

- **Query formation**: each sub‑question is searched using a bounded query string combining topic + sub‑question text.
- **Retriever**: web retrieval is abstracted behind a LangChain retriever (Tavily).
- **Summarization**: the model is prompted to summarize *only what can be supported by retrieved evidence* per sub‑question.
- **Synthesis**: a final model pass turns the set of summaries into a coherent brief (executive summary + structured sections).

### Model selection & structured output

- Planning relies on **structured JSON** outputs validated by Zod.
- The orchestration includes defensive JSON extraction (handles cases where models respond with fenced code blocks or tool-call-only output).
- The server supports a configurable “model registry” concept (see `server/.env.example`) to route tasks to models by profile (reasoning/latency/structured output needs).

### Observability (optional)

- When configured, the server emits trace spans for planning and execution through Langfuse.
- The code is written so tracing is **optional**; missing tracing keys does not block core functionality.

## Running locally

### Prerequisites

- Node.js (LTS recommended)

### Setup

1) Install dependencies

```bash
cd server && npm install
cd ../client && npm install
```

2) Configure environment variables

- Copy `server/.env.example` to `server/.env`
- Fill in **your own** API keys (do not commit secrets)

Minimum required to run end‑to‑end:

- `OPENAI_API_KEY` (planner + synthesis)
- `TAVILY_API_KEY` (Phase 2 web retrieval)

Optional:

- `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` (tracing)

3) Start the server

```bash
cd server
npm run dev:watch
```

4) Start the client

```bash
cd client
npm run dev
```

The UI calls the API via `/api/*` (dev proxy). If you need a custom API origin in dev, set `VITE_DEV_API_URL` in your local Vite env (keep it out of git).

## API (high level)

- `POST /api/research/precheck`: validate topic/goal and run a lightweight precheck
- `POST /api/research/plan`: return plan steps + prioritized sub‑questions
- `POST /api/research/execute`: streams SSE events and ends with the final brief

## Reliability & production notes

- **Input validation**: request bodies are validated (topic/goal length bounds, sub‑question shape, max count).
- **Failure modes**:
  - Missing retrieval credentials results in a fast SSE `error` event (no partial run).
  - Model JSON parse/schema failures in planning trigger a fallback plan so the product remains usable.
- **Cost control knobs**: temperature/max tokens and model selection are environment-configurable (see `server/.env.example`).
- **Security**: keep `.env` local; rotate compromised keys immediately; avoid logging secrets.

## Notes on security

- This repo is designed to keep secrets out of source control (see `.gitignore` and `server/.env.example`).
- Never paste API keys into issues, PRs, or screenshots.


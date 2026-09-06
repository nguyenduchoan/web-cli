# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Agent CLI Web Controller — a mobile-first web UI that controls AI CLI agents (Claude Code, Gemini CLI, Codex CLI, OpenCode CLI) already installed on a Debian host. The backend spawns CLI agents via PTY (node-pty), streams terminal I/O over WebSocket, and the React frontend renders it with xterm.js. The app does NOT reimplement any agent; it wraps their existing CLIs.

## Commands

```bash
# Install dependencies (requires python3, make, g++, pkg-config for node-pty native build)
npm install

# Dev — run in two terminals
npm run dev:server    # Fastify + tsx watch on :3001
npm run dev:web       # Vite React on :5173

# Type-check both workspaces
npm run check

# Production build
npm run build         # server/dist + web/dist

# Production run (serves API + static frontend on :3001)
npm --workspace server run start
```

No test framework is set up yet. There are no lint or format scripts.

## Architecture

**Monorepo with npm workspaces**: root `package.json` defines workspaces `server/` and `web/`.

### Backend (`server/`)

Fastify + node-pty + ws. ESM throughout (tsconfig targets ES2022/NodeNext).

- `config.ts` — Loads `.env`, validates with Zod. Defines `AppConfig` (agents, projects allowlist, auth token, buffer limits). Agents come from `AGENTS_CONFIG_JSON` env var or hardcoded defaults. Projects derive deterministic IDs from SHA-256 of resolved paths.
- `sessionManager.ts` — Core state machine. Each session spawns a PTY process with `pty.spawn(agent.command, agent.args, { cwd: project.path })`. States: idle → running → exited/error. Emits `output`, `state`, `exit` events via Node EventEmitter. Maintains a rolling output buffer (default 200KB).
- `websocket.ts` — `WebSocketBridge` uses `noServer` mode on the Fastify HTTP server. Auth via single-use short-lived tickets (not Bearer tokens). Client messages: `input`, `resize`, `ping`. Server messages: `output`, `state`, `error`, `exit`, `pong`. On connect, replays the full output buffer.
- `auth.ts` — Fastify preHandler hook. Constant-time Bearer token comparison for `/api/*` routes. WebSocket auth is ticket-based (separate from this middleware).
- `staticAssets.ts` — In production, serves `web/dist` with immutable caching for `/assets/*` and SPA fallback (returns `index.html` for HTML-accepting GET requests not under `/api/`).
- `index.ts` — Wires everything together. REST endpoints: `GET /api/health`, `GET /api/agents`, `GET /api/projects`, `POST /api/sessions`, `GET /api/sessions/:id`, `POST /api/sessions/:id/kill`, `POST /api/sessions/:id/restart`, `POST /api/sessions/:id/ws-ticket`.

### Frontend (`web/`)

React 19 + Vite + Tailwind CSS + xterm.js. No router — single-page app.

- `App.tsx` — Root component. Manages auth state (token in localStorage), agent/project selection, session lifecycle (start/kill/restart). Composes all child components.
- `TerminalPane.tsx` — Creates xterm.js Terminal, manages WebSocket lifecycle (ticket acquisition → connect → message routing). Exposes `sendInput` via `useImperativeHandle`. Auto-fits terminal via ResizeObserver.
- `lib/api.ts` — HTTP client wrapping `fetch`. `API_BASE_URL` comes from `VITE_API_BASE_URL` env var or falls back to `window.location.origin`.
- `lib/types.ts` — Shared TypeScript types for Session, AgentConfig, ProjectConfig, ServerMessage.
- Components: `LoginScreen`, `AgentTabs`, `ProjectSelector`, `SessionControls`, `QuickActions`, `CommandInput`, `StatusBadge`.

### Design system

Custom Tailwind theme in `tailwind.config.js`: dark terminal aesthetic with `shell-*` (backgrounds) and `signal-*` (green accents) color palettes. Fonts: Inter (sans), JetBrains Mono (mono).

## Key Design Decisions

- **No raw commands from client**: Client sends only `agentId`; the backend maps it to a command from server config. This prevents arbitrary command injection.
- **Project allowlist**: Only directories listed in `ALLOWED_PROJECT_DIRS` can be used as PTY working directories. Paths are resolved via `realpath`.
- **Ticket-based WebSocket auth**: Short-lived, single-use tickets exchanged via authenticated REST endpoint, avoiding Bearer tokens in WebSocket URLs.
- **Terminal output not logged by default**: `LOG_TERMINAL_OUTPUT=false` — terminal output may contain secrets.

## Environment

Copy `.env.example` to `.env`. Key variables:
- `AUTH_TOKEN` (required, min 16 chars)
- `ALLOWED_PROJECT_DIRS` (comma-separated absolute paths)
- `HOST`, `PORT`, `CLIENT_ORIGIN`, `VITE_API_BASE_URL`
- `AGENTS_CONFIG_JSON` (optional JSON array to override default agent commands)

## Agent Kit

The `agent-kit/` directory contains an Agile product team skill kit (roles, checklists, templates) for Codex CLI. It is independent from the web controller application code. See `AGENTS.md` for routing rules when working with agent-kit tasks.

## Language

The UI and user-facing strings are in Vietnamese. Respond to the user in Vietnamese as instructed in AGENTS.md.

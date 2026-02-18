# SwapSmith — Issue Tracker & Resolution Guide

> A curated set of engineering issues for SwapSmith, each described with clarity, context, and a concrete solving technique. Designed to guide contributors toward high-impact improvements.

---

## Table of Contents

1. [Issue #1 — NLP Parser Fails on Ambiguous Multi-Asset Commands](#issue-1--nlp-parser-fails-on-ambiguous-multi-asset-commands)
2. [Issue #2 — Voice Input Drops Audio on Safari and Firefox](#issue-2--voice-input-drops-audio-on-safari-and-firefox)
3. [Issue #3 — Order Monitor Stalls When SideShift API Returns 429](#issue-3--order-monitor-stalls-when-sideshift-api-returns-429)
4. [Issue #4 — Quote Expiry Race Condition During Confirmation](#issue-4--quote-expiry-race-condition-during-confirmation)
5. [Issue #5 — Portfolio Splits Lose Dust Due to Rounding](#issue-5--portfolio-splits-lose-dust-due-to-rounding)
6. [Issue #6 — Terminal Chat Loses Session on Page Refresh](#issue-6--terminal-chat-loses-session-on-page-refresh)
7. [Issue #7 — Address Validation Missing for Newer Chain Formats](#issue-7--address-validation-missing-for-newer-chain-formats)
8. [Issue #8 — No Retry Mechanism for Failed Cross-Chain Swaps](#issue-8--no-retry-mechanism-for-failed-cross-chain-swaps)
9. [Issue #9 — Database Connection Pool Exhaustion Under Load](#issue-9--database-connection-pool-exhaustion-under-load)
10. [Issue #10 — Sensitive API Keys Exposed in Client-Side Bundles](#issue-10--sensitive-api-keys-exposed-in-client-side-bundles)

---

## Issue #1 — NLP Parser Fails on Ambiguous Multi-Asset Commands

**Labels:** `bug` `parser` `priority: high`

### Description

The regex-first NLP parser in `parseUserCommand.ts` silently misparses commands that reference multiple assets in a single sentence. When a user says:

> *"Swap my ETH and MATIC for USDC on Arbitrum"*

The parser extracts only the **last** mentioned source asset (`MATIC`) and drops `ETH` entirely — no warning, no fallback to the LLM.

### Expected Behavior

The system should either:
- Correctly identify **both** source assets and create two parallel swap intents, or
- Clearly inform the user that multi-source swaps require separate commands.

### Current Behavior

Only one asset is parsed. The user sees a confirmation for a single swap and assumes both were included. Funds are partially swapped without explicit consent for the scope change.

### Architecture Context

```
┌─────────────────────────────────────────────────────┐
│                  User Input                         │
│   "Swap my ETH and MATIC for USDC on Arbitrum"     │
└───────────────┬─────────────────────────────────────┘
                │
                ▼
┌───────────────────────────────┐
│     Regex Pattern Matching    │
│  (parseUserCommand.ts)        │
│                               │
│  ✗ Captures only MATIC       │
│  ✗ Drops ETH silently        │
└───────────────┬───────────────┘
                │
                ▼
┌───────────────────────────────┐
│     Confidence Score < 30?    │──── No ──→ Proceeds with
│                               │           incomplete parse
└───────────────┬───────────────┘
                │ Yes
                ▼
┌───────────────────────────────┐
│     LLM Fallback (Groq)      │
│     (Never reached here)      │
└───────────────────────────────┘
```

### Solving Technique

1. **Add a multi-asset detection regex** before the main parse loop:
   ```
   /(\b[A-Z]{2,10}\b)\s+and\s+(\b[A-Z]{2,10}\b)/i
   ```
2. When detected, either:
   - Split into N separate `ParsedCommand` objects (one per source asset), or
   - Lower the confidence score to force the LLM fallback path.
3. Add explicit rejection with a helpful message:
   ```
   "I found multiple source assets (ETH, MATIC). Would you like to swap them separately?"
   ```
4. **Tests to add:** Multi-asset inputs in `parseUserCommand.test.ts`.

**Files:** `bot/src/services/parseUserCommand.ts`, `bot/src/tests/parseUserCommand.test.ts`

---

## Issue #2 — Voice Input Drops Audio on Safari and Firefox

**Labels:** `bug` `voice` `browser-compat` `priority: medium`

### Description

The voice input feature uses the Web Audio API and `MediaRecorder` to capture microphone input. On Safari (macOS/iOS) and Firefox, the recorded audio blob is either **empty** or encoded in a format (`audio/ogg`) that the Groq transcription API rejects.

### Expected Behavior

Voice commands should record, encode, and transcribe correctly across Chrome, Safari, and Firefox on both desktop and mobile.

### Current Behavior

| Browser        | Recording | Transcription | Notes                        |
|----------------|-----------|---------------|------------------------------|
| Chrome (Desktop) | ✅        | ✅             | Works as expected            |
| Safari (macOS)   | ✅        | ❌             | Blob sent as `audio/mp4`     |
| Safari (iOS)     | ❌        | ❌             | `MediaRecorder` unavailable  |
| Firefox          | ✅        | ❌             | Codec mismatch (`audio/ogg`) |

### Solving Technique

```
┌──────────────────────────────────────────────────┐
│               Voice Input Flow                   │
│                                                  │
│  ┌──────────┐    ┌──────────────┐    ┌────────┐ │
│  │ Mic      │───▶│ MediaRecorder│───▶│ Blob   │ │
│  │ Access   │    │              │    │ (audio)│ │
│  └──────────┘    └──────────────┘    └───┬────┘ │
│                                          │      │
│                        ┌─────────────────┘      │
│                        ▼                        │
│  ┌─────────────────────────────────────┐        │
│  │      Format Negotiation (NEW)       │        │
│  │                                     │        │
│  │  1. Check MediaRecorder.isTypeSupported()    │
│  │  2. Prefer: audio/webm;codecs=opus │        │
│  │  3. Fallback: audio/mp4            │        │
│  │  4. Last resort: audio/wav (PCM)   │        │
│  └──────────────────┬──────────────────┘        │
│                     ▼                           │
│  ┌─────────────────────────────────────┐        │
│  │    Server-Side Transcode (NEW)      │        │
│  │    ffmpeg: any format → wav 16kHz   │        │
│  └──────────────────┬──────────────────┘        │
│                     ▼                           │
│  ┌─────────────────────────────────────┐        │
│  │    Groq Transcription API           │        │
│  │    (accepts wav/mp3/webm)           │        │
│  └─────────────────────────────────────┘        │
└──────────────────────────────────────────────────┘
```

1. **Client-side format negotiation** — Query `MediaRecorder.isTypeSupported()` and select the best compatible MIME type.
2. **Server-side normalization** — Add a lightweight `ffmpeg` transcode step before sending to Groq. Convert any input format to `wav` at 16kHz mono.
3. **iOS fallback** — For browsers without `MediaRecorder`, use the Web Speech API (`SpeechRecognition`) as a text-only fallback.

**Files:** `frontend/components/` (voice input component), `bot/src/services/groq-client.ts`

---

## Issue #3 — Order Monitor Stalls When SideShift API Returns 429

**Labels:** `bug` `reliability` `priority: high`

### Description

The `OrderMonitor` background service polls the SideShift API to track pending orders. When SideShift returns an HTTP `429 Too Many Requests`, the monitor logs the error but **continues polling at the same rate**, compounding the problem. This leads to:

- Cascading 429s across all tracked orders.
- Users receiving no status updates for extended periods.
- Potential temporary IP ban from SideShift.

### Expected Behavior

The monitor should respect rate limits by implementing exponential backoff with jitter when receiving 429 responses, and resume normal polling once the rate limit window resets.

### Current Behavior

The monitor's `getBackoffInterval()` only considers order age, not API response codes. A burst of 429s creates a feedback loop:

```
  Time ──────────────────────────────────────────▶

  Poll ──▶ 429 ──▶ Poll ──▶ 429 ──▶ Poll ──▶ 429
   │                │                │
   └── 15s ─────────┘── 15s ────────┘── 15s ───▶ (never backs off)
```

### Solving Technique

1. **Add a global rate-limit state** to `OrderMonitor`:
   ```typescript
   private rateLimitedUntil: number = 0;

   private handleApiResponse(status: number, headers: Headers) {
     if (status === 429) {
       const retryAfter = parseInt(headers.get('Retry-After') || '60', 10);
       this.rateLimitedUntil = Date.now() + retryAfter * 1000;
     }
   }
   ```
2. **Guard the tick loop** — Skip all polling when `Date.now() < rateLimitedUntil`.
3. **Add jitter** to prevent thundering herd when multiple monitors resume simultaneously:
   ```typescript
   const jitter = Math.random() * 5000; // 0–5s random delay
   ```
4. **Emit a warning to the user** — "⏳ Temporarily paused order tracking due to high traffic. Will resume shortly."

**Files:** `bot/src/services/order-monitor.ts`, `bot/src/tests/order-monitor.test.ts`

---

## Issue #4 — Quote Expiry Race Condition During Confirmation

**Labels:** `bug` `race-condition` `ux` `priority: high`

### Description

SideShift quotes have a **30-second TTL**. The current flow stores the quote ID in the database and waits for user confirmation — but there is no countdown timer or staleness check. If the user takes longer than 30 seconds to confirm, the subsequent `createOrder()` call fails with a cryptic `QUOTE_EXPIRED` error.

### Expected Behavior

The system should:
1. Display a visible countdown timer showing remaining quote validity.
2. Automatically refresh the quote if it expires before confirmation.
3. Notify the user of any rate changes on refresh.

### Current Behavior

```
┌──────────┐     ┌───────────────┐     ┌───────────┐
│  Parse   │────▶│  Get Quote    │────▶│  Store in │
│  Command │     │  (30s TTL)    │     │  DB       │
└──────────┘     └───────────────┘     └─────┬─────┘
                                             │
                              User takes 45s │
                                             ▼
                                    ┌────────────────┐
                                    │  Create Order   │
                                    │  ❌ QUOTE_EXPIRED│
                                    └────────────────┘
```

### Solving Technique

```
┌──────────┐     ┌───────────────┐     ┌──────────────────┐
│  Parse   │────▶│  Get Quote    │────▶│  Show to User    │
│  Command │     │  (30s TTL)    │     │  + Countdown ⏱️   │
└──────────┘     └───────────────┘     └────────┬─────────┘
                                                │
                         ┌──────────────────────┤
                         │                      │
                  Expired│               User   │
                         ▼              Confirms ▼
                 ┌───────────────┐     ┌────────────────┐
                 │ Auto-Refresh  │     │  Staleness     │
                 │ New Quote     │────▶│  Check         │
                 │ + Notify Δ   │     │  quoteAge < 25s│
                 └───────────────┘     └───────┬────────┘
                                               │ Fresh
                                               ▼
                                      ┌────────────────┐
                                      │  Create Order   │
                                      │  ✅ Success      │
                                      └────────────────┘
```

1. **Store `quoteExpiresAt`** alongside the quote ID in the conversation state.
2. **Add a staleness guard** in the `place_order` handler:
   ```typescript
   if (Date.now() > conversation.quoteExpiresAt - 5000) {
     // Re-fetch quote, notify user of rate change
     const newQuote = await sideshiftClient.createQuote(...);
     await notifyRateChange(oldRate, newQuote.rate);
   }
   ```
3. **Client-side countdown** — Show a `<CountdownTimer />` component on the confirmation card.
4. **Telegram inline update** — Edit the confirmation message to show remaining time.

**Files:** `bot/src/bot.ts`, `shared/schema.ts` (add `quoteExpiresAt` column), `frontend/components/SwapConfirmation`

---

## Issue #5 — Portfolio Splits Lose Dust Due to Rounding

**Labels:** `bug` `financial-accuracy` `priority: medium`

### Description

The portfolio service (`portfolio-service.ts`) splits a user's amount by percentage allocations. Due to floating-point arithmetic, the sum of split amounts can be less than the original — leaving "dust" (small residual amounts) unaccounted for.

Example: User requests *"Split 1.0 ETH: 33.33% BTC, 33.33% SOL, 33.34% USDC"*

| Asset | Percentage | Calculated Amount     | Actual Sent     |
|-------|-----------|----------------------|-----------------|
| BTC   | 33.33%    | 0.33330000000000004  | 0.33330000      |
| SOL   | 33.33%    | 0.33330000000000004  | 0.33330000      |
| USDC  | 33.34%    | 0.33340000000000003  | 0.33340000      |
| **Dust** | —      | **~0.00000000000011** | **Lost**        |

Floating-point representation errors compound across multiple splits, producing dust that is silently dropped.

### Solving Technique

1. **Use integer arithmetic (basis points)** internally:
   ```typescript
   // Instead of: amount * (percentage / 100)
   // Use: (amount_bps * percentage_bps) / 10000
   const amountBps = BigInt(Math.round(amount * 1e8));
   ```
2. **Assign all remainder to the last asset** (already partially implemented — verify correctness):
   ```typescript
   const lastAmount = totalAmount - sumOfPreviousAmounts;
   ```
3. **Add a tolerance check** — If dust exceeds a threshold (e.g., > $0.01 equivalent), warn the user.
4. **Tests** — Add property-based tests ensuring `sum(splits) === original` for random percentage arrays.

**Files:** `bot/src/services/portfolio-service.ts`, `bot/src/tests/portfolio-service.test.ts`

---

## Issue #6 — Terminal Chat Loses Session on Page Refresh

**Labels:** `bug` `ux` `frontend` `priority: medium`

### Description

The web terminal (`terminal/page.tsx`) generates a UUID-based session ID on mount. On page refresh, a **new session ID** is created, and the previous conversation context is lost. The user sees an empty chat despite having an active swap in progress.

### Expected Behavior

- Chat history should persist across page refreshes.
- Active swap status should be restored.
- Session ID should be stable for the duration of the browser session.

### Current Behavior

```
  Page Load #1                     Page Refresh
  ┌────────────┐                  ┌────────────┐
  │ Session:   │                  │ Session:   │
  │ abc-123    │                  │ xyz-789    │ ← New ID
  │            │                  │            │
  │ Messages:  │                  │ Messages:  │
  │ - Swap ETH │   ──Refresh──▶  │ (empty)    │
  │ - Quote... │                  │            │
  │ - Confirm? │                  │            │
  └────────────┘                  └────────────┘
```

### Solving Technique

1. **Persist session ID** in `sessionStorage` (per-tab, survives refresh):
   ```typescript
   const getOrCreateSessionId = () => {
     let id = sessionStorage.getItem('swapsmith_session');
     if (!id) {
       id = crypto.randomUUID();
       sessionStorage.setItem('swapsmith_session', id);
     }
     return id;
   };
   ```
2. **Load chat history** from the database on mount using the persisted session ID.
3. **Hydrate pending swaps** — Query `orders` table for active orders tied to this session and render their current status.

**Files:** `frontend/app/terminal/page.tsx`, `frontend/hooks/` (add `useSession` hook)

---

## Issue #7 — Address Validation Missing for Newer Chain Formats

**Labels:** `enhancement` `validation` `priority: medium`

### Description

The address validation config (`bot/src/config/address-patterns.ts`) covers major chains but is missing patterns for several newer or niche networks that SideShift supports. Invalid addresses for these chains pass validation and fail silently at the SideShift API level, wasting a quote and confusing the user.

### Missing Chains (Partial List)

| Chain        | Expected Format           | Current Status |
|--------------|---------------------------|----------------|
| Sui          | `0x` + 64 hex chars       | ❌ Missing      |
| Aptos        | `0x` + 64 hex chars       | ❌ Missing      |
| SEI          | `sei1` + 38 bech32 chars  | ❌ Missing      |
| Injective    | `inj1` + 38 bech32 chars  | ❌ Missing      |
| Celestia     | `celestia1` + bech32      | ❌ Missing      |
| Near         | Named accounts or 64 hex  | ❌ Missing      |

### Solving Technique

1. **Audit the SideShift coin list** — Call `getCoins()` and compare supported chains against `address-patterns.ts`.
2. **Add regex patterns** for each missing chain:
   ```typescript
   sui: /^0x[a-fA-F0-9]{64}$/,
   aptos: /^0x[a-fA-F0-9]{64}$/,
   sei: /^sei1[a-z0-9]{38}$/,
   injective: /^inj1[a-z0-9]{38}$/,
   ```
3. **Add a fallback behavior** — If a chain has no local validation pattern, make a lightweight API call to SideShift's address validation endpoint before creating the order.
4. **Tests** — Add valid/invalid address samples for each new chain in `address-validation.test.ts`.

**Files:** `bot/src/config/address-patterns.ts`, `bot/src/tests/address-validation.test.ts`

---

## Issue #8 — No Retry Mechanism for Failed Cross-Chain Swaps

**Labels:** `enhancement` `reliability` `priority: high`

### Description

When a cross-chain swap fails mid-execution (e.g., network congestion, bridge timeout), the system marks the order as `failed` in the database and notifies the user — but provides **no recovery path**. The user must manually re-initiate the entire flow from scratch.

### Expected Behavior

The system should offer an intelligent retry mechanism:
1. Diagnose the failure reason.
2. If retryable (timeout, temporary bridge issue), offer a one-tap retry.
3. If non-retryable (insufficient funds, invalid address), explain clearly and suggest corrections.

### Solving Technique

```
┌──────────────────────────────────────────────────────────┐
│                  Failure Recovery Flow                    │
│                                                          │
│  ┌──────────┐     ┌────────────────┐     ┌────────────┐ │
│  │  Order   │────▶│  Classify      │────▶│  Retryable │ │
│  │  Failed  │     │  Failure       │     │  ?         │ │
│  └──────────┘     └────────────────┘     └──┬───┬─────┘ │
│                                             │   │       │
│                                    Yes ─────┘   └── No  │
│                                    │                │    │
│                                    ▼                ▼    │
│                          ┌──────────────┐  ┌──────────┐ │
│                          │ Auto-Retry   │  │ Explain  │ │
│                          │ with fresh   │  │ + Guide  │ │
│                          │ quote        │  │ user     │ │
│                          └──────────────┘  └──────────┘ │
└──────────────────────────────────────────────────────────┘
```

1. **Add a `failureReason` enum** to the orders schema:
   ```typescript
   enum FailureReason {
     TIMEOUT = 'timeout',
     BRIDGE_ERROR = 'bridge_error',
     INSUFFICIENT_FUNDS = 'insufficient_funds',
     INVALID_ADDRESS = 'invalid_address',
     QUOTE_EXPIRED = 'quote_expired',
     UNKNOWN = 'unknown'
   }
   ```
2. **Classify failures** in the order monitor based on SideShift error codes.
3. **Add a `/retry` command** (Telegram) and "Retry" button (frontend) that re-uses the original parsed command with a fresh quote.
4. **Cap retries** at 3 attempts with exponential delay (30s, 60s, 120s).

**Files:** `bot/src/bot.ts`, `bot/src/services/order-monitor.ts`, `shared/schema.ts`

---

## Issue #9 — Database Connection Pool Exhaustion Under Load

**Labels:** `bug` `performance` `infra` `priority: high`

### Description

The Neon serverless PostgreSQL connection uses a single connection configuration. Under concurrent load (multiple users swapping simultaneously), the connection pool is exhausted, causing:

- `FATAL: too many connections` errors.
- Dropped order status updates.
- Unresponsive bot during peak usage.

### Expected Behavior

The system should gracefully handle concurrent database access with proper connection pooling, queuing, and timeout handling.

### Solving Technique

```
  Without Pool (Current)              With Pool (Proposed)
  ┌───────────────────┐              ┌───────────────────┐
  │ Request 1 ──▶ DB  │              │ Request 1 ──┐     │
  │ Request 2 ──▶ DB  │              │ Request 2 ──┤     │
  │ Request 3 ──▶ DB  │              │ Request 3 ──┤     │
  │ Request 4 ──▶ ❌  │              │ Request 4 ──┤     │
  │ Request 5 ──▶ ❌  │              │             ▼     │
  │                   │              │    ┌──────────┐   │
  │ (connections      │              │    │ Pool     │   │
  │  exhausted)       │              │    │ max: 10  │──▶ DB
  └───────────────────┘              │    │ idle: 5  │   │
                                     │    │ queue:20 │   │
                                     │    └──────────┘   │
                                     └───────────────────┘
```

1. **Configure Neon's connection pooler** — Use Neon's built-in PgBouncer endpoint instead of direct connections:
   ```
   DATABASE_URL=postgres://user:pass@ep-example-pooler.region.neon.tech/db
   ```
2. **Add Drizzle pool config**:
   ```typescript
   const pool = new Pool({
     connectionString: process.env.DATABASE_URL,
     max: 10,
     idleTimeoutMillis: 30000,
     connectionTimeoutMillis: 5000,
   });
   ```
3. **Add connection health checks** — Ping the database on startup and log pool utilization metrics.
4. **Graceful degradation** — Queue requests when pool is full rather than throwing immediately.

**Files:** `bot/src/services/database.ts`, `shared/schema.ts`, `docker-compose.yaml`

---

## Issue #10 — Sensitive API Keys Exposed in Client-Side Bundles

**Labels:** `security` `priority: critical`

### Description

Environment variables prefixed with `NEXT_PUBLIC_` are embedded into the client-side JavaScript bundle by Next.js. If any sensitive keys (SideShift secret, OpenAI key, database credentials) are accidentally prefixed with `NEXT_PUBLIC_`, they become visible to anyone inspecting the browser's network traffic or source maps.

### Expected Behavior

- **Only non-sensitive values** (e.g., WalletConnect Project ID, public chain RPC URLs) should use the `NEXT_PUBLIC_` prefix.
- All API secrets should remain server-side only, accessed exclusively through API routes.

### Current Risk Assessment

| Variable              | Should Be Public? | Risk if Exposed            |
|-----------------------|--------------------|-----------------------------|
| `NEXT_PUBLIC_WC_ID`   | ✅ Yes             | Low — public project ID     |
| `SIDESHIFT_SECRET`    | ❌ No              | High — API abuse            |
| `OPENAI_API_KEY`      | ❌ No              | Critical — cost exposure    |
| `DATABASE_URL`        | ❌ No              | Critical — data breach      |
| `GROQ_API_KEY`        | ❌ No              | High — API abuse            |

### Solving Technique

1. **Audit `.env.example` and all `process.env` references** in `frontend/` to ensure no secrets use `NEXT_PUBLIC_`.
2. **Add a build-time check** in `next.config.ts`:
   ```typescript
   const FORBIDDEN_PUBLIC_PATTERNS = [
     /SECRET/i, /API_KEY/i, /DATABASE/i, /PASSWORD/i, /PRIVATE/i
   ];

   for (const key of Object.keys(process.env)) {
     if (key.startsWith('NEXT_PUBLIC_') &&
         FORBIDDEN_PUBLIC_PATTERNS.some(p => p.test(key))) {
       throw new Error(`🚨 Sensitive key "${key}" must not use NEXT_PUBLIC_ prefix`);
     }
   }
   ```
3. **Proxy all API calls through Next.js API routes** (`pages/api/`) — never call external APIs directly from the browser.
4. **Add a CI check** — A GitHub Action that scans for `NEXT_PUBLIC_` usage and flags new additions for review.

**Files:** `frontend/next.config.ts`, `.github/workflows/`, `.env.example`

---

## Architecture Overview

The diagram below shows the complete SwapSmith data flow, highlighting where each issue occurs:

```
┌─────────────────────────────────────────────────────────────────────┐
│                        SwapSmith Architecture                       │
│                                                                     │
│   ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────────┐ │
│   │ Telegram │    │   Web    │    │  Voice   │    │  Future:     │ │
│   │   Bot    │    │ Terminal │    │  Input   │    │  Mobile App  │ │
│   └────┬─────┘    └────┬─────┘    └────┬─────┘    └──────────────┘ │
│        │               │               │                            │
│        │          Issue #6         Issue #2                         │
│        │          (session)        (Safari/FF)                      │
│        │               │               │                            │
│        └───────────────┼───────────────┘                            │
│                        ▼                                            │
│        ┌───────────────────────────────┐                            │
│        │      NLP Parser              │ ◄─── Issue #1              │
│        │  (parseUserCommand.ts)       │      (multi-asset)         │
│        └───────────────┬───────────────┘                            │
│                        │                                            │
│                        ▼                                            │
│        ┌───────────────────────────────┐                            │
│        │   Address Validation         │ ◄─── Issue #7              │
│        │  (address-patterns.ts)       │      (missing chains)      │
│        └───────────────┬───────────────┘                            │
│                        │                                            │
│                        ▼                                            │
│        ┌───────────────────────────────┐                            │
│        │   SideShift API              │ ◄─── Issue #4              │
│        │   Quote → Order              │      (quote expiry)        │
│        └───────────────┬───────────────┘                            │
│                        │                                            │
│              ┌─────────┴─────────┐                                  │
│              ▼                   ▼                                   │
│   ┌──────────────────┐ ┌────────────────┐                          │
│   │  Order Monitor   │ │  Portfolio     │                          │
│   │  (background)    │ │  Service       │                          │
│   │                  │ │                │                          │
│   │  Issue #3 (429)  │ │  Issue #5      │                          │
│   │  Issue #8 (retry)│ │  (rounding)    │                          │
│   └────────┬─────────┘ └────────────────┘                          │
│            │                                                        │
│            ▼                                                        │
│   ┌───────────────────────────────┐                                 │
│   │   PostgreSQL (Neon)           │ ◄─── Issue #9                  │
│   │   via Drizzle ORM             │      (pool exhaustion)         │
│   └───────────────────────────────┘                                 │
│                                                                     │
│   ┌───────────────────────────────┐                                 │
│   │   Environment & Secrets       │ ◄─── Issue #10                 │
│   │   (.env / NEXT_PUBLIC_)       │      (key exposure)            │
│   └───────────────────────────────┘                                 │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Priority Matrix

| Priority   | Issue | Impact      | Effort  |
|------------|-------|-------------|---------|
| 🔴 Critical | #10   | Security    | Low     |
| 🔴 High     | #1    | Data Loss   | Medium  |
| 🔴 High     | #3    | Reliability | Low     |
| 🔴 High     | #4    | UX / Funds  | Medium  |
| 🔴 High     | #8    | Reliability | High    |
| 🔴 High     | #9    | Scalability | Medium  |
| 🟡 Medium   | #2    | Compat      | Medium  |
| 🟡 Medium   | #5    | Accuracy    | Low     |
| 🟡 Medium   | #6    | UX          | Low     |
| 🟡 Medium   | #7    | Validation  | Low     |

---

## Contributing

Before picking up an issue, please:

1. Read the [Contributing Guidelines](CONTRIBUTING.md).
2. Comment on the issue to get assigned.
3. Create a feature branch: `git checkout -b fix/issue-number-short-description`.
4. Follow the solving technique outlined above.
5. Add or update tests for your changes.
6. Submit a PR referencing the issue number.

---

*Built with precision. Engineered for clarity.*

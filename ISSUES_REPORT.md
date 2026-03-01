# SwapSmith — Issue Report

This document contains **10 hard-level issues** and **10 medium-level issues** identified through a thorough analysis of the SwapSmith repository. Each issue includes a problem description, why it is required, the proposed approach, and a statement of intent to work on it.

---

## Part 1 — Hard-Level Issues

---

### Hard Issue 1: No End-to-End Swap Recovery Mechanism for Mid-Flight Failures

**Problem Description**

When a user initiates a swap through the frontend or bot, multiple steps occur in sequence: a quote is fetched from SideShift, an order is created, the deposit address is given to the user, and the user sends funds. If any step after funds are sent fails — for example, if the bot process crashes, the database goes temporarily offline, or a network error interrupts the status-polling loop — the order can fall into an unrecoverable limbo state. At that point, the user's funds are in transit but the system has no record of what to do next. The `OrderMonitor` in `bot/src/services/order-monitor.ts` only tracks orders already registered in its in-memory map. If the process restarts, all in-memory state is lost, and active orders are only recovered on the next full database scan at startup.

**Why It Is Required**

This is a financial application that moves real cryptocurrency. Losing track of a user's in-flight swap is a critical reliability failure. A user who sent funds and receives no follow-up message will lose trust in the platform and may be unable to recover their funds without contacting support. Building a proper at-least-once delivery guarantee for swap lifecycle events is essential before this product can be considered production-ready.

**My Approach**

The recovery mechanism should be implemented by persisting all in-flight order IDs to the database the moment a deposit address is given to the user. On every bot startup, the system should query the database for all orders whose status is not in a terminal state and re-register them with the `OrderMonitor`. Additionally, the monitor should expose a "reconciliation" method that can be called periodically (e.g., once per hour) to re-query the database for any orders that may have been missed, cross-reference them with the SideShift API, and update their status accordingly. This makes recovery automatic and self-healing.

**I want to work on this issue.**

---

### Hard Issue 2: DCA Scheduler Race Condition with Multiple Bot Instances

**Problem Description**

The `DCAScheduler` in `bot/src/services/dca-scheduler.ts` uses an optimistic locking mechanism by updating the `nextExecutionAt` timestamp to check whether another instance has already claimed a schedule. However, this check-then-act pattern is not atomic. If two bot instances start within milliseconds of each other (for example, during a rolling restart in a container orchestrator like Docker Swarm or Kubernetes), both instances can read the same schedule from the database before either has committed the lock update. This results in the DCA order being executed twice, meaning the user's funds are double-spent on two separate SideShift orders.

**Why It Is Required**

Dollar-cost averaging is a financial automation feature that directly controls a user's funds. A double-execution is not just a bug — it is a financial harm. If a user set up a DCA to buy 10 USDC of ETH weekly and the system fires two orders in the same tick, 20 USDC is consumed. The user has no easy way to undo a confirmed swap on a non-custodial platform. Fixing this requires a true database-level atomic lock, not an application-level optimistic check.

**My Approach**

The locking logic should be replaced with a PostgreSQL advisory lock or a `SELECT ... FOR UPDATE SKIP LOCKED` query pattern. When `processSchedules` runs, it should issue a `FOR UPDATE SKIP LOCKED` query on the `dca_schedules` table so that only one database connection can hold the lock on a given row at a time. Any other instance attempting to process the same schedule will skip it automatically at the query level, making the operation truly atomic and eliminating the race condition without requiring any application-level coordination.

**I want to work on this issue.**

---

### Hard Issue 3: Limit Order Worker Has No Retry or Dead-Letter Handling

**Problem Description**

In `bot/src/workers/limitOrderWorker.ts`, when a limit order execution fails (for example, because the SideShift API is temporarily down or the quote has expired), the error is caught, written to the `error` field of the `limit_orders` table, and the order's status is set to a failed state. There is no retry mechanism, no exponential backoff, and no dead-letter queue. A transient API failure at the exact moment the price condition was met will permanently fail the user's limit order, even though the error was temporary and the price condition may still be valid.

**Why It Is Required**

Limit orders are a commitment from the platform to execute a trade under specific market conditions. A user setting a limit order to buy ETH when it drops to a certain price expects the system to execute that trade reliably, not to fail silently on a transient HTTP error. Without a retry mechanism, the system is unreliable for one of its most important automation features.

**My Approach**

A retry counter column (`retryCount`) and a `retryAfter` timestamp column should be added to the `limit_orders` table. When an execution fails for a transient reason (network error, rate limit, temporary API unavailability), the worker should increment the counter and set `retryAfter` to a future timestamp using exponential backoff. The worker polling loop should include orders where `retryAfter` is in the past and `retryCount` is below a configured maximum. After exceeding the maximum, the order should be moved to a permanent `failed` state and the user should be notified via the Telegram bot.

**I want to work on this issue.**

---

### Hard Issue 4: Reward Points System Has Race Conditions on Concurrent Claims

**Problem Description**

The rewards system in `frontend/lib/rewards-service.ts` issues points for actions like `daily_login`, `swap_complete`, and `course_complete`. These operations involve reading the user's current point total, adding the new points, and writing the result back. If two events for the same user are processed concurrently — for example, a user completing a course and triggering a daily login at the same time — both reads may see the same original balance. Both writes then overwrite each other, resulting in only one of the two point awards being recorded. This is a classic read-modify-write race condition in a system without proper transaction isolation.

**Why It Is Required**

The rewards system feeds into the token claiming and NFT minting pipeline. If points are lost due to race conditions, users will see their balances be incorrect, which will cause confusion and support requests. More critically, when users convert their points to tokens for minting, incorrect point totals will cause the wrong number of tokens to be minted on-chain, which cannot be reversed.

**My Approach**

All point-awarding operations should use PostgreSQL atomic increment operations (`UPDATE users SET total_points = total_points + $1 WHERE id = $2`) rather than a read-followed-by-write pattern. Additionally, the `rewards_log` table already records every action; a uniqueness constraint should be added on `(user_id, action_type, DATE(created_at))` for daily-limited actions to prevent the same action from being recorded twice in the same day, even under concurrent requests.

**I want to work on this issue.**

---

### Hard Issue 5: No Wallet Ownership Verification — Any Address Can Be Claimed

**Problem Description**

In the frontend, users can link a wallet address to their account by submitting it through the settings interface, which calls the `frontend/app/api/user/settings/route.ts` endpoint. There is no cryptographic proof required that the user actually controls the submitted wallet address. A malicious actor who knows another user's wallet address can associate that address with their own account by simply calling the API with that address. This allows them to see that user's swap history and potentially receive rewards that belong to the real wallet owner.

**Why It Is Required**

Wallet address association is the fundamental identity primitive in a Web3 application. Allowing unverified address claims is a serious security vulnerability that can be exploited to hijack another user's on-chain identity within the platform, steal their accumulated reward points, and expose their financial history. A proper ownership proof mechanism is mandatory before any financial feature can be considered secure.

**My Approach**

A sign-in-with-Ethereum (SIWE) flow should be implemented. When a user wants to link a wallet address, the backend should generate a unique nonce and store it temporarily. The frontend should ask the user to sign a message containing the nonce using their wallet (via MetaMask or WalletConnect). The signed message should be sent back to the backend, which verifies the signature using the submitted wallet address. Only if the recovered address matches the submitted address should the link be saved to the database. This is an industry-standard practice for Web3 authentication.

**I want to work on this issue.**

---

### Hard Issue 6: Conversation State Management Is Vulnerable to Corruption from Concurrent Messages

**Problem Description**

The Telegram bot stores each user's conversation state as a single JSON blob in the `conversations` table (in `bot/src/services/database.ts`). When a user sends multiple messages in rapid succession, multiple bot handler invocations run concurrently against the same conversation record. Each invocation reads the state, modifies it, and writes it back. Telegraf processes messages asynchronously, which means the second handler can read a stale version of the state before the first handler has written its update. When the second handler's write completes, it silently overwrites the first handler's changes, causing conversation state corruption and loss of dialog context.

**Why It Is Required**

The conversation state holds critical multi-step dialog information, such as the pending swap details waiting for user confirmation, the asset pair being discussed, and the confirmation step the user is on. Corrupting this state mid-conversation causes the bot to behave erratically — for example, confirming a swap with the wrong details or forgetting that a confirmation was already received. This directly impacts the reliability of swap execution through the Telegram interface.

**My Approach**

The conversation state update should use a `SELECT ... FOR UPDATE` lock within a database transaction to ensure that only one handler processes the conversation state at a time. Additionally, a version counter field should be added to the `conversations` table. Each update should include `WHERE version = $expected_version` to implement optimistic concurrency control, rejecting stale writes. If a write is rejected, the handler should re-read the state and re-apply its changes.

**I want to work on this issue.**

---

### Hard Issue 7: Price Cache Has No Staleness Guard for Limit Order Execution

**Problem Description**

The `limitOrderWorker.ts` checks whether a user's limit condition is met by reading the current price from the `coin_price_cache` table in the database. The cache has an `expiresAt` field, but there is no check in the worker to verify whether the cached price is within an acceptable freshness window before using it to make an execution decision. If the price refresh cron job (`frontend/lib/price-refresh-cron.ts`) fails or is delayed, the `coin_price_cache` can contain hours-old prices. The worker will still read these stale entries and trigger limit order executions based on market data that no longer reflects reality.

**Why It Is Required**

Executing a limit order based on a stale price is a financial error. A user who set a buy order at "ETH below 2000" does not want the order to execute because the cache recorded a price of 1999 twelve hours ago when ETH is actually trading at 2500 now. This is a silent, hard-to-diagnose bug that results in users having trades executed at conditions they never actually met, which can cause financial losses.

**My Approach**

Before using a cached price for any limit order execution decision, the worker should check whether the `updatedAt` timestamp of the cache record is within a configurable maximum staleness window (for example, 10 minutes). If the cached price is stale, the worker should either skip the order for that tick and log a warning, or make a direct live API call to fetch the current price and use that instead. A staleness threshold constant should be defined and documented so it can be tuned.

**I want to work on this issue.**

---

### Hard Issue 8: No Rate-Limit Handling in OrderMonitor for SideShift API 429 Responses

**Problem Description**

The `OrderMonitor` in `bot/src/services/order-monitor.ts` polls the SideShift API for order status updates. The `getBackoffInterval` function implements age-based backoff, but there is no handling for HTTP 429 (Too Many Requests) responses from the SideShift API. When SideShift rate-limits the bot, the current code will simply catch an error from the HTTP client, log it, and continue polling at the same rate on the next tick. This means the bot will keep hammering the API even after being told to stop, which can lead to the API key being temporarily or permanently suspended.

**Why It Is Required**

SideShift.ai is a third-party service that the entire platform depends on. If the SideShift API key is suspended due to excessive polling after rate-limit errors, every user of the bot loses the ability to execute swaps entirely. A proper rate-limit response handler is a basic requirement for any application that consumes a third-party API and needs to operate reliably in production.

**My Approach**

The HTTP client wrapper for SideShift API calls should catch 429 responses and extract the `Retry-After` header if present. A global backoff state should be maintained in the `OrderMonitor` (or in the SideShift client itself). When a 429 is received, all polling should pause for the duration specified by `Retry-After` (or a sensible default, such as 60 seconds). After the backoff period, polling should resume. The backoff state should be logged clearly so operators can detect when the system is being rate-limited.

**I want to work on this issue.**

---

### Hard Issue 9: Admin Dashboard Has No Audit Log for Privileged Actions

**Problem Description**

The admin dashboard, with routes in `frontend/app/api/admin/`, allows privileged users to approve or reject admin access requests and view analytics. However, none of the admin actions are recorded in any audit log. There is no record of which admin approved a request, when they approved it, what analytics were viewed, or whether any account was modified. The `adminRequests` table records who reviewed a request, but only through the `reviewedBy` email field — there is no separate immutable audit trail table.

**Why It Is Required**

For a financial application with user data and funds involved, an audit log is not optional — it is a compliance and security requirement. Without an audit trail, it is impossible to investigate suspicious admin activity, detect insider threats, or demonstrate regulatory compliance. If an admin account is compromised, the damage cannot be assessed without knowing what actions were taken under that account.

**My Approach**

A new `admin_audit_log` table should be added to `shared/schema.ts` with fields for `adminId`, `action`, `targetResource`, `targetId`, `metadata` (a JSONB field for action-specific context), and `createdAt`. Every admin API route should insert a record into this table after performing its action. The admin dashboard should include a read-only audit log view, accessible only to super admins, that displays recent admin activity in chronological order.

**I want to work on this issue.**

---

### Hard Issue 10: RewardToken Smart Contract Has No Minting Cap or Access Control Upgrade Path

**Problem Description**

The `RewardToken.sol` contract in `hardhat/contracts/RewardToken.sol` is a mintable ERC-20 token. While ownership is controlled by the deployer, there is no on-chain minting cap — the owner can mint an unlimited number of tokens at any time. Additionally, the contract uses simple `Ownable` ownership with no multi-sig or time-lock mechanism. A single compromised deployer private key would allow unlimited token minting, completely inflating the token supply and destroying the reward economy of the platform. There is also no upgrade path defined, meaning any bug in the contract logic requires a full redeployment and token migration.

**Why It Is Required**

A token with unbounded minting ability and single-key control is a critical financial risk. In the DeFi ecosystem, unlimited minting by a single account is the most common attack vector in rug-pull scenarios, whether malicious or due to key compromise. Even if the team is fully trustworthy, the absence of an on-chain cap makes it impossible for users to verify the supply guarantee independently, which undermines trust.

**My Approach**

A maximum supply cap constant should be added to the contract, and the `mint` function should revert if minting would exceed that cap. The ownership model should be upgraded to use a multi-signature scheme (such as Gnosis Safe) or a time-locked governor contract, so that minting operations require multiple approvals and have a mandatory delay before execution. The contract should also emit a clear `MaxSupplyMint` event when the cap is reached, so the community can independently verify on-chain that no further minting is possible.

**I want to work on this issue.**

---

## Part 2 — Medium-Level Issues

---

### Medium Issue 1: Discussion Forum Has No Content Moderation or Spam Filtering

**Problem Description**

The discussions feature, implemented in `frontend/app/discussions/page.tsx` and backed by `frontend/app/api/discussions/route.ts`, allows any authenticated user to post content publicly. There is no profanity filter, no spam detection, no rate limiting on post creation, and no ability for a moderator to delete or hide posts from the admin dashboard. A bad actor can flood the discussion board with spam, offensive content, or even phishing links targeting other users.

**Why It Is Required**

An unmoderated public discussion forum attached to a financial platform is a significant reputational and safety risk. Phishing links disguised as helpful swap advice could trick users into connecting their wallets to malicious sites. Spam floods make the feature unusable and degrade the community experience. Basic moderation capabilities are required before this feature can be safely promoted to users.

**My Approach**

A `is_hidden` boolean column and a `moderation_reason` text column should be added to the `discussions` table. The admin dashboard should be extended with a content moderation panel that lists recent posts and allows admins to hide them with a reason. On the API level, a rate limit should be applied to post creation per user (for example, a maximum of 5 posts per hour). A basic blocklist of known phishing domains and profanity terms should be checked server-side before any post is accepted.

**I want to work on this issue.**

---

### Medium Issue 2: Swap History API Has No Pagination, Returning All Records

**Problem Description**

The swap history endpoint at `frontend/app/api/swap-history/route.ts` queries the `swap_history` table and returns all records for a given user in a single response. For a user who has been active for months and executed hundreds of swaps, this query will return a very large payload, slow down the page load, and potentially cause the browser to lag when rendering the history table. There is no `limit`, `offset`, or cursor-based pagination mechanism in place.

**Why It Is Required**

Returning unbounded data from an API endpoint is a common performance anti-pattern. As the platform grows and users accumulate more history, this endpoint will degrade in performance for the most valuable (most active) users. It also represents a potential denial-of-service vector if a user or attacker manages to create a large number of history records, forcing the API to serialize and transmit a massive payload on every request.

**My Approach**

The swap history endpoint should accept `page` and `limit` query parameters (with sensible defaults, such as `limit=20` and `page=1`). The database query should use `.limit()` and `.offset()` accordingly. The API response should include a pagination metadata object containing `totalCount`, `currentPage`, `totalPages`, and `hasNextPage`. The frontend history component should be updated to display a paginated table with "Previous" and "Next" navigation controls.

**I want to work on this issue.**

---

### Medium Issue 3: Learning Module Course Content Is Entirely Hardcoded with No CMS

**Problem Description**

The learning module, accessed at `frontend/app/learn/[id]/page.tsx`, displays educational courses about cryptocurrency and SwapSmith features. The course content — titles, descriptions, modules, and lesson text — appears to be hardcoded directly in the frontend code or in static data files. Adding a new course or updating an existing lesson requires a code change and a new deployment, making content updates slow and requiring developer involvement for what should be a non-technical task.

**Why It Is Required**

Educational content needs to be updated frequently to reflect changes in the platform's features, market conditions, and newly supported chains or tokens. Requiring a developer to deploy code changes just to fix a typo in a course description creates unnecessary bottlenecks. This also makes it impossible for community contributors or content writers to propose or submit updates without going through a full pull request and review cycle.

**My Approach**

A new `courses` table should be added to the database schema, with fields for `id`, `title`, `description`, `category`, `modules` (as a JSONB array), `isPublished`, and `updatedAt`. The admin dashboard should include a course management panel where admins can create, edit, and publish courses without writing code. The `learn/[id]` page should fetch course data from a new API endpoint that reads from this table, replacing the hardcoded content. Existing course data should be migrated to the database as a one-time seeding script.

**I want to work on this issue.**

---

### Medium Issue 4: No Ability to Export Swap History as CSV or JSON

**Problem Description**

Users can view their swap history within the platform, but there is no way to export that history as a downloadable file. For tax reporting purposes, crypto traders often need a complete record of their trades, including dates, amounts, asset pairs, and transaction hashes. Without an export feature, users must manually copy data from the UI row by row, which is error-prone and time-consuming for users with significant trade histories.

**Why It Is Required**

Tax reporting for cryptocurrency is a legal requirement in many jurisdictions. Users who trade frequently need accurate, complete records to calculate capital gains and losses. A platform that facilitates dozens or hundreds of swaps but provides no export capability forces users to seek third-party tools or perform tedious manual data entry. Providing a simple CSV export is a basic quality-of-life feature that directly addresses a real user need.

**My Approach**

A new API endpoint should be added at `frontend/app/api/swap-history/export/route.ts` that accepts a date range and format parameter (`csv` or `json`). The endpoint should query the user's swap history within the given range, format it appropriately, and return it as a file download with the correct `Content-Disposition` header. The swap history page in the frontend should include an "Export" button that opens a date range picker and triggers the download. The CSV should include columns for date, from asset, from amount, to asset, received amount, status, and transaction hash.

**I want to work on this issue.**

---

### Medium Issue 5: Price Alerts Only Support Telegram Notifications, Not Email or Browser Push

**Problem Description**

The price alert system in `bot/src/workers/price-alerts.ts` and `frontend/app/api/rewards/activities/route.ts` currently sends alerts exclusively through Telegram messages. Users who use the web frontend but have not connected a Telegram account have no way to receive price alerts. Additionally, even for Telegram users, missing a message due to notification settings means the alert is silently lost with no fallback delivery channel.

**Why It Is Required**

A price alert is a time-sensitive notification that a user explicitly requested. If the only delivery channel fails silently — because the user's Telegram notifications are muted, they are not using Telegram, or the bot fails to send the message — the alert is lost and the user misses the market condition they were waiting for. Multiple notification channels ensure that at least one reaches the user at the critical moment.

**My Approach**

The alert delivery logic should be abstracted into a notification service that supports multiple channels. Email delivery should be added using the existing email utility in `frontend/lib/email.ts`. Browser push notifications should be enabled using the Web Push API, with the user's push subscription stored in the `user_settings` table. When an alert triggers, the system should attempt to deliver it through all channels that the user has enabled in their notification preferences. Delivery failures per channel should be logged independently.

**I want to work on this issue.**

---

### Medium Issue 6: Frontend Has No React Error Boundaries, Causing White Screens on Component Crashes

**Problem Description**

The SwapSmith frontend is a Next.js application built with React. None of the major page components or feature sections — such as the chat interface, swap confirmation dialog, or portfolio summary — are wrapped in React Error Boundaries. If any component throws an unhandled JavaScript error during rendering, the entire page will unmount and display a blank white screen to the user with no helpful message or recovery path. Common triggers include unexpected API response shapes, null pointer access on missing data, and third-party library failures.

**Why It Is Required**

In a financial application, a white screen during a swap confirmation or deposit address display is extremely dangerous. A user mid-transaction who sees a blank page may not know whether their transaction was submitted or not, leading to panic and potentially double-spending. Error boundaries are a React best practice that prevent a single component failure from crashing the entire application, allowing other parts of the UI to remain functional and giving users a clear, actionable error message.

**My Approach**

A reusable `ErrorBoundary` React component should be created and placed around all major feature sections of the application: the chat interface, the swap confirmation flow, the portfolio summary, and the terminal page. The error boundary should display a user-friendly fallback UI that explains something went wrong and offers a button to retry or reload the section. Critical errors caught by the boundary should be reported to the logging service so developers are notified. The boundaries should be placed at a granular enough level that a crash in one feature section does not affect other visible parts of the page.

**I want to work on this issue.**

---

### Medium Issue 7: No Sitemap or robots.txt, Reducing Search Engine Discoverability

**Problem Description**

The SwapSmith frontend has multiple public-facing pages including the landing page, the docs page, the about page, the legal and privacy pages, the learn module, and the contributors page. However, there is no `sitemap.xml` file and no `robots.txt` file present in the `frontend/public/` directory. Without these files, search engine crawlers cannot efficiently discover and index the platform's public content, which negatively impacts organic traffic and makes it harder for potential users to find SwapSmith through search engines.

**Why It Is Required**

A sitemap allows search engines to understand the structure of the website and prioritize crawling the most important pages. A `robots.txt` file tells crawlers which pages to index and which to skip (such as admin routes, API routes, and user-specific pages). Without these, search engines may waste crawl budget on irrelevant pages while missing key marketing pages, and they may accidentally attempt to index private API endpoints.

**My Approach**

A `robots.txt` file should be created in `frontend/public/` that allows crawling of all public pages and disallows crawling of `/api/`, `/admin/`, `/profile/`, and `/checkout/`. Next.js provides native support for generating a `sitemap.xml` using the `app/sitemap.ts` convention — a sitemap generator file should be created there that programmatically lists all static public routes with their last-modified dates and change frequencies. Dynamic routes such as `/learn/[id]` should be populated by querying the course list at build time.

**I want to work on this issue.**

---

### Medium Issue 8: The `slippage_tolerance` Field in `user_settings` Is Stored as `real` (Float)

**Problem Description**

In `shared/schema.ts`, the `user_settings` table stores `slippage_tolerance` as a PostgreSQL `real` column, which is a 4-byte floating-point type. Slippage tolerance values like `0.5%`, `1.0%`, or `0.005` are commonly used in DeFi applications and must be stored and compared with precision. A floating-point representation of these values introduces rounding errors that can cause the displayed slippage to differ from the value used in API calls, potentially resulting in quotes being accepted or rejected at incorrect thresholds.

**Why It Is Required**

While slippage tolerance is not a financial amount itself, it is a parameter used to make financial decisions. An incorrect slippage value passed to the SideShift API can cause the order creation to fail unexpectedly (if tolerance is rounded down) or to accept quotes with worse rates than the user intended (if tolerance is rounded up). Consistency and precision in this field are important for user trust and correct behavior.

**My Approach**

The `slippage_tolerance` column in the `user_settings` table should be changed from `real` to `numeric(5, 4)` to support values from 0.0000 to 9.9999 with four decimal places of precision. A database migration should be written to convert the existing `real` column to `numeric`. The API routes that read and write this field should ensure the value is treated as a fixed-point decimal string throughout the application stack, not as a JavaScript floating-point number.

**I want to work on this issue.**

---

### Medium Issue 9: The Bot Has No User-Facing Help Command Listing All Available Commands

**Problem Description**

New users of the SwapSmith Telegram bot have no structured way to discover what commands and features are available to them. While the bot responds to natural language input and specific commands like `/swap`, `/dca`, and `/alert`, there is no comprehensive `/help` command that lists all supported commands with brief descriptions of what each one does. Users must either already know the commands, guess them, or discover them through trial and error.

**Why It Is Required**

User onboarding is critical for adoption. A bot that provides no self-documentation forces users to read external documentation (which many will not do) or give up after their first failed command. A well-structured `/help` command is the standard convention for Telegram bots and sets the right expectations. It also reduces support burden by allowing users to self-serve answers to basic questions about what the bot can do.

**My Approach**

A `/help` command handler should be added to `bot/src/bot.ts` that sends a formatted Telegram message listing every available command grouped by category (for example, Swaps, Automation, Portfolio, Settings). Each command entry should include the command name, a one-line description of its purpose, and a short example of valid input. The help text should also mention natural language support so users understand they can describe their intent without memorizing specific command syntax. The bot's Telegram command menu (set via `setMyCommands`) should be updated to include all available commands so they appear in the Telegram UI's command suggestions.

**I want to work on this issue.**

---

### Medium Issue 10: No Mechanism to Handle Expired Quotes During the Swap Confirmation Flow

**Problem Description**

When a user requests a swap, a quote is fetched from SideShift and displayed in the confirmation UI (in `frontend/components/SwapConfirmation.tsx` and the terminal page). SideShift quotes have an expiration time captured in the `expiry` field. If the user takes longer than the quote's validity window to confirm the swap, the quote will have expired by the time they click "Confirm." This can happen for entirely reasonable reasons — stepping away from the screen, checking the rate on another platform, or simply reading the details carefully. The problem is that the frontend currently provides no visible countdown timer, no warning as expiry approaches, and no automatic quote refresh. The user ends up submitting an expired quote to the backend, receives a vague error, and has no clear path to recover.

**Why It Is Required**

A confusing error message after a user has already decided to proceed with a swap creates friction and erodes trust. The user may not understand why their confirmed swap failed, assume the platform is broken, and abandon the transaction. A proactive expiry countdown and automatic quote refresh ensures the user always acts on valid data and has a smooth experience even if they take time to deliberate.

**My Approach**

The `SwapConfirmation` component should display a countdown timer showing how long the current quote remains valid, derived from the `expiry` field. When the countdown reaches 30 seconds, a warning should appear indicating the quote is about to expire. When the quote expires, the confirm button should be disabled and an "Refresh Quote" button should appear. Clicking it should re-fetch a fresh quote from the same API, update the displayed rate and settle amount, and reset the countdown. This gives the user clear feedback and a simple recovery path without losing context.

**I want to work on this issue.**

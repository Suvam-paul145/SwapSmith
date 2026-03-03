/**
 * Content moderation utility for the SwapSmith discussion forum.
 * Provides spam filtering, profanity detection, and rate-limit checks.
 */

// --- Blocked word patterns (case-insensitive) ---

const PROFANITY_PATTERNS: RegExp[] = [
  /\bf+u+c+k+\w*/i,
  /\bs+h+i+t+\w*/i,
  /\ba+s+s+h+o+l+e/i,
  /\bb+i+t+c+h+\w*/i,
  /\bd+a+m+n+\w*/i,
  /\bn+i+g+g+\w*/i,
  /\bf+a+g+g*o*t*/i,
  /\bc+u+n+t+/i,
  /\bw+h+o+r+e/i,
  /\br+e+t+a+r+d+\w*/i,
];

// --- Spam patterns ---

const SPAM_PATTERNS: RegExp[] = [
  // Repeated characters (e.g., "aaaaaaa")
  /(.)\1{9,}/,
  // Excessive caps (more than 80% uppercase in 20+ char text)
  // (checked separately)
  // Common spam phrases
  /\b(buy now|click here|free money|act now|limited offer|congratulations you won)\b/i,
  /\b(earn \$?\d+ per|work from home|make money fast)\b/i,
  // Crypto scam patterns
  /\b(send \d+ (btc|eth|sol|usdt))\b/i,
  /\b(airdrop|free tokens|guaranteed returns|100x)\b/i,
  /\b(dm me for|message me for|contact me for)\b/i,
  // URL spam (excessive URLs)
  /(https?:\/\/[^\s]+\s*){3,}/i,
];

// --- Link detection ---

const URL_REGEX = /https?:\/\/[^\s]+/gi;
const MAX_URLS_PER_POST = 2;

// --- Rate limiting (in-memory, per userId) ---

interface PostRecord {
  timestamps: number[];
}

const postHistory: Map<string, PostRecord> = new Map();

/** Max posts per user per time window */
const RATE_LIMIT_MAX_POSTS = 5;
/** Time window for rate limiting (ms) */
const RATE_LIMIT_WINDOW = 5 * 60_000; // 5 minutes
/** Minimum interval between posts (ms) */
const MIN_POST_INTERVAL = 10_000; // 10 seconds

// --- Types ---

export interface ModerationResult {
  allowed: boolean;
  reason?: string;
  filtered?: string;
}

// --- Public API ---

/**
 * Run all moderation checks on a discussion post.
 * Returns { allowed: true } if the content passes all checks,
 * or { allowed: false, reason: '...' } if it should be rejected.
 */
export function moderateContent(content: string, userId: string): ModerationResult {
  // 1. Rate limiting
  const rateCheck = checkRateLimit(userId);
  if (!rateCheck.allowed) return rateCheck;

  // 2. Content length check
  if (content.length > 5000) {
    return { allowed: false, reason: 'Content exceeds maximum length of 5000 characters.' };
  }

  // 3. Profanity check
  const profanityCheck = checkProfanity(content);
  if (!profanityCheck.allowed) return profanityCheck;

  // 4. Spam pattern check
  const spamCheck = checkSpamPatterns(content);
  if (!spamCheck.allowed) return spamCheck;

  // 5. Excessive caps check
  const capsCheck = checkExcessiveCaps(content);
  if (!capsCheck.allowed) return capsCheck;

  // 6. URL count check
  const urlCheck = checkUrlCount(content);
  if (!urlCheck.allowed) return urlCheck;

  // Record this post for rate limiting
  recordPost(userId);

  return { allowed: true };
}

// --- Internal helpers ---

function checkRateLimit(userId: string): ModerationResult {
  const now = Date.now();
  const record = postHistory.get(userId);

  if (record) {
    // Clean up old timestamps
    record.timestamps = record.timestamps.filter(t => now - t < RATE_LIMIT_WINDOW);

    // Check minimum interval
    const lastPost = record.timestamps[record.timestamps.length - 1];
    if (lastPost && now - lastPost < MIN_POST_INTERVAL) {
      return { allowed: false, reason: 'You are posting too quickly. Please wait a few seconds.' };
    }

    // Check max posts in window
    if (record.timestamps.length >= RATE_LIMIT_MAX_POSTS) {
      return { allowed: false, reason: 'Rate limit exceeded. Please wait a few minutes before posting again.' };
    }
  }

  return { allowed: true };
}

function recordPost(userId: string): void {
  const now = Date.now();
  const record = postHistory.get(userId);
  if (record) {
    record.timestamps.push(now);
  } else {
    postHistory.set(userId, { timestamps: [now] });
  }
}

function checkProfanity(content: string): ModerationResult {
  for (const pattern of PROFANITY_PATTERNS) {
    if (pattern.test(content)) {
      return { allowed: false, reason: 'Your message contains inappropriate language. Please revise and try again.' };
    }
  }
  return { allowed: true };
}

function checkSpamPatterns(content: string): ModerationResult {
  for (const pattern of SPAM_PATTERNS) {
    if (pattern.test(content)) {
      return { allowed: false, reason: 'Your message was flagged as potential spam. Please revise and try again.' };
    }
  }
  return { allowed: true };
}

function checkExcessiveCaps(content: string): ModerationResult {
  if (content.length < 20) return { allowed: true };

  const letters = content.replace(/[^a-zA-Z]/g, '');
  if (letters.length === 0) return { allowed: true };

  const upperCount = (content.match(/[A-Z]/g) || []).length;
  const capsRatio = upperCount / letters.length;

  if (capsRatio > 0.8) {
    return { allowed: false, reason: 'Excessive use of capital letters. Please use normal casing.' };
  }
  return { allowed: true };
}

function checkUrlCount(content: string): ModerationResult {
  const urls = content.match(URL_REGEX);
  if (urls && urls.length > MAX_URLS_PER_POST) {
    return { allowed: false, reason: `Too many links. Maximum ${MAX_URLS_PER_POST} URLs allowed per post.` };
  }
  return { allowed: true };
}

/** Exported for testing — clear post history */
export function _clearPostHistory(): void {
  postHistory.clear();
}

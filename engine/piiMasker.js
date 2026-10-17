// piiMasker.js - Automatic PII detection and redaction engine

// Standard regular expressions for PII detection
const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

// Phone numbers in various formats: +1 (555) 000-0000, +44 20 7946 0991, 555-123-4567, etc.
const PHONE_REGEX = /(\+?\d{1,3}[-.\s]?)?(\(?\d{2,4}\)?[-.\s]?)?\d{3,4}[-.\s]?\d{3,4}(?:[-.\s]?\d{1,9})?/g;

// Credit card numbers (Visa, MC, Amex, Discover: 13-19 digits with dashes or spaces)
const CREDIT_CARD_REGEX = /\b(?:\d{4}[-\s]){3}\d{4}\b|\b3[47]\d{2}[-\s]?\d{6}[-\s]?\d{5}\b/g;

// US Social Security Numbers: 000-00-0000
const SSN_REGEX = /\b\d{3}-\d{2}-\d{4}\b/g;

// Passwords in connection URIs: postgres://user:password@host:port/db
const CONNECTION_URI_PASSWORD_REGEX = /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^:\/\s]+:)([^@\/\s]+)(@[^/\s]+)/g;

// URL query parameter secrets: ?token=xxx or &api_key=xxx
const URL_QUERY_PARAM_SECRET_REGEX = /([?&](?:token|api_key|apikey|secret|access_token|client_secret|password)=)([^&\s"']+)/gi;

// Private Key blocks (PEM format)
const PEM_PRIVATE_KEY_REGEX = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;

// Token / Secret patterns (Stripe secret keys, Bearer tokens, JWTs, AWS keys, generic hashes)
const SECRET_KEY_PATTERNS = [
  /sk_(?:live|test)_[0-9a-zA-Z_-]{16,}/g,
  /Bearer\s+[A-Za-z0-9._~+/-]{16,}/gi,
  /jwt_[A-Za-z0-9._~+/-]{16,}/gi,
  /ey[A-Za-z0-9-_]{10,}\.[A-Za-z0-9-_]{10,}\.[A-Za-z0-9-_]{10,}/g,
  /(?:sup_sec_|api_key_|secret_|ghp_|gho_|xoxb-|xoxp-)[A-Za-z0-9._~+/-]{12,}/gi,
  /AIza[0-9A-Za-z-_]{35}/g,
  /AKIA[0-9A-Z]{16}/g
];

// Sensitive key name substrings (for object-level redaction)
const SENSITIVE_KEY_NAMES = [
  "password", "secret", "token", "auth", "api_key", "secret_key", 
  "credential", "private_key", "bearer", "session_id", "billing_token",
  "ssn", "credit_card", "card_number", "cvv", "passcode"
];

/**
 * Masks PII in plain text string
 * @param {string} text 
 * @returns {string} Redacted text
 */
export function maskStringPII(text) {
  if (typeof text !== "string") return text;

  let masked = text;

  // 1. Redact PEM Private Keys first
  masked = masked.replace(PEM_PRIVATE_KEY_REGEX, "[REDACTED_SECRET_KEY]");

  // 2. Redact Connection URI Passwords
  masked = masked.replace(CONNECTION_URI_PASSWORD_REGEX, "$1[REDACTED_SECRET]$3");

  // 3. Redact URL Query Parameter Secrets
  masked = masked.replace(URL_QUERY_PARAM_SECRET_REGEX, "$1[REDACTED_SECRET]");

  // 4. Redact Secrets & API Keys
  for (const pattern of SECRET_KEY_PATTERNS) {
    masked = masked.replace(pattern, (match) => {
      if (match.toLowerCase().startsWith("bearer ")) {
        return "Bearer [REDACTED_SECRET]";
      }
      return "[REDACTED_SECRET]";
    });
  }

  // 5. Redact Credit Cards & SSNs
  masked = masked.replace(CREDIT_CARD_REGEX, "[REDACTED_CARD]");
  masked = masked.replace(SSN_REGEX, "[REDACTED_SSN]");

  // 6. Redact Email addresses
  masked = masked.replace(EMAIL_REGEX, "[REDACTED_EMAIL]");

  // 7. Redact Phone numbers (ensure we don't accidentally redact small integers, UUIDs, or dates)
  masked = masked.replace(PHONE_REGEX, (match) => {
    // Avoid matching ISO timestamps like 2024-10-10 or 14:00:00
    if (/^\d{4}-\d{2}-\d{2}/.test(match) || /^\d{2}:\d{2}:\d{2}/.test(match)) {
      return match;
    }
    // Basic heuristics: must contain at least 7 digits and typical delimiters or '+'
    const digitCount = (match.match(/\d/g) || []).length;
    if (digitCount >= 7 && digitCount <= 15 && (/[-()+\s]/.test(match) || match.startsWith("+"))) {
      return "[REDACTED_PHONE]";
    }
    return match;
  });

  return masked;
}

/**
 * Recursively redacts PII within JSON-serializable objects/arrays
 * @param {any} val 
 * @param {string} keyHint 
 * @returns {any}
 */
export function maskObjectPII(val, keyHint = "") {
  if (val === null || val === undefined) return val;

  // Check key hint
  const lowerKey = keyHint.toLowerCase();
  const isSensitiveKey = SENSITIVE_KEY_NAMES.some(s => lowerKey.includes(s));

  if (typeof val === "string") {
    if (isSensitiveKey && val.length > 3 && !val.includes("[REDACTED_")) {
      return "[REDACTED_SECRET]";
    }
    return maskStringPII(val);
  }

  if (typeof val === "number") {
    // If key explicitly says SSN or CVV or Card
    if (isSensitiveKey && (lowerKey.includes("ssn") || lowerKey.includes("cvv") || lowerKey.includes("card"))) {
      return "[REDACTED_SECRET]";
    }
    return val;
  }

  if (Array.isArray(val)) {
    return val.map((item, idx) => maskObjectPII(item, `${keyHint}[${idx}]`));
  }

  if (typeof val === "object") {
    const clone = {};
    for (const [k, v] of Object.entries(val)) {
      clone[k] = maskObjectPII(v, k);
    }
    return clone;
  }

  return val;
}

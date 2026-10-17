// parser.js - Log noise stripper, payload extractor, JSON repair & infra error classifier

/**
 * Known infrastructure / system error patterns
 */
const INFRA_PATTERNS = [
  {
    regex: /(403\s+Forbidden|AccessDenied|PermissionDenied|InsufficientPermission|storage\.objects\.get\s+permission|unauthorized|401\s+Unauthorized|390144|JWT\s+token\s+is\s+invalid|SQL\s+access\s+control\s+error|Insufficient\s+privileges|NoSuchBucket)/i,
    category: "Authentication & Authorization Failure",
    summary: "Cloud service account, database user, or storage token lacks required IAM/ACL privileges or credential expired.",
    remediation: [
      "Verify IAM role bindings for the Airflow / orchestrator worker service account.",
      "Check bucket or dataset ACL permissions (e.g., BigQuery Data Editor, S3 GetObject, Snowflake ROLE).",
      "Rotate expired OAuth tokens, refreshed private keys, or refreshed credentials in cloud secrets manager."
    ]
  },
  {
    regex: /(Connection\s+refused|ConnectionRefusedError|ECONNREFUSED|ETIMEDOUT|504\s+Gateway\s+Timeout|502\s+Bad\s+Gateway|Max\s+retries\s+exceeded|getaddrinfo\s+ENOTFOUND|ServerDisconnectedError|ConnectTimeout)/i,
    category: "Network & Connection Interruption",
    summary: "Target endpoint, database instance, or upstream API is unreachable or timing out.",
    remediation: [
      "Verify VPC security groups, egress firewall rules, and internal DNS resolution.",
      "Check health and connection pool limits on the target database/cluster.",
      "Implement exponential backoff retry policy (e.g., Airflow retry_delay=timedelta(minutes=2))."
    ]
  },
  {
    regex: /(OutOfMemoryError|OOMKilled|MemoryError|Container\s+killed\s+by\s+OOM|exit\s+code\s+137|exceeded\s+memory\s+limit|Java\s+heap\s+space|Container\s+killed\s+by\s+YARN|Resources\s+exceeded\s+during\s+query\s+execution)/i,
    category: "Resource Exhaustion (Out Of Memory)",
    summary: "Pipeline worker container or query engine exceeded its RAM limit and was terminated (OOMKilled / SIGKILL).",
    remediation: [
      "Increase pod/task memory request and limit in Kubernetes/Airflow executor configs.",
      "Chunk data streaming into smaller batches or enable DuckDB / BigQuery disk-spilling.",
      "Avoid reading entire Parquet datasets into in-memory pandas DataFrames at once."
    ]
  },
  {
    regex: /(Quota\s+exceeded|rateLimitExceeded|429\s+Too\s+Many\s+Requests|ThrottlingException|ProvisionedThroughputExceededException)/i,
    category: "Cloud Quota / Rate Limit Exceeded",
    summary: "Pipeline throughput exceeded cloud API request or data ingestion rate quotas.",
    remediation: [
      "Request a service quota increase in Google Cloud Console / AWS Service Quotas.",
      "Add client-side rate limiting or stagger concurrent batch runs across DAG schedules."
    ]
  },
  {
    regex: /(SSL:?\s+CERTIFICATE_VERIFY_FAILED|SSLError|Certificate\s+expired|self-signed\s+certificate)/i,
    category: "SSL / TLS Handshake Failure",
    summary: "TLS certificate verification failed between the worker and upstream data source.",
    remediation: [
      "Ensure the enterprise CA bundle is mounted in the pipeline container truststore.",
      "Check expiration dates on database server SSL certificates."
    ]
  },
  {
    regex: /(deadlock\s+detected|lock\s+wait\s+timeout\s+exceeded|LockTimeout|could\s+not\s+obtain\s+lock)/i,
    category: "Database Deadlock & Lock Contention",
    summary: "Concurrent pipeline transactions conflicted trying to acquire write locks on target tables.",
    remediation: [
      "Stagger pipeline execution times or coordinate DAG dependencies with ExternalTaskSensors.",
      "Use partition-level staging swaps or atomic MERGE statements instead of raw UPDATEs.",
      "Configure transaction retry loops with randomized jitter delay."
    ]
  }
];

/**
 * Checks if raw log indicates an infrastructure/system failure
 * @param {string} logText 
 * @returns {object|null}
 */
export function detectInfraError(logText) {
  if (!logText) return null;

  for (const item of INFRA_PATTERNS) {
    const match = logText.match(item.regex);
    if (match) {
      return {
        isInfraError: true,
        matchedPattern: match[0],
        category: item.category,
        summary: item.summary,
        remediation: item.remediation
      };
    }
  }
  return null;
}

/**
 * Extracts metadata chips from orchestrator log text
 * @param {string} logText 
 * @returns {object}
 */
export function extractLogMetadata(logText) {
  const meta = {
    taskId: null,
    dagId: null,
    jobId: null,
    exception: null,
    lineInfo: null,
    timestamp: null,
    offendingColumns: []
  };

  if (!logText) return meta;

  // Task ID
  const taskMatch = logText.match(/Task\s+ID:?\s*([a-zA-Z0-9_\-\.]+)/i) ||
                    logText.match(/task_id\s*=\s*['"]?([a-zA-Z0-9_\-\.]+)['"]?/i);
  if (taskMatch) meta.taskId = taskMatch[1];

  // DAG ID
  const dagMatch = logText.match(/DAG\s+ID:?\s*([a-zA-Z0-9_\-\.]+)/i) ||
                   logText.match(/dag_id\s*=\s*['"]?([a-zA-Z0-9_\-\.]+)['"]?/i);
  if (dagMatch) meta.dagId = dagMatch[1];

  // Job ID
  const jobMatch = logText.match(/Job\s+ID:?\s*([a-zA-Z0-9_\-\.]+)/i) ||
                   logText.match(/job_id\s*=\s*['"]?([a-zA-Z0-9_\-\.]+)['"]?/i);
  if (jobMatch) meta.jobId = jobMatch[1];

  // Exception class & code
  const exMatch = logText.match(/([a-zA-Z0-9_\.]*(?:Exception|Error|BadRequest|ValidationError))(?::\s*(\d{3})?.*)?/);
  if (exMatch) {
    meta.exception = exMatch[1];
  }

  // Line / file reference
  const lineMatch = logText.match(/File\s+["']?([^"',\n]+)["']?,\s*line\s+(\d+)/i) ||
                    logText.match(/at\s+row\s+(\d+)/i) ||
                    logText.match(/line\s+(\d+)\s+column\s+(\d+)/i) ||
                    logText.match(/\{([^}:]+):(\d+)\}/);
  if (lineMatch) {
    meta.lineInfo = lineMatch[2] ? `${lineMatch[1]}:${lineMatch[2]}` : `Row ${lineMatch[1]}`;
  }

  // Timestamp
  const tsMatch = logText.match(/\b(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\b/);
  if (tsMatch) meta.timestamp = tsMatch[1];

  // Offending columns mentioned in error message
  const colMatches = [
    ...logText.matchAll(/column\s+['"`]([a-zA-Z0-9_\.]+)['"`]/gi),
    ...logText.matchAll(/Field\s+['"`]([a-zA-Z0-9_\.]+)['"`]/gi),
    ...logText.matchAll(/input_value=.*?(?:field|column)?.*?['"]([a-zA-Z0-9_\.]+)['"]/gi)
  ];
  for (const cm of colMatches) {
    if (cm[1] && !meta.offendingColumns.includes(cm[1])) {
      meta.offendingColumns.push(cm[1]);
    }
  }

  // Check Pydantic style lines: "customer.email\n  Field required"
  const pydanticColMatches = logText.matchAll(/\n([a-zA-Z0-9_\.]+)\n\s+(?:Field required|Input should be)/g);
  for (const pm of pydanticColMatches) {
    if (pm[1] && !meta.offendingColumns.includes(pm[1])) {
      meta.offendingColumns.push(pm[1]);
    }
  }

  return meta;
}

/**
 * Resilient JSON repair: unescapes, trims ellipsis/truncated indicators, and balances brackets
 * @param {string} rawSnippet 
 * @returns {any} parsed object or null
 */
export function resilientParseJson(rawSnippet) {
  if (!rawSnippet || typeof rawSnippet !== "string") return null;

  let text = rawSnippet.trim();

  // 1. If wrapped in outer quotes as a stringified JSON string: "{\"...\"}"
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    // Attempt standard unescaping
    try {
      const unescaped = JSON.parse(text);
      if (typeof unescaped === "string") {
        text = unescaped.trim();
      }
    } catch {
      // Manual strip outer quote
      text = text.substring(1, text.length - 1);
    }
  }

  // 2. Unescape common escaped sequences
  text = text
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "")
    .replace(/\\t/g, "  ")
    .replace(/\\\\/g, "\\");

  // 3. Remove truncation markers like '...', '[truncated]', etc.
  text = text
    .replace(/\[\s*\.\.\.\s*\]/g, "")
    .replace(/\[truncated\]/gi, "")
    .replace(/\(truncated\)/gi, "")
    .replace(/\(\d+\s+bytes\s+omitted\)/gi, "")
    .replace(/,\s*\.\.\.\s*(?=[\]}])/g, "") // trailing comma with ellipsis before close
    .replace(/\.\.\.\s*$/g, "")
    .replace(/,\s*$/g, ""); // trailing dangling comma

  // Direct parse attempt
  try {
    return JSON.parse(text);
  } catch (err) {
    // Proceed to normalization
  }

  // 4. Try normalizing Python dictionary literals & objects
  let pyNormalized = text
    .replace(/\bdatetime\.datetime\(\s*(\d{4})\s*,\s*(\d{1,2})\s*,\s*(\d{1,2})(?:,\s*(\d{1,2}))?(?:,\s*(\d{1,2}))?(?:,\s*(\d{1,2}))?[^)]*\)/gi, '"$1-$2-$3T00:00:00Z"')
    .replace(/\bdatetime\.date\(\s*(\d{4})\s*,\s*(\d{1,2})\s*,\s*(\d{1,2})\s*\)/gi, '"$1-$2-$3"')
    .replace(/\bDecimal\(\s*['"]?([0-9.-]+)['"]?\s*\)/gi, '$1')
    .replace(/\bUUID\(\s*['"]([^'"]+)['"]\s*\)/gi, '"$1"')
    .replace(/\bNone\b/g, "null")
    .replace(/\bTrue\b/g, "true")
    .replace(/\bFalse\b/g, "false")
    .replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, '"$1"');
  try {
    return JSON.parse(pyNormalized);
  } catch {}

  // 5. Bracket balancing repair
  let repaired = repairIncompleteJson(text) || repairIncompleteJson(pyNormalized);
  if (repaired) {
    try {
      return JSON.parse(repaired);
    } catch {
      // Fall through
    }
  }

  return null;
}

/**
 * Attempts to balance unclosed JSON braces/brackets and fix dangling keys
 * @param {string} str 
 * @returns {string|null}
 */
function repairIncompleteJson(str) {
  let s = str.trim();

  // Strip trailing commas, dots, and comments
  s = s.replace(/,\s*$/, "").replace(/\.\.\.\s*$/, "").trim();

  // Check if string contains JSON-like content
  const firstBrace = s.indexOf("{");
  const firstBracket = s.indexOf("[");

  let startIdx = -1;
  let isObject = false;

  if (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
    startIdx = firstBrace;
    isObject = true;
  } else if (firstBracket !== -1) {
    startIdx = firstBracket;
    isObject = false;
  }

  if (startIdx === -1) return null;
  s = s.substring(startIdx);

  // Strip dangling unclosed keys or key-colon at the end e.g. `, "key":` or `, "key"` or `, key:`
  s = s.replace(/,\s*"?([a-zA-Z0-9_.-]+)"?\s*:\s*$/, "");
  s = s.replace(/,\s*"?([a-zA-Z0-9_.-]+)"?\s*$/, "");

  // Stack-based bracket balancer
  const stack = [];
  let inString = false;
  let escape = false;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (!inString) {
      if (ch === "{" || ch === "[") {
        stack.push(ch);
      } else if (ch === "}") {
        if (stack.length && stack[stack.length - 1] === "{") stack.pop();
      } else if (ch === "]") {
        if (stack.length && stack[stack.length - 1] === "[") stack.pop();
      }
    }
  }

  // If ended mid-string, close quote
  if (inString) {
    s += '"';
    // If quote closed a dangling key, strip it if dangling
    s = s.replace(/,\s*"[^"]*":?\s*$/, "");
  }

  // Clean trailing commas that might now precede closures
  s = s.replace(/,\s*$/, "");

  // Close remaining open brackets in reverse
  while (stack.length > 0) {
    const openChar = stack.pop();
    if (openChar === "{") s += "}";
    if (openChar === "[") s += "]";
  }

  return s;
}

/**
 * Extracts payload JSON from a multi-line log or raw payload input
 * @param {string} rawInput 
 * @returns {{ payload: any, rawSnippet: string|null }}
 */
export function extractOffendingPayload(rawInput) {
  if (!rawInput) return { payload: null, rawSnippet: null };

  const trimmed = rawInput.trim();

  // Case A: Entire input is directly valid JSON
  const direct = resilientParseJson(trimmed);
  if (direct !== null && typeof direct === "object") {
    return { payload: direct, rawSnippet: trimmed };
  }

  // Case B: Explicit payload dump header
  const payloadHeaderRegex = /(?:Payload Snapshot|Failing Record Dump|Observed Chunk Header|Failing Record|Record Dump|Raw Payload|record_dump=)[\s:]*([\s\S]+)$/i;
  const headerMatch = rawInput.match(payloadHeaderRegex);
  if (headerMatch) {
    const snippet = headerMatch[1].trim();
    const parsed = resilientParseJson(snippet);
    if (parsed !== null && typeof parsed === "object") {
      return { payload: parsed, rawSnippet: snippet };
    }
  }

  // Case C: Scan for escaped JSON dumps or multiline objects/arrays
  const jsonCandidates = [];

  // Match escaped quotes "{\"..."}"
  const escapedMatches = rawInput.match(/"{\\?"[\s\S]+?\\?"}"/g) || [];
  for (const m of escapedMatches) {
    const p = resilientParseJson(m);
    if (p !== null && typeof p === "object") jsonCandidates.push({ payload: p, snippet: m });
  }

  // Match multi-line arrays [ ... ]
  const arrayMatches = rawInput.match(/\[\s*\{[\s\S]*?\}\s*\]/g) || [];
  for (const m of arrayMatches) {
    const p = resilientParseJson(m);
    if (p !== null && typeof p === "object") jsonCandidates.push({ payload: p, snippet: m });
  }

  // Match objects { ... }
  const objectMatches = rawInput.match(/\{[\s\S]*?\}/g) || [];
  for (const m of objectMatches) {
    // Skip tiny things like {taskinstance.py:1942}
    if (m.length > 15 && (m.includes(":") || m.includes(","))) {
      const p = resilientParseJson(m);
      if (p !== null && typeof p === "object") jsonCandidates.push({ payload: p, snippet: m });
    }
  }

  if (jsonCandidates.length > 0) {
    // Pick candidate with largest JSON size/complexity
    jsonCandidates.sort((a, b) => JSON.stringify(b.payload).length - JSON.stringify(a.payload).length);
    return { payload: jsonCandidates[0].payload, rawSnippet: jsonCandidates[0].snippet };
  }

  return { payload: null, rawSnippet: null };
}

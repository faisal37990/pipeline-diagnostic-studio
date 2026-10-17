// app.js - Main Application Controller for Pipeline Data & Schema Diagnostic Studio

import { PRESETS } from "./engine/presets.js";
import { 
  detectInfraError, 
  extractLogMetadata, 
  extractOffendingPayload, 
  resilientParseJson 
} from "./engine/parser.js";
import { analyzeSchemaDiscrepancies } from "./engine/schemaAnalyzer.js";
import { 
  generateRemediationCode, 
  repairAndSanitizePayload 
} from "./engine/remediation.js";
import { maskStringPII, maskObjectPII } from "./engine/piiMasker.js";

// DOM Elements
const rawLogInput = document.getElementById("raw-log-input");
const expectedSchemaInput = document.getElementById("expected-schema-input");
const targetDialectSelect = document.getElementById("target-dialect");
const logCounter = document.getElementById("log-counter");
const schemaCounter = document.getElementById("schema-counter");

const analyzeBtn = document.getElementById("analyze-btn");
const clearBtn = document.getElementById("clear-btn");
const loadSampleBtn = document.getElementById("load-sample-btn");

const emptyStateCard = document.getElementById("empty-state-card");
const resultsSection = document.getElementById("results-section");

// Banner Elements
const triageBannerCard = document.getElementById("triage-banner-card");
const triageStatusBadge = document.getElementById("triage-status-badge");
const badgeStatusText = document.getElementById("badge-status-text");
const rootCauseSummary = document.getElementById("root-cause-summary");
const metadataChipsContainer = document.getElementById("metadata-chips-container");
const infraRemediationContainer = document.getElementById("infra-remediation-container");
const infraStepsList = document.getElementById("infra-steps-list");

// Table Elements
const diffCountPill = document.getElementById("diff-count-pill");
const diffTableBody = document.getElementById("diff-table-body");

// Code & JSON Elements
const remediationDialectPill = document.getElementById("remediation-dialect-pill");
const remediationCodeBlock = document.getElementById("remediation-code-block");
const sanitizedJsonBlock = document.getElementById("sanitized-json-block");

const copyCodeBtn = document.getElementById("copy-code-btn");
const copyJsonBtn = document.getElementById("copy-json-btn");
const downloadJsonBtn = document.getElementById("download-json-btn");

const toastContainer = document.getElementById("toast-container");

// Preset Buttons
const presetBigQuery = document.getElementById("preset-bigquery");
const presetDuckDB = document.getElementById("preset-duckdb");
const presetPydantic = document.getElementById("preset-pydantic");

// Current Application State
let currentAnalysis = {
  discrepancies: [],
  metadata: {},
  payload: null,
  sanitizedJsonString: "",
  remediationCode: "",
  dialect: "bigquery",
  isInfraError: false
};

/* =========================================================================
   Event Listeners & Initialization
   ========================================================================= */

document.addEventListener("DOMContentLoaded", () => {
  setupCounters();
  setupPresets();
  setupActions();
  setupKeyboardShortcuts();
});

function setupCounters() {
  function updateCount(textarea, counterEl) {
    const text = textarea.value;
    const chars = text.length;
    const lines = text ? text.split("\n").length : 0;
    counterEl.textContent = `${chars.toLocaleString()} chars / ${lines} line${lines === 1 ? '' : 's'}`;
  }

  rawLogInput.addEventListener("input", () => updateCount(rawLogInput, logCounter));
  expectedSchemaInput.addEventListener("input", () => updateCount(expectedSchemaInput, schemaCounter));
}

function setupPresets() {
  presetBigQuery.addEventListener("click", () => loadPreset("bigquery_airflow"));
  presetDuckDB.addEventListener("click", () => loadPreset("duckdb_parquet"));
  presetPydantic.addEventListener("click", () => loadPreset("pydantic_python"));
  if (loadSampleBtn) {
    loadSampleBtn.addEventListener("click", () => loadPreset("bigquery_airflow"));
  }
}

function loadPreset(key) {
  const preset = PRESETS[key];
  if (!preset) return;

  rawLogInput.value = preset.log;
  expectedSchemaInput.value = preset.schema;
  targetDialectSelect.value = preset.dialect;

  // Update counters
  rawLogInput.dispatchEvent(new Event("input"));
  expectedSchemaInput.dispatchEvent(new Event("input"));

  showToast(`Loaded preset: ${preset.name}`, "info");

  // Automatically execute diagnosis
  runDiagnostic();
}

function setupActions() {
  analyzeBtn.addEventListener("click", runDiagnostic);

  clearBtn.addEventListener("click", () => {
    rawLogInput.value = "";
    expectedSchemaInput.value = "";
    rawLogInput.dispatchEvent(new Event("input"));
    expectedSchemaInput.dispatchEvent(new Event("input"));
    
    resultsSection.style.display = "none";
    emptyStateCard.style.display = "block";
    showToast("Cleared inputs and diagnostic results", "info");
  });

  // Dynamic dialect change without re-pasting
  targetDialectSelect.addEventListener("change", () => {
    if (resultsSection.style.display !== "none") {
      updateRemediationDialect();
      showToast(`Updated remediation code dialect to ${targetDialectSelect.selectedOptions[0].text}`, "info");
    }
  });

  // Copy buttons
  copyCodeBtn.addEventListener("click", () => {
    copyToClipboard(currentAnalysis.remediationCode, copyCodeBtn, "Code patch copied to clipboard!");
  });

  copyJsonBtn.addEventListener("click", () => {
    copyToClipboard(currentAnalysis.sanitizedJsonString, copyJsonBtn, "Sanitized JSON copied to clipboard!");
  });

  downloadJsonBtn.addEventListener("click", () => {
    if (!currentAnalysis.sanitizedJsonString) return;
    const blob = new Blob([currentAnalysis.sanitizedJsonString], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `remediated_pipeline_payload_${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast("Downloaded sanitized JSON file", "success");
  });
}

function setupKeyboardShortcuts() {
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      runDiagnostic();
    }
  });
}

/* =========================================================================
   Diagnostic Engine Runner
   ========================================================================= */

function runDiagnostic() {
  const rawLog = rawLogInput.value.trim();
  const rawSchema = expectedSchemaInput.value.trim();
  const dialect = targetDialectSelect.value;

  if (!rawLog) {
    showToast("Please provide an error log or JSON payload first", "warning");
    rawLogInput.focus();
    return;
  }

  // 1. Check for Infrastructure/Network/Auth errors first
  const infraError = detectInfraError(rawLog);

  if (infraError) {
    handleInfrastructureError(infraError, rawLog, dialect);
    return;
  }

  // 2. Extract Offending Payload and Metadata
  const { payload, rawSnippet } = extractOffendingPayload(rawLog);
  const metadata = extractLogMetadata(rawLog);

  // 3. Classify Schema Discrepancies
  const discrepancies = analyzeSchemaDiscrepancies(payload, rawSchema, rawLog);

  // 4. Update Application State
  currentAnalysis = {
    discrepancies,
    metadata,
    payload,
    dialect,
    isInfraError: false
  };

  // 5. Render Banner
  renderTriageBanner(discrepancies, metadata, payload);

  // 6. Render Schema Diff Table
  renderDiffTable(discrepancies);

  // 7. Render Remediation Code
  updateRemediationDialect();

  // 8. Render Sanitized Payload Exporter
  renderSanitizedPayload(payload, discrepancies);

  // 9. Show Results Panel
  emptyStateCard.style.display = "none";
  resultsSection.style.display = "flex";

  // Scroll smoothly to results
  resultsSection.scrollIntoView({ behavior: "smooth", block: "start" });
  showToast("Analysis complete. Diagnostic results ready.", "success");
}

/* =========================================================================
   Infrastructure Error Handler
   ========================================================================= */

function handleInfrastructureError(infra, rawLog, dialect) {
  const metadata = extractLogMetadata(rawLog);
  currentAnalysis = {
    discrepancies: [],
    metadata,
    payload: null,
    dialect,
    isInfraError: true
  };

  // Reset classes
  triageBannerCard.className = "triage-banner severity-infra";
  triageStatusBadge.className = "triage-badge badge-infra";
  badgeStatusText.textContent = "Infrastructure / System Failure";

  rootCauseSummary.innerHTML = `
    <strong>${infra.category}:</strong> ${infra.summary}
    <div style="margin-top: 6px; font-size: 13px; color: var(--text-muted);">
      Trigger matched: <code style="color: #fbbf24; font-family: var(--font-mono);">${escapeHtml(infra.matchedPattern)}</code>
    </div>
  `;

  // Metadata chips
  renderMetadataChips(metadata, ["Infrastructure Issue", infra.category]);

  // Show Infra checklist
  infraRemediationContainer.style.display = "block";
  infraStepsList.innerHTML = infra.remediation
    .map(step => `<li>${escapeHtml(step)}</li>`)
    .join("");

  // Diff Table: Show informative message
  diffCountPill.textContent = "0 Schema Issues (Infra Error)";
  diffTableBody.innerHTML = `
    <tr>
      <td colspan="5" style="text-align: center; padding: 36px 20px; color: var(--text-muted);">
        <div style="font-size: 14px; font-weight: 500; color: #fbbf24; margin-bottom: 6px;">
          No Schema Discrepancy Found
        </div>
        This failure is caused by an environmental or network barrier rather than data corruption. Follow the DevOps action steps outlined above.
      </td>
    </tr>
  `;

  // Remediation Code: Infrastructure retry & config script
  const infraScript = `# =========================================================================
# INFRASTRUCTURE & ORCHESTRATION REMEDIATION SCRIPT
# Recommended configuration to mitigate '${infra.category}'
# =========================================================================

# 1. Airflow DAG Operator Resilient Retry Policy:
from datetime import timedelta

default_args = {
    "retries": 4,
    "retry_delay": timedelta(minutes=3),
    "retry_exponential_backoff": True,
    "max_retry_delay": timedelta(minutes=15),
    "execution_timeout": timedelta(hours=1),
}

# 2. Recommended IAM & Service Account Checklist:
# - Validate Google Cloud / AWS role credentials.
# - Ensure network egress through VPC NAT Gateway is authorized.
# - Check cluster pod memory limits (prevent SIGKILL/OOM).
`;
  currentAnalysis.remediationCode = infraScript;
  remediationDialectPill.textContent = "DevOps / Infra Patch";
  remediationCodeBlock.innerHTML = highlightPython(infraScript);

  // Sanitized JSON
  const dummySanitized = {
    diagnostic_status: "SYSTEM_INFRASTRUCTURE_ERROR",
    error_classification: infra.category,
    detected_indicator: infra.matchedPattern,
    orchestrator_context: {
      task_id: metadata.taskId || "unknown_task",
      job_id: metadata.jobId || "unknown_job",
      timestamp: metadata.timestamp || new Date().toISOString()
    },
    action_required: "Review cloud credentials, IAM roles, or cluster memory resources."
  };
  const jsonStr = JSON.stringify(dummySanitized, null, 2);
  currentAnalysis.sanitizedJsonString = jsonStr;
  sanitizedJsonBlock.innerHTML = highlightJson(jsonStr);

  emptyStateCard.style.display = "none";
  resultsSection.style.display = "flex";
  resultsSection.scrollIntoView({ behavior: "smooth", block: "start" });
  showToast("Detected infrastructure / network barrier.", "warning");
}

/* =========================================================================
   Banner & Chips Rendering
   ========================================================================= */

function renderTriageBanner(discrepancies, metadata, payload) {
  infraRemediationContainer.style.display = "none";

  let statusBadgeClass = "badge-mismatch";
  let statusBadgeText = "Schema Mismatch Detected";
  let bannerClass = "triage-banner";

  const hasTypeMismatch = discrepancies.some(d => d.issueCategory === "Type Mismatch");
  const hasMissing = discrepancies.some(d => d.issueCategory === "Missing Required Field");
  const hasExtra = discrepancies.some(d => d.issueCategory === "Unexpected Extra Key");
  const hasNullViolation = discrepancies.some(d => d.issueCategory === "Null Constraint Violation");

  if (discrepancies.length === 0) {
    statusBadgeClass = "badge-healthy";
    statusBadgeText = "No Schema Conflicts";
    bannerClass = "triage-banner severity-ok";
  } else if (hasTypeMismatch) {
    statusBadgeClass = "badge-mismatch";
    statusBadgeText = "Type Coercion Failure";
  } else if (hasMissing) {
    statusBadgeClass = "badge-validation";
    statusBadgeText = "Missing Required Fields";
  } else if (hasExtra) {
    statusBadgeClass = "badge-infra";
    statusBadgeText = "Schema Drift Detected";
    bannerClass = "triage-banner severity-infra";
  }

  triageBannerCard.className = bannerClass;
  triageStatusBadge.className = `triage-badge ${statusBadgeClass}`;
  badgeStatusText.textContent = statusBadgeText;

  // Plain-English Root Cause Summary
  let summaryText = "";
  if (discrepancies.length === 0) {
    summaryText = "Payload conforms to expected schema specifications. No type mismatches or missing fields observed.";
  } else {
    const issueSummaries = discrepancies.slice(0, 3).map(d => {
      if (d.issueCategory === "Type Mismatch") {
        return `field <code>${escapeHtml(d.fieldPath)}</code> expected <strong>${escapeHtml(d.expectedType)}</strong> but received <strong>${escapeHtml(d.observedValue)}</strong> (${escapeHtml(d.receivedType)})`;
      }
      if (d.issueCategory === "Missing Required Field") {
        return `required key <code>${escapeHtml(d.fieldPath)}</code> was omitted`;
      }
      if (d.issueCategory === "Null Constraint Violation") {
        return `column <code>${escapeHtml(d.fieldPath)}</code> received null in violation of NOT NULL constraint`;
      }
      if (d.issueCategory === "Unexpected Extra Key") {
        return `unregistered telemetry column <code>${escapeHtml(d.fieldPath)}</code> introduced schema drift`;
      }
      return `${escapeHtml(d.fieldPath)}: ${escapeHtml(d.issueCategory)}`;
    });

    summaryText = `Found <strong>${discrepancies.length} discrepancy item${discrepancies.length > 1 ? 's' : ''}</strong>: ${issueSummaries.join("; ")}${discrepancies.length > 3 ? ` (and ${discrepancies.length - 3} more)` : ''}.`;
  }

  rootCauseSummary.innerHTML = summaryText;

  // Metadata Chips
  renderMetadataChips(metadata, discrepancies.map(d => d.fieldPath));
}

function renderMetadataChips(metadata, additionalContext = []) {
  metadataChipsContainer.innerHTML = "";

  const chips = [];

  if (metadata.taskId) chips.push({ label: "Task ID", val: metadata.taskId });
  if (metadata.dagId) chips.push({ label: "DAG", val: metadata.dagId });
  if (metadata.jobId) chips.push({ label: "Job ID", val: metadata.jobId });
  if (metadata.lineInfo) chips.push({ label: "Source", val: metadata.lineInfo });
  if (metadata.exception) chips.push({ label: "Exception", val: metadata.exception });
  if (metadata.timestamp) chips.push({ label: "Timestamp", val: metadata.timestamp });

  if (metadata.offendingColumns && metadata.offendingColumns.length > 0) {
    chips.push({ label: "Offending Column", val: metadata.offendingColumns.join(", ") });
  }

  for (const chip of chips) {
    const chipEl = document.createElement("div");
    chipEl.className = "meta-chip";
    chipEl.innerHTML = `<strong>${escapeHtml(chip.label)}:</strong> <span>${escapeHtml(chip.val)}</span>`;
    metadataChipsContainer.appendChild(chipEl);
  }
}

/* =========================================================================
   Schema Diff Table Rendering
   ========================================================================= */

function renderDiffTable(discrepancies) {
  diffCountPill.textContent = `${discrepancies.length} Issue${discrepancies.length === 1 ? '' : 's'}`;

  if (discrepancies.length === 0) {
    diffTableBody.innerHTML = `
      <tr>
        <td colspan="5" style="text-align: center; padding: 28px; color: var(--text-muted);">
          No schema discrepancies detected against the target definition.
        </td>
      </tr>
    `;
    return;
  }

  const rowsHtml = discrepancies.map(item => {
    let catClass = "cat-type-mismatch";
    if (item.issueCategory === "Missing Required Field") catClass = "cat-missing-field";
    else if (item.issueCategory === "Unexpected Extra Key") catClass = "cat-extra-key";
    else if (item.issueCategory === "Null Constraint Violation") catClass = "cat-null-constraint";

    return `
      <tr>
        <td class="field-path-cell">
          <span class="field-bullet">&bull;</span>
          <span>${escapeHtml(item.fieldPath)}</span>
        </td>
        <td>
          <span class="type-pill">${escapeHtml(item.expectedType)}</span>
        </td>
        <td>
          <div class="observed-cell">${escapeHtml(item.observedValue)}</div>
          <span class="observed-type-tag">${escapeHtml(item.receivedType)}</span>
        </td>
        <td>
          <span class="category-badge ${catClass}">
            ${escapeHtml(item.issueCategory)}
          </span>
        </td>
        <td class="action-needed-cell">
          ${escapeHtml(item.actionNeeded)}
        </td>
      </tr>
    `;
  }).join("");

  diffTableBody.innerHTML = rowsHtml;
}

/* =========================================================================
   Remediation Code Generator & Syntax Highlighting
   ========================================================================= */

function updateRemediationDialect() {
  const dialect = targetDialectSelect.value;
  currentAnalysis.dialect = dialect;

  const code = generateRemediationCode(
    dialect, 
    currentAnalysis.discrepancies, 
    currentAnalysis.metadata, 
    currentAnalysis.payload
  );

  currentAnalysis.remediationCode = code;

  let dialectLabel = "BigQuery SQL";
  let highlighted = "";

  if (dialect === "duckdb") {
    dialectLabel = "DuckDB SQL";
    highlighted = highlightSql(code);
  } else if (dialect === "pydantic") {
    dialectLabel = "Python / Pydantic v2";
    highlighted = highlightPython(code);
  } else {
    dialectLabel = "BigQuery SQL";
    highlighted = highlightSql(code);
  }

  remediationDialectPill.textContent = dialectLabel;
  remediationCodeBlock.innerHTML = highlighted;
}

function renderSanitizedPayload(payload, discrepancies) {
  const repairedObj = repairAndSanitizePayload(payload, discrepancies);
  const jsonStr = JSON.stringify(repairedObj, null, 2);
  currentAnalysis.sanitizedJsonString = jsonStr;
  sanitizedJsonBlock.innerHTML = highlightJson(jsonStr);
}

/* =========================================================================
   Syntax Highlighters (SQL, Python, JSON)
   ========================================================================= */

function highlightSql(sql) {
  let safe = escapeHtml(sql);

  // Comments
  safe = safe.replace(/(\/\*[\s\S]*?\*\/|--.*$)/gm, '<span class="syn-cmt">$1</span>');

  // Strings
  safe = safe.replace(/('(?:''|[^'\\]|\\.)*')/g, '<span class="syn-str">$1</span>');

  // SQL Keywords
  const keywords = [
    "SELECT", "FROM", "WHERE", "CREATE", "OR", "REPLACE", "TABLE", "VIEW", "AS",
    "EXCEPT", "EXCLUDE", "INSERT", "INTO", "ALTER", "ADD", "COLUMN", "IF", "NOT",
    "EXISTS", "OPTIONS", "COALESCE", "SAFE_CAST", "TRY_CAST", "CAST", "ROUND",
    "FLOOR", "SAFE.PARSE_TIMESTAMP", "read_parquet", "union_by_name", "NULLIF"
  ];
  const kwRegex = new RegExp(`\\b(${keywords.join("|")})\\b`, "gi");
  safe = safe.replace(kwRegex, (m) => `<span class="syn-kw">${m}</span>`);

  // Types
  const types = ["NUMERIC", "TIMESTAMP", "STRING", "FLOAT64", "INT64", "BIGINT", "INTEGER", "DOUBLE", "BOOLEAN"];
  const typeRegex = new RegExp(`\\b(${types.join("|")})\\b`, "gi");
  safe = safe.replace(typeRegex, (m) => `<span class="syn-type">${m}</span>`);

  return safe;
}

function highlightPython(py) {
  let safe = escapeHtml(py);

  // Comments
  safe = safe.replace(/(#.*$)/gm, '<span class="syn-cmt">$1</span>');

  // Strings (docstrings and single/double quotes)
  safe = safe.replace(/("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\"|[^"\\])*"|'(?:\\'|[^'\\])*')/g, '<span class="syn-str">$1</span>');

  // Keywords
  const keywords = ["class", "def", "return", "import", "from", "if", "else", "elif", "try", "except", "isinstance", "classmethod"];
  const kwRegex = new RegExp(`\\b(${keywords.join("|")})\\b`, "g");
  safe = safe.replace(kwRegex, (m) => `<span class="syn-kw">${m}</span>`);

  // Builtins & Types
  const types = ["BaseModel", "ConfigDict", "field_validator", "Any", "List", "Optional", "str", "int", "float", "bool", "dict"];
  const typeRegex = new RegExp(`\\b(${types.join("|")})\\b`, "g");
  safe = safe.replace(typeRegex, (m) => `<span class="syn-type">${m}</span>`);

  return safe;
}

function highlightJson(json) {
  let safe = escapeHtml(json);

  // Strings & Keys
  safe = safe.replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*")(\s*:)?/g, (match, p1, p2, p3) => {
    // If it's a key
    if (p3) {
      return `<span class="syn-key">${p1}</span>:`;
    }
    // Redacted token highlight
    if (p1.includes("[REDACTED_")) {
      return `<span class="syn-redacted">${p1}</span>`;
    }
    // Standard string
    return `<span class="syn-str">${p1}</span>`;
  });

  // Numbers & Booleans
  safe = safe.replace(/\b(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b/g, '<span class="syn-num">$1</span>');
  safe = safe.replace(/\b(true|false|null)\b/g, '<span class="syn-kw">$1</span>');

  return safe;
}

/* =========================================================================
   Utility Helpers
   ========================================================================= */

function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function copyToClipboard(text, buttonEl, successMsg) {
  if (!text) return;
  navigator.clipboard.writeText(text).then(() => {
    buttonEl.classList.add("copied");
    const origHtml = buttonEl.innerHTML;
    buttonEl.innerHTML = `
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="20 6 9 17 4 12"></polyline>
      </svg>
      <span>Copied!</span>
    `;
    showToast(successMsg, "success");
    setTimeout(() => {
      buttonEl.classList.remove("copied");
      buttonEl.innerHTML = origHtml;
    }, 2000);
  }).catch(() => {
    showToast("Failed to copy to clipboard", "warning");
  });
}

function showToast(message, type = "info") {
  const toast = document.createElement("div");
  toast.className = `toast ${type === 'success' ? 'toast-success' : ''}`;
  
  let iconSvg = `
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="10"></circle>
      <line x1="12" y1="16" x2="12" y2="12"></line>
      <line x1="12" y1="8" x2="12.01" y2="8"></line>
    </svg>
  `;
  if (type === "success") {
    iconSvg = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
        <polyline points="22 4 12 14.01 9 11.01"></polyline>
      </svg>
    `;
  } else if (type === "warning") {
    iconSvg = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
        <line x1="12" y1="9" x2="12" y2="13"></line>
        <line x1="12" y1="17" x2="12.01" y2="17"></line>
      </svg>
    `;
  }

  toast.innerHTML = `${iconSvg}<span>${escapeHtml(message)}</span>`;
  toastContainer.appendChild(toast);

  // Animate in
  setTimeout(() => toast.classList.add("show"), 20);

  // Auto remove
  setTimeout(() => {
    toast.classList.remove("show");
    setTimeout(() => {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 300);
  }, 3200);
}

// verify_engine.js - Comprehensive Verification & Dummy Run Test Suite

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

console.log("================================================================================");
console.log("🚀 STARTING PIPELINE DATA & SCHEMA DIAGNOSTIC STUDIO VERIFICATION SUITE");
console.log("================================================================================\n");

let passedTests = 0;
let totalTests = 0;

function assert(condition, message) {
  totalTests++;
  if (condition) {
    console.log(`  ✅ [PASS] ${message}`);
    passedTests++;
  } else {
    console.error(`  ❌ [FAIL] ${message}`);
  }
}

// -----------------------------------------------------------------------------
// TEST SUITE 1: PII MASKING ENGINE
// -----------------------------------------------------------------------------
console.log("--- TEST SUITE 1: PII Masking Engine ---");
{
  const emailTest = maskStringPII("Contact developer at test.user_99@subdomain.company.co.uk for details.");
  assert(emailTest.includes("[REDACTED_EMAIL]") && !emailTest.includes("test.user_99"), "Email address masked correctly");

  const phoneTest = maskStringPII("Call support hotline at +1 (555) 839-2019 or +44 20 7946 0991 immediately.");
  assert(phoneTest.includes("[REDACTED_PHONE]") && !phoneTest.includes("839-2019"), "International & US phone numbers masked correctly");

  const secretTest = maskStringPII("Bearer sup_sec_4981729019248572019a8f and sk_live_994827103948572019482");
  assert(secretTest.includes("Bearer [REDACTED_SECRET]") && secretTest.includes("[REDACTED_SECRET]"), "Bearer tokens and API keys masked correctly");

  const cardTest = maskStringPII("Payment card 4532-1234-5678-9010 and SSN 123-45-6789 detected in request.");
  assert(cardTest.includes("[REDACTED_CARD]") && cardTest.includes("[REDACTED_SSN]"), "Credit card numbers and SSNs masked correctly");

  const uriTest = maskStringPII("Connected to postgresql://analytics_user:super_secret_pw123@db-primary.internal:5432/lakehouse");
  assert(uriTest.includes("analytics_user:[REDACTED_SECRET]@db-primary") && !uriTest.includes("super_secret_pw123"), "Database connection URI passwords masked");

  const objPII = maskObjectPII({
    customer: { email: "lead@acme.org", phone: "+1 555 491 2910" },
    api_secret_key: "sk_live_verysecret1234567890",
    order_id: 101
  });
  assert(objPII.customer.email === "[REDACTED_EMAIL]", "Deep object email redacted");
  assert(objPII.customer.phone === "[REDACTED_PHONE]", "Deep object phone redacted");
  assert(objPII.api_secret_key === "[REDACTED_SECRET]", "Deep object sensitive key redacted");
  assert(objPII.order_id === 101, "Non-PII fields preserved untouched");
}

// -----------------------------------------------------------------------------
// TEST SUITE 2: NOISE STRIPPING, JSON RECOVERY & TRUNCATION RESILIENCE
// -----------------------------------------------------------------------------
console.log("\n--- TEST SUITE 2: Noise Stripping & JSON Recovery ---");
{
  const truncatedJson = `Failing record: { "order_id": 9942, "items": [{"sku": "A1", "price": 4.5}, ...`;
  const { payload } = extractOffendingPayload(truncatedJson);
  assert(payload !== null && payload.order_id === 9942, "Truncated payload with ellipsis gracefully recovered");
  assert(Array.isArray(payload.items) && payload.items[0].sku === "A1", "Nested truncated array closed and repaired");

  const cutOffMidKey = `{"id": 404, "status": "active", "unfini`;
  const parsedMidKey = resilientParseJson(cutOffMidKey);
  assert(parsedMidKey !== null && parsedMidKey.id === 404 && parsedMidKey.status === "active", "Payload cut off mid-key cleanly pruned and parsed");

  const escapedSnippet = `"{\\"status\\": \\"failed\\", \\"user\\": \\"john\\"}"`;
  const parsedEscaped = resilientParseJson(escapedSnippet);
  assert(parsedEscaped !== null && parsedEscaped.status === "failed", "Stringified escaped JSON unescaped and parsed");

  const pyTraceDump = `{'order_id': 8812, 'created_at': datetime.datetime(2024, 10, 10, 8, 30), 'amount': Decimal('129.50'), 'flag': True, 'null_val': None}`;
  const parsedPy = resilientParseJson(pyTraceDump);
  assert(parsedPy !== null && parsedPy.order_id === 8812, "Python dictionary dump normalized and parsed");
  assert(parsedPy.amount === 129.50 && parsedPy.flag === true && parsedPy.null_val === null, "Python Decimal, True, and None properly coerced to JSON types");
}

// -----------------------------------------------------------------------------
// TEST SUITE 3: NON-SCHEMA INFRASTRUCTURE ERROR HANDLING
// -----------------------------------------------------------------------------
console.log("\n--- TEST SUITE 3: Non-Schema Infrastructure Error Handling ---");
{
  const infraLog403 = `[2024-10-10 09:12:00] google.api_core.exceptions.Forbidden: 403 Caller does not have storage.objects.get permission for gs://prod-lake/orders/part.parquet`;
  const infraRes = detectInfraError(infraLog403);
  assert(infraRes !== null && infraRes.isInfraError === true, "403 Forbidden flagged as infrastructure error");
  assert(infraRes.category === "Authentication & Authorization Failure", "Correctly categorized as Auth/IAM failure");
  assert(infraRes.remediation.length > 0, "Provides actionable DevOps remediation steps");

  const infraLogConn = `psycopg2.OperationalError: could not connect to server: Connection refused (0x0000274D/10061)`;
  const infraConnRes = detectInfraError(infraLogConn);
  assert(infraConnRes !== null && infraConnRes.isInfraError === true, "Connection refused flagged as infrastructure error");
  assert(infraConnRes.category === "Network & Connection Interruption", "Correctly categorized as Network Interruption");

  const infraDeadlock = `ERROR: deadlock detected - Process 8412 waits for ShareLock on transaction 92104; blocked by process 8490.`;
  const deadlockRes = detectInfraError(infraDeadlock);
  assert(deadlockRes !== null && deadlockRes.isInfraError === true, "Database deadlock detected as infrastructure lock contention");

  const snowflakeAuth = `snowflake.connector.errors.DatabaseError: 390144 (08001): JWT token is invalid or expired.`;
  const sfRes = detectInfraError(snowflakeAuth);
  assert(sfRes !== null && sfRes.isInfraError === true, "Snowflake JWT expired flagged as Auth/IAM error");
}

// -----------------------------------------------------------------------------
// TEST SUITE 4: PRESET 1 - BIGQUERY / AIRFLOW MISMATCH
// -----------------------------------------------------------------------------
console.log("\n--- TEST SUITE 4: Preset 1 - BigQuery / Airflow Mismatch ---");
{
  const p1 = PRESETS.bigquery_airflow;
  const meta = extractLogMetadata(p1.log);
  assert(meta.taskId === "ingest_stripe_transactions", `Task ID extracted: ${meta.taskId}`);
  assert(meta.dagId === "finance_daily_reconciliation", `DAG ID extracted: ${meta.dagId}`);
  assert(meta.jobId === "bqjob_r79a83df2_1928374a_001", `Job ID extracted: ${meta.jobId}`);

  const { payload } = extractOffendingPayload(p1.log);
  assert(payload !== null && payload.transaction_id === "txn_982348234", "Offending payload extracted from Airflow dump");

  const discrepancies = analyzeSchemaDiscrepancies(payload, p1.schema, p1.log);
  assert(discrepancies.length >= 2, `Detected ${discrepancies.length} schema discrepancies`);

  const createdMismatch = discrepancies.find(d => d.fieldPath === "created_at");
  assert(createdMismatch && createdMismatch.issueCategory === "Type Mismatch", "created_at flagged as Type Mismatch (invalid calendar date)");

  const amountMismatch = discrepancies.find(d => d.fieldPath === "transaction_amount");
  assert(amountMismatch && amountMismatch.issueCategory === "Type Mismatch", "transaction_amount flagged as Type Mismatch ('N/A' into NUMERIC)");

  const bqCode = generateRemediationCode("bigquery", discrepancies, meta, payload);
  assert(bqCode.includes("SAFE.PARSE_TIMESTAMP"), "Remediation includes BigQuery SAFE.PARSE_TIMESTAMP");
  assert(bqCode.includes("SAFE_CAST"), "Remediation includes BigQuery SAFE_CAST");
  assert(bqCode.includes("REGEXP_REPLACE"), "Remediation includes currency/symbol sanitization");

  const sanitized = repairAndSanitizePayload(payload, discrepancies);
  assert(sanitized.customer_email === "[REDACTED_EMAIL]", "Sanitized payload has email redacted");
  assert(sanitized.api_secret_key === "[REDACTED_SECRET]", "Sanitized payload has secret key redacted");
  assert(sanitized.transaction_amount === 0.0, "Sanitized payload has invalid string 'N/A' repaired to 0.0");
}

// -----------------------------------------------------------------------------
// TEST SUITE 5: PRESET 2 - DUCKDB PARQUET MISMATCH
// -----------------------------------------------------------------------------
console.log("\n--- TEST SUITE 5: Preset 2 - DuckDB Parquet Mismatch ---");
{
  const p2 = PRESETS.duckdb_parquet;
  const meta = extractLogMetadata(p2.log);
  assert(meta.lineInfo === "Row 429", `Row reference extracted: ${meta.lineInfo}`);

  const { payload } = extractOffendingPayload(p2.log);
  assert(payload !== null && Array.isArray(payload) && payload[0].sku === "SKU-MONITOR-4K", "Offending Parquet chunk extracted");

  const discrepancies = analyzeSchemaDiscrepancies(payload, p2.schema, p2.log);
  assert(discrepancies.length >= 2, `Detected ${discrepancies.length} discrepancies`);

  const countMismatch = discrepancies.find(d => d.fieldPath === "item_count");
  assert(countMismatch && countMismatch.issueCategory === "Type Mismatch", "item_count flagged as Type Mismatch ('124.85' into INT32)");

  const nullViolation = discrepancies.find(d => d.fieldPath === "discount_rate");
  assert(nullViolation && nullViolation.issueCategory === "Null Constraint Violation", "discount_rate flagged as Null Constraint Violation");

  const duckCode = generateRemediationCode("duckdb", discrepancies, meta, payload);
  assert(duckCode.includes("TRY_CAST"), "Remediation includes DuckDB TRY_CAST");
  assert(duckCode.includes("union_by_name = true"), "Remediation includes union_by_name = true for schema drift");

  const sanitized = repairAndSanitizePayload(payload, discrepancies);
  assert(sanitized[0].support_contact_email === "[REDACTED_EMAIL]", "DuckDB sanitized output has contact email redacted");
  assert(sanitized[0].supplier_auth_token.includes("[REDACTED_SECRET]"), "DuckDB sanitized output has Bearer token redacted");
}

// -----------------------------------------------------------------------------
// TEST SUITE 6: PRESET 3 - PYDANTIC / PYTHON VALIDATION
// -----------------------------------------------------------------------------
console.log("\n--- TEST SUITE 6: Preset 3 - Pydantic / Python Validation ---");
{
  const p3 = PRESETS.pydantic_python;
  const meta = extractLogMetadata(p3.log);
  assert(meta.exception === "pydantic_core._pydantic_core.ValidationError", `Pydantic exception extracted: ${meta.exception}`);

  const { payload } = extractOffendingPayload(p3.log);
  assert(payload !== null && payload.order_ref === "ORD-2024-88491", "Pydantic offending payload extracted");

  const discrepancies = analyzeSchemaDiscrepancies(payload, p3.schema, p3.log);
  assert(discrepancies.length >= 2, `Detected ${discrepancies.length} discrepancies`);

  const missingEmail = discrepancies.find(d => d.fieldPath === "customer.email");
  assert(missingEmail && missingEmail.issueCategory === "Missing Required Field", "customer.email flagged as Missing Required Field");

  const qtyMismatch = discrepancies.find(d => d.fieldPath.includes("quantity"));
  assert(qtyMismatch && qtyMismatch.issueCategory === "Type Mismatch", "items.quantity flagged as Type Mismatch ('ten' into int)");

  const pydanticCode = generateRemediationCode("pydantic", discrepancies, meta, payload);
  assert(pydanticCode.includes("@field_validator"), "Remediation includes Pydantic @field_validator");
  assert(pydanticCode.includes("sanitize_incoming_payload"), "Remediation includes pre-validation sanitizer");

  const sanitized = repairAndSanitizePayload(payload, discrepancies);
  assert(sanitized.customer.email === "customer.fallback@enterprise.org", "Missing required email injected in sanitized payload");
  assert(sanitized.billing_token === "[REDACTED_SECRET]", "Billing JWT token redacted");
}

// -----------------------------------------------------------------------------
// TEST SUITE 7: MULTI-ROW ARRAY TRAVERSAL & STRICT DATE VALIDATION
// -----------------------------------------------------------------------------
console.log("\n--- TEST SUITE 7: Multi-Row Array Traversal & Strict DATE Validation ---");
{
  const multiRowPayload = {
    order_id: 501,
    order_date: "2024-02-30", // Invalid calendar date
    items: [
      { sku: "ITEM-A", price: 10.0, qty: 2 },
      { sku: "ITEM-B", price: 20.0, qty: "bad_count" } // 2nd row has violation
    ]
  };
  const ddl = `CREATE TABLE orders (
    order_id INT64 NOT NULL,
    order_date DATE NOT NULL,
    items ARRAY<STRUCT<sku STRING, price FLOAT64, qty INT64>>
  );`;

  const ddlSchema = `{
    "type": "object",
    "required": ["order_id", "order_date", "items"],
    "properties": {
      "order_id": { "type": "integer" },
      "order_date": { "type": "date" },
      "items": {
        "type": "array",
        "items": {
          "type": "object",
          "required": ["sku", "price", "qty"],
          "properties": {
            "sku": { "type": "string" },
            "price": { "type": "number" },
            "qty": { "type": "integer" }
          }
        }
      }
    }
  }`;

  const discrepancies = analyzeSchemaDiscrepancies(multiRowPayload, ddlSchema, "");
  const dateErr = discrepancies.find(d => d.fieldPath === "order_date");
  assert(dateErr && dateErr.issueCategory === "Type Mismatch", "Strict DATE validator catches invalid calendar date '2024-02-30'");

  const row2Err = discrepancies.find(d => d.fieldPath === "items[1].qty");
  assert(row2Err && row2Err.issueCategory === "Type Mismatch", "Multi-row array traversal successfully detects violation on items[1].qty");
}

console.log("\n================================================================================");
console.log(`📊 FINAL RESULT: ${passedTests} / ${totalTests} TESTS PASSED`);
if (passedTests === totalTests) {
  console.log("🎉 ALL TESTS PASSED! APPLICATION ENGINE IS 100% OPERATIONAL");
} else {
  console.error("⚠️ SOME TESTS FAILED!");
}
console.log("================================================================================\n");

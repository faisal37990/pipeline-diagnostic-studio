// presets.js - Realistic pipeline failure presets

export const PRESETS = {
  bigquery_airflow: {
    name: "BigQuery / Airflow Mismatch",
    dialect: "bigquery",
    description: "Airflow task failure: String passed into NUMERIC and malformed string in TIMESTAMP column.",
    log: `[2024-10-10 07:14:22,109] {taskinstance.py:1942} ERROR - Task failed with exception
Traceback (most recent call last):
  File "/opt/airflow/dags/ingest_stripe_pipeline.py", line 88, in execute
    job = client.load_table_from_json(records, table_ref, job_config=job_config)
  File "/opt/airflow/env/lib/python3.11/site-packages/google/cloud/bigquery/client.py", line 2841, in load_table_from_json
    return job.result()
google.api_core.exceptions.BadRequest: 400 Error while reading data, error message: Could not convert value '2024-02-30T14:00:00Z' to TIMESTAMP for column 'created_at'. Field 'transaction_amount' has type NUMERIC but received string 'N/A'.
Location: projects/fintech-prod-lake/datasets/analytics/tables/raw_transactions
Job ID: bqjob_r79a83df2_1928374a_001
Task ID: ingest_stripe_transactions
DAG ID: finance_daily_reconciliation
Failing Record Dump:
"{\\"transaction_id\\": \\"txn_982348234\\", \\"customer_email\\": \\"alice.smith@enterprise-client.com\\", \\"customer_phone\\": \\"+1 (555) 438-9201\\", \\"api_secret_key\\": \\"sk_live_994827103948572019482\\", \\"transaction_amount\\": \\"N/A\\", \\"currency\\": \\"USD\\", \\"created_at\\": \\"2024-02-30T14:00:00Z\\", \\"payment_method\\": \\"credit_card\\", \\"extra_gateway_tag\\": \\"stripe_v3_beta\\"}"`,
    schema: `CREATE TABLE \`fintech-prod-lake.analytics.raw_transactions\` (
  transaction_id STRING NOT NULL,
  customer_email STRING NOT NULL,
  customer_phone STRING,
  transaction_amount NUMERIC NOT NULL,
  currency STRING NOT NULL,
  created_at TIMESTAMP NOT NULL,
  payment_method STRING NOT NULL
);`
  },

  duckdb_parquet: {
    name: "DuckDB Parquet Mismatch",
    dialect: "duckdb",
    description: "DuckDB ConversionException: Float-to-int conflict on quantity column and schema drift from unmapped telemetry columns.",
    log: `2024-10-10 08:32:11.450 [ERROR] [DuckDB Worker #3] Pipeline stage [load_order_items] aborted.
duckdb.ConversionException: Conversion Error: Could not convert string '124.85' to INT32 in column 'item_count' at row 429
File: s3://warehouse-lakehouse/orders/year=2024/month=10/part-004.parquet
Thread ID: 0x7fff928100
Query: INSERT INTO warehouse.order_items SELECT * FROM read_parquet('s3://warehouse-lakehouse/orders/year=2024/month=10/*.parquet');
Observed Chunk Header:
[
  {
    "order_id": 89402,
    "sku": "SKU-MONITOR-4K",
    "item_count": "124.85",
    "unit_price": 299.99,
    "discount_rate": null,
    "support_contact_email": "ops-escalation@vendor-supply.io",
    "merchant_support_hotline": "+44 20 7946 0991",
    "supplier_auth_token": "Bearer sup_sec_4981729019248572019a8f",
    "user_agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    "client_ip": "198.51.100.42"
  }
]`,
    schema: `CREATE TABLE warehouse.order_items (
  order_id BIGINT NOT NULL,
  sku VARCHAR NOT NULL,
  item_count INTEGER NOT NULL,
  unit_price DOUBLE NOT NULL,
  discount_rate DOUBLE NOT NULL
);`
  },

  pydantic_python: {
    name: "Pydantic / Python Validation",
    dialect: "pydantic",
    description: "Pydantic v2 ValidationError: Missing required nested key 'customer.email' and type coercion failure on integer.",
    log: `ERROR:root:Validation error processing incoming webhook payload from partner ingest service
Traceback (most recent call last):
  File "/app/services/order_processor.py", line 112, in process_event
    order = OrderPayload.model_validate(raw_event["payload"])
  File "/usr/local/lib/python3.11/site-packages/pydantic/main.py", line 568, in model_validate
    return cls.__pydantic_validator__.validate_python(
pydantic_core._pydantic_core.ValidationError: 2 validation errors for OrderPayload
customer.email
  Field required [type=missing, input_value={'name': 'Jane Doe', 'phone': '+1 (415) 882-9011'}, input_type=dict]
items.0.quantity
  Input should be a valid integer, unable to parse string as an integer [type=int_parsing, input_value='ten', input_type=str]

Payload Snapshot:
{
  "order_ref": "ORD-2024-88491",
  "customer": {
    "name": "Jane Doe",
    "phone": "+1 (415) 882-9011"
  },
  "items": [
    {
      "sku": "CLOUD-SUB-01",
      "quantity": "ten",
      "price": 49.0
    }
  ],
  "billing_token": "jwt_ey891238491283.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvZSJ9.secret992834",
  "support_email": "jane.support@company-portal.org",
  "unregistered_flag": true
}`,
    schema: `{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "OrderPayload",
  "type": "object",
  "required": ["order_ref", "customer", "items"],
  "properties": {
    "order_ref": { "type": "string" },
    "customer": {
      "type": "object",
      "required": ["name", "email"],
      "properties": {
        "name": { "type": "string" },
        "email": { "type": "string", "format": "email" },
        "phone": { "type": "string" }
      }
    },
    "items": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["sku", "quantity", "price"],
        "properties": {
          "sku": { "type": "string" },
          "quantity": { "type": "integer" },
          "price": { "type": "number" }
        }
      }
    }
  }
}`
  }
};

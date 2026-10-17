from PIL import Image, ImageDraw, ImageFont
import os

width, height = 1200, 800 # 3:2 ratio
img = Image.new("RGBA", (width, height), "#080c14")
draw = ImageDraw.Draw(img)

# Background subtle grid / glow effects
for x in range(0, width, 40):
    draw.line([(x, 0), (x, height)], fill="#0f172a", width=1)
for y in range(0, height, 40):
    draw.line([(0, y), (width, y)], fill="#0f172a", width=1)

# Gradient accent borders / glow
for i in range(12):
    alpha = int(40 - i * 3)
    draw.rounded_rectangle([40 - i, 40 - i, width - 40 + i, height - 40 + i], radius=24, outline=(6, 182, 212, alpha), width=1)

# Card container
draw.rounded_rectangle([60, 60, width - 60, height - 60], radius=18, fill="#0f1624", outline="#1e293b", width=2)

# Header pill
draw.rounded_rectangle([100, 95, 340, 135], radius=20, fill="#132738", outline="#06b6d4", width=1)
draw.text((120, 105), "PIPELINE DIAGNOSTIC STUDIO", fill="#38bdf8")

# Live pulse dot
draw.ellipse([310, 110, 320, 120], fill="#10b981")

# Main Title
draw.text((100, 160), "Data Pipeline & Schema Diagnostic Studio", fill="#f8fafc")
draw.text((100, 215), "Triage orchestrator errors, detect schema drift & generate SQL/Python remediation patches.", fill="#94a3b8")

# Feature Panels
# Panel 1: Ingest & Triage
draw.rounded_rectangle([100, 280, 420, 520], radius=12, fill="#141d30", outline="#334155", width=1)
draw.text((120, 305), "1. Log Noise Stripper", fill="#38bdf8")
draw.text((120, 345), "- Auto un-escapes stringified JSON\n- Repairs truncated payloads (...)\n- Isolates failing records\n- Flags Infra/403/OOM errors", fill="#cbd5e1", spacing=10)

# Panel 2: Schema Diffing
draw.rounded_rectangle([440, 280, 760, 520], radius=12, fill="#141d30", outline="#334155", width=1)
draw.text((460, 305), "2. Discrepancy Auditing", fill="#fb7185")
draw.text((460, 345), "- Type Mismatches\n- Missing Required Fields\n- Schema Drift (Extra Keys)\n- Null Constraint Violations\n- Zero-leak PII Redaction", fill="#cbd5e1", spacing=10)

# Panel 3: Multi-Dialect Remediation
draw.rounded_rectangle([780, 280, 1100, 520], radius=12, fill="#141d30", outline="#334155", width=1)
draw.text((800, 305), "3. Multi-Dialect Patches", fill="#34d399")
draw.text((800, 345), "- BigQuery: SAFE_CAST / DDL\n- DuckDB: TRY_CAST / Parquet\n- Pydantic: @field_validator\n- Sanitized JSON Exporter", fill="#cbd5e1", spacing=10)

# Bottom Status Footer bar
draw.rounded_rectangle([100, 560, 1100, 700], radius=12, fill="#070a10", outline="#1e293b", width=1)
draw.text((125, 580), "-- Generated Remediation Query (BigQuery / DuckDB / Python) --", fill="#64748b")
draw.text((125, 615), "SELECT * EXCEPT(amount), COALESCE(SAFE_CAST(amount AS NUMERIC), 0.0) AS amount", fill="#38bdf8")
draw.text((125, 645), "FROM read_parquet('s3://warehouse/*.parquet', union_by_name = true);", fill="#34d399")

# Badge tags
draw.rounded_rectangle([125, 725, 300, 755], radius=6, fill="#1e1b4b", outline="#6366f1", width=1)
draw.text((140, 733), "100% In-Browser Execution", fill="#a5b4fc")

draw.rounded_rectangle([320, 725, 520, 755], radius=6, fill="#064e3b", outline="#10b981", width=1)
draw.text((335, 733), "Automated PII Redaction", fill="#6ee7b7")

draw.rounded_rectangle([540, 725, 730, 755], radius=6, fill="#3b0764", outline="#a855f7", width=1)
draw.text((555, 733), "Zero Data Exfiltration", fill="#d8b4fe")

output_path = os.path.join(os.getcwd(), "preview_cover_1200x800.png")
img.save(output_path, "PNG")
print(f"Created cover image at {output_path}")

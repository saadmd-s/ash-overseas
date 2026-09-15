"""Restore a SQL export in memory and verify it without printing private data."""
import argparse
import hashlib
import json
import sqlite3
from pathlib import Path

REQUIRED = {"dealers", "transactions", "transaction_lines", "payments", "ledger_entries", "audit_log", "app_credentials", "id_sequences"}
MAX_PAISE = 2**53 - 1


def verify_dump(path):
    raw = Path(path).read_bytes()
    db = sqlite3.connect(":memory:")
    try:
        db.executescript(raw.decode("utf-8"))
        if db.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
            raise ValueError("SQLite integrity check failed")
        if db.execute("PRAGMA foreign_key_check").fetchone():
            raise ValueError("Foreign key check failed")
        tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if not REQUIRED <= tables:
            raise ValueError("Required application tables are missing")
        if ("request_receipts" in tables) != ("ledger_write_revision" in tables):
            raise ValueError("Incomplete guarded-write schema")
        counts = {}
        for table in sorted(tables):
            if table.startswith(("sqlite_", "_cf_")) or table == "d1_migrations":
                continue
            quoted = '"' + table.replace('"', '""') + '"'
            counts[table] = db.execute(f"SELECT count(*) FROM {quoted}").fetchone()[0]
            columns = [r[1] for r in db.execute(f"PRAGMA table_info({quoted})") if r[1].endswith("_paise")]
            for column in columns:
                name = '"' + column.replace('"', '""') + '"'
                if db.execute(f"SELECT 1 FROM {quoted} WHERE typeof({name}) != 'integer' OR {name} > ? OR {name} < ? LIMIT 1", (MAX_PAISE, -MAX_PAISE)).fetchone():
                    raise ValueError("Invalid integer paise in backup")
        previous = None
        balance = 0
        digest = hashlib.sha256()
        for row in db.execute("SELECT dealer_id, entry_date, id, debit_paise, credit_paise, running_balance_paise FROM ledger_entries ORDER BY dealer_id, entry_date, id"):
            dealer, _, _, debit, credit, stored = row
            if dealer != previous:
                balance = 0
                previous = dealer
            if debit < 0 or credit < 0 or (debit and credit):
                raise ValueError("Invalid ledger movement")
            balance += debit - credit
            if abs(balance) > MAX_PAISE or balance != stored:
                raise ValueError("Stored ledger balance does not reconcile")
            digest.update(json.dumps(row, separators=(",", ":")).encode())
        return {"sql_sha256": hashlib.sha256(raw).hexdigest(), "row_counts": counts,
                "ledger_sha256": digest.hexdigest(), "ledger_has_entries": counts["ledger_entries"] > 0,
                "guarded_write_schema": "request_receipts" in tables,
                "checks": ["sqlite_restore", "integrity", "foreign_keys", "integer_paise", "all_running_balances"]}
    finally:
        db.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("dump")
    parser.add_argument("--report", required=True)
    args = parser.parse_args()
    try:
        report = verify_dump(args.dump)
        Path(args.report).write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    except Exception:
        # SQLite exceptions may quote data or SQL. Do not expose those in CI logs.
        raise SystemExit("Backup verification failed; inspect the dump privately. No verified artifact was produced.")
    print("Backup restored and checked successfully." if report["ledger_has_entries"] else "Backup restored; database has no ledger entries. A populated restore drill is still required.")

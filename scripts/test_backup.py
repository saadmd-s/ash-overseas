"""Offline backup checks using synthetic data and a disposable encryption key."""
import hashlib
import importlib.util
import io
import json
import os
import shutil
import sqlite3
import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


verify = load("verify-backup").verify_dump
packager = load("package-backup")
package = packager.package
GPG = os.getenv("GPG_BIN") or shutil.which("gpg")
if not GPG and Path("C:/Program Files/Git/usr/bin/gpg.exe").exists():
    GPG = "C:/Program Files/Git/usr/bin/gpg.exe"


class BackupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="ash-backup-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.dump = self.root / "dump.sql"
        db = sqlite3.connect(":memory:")
        for migration in sorted((ROOT / "drizzle/migrations").glob("*.sql")):
            db.executescript(migration.read_text(encoding="utf-8"))
        db.execute("INSERT INTO dealers (id,name) VALUES (1,?)", ("Synthetic dealer",))
        db.execute("INSERT INTO ledger_entries (dealer_id,entry_date,source_type,debit_paise,credit_paise,running_balance_paise) VALUES (1,'2026-09-01','opening',12345,0,12345)")
        db.execute("INSERT INTO ledger_entries (dealer_id,entry_date,source_type,debit_paise,credit_paise,running_balance_paise) VALUES (1,'2026-09-02','reversal',0,12345,0)")
        self.dump.write_text("\n".join(db.iterdump()), encoding="utf-8")
        db.close()

    def test_restores_current_migrations_and_exact_paise(self):
        report = verify(self.dump)
        self.assertEqual(report["row_counts"]["ledger_entries"], 2)
        self.assertTrue(report["guarded_write_schema"])
        self.assertTrue(report["ledger_has_entries"])

    def test_rejects_incorrect_running_balance(self):
        with self.dump.open("a") as file:
            file.write("\nUPDATE ledger_entries SET running_balance_paise=1 WHERE id=2;")
        with self.assertRaisesRegex(ValueError, "reconcile"):
            verify(self.dump)

    def test_rejects_orphan_dealer(self):
        with self.dump.open("a") as file:
            file.write("\nDELETE FROM dealers;")
        with self.assertRaisesRegex(ValueError, "Foreign key"):
            verify(self.dump)

    def test_rejects_unsafe_paise(self):
        with self.dump.open("a") as file:
            file.write("\nUPDATE ledger_entries SET debit_paise=9007199254740992 WHERE id=1;")
        with self.assertRaisesRegex(ValueError, "integer paise"):
            verify(self.dump)

    def test_rejects_missing_schema_and_truncated_dump(self):
        self.dump.write_text("CREATE TABLE unrelated (id INTEGER);", encoding="utf-8")
        with self.assertRaises(ValueError):
            verify(self.dump)
        self.dump.write_text("CREATE TABLE dealers (", encoding="utf-8")
        with self.assertRaises(sqlite3.Error):
            verify(self.dump)

    def test_empty_database_is_backed_up_but_marked(self):
        with self.dump.open("a") as file:
            file.write("\nDELETE FROM ledger_entries; DELETE FROM dealers;")
        self.assertFalse(verify(self.dump)["ledger_has_entries"])

    def test_rejects_private_key_before_import(self):
        with self.assertRaisesRegex(ValueError, "public key"):
            package(self.dump, "unused", self.root / "bad.gpg", "-----BEGIN PGP PRIVATE KEY BLOCK-----", "A" * 40)

    @unittest.skipUnless(GPG, "GPG required for encryption round-trip")
    def test_public_only_encryption_and_private_decryption(self):
        home = self.root / "key-owner"
        home.mkdir(mode=0o700)
        def gpg(*args):
            result = subprocess.run([GPG, "--homedir", packager.gpg_path(home, GPG), "--batch", *args], capture_output=True)
            if result.returncode:
                raise RuntimeError(result.stderr.decode(errors="replace"))
            return result.stdout
        gpg("--pinentry-mode", "loopback", "--passphrase", "", "--quick-generate-key", "Backup test only", "rsa2048", "encr", "1d")
        fingerprint = next(line.split(":")[9] for line in gpg("--with-colons", "--list-keys").decode().splitlines() if line.startswith("fpr:"))
        public = gpg("--armor", "--export", fingerprint).decode()
        report = self.root / "report.json"
        report.write_text(json.dumps(verify(self.dump)), encoding="utf-8")
        output = self.root / "encrypted.tar.gz.gpg"
        package(self.dump, report, output, public, fingerprint, gpg=GPG)
        decrypted = gpg("--decrypt", packager.gpg_path(output, GPG))
        with tarfile.open(fileobj=io.BytesIO(decrypted), mode="r:gz") as archive:
            self.assertEqual(archive.extractfile("ledger-prod.sql").read(), self.dump.read_bytes())
            metadata = json.load(archive.extractfile("manifest.json"))
            self.assertEqual(metadata["sql_sha256"], hashlib.sha256(self.dump.read_bytes()).hexdigest())
        self.assertNotIn(b"Synthetic dealer", output.read_bytes())
        self.assertTrue(output.with_suffix(".gpg.sha256").exists())
        with self.dump.open("a") as file:
            file.write("\n-- changed after verification")
        with self.assertRaisesRegex(ValueError, "changed"):
            package(self.dump, report, self.root / "changed.gpg", public, fingerprint, gpg=GPG)


if __name__ == "__main__":
    unittest.main()

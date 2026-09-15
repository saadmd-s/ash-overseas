"""Package a verified dump using a public OpenPGP key; never upload plaintext."""
import argparse
import hashlib
import json
import os
import re
import subprocess
import tarfile
import tempfile
from datetime import datetime, timezone
from pathlib import Path


def gpg_path(path, executable):
    value = Path(path).resolve().as_posix()
    # Git for Windows ships an MSYS GPG; its agent sockets need POSIX paths.
    if os.name == "nt" and "/git/" in str(executable).lower().replace("\\", "/"):
        return "/" + value[0].lower() + value[2:]
    return value


def package(dump, report, output, public_key, fingerprint, gpg="gpg"):
    fingerprint = fingerprint.replace(" ", "").upper()
    if not re.fullmatch(r"[A-F0-9]{40}|[A-F0-9]{64}", fingerprint):
        raise ValueError("Invalid public key fingerprint")
    if "PRIVATE KEY" in public_key or "-----BEGIN PGP PUBLIC KEY BLOCK-----" not in public_key:
        raise ValueError("Supply only an armored public key")
    metadata = json.loads(Path(report).read_text(encoding="utf-8"))
    if hashlib.sha256(Path(dump).read_bytes()).hexdigest() != metadata["sql_sha256"]:
        raise ValueError("Dump changed after verification")
    metadata.update({"created_at": datetime.now(timezone.utc).isoformat(), "database": "ledger-prod",
                     "commit": os.getenv("GITHUB_SHA", "local"), "run_id": os.getenv("GITHUB_RUN_ID", "local"),
                     "encryption_fingerprint": fingerprint})
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="ash-encrypt-") as temporary:
        work = Path(temporary)
        home = work / "gnupg"
        home.mkdir(mode=0o700)
        def run(*args):
            return subprocess.run([gpg, "--homedir", gpg_path(home, gpg), "--batch", *args], check=True, capture_output=True)
        key = work / "public.asc"
        key.write_text(public_key, encoding="utf-8")
        run("--import", gpg_path(key, gpg))
        if any(line.startswith(b"sec:") for line in run("--with-colons", "--list-secret-keys").stdout.splitlines()):
            raise ValueError("Private keys are forbidden on the backup runner")
        run("--list-keys", fingerprint)
        manifest = work / "manifest.json"
        manifest.write_text(json.dumps(metadata, indent=2), encoding="utf-8")
        archive = work / "backup.tar.gz"
        with tarfile.open(archive, "w:gz") as tar:
            tar.add(dump, arcname="ledger-prod.sql")
            tar.add(manifest, arcname="manifest.json")
        run("--trust-model", "always", "--recipient", fingerprint, "--output", gpg_path(output, gpg), "--encrypt", gpg_path(archive, gpg))
    checksum = hashlib.sha256(output.read_bytes()).hexdigest()
    output.with_suffix(output.suffix + ".sha256").write_text(checksum + "  " + output.name + "\n", encoding="ascii")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("dump")
    parser.add_argument("report")
    parser.add_argument("output")
    args = parser.parse_args()
    try:
        package(args.dump, args.report, args.output, os.environ["BACKUP_PUBLIC_KEY"], os.environ["BACKUP_KEY_FINGERPRINT"])
    except Exception:
        raise SystemExit("Backup encryption failed. Check the public key, fingerprint, expiry and GPG installation. No plaintext is uploaded.")
    print("Encrypted backup package created.")

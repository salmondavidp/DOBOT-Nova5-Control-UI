#!/usr/bin/env python3
"""Bootstrap launcher for the local DOBOT UI."""

from __future__ import annotations

import re
import os
import subprocess
import sys
from importlib.util import find_spec
from pathlib import Path


ROOT = Path(__file__).resolve().parent
REQUIREMENTS_FILE = ROOT / "requirements.txt"
APP_FILE = ROOT / "dobot_ui.py"
MIN_PYTHON = (3, 10)
PACKAGE_IMPORT_OVERRIDES = {
    "numpy": "numpy",
}


def normalize_package_name(requirement_line: str) -> str | None:
    line = requirement_line.strip()
    if not line or line.startswith("#"):
        return None
    package = re.split(r"[<>=!~;\[\s]", line, maxsplit=1)[0].strip()
    return package or None


def package_to_import_name(package_name: str) -> str:
    normalized = package_name.lower().replace("-", "_")
    return PACKAGE_IMPORT_OVERRIDES.get(normalized, normalized)


def read_required_packages() -> list[str]:
    if not REQUIREMENTS_FILE.exists():
        raise FileNotFoundError(f"Missing requirements file: {REQUIREMENTS_FILE}")

    packages: list[str] = []
    for raw_line in REQUIREMENTS_FILE.read_text(encoding="utf-8").splitlines():
        package = normalize_package_name(raw_line)
        if package:
            packages.append(package)
    return packages


def ensure_python_version() -> None:
    if sys.version_info < MIN_PYTHON:
        required = ".".join(str(part) for part in MIN_PYTHON)
        current = ".".join(str(part) for part in sys.version_info[:3])
        raise RuntimeError(f"Python {required}+ is required. Current version: {current}")


def find_missing_packages() -> list[str]:
    missing: list[str] = []
    for package in read_required_packages():
        import_name = package_to_import_name(package)
        if find_spec(import_name) is None:
            missing.append(package)
    return missing


def ensure_pip() -> None:
    try:
        subprocess.run(
            [sys.executable, "-m", "pip", "--version"],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except subprocess.CalledProcessError:
        subprocess.run([sys.executable, "-m", "ensurepip", "--upgrade"], check=True)


def install_requirements() -> None:
    ensure_pip()
    env = os.environ.copy()
    env.setdefault("PIP_DISABLE_PIP_VERSION_CHECK", "1")
    subprocess.run(
        [sys.executable, "-m", "pip", "install", "-r", str(REQUIREMENTS_FILE)],
        check=True,
        env=env,
    )


def launch_app(argv: list[str]) -> int:
    if not APP_FILE.exists():
        raise FileNotFoundError(f"Missing app file: {APP_FILE}")

    command = [sys.executable, str(APP_FILE), *argv]
    completed = subprocess.run(command)
    return completed.returncode


def main(argv: list[str] | None = None) -> int:
    forwarded_args = list(sys.argv[1:] if argv is None else argv)
    try:
        ensure_python_version()

        missing_packages = find_missing_packages()
        if missing_packages:
            print(f"Installing missing packages: {', '.join(missing_packages)}")
            install_requirements()

        return launch_app(forwarded_args)
    except subprocess.CalledProcessError as exc:
        print()
        print("Dependency setup failed.")
        print(f"Failed command exit code: {exc.returncode}")
        print("Manual retry:")
        print(f'  "{sys.executable}" -m pip install -r "{REQUIREMENTS_FILE}"')
        return exc.returncode or 1
    except Exception as exc:
        print()
        print(f"Startup failed: {exc}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

"""MotorControl servo bridge used by the DOBOT 3TTT UI."""

from __future__ import annotations

import base64
import os
import json
import re
import socket
import subprocess
import time
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlparse
from urllib.request import Request, urlopen


DEFAULT_MOTORCONTROL_URL = "http://127.0.0.1:8000"
LOCAL_MOTORCONTROL_EXE = Path(__file__).resolve().with_name("servo_control") / "MotorControl" / "MotorControl.exe"
LEGACY_MOTORCONTROL_EXE = Path(r"D:\Downlaod\1776079719120_smci_app_secure\MotorControl\MotorControl.exe")
SERVER_START_TIMEOUT_SECONDS = 25.0


def _clamp_int(value: Any, minimum: int, maximum: int, *, label: str) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{label} must be a number") from exc
    if number < minimum or number > maximum:
        raise ValueError(f"{label} must be between {minimum} and {maximum}")
    return number


class ServoCT:
    """Small client for the local MotorControl app on port 8000."""

    def __init__(
        self,
        base_url: str = DEFAULT_MOTORCONTROL_URL,
        *,
        auto_start: bool = True,
        motorcontrol_exe: str | Path | None = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.auto_start = auto_start
        self.motorcontrol_exe = Path(motorcontrol_exe) if motorcontrol_exe else None
        self._last_start_attempt = 0.0

    def motorcontrol_candidates(self) -> list[Path]:
        candidates = []
        if self.motorcontrol_exe is not None:
            candidates.append(self.motorcontrol_exe)
        candidates.extend([LOCAL_MOTORCONTROL_EXE, LEGACY_MOTORCONTROL_EXE])

        unique: list[Path] = []
        seen: set[str] = set()
        for candidate in candidates:
            key = str(candidate).lower()
            if key not in seen:
                seen.add(key)
                unique.append(candidate)
        return unique

    def locate_motorcontrol_exe(self) -> Path:
        for candidate in self.motorcontrol_candidates():
            if candidate.exists():
                return candidate
        expected = ", ".join(str(candidate) for candidate in self.motorcontrol_candidates())
        raise RuntimeError(f"MotorControl.exe was not found. Expected one of: {expected}")

    def is_server_reachable(self, timeout: float = 0.5) -> bool:
        request = Request(f"{self.base_url}/api/status", headers={"Accept": "application/json"}, method="GET")
        try:
            with urlopen(request, timeout=timeout) as response:  # noqa: S310 - localhost control API
                response.read(1)
            return True
        except (HTTPError, URLError, OSError, TimeoutError):
            return False

    def ensure_server_running(self) -> dict[str, Any]:
        exe = next((candidate for candidate in self.motorcontrol_candidates() if candidate.exists()), None)
        if self.is_server_reachable():
            return {"running": True, "started": False, "path": str(exe) if exe else None}
        if exe is None:
            self.locate_motorcontrol_exe()

        self._last_start_attempt = time.time()
        creation_flags = 0
        if hasattr(subprocess, "CREATE_NEW_PROCESS_GROUP"):
            creation_flags |= subprocess.CREATE_NEW_PROCESS_GROUP
        if hasattr(subprocess, "DETACHED_PROCESS"):
            creation_flags |= subprocess.DETACHED_PROCESS

        try:
            subprocess.Popen(  # noqa: S603 - local MotorControl executable selected from known paths
                [str(exe)],
                cwd=str(exe.parent),
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                close_fds=True,
                creationflags=creation_flags,
            )
        except OSError as exc:
            raise RuntimeError(f"Could not start MotorControl from {exe}: {exc}") from exc

        deadline = time.time() + SERVER_START_TIMEOUT_SECONDS
        while time.time() < deadline:
            if self.is_server_reachable(timeout=0.75):
                return {"running": True, "started": True, "path": str(exe)}
            time.sleep(0.35)

        raise RuntimeError(
            f"MotorControl did not become reachable at {self.base_url} after starting {exe}. "
            "Start it once manually or run the DOBOT UI as Administrator if the driver asks for permission."
        )

    def request(
        self,
        path: str,
        *,
        method: str = "GET",
        payload: Any | None = None,
        timeout: float = 3.0,
        auto_start: bool | None = None,
    ) -> dict[str, Any]:
        data = None
        headers = {"Accept": "application/json"}
        if payload is not None:
            data = json.dumps(payload).encode("utf-8")
            headers["Content-Type"] = "application/json"
        request = Request(f"{self.base_url}{path}", data=data, headers=headers, method=method)
        should_auto_start = self.auto_start if auto_start is None else auto_start
        try:
            with urlopen(request, timeout=timeout) as response:  # noqa: S310 - localhost control API
                raw = response.read()
        except HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace").strip()
            message = f"MotorControl returned HTTP {exc.code}"
            if detail:
                message = f"{message}: {detail}"
            raise RuntimeError(message) from exc
        except (URLError, OSError) as exc:
            if should_auto_start:
                self.ensure_server_running()
                try:
                    with urlopen(request, timeout=timeout) as response:  # noqa: S310 - localhost control API
                        raw = response.read()
                except HTTPError as retry_exc:
                    detail = retry_exc.read().decode("utf-8", errors="replace").strip()
                    message = f"MotorControl returned HTTP {retry_exc.code}"
                    if detail:
                        message = f"{message}: {detail}"
                    raise RuntimeError(message) from retry_exc
                except (URLError, OSError) as retry_exc:
                    raise RuntimeError(f"MotorControl is not reachable at {self.base_url}") from retry_exc
            else:
                raise RuntimeError(f"MotorControl is not reachable at {self.base_url}") from exc
        if not raw:
            return {}
        return json.loads(raw.decode("utf-8"))

    def status(self) -> dict[str, Any]:
        return self.request("/api/status", timeout=2.5)

    @staticmethod
    def websocket_frame(payload: bytes) -> bytes:
        mask_key = os.urandom(4)
        header = bytearray([0x81])
        if len(payload) < 126:
            header.append(0x80 | len(payload))
        elif len(payload) <= 0xFFFF:
            header.extend([0x80 | 126, (len(payload) >> 8) & 0xFF, len(payload) & 0xFF])
        else:
            header.append(0x80 | 127)
            header.extend(len(payload).to_bytes(8, "big"))
        masked_payload = bytes(byte ^ mask_key[index % 4] for index, byte in enumerate(payload))
        return bytes(header) + mask_key + masked_payload

    def websocket_commands(
        self,
        commands: list[tuple[str, Any | None]],
        *,
        timeout: float = 3.0,
        command_delay: float = 0.45,
        final_delay: float = 0.25,
    ) -> None:
        parsed = urlparse(self.base_url)
        if parsed.scheme not in {"http", "ws"}:
            raise RuntimeError(f"MotorControl WebSocket only supports local http/ws URLs, got {self.base_url}")
        host = parsed.hostname or "127.0.0.1"
        port = parsed.port or 8000
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        host_header = f"{host}:{port}"
        request = (
            "GET /ws?page=dobot HTTP/1.1\r\n"
            f"Host: {host_header}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n"
            "\r\n"
        ).encode("ascii")

        try:
            with socket.create_connection((host, port), timeout=timeout) as sock:
                sock.settimeout(timeout)
                sock.sendall(request)
                response = b""
                while b"\r\n\r\n" not in response:
                    chunk = sock.recv(4096)
                    if not chunk:
                        break
                    response += chunk
                if b" 101 " not in response.split(b"\r\n", 1)[0]:
                    raise RuntimeError(response.decode("utf-8", errors="replace").splitlines()[0] if response else "no response")
                for command, data in commands:
                    payload = json.dumps({"cmd": command, "data": data}).encode("utf-8")
                    sock.sendall(self.websocket_frame(payload))
                    time.sleep(command_delay)
                time.sleep(final_delay)
        except OSError as exc:
            names = ", ".join(command for command, _ in commands)
            raise RuntimeError(f"MotorControl WebSocket command(s) {names!r} failed: {exc}") from exc

    def websocket_command(self, command: str, data: Any | None = None, *, timeout: float = 2.0) -> None:
        self.websocket_commands([(command, data)], timeout=timeout)

    def prepare_position_mode(self, template: dict[str, Any]) -> dict[str, int] | None:
        speed = self.template_movement_speed(template)
        if not speed:
            return None
        self.websocket_command(
            "set_mode",
            {
                "mode": 1,
                "speed": {
                    **speed,
                    "mode_type": "PP",
                },
            },
        )
        deadline = time.time() + 2.0
        status = self.status()
        while time.time() < deadline:
            status = self.status()
            if int(status.get("mode") or 0) == 1:
                break
            time.sleep(0.15)
        if int(status.get("mode") or 0) != 1:
            raise RuntimeError("MotorControl did not switch to position mode")
        self.websocket_command("set_speed", speed)
        if int(status.get("state") or 0) != 2:
            self.enable()
        return speed

    def load_template(self, filename: str = "") -> tuple[str, dict[str, Any]]:
        template_name = filename.strip()
        if not template_name:
            default_info = self.request("/api/default_template", timeout=2.5)
            template_name = str(default_info.get("default_template") or "").strip()
        if not template_name:
            raise RuntimeError("MotorControl has no default template selected")
        template = self.request(f"/api/load_template?filename={quote(template_name)}", timeout=3.0)
        if not isinstance(template.get("template"), dict) or not isinstance(template.get("positions"), dict):
            raise RuntimeError(f"MotorControl template {template_name} is invalid")
        return template_name, template

    @staticmethod
    def parse_board_number(board_name: Any) -> int:
        text = str(board_name).strip().lower()
        match = re.search(r"(\d+)", text)
        if not match:
            raise ValueError("Missing board number")
        return int(match.group(1))

    @staticmethod
    def unique_sorted_positions(values: list[float]) -> list[float]:
        unique: list[float] = []
        for value in sorted(values):
            if not any(abs(value - existing) < 0.0001 for existing in unique):
                unique.append(value)
        return unique

    def board_positions_from_template(
        self,
        template: dict[str, Any],
        *,
        board_count: int,
        slave: int,
    ) -> dict[str, float]:
        positions = template.get("positions", {})
        steps = template.get("template", {}).get("steps", [])
        explicit: dict[str, float] = {}
        movement_values: list[float] = []

        for step in steps:
            if not isinstance(step, dict) or step.get("type") not in {"movement", "all"}:
                continue
            position_key = str(step.get("position", "")).strip()
            raw_values = positions.get(position_key)
            if not isinstance(raw_values, list) or slave >= len(raw_values):
                continue
            try:
                target = float(raw_values[slave])
            except (TypeError, ValueError):
                continue

            label = f"{step.get('name', '')} {position_key}".lower()
            match = re.search(r"(?:board|player)\s*[_#-]?\s*(\d+)", label)
            if match:
                explicit[str(int(match.group(1)))] = target
            else:
                movement_values.append(target)

        sorted_positions = self.unique_sorted_positions(movement_values)
        board_positions = dict(explicit)
        for index in range(1, board_count + 1):
            key = str(index)
            if key not in board_positions and index <= len(sorted_positions):
                board_positions[key] = sorted_positions[index - 1]

        missing = [str(index) for index in range(1, board_count + 1) if str(index) not in board_positions]
        if missing:
            raise RuntimeError(f"Template does not define enough movement positions for board(s): {', '.join(missing)}")
        return board_positions

    @staticmethod
    def limits_from_template(template: dict[str, Any]) -> tuple[float, float] | None:
        template_info = template.get("template", {})
        meta = template_info.get("meta", {}) if isinstance(template_info, dict) else {}
        raw_limits = [
            template_info.get("left_end_position"),
            template_info.get("right_end_position"),
            meta.get("max_left_m") if isinstance(meta, dict) else None,
            meta.get("max_right_m") if isinstance(meta, dict) else None,
        ]
        limits: list[float] = []
        for raw_limit in raw_limits:
            try:
                limits.append(float(raw_limit))
            except (TypeError, ValueError):
                continue
        unique_limits = ServoCT.unique_sorted_positions(limits)
        if len(unique_limits) < 2:
            return None
        return min(unique_limits), max(unique_limits)

    @staticmethod
    def template_movement_speed(template: dict[str, Any]) -> dict[str, int] | None:
        speed = template.get("speed", {})
        movement_speed = speed.get("movement_speed") if isinstance(speed, dict) else None
        if not isinstance(movement_speed, dict):
            return None
        result: dict[str, int] = {}
        for key in ("velocity", "acceleration", "deceleration"):
            try:
                value = int(movement_speed.get(key))
            except (TypeError, ValueError):
                return None
            if value <= 0:
                return None
            result[key] = value
        return result

    def get_status(self, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        payload = payload or {}
        board_count = _clamp_int(payload.get("board_count", 3), 1, 9, label="Board count")
        slave = _clamp_int(payload.get("slave", 0), 0, 99, label="Servo slave")
        server = self.ensure_server_running() if self.auto_start else {"running": self.is_server_reachable()}
        status = self.status()
        template_name, template = self.load_template(str(payload.get("template", "")))
        board_positions = self.board_positions_from_template(template, board_count=board_count, slave=slave)
        limits = self.limits_from_template(template)
        return {
            "motorcontrol_url": self.base_url,
            "status": status,
            "template": template_name,
            "limits": {"min": limits[0], "max": limits[1]} if limits else None,
            "template_speed": self.template_movement_speed(template),
            "board_positions": board_positions,
            "slave": slave,
            "server": server,
        }

    def enable(self) -> dict[str, Any]:
        response = self.request("/api/enable", method="POST", timeout=3.0)
        deadline = time.time() + 6.0
        status = self.status()
        while time.time() < deadline:
            status = self.status()
            if int(status.get("state") or 0) == 2:
                break
            time.sleep(0.2)
        return {"command": response, "status": status}

    def disable(self) -> dict[str, Any]:
        response = self.request("/api/disable", method="POST", timeout=3.0, auto_start=False)
        time.sleep(0.3)
        return {"command": response, "status": self.status()}

    def stop(self) -> dict[str, Any]:
        result = self.disable()
        return {"emergency_stop": True, **result}

    def reset_fault(self) -> dict[str, Any]:
        response = self.request("/api/reset", method="POST", timeout=3.0)
        time.sleep(0.5)
        return {"command": response, "status": self.status()}

    def move_position(self, payload: dict[str, Any]) -> dict[str, Any]:
        slave = _clamp_int(payload.get("slave", 0), 0, 99, label="Servo slave")
        target = float(payload.get("position", 0.0))
        timeout_seconds = max(1.0, min(120.0, float(payload.get("timeout", 120.0))))
        tolerance = max(0.0005, min(0.1, float(payload.get("tolerance", 0.002))))
        settle_seconds = max(0.0, min(5.0, float(payload.get("settle", 2.0))))

        template_name, template = self.load_template(str(payload.get("template", "")))
        limits = self.limits_from_template(template)
        if limits and not (limits[0] <= target <= limits[1]):
            raise ValueError(
                f"Servo target {target:.4f}m is outside template {template_name} limits "
                f"({limits[0]:.4f}m to {limits[1]:.4f}m)"
            )

        status = self.status()
        if int(status.get("num_slaves") or 0) <= slave:
            raise RuntimeError(f"MotorControl does not report servo slave {slave}")
        if status.get("has_fault"):
            raise RuntimeError("MotorControl reports a servo fault; clear it before moving")
        if int(status.get("state") or 0) != 2:
            raise RuntimeError("MotorControl is not enabled. Click Enable Servo, then try the move again")

        values = status.get("positions") if isinstance(status.get("positions"), list) else []
        current = float(values[slave]) if slave < len(values) else None
        if current is not None and abs(current - target) <= tolerance and not status.get("moving"):
            return {
                "reached": True,
                "already_at_target": True,
                "target": target,
                "current": current,
                "slave": slave,
                "template": template_name,
            }

        response = {"message": "Move command sent"}
        speed = self.template_movement_speed(template)
        commands: list[tuple[str, Any | None]] = []
        if speed:
            commands.append(
                (
                    "set_mode",
                    {
                        "mode": 1,
                        "speed": {
                            **speed,
                            "mode_type": "PP",
                        },
                    },
                )
            )
            commands.append(("enable", None))
            commands.append(("set_speed", speed))
        else:
            commands.append(("set_mode", {"mode": 1}))
            commands.append(("enable", None))
        commands.append(("move", {"positions": [target], "slave": slave}))
        self.websocket_commands(commands)
        deadline = time.time() + timeout_seconds
        last_position = current
        reached_since: float | None = None

        while time.time() < deadline:
            time.sleep(0.15)
            status = self.status()
            if status.get("has_fault"):
                raise RuntimeError("MotorControl reported a servo fault during move")
            values = status.get("positions") if isinstance(status.get("positions"), list) else []
            if slave >= len(values):
                continue
            last_position = float(values[slave])
            if abs(last_position - target) <= tolerance and not status.get("moving"):
                if reached_since is None:
                    reached_since = time.time()
                    continue
                if time.time() - reached_since < settle_seconds:
                    continue
                return {
                    "reached": True,
                    "already_at_target": False,
                    "target": target,
                    "current": last_position,
                    "slave": slave,
                    "template": template_name,
                    "template_speed": self.template_movement_speed(template),
                    "command": response,
                }
            reached_since = None

        raise TimeoutError(
            f"Servo did not reach {target:.4f}m (last={last_position}, timeout={timeout_seconds:.1f}s)"
        )

    def move_board(self, payload: dict[str, Any]) -> dict[str, Any]:
        board_count = _clamp_int(payload.get("board_count", 3), 1, 9, label="Board count")
        slave = _clamp_int(payload.get("slave", 0), 0, 99, label="Servo slave")
        board_number = self.parse_board_number(payload.get("board_name", payload.get("board", "")))
        template_name, template = self.load_template(str(payload.get("template", "")))
        board_positions = self.board_positions_from_template(template, board_count=board_count, slave=slave)
        target = board_positions.get(str(board_number))
        if target is None:
            raise ValueError(f"No servo position mapped for board {board_number}")

        move_result = self.move_position(
            {
                "slave": slave,
                "position": target,
                "template": template_name,
                "timeout": payload.get("timeout", 120.0),
                "tolerance": payload.get("tolerance", 0.002),
            }
        )
        return {
            **move_result,
            "board": board_number,
            "template": template_name,
            "board_positions": board_positions,
        }

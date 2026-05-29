#!/usr/bin/env python3
"""Local web UI for controlling a DOBOT Nova 5 over TCP/IP."""

from __future__ import annotations

import argparse
import csv
import ipaddress
import io
import json
import math
import re
import socket
import struct
import threading
import time
import webbrowser
from copy import deepcopy
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict, dataclass, replace
from functools import partial
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable
from urllib.parse import parse_qs, unquote, urlparse

from dobot_nova5 import DEFAULT_DASHBOARD_PORT, DEFAULT_FEEDBACK_PORT, DEFAULT_MOTION_PORT, ROBOT_MODES, DobotClient
from servoCT import ServoCT


STATIC_DIR = Path(__file__).with_name("webui")
SOUNDS_DIR = Path(__file__).with_name("sounds")
COFFEE_ORDERS_DB = Path(__file__).with_name("coffee_orders.json")
TICTACTOE_SETUP_DB = Path(__file__).with_name("tictactoe_setup_saved.json")
GAME_MAPPINGS_DB = Path(__file__).with_name("game_mappings_saved.json")
DEFAULT_UI_HOST = "127.0.0.1"
DEFAULT_UI_PORT = 8765
GAME_MAPPINGS_LOCK = threading.Lock()
GAME_MAPPING_KEY_RE = re.compile(r"^[A-Za-z0-9_.-]{1,64}$")
OSC_C_MAPPING_KEY = "osc_c"
OSC_C_LOG_LIMIT = 80
OSC_C_ROUTE_ACTIONS = {"run_once", "play_loop", "stop"}
OSC_C_MODES = {"preview", "live"}
COFFEE_TARGET_NAMES = {
    "HOME",
    "STANDBY",
}
COFFEE_ROUTINE_NAMES = {
    "cup_pick",
    "machine_place",
    "machine_pickup",
    "delivery",
    "hot_water",
    "milk",
    "espresso",
    "cappuccino",
    "latte",
}


def current_utc_timestamp() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def validate_game_mapping_key(raw_key: Any) -> str:
    game = str(raw_key or "").strip()
    if not GAME_MAPPING_KEY_RE.fullmatch(game):
        raise ValueError("Game mapping key must be 1-64 letters, numbers, dots, dashes, or underscores")
    return game


def empty_game_mappings_document() -> dict[str, Any]:
    return {
        "version": 1,
        "saved_at": None,
        "mappings": {},
    }


def read_game_mappings_unlocked() -> dict[str, Any]:
    if not GAME_MAPPINGS_DB.exists():
        return empty_game_mappings_document()

    document = json.loads(GAME_MAPPINGS_DB.read_text(encoding="utf-8"))
    if not isinstance(document, dict):
        raise ValueError("Saved game mappings file is invalid")
    mappings = document.get("mappings")
    if not isinstance(mappings, dict):
        mappings = {}
    return {
        "version": 1,
        "saved_at": document.get("saved_at"),
        "mappings": mappings,
    }


def write_game_mappings_unlocked(document: dict[str, Any]) -> None:
    tmp_path = GAME_MAPPINGS_DB.with_suffix(".tmp")
    tmp_path.write_text(json.dumps(document, indent=2), encoding="utf-8")
    tmp_path.replace(GAME_MAPPINGS_DB)


def save_game_mapping_entry(game: str, setup: Any, saved_at: str | None = None) -> dict[str, Any]:
    game = validate_game_mapping_key(game)
    if saved_at is None:
        saved_at = current_utc_timestamp()

    with GAME_MAPPINGS_LOCK:
        document = read_game_mappings_unlocked()
        document["mappings"][game] = {
            "saved_at": saved_at,
            "setup": setup,
        }
        document["saved_at"] = saved_at
        write_game_mappings_unlocked(document)

    return {
        "saved": True,
        "game": game,
        "path": str(GAME_MAPPINGS_DB),
        "saved_at": saved_at,
    }


def save_game_mapping_to_disk(payload: dict[str, Any]) -> dict[str, Any]:
    if "game" not in payload:
        raise ValueError("Missing game mapping key")
    if "setup" not in payload:
        raise ValueError("Missing game mapping setup")
    return save_game_mapping_entry(str(payload.get("game")), payload.get("setup"))


def load_game_mapping_from_disk(raw_game: Any) -> dict[str, Any]:
    game = validate_game_mapping_key(raw_game)
    with GAME_MAPPINGS_LOCK:
        document = read_game_mappings_unlocked()
    entry = document.get("mappings", {}).get(game)
    if not isinstance(entry, dict):
        return {
            "exists": False,
            "game": game,
            "path": str(GAME_MAPPINGS_DB),
            "setup": None,
            "saved_at": None,
        }
    return {
        "exists": True,
        "game": game,
        "path": str(GAME_MAPPINGS_DB),
        "setup": entry.get("setup"),
        "saved_at": entry.get("saved_at"),
    }


def load_all_game_mappings_from_disk() -> dict[str, Any]:
    with GAME_MAPPINGS_LOCK:
        document = read_game_mappings_unlocked()
    return {
        "exists": GAME_MAPPINGS_DB.exists(),
        "path": str(GAME_MAPPINGS_DB),
        "saved_at": document.get("saved_at"),
        "mappings": document.get("mappings", {}),
    }


def save_tictactoe_setup_to_disk(payload: dict[str, Any]) -> dict[str, Any]:
    setup = payload.get("setup")
    if not isinstance(setup, dict):
        raise ValueError("Missing Tic-Tac-Toe setup")

    saved_at = current_utc_timestamp()
    generic_result = save_game_mapping_entry("tictactoe", setup, saved_at=saved_at)
    document = {
        "saved_at": saved_at,
        "setup": setup,
    }
    tmp_path = TICTACTOE_SETUP_DB.with_suffix(".tmp")
    tmp_path.write_text(json.dumps(document, indent=2), encoding="utf-8")
    tmp_path.replace(TICTACTOE_SETUP_DB)
    return {
        "saved": True,
        "path": generic_result["path"],
        "legacy_path": str(TICTACTOE_SETUP_DB),
        "saved_at": saved_at,
    }


def load_tictactoe_setup_from_disk() -> dict[str, Any]:
    generic_result = load_game_mapping_from_disk("tictactoe")
    if generic_result["exists"] and isinstance(generic_result.get("setup"), dict):
        legacy_result = dict(generic_result)
        legacy_result["legacy_path"] = str(TICTACTOE_SETUP_DB)
        return legacy_result

    if not TICTACTOE_SETUP_DB.exists():
        return {
            "exists": False,
            "path": str(GAME_MAPPINGS_DB),
            "legacy_path": str(TICTACTOE_SETUP_DB),
            "setup": None,
            "saved_at": None,
        }

    document = json.loads(TICTACTOE_SETUP_DB.read_text(encoding="utf-8"))
    setup = document.get("setup") if isinstance(document, dict) else None
    if not isinstance(setup, dict):
        raise ValueError("Saved Tic-Tac-Toe setup file is invalid")
    migrated = save_game_mapping_entry("tictactoe", setup, saved_at=document.get("saved_at"))
    return {
        "exists": True,
        "path": migrated["path"],
        "legacy_path": str(TICTACTOE_SETUP_DB),
        "setup": setup,
        "saved_at": document.get("saved_at"),
    }
COFFEE_REQUIRED_CORE_ROUTINES = {
    "cup_pick",
    "machine_place",
    "machine_pickup",
    "delivery",
}
COFFEE_REQUIRED_POSITION_TARGETS = {
    "HOME",
    "STANDBY",
}
COFFEE_ALLOWED_GRIPPERS = {"two_finger", "soft", "suction"}


def _osc_pad(raw: bytes) -> bytes:
    padding = (4 - (len(raw) % 4)) % 4
    return raw + (b"\0" * padding)


def _osc_pack_string(value: str) -> bytes:
    return _osc_pad(value.encode("utf-8") + b"\0")


def pack_osc_message(address: str, args: list[Any]) -> bytes:
    if not address.startswith("/"):
        raise ValueError("OSC address must start with /")

    tags = [","]
    payload = bytearray()
    for arg in args:
        if isinstance(arg, bool):
            tags.append("T" if arg else "F")
        elif isinstance(arg, int):
            tags.append("i")
            payload.extend(struct.pack(">i", arg))
        elif isinstance(arg, float):
            tags.append("f")
            payload.extend(struct.pack(">f", arg))
        else:
            tags.append("s")
            payload.extend(_osc_pack_string(str(arg)))

    return _osc_pack_string(address) + _osc_pack_string("".join(tags)) + bytes(payload)


def osc_join_address(base: str, suffix: str) -> str:
    clean_base = base.strip() or "/"
    if not clean_base.startswith("/"):
        raise ValueError("OSC address must start with /")
    clean_base = clean_base.rstrip("/")
    clean_suffix = str(suffix).strip().strip("/")
    if not clean_suffix:
        return clean_base
    return f"{clean_base}/{clean_suffix}"


def _osc_read_string(data: bytes, offset: int) -> tuple[str, int]:
    end = data.index(b"\0", offset)
    value = data[offset:end].decode("utf-8", errors="replace")
    next_offset = end + 1
    while next_offset % 4:
        next_offset += 1
    return value, next_offset


def unpack_osc_message(data: bytes) -> tuple[str, list[Any]]:
    address, offset = _osc_read_string(data, 0)
    type_tags, offset = _osc_read_string(data, offset)
    if not type_tags.startswith(","):
        raise ValueError("OSC type tag string is invalid")

    args: list[Any] = []
    for tag in type_tags[1:]:
        if tag == "s":
            value, offset = _osc_read_string(data, offset)
            args.append(value)
        elif tag == "i":
            args.append(struct.unpack(">i", data[offset:offset + 4])[0])
            offset += 4
        elif tag == "f":
            args.append(struct.unpack(">f", data[offset:offset + 4])[0])
            offset += 4
        elif tag == "T":
            args.append(True)
        elif tag == "F":
            args.append(False)
    return address, args


@dataclass
class ConnectionConfig:
    host: str = "192.168.0.110"
    dashboard_port: int = DEFAULT_DASHBOARD_PORT
    motion_port: int = DEFAULT_MOTION_PORT
    feedback_port: int = DEFAULT_FEEDBACK_PORT
    timeout: float = 3.0


@dataclass
class SequenceStep:
    step_id: int
    name: str
    joints: list[float]
    pose: list[float] | None
    speedj: int
    accj: int
    dwell_ms: int = 0


def _coerce_bool(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        text = value.strip().lower()
        if text in {"1", "true", "yes", "on", "enabled"}:
            return True
        if text in {"0", "false", "no", "off", "disabled"}:
            return False
    return default


def _coerce_port(value: Any, default: int) -> int:
    try:
        port = int(value)
    except Exception:
        return default
    return max(1, min(65535, port))


def _coerce_osc_address(value: Any, default: str) -> str:
    address = str(value or "").strip()
    if not address.startswith("/"):
        return default
    return address.rstrip("/") or "/"


def _coerce_optional_osc_address(value: Any) -> str:
    address = str(value or "").strip()
    if not address:
        return ""
    if not address.startswith("/"):
        return ""
    return address.rstrip("/") or "/"


def _coerce_number_list(value: Any, expected: int | None = None) -> list[float] | None:
    if not isinstance(value, list):
        return None
    try:
        numbers = [float(item) for item in value]
    except Exception:
        return None
    if expected is not None and len(numbers) != expected:
        return None
    return numbers


def default_osc_c_setup() -> dict[str, Any]:
    first_sequence_id = "seq_1"
    first_route_id = "route_1"
    return {
        "enabled": False,
        "mode": "preview",
        "listenPort": 9012,
        "allowedHost": "",
        "sendStatus": True,
        "statusHost": "127.0.0.1",
        "statusPort": 9013,
        "statusAddress": "/dobot/osc_c/status",
        "directRunAddress": "/dobot/run",
        "directLoopAddress": "/dobot/loop",
        "directStopAddress": "/dobot/stop",
        "selectedSequenceId": first_sequence_id,
        "nextSequenceId": 2,
        "sequences": [
            {
                "id": first_sequence_id,
                "name": "Sequence 1",
                "enabled": True,
                "selectedStepId": None,
                "nextStepId": 1,
                "steps": [],
            },
        ],
        "selectedRouteId": first_route_id,
        "nextRouteId": 2,
        "routes": [
            {
                "id": first_route_id,
                "enabled": True,
                "address": "/robot/sequence1",
                "argMatch": "",
                "action": "run_once",
                "sequenceId": first_sequence_id,
                "onStartAddress": "",
                "onStepAddress": "",
                "onCompleteAddress": "",
                "onErrorAddress": "",
            },
        ],
    }


def normalize_osc_c_setup(raw: Any) -> dict[str, Any]:
    defaults = default_osc_c_setup()
    source = raw if isinstance(raw, dict) else {}

    sequences: list[dict[str, Any]] = []
    for index, raw_sequence in enumerate(source.get("sequences") if isinstance(source.get("sequences"), list) else []):
        if not isinstance(raw_sequence, dict):
            continue
        sequence_id = str(raw_sequence.get("id") or f"seq_{index + 1}").strip() or f"seq_{index + 1}"
        name = str(raw_sequence.get("name") or f"Sequence {index + 1}").strip() or f"Sequence {index + 1}"
        steps: list[dict[str, Any]] = []
        for step_index, raw_step in enumerate(raw_sequence.get("steps") if isinstance(raw_sequence.get("steps"), list) else []):
            if not isinstance(raw_step, dict):
                continue
            try:
                step_id = int(raw_step.get("stepId") or raw_step.get("step_id") or step_index + 1)
            except Exception:
                step_id = step_index + 1
            joints = _coerce_number_list(raw_step.get("joints"), expected=6)
            pose = _coerce_number_list(raw_step.get("pose"))
            if pose is not None and len(pose) < 3:
                pose = None
            try:
                dwell_ms = max(0, int(float(raw_step.get("dwellMs", raw_step.get("dwell_ms", 0)) or 0)))
            except Exception:
                dwell_ms = 0
            steps.append(
                {
                    "stepId": step_id,
                    "name": str(raw_step.get("name") or f"Step {step_index + 1}").strip() or f"Step {step_index + 1}",
                    "joints": joints,
                    "pose": pose,
                    "dwellMs": dwell_ms,
                    "capturedAt": raw_step.get("capturedAt") if isinstance(raw_step.get("capturedAt"), str) else None,
                }
            )
        selected_step = raw_sequence.get("selectedStepId")
        if not any(step["stepId"] == selected_step for step in steps):
            selected_step = steps[0]["stepId"] if steps else None
        next_step_id = max(
            int(raw_sequence.get("nextStepId") or 1) if str(raw_sequence.get("nextStepId") or "").isdigit() else 1,
            max((step["stepId"] for step in steps), default=0) + 1,
        )
        sequences.append(
            {
                "id": sequence_id,
                "name": name[:80],
                "enabled": _coerce_bool(raw_sequence.get("enabled"), True),
                "selectedStepId": selected_step,
                "nextStepId": next_step_id,
                "steps": steps,
            }
        )

    if not sequences:
        sequences = defaults["sequences"]
    sequence_ids = {sequence["id"] for sequence in sequences}

    routes: list[dict[str, Any]] = []
    for index, raw_route in enumerate(source.get("routes") if isinstance(source.get("routes"), list) else []):
        if not isinstance(raw_route, dict):
            continue
        route_id = str(raw_route.get("id") or f"route_{index + 1}").strip() or f"route_{index + 1}"
        action = str(raw_route.get("action") or "run_once").strip()
        if action not in OSC_C_ROUTE_ACTIONS:
            action = "run_once"
        sequence_id = str(raw_route.get("sequenceId") or "").strip()
        if sequence_id not in sequence_ids:
            sequence_id = sequences[0]["id"]
        routes.append(
            {
                "id": route_id,
                "enabled": _coerce_bool(raw_route.get("enabled"), True),
                "address": _coerce_osc_address(raw_route.get("address"), f"/robot/sequence{index + 1}"),
                "argMatch": str(raw_route.get("argMatch") or "").strip(),
                "action": action,
                "sequenceId": sequence_id,
                "onStartAddress": _coerce_optional_osc_address(raw_route.get("onStartAddress")),
                "onStepAddress": _coerce_optional_osc_address(raw_route.get("onStepAddress")),
                "onCompleteAddress": _coerce_optional_osc_address(raw_route.get("onCompleteAddress")),
                "onErrorAddress": _coerce_optional_osc_address(raw_route.get("onErrorAddress")),
            }
        )

    if not routes:
        routes = deepcopy(defaults["routes"])
        routes[0]["sequenceId"] = sequences[0]["id"]

    selected_sequence_id = str(source.get("selectedSequenceId") or "").strip()
    if selected_sequence_id not in sequence_ids:
        selected_sequence_id = sequences[0]["id"]
    route_ids = {route["id"] for route in routes}
    selected_route_id = str(source.get("selectedRouteId") or "").strip()
    if selected_route_id not in route_ids:
        selected_route_id = routes[0]["id"] if routes else None

    try:
        next_sequence_id = int(source.get("nextSequenceId") or defaults["nextSequenceId"])
    except Exception:
        next_sequence_id = defaults["nextSequenceId"]
    try:
        next_route_id = int(source.get("nextRouteId") or defaults["nextRouteId"])
    except Exception:
        next_route_id = defaults["nextRouteId"]

    return {
        "enabled": _coerce_bool(source.get("enabled"), defaults["enabled"]),
        "mode": str(source.get("mode") or defaults["mode"]) if str(source.get("mode") or defaults["mode"]) in OSC_C_MODES else defaults["mode"],
        "listenPort": _coerce_port(source.get("listenPort"), defaults["listenPort"]),
        "allowedHost": str(source.get("allowedHost") or "").strip(),
        "sendStatus": _coerce_bool(source.get("sendStatus"), defaults["sendStatus"]),
        "statusHost": str(source.get("statusHost") or defaults["statusHost"]).strip() or defaults["statusHost"],
        "statusPort": _coerce_port(source.get("statusPort"), defaults["statusPort"]),
        "statusAddress": _coerce_osc_address(source.get("statusAddress"), defaults["statusAddress"]),
        "directRunAddress": _coerce_osc_address(source.get("directRunAddress"), defaults["directRunAddress"]),
        "directLoopAddress": _coerce_osc_address(source.get("directLoopAddress"), defaults["directLoopAddress"]),
        "directStopAddress": _coerce_osc_address(source.get("directStopAddress"), defaults["directStopAddress"]),
        "selectedSequenceId": selected_sequence_id,
        "nextSequenceId": max(next_sequence_id, len(sequences) + 1),
        "sequences": sequences,
        "selectedRouteId": selected_route_id,
        "nextRouteId": max(next_route_id, len(routes) + 1),
        "routes": routes,
    }


def clamp_int(value: Any, minimum: int, maximum: int, *, label: str) -> int:
    integer = int(value)
    if integer < minimum or integer > maximum:
        raise ValueError(f"{label} must be between {minimum} and {maximum}")
    return integer


def parse_float_list(values: list[str]) -> list[float] | None:
    try:
        return [float(value) for value in values]
    except ValueError:
        return None


def serialize_response(response: Any) -> dict[str, Any]:
    values = list(response.values)
    return {
        "ok": response.ok,
        "error_id": response.error_id,
        "values": values,
        "floats": parse_float_list(values),
        "echoed_command": response.echoed_command,
        "raw": response.raw,
    }


class ControlService:
    def __init__(self, config: ConnectionConfig) -> None:
        self._config = config
        self._lock = threading.Lock()
        self._connected = False
        self._session_client: DobotClient | None = None
        self._last_connect_error: str | None = None
        self._discovered_devices: list[dict[str, Any]] = []
        self._last_error_poll_at = 0.0
        self._last_auto_reconnect_at = 0.0
        self._last_state: dict[str, dict[str, Any] | None] = {
            "robot_mode": None,
            "pose": None,
            "angle": None,
            "error": None,
        }
        self._sequence_steps: list[SequenceStep] = []
        self._sequence_next_id = 1
        self._sequence_selected_id: int | None = None
        self._sequence_active_id: int | None = None
        self._sequence_running = False
        self._sequence_loop = False
        self._sequence_last_error: str | None = None
        self._sequence_thread: threading.Thread | None = None
        self._sequence_stop_event: threading.Event | None = None
        self._speed_ratio = 20
        self._coffee_orders: dict[str, dict[str, Any]] = {}
        self._coffee_queue: list[str] = []
        self._coffee_active_order_id: str | None = None
        self._coffee_last_completed_order_id: str | None = None
        self._coffee_last_failed_order_id: str | None = None
        self._coffee_last_error: str | None = None
        self._coffee_thread: threading.Thread | None = None
        self._coffee_stop_event: threading.Event | None = None
        self._three_ttt_osc_lock = threading.Lock()
        self._three_ttt_osc_events: dict[str, dict[str, Any]] = {}
        self._three_ttt_osc_board_tasks: dict[str, str] = {}
        self._three_ttt_osc_address_tasks: dict[str, str] = {}
        self._three_ttt_osc_reached_addresses = {"/reached", "/3ttt/reached", "/3ttt/arrived"}
        self._three_ttt_osc_listener_thread: threading.Thread | None = None
        self._three_ttt_osc_stop_event: threading.Event | None = None
        self._three_ttt_osc_listen_port: int | None = None
        self._three_ttt_queue_condition = threading.Condition()
        self._three_ttt_turn_queue: list[dict[str, Any]] = []
        self._three_ttt_active_turn: dict[str, Any] | None = None
        self._osc_c_lock = threading.Lock()
        self._osc_c_setup = self._load_osc_c_setup()
        self._osc_c_events: list[dict[str, Any]] = []
        self._osc_c_listener_thread: threading.Thread | None = None
        self._osc_c_listener_stop_event: threading.Event | None = None
        self._osc_c_listener_port: int | None = None
        self._osc_c_sequence_thread: threading.Thread | None = None
        self._osc_c_sequence_stop_event: threading.Event | None = None
        self._osc_c_runtime: dict[str, Any] = {
            "running": False,
            "loop": False,
            "mode": self._osc_c_setup["mode"],
            "activeSequenceId": None,
            "activeSequenceName": None,
            "activeStepId": None,
            "activeStepName": None,
            "lastError": None,
            "lastMessage": None,
            "startedAt": None,
            "updatedAt": None,
            "source": None,
        }
        self._servo = ServoCT()
        self._sync_osc_c_listener()

    def _load_osc_c_setup(self) -> dict[str, Any]:
        try:
            result = load_game_mapping_from_disk(OSC_C_MAPPING_KEY)
            if result.get("exists"):
                return normalize_osc_c_setup(result.get("setup"))
        except Exception:
            pass
        return default_osc_c_setup()

    def _record_osc_c_event(self, kind: str, message: str, **extra: Any) -> None:
        event = {
            "kind": kind,
            "message": message,
            "time": time.time(),
            **extra,
        }
        with self._osc_c_lock:
            self._osc_c_events.insert(0, event)
            del self._osc_c_events[OSC_C_LOG_LIMIT:]

    def _osc_c_snapshot(self) -> dict[str, Any]:
        with self._osc_c_lock:
            listener_alive = bool(self._osc_c_listener_thread and self._osc_c_listener_thread.is_alive())
            runner_alive = bool(self._osc_c_sequence_thread and self._osc_c_sequence_thread.is_alive())
            return {
                "setup": deepcopy(self._osc_c_setup),
                "runtime": {
                    **deepcopy(self._osc_c_runtime),
                    "running": bool(self._osc_c_runtime.get("running")) and runner_alive,
                },
                "listener": {
                    "enabled": bool(self._osc_c_setup.get("enabled")),
                    "listening": listener_alive,
                    "port": self._osc_c_listener_port,
                },
                "events": deepcopy(self._osc_c_events[:OSC_C_LOG_LIMIT]),
            }

    def get_osc_c_state(self) -> dict[str, Any]:
        return {"osc_c": self._osc_c_snapshot()}

    def _stop_osc_c_listener(self) -> None:
        with self._osc_c_lock:
            stop_event = self._osc_c_listener_stop_event
            thread = self._osc_c_listener_thread
            self._osc_c_listener_stop_event = None
            self._osc_c_listener_thread = None
            self._osc_c_listener_port = None
        if stop_event is not None:
            stop_event.set()
        if thread is not None and thread.is_alive():
            thread.join(timeout=1.0)

    def _start_osc_c_listener(self, listen_port: int) -> None:
        self._stop_osc_c_listener()
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind(("0.0.0.0", listen_port))
        except Exception:
            sock.close()
            raise
        sock.settimeout(0.25)
        stop_event = threading.Event()
        worker = threading.Thread(
            target=self._run_osc_c_listener,
            args=(sock, stop_event),
            daemon=True,
            name="dobot-osc-c-listener",
        )
        with self._osc_c_lock:
            self._osc_c_listener_stop_event = stop_event
            self._osc_c_listener_thread = worker
            self._osc_c_listener_port = listen_port
        worker.start()
        self._record_osc_c_event("listener", f"OSC_C listening on UDP {listen_port}", port=listen_port)

    def _sync_osc_c_listener(self) -> None:
        with self._osc_c_lock:
            setup = deepcopy(self._osc_c_setup)
            existing_alive = bool(self._osc_c_listener_thread and self._osc_c_listener_thread.is_alive())
            existing_port = self._osc_c_listener_port
        if not setup.get("enabled"):
            self._stop_osc_c_listener()
            return
        listen_port = _coerce_port(setup.get("listenPort"), 9012)
        if existing_alive and existing_port == listen_port:
            return
        try:
            self._start_osc_c_listener(listen_port)
        except Exception as exc:  # noqa: BLE001 - expose listener failures in the UI
            self._record_osc_c_event("error", f"OSC_C listener failed: {exc}", port=listen_port)

    def update_osc_c_config(self, payload: dict[str, Any]) -> dict[str, Any]:
        setup = normalize_osc_c_setup(payload.get("setup", payload))
        with self._osc_c_lock:
            self._osc_c_setup = setup
            self._osc_c_runtime["mode"] = setup["mode"]
            self._osc_c_runtime["updatedAt"] = time.time()
        save_game_mapping_entry(OSC_C_MAPPING_KEY, setup)
        self._sync_osc_c_listener()
        self._record_osc_c_event("config", "OSC_C setup saved", mode=setup["mode"], enabled=setup["enabled"])
        return self.get_osc_c_state()

    def _find_osc_c_sequence(self, setup: dict[str, Any], sequence_ref: Any) -> dict[str, Any] | None:
        reference = str(sequence_ref or "").strip()
        if not reference:
            return None
        lowered = reference.lower()
        for sequence in setup.get("sequences", []):
            if str(sequence.get("id")) == reference or str(sequence.get("name", "")).lower() == lowered:
                return sequence
        return None

    @staticmethod
    def _osc_c_route_matches(route: dict[str, Any], osc_address: str, args: list[Any]) -> bool:
        if not route.get("enabled"):
            return False
        if route.get("address") != osc_address:
            return False
        arg_match = str(route.get("argMatch") or "").strip()
        if not arg_match:
            return True
        return bool(args) and str(args[0]) == arg_match

    def _send_osc_c_status(
        self,
        status: str,
        *,
        sequence: dict[str, Any] | None = None,
        step: dict[str, Any] | None = None,
        route: dict[str, Any] | None = None,
        detail: str = "",
    ) -> None:
        with self._osc_c_lock:
            setup = deepcopy(self._osc_c_setup)
        if not setup.get("sendStatus"):
            return
        status_route_fields = {
            "started": "onStartAddress",
            "step": "onStepAddress",
            "done": "onCompleteAddress",
            "error": "onErrorAddress",
        }
        custom_address = ""
        if route is not None:
            custom_address = _coerce_optional_osc_address(route.get(status_route_fields.get(status, "")))
        address = custom_address or _coerce_osc_address(setup.get("statusAddress"), "/dobot/osc_c/status")
        args: list[Any] = [status]
        if sequence is not None:
            args.append(str(sequence.get("name") or sequence.get("id") or ""))
        if step is not None:
            args.extend([int(step.get("stepId") or 0), str(step.get("name") or "")])
        if detail:
            args.append(detail)
        try:
            packet = pack_osc_message(address, args)
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
                sock.sendto(packet, (str(setup.get("statusHost") or "127.0.0.1"), _coerce_port(setup.get("statusPort"), 9013)))
            self._record_osc_c_event("status", f"Sent OSC_C status {address}", status=status, address=address, custom=bool(custom_address))
        except Exception as exc:  # noqa: BLE001 - status replies should not stop robot logic
            self._record_osc_c_event("error", f"OSC_C status send failed: {exc}", status=status)

    def _stop_osc_c_sequence(self, *, wait: bool, interrupt_motion: bool = False) -> None:
        with self._osc_c_lock:
            stop_event = self._osc_c_sequence_stop_event
            thread = self._osc_c_sequence_thread
            running = bool(self._osc_c_runtime.get("running"))
            live_mode = self._osc_c_runtime.get("mode") == "live"
        if stop_event is not None:
            stop_event.set()
        if interrupt_motion and running and live_mode:
            try:
                client = self._get_connected_client()
                self._dashboard_action(client.reset_robot, attempts=1)
            except Exception:
                pass
        if wait and thread is not None and thread.is_alive():
            thread.join(timeout=2.0)

    def _sleep_osc_c(self, seconds: float, stop_event: threading.Event) -> None:
        deadline = time.monotonic() + max(0.0, seconds)
        while time.monotonic() < deadline:
            if stop_event.is_set():
                break
            time.sleep(min(0.05, max(0.0, deadline - time.monotonic())))

    def _run_osc_c_sequence_worker(
        self,
        sequence: dict[str, Any],
        *,
        loop: bool,
        mode: str,
        source: str,
        route: dict[str, Any] | None,
        stop_event: threading.Event,
    ) -> None:
        error_text: str | None = None
        stopped_by_user = False
        self._send_osc_c_status("started", sequence=sequence, route=route)
        self._record_osc_c_event("run", f"OSC_C started {sequence.get('name')}", sequenceId=sequence.get("id"), mode=mode, source=source)
        try:
            while True:
                steps = deepcopy(sequence.get("steps") or [])
                if not steps:
                    raise RuntimeError(f"{sequence.get('name') or 'Sequence'} has no steps")
                for index, step in enumerate(steps):
                    if stop_event.is_set():
                        break
                    with self._osc_c_lock:
                        self._osc_c_runtime.update(
                            {
                                "activeStepId": step.get("stepId"),
                                "activeStepName": step.get("name"),
                                "lastMessage": f"Step {index + 1}: {step.get('name')}",
                                "updatedAt": time.time(),
                            }
                        )
                    self._record_osc_c_event(
                        "step",
                        f"{sequence.get('name')} step {index + 1}: {step.get('name')}",
                        sequenceId=sequence.get("id"),
                        stepId=step.get("stepId"),
                        mode=mode,
                    )
                    self._send_osc_c_status("step", sequence=sequence, step=step, route=route)
                    dwell_seconds = max(0, int(step.get("dwellMs") or 0)) / 1000.0
                    if mode == "preview":
                        self._sleep_osc_c(dwell_seconds if dwell_seconds > 0 else 0.25, stop_event)
                    else:
                        joints = _coerce_number_list(step.get("joints"), expected=6)
                        if joints is None:
                            raise RuntimeError(f"Step {step.get('name')} has no recorded joints for live mode")
                        sequence_step = SequenceStep(
                            step_id=int(step.get("stepId") or index + 1),
                            name=str(step.get("name") or f"Step {index + 1}"),
                            joints=joints,
                            pose=_coerce_number_list(step.get("pose")),
                            speedj=20,
                            accj=20,
                            dwell_ms=max(0, int(step.get("dwellMs") or 0)),
                        )
                        self._execute_sequence_step(sequence_step)
                        if dwell_seconds > 0:
                            self._sleep_osc_c(dwell_seconds, stop_event)
                if stop_event.is_set() or not loop:
                    break
        except Exception as exc:  # noqa: BLE001 - surface OSC_C execution errors to UI/status OSC
            if stop_event.is_set():
                stopped_by_user = True
            else:
                error_text = str(exc)
        finally:
            if stop_event.is_set():
                stopped_by_user = True
            final_status = "stopped" if stopped_by_user else "error" if error_text else "done"
            with self._osc_c_lock:
                self._osc_c_runtime.update(
                    {
                        "running": False,
                        "loop": False,
                        "activeStepId": None,
                        "activeStepName": None,
                        "lastError": None if stopped_by_user else error_text,
                        "lastMessage": final_status,
                        "updatedAt": time.time(),
                    }
                )
                self._osc_c_sequence_thread = None
                self._osc_c_sequence_stop_event = None
            self._record_osc_c_event(
                final_status,
                f"OSC_C {final_status}: {sequence.get('name')}" + (f" - {error_text}" if error_text else ""),
                sequenceId=sequence.get("id"),
                mode=mode,
            )
            self._send_osc_c_status(final_status, sequence=sequence, route=route, detail=error_text or "")

    def _start_osc_c_sequence(self, sequence_ref: Any, action: str, source: str, route: dict[str, Any] | None = None) -> None:
        if action not in {"run_once", "play_loop"}:
            raise ValueError("OSC_C action must be run_once or play_loop")
        with self._osc_c_lock:
            setup = deepcopy(self._osc_c_setup)
            if self._osc_c_runtime.get("running"):
                raise RuntimeError("OSC_C sequence is already running")
            sequence = self._find_osc_c_sequence(setup, sequence_ref)
            if sequence is None:
                raise RuntimeError(f"OSC_C sequence not found: {sequence_ref}")
            if not sequence.get("enabled"):
                raise RuntimeError(f"OSC_C sequence disabled: {sequence.get('name')}")
            mode = setup.get("mode") if setup.get("mode") in OSC_C_MODES else "preview"
            if mode == "live":
                self._get_connected_client()
            stop_event = threading.Event()
            self._osc_c_sequence_stop_event = stop_event
            self._osc_c_runtime.update(
                {
                    "running": True,
                    "loop": action == "play_loop",
                    "mode": mode,
                    "activeSequenceId": sequence.get("id"),
                    "activeSequenceName": sequence.get("name"),
                    "activeStepId": None,
                    "activeStepName": None,
                    "lastError": None,
                    "lastMessage": "starting",
                    "startedAt": time.time(),
                    "updatedAt": time.time(),
                    "source": source,
                }
            )
            worker = threading.Thread(
                target=self._run_osc_c_sequence_worker,
                kwargs={
                    "sequence": deepcopy(sequence),
                    "loop": action == "play_loop",
                    "mode": mode,
                    "source": source,
                    "route": deepcopy(route) if route is not None else None,
                    "stop_event": stop_event,
                },
                daemon=True,
                name="dobot-osc-c-sequence",
            )
            self._osc_c_sequence_thread = worker
            worker.start()

    def _handle_osc_c_message(self, osc_address: str, args: list[Any], remote: tuple[str, int]) -> None:
        with self._osc_c_lock:
            setup = deepcopy(self._osc_c_setup)
        remote_host = remote[0]
        allowed_host = str(setup.get("allowedHost") or "").strip()
        arg_text = [str(arg) for arg in args]
        self._record_osc_c_event("received", f"{osc_address} {' '.join(arg_text)}".strip(), address=osc_address, args=arg_text, remote=f"{remote[0]}:{remote[1]}")
        if allowed_host and allowed_host != remote_host:
            self._record_osc_c_event("ignored", f"Ignored OSC_C from {remote_host}", address=osc_address, remote=remote_host)
            return

        action: str | None = None
        sequence_ref: Any = None
        matched_route: dict[str, Any] | None = None
        if osc_address == setup.get("directStopAddress"):
            action = "stop"
        elif osc_address == setup.get("directRunAddress") and args:
            action = "run_once"
            sequence_ref = args[0]
        elif osc_address == setup.get("directLoopAddress") and args:
            action = "play_loop"
            sequence_ref = args[0]
        else:
            for route in setup.get("routes", []):
                if self._osc_c_route_matches(route, osc_address, args):
                    action = str(route.get("action") or "run_once")
                    sequence_ref = route.get("sequenceId")
                    matched_route = route
                    break

        if action is None:
            self._record_osc_c_event("ignored", f"No OSC_C route matched {osc_address}", address=osc_address, args=arg_text)
            return
        if action == "stop":
            self._stop_osc_c_sequence(wait=False, interrupt_motion=True)
            self._record_osc_c_event("stop", "OSC_C stop requested", address=osc_address, remote=remote_host)
            self._send_osc_c_status("stop_requested", route=matched_route, detail=osc_address)
            return
        try:
            self._start_osc_c_sequence(sequence_ref, action, source=f"{remote_host} {osc_address}", route=matched_route)
        except Exception as exc:  # noqa: BLE001 - listener must stay alive
            self._record_osc_c_event("error", f"OSC_C route failed: {exc}", address=osc_address, args=arg_text)
            self._send_osc_c_status("error", route=matched_route, detail=str(exc))

    def _run_osc_c_listener(self, sock: socket.socket, stop_event: threading.Event) -> None:
        try:
            while not stop_event.is_set():
                try:
                    data, address = sock.recvfrom(8192)
                except socket.timeout:
                    continue
                except OSError:
                    break
                try:
                    osc_address, args = unpack_osc_message(data)
                    self._handle_osc_c_message(osc_address, args, address)
                except Exception as exc:  # noqa: BLE001 - keep listener alive and log parse errors
                    self._record_osc_c_event("error", f"OSC_C parse error: {exc}")
        finally:
            try:
                sock.close()
            except OSError:
                pass

    def osc_c_action(self, payload: dict[str, Any]) -> dict[str, Any]:
        action = str(payload.get("action") or "").strip()
        if action in {"run_once", "play_loop"}:
            self._start_osc_c_sequence(payload.get("sequenceId") or payload.get("sequenceName"), action, source="manual")
        elif action == "stop":
            self._stop_osc_c_sequence(wait=False, interrupt_motion=True)
            self._record_osc_c_event("stop", "OSC_C manual stop requested")
        else:
            raise ValueError("Unsupported OSC_C action")
        return self.get_osc_c_state()

    def osc_c_test_message(self, payload: dict[str, Any]) -> dict[str, Any]:
        with self._osc_c_lock:
            setup = deepcopy(self._osc_c_setup)
        if not setup.get("enabled"):
            raise RuntimeError("Enable OSC_C listener before sending a test message")
        address = _coerce_osc_address(payload.get("address"), setup.get("directRunAddress") or "/dobot/run")
        raw_args = payload.get("args", [])
        if isinstance(raw_args, str):
            args = [raw_args] if raw_args else []
        elif isinstance(raw_args, list):
            args = raw_args
        else:
            args = [str(raw_args)]
        packet = pack_osc_message(address, args)
        listen_port = _coerce_port(setup.get("listenPort"), 9012)
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.sendto(packet, ("127.0.0.1", listen_port))
        self._record_osc_c_event("test", f"Sent local OSC_C test {address}", address=address, args=[str(arg) for arg in args], port=listen_port)
        return {"sent": True, "address": address, "args": args, "port": listen_port, **self.get_osc_c_state()}

    def get_config(self) -> ConnectionConfig:
        with self._lock:
            return replace(self._config)

    def update_config(self, payload: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            previous = replace(self._config)
            self._config = ConnectionConfig(
                host=str(payload.get("host", self._config.host)),
                dashboard_port=int(payload.get("dashboard_port", self._config.dashboard_port)),
                motion_port=int(payload.get("motion_port", self._config.motion_port)),
                feedback_port=int(payload.get("feedback_port", self._config.feedback_port)),
                timeout=float(payload.get("timeout", self._config.timeout)),
            )
            if self._config != previous and self._session_client is not None:
                self._session_client.close()
                self._session_client = None
                self._connected = False
            self._last_connect_error = None
            return {"config": asdict(self._config)}

    def search_devices(self, payload: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            config = replace(self._config)
            if payload:
                config = ConnectionConfig(
                    host=str(payload.get("host", config.host)),
                    dashboard_port=int(payload.get("dashboard_port", config.dashboard_port)),
                    motion_port=int(payload.get("motion_port", config.motion_port)),
                    feedback_port=int(payload.get("feedback_port", config.feedback_port)),
                    timeout=float(payload.get("timeout", min(config.timeout, 0.4))),
                )

        network = self._derive_search_network(config.host)
        candidates = self._scan_network(network, config)

        with self._lock:
            self._discovered_devices = candidates

        return {
            "devices": candidates,
            "searched_network": network,
        }

    def connect(self, payload: dict[str, Any]) -> dict[str, Any]:
        config_result = self.update_config(payload)
        self._stop_sequence(wait=True)
        self._stop_osc_c_sequence(wait=True, interrupt_motion=True)
        with self._lock:
            config = replace(self._config)
            old_client = self._session_client
            self._session_client = None
            self._connected = False
            self._last_connect_error = None
            self._last_error_poll_at = 0.0
            self._last_auto_reconnect_at = 0.0
        if old_client is not None:
            old_client.close()

        client = DobotClient(
            host=config.host,
            dashboard_port=config.dashboard_port,
            motion_port=config.motion_port,
            feedback_port=config.feedback_port,
            timeout_seconds=config.timeout,
            persistent=True,
        )
        try:
            client.connect()
            with self._lock:
                self._session_client = client
                self._connected = True
            state = self._probe_state(require_full_state=False, force_error_poll=True)
            if state.get("mode_mismatch"):
                raise RuntimeError("Controller is reachable but not in TCP/IP Secondary Development mode")
            if not state["connected"]:
                raise RuntimeError("Robot controller did not answer after connect")
        except Exception as exc:
            client.close()
            with self._lock:
                self._session_client = None
                self._connected = False
                self._last_connect_error = str(exc)
            raise

        with self._lock:
            self._last_connect_error = None
        return {
            **config_result,
            "state": state,
        }

    def disconnect(self) -> dict[str, Any]:
        self._stop_sequence(wait=True)
        self._stop_osc_c_sequence(wait=True, interrupt_motion=True)
        with self._lock:
            client = self._session_client
            self._session_client = None
            self._connected = False
            self._last_connect_error = None
            self._last_error_poll_at = 0.0
            self._last_auto_reconnect_at = 0.0
        if client is not None:
            client.close()
        return {"connected": False, "state": self.get_state()}

    def _reconnect_session(self) -> bool:
        with self._lock:
            config = replace(self._config)
            old_client = self._session_client
            self._session_client = None
            self._connected = False
            self._last_error_poll_at = 0.0
        if old_client is not None:
            old_client.close()

        client = DobotClient(
            host=config.host,
            dashboard_port=config.dashboard_port,
            motion_port=config.motion_port,
            feedback_port=config.feedback_port,
            timeout_seconds=config.timeout,
            persistent=True,
        )
        try:
            client.connect()
        except Exception:
            client.close()
            with self._lock:
                self._session_client = None
                self._connected = False
            return False

        with self._lock:
            self._session_client = client
            self._connected = True
            self._last_auto_reconnect_at = time.monotonic()
        return True

    def _client(self) -> DobotClient:
        if self._session_client is None:
            raise RuntimeError("Connect to a robot first")
        return self._session_client

    def _command_client(self) -> DobotClient:
        return self._get_connected_client()

    def _safe_dashboard_query(
        self,
        client: DobotClient,
        label: str,
        fn: Callable[[], Any],
        *,
        attempts: int = 3,
        delay_seconds: float = 0.12,
    ) -> dict[str, Any]:
        last_error = "No response"
        for attempt in range(attempts):
            try:
                response = fn()
                data = serialize_response(response)
                data["label"] = label
                data["reachable"] = True
                data["stale"] = False
                return data
            except Exception as exc:  # noqa: BLE001 - surface exact controller errors in UI
                last_error = str(exc)
                if "TCP/IP Secondary Development mode" in last_error:
                    return {
                        "label": label,
                        "ok": False,
                        "reachable": True,
                        "stale": False,
                        "mode_mismatch": True,
                        "error": last_error,
                    }
                if attempt < attempts - 1:
                    time.sleep(delay_seconds)

        return {
            "label": label,
            "ok": False,
            "reachable": False,
            "stale": False,
            "error": last_error,
        }

    @staticmethod
    def _derive_search_network(host: str) -> str:
        try:
            address = ipaddress.ip_address(host)
        except ValueError as exc:
            raise ValueError(f"Invalid host for search: {host}") from exc
        return str(ipaddress.ip_network(f"{address}/24", strict=False))

    @staticmethod
    def _port_is_open(host: str, port: int, timeout_seconds: float) -> bool:
        try:
            with socket.create_connection((host, port), timeout=min(timeout_seconds, 0.35)):
                return True
        except OSError:
            return False

    def _probe_candidate(self, host: str, config: ConnectionConfig) -> dict[str, Any] | None:
        dashboard_open = False
        feedback_open = False
        try:
            with socket.create_connection((host, config.dashboard_port), timeout=min(config.timeout, 0.35)):
                dashboard_open = True
        except OSError:
            dashboard_open = False
        try:
            with socket.create_connection((host, config.feedback_port), timeout=min(config.timeout, 0.35)):
                feedback_open = True
        except OSError:
            feedback_open = False
        if not dashboard_open and not feedback_open:
            return None

        candidate_client = DobotClient(
            host=host,
            dashboard_port=config.dashboard_port,
            motion_port=config.motion_port,
            feedback_port=config.feedback_port,
            timeout_seconds=min(config.timeout, 0.8),
        )
        try:
            mode = self._safe_dashboard_query(candidate_client, "RobotMode", candidate_client.robot_mode, attempts=2)
            pose = self._safe_dashboard_query(candidate_client, "GetPose", candidate_client.get_pose, attempts=2)
            mode_name = None
            if mode.get("floats"):
                mode_name = ROBOT_MODES.get(int(mode["floats"][0]), "UNKNOWN")
            if mode.get("mode_mismatch"):
                mode_name = "NOT_TCP_MODE"
            if not mode.get("ok") and feedback_open:
                feedback = self._safe_feedback_query(candidate_client)
                if feedback.get("ok"):
                    mode = {
                        "ok": True,
                        "reachable": True,
                        "label": "RobotMode",
                        "stale": False,
                        "floats": [float(feedback["robot_mode"])],
                        "values": [str(int(feedback["robot_mode"]))],
                        "raw": f"feedback:robot_mode={feedback['robot_mode']}",
                    }
                    pose = feedback["pose"]
                    mode_name = ROBOT_MODES.get(int(feedback["robot_mode"]), "UNKNOWN")
            return {
                "host": host,
                "dashboard_port": config.dashboard_port,
                "motion_port": config.motion_port,
                "feedback_port": config.feedback_port,
                "reachable": bool(mode.get("reachable") or pose.get("reachable")),
                "mode_name": mode_name,
                "mode": mode,
                "pose": pose,
            }
        except Exception:
            return {
                "host": host,
                "dashboard_port": config.dashboard_port,
                "motion_port": config.motion_port,
                "reachable": True,
                "mode_name": None,
            }

    def _scan_network(self, network_text: str, config: ConnectionConfig) -> list[dict[str, Any]]:
        network = ipaddress.ip_network(network_text, strict=False)
        preferred_host = config.host
        hosts = [str(ip) for ip in network.hosts()]
        if preferred_host in hosts:
            hosts.remove(preferred_host)
            hosts.insert(0, preferred_host)

        results: list[dict[str, Any]] = []
        with ThreadPoolExecutor(max_workers=48) as pool:
            futures = {
                pool.submit(self._probe_candidate, host, config): host
                for host in hosts
            }
            for future in as_completed(futures):
                candidate = future.result()
                if candidate and candidate.get("reachable"):
                    results.append(candidate)

        results.sort(key=lambda item: (item["host"] != preferred_host, item["host"]))
        return results

    def _merge_cached_result(self, key: str, current: dict[str, Any]) -> dict[str, Any]:
        cached = self._last_state.get(key)
        has_live_numbers = bool(current.get("floats"))

        if current.get("reachable") and has_live_numbers:
            self._last_state[key] = dict(current)
            return current

        if current.get("reachable") and current.get("ok"):
            self._last_state[key] = dict(current)
            return current

        if cached:
            merged = dict(cached)
            merged["stale"] = True
            merged["live_error"] = current.get("error")
            merged["live_ok"] = current.get("ok")
            merged["label"] = current.get("label", merged.get("label"))
            return merged

        return current

    def _safe_feedback_query(self, client: DobotClient) -> dict[str, Any]:
        try:
            feedback = client.feedback()
            pose = feedback.tool_vector_actual
            joints = feedback.q_actual
            return {
                "ok": True,
                "reachable": True,
                "label": "Feedback30004",
                "stale": False,
                "robot_mode": feedback.robot_mode,
                "pose": {
                    "ok": True,
                    "reachable": True,
                    "label": "FeedbackPose",
                    "stale": False,
                    "floats": pose,
                    "values": [str(value) for value in pose],
                    "raw": "feedback:tool_vector_actual",
                },
                "angle": {
                    "ok": True,
                    "reachable": True,
                    "label": "FeedbackAngle",
                    "stale": False,
                    "floats": joints,
                    "values": [str(value) for value in joints],
                    "raw": "feedback:q_actual",
                },
                "enable_status": feedback.enable_status,
                "error_status": feedback.error_status,
            }
        except Exception as exc:  # noqa: BLE001 - surface feedback path errors in UI
            return {
                "ok": False,
                "reachable": False,
                "label": "Feedback30004",
                "stale": False,
                "error": str(exc),
            }

    def _probe_state(self, *, require_full_state: bool, force_error_poll: bool = False) -> dict[str, Any]:
        with self._lock:
            config = replace(self._config)
            client = self._client()
            should_poll_error = force_error_poll or (time.monotonic() - self._last_error_poll_at >= 5.0)
            speed_ratio = self._speed_ratio

        feedback = self._safe_feedback_query(client)
        dashboard_mode = self._safe_dashboard_query(client, "RobotMode", client.robot_mode, attempts=2)
        raw_mode = dashboard_mode
        raw_pose = self._safe_dashboard_query(client, "GetPose", client.get_pose, attempts=2)
        raw_angle = self._safe_dashboard_query(client, "GetAngle", client.get_angle, attempts=2)

        if feedback.get("ok"):
            if (
                feedback.get("robot_mode") is not None
                and (
                    not raw_mode.get("ok")
                    or not raw_mode.get("floats")
                    or raw_mode.get("echoed_command") != "RobotMode();"
                )
            ):
                raw_mode = {
                    "ok": True,
                    "reachable": True,
                    "label": "RobotMode",
                    "stale": False,
                    "floats": [float(feedback["robot_mode"])],
                    "values": [str(int(feedback["robot_mode"]))],
                    "raw": f"feedback:robot_mode={feedback['robot_mode']}",
                }
            raw_pose = feedback["pose"]
            raw_angle = feedback["angle"]

        if should_poll_error:
            raw_error = self._safe_dashboard_query(client, "GetErrorID", client.get_error_id, attempts=2)
            if raw_error.get("reachable"):
                with self._lock:
                    self._last_error_poll_at = time.monotonic()
        else:
            raw_error = {
                "label": "GetErrorID",
                "ok": True,
                "reachable": False,
                "stale": True,
                "skipped": True,
            }

        mode = self._merge_cached_result("robot_mode", raw_mode)
        pose = self._merge_cached_result("pose", raw_pose)
        angle = self._merge_cached_result("angle", raw_angle)
        error = self._merge_cached_result("error", raw_error)

        dashboard_available = bool(dashboard_mode.get("reachable") and dashboard_mode.get("ok"))
        feedback_available = bool(feedback.get("ok"))
        motion_channel_available = self._port_is_open(config.host, config.motion_port, config.timeout)

        mode_name = None
        if mode.get("floats"):
            mode_number = int(mode["floats"][0])
            mode_name = ROBOT_MODES.get(mode_number, "UNKNOWN")

        connected = dashboard_available or feedback_available or bool(raw_error.get("reachable"))
        if require_full_state and not connected:
            raise RuntimeError("No response from robot controller")

        motion_ready = bool(
            mode_name in {"ENABLED", "RUNNING", "JOG", "PAUSED"}
            and motion_channel_available
            and connected
        )
        live_checks = {
            "robot_mode": bool((raw_mode.get("reachable") and raw_mode.get("ok")) or feedback.get("robot_mode") is not None),
            "pose": bool(raw_pose.get("reachable") and raw_pose.get("ok") and raw_pose.get("floats")),
            "angle": bool(raw_angle.get("reachable") and raw_angle.get("ok") and raw_angle.get("floats")),
            "error": bool(raw_error.get("skipped") or (raw_error.get("reachable") and raw_error.get("ok"))),
        }
        mode_mismatch = any(result.get("mode_mismatch") for result in (raw_mode, raw_pose, raw_angle, raw_error))
        telemetry_limited = connected and (not live_checks["pose"] or not live_checks["angle"])
        telemetry_degraded = connected and not live_checks["robot_mode"]
        status = "connected" if connected and not telemetry_degraded else "degraded" if connected else "disconnected"
        return {
            "connected": connected,
            "status": status,
            "motion_ready": motion_ready,
            "dashboard_available": dashboard_available,
            "feedback_available": feedback_available,
            "motion_channel_available": motion_channel_available,
            "telemetry_degraded": telemetry_degraded,
            "telemetry_limited": telemetry_limited,
            "mode_mismatch": mode_mismatch,
            "live_checks": live_checks,
            "config": asdict(config),
            "speed_ratio": speed_ratio,
            "feedback": feedback,
            "robot_mode": mode,
            "mode_name": mode_name,
            "pose": pose,
            "angle": angle,
            "error": error,
        }

    def _maybe_recover_degraded_state(self, state: dict[str, Any]) -> dict[str, Any]:
        if not state["connected"] or not state["telemetry_degraded"]:
            return state
        if state.get("mode_mismatch"):
            return state
        if state["live_checks"].get("pose") or state["live_checks"].get("angle"):
            return state

        with self._lock:
            recently_reconnected = time.monotonic() - self._last_auto_reconnect_at < 6.0
        if recently_reconnected:
            return state

        if not self._reconnect_session():
            return state

        recovered_state = self._probe_state(require_full_state=False, force_error_poll=True)
        recovered_state["auto_reconnected"] = True
        return recovered_state

    def get_state(self) -> dict[str, Any]:
        with self._lock:
            connected = self._connected
            config = replace(self._config)
            discovered = list(self._discovered_devices)
            connect_error = self._last_connect_error
            speed_ratio = self._speed_ratio
            cached_state = {
                "robot_mode": self._last_state["robot_mode"],
                "pose": self._last_state["pose"],
                "angle": self._last_state["angle"],
                "error": self._last_state["error"],
            }
            sequence = self._sequence_snapshot_no_lock()

        if not connected:
            mode_name = None
            mode = cached_state["robot_mode"]
            if mode and mode.get("floats"):
                mode_name = ROBOT_MODES.get(int(mode["floats"][0]), "UNKNOWN")
            return {
                "connected": False,
                "status": "disconnected",
                "motion_ready": False,
                "dashboard_available": False,
                "feedback_available": False,
                "motion_channel_available": False,
                "telemetry_degraded": False,
                "telemetry_limited": False,
                "live_checks": {
                    "robot_mode": False,
                    "pose": False,
                    "angle": False,
                    "error": False,
                },
                "config": asdict(config),
                "speed_ratio": speed_ratio,
                "robot_mode": mode,
                "mode_name": mode_name,
                "pose": cached_state["pose"],
                "angle": cached_state["angle"],
                "error": cached_state["error"],
                "discovered_devices": discovered,
                "connect_error": connect_error,
                "sequence": sequence,
                "osc_c": self._osc_c_snapshot(),
            }

        state = self._probe_state(require_full_state=False)
        state = self._maybe_recover_degraded_state(state)
        state["discovered_devices"] = discovered
        state["connect_error"] = connect_error
        state["sequence"] = self._sequence_snapshot()
        state["osc_c"] = self._osc_c_snapshot()
        return state

    def _sequence_snapshot(self) -> dict[str, Any]:
        with self._lock:
            return self._sequence_snapshot_no_lock()

    def _sequence_snapshot_no_lock(self) -> dict[str, Any]:
        steps = [
            {
                "step_id": step.step_id,
                "name": step.name,
                "joints": list(step.joints),
                "pose": list(step.pose) if step.pose is not None else None,
                "speedj": step.speedj,
                "accj": step.accj,
                "dwell_ms": step.dwell_ms,
            }
            for step in self._sequence_steps
        ]
        return {
            "steps": steps,
            "selected_step_id": self._sequence_selected_id,
            "active_step_id": self._sequence_active_id,
            "running": self._sequence_running,
            "loop": self._sequence_loop,
            "last_error": self._sequence_last_error,
        }

    def _default_step_name_no_lock(self) -> str:
        if not self._sequence_steps:
            return "Home"
        return f"Step {len(self._sequence_steps) + 1}"

    def _capture_live_position(self) -> tuple[list[float], list[float] | None]:
        state = self.get_state()
        joints = state.get("angle", {}).get("floats") if state.get("angle") else None
        if not joints or len(joints) != 6:
            raise RuntimeError("Live joint values are unavailable")
        pose = state.get("pose", {}).get("floats") if state.get("pose") else None
        return [float(value) for value in joints], [float(value) for value in pose] if pose else None

    def _find_sequence_step_index(self, step_id: int) -> int:
        with self._lock:
            for index, step in enumerate(self._sequence_steps):
                if step.step_id == step_id:
                    return index
        raise ValueError("Sequence step not found")

    def _get_sequence_step(self, step_id: int) -> SequenceStep:
        with self._lock:
            for step in self._sequence_steps:
                if step.step_id == step_id:
                    return SequenceStep(
                        step_id=step.step_id,
                        name=step.name,
                        joints=list(step.joints),
                        pose=list(step.pose) if step.pose is not None else None,
                        speedj=step.speedj,
                        accj=step.accj,
                        dwell_ms=step.dwell_ms,
                    )
        raise ValueError("Sequence step not found")

    def _stop_sequence(self, *, wait: bool, interrupt_motion: bool = False) -> None:
        with self._lock:
            stop_event = self._sequence_stop_event
            thread = self._sequence_thread
            running = self._sequence_running
        if stop_event is not None:
            stop_event.set()
        if interrupt_motion and running:
            try:
                client = self._get_connected_client()
                self._dashboard_action(client.reset_robot, attempts=1)
            except Exception:
                pass
        if wait and thread is not None and thread.is_alive():
            thread.join(timeout=2.0)

    def _coffee_snapshot_no_lock(self, order_id: str | None = None) -> dict[str, Any]:
        def clone(target_id: str | None) -> dict[str, Any] | None:
            if not target_id:
                return None
            order = self._coffee_orders.get(target_id)
            return deepcopy(order) if order is not None else None

        requested_order = clone(order_id)
        active_order = clone(self._coffee_active_order_id)
        last_completed = clone(self._coffee_last_completed_order_id)
        last_failed = clone(self._coffee_last_failed_order_id)
        return {
            "running": bool(self._coffee_thread and self._coffee_thread.is_alive()),
            "queue_length": len(self._coffee_queue),
            "queue_order_ids": list(self._coffee_queue),
            "active_order_id": self._coffee_active_order_id,
            "last_completed_order_id": self._coffee_last_completed_order_id,
            "last_failed_order_id": self._coffee_last_failed_order_id,
            "last_error": self._coffee_last_error,
            "active_order": active_order,
            "last_completed_order": last_completed,
            "last_failed_order": last_failed,
            "requested_order": requested_order,
        }

    def get_coffee_state(self, order_id: str | None = None) -> dict[str, Any]:
        with self._lock:
            return self._coffee_snapshot_no_lock(order_id)

    @staticmethod
    def _coffee_history_record(order: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": str(order.get("id", "")),
            "customerName": str(order.get("customerName", "Customer") or "Customer"),
            "recipeKey": str(order.get("recipeKey", "")),
            "drinkName": str(order.get("recipeLabel", "") or order.get("recipeKey", "")),
            "createdAt": str(order.get("createdAt", "")),
            "status": str(order.get("status", "")),
            "startedAt": order.get("startedAt"),
            "completedAt": order.get("completedAt"),
            "error": order.get("error"),
        }

    def _load_coffee_order_history(self) -> list[dict[str, Any]]:
        try:
            raw = json.loads(COFFEE_ORDERS_DB.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return []
        except Exception:
            return []

        if not isinstance(raw, list):
            return []
        records: list[dict[str, Any]] = []
        for item in raw:
            if not isinstance(item, dict):
                continue
            records.append({
                "id": str(item.get("id", "")),
                "customerName": str(item.get("customerName", "Customer") or "Customer"),
                "recipeKey": str(item.get("recipeKey", "")),
                "drinkName": str(item.get("drinkName", "") or item.get("recipeLabel", "")),
                "createdAt": str(item.get("createdAt", "")),
                "status": str(item.get("status", "")),
                "startedAt": item.get("startedAt"),
                "completedAt": item.get("completedAt"),
                "error": item.get("error"),
            })
        return records

    def _save_coffee_order_history(self, records: list[dict[str, Any]]) -> None:
        COFFEE_ORDERS_DB.write_text(
            json.dumps(records, indent=2, ensure_ascii=False),
            encoding="utf-8",
        )

    def _upsert_coffee_order_history(self, order: dict[str, Any]) -> None:
        record = self._coffee_history_record(order)
        if not record["id"]:
            return
        records = self._load_coffee_order_history()
        for index, existing in enumerate(records):
            if existing.get("id") == record["id"]:
                records[index] = record
                break
        else:
            records.append(record)
        self._save_coffee_order_history(records)

    def get_coffee_order_history(self) -> dict[str, Any]:
        records = self._load_coffee_order_history()
        records.sort(key=lambda item: str(item.get("createdAt", "")), reverse=True)
        return {"orders": records}

    def export_coffee_order_history_csv(self) -> bytes:
        records = self.get_coffee_order_history()["orders"]
        output = io.StringIO()
        writer = csv.writer(output)
        writer.writerow(["Name", "Drink Name", "Timing"])
        for record in records:
            writer.writerow([
                record.get("customerName", ""),
                record.get("drinkName", ""),
                record.get("createdAt", ""),
            ])
        return ("\ufeff" + output.getvalue()).encode("utf-8")

    @staticmethod
    def _normalize_coffee_targets(raw_targets: Any) -> dict[str, dict[str, Any]]:
        if not isinstance(raw_targets, dict):
            raise ValueError("Coffee setup targets are missing")

        normalized: dict[str, dict[str, Any]] = {}
        for name, target in raw_targets.items():
            if name not in COFFEE_TARGET_NAMES or not isinstance(target, dict):
                continue
            joints_raw = target.get("joints")
            if not isinstance(joints_raw, list) or len(joints_raw) != 6:
                continue
            joints = [float(value) for value in joints_raw]
            pose_raw = target.get("pose")
            pose = None
            if isinstance(pose_raw, list) and len(pose_raw) >= 3:
                pose = [float(value) for value in pose_raw]
            normalized[name] = {
                "slot": name,
                "joints": joints,
                "pose": pose,
                "capturedAt": target.get("capturedAt"),
            }
        return normalized

    @staticmethod
    def _normalize_coffee_routines(raw_routines: Any) -> dict[str, dict[str, Any]]:
        if not isinstance(raw_routines, dict):
            raise ValueError("Coffee routines are missing")

        normalized: dict[str, dict[str, Any]] = {}
        for key, routine in raw_routines.items():
            if key not in COFFEE_ROUTINE_NAMES or not isinstance(routine, dict):
                continue
            steps_raw = routine.get("steps")
            if not isinstance(steps_raw, list):
                steps_raw = []
            steps: list[dict[str, Any]] = []
            for index, step in enumerate(steps_raw):
                if not isinstance(step, dict):
                    continue
                joints_raw = step.get("joints")
                if not isinstance(joints_raw, list) or len(joints_raw) != 6:
                    continue
                joints = [float(value) for value in joints_raw]
                pose_raw = step.get("pose")
                pose = None
                if isinstance(pose_raw, list) and len(pose_raw) >= 3:
                    pose = [float(value) for value in pose_raw]
                steps.append({
                    "stepId": int(step.get("stepId", index + 1)),
                    "name": str(step.get("name", "")).strip() or f"{key} {index + 1}",
                    "joints": joints,
                    "pose": pose,
                    "dwellMs": max(0, int(step.get("dwellMs", 0) or 0)),
                    "capturedAt": step.get("capturedAt"),
                })
            normalized[key] = {"steps": steps}
        return normalized

    def _ensure_coffee_ready_for_order(self) -> None:
        state = self.get_state()
        if not state["connected"]:
            raise RuntimeError("Connect the robot before accepting coffee orders")
        if not state["motion_ready"]:
            raise RuntimeError("Robot motion is not ready. Enable the robot and confirm TCP motion is available")
        with self._lock:
            if self._sequence_running:
                raise RuntimeError("Stop the sequence runner before starting the coffee workflow")

    def _start_coffee_worker_if_needed(self) -> None:
        with self._lock:
            if self._coffee_thread is not None and self._coffee_thread.is_alive():
                return
            self._coffee_stop_event = threading.Event()
            worker = threading.Thread(
                target=self._run_coffee_worker,
                daemon=True,
                name="dobot-coffee-runner",
            )
            self._coffee_thread = worker
            worker.start()

    def queue_coffee_order(self, payload: dict[str, Any]) -> dict[str, Any]:
        self._ensure_coffee_ready_for_order()

        order_id = str(payload.get("id", "")).strip()
        if not order_id:
            raise ValueError("Order id is required")

        customer_name = str(payload.get("customerName", "")).strip() or "Customer"
        recipe_key = str(payload.get("recipeKey", "")).strip()
        recipe_label = str(payload.get("recipeLabel", "")).strip() or recipe_key.replace("_", " ").title()
        recipe_routine_key = str(payload.get("recipeRoutineKey", "")).strip()
        gripper_type = str(payload.get("gripperType", "")).strip() or "two_finger"
        pour_ms = max(1000, int(payload.get("pourMs", 0) or 0))
        created_at = str(payload.get("createdAt", "")).strip() or time.strftime("%Y-%m-%dT%H:%M:%S")

        if not recipe_key:
            raise ValueError("Recipe key is required")
        if recipe_routine_key not in COFFEE_ROUTINE_NAMES:
            raise ValueError("Recipe routine key is invalid")
        if gripper_type not in COFFEE_ALLOWED_GRIPPERS:
            raise ValueError("Unsupported gripper type")

        targets = self._normalize_coffee_targets(payload.get("targets"))
        missing_targets = sorted(COFFEE_REQUIRED_POSITION_TARGETS - set(targets))
        if missing_targets:
            raise ValueError(f"Missing coffee targets: {', '.join(missing_targets)}")
        routines = self._normalize_coffee_routines(payload.get("routines"))
        missing_routines = sorted(COFFEE_REQUIRED_CORE_ROUTINES - {key for key, routine in routines.items() if routine.get("steps")})
        if missing_routines:
            raise ValueError(f"Missing coffee routines: {', '.join(missing_routines)}")
        if not routines.get(recipe_routine_key, {}).get("steps"):
            raise ValueError(f"Selected drink routine is empty: {recipe_routine_key}")

        order = {
            "id": order_id,
            "customerName": customer_name,
            "recipeKey": recipe_key,
            "recipeLabel": recipe_label,
            "pourMs": pour_ms,
            "recipeRoutineKey": recipe_routine_key,
            "gripperType": gripper_type,
            "createdAt": created_at,
            "targets": targets,
            "routines": routines,
            "status": "queued",
            "phase": "queued",
            "message": f"{recipe_label} is queued. The robot will start shortly.",
            "startedAt": None,
            "completedAt": None,
            "error": None,
        }

        with self._lock:
            if order_id in self._coffee_orders:
                raise ValueError("Order id already exists")
            self._coffee_orders[order_id] = order
            self._coffee_queue.append(order_id)
            self._coffee_last_error = None

        self._upsert_coffee_order_history(order)
        self._start_coffee_worker_if_needed()
        return {
            "order": deepcopy(order),
            "coffee": self.get_coffee_state(order_id),
        }

    def _update_coffee_order(
        self,
        order_id: str,
        *,
        status: str | None = None,
        phase: str | None = None,
        message: str | None = None,
        error: str | None = None,
        started_at: str | None = None,
        completed_at: str | None = None,
    ) -> None:
        history_order: dict[str, Any] | None = None
        with self._lock:
            order = self._coffee_orders.get(order_id)
            if order is None:
                return
            if status is not None:
                order["status"] = status
            if phase is not None:
                order["phase"] = phase
            if message is not None:
                order["message"] = message
            if error is not None:
                order["error"] = error
            if started_at is not None:
                order["startedAt"] = started_at
            if completed_at is not None:
                order["completedAt"] = completed_at
            history_order = deepcopy(order)
        if history_order is not None:
            self._upsert_coffee_order_history(history_order)

    def _sleep_with_stop(self, seconds: float, stop_event: threading.Event | None) -> None:
        deadline = time.monotonic() + max(0.0, seconds)
        while time.monotonic() < deadline:
            if stop_event is not None and stop_event.is_set():
                raise RuntimeError("Coffee workflow stopped")
            time.sleep(min(0.1, deadline - time.monotonic()))

    def _move_to_coffee_target(self, joints: list[float]) -> None:
        self._get_connected_client()
        with self._lock:
            speed_ratio = self._speed_ratio
        client = self._command_client()
        client.joint_movj(joints, speedj=speed_ratio, accj=speed_ratio)
        client.sync()
        self._wait_for_joint_target(joints)

    def _run_coffee_motion_step(
        self,
        order_id: str,
        *,
        status: str,
        phase: str,
        message: str,
        joints: list[float],
    ) -> None:
        self._update_coffee_order(order_id, status=status, phase=phase, message=message, error=None)
        self._move_to_coffee_target(joints)

    def _execute_coffee_routine(
        self,
        order_id: str,
        routine_key: str,
        routine_label: str,
        routine: dict[str, Any],
        stop_event: threading.Event | None,
    ) -> None:
        steps = routine.get("steps", [])
        if not steps:
            raise RuntimeError(f"{routine_label} sequence is empty")
        for index, step in enumerate(steps, start=1):
            self._run_coffee_motion_step(
                order_id,
                status="running",
                phase=f"routine_{routine_key}_{index}",
                message=f"{routine_label}: {step.get('name', f'Step {index}')}",
                joints=[float(value) for value in step["joints"]],
            )
            dwell_ms = max(0, int(step.get("dwellMs", 0) or 0))
            if dwell_ms > 0:
                self._sleep_with_stop(dwell_ms / 1000.0, stop_event)

    def _execute_coffee_order(self, order: dict[str, Any], stop_event: threading.Event | None) -> None:
        self._ensure_coffee_ready_for_order()
        order_id = str(order["id"])
        targets = deepcopy(order["targets"])
        routines = deepcopy(order["routines"])
        recipe_label = str(order["recipeLabel"])
        recipe_routine_key = str(order["recipeRoutineKey"])

        self._run_coffee_motion_step(
            order_id,
            status="running",
            phase="moving_home",
            message="Moving to the home position.",
            joints=targets["HOME"]["joints"],
        )
        self._execute_coffee_routine(order_id, "cup_pick", "Cup Pick", routines["cup_pick"], stop_event)
        self._execute_coffee_routine(order_id, "machine_place", "Machine Place", routines["machine_place"], stop_event)
        self._execute_coffee_routine(order_id, recipe_routine_key, f"{recipe_label} Button", routines[recipe_routine_key], stop_event)
        self._update_coffee_order(
            order_id,
            status="running",
            phase="waiting_for_pour",
            message=f"{recipe_label} is pouring into the cup.",
            error=None,
        )
        self._sleep_with_stop(float(order["pourMs"]) / 1000.0, stop_event)
        self._execute_coffee_routine(order_id, "machine_pickup", "Machine Pickup", routines["machine_pickup"], stop_event)
        self._execute_coffee_routine(order_id, "delivery", "Delivery", routines["delivery"], stop_event)

    def _run_coffee_worker(self) -> None:
        stop_event: threading.Event | None = None
        try:
            while True:
                with self._lock:
                    stop_event = self._coffee_stop_event
                    if not self._coffee_queue:
                        self._coffee_active_order_id = None
                        self._coffee_thread = None
                        self._coffee_stop_event = None
                        return
                    order_id = self._coffee_queue.pop(0)
                    order = deepcopy(self._coffee_orders[order_id])
                    self._coffee_active_order_id = order_id
                    self._coffee_last_error = None
                    self._coffee_orders[order_id]["status"] = "running"
                    self._coffee_orders[order_id]["phase"] = "starting"
                    self._coffee_orders[order_id]["message"] = "Starting the robot coffee workflow."
                    self._coffee_orders[order_id]["error"] = None
                    self._coffee_orders[order_id]["startedAt"] = time.strftime("%Y-%m-%dT%H:%M:%S")
                try:
                    self._execute_coffee_order(order, stop_event)
                except Exception as exc:  # noqa: BLE001 - surface exact workflow failures
                    error_text = str(exc)
                    completed_at = time.strftime("%Y-%m-%dT%H:%M:%S")
                    self._update_coffee_order(
                        order_id,
                        status="failed",
                        phase="failed",
                        message=f"Coffee workflow failed: {error_text}",
                        error=error_text,
                        completed_at=completed_at,
                    )
                    with self._lock:
                        self._coffee_last_failed_order_id = order_id
                        self._coffee_last_error = error_text
                        self._coffee_active_order_id = None
                    continue

                completed_at = time.strftime("%Y-%m-%dT%H:%M:%S")
                self._update_coffee_order(
                    order_id,
                    status="completed",
                    phase="completed",
                    message=f"{order['recipeLabel']} is ready at the delivery point. Thank you for ordering.",
                    completed_at=completed_at,
                    error=None,
                )
                with self._lock:
                    self._coffee_last_completed_order_id = order_id
                    self._coffee_active_order_id = None
        finally:
            with self._lock:
                if self._coffee_thread is not None and not self._coffee_queue:
                    self._coffee_thread = None
                    self._coffee_stop_event = None

    def _coerce_orientation_lock_pose(self, payload: dict[str, Any]) -> list[float] | None:
        if not bool(payload.get("lock_orientation", False)):
            return None
        pose_raw = payload.get("orientation_pose")
        if not isinstance(pose_raw, list) or len(pose_raw) < 6:
            raise ValueError("orientation_pose must be a list of 6 values when orientation lock is enabled")
        try:
            pose = [float(value) for value in pose_raw[:6]]
        except (TypeError, ValueError) as exc:
            raise ValueError("orientation_pose contains invalid values") from exc
        if any(not math.isfinite(value) for value in pose):
            raise ValueError("orientation_pose contains invalid values")
        return pose

    def _execute_locked_pose_step(self, step: SequenceStep, orientation_pose: list[float]) -> None:
        if step.pose is None or len(step.pose) < 3:
            raise RuntimeError(f"Sequence step '{step.name}' does not have pose data required for orientation lock")
        with self._lock:
            speed_ratio = self._speed_ratio
        self._get_connected_client()
        client = self._command_client()
        target_pose = [
            float(step.pose[0]),
            float(step.pose[1]),
            float(step.pose[2]),
            float(orientation_pose[3]),
            float(orientation_pose[4]),
            float(orientation_pose[5]),
        ]
        client.movl(
            target_pose,
            speedl=speed_ratio,
            accl=speed_ratio,
        )
        client.sync()

    def _execute_sequence_step(
        self,
        step: SequenceStep,
        *,
        orientation_pose: list[float] | None = None,
    ) -> None:
        if orientation_pose is not None:
            self._execute_locked_pose_step(step, orientation_pose)
            return
        with self._lock:
            speed_ratio = self._speed_ratio
        self._get_connected_client()
        client = self._command_client()
        client.joint_movj(
            step.joints,
            speedj=speed_ratio,
            accj=speed_ratio,
        )
        self._motion_sync_or_warning(client)
        self._wait_for_joint_target(step.joints)

    def _wait_for_joint_target(
        self,
        target_joints: list[float],
        *,
        tolerance_degrees: float = 1.0,
        timeout_seconds: float = 20.0,
        poll_interval_seconds: float = 0.08,
        stable_reads_required: int = 2,
    ) -> None:
        deadline = time.monotonic() + timeout_seconds
        stable_reads = 0
        use_feedback = True

        while time.monotonic() < deadline:
            client = self._get_connected_client()
            if use_feedback:
                try:
                    feedback = client.feedback()
                    actual = feedback.q_actual
                except Exception:
                    use_feedback = False
                    actual = self._dashboard_joint_values(client)
            else:
                actual = self._dashboard_joint_values(client)
            if len(actual) != 6:
                stable_reads = 0
                time.sleep(poll_interval_seconds)
                continue

            deltas = [abs(actual[index] - target_joints[index]) for index in range(6)]
            if max(deltas) <= tolerance_degrees:
                stable_reads += 1
                if stable_reads >= stable_reads_required:
                    return
            else:
                stable_reads = 0
            time.sleep(poll_interval_seconds)

        raise RuntimeError("Robot did not reach the requested joint target in time")

    @staticmethod
    def _dashboard_joint_values(client: DobotClient) -> list[float]:
        response = client.get_angle()
        data = serialize_response(response)
        values = data.get("floats")
        if response.ok and isinstance(values, list) and len(values) == 6:
            return [float(value) for value in values]
        return []

    @staticmethod
    def _angle_delta_degrees(actual: float, target: float) -> float:
        delta = actual - target
        while delta > 180:
            delta -= 360
        while delta <= -180:
            delta += 360
        return delta

    def _wait_for_pose_target(
        self,
        target_pose: list[float],
        *,
        tolerance_mm: float = 2.0,
        tolerance_degrees: float = 2.0,
        timeout_seconds: float = 20.0,
        poll_interval_seconds: float = 0.08,
        stable_reads_required: int = 2,
    ) -> None:
        deadline = time.monotonic() + timeout_seconds
        stable_reads = 0
        use_feedback = True

        while time.monotonic() < deadline:
            client = self._get_connected_client()
            if use_feedback:
                try:
                    feedback = client.feedback()
                    actual = feedback.tool_vector_actual
                except Exception:
                    use_feedback = False
                    actual = self._dashboard_pose_values(client)
            else:
                actual = self._dashboard_pose_values(client)
            if len(actual) < 6:
                stable_reads = 0
                time.sleep(poll_interval_seconds)
                continue

            xyz_deltas = [abs(actual[index] - target_pose[index]) for index in range(3)]
            angle_deltas = [
                abs(self._angle_delta_degrees(actual[index], target_pose[index]))
                for index in range(3, 6)
            ]
            if max(xyz_deltas) <= tolerance_mm and max(angle_deltas) <= tolerance_degrees:
                stable_reads += 1
                if stable_reads >= stable_reads_required:
                    return
            else:
                stable_reads = 0
            time.sleep(poll_interval_seconds)

        raise RuntimeError("Robot did not reach the requested pose target in time")

    @staticmethod
    def _dashboard_pose_values(client: DobotClient) -> list[float]:
        response = client.get_pose()
        data = serialize_response(response)
        values = data.get("floats")
        if response.ok and isinstance(values, list) and len(values) >= 6:
            return [float(value) for value in values[:6]]
        return []

    @staticmethod
    def _motion_sync_or_warning(client: DobotClient) -> dict[str, Any]:
        try:
            return {"ok": True, "raw": client.sync()}
        except RuntimeError as exc:
            message = str(exc)
            if "Sync()" not in message:
                raise
            raw = message.replace("Motion command rejected: ", "")
            return {"ok": False, "raw": raw, "warning": message}

    def _run_sequence_worker(
        self,
        *,
        loop: bool,
        orientation_pose: list[float] | None = None,
    ) -> None:
        error_text: str | None = None
        stopped_by_user = False
        try:
            while True:
                with self._lock:
                    steps = [
                        SequenceStep(
                            step_id=step.step_id,
                            name=step.name,
                            joints=list(step.joints),
                            pose=list(step.pose) if step.pose is not None else None,
                            speedj=step.speedj,
                            accj=step.accj,
                            dwell_ms=step.dwell_ms,
                        )
                        for step in self._sequence_steps
                    ]
                    stop_event = self._sequence_stop_event
                if not steps:
                    break
                assert stop_event is not None

                for step in steps:
                    if stop_event.is_set():
                        break
                    with self._lock:
                        self._sequence_active_id = step.step_id
                        self._sequence_selected_id = step.step_id
                    self._execute_sequence_step(step, orientation_pose=orientation_pose)
                    if step.dwell_ms > 0:
                        dwell_deadline = time.monotonic() + (step.dwell_ms / 1000)
                        while time.monotonic() < dwell_deadline:
                            if stop_event.is_set():
                                break
                            time.sleep(0.05)
                    if stop_event.is_set():
                        break

                if stop_event.is_set() or not loop:
                    break
        except Exception as exc:  # noqa: BLE001 - surface exact sequence playback errors
            if stop_event is not None and stop_event.is_set():
                stopped_by_user = True
            else:
                error_text = str(exc)
        finally:
            if stop_event is not None and stop_event.is_set():
                stopped_by_user = True
            with self._lock:
                self._sequence_running = False
                self._sequence_loop = False
                self._sequence_active_id = None
                self._sequence_last_error = None if stopped_by_user else error_text
                self._sequence_thread = None
                self._sequence_stop_event = None

    def sequence_action(self, payload: dict[str, Any]) -> dict[str, Any]:
        action = str(payload.get("action", "")).strip()
        if not action:
            raise ValueError("Missing sequence action")

        if action == "clear":
            self._stop_sequence(wait=True, interrupt_motion=True)
            with self._lock:
                self._sequence_steps = []
                self._sequence_selected_id = None
                self._sequence_active_id = None
                self._sequence_last_error = None
            return {"sequence": self._sequence_snapshot()}

        if action == "add_current":
            joints, pose = self._capture_live_position()
            with self._lock:
                step = SequenceStep(
                    step_id=self._sequence_next_id,
                    name=str(payload.get("name", "")).strip() or self._default_step_name_no_lock(),
                    joints=joints,
                    pose=pose,
                    speedj=clamp_int(payload.get("speedj", 20), 1, 100, label="SpeedJ"),
                    accj=clamp_int(payload.get("accj", 20), 1, 100, label="AccJ"),
                    dwell_ms=max(0, int(payload.get("dwell_ms", 0))),
                )
                self._sequence_steps.append(step)
                self._sequence_next_id += 1
                self._sequence_selected_id = step.step_id
                self._sequence_last_error = None
            return {"sequence": self._sequence_snapshot()}

        step_id = int(payload.get("step_id", 0)) if payload.get("step_id") is not None else None

        if action == "select":
            if step_id is None:
                raise ValueError("Missing step_id")
            self._find_sequence_step_index(step_id)
            with self._lock:
                self._sequence_selected_id = step_id
            return {"sequence": self._sequence_snapshot()}

        if action == "delete":
            if step_id is None:
                raise ValueError("Missing step_id")
            self._stop_sequence(wait=True, interrupt_motion=True)
            with self._lock:
                index = next((i for i, step in enumerate(self._sequence_steps) if step.step_id == step_id), None)
                if index is None:
                    raise ValueError("Sequence step not found")
                self._sequence_steps.pop(index)
                if self._sequence_selected_id == step_id:
                    if self._sequence_steps:
                        replacement_index = min(index, len(self._sequence_steps) - 1)
                        self._sequence_selected_id = self._sequence_steps[replacement_index].step_id
                    else:
                        self._sequence_selected_id = None
                if self._sequence_active_id == step_id:
                    self._sequence_active_id = None
            return {"sequence": self._sequence_snapshot()}

        if action == "move":
            if step_id is None:
                raise ValueError("Missing step_id")
            direction = str(payload.get("direction", "")).strip()
            if direction not in {"up", "down"}:
                raise ValueError("direction must be 'up' or 'down'")
            with self._lock:
                index = next((i for i, step in enumerate(self._sequence_steps) if step.step_id == step_id), None)
                if index is None:
                    raise ValueError("Sequence step not found")
                target_index = index - 1 if direction == "up" else index + 1
                if target_index < 0 or target_index >= len(self._sequence_steps):
                    return {"sequence": self._sequence_snapshot()}
                self._sequence_steps[index], self._sequence_steps[target_index] = (
                    self._sequence_steps[target_index],
                    self._sequence_steps[index],
                )
            return {"sequence": self._sequence_snapshot()}

        if action == "replace_current":
            if step_id is None:
                raise ValueError("Missing step_id")
            joints, pose = self._capture_live_position()
            with self._lock:
                index = next((i for i, step in enumerate(self._sequence_steps) if step.step_id == step_id), None)
                if index is None:
                    raise ValueError("Sequence step not found")
                existing = self._sequence_steps[index]
                existing.joints = joints
                existing.pose = pose
                existing.speedj = clamp_int(payload.get("speedj", existing.speedj), 1, 100, label="SpeedJ")
                existing.accj = clamp_int(payload.get("accj", existing.accj), 1, 100, label="AccJ")
                existing.dwell_ms = max(0, int(payload.get("dwell_ms", existing.dwell_ms)))
                name = str(payload.get("name", "")).strip()
                if name:
                    existing.name = name
                self._sequence_selected_id = existing.step_id
            return {"sequence": self._sequence_snapshot()}

        if action == "move_selected":
            if step_id is None:
                raise ValueError("Missing step_id")
            step = self._get_sequence_step(step_id)
            orientation_pose = self._coerce_orientation_lock_pose(payload)
            with self._lock:
                self._sequence_active_id = step.step_id
                self._sequence_last_error = None
            try:
                self._execute_sequence_step(step, orientation_pose=orientation_pose)
            finally:
                with self._lock:
                    self._sequence_active_id = None
                    self._sequence_selected_id = step.step_id
            return {"sequence": self._sequence_snapshot()}

        if action in {"play_once", "play_loop"}:
            self._get_connected_client()
            orientation_pose = self._coerce_orientation_lock_pose(payload)
            with self._lock:
                if not self._sequence_steps:
                    raise RuntimeError("Sequence is empty")
                if self._sequence_running:
                    raise RuntimeError("Sequence is already running")
                self._sequence_stop_event = threading.Event()
                self._sequence_running = True
                self._sequence_loop = action == "play_loop"
                self._sequence_last_error = None
                worker = threading.Thread(
                    target=self._run_sequence_worker,
                    kwargs={
                        "loop": action == "play_loop",
                        "orientation_pose": list(orientation_pose) if orientation_pose is not None else None,
                    },
                    daemon=True,
                    name="dobot-sequence-runner",
                )
                self._sequence_thread = worker
                worker.start()
            return {"sequence": self._sequence_snapshot()}

        if action == "stop":
            self._stop_sequence(wait=True, interrupt_motion=True)
            return {"sequence": self._sequence_snapshot()}

        raise ValueError(f"Unsupported sequence action: {action}")

    def _get_connected_client(self) -> DobotClient:
        with self._lock:
            if not self._connected or self._session_client is None:
                raise RuntimeError("Connect to a robot first")
            return self._session_client

    def _ensure_three_ttt_osc_listener(self, listen_port: int, reached_address: str) -> None:
        if listen_port < 1 or listen_port > 65535:
            raise ValueError("OSC listen port must be between 1 and 65535")
        if not reached_address.startswith("/"):
            raise ValueError("OSC reached address must start with /")

        with self._three_ttt_osc_lock:
            self._three_ttt_osc_reached_addresses.update({reached_address.rstrip("/"), "/reached", "/3ttt/reached", "/3ttt/arrived"})
            if (
                self._three_ttt_osc_listener_thread
                and self._three_ttt_osc_listener_thread.is_alive()
                and self._three_ttt_osc_listen_port == listen_port
            ):
                return

            old_stop = self._three_ttt_osc_stop_event
            if old_stop is not None:
                old_stop.set()

            sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                sock.bind(("0.0.0.0", listen_port))
            except Exception:
                sock.close()
                raise
            sock.settimeout(0.25)

            stop_event = threading.Event()
            worker = threading.Thread(
                target=self._run_three_ttt_osc_listener,
                args=(sock, stop_event),
                daemon=True,
                name="dobot-3ttt-osc-listener",
            )
            self._three_ttt_osc_stop_event = stop_event
            self._three_ttt_osc_listener_thread = worker
            self._three_ttt_osc_listen_port = listen_port
            worker.start()

    def _run_three_ttt_osc_listener(self, sock: socket.socket, stop_event: threading.Event) -> None:
        try:
            while not stop_event.is_set():
                try:
                    data, address = sock.recvfrom(8192)
                except socket.timeout:
                    continue
                except OSError:
                    break

                try:
                    osc_address, args = unpack_osc_message(data)
                    self._record_three_ttt_osc_message(osc_address, args, address)
                except Exception as exc:  # noqa: BLE001 - keep listener alive and expose parse failures
                    with self._three_ttt_osc_lock:
                        self._three_ttt_osc_events[f"listener_error_{time.time_ns()}"] = {
                            "status": "error",
                            "message": f"OSC parse error: {exc}",
                            "received_at": time.time(),
                            "remote": f"{address[0]}:{address[1]}" if "address" in locals() else None,
                        }
        finally:
            try:
                sock.close()
            except OSError:
                pass

    def _record_three_ttt_osc_message(
        self,
        osc_address: str,
        args: list[Any],
        remote: tuple[str, int],
    ) -> None:
        arg_text = [str(arg) for arg in args]

        with self._three_ttt_osc_lock:
            reached_addresses = set(self._three_ttt_osc_reached_addresses)
            address_task_id = self._three_ttt_osc_address_tasks.get(osc_address)
            matched_reached_base = next(
                (
                    base for base in reached_addresses
                    if osc_address == base or osc_address.startswith(f"{base}/")
                ),
                None,
            )
            is_reached = bool(address_task_id or matched_reached_base)
            is_error = osc_address in {"/3ttt/error", "/3ttt/board/error"}
            if not is_reached and not is_error:
                return

            task_id: str | None = None
            board_name: str | None = None
            message = ""
            if address_task_id:
                task_id = address_task_id
                matched_address = next(
                    (address for address, candidate_task_id in self._three_ttt_osc_address_tasks.items() if address == osc_address and candidate_task_id == task_id),
                    None,
                )
                if matched_address:
                    board_name = matched_address.rsplit("/", 1)[-1]
            elif matched_reached_base and osc_address.startswith(f"{matched_reached_base}/"):
                board_name = osc_address[len(matched_reached_base):].strip("/")
                task_id = self._three_ttt_osc_board_tasks.get(board_name)
            if not task_id and arg_text:
                first = arg_text[0]
                if first.startswith("task"):
                    task_id = first
                    board_name = arg_text[1] if len(arg_text) > 1 else None
                    message = " ".join(arg_text[2:])
                else:
                    board_name = first
                    task_id = self._three_ttt_osc_board_tasks.get(board_name)
                    message = " ".join(arg_text[1:])

            if not task_id:
                task_id = f"unmatched_{time.time_ns()}"

            self._three_ttt_osc_events[task_id] = {
                "status": "error" if is_error else "reached",
                "task_id": task_id,
                "board_name": board_name,
                "message": message,
                "address": osc_address,
                "args": arg_text,
                "received_at": time.time(),
                "remote": f"{remote[0]}:{remote[1]}",
            }

    def three_ttt_osc_goto(self, payload: dict[str, Any]) -> dict[str, Any]:
        host = str(payload.get("host", "127.0.0.1")).strip()
        port = clamp_int(payload.get("port", 9000), 1, 65535, label="OSC send port")
        listen_port = clamp_int(payload.get("listen_port", 9001), 1, 65535, label="OSC listen port")
        goto_address = str(payload.get("goto_address", "/board")).strip()
        reached_address = str(payload.get("reached_address", "/reached")).strip()
        task_id = str(payload.get("task_id", "")).strip()
        board_name = str(payload.get("board_name", "")).strip()
        priority = clamp_int(payload.get("priority", 1), 1, 99, label="Priority")

        if not task_id:
            raise ValueError("Missing 3TTT task_id")
        if not board_name:
            raise ValueError("Missing 3TTT board_name")
        if not goto_address.startswith("/"):
            raise ValueError("OSC goto address must start with /")

        full_goto_address = osc_join_address(goto_address, board_name)
        full_reached_address = osc_join_address(reached_address, board_name)
        self._ensure_three_ttt_osc_listener(listen_port, reached_address)
        packet = pack_osc_message(full_goto_address, [])
        with self._three_ttt_osc_lock:
            self._three_ttt_osc_board_tasks[board_name] = task_id
            self._three_ttt_osc_address_tasks[full_reached_address] = task_id
            self._three_ttt_osc_events[task_id] = {
                "status": "pending",
                "task_id": task_id,
                "board_name": board_name,
                "address": full_goto_address,
                "reached_address": full_reached_address,
                "sent_at": time.time(),
                "target": f"{host}:{port}",
                "listen_port": listen_port,
                "priority": priority,
            }

        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.sendto(packet, (host, port))

        return {
            "sent": True,
            "task_id": task_id,
            "board_name": board_name,
            "address": full_goto_address,
            "reached_address": full_reached_address,
            "target": f"{host}:{port}",
            "listen_port": listen_port,
        }

    def get_three_ttt_osc_task(self, task_id: str) -> dict[str, Any]:
        with self._three_ttt_osc_lock:
            event = deepcopy(self._three_ttt_osc_events.get(task_id))
        return {"event": event}

    def _three_ttt_queue_snapshot_locked(self) -> dict[str, Any]:
        now = time.time()

        def format_entry(entry: dict[str, Any] | None) -> dict[str, Any] | None:
            if entry is None:
                return None
            formatted = deepcopy(entry)
            queued_at = formatted.get("queued_at")
            started_at = formatted.get("started_at")
            if isinstance(queued_at, (int, float)):
                formatted["queued_for"] = round(now - queued_at, 3)
            if isinstance(started_at, (int, float)):
                formatted["running_for"] = round(now - started_at, 3)
            return formatted

        return {
            "active": format_entry(self._three_ttt_active_turn),
            "pending": [format_entry(entry) for entry in self._three_ttt_turn_queue],
            "pending_count": len(self._three_ttt_turn_queue),
        }

    def get_three_ttt_queue(self) -> dict[str, Any]:
        with self._three_ttt_queue_condition:
            return {"queue": self._three_ttt_queue_snapshot_locked()}

    def acquire_three_ttt_turn(self, payload: dict[str, Any]) -> dict[str, Any]:
        task_id = str(payload.get("task_id", "")).strip()
        board_name = str(payload.get("board_name") or payload.get("board_id") or "").strip()
        board_id = str(payload.get("board_id", "")).strip()
        player_name = str(payload.get("player_name", "")).strip()
        cell = str(payload.get("cell", "")).strip()

        if not task_id:
            raise ValueError("Missing 3TTT queue task_id")
        if not board_name:
            raise ValueError("Missing 3TTT queue board_name")

        try:
            timeout = float(payload.get("timeout", 600))
        except (TypeError, ValueError) as exc:
            raise ValueError("3TTT queue timeout must be a number") from exc
        if not math.isfinite(timeout):
            raise ValueError("3TTT queue timeout must be finite")
        timeout = max(1.0, min(timeout, 900.0))

        queued_entry = {
            "task_id": task_id,
            "board_name": board_name,
            "board_id": board_id or board_name,
            "player_name": player_name,
            "cell": cell,
            "status": "queued",
            "queued_at": time.time(),
        }
        deadline = time.monotonic() + timeout

        with self._three_ttt_queue_condition:
            active = self._three_ttt_active_turn
            if active and active.get("task_id") == task_id:
                return {
                    "queue": {
                        "status": "active",
                        "task_id": task_id,
                        **self._three_ttt_queue_snapshot_locked(),
                    }
                }

            existing_entry = next(
                (entry for entry in self._three_ttt_turn_queue if entry.get("task_id") == task_id),
                None,
            )
            if existing_entry is None:
                self._three_ttt_turn_queue.append(queued_entry)
                self._three_ttt_queue_condition.notify_all()

            while True:
                is_front = bool(self._three_ttt_turn_queue) and self._three_ttt_turn_queue[0].get("task_id") == task_id
                if self._three_ttt_active_turn is None and is_front:
                    active_entry = self._three_ttt_turn_queue.pop(0)
                    active_entry["status"] = "active"
                    active_entry["started_at"] = time.time()
                    active_entry["waited_seconds"] = round(active_entry["started_at"] - active_entry["queued_at"], 3)
                    self._three_ttt_active_turn = active_entry
                    return {
                        "queue": {
                            "status": "active",
                            "task_id": task_id,
                            "waited_seconds": active_entry["waited_seconds"],
                            **self._three_ttt_queue_snapshot_locked(),
                        }
                    }

                still_queued = any(entry.get("task_id") == task_id for entry in self._three_ttt_turn_queue)
                if not still_queued:
                    raise RuntimeError("3TTT queue entry was cancelled")

                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    self._three_ttt_turn_queue = [
                        entry for entry in self._three_ttt_turn_queue if entry.get("task_id") != task_id
                    ]
                    self._three_ttt_queue_condition.notify_all()
                    raise TimeoutError("Timed out waiting for 3TTT robot queue")

                self._three_ttt_queue_condition.wait(timeout=min(remaining, 1.0))

    def release_three_ttt_turn(self, payload: dict[str, Any]) -> dict[str, Any]:
        task_id = str(payload.get("task_id", "")).strip()
        if not task_id:
            raise ValueError("Missing 3TTT queue task_id")

        with self._three_ttt_queue_condition:
            released = False
            cancelled = False
            active = self._three_ttt_active_turn
            if active and active.get("task_id") == task_id:
                self._three_ttt_active_turn = None
                released = True
            else:
                pending_before = len(self._three_ttt_turn_queue)
                self._three_ttt_turn_queue = [
                    entry for entry in self._three_ttt_turn_queue if entry.get("task_id") != task_id
                ]
                cancelled = len(self._three_ttt_turn_queue) != pending_before

            self._three_ttt_queue_condition.notify_all()
            return {
                "queue": {
                    "released": released,
                    "cancelled": cancelled,
                    **self._three_ttt_queue_snapshot_locked(),
                }
            }

    def perform_action(self, payload: dict[str, Any]) -> dict[str, Any]:
        action = str(payload.get("action", "")).strip()
        if not action:
            raise ValueError("Missing action")

        self._get_connected_client()
        client = self._command_client()
        if action == "power_on":
            response = self._dashboard_action(client.power_on)
            return {"response": serialize_response(response)}
        if action == "enable":
            return {"response": self._verified_mode_action(client, client.enable_robot, 5, "EnableRobot()")}
        if action == "disable":
            return {"response": self._verified_mode_action(client, client.disable_robot, 4, "DisableRobot()")}
        if action == "clear_error":
            response = self._dashboard_action(client.clear_error)
            return {"response": serialize_response(response)}
        if action == "continue_run":
            response = self._dashboard_action(client.continue_robot)
            return {"response": serialize_response(response)}
        if action == "start_drag":
            return {"response": self._verified_mode_action(client, client.start_drag, 6, "StartDrag()")}
        if action == "stop_drag":
            return {"response": self._verified_mode_action(client, client.stop_drag, 5, "StopDrag()")}
        if action == "recover":
            return {"response": self._recover_controller(client)}
        if action == "reset":
            response = self._dashboard_action(client.reset_robot)
            return {"response": serialize_response(response)}
        if action == "speed_factor":
            ratio = clamp_int(payload.get("ratio", 10), 1, 100, label="Speed ratio")
            response = self._dashboard_action(lambda: client.speed_factor(ratio))
            with self._lock:
                self._speed_ratio = ratio
            return {"response": serialize_response(response)}
        if action == "sync":
            return {"response": self._motion_sync_or_warning(client)}

        raise ValueError(f"Unsupported action: {action}")

    def jog_joint(self, payload: dict[str, Any]) -> dict[str, Any]:
        joint = clamp_int(payload.get("joint"), 1, 6, label="Joint")
        delta = float(payload.get("delta"))
        speedj = clamp_int(payload.get("speedj", 10), 1, 100, label="SpeedJ")
        accj = clamp_int(payload.get("accj", speedj), 1, 100, label="AccJ")
        sync = bool(payload.get("sync", True))

        self._get_connected_client()
        client = self._command_client()
        raw = client.rel_joint_movj(joint, delta, speedj=speedj, accj=accj)
        response = {
            "command": {
                "joint": joint,
                "delta": delta,
                "speedj": speedj,
                "accj": accj,
            },
            "response": {"ok": True, "raw": raw},
        }
        if sync:
            response["response"]["sync"] = self._motion_sync_or_warning(client)
        return response

    def move_joint_target(self, payload: dict[str, Any]) -> dict[str, Any]:
        joints_raw = payload.get("joints")
        if not isinstance(joints_raw, list) or len(joints_raw) != 6:
            raise ValueError("joints must be a list of 6 values")

        joints = [float(value) for value in joints_raw]
        speedj = clamp_int(payload.get("speedj", self._speed_ratio), 1, 100, label="SpeedJ")
        accj = clamp_int(payload.get("accj", speedj), 1, 100, label="AccJ")
        sync = bool(payload.get("sync", True))

        self._get_connected_client()
        client = self._command_client()
        raw = client.joint_movj(joints, speedj=speedj, accj=accj)
        response = {
            "motion": "JointMovJ",
            "joints": joints,
            "speedj": speedj,
            "accj": accj,
            "raw": raw,
        }
        if sync:
            response["sync"] = self._motion_sync_or_warning(client)
            self._wait_for_joint_target(joints)
            response["reached_target"] = True
        return {"response": response}

    def move_pose(self, payload: dict[str, Any], *, linear: bool) -> dict[str, Any]:
        pose = [
            float(payload["x"]),
            float(payload["y"]),
            float(payload["z"]),
            float(payload["rx"]),
            float(payload["ry"]),
            float(payload["rz"]),
        ]
        user = clamp_int(payload.get("user", 0), 0, 9, label="User frame")
        tool = clamp_int(payload.get("tool", 0), 0, 9, label="Tool frame")
        sync = bool(payload.get("sync", False))

        self._get_connected_client()
        client = self._command_client()
        if linear:
            speedl = clamp_int(payload.get("speedl", 10), 1, 100, label="SpeedL")
            accl = clamp_int(payload.get("accl", speedl), 1, 100, label="AccL")
            raw = client.movl(
                pose,
                user=user,
                tool=tool,
                speedl=speedl,
                accl=accl,
            )
            response = {
                "motion": "MovL",
                "pose": pose,
                "speedl": speedl,
                "accl": accl,
                "raw": raw,
            }
        else:
            speedj = clamp_int(payload.get("speedj", 10), 1, 100, label="SpeedJ")
            accj = clamp_int(payload.get("accj", speedj), 1, 100, label="AccJ")
            raw = client.movj(
                pose,
                user=user,
                tool=tool,
                speedj=speedj,
                accj=accj,
            )
            response = {
                "motion": "MovJ",
                "pose": pose,
                "speedj": speedj,
                "accj": accj,
                "raw": raw,
            }

        if sync:
            response["sync"] = self._motion_sync_or_warning(client)
            self._wait_for_pose_target(pose)
            response["reached_target"] = True
        return {"response": response}

    def raw_dashboard(self, payload: dict[str, Any]) -> dict[str, Any]:
        command = str(payload.get("command", "")).strip()
        if not command:
            raise ValueError("Missing dashboard command")

        self._get_connected_client()
        client = self._command_client()
        response = self._dashboard_action(lambda: client.dashboard(command))
        return {"response": serialize_response(response)}

    def raw_motion(self, payload: dict[str, Any]) -> dict[str, Any]:
        command = str(payload.get("command", "")).strip()
        if not command:
            raise ValueError("Missing motion command")

        self._get_connected_client()
        client = self._command_client()
        raw = client.motion(command)
        return {"response": {"ok": True, "raw": raw}}

    def get_servo_status(self, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        return self._servo.get_status(payload)

    def enable_servo(self) -> dict[str, Any]:
        return self._servo.enable()

    def disable_servo(self) -> dict[str, Any]:
        return self._servo.disable()

    def stop_servo(self) -> dict[str, Any]:
        return self._servo.stop()

    def reset_servo_fault(self) -> dict[str, Any]:
        return self._servo.reset_fault()

    def move_servo_position(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self._servo.move_position(payload)

    def move_servo_board(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self._servo.move_board(payload)

    @staticmethod
    def _dashboard_action(fn: Callable[[], Any], attempts: int = 3, delay_seconds: float = 0.12) -> Any:
        last_exc: Exception | None = None
        for attempt in range(attempts):
            try:
                return fn()
            except Exception as exc:  # noqa: BLE001 - retry transient controller misses
                last_exc = exc
                if attempt < attempts - 1:
                    time.sleep(delay_seconds)
        assert last_exc is not None
        raise last_exc

    def _verified_mode_action(
        self,
        client: DobotClient,
        fn: Callable[[], Any],
        expected_mode: int,
        command_name: str,
    ) -> dict[str, Any]:
        try:
            response = self._dashboard_action(fn, attempts=4)
            data = serialize_response(response)
            data["verified"] = False
            if data.get("ok"):
                self._last_state["robot_mode"] = {
                    "ok": True,
                    "error_id": 0,
                    "values": [str(expected_mode)],
                    "floats": [float(expected_mode)],
                    "echoed_command": "RobotMode();",
                    "raw": f"0,{{{expected_mode}}},RobotMode();",
                    "label": "RobotMode",
                    "reachable": True,
                    "stale": False,
                }
            return data
        except Exception as exc:
            mode = self._safe_dashboard_query(client, "RobotMode", client.robot_mode, attempts=4)
            if mode.get("floats") and int(mode["floats"][0]) == expected_mode:
                self._last_state["robot_mode"] = dict(mode)
                return {
                    "ok": True,
                    "error_id": 0,
                    "values": [str(expected_mode)],
                    "floats": [float(expected_mode)],
                    "echoed_command": command_name,
                    "raw": f"{command_name} verified by RobotMode={expected_mode}",
                    "verified": True,
                }
            try:
                feedback = client.feedback()
                if int(feedback.robot_mode) == expected_mode:
                    self._last_state["robot_mode"] = {
                        "ok": True,
                        "reachable": True,
                        "label": "RobotMode",
                        "stale": False,
                        "floats": [float(expected_mode)],
                        "values": [str(expected_mode)],
                        "raw": f"feedback:robot_mode={expected_mode}",
                    }
                    return {
                        "ok": True,
                        "error_id": 0,
                        "values": [str(expected_mode)],
                        "floats": [float(expected_mode)],
                        "echoed_command": command_name,
                        "raw": f"{command_name} verified by feedback RobotMode={expected_mode}",
                        "verified": True,
                    }
            except Exception:
                pass
            raise exc

    def _recover_controller(self, client: DobotClient) -> dict[str, Any]:
        steps: list[dict[str, Any]] = []
        previous_timeout = client.timeout_seconds
        client.timeout_seconds = min(previous_timeout, 1.2)
        recovery_steps = [
            ("ClearError", client.clear_error, 0.15),
            ("Continue", client.continue_robot, 0.2),
            ("PowerOn", client.power_on, 0.35),
            ("EnableRobot", client.enable_robot, 0.5),
        ]

        try:
            for label, fn, sleep_seconds in recovery_steps:
                try:
                    response = self._dashboard_action(fn, attempts=1)
                    steps.append({
                        "step": label,
                        "ok": True,
                        "raw": response.raw,
                    })
                except Exception as exc:  # noqa: BLE001 - expose controller recovery sequence
                    steps.append({
                        "step": label,
                        "ok": False,
                        "error": str(exc),
                    })
                time.sleep(sleep_seconds)

            state = self._probe_state(require_full_state=False, force_error_poll=True)
            return {
                "ok": state["connected"],
                "raw": "Recovery sequence complete",
                "steps": steps,
                "state": state,
            }
        finally:
            client.timeout_seconds = previous_timeout


class UiHandler(SimpleHTTPRequestHandler):
    server_version = "DOBOTUI/1.0"

    def __init__(self, *args: Any, directory: str | None = None, **kwargs: Any) -> None:
        super().__init__(*args, directory=str(STATIC_DIR), **kwargs)

    @property
    def service(self) -> ControlService:
        return self.server.control_service  # type: ignore[attr-defined]

    def log_message(self, format: str, *args: Any) -> None:
        return

    def _send_json(self, payload: dict[str, Any], *, status: HTTPStatus = HTTPStatus.OK) -> None:
        raw = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _send_csv(self, raw: bytes, filename: str) -> None:
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/csv; charset=utf-8")
        self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _send_sound_file(self, request_path: str) -> None:
        file_name = unquote(request_path.removeprefix("/sounds/"))
        sound_root = SOUNDS_DIR.resolve()
        sound_file = (sound_root / file_name).resolve()
        try:
            sound_file.relative_to(sound_root)
        except ValueError:
            self.send_error(HTTPStatus.NOT_FOUND, "Sound not found")
            return
        if not sound_file.is_file() or sound_file.suffix.lower() != ".mp3":
            self.send_error(HTTPStatus.NOT_FOUND, "Sound not found")
            return
        raw = sound_file.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "audio/mpeg")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length else b"{}"
        if not raw:
            return {}
        return json.loads(raw.decode("utf-8"))

    def do_GET(self) -> None:  # noqa: N802 - stdlib handler signature
        parsed = urlparse(self.path)
        if parsed.path == "/api/state":
            self._send_json({"ok": True, "state": self.service.get_state()})
            return
        if parsed.path == "/api/coffee/state":
            order_id = parse_qs(parsed.query).get("order_id", [None])[0]
            self._send_json({"ok": True, "coffee": self.service.get_coffee_state(order_id)})
            return
        if parsed.path == "/api/coffee/orders":
            self._send_json({"ok": True, **self.service.get_coffee_order_history()})
            return
        if parsed.path == "/api/coffee/orders/export":
            self._send_csv(self.service.export_coffee_order_history_csv(), "coffee-orders.csv")
            return
        if parsed.path == "/api/game-mappings":
            self._send_json({"ok": True, **load_all_game_mappings_from_disk()})
            return
        if parsed.path == "/api/game-mapping":
            game = parse_qs(parsed.query).get("game", [None])[0]
            self._send_json({"ok": True, **load_game_mapping_from_disk(game)})
            return
        if parsed.path == "/api/osc-c/state":
            self._send_json({"ok": True, **self.service.get_osc_c_state()})
            return
        if parsed.path == "/api/tictactoe/setup":
            self._send_json({"ok": True, **load_tictactoe_setup_from_disk()})
            return
        if parsed.path == "/api/3ttt/osc/task":
            task_id = parse_qs(parsed.query).get("task_id", [""])[0]
            self._send_json({"ok": True, **self.service.get_three_ttt_osc_task(task_id)})
            return
        if parsed.path == "/api/3ttt/queue":
            self._send_json({"ok": True, **self.service.get_three_ttt_queue()})
            return
        if parsed.path == "/api/servo/status":
            try:
                self._send_json({"ok": True, **self.service.get_servo_status()})
            except Exception as exc:  # noqa: BLE001 - return exact UI/API errors
                self._send_json(
                    {"ok": False, "error": str(exc)},
                    status=HTTPStatus.BAD_REQUEST,
                )
            return
        if parsed.path.startswith("/sounds/"):
            self._send_sound_file(parsed.path)
            return
        super().do_GET()

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def do_POST(self) -> None:  # noqa: N802 - stdlib handler signature
        try:
            payload = self._read_json()
            if self.path == "/api/config":
                result = self.service.update_config(payload)
            elif self.path == "/api/search":
                result = self.service.search_devices(payload)
            elif self.path == "/api/connect":
                result = self.service.connect(payload)
            elif self.path == "/api/disconnect":
                result = self.service.disconnect()
            elif self.path == "/api/action":
                result = self.service.perform_action(payload)
            elif self.path == "/api/jog-joint":
                result = self.service.jog_joint(payload)
            elif self.path == "/api/joint-movej":
                result = self.service.move_joint_target(payload)
            elif self.path == "/api/sequence":
                result = self.service.sequence_action(payload)
            elif self.path == "/api/osc-c/config":
                result = self.service.update_osc_c_config(payload)
            elif self.path == "/api/osc-c/action":
                result = self.service.osc_c_action(payload)
            elif self.path == "/api/osc-c/test":
                result = self.service.osc_c_test_message(payload)
            elif self.path == "/api/movej":
                result = self.service.move_pose(payload, linear=False)
            elif self.path == "/api/movel":
                result = self.service.move_pose(payload, linear=True)
            elif self.path == "/api/raw-dashboard":
                result = self.service.raw_dashboard(payload)
            elif self.path == "/api/raw-motion":
                result = self.service.raw_motion(payload)
            elif self.path == "/api/coffee/order":
                result = self.service.queue_coffee_order(payload)
            elif self.path == "/api/game-mapping":
                result = save_game_mapping_to_disk(payload)
            elif self.path == "/api/tictactoe/setup":
                result = save_tictactoe_setup_to_disk(payload)
            elif self.path == "/api/servo/status":
                result = self.service.get_servo_status(payload)
            elif self.path == "/api/servo/enable":
                result = self.service.enable_servo()
            elif self.path == "/api/servo/disable":
                result = self.service.disable_servo()
            elif self.path == "/api/servo/stop":
                result = self.service.stop_servo()
            elif self.path == "/api/servo/reset":
                result = self.service.reset_servo_fault()
            elif self.path == "/api/servo/move":
                result = self.service.move_servo_position(payload)
            elif self.path == "/api/servo/board":
                result = self.service.move_servo_board(payload)
            elif self.path == "/api/3ttt/osc/goto":
                result = self.service.three_ttt_osc_goto(payload)
            elif self.path == "/api/3ttt/queue/acquire":
                result = self.service.acquire_three_ttt_turn(payload)
            elif self.path == "/api/3ttt/queue/release":
                result = self.service.release_three_ttt_turn(payload)
            else:
                self._send_json(
                    {"ok": False, "error": f"Unknown endpoint: {self.path}"},
                    status=HTTPStatus.NOT_FOUND,
                )
                return
            self._send_json({"ok": True, **result})
        except Exception as exc:  # noqa: BLE001 - return exact UI/API errors
            self._send_json(
                {"ok": False, "error": str(exc)},
                status=HTTPStatus.BAD_REQUEST,
            )


def safe_print(message: str) -> None:
    try:
        print(message, flush=True)
    except Exception:  # noqa: BLE001 - stdout can be unavailable under pythonw.exe
        pass


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Launch the local DOBOT control UI")
    parser.add_argument("--listen", default=DEFAULT_UI_HOST, help="UI bind address")
    parser.add_argument("--port", type=int, default=DEFAULT_UI_PORT, help="UI bind port")
    parser.add_argument("--robot-host", default="192.168.0.110", help="Default robot controller IP")
    parser.add_argument("--dashboard-port", type=int, default=DEFAULT_DASHBOARD_PORT)
    parser.add_argument("--motion-port", type=int, default=DEFAULT_MOTION_PORT)
    parser.add_argument("--timeout", type=float, default=3.0)
    parser.add_argument("--open-browser", action="store_true", help="Open the UI in a browser tab")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    service = ControlService(
        ConnectionConfig(
            host=args.robot_host,
            dashboard_port=args.dashboard_port,
            motion_port=args.motion_port,
            timeout=args.timeout,
        )
    )

    handler = partial(UiHandler, directory=str(STATIC_DIR))
    with ThreadingHTTPServer((args.listen, args.port), handler) as server:
        server.control_service = service  # type: ignore[attr-defined]
        url = f"http://{args.listen}:{args.port}"
        safe_print(f"DOBOT UI listening on {url}")
        safe_print(f"Default robot host: {args.robot_host}")
        if args.open_browser:
            webbrowser.open(url)
        server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

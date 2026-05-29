#!/usr/bin/env python3
"""Minimal TCP/IP client for DOBOT Nova / CR series controllers.

This script targets the controller ports documented for DOBOT TCP/IP
secondary development:
  - 29999: dashboard / status / setup commands
  - 30003: motion commands

It is intentionally small and dependency-free so it can be used as a first
LAN control tool on a clean machine.
"""

from __future__ import annotations

import argparse
import socket
import sys
import threading
from dataclasses import dataclass
from typing import Iterable

import numpy as np


DEFAULT_DASHBOARD_PORT = 29999
DEFAULT_MOTION_PORT = 30003
DEFAULT_FEEDBACK_PORT = 30004
DEFAULT_TIMEOUT_SECONDS = 3.0
TCP_MODE_MISMATCH_TEXT = "Control mode is not TCP please change mode"

ROBOT_MODES = {
    1: "INIT",
    2: "BRAKE_OPEN",
    4: "DISABLED",
    5: "ENABLED",
    6: "BACKDRIVE",
    7: "RUNNING",
    8: "RECORDING",
    9: "ERROR",
    10: "PAUSED",
    11: "JOG",
}

FEEDBACK_PACKET_DTYPE = np.dtype([
    ("len", np.int64),
    ("digital_input_bits", np.uint64),
    ("digital_output_bits", np.uint64),
    ("robot_mode", np.uint64),
    ("time_stamp", np.uint64),
    ("time_stamp_reserve_bit", np.uint64),
    ("test_value", np.uint64),
    ("test_value_keep_bit", np.float64),
    ("speed_scaling", np.float64),
    ("linear_momentum_norm", np.float64),
    ("v_main", np.float64),
    ("v_robot", np.float64),
    ("i_robot", np.float64),
    ("i_robot_keep_bit1", np.float64),
    ("i_robot_keep_bit2", np.float64),
    ("tool_accelerometer_values", np.float64, (3,)),
    ("elbow_position", np.float64, (3,)),
    ("elbow_velocity", np.float64, (3,)),
    ("q_target", np.float64, (6,)),
    ("qd_target", np.float64, (6,)),
    ("qdd_target", np.float64, (6,)),
    ("i_target", np.float64, (6,)),
    ("m_target", np.float64, (6,)),
    ("q_actual", np.float64, (6,)),
    ("qd_actual", np.float64, (6,)),
    ("i_actual", np.float64, (6,)),
    ("actual_TCP_force", np.float64, (6,)),
    ("tool_vector_actual", np.float64, (6,)),
    ("TCP_speed_actual", np.float64, (6,)),
    ("TCP_force", np.float64, (6,)),
    ("Tool_vector_target", np.float64, (6,)),
    ("TCP_speed_target", np.float64, (6,)),
    ("motor_temperatures", np.float64, (6,)),
    ("joint_modes", np.float64, (6,)),
    ("v_actual", np.float64, (6,)),
    ("hand_type", np.byte, (4,)),
    ("user", np.byte),
    ("tool", np.byte),
    ("run_queued_cmd", np.byte),
    ("pause_cmd_flag", np.byte),
    ("velocity_ratio", np.byte),
    ("acceleration_ratio", np.byte),
    ("jerk_ratio", np.byte),
    ("xyz_velocity_ratio", np.byte),
    ("r_velocity_ratio", np.byte),
    ("xyz_acceleration_ratio", np.byte),
    ("r_acceleration_ratio", np.byte),
    ("xyz_jerk_ratio", np.byte),
    ("r_jerk_ratio", np.byte),
    ("brake_status", np.byte),
    ("enable_status", np.byte),
    ("drag_status", np.byte),
    ("running_status", np.byte),
    ("error_status", np.byte),
    ("jog_status", np.byte),
    ("robot_type", np.byte),
    ("drag_button_signal", np.byte),
    ("enable_button_signal", np.byte),
    ("record_button_signal", np.byte),
    ("reappear_button_signal", np.byte),
    ("jaw_button_signal", np.byte),
    ("six_force_online", np.byte),
    ("reserve2", np.byte, (82,)),
    ("m_actual", np.float64, (6,)),
    ("load", np.float64),
    ("center_x", np.float64),
    ("center_y", np.float64),
    ("center_z", np.float64),
    ("user_frame_actual", np.float64, (6,)),
    ("tool_frame_actual", np.float64, (6,)),
    ("trace_index", np.float64),
    ("six_force_value", np.float64, (6,)),
    ("target_quaternion", np.float64, (4,)),
    ("actual_quaternion", np.float64, (4,)),
    ("reserve3", np.byte, (24,)),
])

FEEDBACK_PACKET_SIZE = FEEDBACK_PACKET_DTYPE.itemsize


@dataclass
class DobotResponse:
    error_id: int
    values: list[str]
    echoed_command: str
    raw: str

    @property
    def ok(self) -> bool:
        return self.error_id == 0


@dataclass
class DobotFeedback:
    robot_mode: int
    q_actual: list[float]
    tool_vector_actual: list[float]
    enable_status: int
    error_status: int
    run_queued_cmd: int
    running_status: int
    raw_len: int


class DobotClient:
    def __init__(
        self,
        host: str,
        dashboard_port: int = DEFAULT_DASHBOARD_PORT,
        motion_port: int = DEFAULT_MOTION_PORT,
        feedback_port: int = DEFAULT_FEEDBACK_PORT,
        timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
        *,
        persistent: bool = False,
    ) -> None:
        self.host = host
        self.dashboard_port = dashboard_port
        self.motion_port = motion_port
        self.feedback_port = feedback_port
        self.timeout_seconds = timeout_seconds
        self.persistent = persistent
        self._dashboard_socket: socket.socket | None = None
        self._motion_socket: socket.socket | None = None
        self._dashboard_lock = threading.Lock()
        self._motion_lock = threading.Lock()

    def connect(self) -> None:
        if not self.persistent:
            return
        self._ensure_socket("dashboard")
        self._ensure_socket("motion")

    def close(self) -> None:
        self._reset_socket("dashboard")
        self._reset_socket("motion")

    def dashboard(self, command: str) -> DobotResponse:
        raw = self._send_and_receive(self.dashboard_port, command, expect_reply=True)
        return self._parse_dashboard_response(raw)

    def motion(self, command: str) -> str | None:
        raw = self._send_and_receive(self.motion_port, command, expect_reply=False)
        self._validate_motion_response(command, raw)
        return raw

    def power_on(self) -> DobotResponse:
        return self.dashboard("PowerOn()")

    def enable_robot(
        self,
        load: float | None = None,
        center: tuple[float, float, float] | None = None,
    ) -> DobotResponse:
        if load is None:
            command = "EnableRobot()"
        elif center is None:
            command = f"EnableRobot({format_number(load)})"
        else:
            x, y, z = center
            command = (
                f"EnableRobot({format_number(load)},{format_number(x)},"
                f"{format_number(y)},{format_number(z)})"
            )
        return self.dashboard(command)

    def disable_robot(self) -> DobotResponse:
        return self.dashboard("DisableRobot()")

    def clear_error(self) -> DobotResponse:
        return self.dashboard("ClearError()")

    def continue_robot(self) -> DobotResponse:
        return self.dashboard("Continue()")

    def start_drag(self) -> DobotResponse:
        return self.dashboard("StartDrag()")

    def stop_drag(self) -> DobotResponse:
        return self.dashboard("StopDrag()")

    def reset_robot(self) -> DobotResponse:
        return self.dashboard("ResetRobot()")

    def robot_mode(self) -> DobotResponse:
        return self.dashboard("RobotMode()")

    def get_pose(self) -> DobotResponse:
        return self.dashboard("GetPose()")

    def get_angle(self) -> DobotResponse:
        return self.dashboard("GetAngle()")

    def get_error_id(self) -> DobotResponse:
        return self.dashboard("GetErrorID()")

    def feedback(self) -> DobotFeedback:
        raw = self._read_feedback_packet()
        packet = np.frombuffer(raw, dtype=FEEDBACK_PACKET_DTYPE, count=1)[0]
        return DobotFeedback(
            robot_mode=int(packet["robot_mode"]),
            q_actual=[float(value) for value in packet["q_actual"]],
            tool_vector_actual=[float(value) for value in packet["tool_vector_actual"]],
            enable_status=int(packet["enable_status"]),
            error_status=int(packet["error_status"]),
            run_queued_cmd=int(packet["run_queued_cmd"]),
            running_status=int(packet["running_status"]),
            raw_len=len(raw),
        )

    def speed_factor(self, ratio: int) -> DobotResponse:
        return self.dashboard(f"SpeedFactor({ratio})")

    def speed_j(self, ratio: int) -> DobotResponse:
        return self.dashboard(f"SpeedJ({ratio})")

    def speed_l(self, ratio: int) -> DobotResponse:
        return self.dashboard(f"SpeedL({ratio})")

    def sync(self) -> str | None:
        return self.motion("Sync()")

    def movj(
        self,
        pose: Iterable[float],
        *,
        user: int = 0,
        tool: int = 0,
        speedj: int | None = None,
        accj: int | None = None,
    ) -> str | None:
        extras: list[str] = [f"User={user}", f"Tool={tool}"]
        if speedj is not None:
            extras.append(f"SpeedJ={speedj}")
        if accj is not None:
            extras.append(f"AccJ={accj}")
        command = make_pose_command("MovJ", pose, extras)
        return self.motion(command)

    def movl(
        self,
        pose: Iterable[float],
        *,
        user: int = 0,
        tool: int = 0,
        speedl: int | None = None,
        accl: int | None = None,
    ) -> str | None:
        extras: list[str] = [f"User={user}", f"Tool={tool}"]
        if speedl is not None:
            extras.append(f"SpeedL={speedl}")
        if accl is not None:
            extras.append(f"AccL={accl}")
        command = make_pose_command("MovL", pose, extras)
        return self.motion(command)

    def rel_joint_movj(
        self,
        joint: int,
        delta_degrees: float,
        *,
        speedj: int | None = None,
        accj: int | None = None,
    ) -> str | None:
        command = make_relative_joint_command(
            "RelJointMovJ",
            joint,
            delta_degrees,
            speedj=speedj,
            accj=accj,
        )
        return self.motion(command)

    def joint_movj(
        self,
        joints: Iterable[float],
        *,
        speedj: int | None = None,
        accj: int | None = None,
    ) -> str | None:
        command = make_joint_target_command(
            "JointMovJ",
            joints,
            speedj=speedj,
            accj=accj,
        )
        return self.motion(command)

    def _ensure_socket(self, channel: str) -> socket.socket:
        if channel == "dashboard":
            existing = self._dashboard_socket
            port = self.dashboard_port
        else:
            existing = self._motion_socket
            port = self.motion_port

        if existing is not None:
            return existing

        sock = socket.create_connection((self.host, port), timeout=self.timeout_seconds)
        sock.settimeout(self.timeout_seconds)
        if channel == "dashboard":
            self._dashboard_socket = sock
        else:
            self._motion_socket = sock
        return sock

    def _reset_socket(self, channel: str) -> None:
        attr = "_dashboard_socket" if channel == "dashboard" else "_motion_socket"
        sock = getattr(self, attr)
        setattr(self, attr, None)
        if sock is None:
            return
        try:
            sock.close()
        except OSError:
            pass

    def _send_and_receive(self, port: int, command: str, *, expect_reply: bool) -> str | None:
        message = command.strip()
        if not message.endswith(")"):
            raise ValueError(f"Command must end with ')': {command}")

        if self.persistent:
            channel = "dashboard" if port == self.dashboard_port else "motion"
            lock = self._dashboard_lock if channel == "dashboard" else self._motion_lock
            with lock:
                last_exc: OSError | None = None
                for attempt in range(2):
                    try:
                        sock = self._ensure_socket(channel)
                        sock.sendall(message.encode("ascii"))
                        try:
                            response = sock.recv(4096)
                        except socket.timeout:
                            return None if not expect_reply else ""
                        if response == b"":
                            if not expect_reply:
                                self._reset_socket(channel)
                                return None
                            raise ConnectionError("Socket closed by controller")
                        return response.decode("ascii", errors="replace").strip()
                    except OSError as exc:
                        last_exc = exc
                        self._reset_socket(channel)
                        if attempt == 0:
                            continue
                        raise
                if last_exc is not None:
                    raise last_exc
                raise RuntimeError("Failed to send command")

        with socket.create_connection((self.host, port), timeout=self.timeout_seconds) as sock:
            sock.settimeout(self.timeout_seconds)
            sock.sendall(message.encode("ascii"))

            try:
                response = sock.recv(4096)
            except socket.timeout:
                return None if not expect_reply else ""

        return response.decode("ascii", errors="replace").strip()

    def _read_feedback_packet(self) -> bytes:
        with socket.create_connection((self.host, self.feedback_port), timeout=self.timeout_seconds) as sock:
            sock.settimeout(self.timeout_seconds)
            data = bytearray()
            while len(data) < FEEDBACK_PACKET_SIZE:
                chunk = sock.recv(FEEDBACK_PACKET_SIZE - len(data))
                if not chunk:
                    raise RuntimeError("Feedback port closed before a full packet was received")
                data.extend(chunk)
            return bytes(data[:FEEDBACK_PACKET_SIZE])

    @staticmethod
    def _validate_motion_response(command: str, raw: str | None) -> None:
        if not raw:
            return
        if raw.startswith("-1,"):
            raise RuntimeError(f"Motion command rejected: {raw}")

    @staticmethod
    def _parse_dashboard_response(raw: str | None) -> DobotResponse:
        if not raw:
            raise RuntimeError("No response from dashboard port")
        if raw.startswith(TCP_MODE_MISMATCH_TEXT):
            raise RuntimeError("Controller is reachable but not in TCP/IP Secondary Development mode")

        fields = split_top_level_fields(raw, expected=3)
        if len(fields) != 3:
            raise RuntimeError(f"Unrecognized response format: {raw}")

        error_text, values_text, echoed = fields

        try:
            error_id = int(error_text)
        except ValueError as exc:
            raise RuntimeError(f"Invalid error code in response: {raw}") from exc

        values = parse_values(values_text)
        return DobotResponse(
            error_id=error_id,
            values=values,
            echoed_command=echoed,
            raw=raw,
        )


def parse_values(values_text: str) -> list[str]:
    if values_text == "{}":
        return []
    if values_text.startswith("{") and values_text.endswith("}"):
        inner = values_text[1:-1].strip()
        if not inner:
            return []
        return [part.strip() for part in inner.split(",")]
    return [values_text]


def split_top_level_fields(raw: str, expected: int) -> list[str]:
    fields: list[str] = []
    chunk: list[str] = []
    brace_depth = 0
    bracket_depth = 0
    paren_depth = 0

    for char in raw:
        if char == "," and brace_depth == 0 and bracket_depth == 0 and paren_depth == 0:
            fields.append("".join(chunk).strip())
            chunk = []
            if len(fields) == expected - 1:
                continue
            continue

        chunk.append(char)
        if char == "{":
            brace_depth += 1
        elif char == "}":
            brace_depth = max(0, brace_depth - 1)
        elif char == "[":
            bracket_depth += 1
        elif char == "]":
            bracket_depth = max(0, bracket_depth - 1)
        elif char == "(":
            paren_depth += 1
        elif char == ")":
            paren_depth = max(0, paren_depth - 1)

    if chunk:
        fields.append("".join(chunk).strip())
    return fields


def format_number(value: float) -> str:
    text = f"{value:.6f}".rstrip("0").rstrip(".")
    return text if text else "0"


def make_pose_command(name: str, pose: Iterable[float], extras: list[str]) -> str:
    pose_values = [format_number(value) for value in pose]
    if len(pose_values) != 6:
        raise ValueError("Pose must have 6 values: X Y Z Rx Ry Rz")
    return f"{name}({','.join(pose_values + extras)})"


def make_relative_joint_command(
    name: str,
    joint: int,
    delta_degrees: float,
    *,
    speedj: int | None = None,
    accj: int | None = None,
) -> str:
    if joint < 1 or joint > 6:
        raise ValueError("Joint index must be between 1 and 6")

    deltas = [0.0] * 6
    deltas[joint - 1] = delta_degrees
    extras: list[str] = []
    if speedj is not None:
        extras.append(f"SpeedJ={speedj}")
    if accj is not None:
        extras.append(f"AccJ={accj}")
    values = [format_number(value) for value in deltas]
    return f"{name}({','.join(values + extras)})"


def make_joint_target_command(
    name: str,
    joints: Iterable[float],
    *,
    speedj: int | None = None,
    accj: int | None = None,
) -> str:
    joint_values = [format_number(value) for value in joints]
    if len(joint_values) != 6:
        raise ValueError("Joint target must have 6 values")
    extras: list[str] = []
    if speedj is not None:
        extras.append(f"SpeedJ={speedj}")
    if accj is not None:
        extras.append(f"AccJ={accj}")
    return f"{name}({','.join(joint_values + extras)})"


def add_connection_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--host", required=True, help="Robot controller IP address")
    parser.add_argument(
        "--dashboard-port",
        type=int,
        default=DEFAULT_DASHBOARD_PORT,
        help=f"Dashboard port (default: {DEFAULT_DASHBOARD_PORT})",
    )
    parser.add_argument(
        "--motion-port",
        type=int,
        default=DEFAULT_MOTION_PORT,
        help=f"Motion port (default: {DEFAULT_MOTION_PORT})",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=DEFAULT_TIMEOUT_SECONDS,
        help=f"Socket timeout in seconds (default: {DEFAULT_TIMEOUT_SECONDS})",
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Control a DOBOT Nova 5 over LAN")
    subparsers = parser.add_subparsers(dest="command", required=True)

    connect = subparsers.add_parser("connect-test", help="Query robot mode, pose, and joints")
    add_connection_args(connect)

    power_on = subparsers.add_parser("power-on", help="Send PowerOn()")
    add_connection_args(power_on)

    enable = subparsers.add_parser("enable", help="Send EnableRobot()")
    add_connection_args(enable)
    enable.add_argument("--load", type=float, help="Payload weight in kg")
    enable.add_argument(
        "--center",
        type=float,
        nargs=3,
        metavar=("X", "Y", "Z"),
        help="Payload center offset in mm",
    )

    disable = subparsers.add_parser("disable", help="Send DisableRobot()")
    add_connection_args(disable)

    clear_error = subparsers.add_parser("clear-error", help="Send ClearError()")
    add_connection_args(clear_error)

    continue_run = subparsers.add_parser("continue-run", help="Send Continue()")
    add_connection_args(continue_run)

    reset = subparsers.add_parser("reset", help="Send ResetRobot()")
    add_connection_args(reset)

    speed = subparsers.add_parser("speed-factor", help="Set global speed factor")
    add_connection_args(speed)
    speed.add_argument("ratio", type=int, help="1-100")

    status = subparsers.add_parser("status", help="Print RobotMode(), GetPose(), GetAngle()")
    add_connection_args(status)

    raw_dashboard = subparsers.add_parser("raw-dashboard", help="Send a raw dashboard command")
    add_connection_args(raw_dashboard)
    raw_dashboard.add_argument("text", help="Example: GetPose()")

    raw_motion = subparsers.add_parser("raw-motion", help="Send a raw motion command")
    add_connection_args(raw_motion)
    raw_motion.add_argument("text", help="Example: Sync() or MovJ(...)")

    movej = subparsers.add_parser("movej", help="Send a MovJ command")
    add_connection_args(movej)
    add_pose_args(movej)
    movej.add_argument("--user", type=int, default=0)
    movej.add_argument("--tool", type=int, default=0)
    movej.add_argument("--speedj", type=int)
    movej.add_argument("--accj", type=int)
    movej.add_argument("--sync", action="store_true", help="Wait for move completion with Sync()")

    movel = subparsers.add_parser("movel", help="Send a MovL command")
    add_connection_args(movel)
    add_pose_args(movel)
    movel.add_argument("--user", type=int, default=0)
    movel.add_argument("--tool", type=int, default=0)
    movel.add_argument("--speedl", type=int)
    movel.add_argument("--accl", type=int)
    movel.add_argument("--sync", action="store_true", help="Wait for move completion with Sync()")

    jog_joint = subparsers.add_parser("jog-joint", help="Send a relative joint move command")
    add_connection_args(jog_joint)
    jog_joint.add_argument("--joint", type=int, required=True, help="Joint index 1-6")
    jog_joint.add_argument("--delta", type=float, required=True, help="Relative move in degrees")
    jog_joint.add_argument("--speedj", type=int)
    jog_joint.add_argument("--accj", type=int)
    jog_joint.add_argument("--sync", action="store_true", help="Wait for move completion with Sync()")

    return parser


def add_pose_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("x", type=float)
    parser.add_argument("y", type=float)
    parser.add_argument("z", type=float)
    parser.add_argument("rx", type=float)
    parser.add_argument("ry", type=float)
    parser.add_argument("rz", type=float)


def build_client(args: argparse.Namespace) -> DobotClient:
    return DobotClient(
        host=args.host,
        dashboard_port=args.dashboard_port,
        motion_port=args.motion_port,
        timeout_seconds=args.timeout,
    )


def print_response(label: str, response: DobotResponse) -> None:
    print(f"{label}: error_id={response.error_id} ok={response.ok}")
    if response.values:
        print(f"  values={response.values}")
    print(f"  raw={response.raw}")


def print_status(client: DobotClient) -> None:
    queries = [
        ("RobotMode", client.robot_mode, True),
        ("GetPose", client.get_pose, False),
        ("GetAngle", client.get_angle, False),
    ]
    had_success = False

    for label, fn, show_mode_name in queries:
        try:
            response = fn()
        except (OSError, RuntimeError, ValueError) as exc:
            print(f"{label}: ERROR: {exc}")
            continue

        had_success = True
        print_response(label, response)
        if show_mode_name and response.values:
            try:
                mode_number = int(float(response.values[0]))
                print(f"  mode_name={ROBOT_MODES.get(mode_number, 'UNKNOWN')}")
            except ValueError:
                pass

    if not had_success:
        raise RuntimeError("No dashboard commands succeeded")


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    client = build_client(args)

    try:
        if args.command == "connect-test":
            print_status(client)
            return 0
        if args.command == "power-on":
            print_response("PowerOn", client.power_on())
            return 0
        if args.command == "enable":
            center = tuple(args.center) if args.center else None
            print_response("EnableRobot", client.enable_robot(load=args.load, center=center))
            return 0
        if args.command == "disable":
            print_response("DisableRobot", client.disable_robot())
            return 0
        if args.command == "clear-error":
            print_response("ClearError", client.clear_error())
            return 0
        if args.command == "continue-run":
            print_response("Continue", client.continue_robot())
            return 0
        if args.command == "reset":
            print_response("ResetRobot", client.reset_robot())
            return 0
        if args.command == "speed-factor":
            print_response("SpeedFactor", client.speed_factor(args.ratio))
            return 0
        if args.command == "status":
            print_status(client)
            return 0
        if args.command == "raw-dashboard":
            print_response("Dashboard", client.dashboard(args.text))
            return 0
        if args.command == "raw-motion":
            raw = client.motion(args.text)
            print(f"Motion command sent. response={raw!r}")
            return 0
        if args.command == "movej":
            pose = [args.x, args.y, args.z, args.rx, args.ry, args.rz]
            raw = client.movj(
                pose,
                user=args.user,
                tool=args.tool,
                speedj=args.speedj,
                accj=args.accj,
            )
            print(f"MovJ sent. response={raw!r}")
            if args.sync:
                print(f"Sync response={client.sync()!r}")
            return 0
        if args.command == "movel":
            pose = [args.x, args.y, args.z, args.rx, args.ry, args.rz]
            raw = client.movel(
                pose,
                user=args.user,
                tool=args.tool,
                speedl=args.speedl,
                accl=args.accl,
            )
            print(f"MovL sent. response={raw!r}")
            if args.sync:
                print(f"Sync response={client.sync()!r}")
            return 0
        if args.command == "jog-joint":
            raw = client.rel_joint_movj(
                args.joint,
                args.delta,
                speedj=args.speedj,
                accj=args.accj,
            )
            print(f"RelJointMovJ sent. response={raw!r}")
            if args.sync:
                print(f"Sync response={client.sync()!r}")
            return 0
    except (OSError, RuntimeError, ValueError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    parser.error(f"Unhandled command: {args.command}")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())

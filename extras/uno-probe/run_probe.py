#!/usr/bin/env python3
import os
import subprocess
import sys
import time

import serial


PORT = os.environ.get("ALLOY_UNO_PORT", "/dev/cu.usbmodemF0F5BD509C002")
HOST_TIMEOUT_SECONDS = 240


def secret(name: str) -> str:
    output = subprocess.run(
        ["pass", "show", name], check=True, capture_output=True, text=True
    ).stdout
    lines = output.splitlines()
    if not lines:
        raise RuntimeError(f"password-store entry {name!r} is empty")
    return lines[0]


def validate_credentials(ssid: str, password: str) -> None:
    ssid_bytes = ssid.encode("utf-8")
    if not 1 <= len(ssid_bytes) <= 32:
        raise ValueError("SSID must be 1-32 UTF-8 bytes")
    if any(character in ssid for character in ("\x00", "\r", "\n", ",")):
        raise ValueError("SSID contains a character unsupported by the WiFiS3 serial protocol")

    if any(character in password for character in ("\x00", "\r", "\n", ",")):
        raise ValueError("password contains a character unsupported by the WiFiS3 serial protocol")
    if not all(32 <= ord(character) <= 126 for character in password):
        raise ValueError("password must contain printable ASCII only")
    if len(password) == 64:
        if any(character not in "0123456789abcdefABCDEF" for character in password):
            raise ValueError("a 64-character WPA2 key must be hexadecimal")
    elif not 8 <= len(password) <= 63:
        raise ValueError("WPA2 password must be 8-63 characters or 64 hexadecimal digits")


def open_serial_port() -> serial.Serial:
    deadline = time.monotonic() + 20
    while True:
        try:
            return serial.Serial(PORT, 115200, timeout=0.2, write_timeout=2)
        except serial.SerialException:
            if time.monotonic() >= deadline:
                raise
            time.sleep(0.5)


def send_line(port: serial.Serial, value: str) -> None:
    port.write((value + "\n").encode("utf-8"))
    port.flush()


def main() -> int:
    ssid = os.environ.get("ALLOY_UNO_WIFI_SSID") or secret("wifi/ssid")
    password = os.environ.get("ALLOY_UNO_WIFI_PASSWORD") or secret("wifi/pass")
    try:
        validate_credentials(ssid, password)
    except ValueError as error:
        print(f"HOST_CREDENTIAL_ERROR={error}", file=sys.stderr, flush=True)
        return 4

    port = open_serial_port()
    deadline = time.monotonic() + HOST_TIMEOUT_SECONDS
    sent_start = False
    sent_ssid = False
    sent_password = False

    try:
        # Native USB does not reset the Uno R4 when this port is opened. The
        # sketch may therefore have emitted READY_START before the host could
        # attach after an upload. Queue only the non-secret START token now;
        # SSID and password still wait for their explicit board prompts.
        send_line(port, "START")
        sent_start = True
        while time.monotonic() < deadline:
            line = port.readline().decode("utf-8", "replace").strip()
            if not line:
                continue
            print(line, flush=True)
            if line == "READY_START" and not sent_start:
                send_line(port, "START")
                sent_start = True
            elif line == "READY_SSID" and not sent_ssid:
                send_line(port, ssid)
                sent_ssid = True
            elif line == "READY_PASSWORD" and not sent_password:
                send_line(port, password)
                sent_password = True
                password = ""
            elif line.startswith("RESULT="):
                return 0 if line == "RESULT=PASS" else 2
    finally:
        password = ""
        port.close()

    print("HOST_TIMEOUT", flush=True)
    return 3


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
import os
import time
import json
import glob
import threading
import queue
import serial
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse

HOST = "0.0.0.0"
PORT = 8080

# Scanner / Drucker Settings
SCANNER_BAUD = 9600
PRINTER_BAUD = 19200

# Stabiler Match über by-id (wird automatisch gefunden)
SCANNER_MATCH = "FTDI_USB_Serial_Converter"
PRINTER_MATCH = "Silicon_Labs_CP2102"

# Fallback falls by-id nicht existiert (z.B. sehr früher Boot)
SCANNER_FALLBACK = "/dev/ttyUSB1"
PRINTER_FALLBACK = "/dev/ttyUSB0"

# Handshake:
# Scanner braucht meist nix, Drucker: DTR/DSR (dsrdtr=True). RTS/CTS meist NICHT nötig.
PRINTER_DSRDTR = True
PRINTER_RTSCTS = False

# Extra Feed: mehr Papier raus
EXTRA_NEWLINES = 8     # zusätzliche Leerzeilen am Ende
ESC_POS_FEED_LINES = 6 # ESC d n (Print and feed n lines)

clients_lock = threading.Lock()
clients = []  # list[queue.Queue[str]]

def broadcast(msg: str):
    with clients_lock:
        dead = []
        for q in clients:
            try:
                q.put_nowait(msg)
            except Exception:
                dead.append(q)
        for q in dead:
            try:
                clients.remove(q)
            except Exception:
                pass

def find_serial_by_id(match: str) -> str | None:
    paths = glob.glob("/dev/serial/by-id/*")
    for p in paths:
        if match in os.path.basename(p):
            return p
    return None

def resolve_ports():
    """Findet Ports stabil über by-id; fällt sonst auf ttyUSB* zurück."""
    scanner = find_serial_by_id(SCANNER_MATCH) or SCANNER_FALLBACK
    printer = find_serial_by_id(PRINTER_MATCH) or PRINTER_FALLBACK
    return scanner, printer

def clean_digits(s: str) -> str:
    return "".join(ch for ch in s if ch.isdigit())

def scanner_reader_thread():
    """Liest Scanner kontinuierlich und broadcastet EAN/Code an SSE."""
    while True:
        scanner_port, _ = resolve_ports()
        try:
            with serial.Serial(
                scanner_port,
                SCANNER_BAUD,
                bytesize=serial.EIGHTBITS,
                parity=serial.PARITY_NONE,
                stopbits=serial.STOPBITS_ONE,
                timeout=1,
            ) as ser:
                print(f"[bridge] Scanner OK: {scanner_port} @ {SCANNER_BAUD}")
                buf = ""
                while True:
                    data = ser.read(64)
                    if not data:
                        continue
                    s = data.decode("utf-8", errors="ignore")
                    buf += s

                    # Scanner sendet meist \r oder \n
                    while "\n" in buf or "\r" in buf:
                        parts = buf.replace("\r", "\n").split("\n")
                        buf = parts[-1]
                        for p in parts[:-1]:
                            code = clean_digits(p)
                            if not code:
                                continue
                            # akzeptiere EAN-8 oder EAN-13 (oder auch andere Zahlencodes)
                            print("[scan]", code)
                            broadcast(code)

        except Exception as e:
            print("[bridge] Scanner error:", e)
            time.sleep(1)

def escpos_wrap_text(text: str) -> bytes:
    """
    Drucker mag CP437 + CRLF.
    Extra: ESC d n für Feed + zusätzliche Leerzeilen.
    """
    # \n -> CRLF
    text = text.replace("\r\n", "\n").replace("\r", "\n").replace("\n", "\r\n")

    # encode CP437 (klassisch für ESC/POS)
    payload = text.encode("cp437", errors="replace")

    # Extra Leerzeilen
    payload += ("\r\n" * EXTRA_NEWLINES).encode("ascii")

    # ESC d n (Print and feed n lines)
    payload += bytes([0x1B, 0x64, int(ESC_POS_FEED_LINES) & 0xFF])

    # Abschluss nochmal CRLF
    payload += b"\r\n\r\n"
    return payload

def print_to_printer(text: str) -> tuple[bool, str]:
    """Schreibt direkt an den Bondrucker."""
    _, printer_port = resolve_ports()
    try:
        with serial.Serial(
            printer_port,
            PRINTER_BAUD,
            bytesize=serial.EIGHTBITS,
            parity=serial.PARITY_NONE,
            stopbits=serial.STOPBITS_ONE,
            timeout=2,
            dsrdtr=PRINTER_DSRDTR,
            rtscts=PRINTER_RTSCTS,
        ) as ser:
            print(f"[bridge] Printer OK: {printer_port} @ {PRINTER_BAUD}")
            data = escpos_wrap_text(text)
            ser.write(data)
            ser.flush()
        return True, printer_port
    except Exception as e:
        return False, f"{printer_port}: {e}"

class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)

        if parsed.path == "/events":
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            self.end_headers()

            q = queue.Queue(maxsize=200)
            with clients_lock:
                clients.append(q)

            try:
                self.wfile.write(b"event: hello\ndata: ready\n\n")
                self.wfile.flush()
            except Exception:
                pass

            try:
                while True:
                    msg = q.get()
                    payload = f"data: {msg}\n\n".encode("utf-8")
                    self.wfile.write(payload)
                    self.wfile.flush()
            except Exception:
                with clients_lock:
                    if q in clients:
                        clients.remove(q)
            return

        return super().do_GET()

    def do_POST(self):
        parsed = urlparse(self.path)

        if parsed.path == "/print":
            try:
                length = int(self.headers.get("Content-Length", "0"))
                raw = self.rfile.read(length) if length > 0 else b"{}"
                obj = json.loads(raw.decode("utf-8", errors="ignore"))
                text = str(obj.get("text", "")).strip()

                if not text:
                    self.send_response(400)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(json.dumps({"ok": False, "error": "empty text"}).encode("utf-8"))
                    return

                ok, info = print_to_printer(text)

                self.send_response(200 if ok else 500)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"ok": ok, "info": info}).encode("utf-8"))
                return
            except Exception as e:
                self.send_response(500)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"ok": False, "error": str(e)}).encode("utf-8"))
                return

        self.send_response(404)
        self.end_headers()

def main():
    os.chdir(os.path.dirname(os.path.abspath(__file__)))

    t = threading.Thread(target=scanner_reader_thread, daemon=True)
    t.start()

    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"[bridge] Web: http://{HOST}:{PORT}")
    httpd.serve_forever()

if __name__ == "__main__":
    main()

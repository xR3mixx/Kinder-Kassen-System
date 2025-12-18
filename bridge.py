#!/usr/bin/env python3
import os
import time
import json
import threading
import queue
import serial

from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse


# =========================
# CONFIG
# =========================
HOST = "0.0.0.0"
PORT = 8080

# Scanner (RS232/USB Adapter)
SCANNER_PORT = "/dev/ttyUSB0"
SCANNER_BAUD = 9600

# Drucker (USB/Serial, z.B. Partner RP-320)
PRINTER_PORT = "/dev/ttyUSB1"
PRINTER_BAUD = 19200

# Datei für Produkte (persistiert am Pi)
PRODUCTS_FILE = "products.json"

# Extra Papier-Vorlauf am Ende (Leerzeilen)
PRINTER_TRAILING_FEEDS = 6   # z.B. 6 Zeilen extra zum Abreißen

# Optional: Cut-Command (ESC/POS)
# Manche Drucker schneiden nicht über ESC/POS (oder nur bei Autocut ON).
ENABLE_ESC_POS_CUT = False


# =========================
# SSE CLIENTS
# =========================
clients_lock = threading.Lock()
clients = []  # list[queue.Queue[str]]


def broadcast(msg: str):
    """Sendet eine Nachricht an alle SSE-Clients (/events)."""
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


# =========================
# PRODUCTS (JSON helpers)
# =========================
products_lock = threading.Lock()


def load_products() -> dict:
    """Lädt products.json. Wenn nicht vorhanden -> {}"""
    with products_lock:
        try:
            with open(PRODUCTS_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except FileNotFoundError:
            return {}
        except Exception:
            # kaputte Datei? -> leeres dict
            return {}


def save_products(data: dict):
    """Speichert products.json sauber formatiert."""
    with products_lock:
        with open(PRODUCTS_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)


# =========================
# SCANNER SERIAL THREAD
# =========================
def serial_scanner_reader():
    """Liest Scanner-Serial und broadcastet Ziffern über SSE."""
    while True:
        try:
            with serial.Serial(
                SCANNER_PORT,
                SCANNER_BAUD,
                bytesize=serial.EIGHTBITS,
                parity=serial.PARITY_NONE,
                stopbits=serial.STOPBITS_ONE,
                timeout=1,
            ) as ser:
                print(f"[bridge] Scanner OK: {SCANNER_PORT} @ {SCANNER_BAUD}")
                buf = ""
                while True:
                    data = ser.read(64)
                    if not data:
                        continue

                    try:
                        s = data.decode("utf-8", errors="ignore")
                    except Exception:
                        continue

                    buf += s

                    # Scanner sendet meist CR/LF am Ende -> wir splitten an \r/\n
                    while "\n" in buf or "\r" in buf:
                        parts = buf.replace("\r", "\n").split("\n")
                        buf = parts[-1]  # Rest bleibt
                        for p in parts[:-1]:
                            ean = "".join(ch for ch in p if ch.isdigit())
                            if not ean:
                                continue
                            print("[scan]", ean)
                            broadcast(ean)

        except Exception as e:
            print("[bridge] Scanner error:", e)
            time.sleep(2)


# =========================
# PRINTER (queue + thread)
# =========================
printer_queue = queue.Queue()


def escpos_cut() -> bytes:
    # ESC i (full cut) ist bei vielen kompatiblen Geräten ok,
    # alternativ GS V 0 (0x1D 0x56 0x00)
    return b"\x1b\x69"


def normalize_crlf(text: str) -> bytes:
    # CRLF erzwingen
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = text.replace("\n", "\r\n")
    return text.encode("utf-8", errors="ignore")


def printer_worker():
    """Nimmt Print-Jobs aus printer_queue und schreibt sie an den Drucker."""
    while True:
        job = printer_queue.get()
        try:
            if job is None:
                continue

            payload_text = job.get("text", "")
            if not isinstance(payload_text, str):
                payload_text = str(payload_text)

            # extra feeds anhängen
            payload_text = payload_text + ("\r\n" * PRINTER_TRAILING_FEEDS)

            raw = normalize_crlf(payload_text)

            with serial.Serial(
                PRINTER_PORT,
                PRINTER_BAUD,
                bytesize=serial.EIGHTBITS,
                parity=serial.PARITY_NONE,
                stopbits=serial.STOPBITS_ONE,
                timeout=2,
                write_timeout=2,
                dsrdtr=True,   # DTR/DSR
                rtscts=False,
            ) as ser:
                print(f"[bridge] Printer OK: {PRINTER_PORT} @ {PRINTER_BAUD}")
                ser.write(raw)
                ser.flush()

                if ENABLE_ESC_POS_CUT:
                    try:
                        ser.write(escpos_cut())
                        ser.flush()
                    except Exception:
                        pass

            print("[print] done")

        except Exception as e:
            print("[bridge] Printer error:", e)
        finally:
            printer_queue.task_done()


# =========================
# HTTP HANDLER
# =========================
class Handler(SimpleHTTPRequestHandler):
    # Kein Cache (damit Updates sofort sichtbar sind)
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def _send_json(self, code: int, obj):
        raw = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        parsed = urlparse(self.path)

        # --- SSE events ---
        if parsed.path == "/events":
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            self.end_headers()

            q = queue.Queue(maxsize=200)
            with clients_lock:
                clients.append(q)

            # hello event
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

        # --- products.json via API ---
        if parsed.path == "/products":
            data = load_products()
            self._send_json(200, data)
            return

        # --- simple health ---
        if parsed.path == "/health":
            self._send_json(200, {"ok": True, "time": int(time.time())})
            return

        # sonst statische Dateien (index.html/app.js/styles.css/...)
        return super().do_GET()

    def do_POST(self):
        parsed = urlparse(self.path)
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length) if length > 0 else b""

        # --- save products ---
        if parsed.path == "/products":
            try:
                data = json.loads(body.decode("utf-8"))
                if not isinstance(data, dict):
                    return self._send_json(400, {"ok": False, "error": "products must be an object/dict"})
                save_products(data)
                return self._send_json(200, {"ok": True})
            except Exception as e:
                return self._send_json(500, {"ok": False, "error": str(e)})

        # --- print receipt ---
        # Erwartet JSON:
        # { "text": "..." }
        if parsed.path == "/print":
            try:
                data = json.loads(body.decode("utf-8"))
                if not isinstance(data, dict):
                    return self._send_json(400, {"ok": False, "error": "body must be JSON object"})
                if "text" not in data:
                    return self._send_json(400, {"ok": False, "error": "missing 'text'"})

                printer_queue.put({"text": str(data["text"])})
                return self._send_json(200, {"ok": True})
            except Exception as e:
                return self._send_json(500, {"ok": False, "error": str(e)})

        return self._send_json(404, {"ok": False, "error": "unknown endpoint"})


# =========================
# MAIN
# =========================
def main():
    os.chdir(os.path.dirname(os.path.abspath(__file__)))

    # Scanner Thread
    t_scan = threading.Thread(target=serial_scanner_reader, daemon=True)
    t_scan.start()

    # Printer Thread
    t_prn = threading.Thread(target=printer_worker, daemon=True)
    t_prn.start()

    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"[bridge] Web: http://{HOST}:{PORT}")
    print(f"[bridge] Scanner: {SCANNER_PORT} @ {SCANNER_BAUD}")
    print(f"[bridge] Printer: {PRINTER_PORT} @ {PRINTER_BAUD}")
    print(f"[bridge] products: {os.path.abspath(PRODUCTS_FILE)}")
    httpd.serve_forever()


if __name__ == "__main__":
    main()

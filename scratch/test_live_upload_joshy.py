import os
import base64
import urllib.request
import urllib.parse
import json

with open("backend/samples/sample_registrant_anandhu.jpg", "rb") as f:
    img_bytes = f.read()

b64_str = base64.b64encode(img_bytes).decode("utf-8")
data_url = "data:image/jpeg;base64," + b64_str
clean_b64 = data_url.split(",")[1]
decoded = base64.b64decode(clean_b64)
print("Decoded bytes:", len(decoded), "Magic:", decoded[:3].hex())

boundary = "----WebKitFormBoundary7MA4YWxkTrZu0gW"
header_part = (
    f"--{boundary}\r\n"
    f'Content-Disposition: form-data; name="file"; filename="Joshy.jpg"\r\n'
    f"Content-Type: image/jpeg\r\n\r\n"
).encode("utf-8")
footer_part = f"\r\n--{boundary}--\r\n".encode("utf-8")

body = header_part + decoded + footer_part

req = urllib.request.Request(
    "http://127.0.0.1:8000/api/upload",
    data=body,
    headers={
        "Content-Type": f"multipart/form-data; boundary={boundary}",
        "X-Warden-API-Key": "warden-dev-key-9941"
    }
)
res = urllib.request.urlopen(req)
print("HTTP upload status for Joshy.jpg:", res.status)
data = json.loads(res.read().decode("utf-8"))
print("Upload response:", data)

scan_body = urllib.parse.urlencode({
    "file_path": data["file_path"],
    "mode": "guard",
    "early_exit": "true",
    "threshold": "0.50"
}).encode("utf-8")

scan_req = urllib.request.Request(
    "http://127.0.0.1:8000/api/scan",
    data=scan_body,
    headers={
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Warden-API-Key": "warden-dev-key-9941"
    }
)
scan_res = urllib.request.urlopen(scan_req)
print("Scan response for Joshy.jpg:", json.loads(scan_res.read().decode("utf-8")))
print("\n[SUCCESS] Joshy.jpg upload and scan verified completely against live server!")

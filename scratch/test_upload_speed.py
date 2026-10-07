import time
import requests

video_path = "backend/samples/sample_unauthorized_video.mp4"
headers = {"X-Warden-API-Key": "warden-dev-key-9941"}

with open(video_path, "rb") as f:
    files = {"file": ("video.mp4", f, "video/mp4")}
    t0 = time.perf_counter()
    res = requests.post("http://127.0.0.1:8000/api/upload", files=files, headers=headers)
    dt = (time.perf_counter() - t0) * 1000

print(f"Status: {res.status_code} in {dt:.2f}ms")
data = res.json()
print("Staged path:", data.get("file_path"))
print("Content type:", data.get("content_type"))

# Now test direct scan of staged file
staged_path = data.get("file_path")
t1 = time.perf_counter()
scan_form = {
    "file_path": staged_path,
    "mode": "guard",
    "threshold": 0.50,
    "early_exit": True
}
scan_res = requests.post("http://127.0.0.1:8000/api/scan", data=scan_form, headers=headers)
dt_scan = (time.perf_counter() - t1) * 1000
print(f"Scan verdict: {scan_res.json().get('verdict')} in {dt_scan:.2f}ms")

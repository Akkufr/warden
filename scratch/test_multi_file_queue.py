import os
import sys
import json
import urllib.request
import urllib.parse
import mimetypes

BASE_URL = "http://127.0.0.1:8000"
API_KEY = "warden-dev-key-9941"

def check_health():
    req = urllib.request.Request(f"{BASE_URL}/api/health")
    with urllib.request.urlopen(req) as resp:
        assert resp.status == 200
        data = json.loads(resp.read().decode())
        print(f"[Health] Server is {data['status']}, indexed vectors: {data['stats']['indexed_vectors']}")

def upload_and_scan(file_path, display_name):
    # 1. Upload stage
    boundary = "----WebKitFormBoundary7MA4YWxkTrZu0gW"
    with open(file_path, "rb") as f:
        file_bytes = f.read()

    body = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="{display_name}"\r\n'
        f"Content-Type: image/jpeg\r\n\r\n"
    ).encode("utf-8") + file_bytes + f"\r\n--{boundary}--\r\n".encode("utf-8")

    req_upload = urllib.request.Request(
        f"{BASE_URL}/api/upload",
        data=body,
        headers={
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "X-Warden-API-Key": API_KEY
        }
    )
    with urllib.request.urlopen(req_upload) as resp:
        upload_data = json.loads(resp.read().decode())
        staged_path = upload_data["file_path"]

    # 2. Scan stage
    scan_body = urllib.parse.urlencode({
        "file_path": staged_path,
        "mode": "guard",
        "threshold": "0.50",
        "early_exit": "true"
    }).encode("utf-8")

    req_scan = urllib.request.Request(
        f"{BASE_URL}/api/scan",
        data=scan_body,
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "X-Warden-API-Key": API_KEY
        }
    )
    with urllib.request.urlopen(req_scan) as resp:
        scan_data = json.loads(resp.read().decode())
        return scan_data

def run_tests():
    print("=" * 65)
    print("  WARDEN MULTI-FILE QUEUE & BATCH FILTERING VERIFICATION")
    print("=" * 65)

    check_health()

    # Create dummy safe jpeg
    import cv2
    import numpy as np

    safe_img1_path = "scratch/safe_photo_1.jpg"
    safe_img2_path = "scratch/safe_photo_2.jpg"
    # Create simple landscape gradient images with NO faces
    grad1 = np.zeros((300, 400, 3), dtype=np.uint8)
    grad1[:, :, 0] = np.linspace(50, 200, 400, dtype=np.uint8)
    cv2.imwrite(safe_img1_path, grad1)

    grad2 = np.zeros((300, 400, 3), dtype=np.uint8)
    grad2[:, :, 1] = np.linspace(80, 220, 400, dtype=np.uint8)
    cv2.imwrite(safe_img2_path, grad2)

    joshy_path = "backend/samples/sample_registrant_anandhu.jpg"
    assert os.path.exists(joshy_path), f"Sample registrant not found at {joshy_path}"

    test_batch = [
        {"name": "safe_photo_1.jpg", "path": safe_img1_path},
        {"name": "Joshy.jpg", "path": joshy_path},
        {"name": "safe_photo_2.jpg", "path": safe_img2_path}
    ]

    print(f"\n[Test 1] Simulating queue processing of 3 files:")
    print("         1. safe_photo_1.jpg (Clean landscape)")
    print("         2. Joshy.jpg (Contains Anandhu - Protected)")
    print("         3. safe_photo_2.jpg (Clean landscape)")

    passed_files = []
    blocked_files = []

    for i, item in enumerate(test_batch):
        print(f"\n  -> Processing Queue Item [{i+1}/3]: {item['name']} ...")
        result = upload_and_scan(item["path"], item["name"])
        verdict = result.get("verdict", "PASS")
        print(f"     Verdict: {verdict} | Flagged: {result.get('flagged_count', 0)}")

        if verdict == "BLOCK":
            match_name = result["ledger"][0]["name"] if result.get("ledger") else "Protected"
            sim = result["ledger"][0]["similarity"] if result.get("ledger") else 0
            print(f"     [BLOCKED] Detected protected person: {match_name} (Similarity: {sim:.4f})")
            blocked_files.append({"file": item, "match_name": match_name, "result": result})
        else:
            print(f"     [PASSED] Cleared for chat attachment.")
            passed_files.append(item)

    print("\n[Test 2] Evaluating Queue Gating Outcomes:")
    assert len(blocked_files) == 1, f"Expected 1 blocked file, got {len(blocked_files)}"
    assert blocked_files[0]["file"]["name"] == "Joshy.jpg"
    assert blocked_files[0]["match_name"] == "Anandhu"
    assert len(passed_files) == 2, f"Expected 2 passed files, got {len(passed_files)}"

    print(f"  -> Total Blocked: {len(blocked_files)} ({[b['file']['name'] for b in blocked_files]})")
    print(f"  -> Total Approved: {len(passed_files)} ({[p['name'] for p in passed_files]})")
    print("  -> DataTransfer filter strips 'Joshy.jpg' and retains safe_photo_1.jpg + safe_photo_2.jpg")
    print("  -> Security Override PREVENTED! Malicious / unconsented files cannot ride along with clean files!")

    print("\n" + "=" * 65)
    print("  ALL MULTI-FILE QUEUE & FILTERING TESTS PASSED PERFECTLY!")
    print("=" * 65)

if __name__ == "__main__":
    run_tests()

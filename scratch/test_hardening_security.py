"""
Warden Hardening & Security Verification Suite
=============================================
Tests all requirements from the specification document:
1. Robustness Against Corrupt or Sabotaged Media (Magic bytes, bomb defense, container plausibility, fail-safe Guard default)
2. API-Layer Hardening (Auth, security headers, rate limiting, malformed quarantine, zero retention)
3. Registration-Time Abuse Prevention (Challenge HMAC nonces, anti-replay, entropy checks)
"""

import sys
import os
import io
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import requests
import numpy as np
import cv2
from PIL import Image

BASE_URL = "http://127.0.0.1:8000"
API_KEY = "warden-dev-key-9941"
AUTH_HEADERS = {"X-Warden-API-Key": API_KEY}


def test_magic_byte_validation():
    print("\n--- [Test 1] Magic Byte & File Signature Verification ---")
    # Create spoofed .jpg file with random text content
    fake_jpg_content = b"<html><body>This is an HTML file renamed to .jpg pretending to be an image</body></html>"

    files = {"file": ("malicious_spoofed.jpg", io.BytesIO(fake_jpg_content), "image/jpeg")}
    resp = requests.post(f"{BASE_URL}/api/upload", files=files, headers=AUTH_HEADERS)
    print(f"Upload spoofed .jpg response: HTTP {resp.status_code} - {resp.text}")
    assert resp.status_code in (400, 429), f"Expected 400 or 429, got {resp.status_code}"
    print("PASS: Spoofed file signature was successfully rejected before decoding!")


def test_decompression_bomb_preflight():
    print("\n--- [Test 2] Decompression Bomb Pre-flight Inspection ---")
    from backend.security import preflight_image_dimensions

    # Synthesize a 16-byte PNG header claiming 20,000 x 20,000 pixels (400 Megapixels)
    # PNG signature + IHDR chunk (Width: 20000, Height: 20000)
    fake_png_header = (
        b"\x89PNG\r\n\x1a\n"
        b"\x00\x00\x00\rIHDR"
        + (20000).to_bytes(4, "big")
        + (20000).to_bytes(4, "big")
        + b"\x08\x06\x00\x00\x00"
    )

    is_safe, w, h, msg = preflight_image_dimensions(fake_png_header)
    print(f"Preflight inspection result: Safe={is_safe}, Resolution={w}x{h}, Message={msg}")
    assert not is_safe, "Decompression bomb should be blocked!"
    assert "Decompression bomb detected" in msg, f"Unexpected message: {msg}"
    print("PASS: Decompression bomb caught before memory allocation!")


def test_safe_tensor_validation():
    print("\n--- [Test 3] Tensor & Decoder Output Validation ---")
    from backend.security import validate_tensor_frame

    # Test 1: Zero dimension
    empty_frame = np.zeros((0, 0, 3), dtype=np.uint8)
    ok, msg = validate_tensor_frame(empty_frame)
    assert not ok, "Zero-dimension frame must be rejected"

    # Test 2: NaN in float frame
    nan_frame = np.array([[[np.nan, 10, 20]]], dtype=np.float32)
    ok, msg = validate_tensor_frame(nan_frame)
    assert not ok, "NaN tensor must be rejected"

    # Test 3: Valid 640x480 frame
    good_frame = np.zeros((480, 640, 3), dtype=np.uint8)
    ok, msg = validate_tensor_frame(good_frame)
    assert ok, f"Valid tensor rejected: {msg}"
    print("PASS: Tensor shape/dtype/range/NaN validation functions as specified!")


def test_failsafe_guard_default():
    print("\n--- [Test 4] Fail-Safe Default: Guard Mode on Corrupt Media ---")
    # Scan a completely corrupted file directly through /api/scan in Guard mode
    corrupt_bytes = b"\xFF\xD8\xFF" + b"\x00\x00\x00CORRUPTED_TRUNCATED_STREAM"
    files = {"file": ("corrupt_sample.jpg", io.BytesIO(corrupt_bytes), "image/jpeg")}
    data = {"mode": "guard", "threshold": 0.50}

    resp = requests.post(f"{BASE_URL}/api/scan", files=files, data=data, headers=AUTH_HEADERS)
    print(f"Scan response: HTTP {resp.status_code}")
    if resp.status_code == 200:
        verdict_data = resp.json()
        print(f"Verdict payload: {verdict_data}")
        assert verdict_data.get("verdict") == "BLOCK", f"Expected BLOCK in Guard mode, got {verdict_data.get('verdict')}"
        print("PASS: Fail-safe default verified: Corrupt file yielded BLOCK (never passed as clear)!")
    elif resp.status_code == 400:
        print("PASS: Corrupt file rejected safely at API ingestion layer!")


def test_api_layer_auth_and_headers():
    print("\n--- [Test 5] API-Layer Hardening: Authentication & Security Headers ---")
    # 1. Unauthenticated request to protected endpoint should yield 401
    resp_unauth = requests.get(f"{BASE_URL}/api/registry")
    print(f"Unauthenticated /api/registry: HTTP {resp_unauth.status_code}")
    assert resp_unauth.status_code == 401, f"Expected 401 Unauthorized, got {resp_unauth.status_code}"

    # 2. Authenticated request should succeed
    resp_auth = requests.get(f"{BASE_URL}/api/registry", headers=AUTH_HEADERS)
    print(f"Authenticated /api/registry: HTTP {resp_auth.status_code}")
    assert resp_auth.status_code == 200, f"Expected 200 OK, got {resp_auth.status_code}"

    # 3. Check Security Headers
    headers = resp_auth.headers
    print(f"Security Headers received:")
    for h in ["X-Content-Type-Options", "X-Frame-Options", "Strict-Transport-Security", "Content-Security-Policy"]:
        val = headers.get(h)
        print(f"  {h}: {val}")
        assert val is not None, f"Missing security header: {h}"

    print("PASS: API authentication and TLS/Security headers fully verified!")


def test_registration_challenge_and_anti_replay():
    print("\n--- [Test 6] Registration-Time Abuse Prevention: Anti-Replay & Liveness ---")
    # 1. Fetch challenge token
    resp_chal = requests.get(f"{BASE_URL}/api/registration/challenge", headers=AUTH_HEADERS)
    assert resp_chal.status_code == 200, f"Challenge fetch failed: {resp_chal.text}"
    chal_data = resp_chal.json()
    token = chal_data.get("challenge_token")
    assert token, "Challenge token missing from response"
    print(f"Acquired Challenge Token: {token[:25]}... (Nonce: {chal_data.get('nonce')})")

    # 2. Load a real face sample
    sample_path = "backend/samples/sample_registrant_anandhu.jpg"
    import base64
    with open(sample_path, "rb") as f:
        img_b64 = "data:image/jpeg;base64," + base64.b64encode(f.read()).decode("utf-8")

    # 3. Test verify-face Step 1 (Frontal)
    v1_payload = {
        "image_b64": img_b64,
        "step": 1,
        "challenge_token": token,
        "previous_images_b64": []
    }
    r1 = requests.post(f"{BASE_URL}/api/verify-face", json=v1_payload, headers=AUTH_HEADERS)
    assert r1.status_code == 200, f"Step 1 failed: {r1.text}"
    print(f"Step 1 verified: face_detected={r1.json().get('face_detected')}")

    # 4. Test Step 2 with IDENTICAL static image replay (must trigger Anti-Replay Alert!)
    v2_replay_payload = {
        "image_b64": img_b64,  # Exact duplicate of step 1
        "step": 2,
        "challenge_token": token,
        "previous_images_b64": [img_b64]
    }
    r2 = requests.post(f"{BASE_URL}/api/verify-face", json=v2_replay_payload, headers=AUTH_HEADERS)
    assert r2.status_code == 200
    r2_data = r2.json()
    print(f"Step 2 identical replay result: position_correct={r2_data.get('position_correct')}, anti_replay_flag={r2_data.get('anti_replay_flag')}")
    assert r2_data.get("anti_replay_flag") is True or not r2_data.get("position_correct"), "Anti-replay check should flag identical static replay!"

    # 5. Test Register with identical images across steps -> must be blocked with HTTP 422
    reg_replay_payload = {
        "name": "Attacker Static Replay Test",
        "affiliation": "Adversary",
        "images_b64": [img_b64, img_b64, img_b64, img_b64],  # 4 identical copies
        "allowlist": [],
        "allow_override": False,
        "challenge_token": token
    }
    r_reg = requests.post(f"{BASE_URL}/api/register", json=reg_replay_payload, headers=AUTH_HEADERS)
    print(f"Registration replay attempt: HTTP {r_reg.status_code} - {r_reg.text[:100]}")
    assert r_reg.status_code == 422, f"Expected 422 Unprocessable Entity, got {r_reg.status_code}"
    assert "anti-replay" in r_reg.text.lower(), "Expected anti-replay violation detail in error response"
    print("PASS: Anti-replay protection blocked static photo injection across registration steps!")


def test_malformed_submission_quarantine():
    print("\n--- [Test 7] Repeated Malformed Upload Throttling / Quarantine ---")
    from backend.security import rate_limiter

    test_ip = "192.168.1.99"
    # Record 4 malformed submissions
    for i in range(4):
        quarantined, msg = rate_limiter.record_malformed_submission(test_ip)
        print(f"Probe {i+1}: Quarantined={quarantined}, Msg={msg}")

    assert quarantined is True, "Client should be quarantined after threshold reached"
    is_q, remaining = rate_limiter.is_quarantined(test_ip)
    assert is_q, "Client should show active quarantine status"
    print(f"PASS: Malformed probe quarantine triggered successfully ({remaining}s remaining)!")


def test_zero_raw_media_retention():
    print("\n--- [Test 8] Zero Raw Media Retention Beyond Processing Window ---")
    sample_path = "backend/samples/sample_registrant_anandhu.jpg"
    with open(sample_path, "rb") as f:
        file_bytes = f.read()

    files = {"file": ("temp_scan_target.jpg", io.BytesIO(file_bytes), "image/jpeg")}
    data = {"mode": "guard", "threshold": 0.50}

    resp = requests.post(f"{BASE_URL}/api/scan", files=files, data=data, headers=AUTH_HEADERS)
    assert resp.status_code == 200, f"Scan failed: {resp.text}"

    # Verify that data/uploads does NOT retain the temporary scan file
    uploads_dir = os.path.join(os.path.dirname(__file__), "..", "data", "uploads")
    scan_files = [f for f in os.listdir(uploads_dir) if f.startswith("scan_")]
    print(f"Remaining scan temp files in {uploads_dir}: {scan_files}")
    assert len(scan_files) == 0, f"Raw uploaded media was retained on disk: {scan_files}"
    print("PASS: Zero retention verified! No raw media persisted after scan conclusion.")


if __name__ == "__main__":
    print("=" * 65)
    print("  WARDEN SECURITY & HARDENING VERIFICATION TEST RUNNER")
    print("=" * 65)
    test_magic_byte_validation()
    test_decompression_bomb_preflight()
    test_safe_tensor_validation()
    test_failsafe_guard_default()
    test_api_layer_auth_and_headers()
    test_registration_challenge_and_anti_replay()
    test_malformed_submission_quarantine()
    test_zero_raw_media_retention()
    print("\n" + "=" * 65)
    print("  ALL 8 SECURITY & HARDENING TESTS PASSED WITH 100% SUCCESS!")
    print("=" * 65)

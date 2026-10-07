import base64
import cv2
import numpy as np
import requests

BASE_URL = "http://127.0.0.1:8000"

def run_tests():
    print("=" * 60)
    print("RUNNING AUTOMATED VERIFICATION OF NEW CAPABILITIES")
    print("=" * 60)

    # 1. Load sample frontal face
    sample_path = "backend/samples/sample_registrant_anandhu.jpg"
    img = cv2.imread(sample_path)
    assert img is not None, f"Failed to load {sample_path}"

    _, buf = cv2.imencode(".jpg", img)
    b64_frontal = base64.b64encode(buf).decode("utf-8")

    # ----------------------------------------------------
    # TEST 1: Orientation & Pose Detection via /api/verify-face
    # ----------------------------------------------------
    print("\n--- TEST 1: Step Pose & Orientation Verification ---")
    
    # Step 1: Frontal Neutral (should pass for frontal image)
    r1 = requests.post(f"{BASE_URL}/api/verify-face", json={"image_b64": b64_frontal, "step": 1})
    d1 = r1.json()
    print(f"Step 1 (Frontal Neutral): status={r1.status_code}, pos_correct={d1.get('position_correct')}, guidance='{d1.get('guidance')}'")
    assert r1.status_code == 200
    assert d1.get("position_correct") is True, f"Expected step 1 to pass: {d1}"

    # Step 2: Left Turn/Tilt requested (frontal image should be rejected with left guidance)
    r2 = requests.post(f"{BASE_URL}/api/verify-face", json={"image_b64": b64_frontal, "step": 2})
    d2 = r2.json()
    print(f"Step 2 with Frontal img: pos_correct={d2.get('position_correct')}, guidance='{d2.get('guidance')}'")
    assert d2.get("position_correct") is False
    assert "LEFT" in d2.get("guidance", "").upper()

    # Step 3: Right Turn/Tilt requested (frontal image should be rejected with right guidance)
    r3 = requests.post(f"{BASE_URL}/api/verify-face", json={"image_b64": b64_frontal, "step": 3})
    d3 = r3.json()
    print(f"Step 3 with Frontal img: pos_correct={d3.get('position_correct')}, guidance='{d3.get('guidance')}'")
    assert d3.get("position_correct") is False
    assert "RIGHT" in d3.get("guidance", "").upper()

    # Step 4: Smiling Expression requested (smiling image should pass with high smile percent)
    r4 = requests.post(f"{BASE_URL}/api/verify-face", json={"image_b64": b64_frontal, "step": 4})
    d4 = r4.json()
    print(f"Step 4 with Smiling img: pos_correct={d4.get('position_correct')}, guidance='{d4.get('guidance')}', smile={d4.get('smile_percent')}%")
    assert d4.get("position_correct") is True, f"Expected smiling image to pass Step 4: {d4}"
    assert d4.get("smile_percent", 0) >= 50, f"Expected smile percent >= 50: {d4}"

    # Synthesize left tilt (~12 degrees rotation)
    h, w = img.shape[:2]
    M_left = cv2.getRotationMatrix2D((w/2, h/2), 12, 1.0)
    img_left = cv2.warpAffine(img, M_left, (w, h))
    _, buf_left = cv2.imencode(".jpg", img_left)
    b64_left = base64.b64encode(buf_left).decode("utf-8")

    r2_tilt = requests.post(f"{BASE_URL}/api/verify-face", json={"image_b64": b64_left, "step": 2})
    d2_tilt = r2_tilt.json()
    print(f"Step 2 with Left Tilt img: pos_correct={d2_tilt.get('position_correct')}, orientation={d2_tilt.get('orientation')}, guidance='{d2_tilt.get('guidance')}'")
    assert d2_tilt.get("position_correct") is True, f"Expected step 2 to accept left tilt: {d2_tilt}"

    # Synthesize right tilt (~ -12 degrees rotation)
    M_right = cv2.getRotationMatrix2D((w/2, h/2), -12, 1.0)
    img_right = cv2.warpAffine(img, M_right, (w, h))
    _, buf_right = cv2.imencode(".jpg", img_right)
    b64_right = base64.b64encode(buf_right).decode("utf-8")

    r3_tilt = requests.post(f"{BASE_URL}/api/verify-face", json={"image_b64": b64_right, "step": 3})
    d3_tilt = r3_tilt.json()
    print(f"Step 3 with Right Tilt img: pos_correct={d3_tilt.get('position_correct')}, orientation={d3_tilt.get('orientation')}, guidance='{d3_tilt.get('guidance')}'")
    assert d3_tilt.get("position_correct") is True, f"Expected step 3 to accept right tilt: {d3_tilt}"

    print(">>> TEST 1 PASSED: Orientation & Pose checks correctly validate/reject each step!")

    # ----------------------------------------------------
    # TEST 2: Duplicate Face Preclusion on Registration
    # ----------------------------------------------------
    print("\n--- TEST 2: Duplicate Face Preclusion ---")
    
    # Ensure Anandhu profile exists in registry first
    r_check_init = requests.post(f"{BASE_URL}/api/check-duplicate-face", json={
        "image_b64": b64_frontal,
        "images_b64": [b64_frontal],
        "threshold": 0.50
    })
    d_check_init = r_check_init.json()
    if not d_check_init.get("has_duplicate"):
        print("Enrolling base profile Anandhu A for duplicate testing...")
        r_init_reg = requests.post(f"{BASE_URL}/api/register", json={
            "name": "Anandhu A",
            "affiliation": "Team TITANS",
            "images_b64": [b64_frontal],
            "photo_b64": b64_frontal,
            "allow_override": True
        })
        assert r_init_reg.status_code == 200, f"Failed to enroll base profile: {r_init_reg.text}"

    # First, verify duplicate detection via /api/check-duplicate-face
    r_dup = requests.post(f"{BASE_URL}/api/check-duplicate-face", json={
        "image_b64": b64_frontal,
        "images_b64": [b64_frontal],
        "threshold": 0.50
    })
    d_dup = r_dup.json()
    matched_name = d_dup.get("registrant", {}).get("name") if d_dup.get("registrant") else None
    print(f"Check duplicate: has_duplicate={d_dup.get('has_duplicate')}, sim={d_dup.get('similarity')}, matched={matched_name}")
    assert d_dup.get("has_duplicate") is True, "Expected sample_registrant_anandhu to match existing profile in registry"

    # Now attempt registration with a duplicate face WITHOUT override -> MUST return HTTP 409
    dup_reg_payload = {
        "name": "Different Impostor Name",
        "affiliation": "Duplicate Attempt",
        "images_b64": [b64_frontal, b64_frontal],
        "photo_b64": b64_frontal,
        "allow_override": False
    }
    r_reg_block = requests.post(f"{BASE_URL}/api/register", json=dup_reg_payload)
    print(f"Registration without override: status={r_reg_block.status_code}, response={r_reg_block.text}")
    assert r_reg_block.status_code == 409, f"Expected HTTP 409, got {r_reg_block.status_code}"
    assert "Registration prevented" in r_reg_block.text
    print(">>> TEST 2 PASSED: Duplicate registration under different name was strictly blocked with HTTP 409!")

    # ----------------------------------------------------
    # TEST 3: Grouped Hits Dropdown in Pipeline Verdict
    # ----------------------------------------------------
    print("\n--- TEST 3: Static & UI Asset Integrity ---")
    r_appjs = requests.get(f"{BASE_URL}/app.js")
    assert r_appjs.status_code == 200
    assert "grouped-identity-row" in r_appjs.text
    assert "hits-dropdown-toggle-btn" in r_appjs.text
    assert "allow_override" in r_appjs.text
    assert "tab-registration" in r_appjs.text

    r_css = requests.get(f"{BASE_URL}/style.css")
    assert r_css.status_code == 200
    assert ".grouped-identity-row" in r_css.text
    assert ".nested-hits-table" in r_css.text

    print(">>> TEST 3 PASSED: Static assets contain grouped dropdown styles and tab suppression logic!")

    print("\n" + "=" * 60)
    print("ALL TESTS PASSED SUCCESSFULLY!")
    print("=" * 60)

if __name__ == "__main__":
    run_tests()

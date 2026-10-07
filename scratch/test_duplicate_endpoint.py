import base64
import json
import urllib.request

def test_full_duplicate_flow():
    print("Testing full duplicate verification flow...")

    # Load Anandhu image
    with open("backend/samples/sample_registrant_anandhu.jpg", "rb") as f:
        anandhu_b64 = "data:image/jpeg;base64," + base64.b64encode(f.read()).decode("utf-8")

    # 1. Register test user with photo_b64
    reg_payload = {
        "name": "Anandhu A (Titan)",
        "affiliation": "Core Architect",
        "images_b64": [anandhu_b64, anandhu_b64, anandhu_b64, anandhu_b64],
        "photo_b64": anandhu_b64,
        "allowlist": ["@titan_anandhu"],
        "notes": "Verified biometrics",
        "allow_override": True
    }
    req = urllib.request.Request(
        "http://127.0.0.1:8000/api/register",
        data=json.dumps(reg_payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "X-Warden-API-Key": "warden-dev-key-9941"}
    )
    with urllib.request.urlopen(req) as resp:
        reg_data = json.loads(resp.read().decode("utf-8"))
        print(f"1. Registered user: {reg_data['registrant']['name']}, ID: {reg_data['registrant']['registrant_id']}")
        reg_id = reg_data['registrant']['registrant_id']

    # 2. Check duplicate with same image
    check_payload = {
        "image_b64": anandhu_b64,
        "threshold": 0.50
    }
    req2 = urllib.request.Request(
        "http://127.0.0.1:8000/api/check-duplicate-face",
        data=json.dumps(check_payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "X-Warden-API-Key": "warden-dev-key-9941"}
    )
    with urllib.request.urlopen(req2) as resp:
        chk_data = json.loads(resp.read().decode("utf-8"))
        print("\n2. Duplicate check on registered face:")
        print(f"   has_duplicate: {chk_data.get('has_duplicate')}")
        print(f"   similarity: {chk_data.get('similarity')}")
        print(f"   confidence: {chk_data.get('confidence_percent')}%")
        registrant = chk_data.get('registrant')
        print(f"   matched registrant: {registrant.get('name') if registrant else None}")
        print(f"   photo_b64 length: {len(registrant.get('photo_b64', '')) if registrant else 0}")
        assert chk_data.get('has_duplicate') == True, "Failed: Expected duplicate to be True!"
        assert registrant is not None, "Failed: Expected registrant object!"
        assert len(registrant.get('photo_b64', '')) > 100, "Failed: Expected photo_b64 to be populated!"

    # 3. Check duplicate with unregistered person
    with open("backend/samples/sample_unregistered_senior.jpg", "rb") as f:
        unreg_b64 = "data:image/jpeg;base64," + base64.b64encode(f.read()).decode("utf-8")

    check_payload2 = {
        "image_b64": unreg_b64,
        "threshold": 0.50
    }
    req3 = urllib.request.Request(
        "http://127.0.0.1:8000/api/check-duplicate-face",
        data=json.dumps(check_payload2).encode("utf-8"),
        headers={"Content-Type": "application/json", "X-Warden-API-Key": "warden-dev-key-9941"}
    )
    with urllib.request.urlopen(req3) as resp:
        chk_data2 = json.loads(resp.read().decode("utf-8"))
        print("\n3. Duplicate check on unregistered face:")
        print(f"   has_duplicate: {chk_data2.get('has_duplicate')}")
        print(f"   similarity: {chk_data2.get('similarity')}")
        assert chk_data2.get('has_duplicate') == False, "Failed: Expected no duplicate for unreg person!"

    # 4. Clean up test registrant
    del_req = urllib.request.Request(
        f"http://127.0.0.1:8000/api/registry/{reg_id}",
        headers={"X-Warden-API-Key": "warden-dev-key-9941"},
        method="DELETE"
    )
    with urllib.request.urlopen(del_req) as del_resp:
        print(f"\n4. Cleaned up test registrant {reg_id}")

    print("\n[OK] ALL ENDPOINT TESTS PASSED COMPLETELY!")

if __name__ == "__main__":
    test_full_duplicate_flow()

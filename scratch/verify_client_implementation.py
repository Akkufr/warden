import re

def verify_code():
    print("Verifying frontend/index.html...")
    with open("frontend/index.html", "r", encoding="utf-8") as f:
        html = f.read()

    assert "reset-captures-btn" in html, "Missing #reset-captures-btn"
    assert "duplicate-modal" in html, "Missing #duplicate-modal"
    assert "dup-capture-again-btn" in html, "Missing #dup-capture-again-btn"
    assert "dup-keep-proceed-btn" in html, "Missing #dup-keep-proceed-btn"
    assert "dup-new-photo" in html, "Missing #dup-new-photo"
    assert "dup-existing-photo" in html, "Missing #dup-existing-photo"
    print("[OK] index.html has all required UI components.")

    print("\nVerifying frontend/app.js...")
    with open("frontend/app.js", "r", encoding="utf-8") as f:
        js = f.read()

    assert "resetRegistrationCaptures" in js, "Missing resetRegistrationCaptures"
    assert "checkDuplicateFaceOnEnrolment" in js, "Missing checkDuplicateFaceOnEnrolment"
    assert "showDuplicateModal" in js, "Missing showDuplicateModal"
    assert "closeDuplicateModal" in js, "Missing closeDuplicateModal"
    assert "check-duplicate-face" in js, "Missing API call to check-duplicate-face"
    assert "requiredStable = 6" in js, "Expected requiredStable to be 6 ticks (2.4s)"
    assert "4000" in js, "Expected 4000ms pose adjustment window"
    print("[OK] app.js has all required auto-snap timing adjustments and handlers.")

    print("\nVerifying frontend/style.css...")
    with open("frontend/style.css", "r", encoding="utf-8") as f:
        css = f.read()

    assert ".modal-backdrop" in css, "Missing .modal-backdrop CSS"
    assert ".duplicate-dialog" in css, "Missing .duplicate-dialog CSS"
    assert ".dup-comparison-grid" in css, "Missing .dup-comparison-grid CSS"
    print("[OK] style.css has modal and comparison styling.")

    print("\nALL CLIENT CHECKS VERIFIED SUCCESSFULLY!")

if __name__ == "__main__":
    verify_code()

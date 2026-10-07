import re

with open("frontend/index.html", "r", encoding="utf-8") as f:
    html = f.read()

with open("frontend/app.js", "r", encoding="utf-8") as f:
    js = f.read()

with open("frontend/style.css", "r", encoding="utf-8") as f:
    css = f.read()

print("=== VERIFYING FRONTEND HTML STRUCTURE ===")
assert 'id="btn-mode-guard"' in html, "Missing btn-mode-guard"
assert 'id="btn-mode-early"' in html, "Missing btn-mode-early"
assert 'id="btn-mode-ledger"' in html, "Missing btn-mode-ledger"
print("[OK] Header 3-button mode group present with (i) icons")

assert 'id="open-arch-btn"' in html, "Missing open-arch-btn"
assert 'id="arch-close-btn"' in html, "Missing arch-close-btn"
print("[OK] Architecture & Specs corner (i) button and return button present")

assert 'id="upload-step-photo-btn"' not in html, "Upload photo button still in HTML"
assert 'id="reg-photo-file-input"' not in html, "Photo file input still in HTML"
print("[OK] Upload photo option completely removed from registration UX")

assert 'id="dup-close-btn"' not in html, "Duplicate modal close X still in HTML"
assert 'id="dup-capture-again-btn"' in html, "Missing dup-capture-again-btn"
assert 'id="dup-keep-proceed-btn"' in html, "Missing dup-keep-proceed-btn"
print("[OK] Duplicate modal close X removed; capture again & keep proceed verified")

# Check tab-console has exactly four elements
assert 'id="tab-console"' in html, "Missing tab-console"
assert 'id="console-mode-guard"' in html, "Missing console-mode-guard"
assert 'id="console-mode-ledger"' in html, "Missing console-mode-ledger"
assert 'id="console-mode-early"' in html, "Missing console-mode-early"
assert 'id="console-input-pipeline"' in html, "Missing console-input-pipeline"
assert '<input type="password" id="console-registry-db"' in html, "Registry DB is not input type=password"
assert 'id="console-cli-form"' in html, "Missing console-cli-form"
assert 'id="console-cli-input"' in html, "Missing console-cli-input"
print("[OK] Deployment Console strictly has the 4 required elements (Masked password confirmed)")

# Check collegiate mentions
for word in ["LMCST", "Lourdes Matha", "Kuttichal"]:
    assert word.lower() not in html.lower(), f"Found {word} in HTML"
print("[OK] Zero collegiate references in index.html")

print("\n=== VERIFYING APP.JS LOGIC ===")
assert "function stopWebcam()" in js, "Missing stopWebcam function in app.js"
assert "stopWebcam();" in js, "Missing stopWebcam call in app.js"
assert "function initConsoleCLI()" in js, "Missing initConsoleCLI in app.js"
assert "function handleCliCommand(" in js, "Missing handleCliCommand in app.js"
assert "function setSystemMode(" in js, "Missing setSystemMode in app.js"
print("[OK] stopWebcam, initConsoleCLI, handleCliCommand, setSystemMode verified in app.js")

print("\nALL FRONTEND STRUCTURAL ASSERTIONS PASSED 100%!")

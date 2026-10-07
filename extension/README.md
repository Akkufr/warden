# WARDEN — Chrome Extension (Manifest V3)
## Consent-Based Biometric Upload Gating for Instagram DMs & WhatsApp Web

**Event:** HackAthena 2.0  
**Theme:** Detection and Prevention of AI-Based Frauds  
**Team:** TITANS (Anandhu A, Akshay B A, Joshy Bovas, Manu V S)  

---

## 1. Overview & Architecture

This Chrome extension (Manifest V3) brings **Warden's proactive client-boundary protection** directly into the social web. It specifically targets media attachments inside:
1. **Instagram Direct Messages (DMs)** (`instagram.com/direct/...`)
2. **WhatsApp Web** (`web.whatsapp.com/...`)

Rather than waiting for non-consensual AI deepfakes, face swaps, or impersonation videos/images to be transmitted and stored on social media servers, **Warden intercepts media at the moment of selection in the native file picker**, compares facial geometry against the local encrypted FAISS vector index, and enforces real-time upload gating with **zero startup latency**.

```
[ Instagram DM / WhatsApp Web Compose Bar ]
              │ (Click Photo/Video Attach Icon)
              ▼
[ Native OS File Picker ]
              │ (User selects photo / video)
              ▼
[ Warden Content Script (Capture Phase) ] ── (Stops immediate event propagation)
              │
              ├──► 1. Renders minimal "Warden Checking..." status badge near composer
              │
              ├──► 2. Reads binary data via fast native ArrayBuffer (Zero Base64 latency)
              │
              ├──► 3. Focuses/opens Warden Live Dashboard tab with immediate processing
              │
              ▼
[ Extension Service Worker ] ───────────────► [ Warden Backend API: http://127.0.0.1:8000 ]
                                              • /api/upload (Direct staging via single stream)
                                              • /api/scan (Fast 7-Step SFace + FAISS early-exit)
                                              │
                    ┌─────────────────────────┴─────────────────────────┐
                    ▼                                                   ▼
            [ Verdict: PASS ]                                   [ Verdict: BLOCK ]
   • Dismisses status indicator                        • Gated under Fail-Safe Policy
   • Re-dispatches attachment event                    • Clears input.value (purges file)
   • Permitted into chat natively                      • Displays Crimson Alert with match telemetry
```

---

## 2. Zero-Latency Streaming Architecture

In previous implementations, video files suffered noticeable startup lag due to:
1. Multi-megabyte files being converted into Base64 strings in JavaScript.
2. Inefficient character-by-character loops parsing Base64 back into Blobs.
3. Redundant pre-flight health queries and duplicate full-file HTTP uploads.
4. Artificial countdown timers before the pipeline visualizer started.

**Warden v1.1.0 eliminates all startup delays:**
- **Zero-Copy Native ArrayBuffers:** Binary data is transferred via browser structured cloning in < 5ms.
- **Single-Pass Staging:** The background service worker uploads media once to `/api/upload` and passes the canonical identifier to `/api/scan` and the WebSocket visualizer.
- **Tab Reuse & Instant Pipeline Trigger:** Reuses open dashboard tabs and initiates the WebSocket scan with 0ms artificial delay. Video processing begins immediately, matching the performance of direct file uploads on the Warden interface.

---

## 3. Installation (Load Unpacked)

1. Open Google Chrome (or any Chromium browser: Brave, Edge, Arc).
2. In the address bar, navigate to:
   ```
   chrome://extensions
   ```
3. In the top-right corner, toggle **Developer mode** to **ON**.
4. Click the **Load unpacked** button in the top-left toolbar.
5. In the folder picker dialog, select the extension folder:
   ```
   d:\THE TITANS\extension
   ```
6. The extension **Warden — Social Media Likeness Shield** (v1.1.0) is now loaded and active.

---

## 4. How to Test & Demo

Ensure the Warden backend server is running in the background:
```powershell
python run.py
```
*(Confirms `http://127.0.0.1:8000` is online with FAISS vector index loaded).*

### Option A: Built-in Simulated WhatsApp Web Testbench
To evaluate WhatsApp Web upload gating in an authentic chat environment:
1. Open your browser and navigate to:
   ```
   http://127.0.0.1:8000/test_whatsapp_web_mock.html
   ```
2. Click the paperclip attach icon (**📎**) or the "Photos & videos" option in the compose bar.
3. Select a test image or video:
   - **Test Unauthorized Match (BLOCK):** Select `backend/samples/sample_registrant_anandhu.jpg`.
     - *Result:* Intercepted instantly. The dashboard opens showing live vector alignment. The WhatsApp chat receives **NO file**, and the status badge displays:
       **"Upload Blocked: Consent Not Obtained. We have not obtained consent from the person present in this media (Anandhu A)..."**
   - **Test Clean Unregistered Image (PASS):** Select `backend/samples/sample_unregistered_senior.jpg`.
     - *Result:* Intercepted, checked, and cleared. The status badge displays **✓ WARDEN CLEARED**, and the image appears attached inside the WhatsApp chat bubble!

### Option B: Built-in Simulated Instagram DM Testbench
To evaluate Instagram DM upload gating:
1. Open your browser and navigate to:
   ```
   http://127.0.0.1:8000/test_instagram_dm_mock.html
   ```
2. Click the photo attachment gallery icon (**🖼️**) next to the message input box.
3. Select your test photo or video (`sample_registrant_anandhu.jpg` for BLOCK, `sample_unregistered_senior.jpg` for PASS).

### Option C: Simulated Instagram Biometric Likeness Settings
To demonstrate the production-ready social privacy settings interface:
1. Navigate to:
   ```
   http://127.0.0.1:8000/mock_instagram_registry.html
   ```
2. Review active biometric consent ledgers, enrolled identities, and allowlists.

### Option D: Live WhatsApp Web & Instagram DMs
1. Open [WhatsApp Web](https://web.whatsapp.com) or [Instagram](https://www.instagram.com/direct).
2. Attach any photo or video in an active conversation.
3. Observe Warden's client-boundary shield intercept the attachment, gate the upload, and launch the real-time biometric telemetry verification.

---

## 5. Extension File Structure

```
d:\THE TITANS\extension\
├── manifest.json              # Chrome Manifest V3 declaration (IG & WhatsApp Web)
├── background.js             # Service worker handling API requests & zero-delay staging
├── content.js                # Capture-phase file interceptor & platform-aware badge UI
├── content.css               # Obsidian & emerald/crimson cybersecurity styling
├── popup.html                # Multi-platform status toolbar popup
├── popup.css                 # Popup design system styles
├── popup.js                  # Live FAISS connectivity monitor & testbench launchers
├── test_whatsapp_web_mock.html # Authentic WhatsApp Web simulated testbench
├── test_instagram_dm_mock.html# Simulated Instagram DM testbench
├── mock_instagram_registry.html # Biometric Likeness & Consent Registry interface
├── README.md                 # Documentation
└── icons/                    # Biometric shield icons
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

---

## 6. Security & Privacy Guarantees

* **Zero Third-Party Telemetry:** Media is sent exclusively to the local Warden instance (`http://127.0.0.1:8000`). No data is sent to Meta, Instagram, WhatsApp, or external cloud servers.
* **Zero Persistence:** File data resides only in memory during the scanning lifecycle and is immediately purged upon verdict formulate.
* **Fail-Safe Client Interception:** Utilizing the DOM event capture phase ensures neither Instagram nor WhatsApp ever previews, caches, or transmits unauthorized likenesses before clearance.

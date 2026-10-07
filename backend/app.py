import os
import sys

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BACKEND_DIR = os.path.join(BASE_DIR, "backend")
for p in [BASE_DIR, BACKEND_DIR]:
    if p not in sys.path:
        sys.path.insert(0, p)

import shutil
import uuid
import json
import base64
import asyncio
import cv2
import numpy as np
import time
import logging
from fastapi import FastAPI, UploadFile, File, Form, WebSocket, WebSocketDisconnect, HTTPException, Request, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import JSONResponse, FileResponse
from pydantic import BaseModel
from typing import List, Optional

logger = logging.getLogger("warden.app")
if not logger.handlers:
    logging.basicConfig(level=logging.INFO)

try:
    from backend.models_loader import BiometricModels
    from backend.registry import VectorRegistry
    from backend.pipeline import WardenPipeline
    from backend.seed_data import seed_default_registrants
    from backend.security import (
        rate_limiter,
        liveness_manager,
        detect_magic_signature,
        preflight_image_dimensions,
        validate_video_container,
        validate_tensor_frame,
        safe_decode_image,
        safe_sandboxed_decode_image,
        WARDEN_API_KEY_DEFAULT,
        MAX_VIDEO_FILE_SIZE,
        MAX_IMAGE_FILE_SIZE
    )
except ImportError:
    from models_loader import BiometricModels
    from registry import VectorRegistry
    from pipeline import WardenPipeline
    from seed_data import seed_default_registrants
    from security import (
        rate_limiter,
        liveness_manager,
        detect_magic_signature,
        preflight_image_dimensions,
        validate_video_container,
        validate_tensor_frame,
        safe_decode_image,
        safe_sandboxed_decode_image,
        WARDEN_API_KEY_DEFAULT,
        MAX_VIDEO_FILE_SIZE,
        MAX_IMAGE_FILE_SIZE
    )

# Ensure sys.modules aliases point to the exact same module instances
if "backend.registry" in sys.modules and "registry" not in sys.modules:
    sys.modules["registry"] = sys.modules["backend.registry"]
elif "registry" in sys.modules and "backend.registry" not in sys.modules:
    sys.modules["backend.registry"] = sys.modules["registry"]


BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FRONTEND_DIR = os.path.join(BASE_DIR, "frontend")
SAMPLES_DIR = os.path.join(BASE_DIR, "backend", "samples")
UPLOADS_DIR = os.path.join(BASE_DIR, "data", "uploads")
os.makedirs(UPLOADS_DIR, exist_ok=True)

app = FastAPI(
    title="Warden API — Consent-Based Identity Verification Framework",
    description="Backend identity-verification and upload gating framework against AI-based impersonation and likeness fraud (HackAthena 2.0)",
    version="2.0.0"
)

# Enable CORS for local cross-origin development if needed
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def verify_api_key(request: Request):
    """
    Validates API key authentication for incoming API requests.
    Enforces authentication for programmatic endpoints as required by Section 2.
    Supports X-Warden-API-Key header, Authorization Bearer, or query parameter api_key.
    """
    api_key = request.headers.get("X-Warden-API-Key")
    if not api_key:
        auth_header = request.headers.get("Authorization")
        if auth_header and auth_header.startswith("Bearer "):
            api_key = auth_header[7:].strip()
    if not api_key:
        api_key = request.query_params.get("api_key")

    if not api_key or api_key != WARDEN_API_KEY_DEFAULT:
        raise HTTPException(
            status_code=401,
            detail="Unauthorized: Missing or invalid API key. Provide header 'X-Warden-API-Key: warden-dev-key-9941' or Bearer token."
        )
    return api_key


@app.middleware("http")
async def security_middleware(request: Request, call_next):
    client_ip = request.client.host if request.client else "127.0.0.1"
    path = request.url.path

    # 1. Request size ceiling check (60MB)
    content_length = request.headers.get("content-length")
    if content_length and int(content_length) > MAX_VIDEO_FILE_SIZE:
        logger.warning(f"[SecurityCeiling] Request size {content_length}b from {client_ip} exceeds 60MB limit")
        return JSONResponse(
            status_code=413,
            content={"detail": "Payload Too Large: Request exceeds maximum allowed ceiling of 60MB."}
        )

    # 2. Per-client sliding-window rate limit & automated quarantine check on API endpoints
    if path.startswith("/api/"):
        allowed, msg = rate_limiter.record_request(client_ip)
        if not allowed:
            logger.warning(f"[SecurityRateLimit] Throttled {client_ip} on {path}: {msg}")
            return JSONResponse(
                status_code=429,
                content={"detail": msg}
            )

    # 3. Audit trail logging
    t_start = time.time()
    response = await call_next(request)
    duration_ms = round((time.time() - t_start) * 1000, 2)

    if path.startswith("/api/"):
        logger.info(f"[AUDIT] {request.method} {path} | Client: {client_ip} | Status: {response.status_code} | Latency: {duration_ms}ms")

    # 4. Security & TLS enforcement headers
    response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "SAMEORIGIN"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["X-XSS-Protection"] = "1; mode=block"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob: ws: wss:; "
        "font-src 'self' https: data:; "
        "style-src 'self' 'unsafe-inline' https:;"
    )

    return response

# Startup event: ensure default seeds exist
@app.on_event("startup")
def startup_event():
    seed_default_registrants()

@app.get("/api/health")
def get_health():
    registry = VectorRegistry.get_instance()
    stats = registry.get_statistics()
    return {
        "status": "ONLINE",
        "system": "Warden Identity Framework v2.0",
        "team": "TITANS",
        "event": "HackAthena 2.0",
        "stats": stats
    }

@app.get("/api/samples")
def list_samples():
    """Lists pre-packaged benchmark media files for one-click evaluator testing."""
    samples = [
        {
            "id": "sample_registrant_anandhu.jpg",
            "name": "Registered Individual (Anandhu A)",
            "type": "IMAGE",
            "description": "Clean frontal portrait of opted-in registrant Anandhu A.",
            "expected_verdict": "BLOCK (Guard) / MATCH (Ledger)"
        },
        {
            "id": "sample_unregistered_senior.jpg",
            "name": "Unregistered Subject (Senior)",
            "type": "IMAGE",
            "description": "Unregistered portrait. Verifies high discrimination ratio without false flags.",
            "expected_verdict": "PASS (Guard) / CLEARED (Ledger)"
        },
        {
            "id": "sample_group_composite.jpg",
            "name": "Multi-Person Composite Scene",
            "type": "IMAGE",
            "description": "Composite frame featuring both registered and unregistered subjects in one scene.",
            "expected_verdict": "BLOCK (Guard triggers on unauthorized likeness)"
        },
        {
            "id": "sample_synthetic_broadcast.jpg",
            "name": "AI Studio Broadcast Still",
            "type": "IMAGE",
            "description": "Synthetic broadcast stream test for deepfake-style studio lighting.",
            "expected_verdict": "PASS (Unregistered)"
        },
        {
            "id": "sample_dedup_video.mp4",
            "name": "Live Video Stream — Deduplication Test",
            "type": "VIDEO",
            "description": "3-second video tracking a face across frames, demonstrating intra-content deduplication.",
            "expected_verdict": "BLOCK (With visual deduplication discard telemetry)"
        },
        {
            "id": "sample_unauthorized_video.mp4",
            "name": "Social Feed Injection — Mid-Stream Appearance",
            "type": "VIDEO",
            "description": "Video starting clean, where registered individual likeness appears mid-stream.",
            "expected_verdict": "BLOCK (Demonstrates Early-Exit Gating vs Full Audit)"
        }
    ]
    return samples

@app.get("/api/registration/challenge")
def get_registration_challenge(api_key: str = Depends(verify_api_key)):
    """
    Issues a cryptographic time-bound session nonce token for biometric registration.
    Prevents injection and replay attacks by validating that subsequent capture steps
    belong to an active, unexpired challenge session.
    """
    return liveness_manager.create_registration_challenge()

@app.get("/api/registry")
def get_registry(api_key: str = Depends(verify_api_key)):
    registry = VectorRegistry.get_instance()
    response = JSONResponse(content={
        "registrants": registry.list_registrants(),
        "stats": registry.get_statistics()
    })
    response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate, max-age=0"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    return response

class VerifyFaceRequest(BaseModel):
    image_b64: str
    step: Optional[int] = 1
    challenge_token: Optional[str] = None
    previous_images_b64: Optional[List[str]] = []

@app.post("/api/verify-face")
def verify_face(payload: VerifyFaceRequest, api_key: str = Depends(verify_api_key)):
    """
    Validates whether a clear face is detected, centered in the oval guide,
    and oriented correctly according to the requested step (frontal, left, right, smile).
    Used by the registration UX to turn the face outline green when in the correct position
    and prevent invalid step captures. Enforces anti-replay and dynamic entropy checks.
    """
    models = BiometricModels.get_instance()
    try:
        # 1. Challenge Token verification
        if payload.challenge_token:
            valid_tok, nonce, tok_msg = liveness_manager.validate_token(payload.challenge_token)
            if not valid_tok:
                return {
                    "face_detected": False,
                    "face_count": 0,
                    "confidence": 0.0,
                    "position_correct": False,
                    "guidance": tok_msg,
                    "message": f"Liveness challenge rejected: {tok_msg}"
                }

        # 2. Safe decoding with tensor bounds validation
        b64_str = payload.image_b64
        if "," in b64_str:
            b64_str = b64_str.split(",", 1)[1]
        img_bytes = base64.b64decode(b64_str)

        safe_ok, img, dec_err = safe_decode_image(img_bytes)
        if not safe_ok or img is None:
            return {
                "face_detected": False,
                "face_count": 0,
                "confidence": 0.0,
                "position_correct": False,
                "is_centered": False,
                "orientation_satisfied": False,
                "reason_code": "CORRUPT_FRAME",
                "guidance": "Camera stream frame is corrupted or unreadable. Check camera drivers or reconnect webcam.",
                "message": f"Frame decoding rejected: {dec_err}"
            }

        # 3. Anti-replay & minimum frame entropy verification
        if payload.previous_images_b64 and len(payload.previous_images_b64) > 0:
            prev_imgs = []
            for p_b64 in payload.previous_images_b64:
                if "," in p_b64:
                    p_b64 = p_b64.split(",", 1)[1]
                p_bytes = base64.b64decode(p_b64)
                p_ok, p_img, _ = safe_decode_image(p_bytes)
                if p_ok and p_img is not None:
                    prev_imgs.append(p_img)

            live_ok, live_msg = liveness_manager.validate_anti_replay_and_entropy(
                img, prev_imgs, step_number=payload.step or 1
            )
            if not live_ok:
                return {
                    "face_detected": True,
                    "face_count": 1,
                    "confidence": 95.0,
                    "position_correct": False,
                    "is_centered": False,
                    "orientation_satisfied": False,
                    "reason_code": "ANTI_REPLAY_FLAG",
                    "guidance": live_msg,
                    "message": live_msg,
                    "anti_replay_flag": True
                }

        h_img, w_img, _ = img.shape
        faces = models.detect_faces(img, score_threshold=0.45)
        if not faces:
            return {
                "face_detected": False,
                "face_count": 0,
                "confidence": 0.0,
                "position_correct": False,
                "is_centered": False,
                "orientation_satisfied": False,
                "reason_code": "NO_FACE",
                "guidance": "No face detected in camera frame. Center your face inside the guide oval.",
                "message": "No face detected in camera frame. Center your face inside the guide oval."
            }

        # Oval Face Zone Filtering: isolate faces positioned inside the central registration zone
        img_cx = w_img / 2.0
        img_cy = h_img / 2.0
        rx = 0.32 * w_img
        ry = 0.40 * h_img

        zone_faces = []
        for f in faces:
            fx, fy, fw, fh = f["bbox"]
            fcx = fx + fw / 2.0
            fcy = fy + fh / 2.0
            # Ellipse containment formula: ((fcx - cx)/rx)^2 + ((fcy - cy)/ry)^2 <= 1.0
            dist_sq = ((fcx - img_cx) / rx) ** 2 + ((fcy - img_cy) / ry) ** 2
            if dist_sq <= 1.0:
                zone_faces.append(f)

        # Only evaluate faces positioned inside the face oval zone; ignore background people
        eval_faces = zone_faces if len(zone_faces) > 0 else faces
        best_face = max(eval_faces, key=lambda f: f["conf"])
        x, y, w, h = best_face["bbox"]

        # Face center coordinates
        face_cx = x + w / 2.0
        face_cy = y + h / 2.0

        # Normalized offset from center
        dx = abs(face_cx - img_cx) / float(w_img)
        dy = abs(face_cy - img_cy) / float(h_img)
        face_ratio = w / float(w_img)

        # In correct position when reasonably centered inside the oval guide and adequately sized
        is_centered = (dx <= 0.28) and (dy <= 0.28) and (0.12 <= face_ratio <= 0.85)

        if not is_centered:
            if face_ratio < 0.12:
                guidance = "Move closer to camera"
            elif face_ratio > 0.85:
                guidance = "Step back slightly"
            elif dx > 0.28:
                guidance = "Center face horizontally"
            else:
                guidance = "Center face vertically"
        else:
            guidance = "Face in correct position"

        # Pose & Expression Verification from 5 YuNet facial landmarks
        landmarks = best_face.get("landmarks", [])
        orientation_satisfied = True
        orientation_name = "frontal"
        is_smiling = False
        smile_percent = 0
        step = payload.step or 1

        if len(landmarks) >= 5:
            x_re, y_re = landmarks[0]
            x_le, y_le = landmarks[1]
            x_n, y_n = landmarks[2]
            x_rc, y_rc = landmarks[3]
            x_lc, y_lc = landmarks[4]

            eye_dx = abs(x_le - x_re)
            eye_dist = float(np.hypot(x_le - x_re, y_le - y_re))
            mouth_width = float(np.hypot(x_lc - x_rc, y_lc - y_rc))

            min_eye_x = min(x_re, x_le)
            yaw_ratio = float((x_n - min_eye_x) / (eye_dx + 1e-6)) if eye_dx > 0 else 0.50
            roll_ratio = float((y_le - y_re) / (eye_dist + 1e-6))

            mouth_mid_x = (x_rc + x_lc) / 2.0
            mouth_mid_y = (y_rc + y_lc) / 2.0
            nose_to_mouth_dist = max(1.0, float(np.hypot(mouth_mid_x - x_n, mouth_mid_y - y_n)))
            eye_to_nose_dist = max(1.0, float(np.hypot(x_n - (x_re + x_le) / 2.0, y_n - (y_re + y_le) / 2.0)))

            smile_ratio = float(mouth_width / nose_to_mouth_dist)
            mouth_to_eye = float(mouth_width / (eye_dist + 1e-6))
            vert_ratio = float(nose_to_mouth_dist / eye_to_nose_dist)

            # Calibrated multi-factor smile indicators:
            # 1. Mouth width expansion relative to eye distance (neutral: 0.80-0.86, natural smile: >= 0.87)
            score_width = min(1.0, max(0.0, (mouth_to_eye - 0.80) / (0.92 - 0.80)))
            # 2. Mouth width to nose-to-mouth ratio (neutral: 1.6-2.1, natural smile: >= 2.10)
            score_ratio = min(1.0, max(0.0, (smile_ratio - 1.80) / (2.30 - 1.80)))
            # 3. Vertical upper lip elevation towards nose (neutral: 0.72-0.78, natural smile: < 0.71)
            score_vert = min(1.0, max(0.0, (0.75 - vert_ratio) / (0.75 - 0.63)))

            # Composite smile score from 0.0 to 1.0 (expressed as percent 0-100)
            smile_score = 0.45 * score_ratio + 0.40 * score_width + 0.15 * score_vert
            smile_percent = int(round(smile_score * 100))

            # Step 4 Smile criteria:
            # Responsive to natural, pleasant, or broad smiles (triggers at >= 45% or ratio >= 2.10 or width >= 0.87)
            is_smiling = (smile_score >= 0.45) or (mouth_to_eye >= 0.87) or (smile_ratio >= 2.10)

            # Step 1 Neutral criteria:
            # Relaxed/pleasant faces pass; only reject very broad exaggerated open grins
            is_broad_smile = (smile_score >= 0.90) and (smile_ratio >= 2.65)

            # Detect orientation using both horizontal yaw turn and lateral roll tilt:
            # Left: head turned left (yaw > 0.54) or tilted counter-clockwise (roll < -0.08)
            # Right: head turned right (yaw < 0.46) or tilted clockwise (roll > 0.08)
            if (yaw_ratio > 0.54) or (roll_ratio < -0.08):
                orientation_name = "left"
            elif (yaw_ratio < 0.46) or (roll_ratio > 0.08):
                orientation_name = "right"
            else:
                orientation_name = "frontal"

            if is_centered:
                if step == 1:
                    # Step 1: Frontal Neutral
                    if orientation_name != "frontal":
                        orientation_satisfied = False
                        guidance = "Look directly at camera (Frontal Neutral)"
                    elif is_broad_smile:
                        orientation_satisfied = False
                        guidance = "Keep a neutral facial expression"
                    else:
                        orientation_satisfied = True
                        guidance = "Face in correct position"
                elif step == 2:
                    # Step 2: Slight Left Turn / Tilt (~15-20 deg)
                    if orientation_name != "left":
                        orientation_satisfied = False
                        guidance = "Turn or tilt head slightly to the LEFT (~15–20°)"
                    else:
                        orientation_satisfied = True
                        guidance = "Left turn/tilt verified"
                elif step == 3:
                    # Step 3: Slight Right Turn / Tilt (~15-20 deg)
                    if orientation_name != "right":
                        orientation_satisfied = False
                        guidance = "Turn or tilt head slightly to the RIGHT (~15–20°)"
                    else:
                        orientation_satisfied = True
                        guidance = "Right turn/tilt verified"
                elif step == 4:
                    # Step 4: Smiling Expression
                    if not is_smiling:
                        orientation_satisfied = False
                        guidance = f"Smile naturally for expression capture ({smile_percent}%)"
                    else:
                        orientation_satisfied = True
                        guidance = f"Natural smile verified ({smile_percent}%)"

        effective_count = len(zone_faces) if len(zone_faces) > 0 else len(faces)
        is_position_correct = is_centered and orientation_satisfied and (effective_count == 1)

        # Determine explicit machine-readable reason code
        reason_code = "OK"
        if effective_count > 1:
            reason_code = "MULTIPLE_FACES"
            guidance = f"Multiple faces detected ({effective_count} in view). Exactly 1 individual required."
        elif not is_centered:
            if face_ratio < 0.12:
                reason_code = "TOO_FAR"
            elif face_ratio > 0.85:
                reason_code = "TOO_CLOSE"
            elif dx > 0.28:
                reason_code = "OFF_CENTER_X"
            else:
                reason_code = "OFF_CENTER_Y"
        elif not orientation_satisfied:
            if step == 1:
                reason_code = "EXPRESSION_MISMATCH" if is_broad_smile else "WRONG_ORIENTATION_FRONTAL"
            elif step == 2:
                reason_code = "WRONG_ORIENTATION_LEFT"
            elif step == 3:
                reason_code = "WRONG_ORIENTATION_RIGHT"
            elif step == 4:
                reason_code = "SMILE_DEFICIT"
            else:
                reason_code = "WRONG_ORIENTATION"

        return {
            "face_detected": True,
            "face_count": effective_count,
            "confidence": round(float(best_face["conf"]) * 100, 1),
            "bbox": best_face["bbox"],
            "position_correct": is_position_correct,
            "is_centered": bool(is_centered),
            "orientation_satisfied": bool(orientation_satisfied),
            "reason_code": reason_code,
            "face_ratio": round(float(face_ratio), 3),
            "guidance": guidance,
            "orientation": orientation_name,
            "is_smiling": is_smiling,
            "smile_percent": smile_percent,
            "step": step,
            "message": f"Face detected in registration zone ({round(float(best_face['conf']) * 100, 1)}% confidence)"
        }
    except Exception as e:
        return {
            "face_detected": False,
            "face_count": 0,
            "confidence": 0.0,
            "position_correct": False,
            "is_centered": False,
            "orientation_satisfied": False,
            "reason_code": "VERIFICATION_ERROR",
            "guidance": f"Face verification error: {str(e)}",
            "message": str(e)
        }

class RegisterRequest(BaseModel):
    name: str
    affiliation: Optional[str] = "Protected Registrant"
    images_b64: List[str] # 3 to 5 images captured during guided registration
    allowlist: Optional[List[str]] = []
    notes: Optional[str] = ""
    photo_b64: Optional[str] = ""
    allow_override: Optional[bool] = False

class CheckDuplicateRequest(BaseModel):
    image_b64: Optional[str] = ""
    images_b64: Optional[List[str]] = []
    threshold: Optional[float] = 0.52

@app.post("/api/check-duplicate-face")
def check_duplicate_face(payload: CheckDuplicateRequest, api_key: str = Depends(verify_api_key)):
    """
    Checks if a newly captured face image already matches any active profile in the vector registry.
    Returns whether duplicate is detected, similarity, matched registrant data (including photo_b64).
    """
    models = BiometricModels.get_instance()
    registry = VectorRegistry.get_instance()
    registry.reload()

    candidates = []
    if payload.image_b64:
        candidates.append(payload.image_b64)
    if payload.images_b64:
        for img in payload.images_b64:
            if img and img not in candidates:
                candidates.append(img)

    if not candidates:
        raise HTTPException(status_code=400, detail="At least one image is required for duplicate check.")

    threshold = payload.threshold if (payload.threshold is not None and payload.threshold > 0) else 0.52
    best_match = None
    highest_sim = -1.0

    for b64_str in candidates:
        try:
            if "," in b64_str:
                b64_str = b64_str.split(",", 1)[1]
            img_bytes = base64.b64decode(b64_str)
            safe_ok, img, _ = safe_decode_image(img_bytes)
            if not safe_ok or img is None:
                continue

            faces = models.detect_faces(img, score_threshold=0.45)
            if not faces:
                continue

            h_img, w_img = img.shape[:2]
            img_cx, img_cy = w_img / 2.0, h_img / 2.0
            rx, ry = 0.35 * w_img, 0.42 * h_img

            zone_faces = [
                f for f in faces
                if (((f["bbox"][0] + f["bbox"][2]/2.0 - img_cx)/rx)**2 + ((f["bbox"][1] + f["bbox"][3]/2.0 - img_cy)/ry)**2) <= 1.0
            ]
            eval_faces = zone_faces if len(zone_faces) > 0 else faces
            best_face = max(eval_faces, key=lambda f: f["conf"])

            vec = models.extract_embedding(img, best_face["raw"])
            search_res = registry.search_vector(vec, top_k=1, threshold=threshold)

            sim = float(search_res.get("similarity", 0.0))
            if sim > highest_sim:
                highest_sim = sim
                best_match = search_res
        except Exception:
            continue

    if best_match and best_match.get("matched"):
        reg = best_match.get("registrant", {})
        return {
            "has_duplicate": True,
            "similarity": best_match.get("similarity", 0.0),
            "confidence_percent": best_match.get("confidence_percent", 0.0),
            "threshold": threshold,
            "registrant": reg,
            "message": f"Similar likeness already registered: {reg.get('name', 'Known Individual')} ({best_match.get('confidence_percent', 0.0)}% match)"
        }

    return {
        "has_duplicate": False,
        "similarity": max(0.0, round(highest_sim, 4)),
        "confidence_percent": max(0.0, round(highest_sim * 100, 1)),
        "threshold": threshold,
        "registrant": None,
        "message": "No duplicate face found in registry."
    }

class RegisterRequest(BaseModel):
    name: str
    affiliation: Optional[str] = "Protected Registrant"
    images_b64: List[str] # 3 to 5 images captured during guided registration
    allowlist: Optional[List[str]] = []
    notes: Optional[str] = ""
    photo_b64: Optional[str] = ""
    allow_override: Optional[bool] = False
    challenge_token: Optional[str] = None

@app.post("/api/register")
def register_user(payload: RegisterRequest, api_key: str = Depends(verify_api_key)):
    """
    Registers a new individual with multi-angle guided captures.
    Computes SFace 128-d embeddings for each angle, averages/normalizes,
    and updates the active FAISS vector index under GDPR/DPDP consent terms.
    Enforces cryptographic session challenge validation and anti-replay guards.
    """
    models = BiometricModels.get_instance()
    registry = VectorRegistry.get_instance()

    # 1. Challenge Token verification
    if payload.challenge_token:
        valid_tok, nonce, tok_msg = liveness_manager.validate_token(payload.challenge_token)
        if not valid_tok:
            raise HTTPException(status_code=403, detail=f"Registration rejected: {tok_msg}")

    if not payload.images_b64 or len(payload.images_b64) == 0:
        raise HTTPException(status_code=400, detail="At least 1 face capture image is required")

    clean_name = payload.name.strip()
    if not clean_name:
        raise HTTPException(status_code=400, detail="Registration prevented: Full name is required.")

    # 2. Safe decode and anti-replay validation
    decoded_images: List[np.ndarray] = []
    for b64_str in payload.images_b64:
        if "," in b64_str:
            b64_str = b64_str.split(",", 1)[1]
        raw_b = base64.b64decode(b64_str)
        s_ok, s_img, _ = safe_decode_image(raw_b)
        if s_ok and s_img is not None:
            decoded_images.append(s_img)

    if not decoded_images:
        raise HTTPException(status_code=400, detail="Registration rejected: Could not decode submitted capture media.")

    # Anti-Replay Check: Reject submissions where identical static photos are replayed across steps
    if len(decoded_images) >= 2 and not payload.allow_override:
        for idx in range(1, len(decoded_images)):
            curr = decoded_images[idx]
            prevs = decoded_images[:idx]
            live_ok, live_msg = liveness_manager.validate_anti_replay_and_entropy(curr, prevs, step_number=idx+1)
            if not live_ok:
                raise HTTPException(
                    status_code=422,
                    detail=f"Registration prevented by anti-replay guard: {live_msg}"
                )

    captured_vectors = []
    quality_checks = []

    for idx, img in enumerate(decoded_images):
        try:
            faces = models.detect_faces(img, score_threshold=0.45)
            if not faces:
                continue

            h_img, w_img = img.shape[:2]
            img_cx, img_cy = w_img / 2.0, h_img / 2.0
            rx, ry = 0.35 * w_img, 0.42 * h_img

            # Prioritize face located inside the face oval zone (ignore any background people)
            zone_faces = [
                f for f in faces
                if (((f["bbox"][0] + f["bbox"][2]/2.0 - img_cx)/rx)**2 + ((f["bbox"][1] + f["bbox"][3]/2.0 - img_cy)/ry)**2) <= 1.0
            ]
            eval_faces = zone_faces if len(zone_faces) > 0 else faces

            # Pick highest confidence face in the oval zone
            best_face = max(eval_faces, key=lambda f: f["conf"])
            vec = models.extract_embedding(img, best_face["raw"])
            captured_vectors.append(vec)
            quality_checks.append({
                "capture_index": idx,
                "confidence": best_face["conf"],
                "bbox": best_face["bbox"]
            })
        except Exception:
            continue

    if len(captured_vectors) == 0:
        raise HTTPException(
            status_code=422,
            detail="Registration prevented: No face detected in the submitted captures. Facial geometry is strictly required."
        )

    # Duplicate Prevention Check:
    # Verify that the captured face does NOT already exist in the FAISS registry under same or different name
    if not payload.allow_override:
        registry.reload()
        for v in captured_vectors:
            match_res = registry.search_vector(v, top_k=1, threshold=0.50)
            if match_res.get("matched") and match_res.get("registrant"):
                existing = match_res["registrant"]
                raise HTTPException(
                    status_code=409,
                    detail=f"Registration prevented: Facial likeness already exists in the registry as '{existing['name']}' ({existing['registrant_id']}). Duplicate registrations under different or same names are prohibited."
                )

    # Persist the primary frontal photo thumbnail
    primary_photo = payload.photo_b64 or (payload.images_b64[0] if payload.images_b64 else "")

    record = registry.register_individual(
        name=clean_name,
        vectors=captured_vectors,
        affiliation=(payload.affiliation or "Protected Registrant").strip(),
        allowlist=payload.allowlist,
        notes=payload.notes or "Web Registration via Guided UX",
        photo_b64=primary_photo
    )
    registry.reload()

    return {
        "success": True,
        "registrant": record,
        "captures_processed": len(captured_vectors),
        "quality_report": quality_checks,
        "message": f"Likeness registered securely. {len(captured_vectors)} vector embeddings committed to FAISS index. Consent ID generated."
    }

@app.delete("/api/registry/{registrant_id}")
def revoke_registration(registrant_id: str, api_key: str = Depends(verify_api_key)):
    """
    Revokes and permanently removes an individual's biometric registration.
    Embeddings are immediately purged from the active FAISS index.
    """
    registry = VectorRegistry.get_instance()
    target_id = registrant_id.strip()
    success = registry.delete_record(target_id)
    if not success:
        with registry._get_connection() as conn:
            row = conn.execute(
                "SELECT registrant_id FROM registrants WHERE consent_id = ? OR name = ?", 
                (target_id, target_id)
            ).fetchone()
            if row:
                success = registry.delete_record(row["registrant_id"])
    if not success:
        raise HTTPException(status_code=404, detail=f"Registrant '{target_id}' not found in registry")
    registry.reload()
    return {
        "success": True,
        "registrant_id": target_id,
        "status": "REMOVED",
        "message": "Record and embeddings permanently purged from registry and FAISS index."
    }

class BatchRevokeRequest(BaseModel):
    registrant_ids: List[str]

@app.post("/api/registry/batch-delete")
@app.delete("/api/registry/batch-delete")
def batch_delete_registrations(payload: BatchRevokeRequest, api_key: str = Depends(verify_api_key)):
    """
    Batch revokes/deletes multiple selected biometric registrations.
    """
    registry = VectorRegistry.get_instance()
    count = registry.delete_multiple_records(payload.registrant_ids)
    registry.reload()
    return {
        "success": True,
        "deleted_count": count,
        "message": f"Successfully revoked and purged {count} biometric record(s) from FAISS index."
    }


@app.post("/api/upload")
async def upload_file(
    request: Request,
    file: UploadFile = File(...),
    api_key: str = Depends(verify_api_key)
):
    """
    Uploads media for scan and returns local temporary identifier.
    Validates magic bytes, enforces size ceiling, and tracks malformed submissions.
    """
    client_ip = request.client.host if (request and request.client) else "127.0.0.1"
    file_ext = os.path.splitext(file.filename)[1].lower()
    if file_ext not in [".jpg", ".jpeg", ".png", ".webp", ".mp4", ".mov", ".avi", ".webm"]:
        rate_limiter.record_malformed_submission(client_ip)
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file format: '{file_ext}' is not supported. Please upload JPG, PNG, WEBP, MP4, MOV, WEBM, or AVI."
        )

    unique_filename = f"upload_{uuid.uuid4().hex[:10]}{file_ext}"
    target_path = os.path.join(UPLOADS_DIR, unique_filename)

    bytes_written = 0
    with open(target_path, "wb") as buffer:
        while chunk := await file.read(1024 * 1024):
            bytes_written += len(chunk)
            if bytes_written > MAX_VIDEO_FILE_SIZE:
                buffer.close()
                if os.path.exists(target_path):
                    os.remove(target_path)
                rate_limiter.record_malformed_submission(client_ip)
                raise HTTPException(status_code=413, detail=f"File exceeds maximum allowed size ({MAX_VIDEO_FILE_SIZE // (1024*1024)}MB)")
            buffer.write(chunk)

    # 1. Verify Magic Bytes
    with open(target_path, "rb") as f_head:
        header_sample = f_head.read(64)
    sig = detect_magic_signature(header_sample)
    if not sig:
        if os.path.exists(target_path):
            os.remove(target_path)
        is_quar, q_msg = rate_limiter.record_malformed_submission(client_ip)
        if is_quar:
            raise HTTPException(status_code=429, detail=q_msg)
        raise HTTPException(status_code=400, detail="File rejected: corrupt, malformed, or invalid binary file signature.")

    # 2. Pre-flight dimension / container check
    is_video = sig in ("MP4", "WEBM", "AVI")
    if not is_video:
        with open(target_path, "rb") as f_img:
            img_data = f_img.read()
        safe_dim, w, h, dim_err = preflight_image_dimensions(img_data)
        if not safe_dim:
            if os.path.exists(target_path):
                os.remove(target_path)
            rate_limiter.record_malformed_submission(client_ip)
            raise HTTPException(status_code=400, detail=f"Image rejected: {dim_err}")
    else:
        valid_vid, vid_err, _ = validate_video_container(target_path, bytes_written)
        if not valid_vid:
            if os.path.exists(target_path):
                os.remove(target_path)
            rate_limiter.record_malformed_submission(client_ip)
            raise HTTPException(status_code=400, detail=f"Video rejected: {vid_err}")

    # Zero-retention: clean any stale temporary files older than 120s
    try:
        now = time.time()
        for f in os.listdir(UPLOADS_DIR):
            f_p = os.path.join(UPLOADS_DIR, f)
            if os.path.isfile(f_p) and f_p != target_path and (now - os.path.getmtime(f_p)) > 120.0:
                os.remove(f_p)
    except Exception:
        pass

    return {
        "filename": unique_filename,
        "file_path": target_path,
        "content_type": "VIDEO" if is_video else "IMAGE"
    }

@app.post("/api/scan")
async def scan_direct(
    request: Request,
    file: Optional[UploadFile] = File(None),
    file_path: Optional[str] = Form(None),
    mode: str = Form("guard"),
    early_exit: bool = Form(False),
    threshold: float = Form(0.50),
    api_key: str = Depends(verify_api_key)
):
    """
    Programmatic REST API for integrating platforms (Section 9).
    Upload media or reference pre-staged media and receive instant pass/block or compliance ledger.
    Fails safely in Guard mode and purges temporary files immediately upon completion.
    """
    client_ip = request.client.host if (request and request.client) else "127.0.0.1"
    scan_path = None
    should_delete = False

    if file_path:
        norm_path = os.path.abspath(file_path)
        uploads_abs = os.path.abspath(UPLOADS_DIR)
        samples_abs = os.path.abspath(SAMPLES_DIR)
        if not (norm_path.startswith(uploads_abs) or norm_path.startswith(samples_abs)) or not os.path.exists(norm_path):
            raise HTTPException(status_code=400, detail="Invalid file_path specified or file not found.")
        scan_path = norm_path
        should_delete = False
    elif file is not None:
        file_ext = os.path.splitext(file.filename)[1].lower() if file.filename else ".jpg"
        temp_path = os.path.join(UPLOADS_DIR, f"scan_{uuid.uuid4().hex[:10]}{file_ext}")
        bytes_written = 0
        with open(temp_path, "wb") as buffer:
            while chunk := await file.read(1024 * 1024):
                bytes_written += len(chunk)
                if bytes_written > MAX_VIDEO_FILE_SIZE:
                    buffer.close()
                    if os.path.exists(temp_path):
                        os.remove(temp_path)
                    rate_limiter.record_malformed_submission(client_ip)
                    raise HTTPException(status_code=413, detail="Payload exceeds maximum limit of 60MB")
                buffer.write(chunk)
        scan_path = temp_path
        should_delete = True
    else:
        raise HTTPException(status_code=400, detail="Either 'file' or 'file_path' must be provided.")

    try:
        # Pre-flight signature inspection
        with open(scan_path, "rb") as f_head:
            header_sample = f_head.read(64)
        sig = detect_magic_signature(header_sample)
        if not sig:
            if should_delete and os.path.exists(scan_path):
                os.remove(scan_path)
            is_quar, q_msg = rate_limiter.record_malformed_submission(client_ip)
            if is_quar:
                raise HTTPException(status_code=429, detail=q_msg)
            raise HTTPException(status_code=400, detail="File rejected: corrupt, malformed, or unsupported media signature.")

        pipeline = WardenPipeline(mode=mode, early_exit=early_exit, match_threshold=threshold)
        last_event = None
        async for ev in pipeline.process_media_stream(scan_path):
            if ev["type"] == "VERDICT":
                last_event = ev
        return last_event
    finally:
        # Strict Zero Raw Media Retention: delete temp file immediately upon scan conclusion if created by this endpoint
        if should_delete and scan_path and os.path.exists(scan_path):
            try:
                os.remove(scan_path)
            except Exception:
                pass

@app.websocket("/ws/pipeline")
async def websocket_pipeline(websocket: WebSocket):
    """
    Real-time interactive demonstration WebSocket.
    Streams video frames, bounding boxes, landmarks, deduplication tags,
    vector matching alignment telemetry, and terse monospace log lines.
    Enforces zero retention of uploaded media upon stream completion.
    """
    await websocket.accept()

    try:
        while True:
            raw_msg = await websocket.receive_text()
            data = json.loads(raw_msg)
            action = data.get("action")

            if action == "start":
                sample_id = data.get("sample_id")
                file_path = data.get("file_path")
                mode = data.get("mode", "guard")
                early_exit = bool(data.get("early_exit", False))
                threshold = float(data.get("threshold", 0.50))

                target_file = None
                if sample_id:
                    target_file = os.path.join(SAMPLES_DIR, sample_id)
                elif file_path:
                    target_file = file_path

                if not target_file or not os.path.exists(target_file):
                    await websocket.send_json({
                        "type": "ERROR",
                        "message": f"Target file not found: {target_file}"
                    })
                    continue

                pipeline = WardenPipeline(
                    mode=mode,
                    early_exit=early_exit,
                    match_threshold=threshold
                )

                try:
                    async for event in pipeline.process_media_stream(target_file):
                        await websocket.send_json(event)
                        # Pacing for human readability during video demonstration
                        if event["type"] == "FRAME_PROCESSED":
                            await asyncio.sleep(0.02)
                        elif event["type"] in ("FACE_QUEUED", "FACE_COMPARING", "FACE_MATCH_RESULT", "FACE_DEDUPLICATED"):
                            await asyncio.sleep(0.01)

                    await websocket.send_json({
                        "type": "PIPELINE_COMPLETE",
                        "message": "[Pipeline Complete] Execution cycle concluded."
                    })
                finally:
                    # Strict Zero Retention Policy:
                    # Clean up temporary user uploads immediately after processing concludes
                    if target_file and target_file.startswith(UPLOADS_DIR) and os.path.exists(target_file):
                        try:
                            os.remove(target_file)
                            logger.info(f"[ZeroRetention] Purged temporary upload after stream completion: {target_file}")
                        except Exception:
                            pass

            elif action == "ping":
                await websocket.send_json({"type": "PONG"})

    except WebSocketDisconnect:
        pass
    except Exception as e:
        try:
            await websocket.send_json({"type": "ERROR", "message": str(e)})
        except:
            pass

# Serve samples directory
if os.path.exists(SAMPLES_DIR):
    app.mount("/backend/samples", StaticFiles(directory=SAMPLES_DIR), name="samples")

# Serve extension directory for direct browser testbench accessibility
EXTENSION_DIR = os.path.join(BASE_DIR, "extension")
if os.path.exists(EXTENSION_DIR):
    app.mount("/extension", StaticFiles(directory=EXTENSION_DIR), name="extension")

# Serve static frontend files
if os.path.exists(FRONTEND_DIR):
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")


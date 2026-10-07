"""
Warden Security & Hardening Architecture Module
================================================
Comprehensive protection against corrupt, malformed, or sabotaged media,
API-level rate limiting, authentication, fail-safe defaults, and registration-time anti-replay.
"""

import os
import time
import hmac
import hashlib
import binascii
import logging
from typing import Tuple, Optional, Dict, Any, List, Union
import numpy as np
import cv2
from PIL import Image

logger = logging.getLogger("warden.security")
if not logger.handlers:
    logging.basicConfig(level=logging.INFO)

# ==============================================================================
# 1. CONSTANTS & RESOURCE CEILINGS
# ==============================================================================

MAX_IMAGE_FILE_SIZE = 15 * 1024 * 1024    # 15 MB
MAX_VIDEO_FILE_SIZE = 60 * 1024 * 1024    # 60 MB
MAX_IMAGE_PIXELS = 40_000_000             # 40 Megapixels max (decompression bomb protection)
MAX_IMAGE_DIM = 8192                      # 8192px width or height
MAX_VIDEO_DURATION_SEC = 300.0            # 5 minutes max video scan
MAX_VIDEO_FRAMES = 15_000                 # 15,000 frames max
MIN_VIDEO_BITRATE_BPS = 20.0              # Bytes per second (reject implausible ratio)

WARDEN_API_KEY_DEFAULT = os.environ.get("WARDEN_API_KEY", "warden-dev-key-9941")
HMAC_SECRET = os.environ.get("WARDEN_SECRET_KEY", "warden-liveness-secret-88421").encode("utf-8")


# ==============================================================================
# 2. FILE SIGNATURE & MAGIC BYTES INSPECTION
# ==============================================================================

MAGIC_SIGNATURES: Dict[str, List[bytes]] = {
    "JPEG": [b"\xFF\xD8\xFF"],
    "PNG": [b"\x89PNG\r\n\x1a\n"],
    "WEBP": [b"RIFF"],   # Needs secondary check: offset 8 has b"WEBP"
    "GIF": [b"GIF87a", b"GIF89a"],
    "MP4": [b"ftyp"],    # offset 4..16 usually contains b"ftyp"
    "WEBM": [b"\x1a\x45\xdf\xa3"], # Matroska / WebM EBML header
    "AVI": [b"RIFF"],   # Needs secondary check: offset 8 has b"AVI "
}


def detect_magic_signature(header: bytes) -> Optional[str]:
    """
    Detects media format using binary magic bytes / file signatures.
    Never trusts file extensions or declared MIME headers alone.
    """
    if len(header) < 16:
        return None

    # Check JPEG
    if header.startswith(b"\xFF\xD8\xFF"):
        return "JPEG"

    # Check PNG
    if header.startswith(b"\x89PNG\r\n\x1a\n"):
        return "PNG"

    # Check WEBP: "RIFF" .... "WEBP"
    if header.startswith(b"RIFF") and len(header) >= 12 and header[8:12] == b"WEBP":
        return "WEBP"

    # Check AVI: "RIFF" .... "AVI "
    if header.startswith(b"RIFF") and len(header) >= 12 and header[8:12] == b"AVI ":
        return "AVI"

    # Check Matroska / WebM EBML
    if header.startswith(b"\x1a\x45\xdf\xa3"):
        return "WEBM"

    # Check MP4 / QuickTime / MOV: 'ftyp' in first 24 bytes
    for offset in range(4, min(len(header) - 4, 24)):
        if header[offset:offset+4] == b"ftyp":
            return "MP4"

    # Check GIF
    if header.startswith(b"GIF87a") or header.startswith(b"GIF89a"):
        return "GIF"

    return None


# ==============================================================================
# 3. DECOMPRESSION BOMB & RESOLUTION VALIDATION
# ==============================================================================

def preflight_image_dimensions(file_bytes: bytes) -> Tuple[bool, int, int, str]:
    """
    Inspects image dimensions before full decompression memory allocation.
    Returns: (is_safe, width, height, message)
    """
    # 1. Parse PNG IHDR chunk (Width: bytes 16..20, Height: bytes 20..24)
    if file_bytes.startswith(b"\x89PNG\r\n\x1a\n") and len(file_bytes) >= 24:
        try:
            w = int.from_bytes(file_bytes[16:20], "big")
            h = int.from_bytes(file_bytes[20:24], "big")
            if w <= 0 or h <= 0:
                return False, 0, 0, "Corrupt PNG zero or negative dimensions"
            if w > MAX_IMAGE_DIM or h > MAX_IMAGE_DIM or (w * h) > MAX_IMAGE_PIXELS:
                return False, w, h, f"Decompression bomb detected: {w}x{h} exceeds max limits ({MAX_IMAGE_PIXELS} px)"
            return True, w, h, "OK"
        except Exception as e:
            return False, 0, 0, f"Malformed PNG header: {str(e)}"

    # 2. General safe inspection via PIL lazy header parser
    try:
        Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS
        import io
        with Image.open(io.BytesIO(file_bytes)) as pil_img:
            w, h = pil_img.size
            if w <= 0 or h <= 0:
                return False, 0, 0, "Corrupt image with zero dimensions"
            if w > MAX_IMAGE_DIM or h > MAX_IMAGE_DIM or (w * h) > MAX_IMAGE_PIXELS:
                return False, w, h, f"Decompression bomb detected: {w}x{h} ({w*h} pixels exceeds ceiling)"
            return True, w, h, "OK"
    except Image.DecompressionBombError as e:
        return False, 0, 0, f"Decompression bomb blocked: {str(e)}"
    except Exception as e:
        return False, 0, 0, f"Unreadable image header: {str(e)}"


# ==============================================================================
# 4. VIDEO PLAUSIBILITY & CONTAINER SAFETY
# ==============================================================================

def validate_video_container(file_path: str, file_size: int) -> Tuple[bool, str, Dict[str, Any]]:
    """
    Probes video metadata to reject implausible duration/bitrate/frame ratio
    attacks before full sequential decoding commences.
    """
    if file_size > MAX_VIDEO_FILE_SIZE:
        return False, f"Video file size {file_size/(1024*1024):.1f}MB exceeds limit of {MAX_VIDEO_FILE_SIZE/(1024*1024)}MB", {}

    cap = cv2.VideoCapture(file_path)
    if not cap.isOpened():
        cap.release()
        return False, "Could not initialize video decoder on container", {}

    try:
        w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        fps = float(cap.get(cv2.CAP_PROP_FPS) or 0.0)
        frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)

        # 1. Geometry sanity check
        if w <= 0 or h <= 0:
            return False, f"Invalid video frame resolution: {w}x{h}", {}
        if w > MAX_IMAGE_DIM or h > MAX_IMAGE_DIM:
            return False, f"Video frame resolution {w}x{h} exceeds max ceiling ({MAX_IMAGE_DIM}px)", {}

        # 2. FPS & Duration plausibility
        if fps < 0.1 or fps > 240.0:
            return False, f"Implausible video frame rate: {fps:.2f} FPS", {}

        duration_sec = (frames / fps) if (frames > 0 and fps > 0) else 0.0

        if duration_sec > MAX_VIDEO_DURATION_SEC:
            return False, f"Video duration {duration_sec:.1f}s exceeds max limit of {MAX_VIDEO_DURATION_SEC}s", {}
        if frames > MAX_VIDEO_FRAMES:
            return False, f"Video frame count {frames} exceeds max processing ceiling of {MAX_VIDEO_FRAMES}", {}

        # 3. Implausible Bitrate / Decompression Bomb Ratio
        # A tiny file claiming massive frame counts is a known parser-bomb attack
        if frames > 1000 and file_size < 20_000:
            return False, f"Implausible frame-to-size ratio: {frames} frames in only {file_size} bytes", {}

        if duration_sec > 60.0 and (file_size / max(1.0, duration_sec)) < MIN_VIDEO_BITRATE_BPS:
            return False, f"Implausible video bitrate: file size {file_size}b for {duration_sec:.1f}s", {}

        return True, "OK", {
            "width": w,
            "height": h,
            "fps": fps,
            "frames": frames,
            "duration": round(duration_sec, 2)
        }
    finally:
        cap.release()


# ==============================================================================
# 5. TENSOR & DECODER OUTPUT VALIDATION
# ==============================================================================

def validate_tensor_frame(frame: Any) -> Tuple[bool, str]:
    """
    Validates decoder output before passing to neural models (YuNet/SFace).
    Catches zero-dimension buffers, NaN/Inf values, corrupted pixel buffers, and out-of-range arrays.
    """
    if frame is None:
        return False, "Frame is None"

    if not isinstance(frame, np.ndarray):
        return False, f"Frame is not a numpy ndarray, got {type(frame)}"

    if frame.ndim != 3:
        return False, f"Expected 3-dimensional BGR tensor, got {frame.ndim} dimensions"

    h, w, c = frame.shape
    if h <= 0 or w <= 0 or c != 3:
        return False, f"Invalid tensor shape: ({h}, {w}, {c})"

    if frame.dtype != np.uint8:
        return False, f"Invalid frame dtype: expected uint8, got {frame.dtype}"

    # Check for NaN or Inf (rare on uint8, but defensive against invalid memory buffers)
    if np.isnan(frame).any() or np.isinf(frame).any():
        return False, "Frame tensor contains NaN or Infinite numerical values"

    # Value range check
    min_val, max_val = int(frame.min()), int(frame.max())
    if min_val < 0 or max_val > 255:
        return False, f"Pixel values out of 0..255 range: [{min_val}, {max_val}]"

    return True, "OK"


# ==============================================================================
# 6. SAFE DECODING WITH EXCEPTION ISOLATION
# ==============================================================================

def safe_decode_image(data: Union[bytes, str]) -> Tuple[bool, Optional[np.ndarray], str]:
    """
    Safely decodes an image with pre-flight signature checks, decompression bomb
    protection, and tensor validation.
    """
    raw_bytes: bytes = b""

    try:
        if isinstance(data, str):
            if os.path.exists(data):
                with open(data, "rb") as f:
                    raw_bytes = f.read()
            else:
                return False, None, f"File not found: {data}"
        elif isinstance(data, bytes):
            raw_bytes = data
        else:
            return False, None, "Invalid input type for image decoding"

        # 1. Size check
        if len(raw_bytes) == 0:
            return False, None, "Uploaded media is 0 bytes (empty buffer)"
        if len(raw_bytes) > MAX_IMAGE_FILE_SIZE:
            return False, None, f"Image size exceeds limit of {MAX_IMAGE_FILE_SIZE / (1024*1024)}MB"

        # 2. Magic bytes verification
        sig = detect_magic_signature(raw_bytes[:32])
        if sig not in ("JPEG", "PNG", "WEBP", "GIF"):
            return False, None, f"Invalid or sabotaged file signature: detected {sig or 'UNKNOWN'}"

        # 3. Pre-flight dimension inspection
        safe_dim, w, h, dim_msg = preflight_image_dimensions(raw_bytes)
        if not safe_dim:
            return False, None, f"Image validation failed: {dim_msg}"

        # 4. Safe decode via OpenCV
        nparr = np.frombuffer(raw_bytes, np.uint8)
        img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        if img is None:
            return False, None, "Decoder returned None (corrupt or unreadable image stream)"

        # 5. Tensor validation
        valid_tensor, t_msg = validate_tensor_frame(img)
        if not valid_tensor:
            return False, None, f"Decoder output failed tensor validation: {t_msg}"

        return True, img, "OK"

    except Exception as e:
        logger.error(f"[SafeDecode] Unexpected decoding failure: {str(e)}", exc_info=True)
        return False, None, "Malformed or corrupt image could not be processed safely."


def safe_sandboxed_decode_image(data: Union[bytes, str], timeout_sec: float = 5.0) -> Tuple[bool, Optional[np.ndarray], str]:
    """
    Decodes image inside a sandboxed/isolated child process with a hard timeout ceiling.
    Protects the main process against parser hangs, memory blowouts, and segfaults.
    """
    import tempfile
    import subprocess
    import uuid
    import sys

    temp_in = None
    temp_out = None
    try:
        if isinstance(data, str) and os.path.exists(data):
            input_file = data
        elif isinstance(data, (bytes, bytearray)):
            temp_fd, temp_in = tempfile.mkstemp(suffix=".tmp", prefix="warden_sandbox_in_")
            os.close(temp_fd)
            with open(temp_in, "wb") as f:
                f.write(data)
            input_file = temp_in
        else:
            return False, None, "Invalid input data for sandboxed decode"

        temp_out = os.path.join(tempfile.gettempdir(), f"warden_tensor_{uuid.uuid4().hex[:12]}.npy")

        # Execute sandboxed worker
        decoder_script = os.path.join(os.path.dirname(__file__), "isolated_decoder.py")
        cmd = [sys.executable, decoder_script, "--input", input_file, "--output", temp_out]

        proc = subprocess.run(cmd, capture_output=True, timeout=timeout_sec)
        if proc.returncode == 0 and os.path.exists(temp_out):
            tensor = np.load(temp_out)
            return True, tensor, "OK"

        # Handle failure cases
        stderr_msg = proc.stderr.decode("utf-8", errors="ignore").strip()
        if stderr_msg.startswith("ERROR:"):
            clean_err = stderr_msg[6:]
        else:
            clean_err = "Corrupt or unreadable image stream"

        return False, None, f"Sandboxed decode failed: {clean_err}"

    except subprocess.TimeoutExpired:
        logger.warning(f"[SecurityCeiling] Sandboxed image decoder timed out after {timeout_sec}s")
        return False, None, f"Image decoding timed out ({timeout_sec}s ceiling exceeded)"
    except Exception as e:
        logger.error(f"[SandboxedDecode] Fallback to safe internal decode: {str(e)}")
        return safe_decode_image(data)
    finally:
        if temp_in and os.path.exists(temp_in):
            try:
                os.remove(temp_in)
            except Exception:
                pass
        if temp_out and os.path.exists(temp_out):
            try:
                os.remove(temp_out)
            except Exception:
                pass



# ==============================================================================
# 7. CLIENT RATE LIMITING & MALFORMED PROBE QUARANTINE
# ==============================================================================

class SecurityRateLimiter:
    """
    Per-client sliding-window rate limiter with automated throttling of callers
    that submit repeated malformed/corrupted files.
    """
    def __init__(self, request_limit_per_min: int = 360, max_malformed_probes: int = 30, quarantine_sec: int = 300):
        self.request_limit = request_limit_per_min
        self.max_malformed = max_malformed_probes
        self.quarantine_sec = quarantine_sec

        self.client_requests: Dict[str, List[float]] = {}
        self.client_malformed: Dict[str, List[float]] = {}
        self.quarantine_until: Dict[str, float] = {}

    def is_quarantined(self, client_id: str) -> Tuple[bool, int]:
        now = time.time()
        until = self.quarantine_until.get(client_id, 0.0)
        if now < until:
            remaining = int(until - now)
            return True, remaining
        return False, 0

    def record_request(self, client_id: str) -> Tuple[bool, str]:
        now = time.time()
        quarantined, rem = self.is_quarantined(client_id)
        if quarantined:
            return False, f"Client temporarily quarantined ({rem}s remaining) due to excessive malformed uploads"

        window = now - 60.0
        reqs = [t for t in self.client_requests.get(client_id, []) if t > window]
        reqs.append(now)
        self.client_requests[client_id] = reqs

        if len(reqs) > self.request_limit:
            return False, f"Rate limit exceeded ({self.request_limit} requests/minute)"

        return True, "OK"

    def record_malformed_submission(self, client_id: str) -> Tuple[bool, str]:
        """
        Records a corrupt/malformed upload attempt. If a threshold is crossed,
        automatically quarantines the client.
        """
        now = time.time()
        window = now - 60.0
        probes = [t for t in self.client_malformed.get(client_id, []) if t > window]
        probes.append(now)
        self.client_malformed[client_id] = probes

        if len(probes) >= self.max_malformed:
            self.quarantine_until[client_id] = now + self.quarantine_sec
            logger.warning(f"[SecurityAlert] Client {client_id} quarantined for {self.quarantine_sec}s: {len(probes)} malformed files in 60s")
            return True, f"Security Alert: Repeated malformed file submissions ({len(probes)} in 60s). Client throttled for {self.quarantine_sec}s."

        return False, f"Malformed file attempt recorded ({len(probes)}/{self.max_malformed})"


# Singleton Security Rate Limiter instance
rate_limiter = SecurityRateLimiter()


# ==============================================================================
# 8. REGISTRATION LIVENESS & ANTI-REPLAY ENGINE
# ==============================================================================

class RegistrationLivenessManager:
    """
    Validates that biometric enrolment streams originate from genuinely live camera
    capture rather than injected or replayed static imagery.
    """
    def __init__(self):
        self.active_sessions: Dict[str, Dict[str, Any]] = {}

    def create_registration_challenge(self) -> Dict[str, Any]:
        """
        Issues a time-stamped registration session token with a cryptographic HMAC.
        """
        nonce = binascii.hexlify(os.urandom(16)).decode("utf-8")
        issued_int = int(time.time())
        sig = hmac.new(HMAC_SECRET, f"{nonce}:{issued_int}".encode("utf-8"), hashlib.sha256).hexdigest()
        token = f"{nonce}.{issued_int}.{sig[:16]}"

        session_data = {
            "nonce": nonce,
            "issued_at": issued_int,
            "step_hashes": [],
            "completed_steps": set()
        }
        self.active_sessions[nonce] = session_data

        return {
            "challenge_token": token,
            "nonce": nonce,
            "expires_in_sec": 180,
            "required_steps": [
                {"step": 1, "action": "Frontal Neutral"},
                {"step": 2, "action": "Slight Left Turn (~15-20°)"},
                {"step": 3, "action": "Slight Right Turn (~15-20°)"},
                {"step": 4, "action": "Natural Smile"}
            ]
        }

    def validate_token(self, token: str) -> Tuple[bool, Optional[str], str]:
        if not token or "." not in token:
            return False, None, "Missing or malformed challenge token"

        parts = token.split(".")
        if len(parts) != 3:
            return False, None, "Invalid challenge token format"

        nonce, issued_str, client_sig = parts
        try:
            issued_at = float(issued_str)
        except ValueError:
            return False, None, "Invalid token timestamp"

        # Check token expiration (3 minutes)
        if time.time() - issued_at > 180.0:
            return False, None, "Registration session token expired. Please start a new capture."

        expected_sig = hmac.new(HMAC_SECRET, f"{nonce}:{int(issued_at)}".encode("utf-8"), hashlib.sha256).hexdigest()[:16]
        if not hmac.compare_digest(expected_sig, client_sig):
            return False, None, "Cryptographic challenge signature mismatch"

        return True, nonce, "OK"

    def compute_frame_phash(self, img_bgr: np.ndarray) -> np.ndarray:
        """Computes a compact downsampled perceptual signature for anti-replay diffing."""
        gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
        small = cv2.resize(gray, (32, 32), interpolation=cv2.INTER_AREA)
        return small

    def validate_anti_replay_and_entropy(
        self,
        current_img: np.ndarray,
        previous_imgs: List[np.ndarray],
        step_number: int
    ) -> Tuple[bool, str]:
        """
        Validates anti-replay and minimum frame entropy:
        1. Ensures frame is not a synthetic flat blackout or single-color buffer.
        2. Ensures the frame is not an identical static image replay of previous steps.
        """
        # 1. Entropy / Variance check (detects flat/blank camera feeds)
        variance = float(np.var(current_img))
        if variance < 8.0:
            return False, "Liveness failed: Camera frame has insufficient dynamic range or is blank/blackout."

        # 2. Anti-Replay check: compare against all previously captured step frames
        if previous_imgs and len(previous_imgs) > 0:
            curr_small = self.compute_frame_phash(current_img)

            for idx, prev in enumerate(previous_imgs):
                prev_small = self.compute_frame_phash(prev)
                # Compute normalized mean absolute pixel difference
                diff = float(np.mean(np.abs(curr_small.astype(np.float32) - prev_small.astype(np.float32))))

                # If difference is near-zero (< 1.6 out of 255), this is an identical static photo replay
                if diff < 1.6:
                    return False, f"Anti-Replay Alert: Step {step_number} is identical to Step {idx+1} (diff={diff:.2f}). Live movement/orientation change required."

        return True, "Liveness verified"


# Singleton Liveness Manager instance
liveness_manager = RegistrationLivenessManager()

import os
import cv2
import time
import base64
import numpy as np
from typing import AsyncGenerator, Dict, Any, List
try:
    from backend.models_loader import BiometricModels
    from backend.registry import VectorRegistry
except ImportError:
    from models_loader import BiometricModels
    from registry import VectorRegistry


class WardenPipeline:
    def __init__(self, mode: str = "guard", early_exit: bool = False, match_threshold: float = 0.50, dedup_threshold: float = 0.62):
        self.mode = mode.lower() # "guard" or "ledger"
        self.early_exit = early_exit
        self.match_threshold = match_threshold
        self.dedup_threshold = dedup_threshold
        self.models = BiometricModels.get_instance()
        self.registry = VectorRegistry.get_instance()


    def _encode_image_b64(self, img_bgr: np.ndarray, quality: int = 80) -> str:
        """Converts an OpenCV BGR image into a base64 JPEG string for WebSocket transmission."""
        encode_param = [int(cv2.IMWRITE_JPEG_QUALITY), quality]
        success, buffer = cv2.imencode(".jpg", img_bgr, encode_param)
        if not success:
            return ""
        return base64.b64encode(buffer).decode("utf-8")

    def _preprocess_frame(self, frame_bgr: np.ndarray, max_dim: int = 640):
        """
        Resolution-Tiered Preprocessing: downscales large media for low-latency inference.
        Returns: (processed_frame, scale_factor, original_dimensions)
        """
        orig_h, orig_w = frame_bgr.shape[:2]
        if max(orig_h, orig_w) <= max_dim:
            return frame_bgr, 1.0, (orig_w, orig_h)

        if orig_w >= orig_h:
            new_w = max_dim
            new_h = int(orig_h * (max_dim / orig_w))
        else:
            new_h = max_dim
            new_w = int(orig_w * (max_dim / orig_h))

        resized = cv2.resize(frame_bgr, (new_w, new_h), interpolation=cv2.INTER_AREA)
        scale_factor = new_w / orig_w
        return resized, scale_factor, (orig_w, orig_h)

    async def process_media_stream(self, file_path: str) -> AsyncGenerator[Dict[str, Any], None]:
        """
        Main pipeline execution engine yielding live telemetry events for WebSockets.
        Implements Steps 1 through 7 of the Warden PRD.
        """
        # Always synchronize FAISS index with database before running scan
        self.registry.reload()

        is_video = file_path.lower().endswith((".mp4", ".avi", ".mov", ".mkv", ".webm"))
        content_type = "VIDEO" if is_video else "IMAGE"

        # Telemetry State
        session_faces: List[Dict[str, Any]] = [] # Tracked identities inside this content for dedup
        detected_ledger_records: List[Dict[str, Any]] = []
        flagged_count = 0
        cleared_count = 0
        total_faces_encountered = 0
        face_counter = 0

        yield {
            "type": "PIPELINE_START",
            "timestamp": time.time(),
            "content_type": content_type,
            "mode": self.mode,
            "early_exit": self.early_exit,
            "threshold": self.match_threshold,
            "message": f"[Pipeline Init] Mode: {self.mode.upper()} | Type: {content_type} | FAISS Registry size: {self.registry.index.ntotal} vectors"
        }

        # Step 0: Robustness & Input Validation Before Any Decoding
        try:
            from backend.security import (
                detect_magic_signature,
                safe_decode_image,
                safe_sandboxed_decode_image,
                validate_video_container,
                validate_tensor_frame
            )
        except ImportError:
            from security import (
                detect_magic_signature,
                safe_decode_image,
                safe_sandboxed_decode_image,
                validate_video_container,
                validate_tensor_frame
            )

        if not os.path.exists(file_path):
            yield {"type": "ERROR", "message": f"Target file not found: {file_path}"}
            yield {
                "type": "VERDICT",
                "mode": self.mode,
                "verdict": "BLOCK" if self.mode == "guard" else "RECORDED_ERROR",
                "description": "File not found or unreadable. Gated under fail-safe policy.",
                "flagged_count": 1,
                "cleared_count": 0,
                "unique_identities_count": 0,
                "total_detections": 0,
                "ledger": [],
                "completed_at": time.time()
            }
            return

        file_size = os.path.getsize(file_path)
        with open(file_path, "rb") as f_head:
            header_sample = f_head.read(64)

        sig = detect_magic_signature(header_sample)
        if not sig:
            yield {
                "type": "LOG",
                "level": "WARN",
                "step": "SECURITY",
                "message": f"[Security Gate] Invalid/corrupted magic bytes signature (header: {header_sample[:8]!r})"
            }
            yield {"type": "ERROR", "message": "File rejected: corrupt, malformed, or unsupported binary signature."}
            yield {
                "type": "VERDICT",
                "mode": self.mode,
                "verdict": "BLOCK" if self.mode == "guard" else "RECORDED_ERROR",
                "description": "Media corrupt or sabotaged (unrecognized signature). Gated under fail-safe policy.",
                "flagged_count": 1,
                "cleared_count": 0,
                "unique_identities_count": 0,
                "total_detections": 0,
                "ledger": [],
                "completed_at": time.time()
            }
            return

        if not is_video:
            # Safe Sandboxed Image Decoding in Isolated Subprocess with Hard Timeout
            safe_ok, img, dec_err = safe_sandboxed_decode_image(file_path, timeout_sec=5.0)
            if not safe_ok or img is None:
                yield {
                    "type": "LOG",
                    "level": "WARN",
                    "step": "SECURITY",
                    "message": f"[Security Gate] Image decode blocked in sandbox: {dec_err}"
                }
                yield {"type": "ERROR", "message": f"Image decoding rejected: {dec_err}"}
                yield {
                    "type": "VERDICT",
                    "mode": self.mode,
                    "verdict": "BLOCK" if self.mode == "guard" else "RECORDED_ERROR",
                    "description": f"Image unprocessable ({dec_err}). Gated under fail-safe policy.",
                    "flagged_count": 1,
                    "cleared_count": 0,
                    "unique_identities_count": 0,
                    "total_detections": 0,
                    "ledger": [],
                    "completed_at": time.time()
                }
                return

            proc_img, scale, (ow, oh) = self._preprocess_frame(img, max_dim=720)
            yield {
                "type": "LOG",
                "level": "INFO",
                "step": "PREPROCESS",
                "message": f"[Step 1: Preprocess] Resolution: {ow}x{oh} -> Tiered scale: {proc_img.shape[1]}x{proc_img.shape[0]} (Factor: {scale:.2f})"
            }

            # Per-frame face detection
            t0 = time.perf_counter()
            faces = self.models.detect_faces(proc_img, score_threshold=0.45)
            det_latency = (time.perf_counter() - t0) * 1000

            yield {
                "type": "LOG",
                "level": "INFO",
                "step": "DETECTION",
                "message": f"[Step 3: Face Detection] YuNet inference completed in {det_latency:.1f}ms | Faces located: {len(faces)}"
            }

            # Build UI frame with overlay
            overlay_frame = proc_img.copy()
            frame_faces_data = []

            for f in faces:
                total_faces_encountered += 1
                face_counter += 1
                face_id = f"Face_{face_counter:02d}"

                bbox = f["bbox"] # [x, y, w, h]
                conf = f["conf"]
                landmarks = f["landmarks"]

                # Extract crop
                crop = self.models.crop_face(proc_img, bbox)
                crop_b64 = self._encode_image_b64(crop, quality=85)

                # Generate 128-d embedding
                t_emb = time.perf_counter()
                embedding = self.models.extract_embedding(proc_img, f["raw"])
                emb_latency = (time.perf_counter() - t_emb) * 1000

                yield {
                    "type": "FACE_QUEUED",
                    "face_id": face_id,
                    "confidence": conf,
                    "bbox": bbox,
                    "crop_b64": crop_b64,
                    "status": "QUEUED",
                    "message": f"[{face_id}] Enqueued for vector matching (conf: {conf:.2f})"
                }

                # Step 4: Intra-Content Deduplication (Single image is trivial, but checks multi-faces)
                is_duplicate = False
                matched_session_id = None
                for s_face in session_faces:
                    sim = float(np.dot(embedding.flatten(), s_face["embedding"].flatten()))
                    if sim >= self.dedup_threshold:
                        is_duplicate = True
                        matched_session_id = s_face["face_id"]
                        break

                if is_duplicate:
                    yield {
                        "type": "FACE_DEDUPLICATED",
                        "face_id": face_id,
                        "matched_session_id": matched_session_id,
                        "crop_b64": crop_b64,
                        "status": "DISCARDED",
                        "message": f"[Step 4: Deduplication] {face_id} matches already-identified {matched_session_id} -> Bypassing registry lookup"
                    }
                else:
                    session_faces.append({
                        "face_id": face_id,
                        "embedding": embedding,
                        "crop_b64": crop_b64
                    })

                # Step 5 & 6: FAISS Vector Registry Lookup
                yield {
                    "type": "FACE_COMPARING",
                    "face_id": face_id,
                    "vector_preview": [round(float(x), 4) for x in embedding.flatten()[:32]],
                    "status": "COMPARING",
                    "message": f"[Step 5 & 6: Vector ANN] Querying FAISS IndexFlatIP (dim=128) for {face_id}..."
                }


                search_res = self.registry.search_vector(embedding, top_k=1, threshold=self.match_threshold)
                sim = search_res.get("similarity", 0.0)
                matched = search_res.get("matched", False)
                registrant = search_res.get("registrant", None)
                conf_pct = search_res.get("confidence_percent", round(sim * 100, 1))
                vec_preview = search_res.get("vector_preview") or [round(float(x), 4) for x in embedding.flatten()[:32]]

                if matched and registrant:
                    flagged_count += 1
                    status = "FLAGGED"
                    record = {
                        "face_id": face_id,
                        "registrant_id": registrant["registrant_id"],
                        "name": registrant["name"],
                        "affiliation": registrant["affiliation"],
                        "consent_id": registrant["consent_id"],
                        "similarity": sim,
                        "frame_index": 0,
                        "timestamp": "00:00:00"
                    }
                    detected_ledger_records.append(record)

                    yield {
                        "type": "FACE_MATCH_RESULT",
                        "face_id": face_id,
                        "status": status,
                        "similarity": sim,
                        "confidence_percent": conf_pct,
                        "registrant": registrant,
                        "vector_preview": vec_preview,
                        "message": f"MATCH DETECTED: {face_id} -> {registrant['name']} (Sim: {sim*100:.1f}%)"
                    }
                else:
                    cleared_count += 1
                    if not is_duplicate:
                        status = "CLEARED"
                        yield {
                            "type": "FACE_MATCH_RESULT",
                            "face_id": face_id,
                            "status": status,
                            "similarity": sim,
                            "confidence_percent": conf_pct,
                            "registrant": None,
                            "vector_preview": vec_preview,
                            "message": f"CLEARED: {face_id} -> No protected likeness match (Max sim: {sim*100:.1f}%)"
                        }
                    else:
                        status = "DEDUP_DISCARD"

                frame_faces_data.append({
                    "face_id": face_id,
                    "bbox": bbox,
                    "conf": conf,
                    "landmarks": landmarks,
                    "status": status
                })

            # Send single frame preview event with overlays
            yield {
                "type": "FRAME_PROCESSED",
                "frame_index": 0,
                "total_frames": 1,
                "fps": 0,
                "faces_in_frame": len(faces),
                "faces_data": frame_faces_data,
                "frame_b64": self._encode_image_b64(proc_img, quality=75)
            }

        else:
            # Video Container Plausibility Validation (Step 0)
            valid_vid, vid_err, vid_meta = validate_video_container(file_path, file_size)
            if not valid_vid:
                yield {
                    "type": "LOG",
                    "level": "WARN",
                    "step": "SECURITY",
                    "message": f"[Security Gate] Video container plausibility check failed: {vid_err}"
                }
                yield {"type": "ERROR", "message": f"Video validation rejected: {vid_err}"}
                yield {
                    "type": "VERDICT",
                    "mode": self.mode,
                    "verdict": "BLOCK" if self.mode == "guard" else "RECORDED_ERROR",
                    "description": f"Video rejected ({vid_err}). Gated under fail-safe policy.",
                    "flagged_count": 1,
                    "cleared_count": 0,
                    "unique_identities_count": 0,
                    "total_detections": 0,
                    "ledger": [],
                    "completed_at": time.time()
                }
                return

            # Video Processing with Adaptive Temporal Sampling (Step 2)
            cap = cv2.VideoCapture(file_path)
            if not cap.isOpened():
                yield {
                    "type": "ERROR",
                    "message": f"Could not initialize video decoder on container: {file_path}"
                }
                yield {
                    "type": "VERDICT",
                    "mode": self.mode,
                    "verdict": "BLOCK" if self.mode == "guard" else "RECORDED_ERROR",
                    "description": "Video stream could not be decoded. Gated under fail-safe policy.",
                    "flagged_count": 1,
                    "cleared_count": 0,
                    "unique_identities_count": 0,
                    "total_detections": 0,
                    "ledger": [],
                    "completed_at": time.time()
                }
                return

            total_video_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
            fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
            video_duration = total_video_frames / fps

            # Sample 2 to 3 frames per second for real-time responsiveness
            sample_interval = max(1, int(fps / 2.5))

            yield {
                "type": "LOG",
                "level": "INFO",
                "step": "SAMPLING",
                "message": f"[Step 2: Adaptive Sampling] Total frames: {total_video_frames} ({video_duration:.1f}s) | Sample rate: 1 every {sample_interval} frames"
            }

            frame_idx = 0
            processed_count = 0
            aborted_early = False
            scan_start_time = time.time()

            while cap.isOpened():
                # Resource Exhaustion Ceiling (35 seconds max for streaming video)
                if (time.time() - scan_start_time) > 35.0:
                    yield {
                        "type": "LOG",
                        "level": "WARN",
                        "step": "RESOURCE_LIMIT",
                        "message": "[Resource Ceiling] Per-request processing time limit reached. Halting stream safely."
                    }
                    break

                ret, frame = cap.read()
                if not ret or frame is None:
                    break

                # Validate decoder frame output
                valid_frame, frame_err = validate_tensor_frame(frame)
                if not valid_frame:
                    yield {
                        "type": "LOG",
                        "level": "WARN",
                        "step": "SECURITY",
                        "message": f"[Frame {frame_idx:04d}] Decoder emitted unvalidated/corrupt frame ({frame_err}) -> Skipping"
                    }
                    frame_idx += 1
                    continue

                if frame_idx % sample_interval != 0:
                    frame_idx += 1
                    continue

                processed_count += 1
                curr_time_sec = frame_idx / fps
                time_str = f"{int(curr_time_sec//60):02d}:{int(curr_time_sec%60):02d}"

                proc_frame, scale, (ow, oh) = self._preprocess_frame(frame, max_dim=640)

                # Face detection
                faces = self.models.detect_faces(proc_frame, score_threshold=0.45)
                frame_faces_data = []


                yield {
                    "type": "LOG",
                    "level": "DEBUG",
                    "step": "FRAME_SCAN",
                    "message": f"[Frame {frame_idx:04d} @ {time_str}] YuNet inference -> {len(faces)} faces detected"
                }

                for f in faces:
                    total_faces_encountered += 1
                    face_counter += 1
                    face_id = f"Face_{face_counter:02d}"

                    bbox = f["bbox"]
                    conf = f["conf"]
                    landmarks = f["landmarks"]

                    crop = self.models.crop_face(proc_frame, bbox)
                    crop_b64 = self._encode_image_b64(crop, quality=80)

                    # Extract embedding
                    embedding = self.models.extract_embedding(proc_frame, f["raw"])

                    # Step 4: Intra-Content Identity Deduplication
                    is_duplicate = False
                    matched_session_id = None
                    for s_face in session_faces:
                        sim = float(np.dot(embedding.flatten(), s_face["embedding"].flatten()))
                        if sim >= self.dedup_threshold:
                            is_duplicate = True
                            matched_session_id = s_face["face_id"]
                            break

                    if is_duplicate:
                        # Emit dedup message as requested, but perform the real registry lookup checkup!
                        yield {
                            "type": "FACE_DEDUPLICATED",
                            "face_id": face_id,
                            "frame_index": frame_idx,
                            "matched_session_id": matched_session_id,
                            "crop_b64": crop_b64,
                            "status": "DISCARDED",
                            "message": f"[Dedup] Face at frame {frame_idx} matches {matched_session_id} -> Bypassing registry lookup"
                        }
                    else:
                        # Unique face discovered in this content
                        session_faces.append({
                            "face_id": face_id,
                            "embedding": embedding,
                            "crop_b64": crop_b64
                        })

                        yield {
                            "type": "FACE_QUEUED",
                            "face_id": face_id,
                            "confidence": conf,
                            "bbox": bbox,
                            "crop_b64": crop_b64,
                            "frame_index": frame_idx,
                            "status": "QUEUED",
                            "message": f"[{face_id}] Enqueued new unique identity"
                        }

                    # Step 5 & 6: FAISS Vector ANN Search
                    search_res = self.registry.search_vector(embedding, top_k=1, threshold=self.match_threshold)
                    sim = search_res.get("similarity", 0.0)
                    matched = search_res.get("matched", False)
                    registrant = search_res.get("registrant", None)
                    conf_pct = search_res.get("confidence_percent", round(sim * 100, 1))
                    vec_preview = search_res.get("vector_preview") or [round(float(x), 4) for x in embedding.flatten()[:32]]

                    if matched and registrant:
                        flagged_count += 1
                        status = "FLAGGED"
                        detected_ledger_records.append({
                            "face_id": face_id,
                            "registrant_id": registrant["registrant_id"],
                            "name": registrant["name"],
                            "affiliation": registrant["affiliation"],
                            "consent_id": registrant["consent_id"],
                            "similarity": sim,
                            "frame_index": frame_idx,
                            "timestamp": time_str
                        })

                        yield {
                            "type": "FACE_MATCH_RESULT",
                            "face_id": face_id,
                            "status": status,
                            "similarity": sim,
                            "confidence_percent": conf_pct,
                            "registrant": registrant,
                            "vector_preview": vec_preview,
                            "frame_index": frame_idx,
                            "message": f"MATCH DETECTED: {face_id} matches protected {registrant['name']} ({sim*100:.1f}%)"
                        }

                        # Check early exit toggle
                        if self.early_exit and self.mode == "guard":
                            aborted_early = True
                            frame_faces_data.append({
                                "face_id": face_id,
                                "bbox": bbox,
                                "conf": conf,
                                "landmarks": landmarks,
                                "status": status
                            })
                            break
                    else:
                        cleared_count += 1
                        if not is_duplicate:
                            status = "CLEARED"
                            yield {
                                "type": "FACE_MATCH_RESULT",
                                "face_id": face_id,
                                "status": status,
                                "similarity": sim,
                                "confidence_percent": conf_pct,
                                "registrant": None,
                                "vector_preview": vec_preview,
                                "frame_index": frame_idx,
                                "message": f"CLEARED: {face_id} has no registered match ({sim*100:.1f}%)"
                            }
                        else:
                            status = "DEDUP_DISCARD"

                    frame_faces_data.append({
                        "face_id": face_id,
                        "bbox": bbox,
                        "conf": conf,
                        "landmarks": landmarks,
                        "status": status
                    })

                yield {
                    "type": "FRAME_PROCESSED",
                    "frame_index": frame_idx,
                    "total_frames": total_video_frames,
                    "time_str": time_str,
                    "fps": round(fps, 1),
                    "faces_in_frame": len(faces),
                    "faces_data": frame_faces_data,
                    "frame_b64": self._encode_image_b64(proc_frame, quality=70)
                }

                if aborted_early:
                    yield {
                        "type": "LOG",
                        "level": "WARN",
                        "step": "EARLY_EXIT",
                        "message": f"[Guard Policy] Early-exit triggered upon positive likeness match at frame {frame_idx}. Gating decision locked."
                    }
                    break

                frame_idx += 1
                # Small yield pause to simulate streaming pacing for smooth visualization
                # time.sleep(0.02)

            cap.release()

        # Step 7: Verdict Formulation
        final_verdict = "BLOCK" if flagged_count > 0 else "PASS"
        if self.mode == "ledger":
            verdict_desc = f"Scan complete. {len(detected_ledger_records)} registered individual instances detected across content."
        else:
            if final_verdict == "BLOCK":
                names = list(dict.fromkeys([r.get("name", "Protected Registrant") for r in detected_ledger_records if r.get("name")]))
                names_str = ", ".join(names) if names else "the individual present"
                verdict_desc = (
                    f"We have not obtained consent from the person(s) present ({names_str}). "
                    f"Even if this person follows you or is connected with you, they have not given consent to upload "
                    f"pictures or videos containing their likeness. Either obtain explicit verified consent from {names_str} "
                    f"or censor/blur their face."
                )
            else:
                verdict_desc = "No protected identities detected. Content cleared for publishing."

        yield {
            "type": "VERDICT",
            "mode": self.mode,
            "verdict": final_verdict,
            "description": verdict_desc,
            "flagged_count": flagged_count,
            "cleared_count": cleared_count,
            "unique_identities_count": len(session_faces),
            "total_detections": total_faces_encountered,
            "ledger": detected_ledger_records,
            "completed_at": time.time()
        }

    def scan_sync(self, file_path: str) -> Dict[str, Any]:
        """
        Synchronous batch scan returning the final verdict and audit ledger.
        Used for direct REST API integrations.
        """
        import asyncio
        async def _run():
            last_event = None
            async for ev in self.process_media_stream(file_path):
                if ev["type"] == "VERDICT":
                    last_event = ev
            return last_event
        return asyncio.run(_run())

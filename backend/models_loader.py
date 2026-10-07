import os
import cv2
import numpy as np

# Path configurations
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
YUNET_PATH = os.path.join(BASE_DIR, "models", "face_detection_yunet.onnx")
SFACE_PATH = os.path.join(BASE_DIR, "models", "face_recognition_sface.onnx")

class BiometricModels:
    _instance = None

    def __init__(self):
        if not os.path.exists(YUNET_PATH):
            raise FileNotFoundError(f"YuNet model not found at {YUNET_PATH}")
        if not os.path.exists(SFACE_PATH):
            raise FileNotFoundError(f"SFace model not found at {SFACE_PATH}")

        # Initialize YuNet with sensitive threshold
        self.detector = cv2.FaceDetectorYN.create(
            model=YUNET_PATH,
            config="",
            input_size=(320, 320),
            score_threshold=0.45,
            nms_threshold=0.30,
            top_k=5000
        )

        # Initialize SFace recognizer (128-dimensional output)
        self.recognizer = cv2.FaceRecognizerSF.create(
            model=SFACE_PATH,
            config=""
        )

    @classmethod
    def get_instance(cls):
        if cls._instance is None:
            cls._instance = BiometricModels()
        return cls._instance

    def detect_faces(self, image_bgr: np.ndarray, score_threshold: float = 0.45):
        """
        Detects faces in an image using YuNet.
        Validates tensor shape/dtype/range before passing to native detector.
        """
        if image_bgr is None:
            return []

        try:
            from backend.security import validate_tensor_frame
        except ImportError:
            from security import validate_tensor_frame

        valid_tensor, msg = validate_tensor_frame(image_bgr)
        if not valid_tensor:
            return []

        h, w, _ = image_bgr.shape
        self.detector.setInputSize((w, h))
        self.detector.setScoreThreshold(score_threshold)

        _, raw_faces = self.detector.detect(image_bgr)
        if raw_faces is None or len(raw_faces) == 0:
            return []

        results = []
        for face in raw_faces:
            # face structure: [x, y, w, h, x_re, y_re, x_le, y_le, x_nt, y_nt, x_rc, y_rc, x_lc, y_lc, score]
            x, y, bw, bh = int(face[0]), int(face[1]), int(face[2]), int(face[3])
            score = float(face[-1])
            landmarks = [
                (float(face[4]), float(face[5])),   # right eye
                (float(face[6]), float(face[7])),   # left eye
                (float(face[8]), float(face[9])),   # nose tip
                (float(face[10]), float(face[11])), # right mouth corner
                (float(face[12]), float(face[13]))  # left mouth corner
            ]

            results.append({
                "bbox": [max(0, x), max(0, y), max(1, bw), max(1, bh)],
                "conf": round(score, 4),
                "landmarks": landmarks,
                "raw": np.array(face, dtype=np.float32)
            })
        return results

    def extract_embedding(self, image_bgr: np.ndarray, raw_face: np.ndarray) -> np.ndarray:
        """
        Aligns and crops the detected face based on 5 landmarks,
        then extracts a 128-dimensional L2-normalized embedding.
        Validates tensor shapes and handles numerical singularities safely.
        """
        try:
            from backend.security import validate_tensor_frame
        except ImportError:
            from security import validate_tensor_frame

        valid_tensor, _ = validate_tensor_frame(image_bgr)
        if not valid_tensor:
            return np.zeros(128, dtype=np.float32)

        raw_face_arr = np.array(raw_face, dtype=np.float32).reshape(-1)
        if len(raw_face_arr) < 15:
            return np.zeros(128, dtype=np.float32)

        aligned_face = self.recognizer.alignCrop(image_bgr, raw_face_arr)
        if aligned_face is None or aligned_face.size == 0:
            return np.zeros(128, dtype=np.float32)

        feature = self.recognizer.feature(aligned_face)
        norm = np.linalg.norm(feature)
        if norm == 0 or np.isnan(norm) or np.isinf(norm):
            return np.zeros(128, dtype=np.float32)

        feature_norm = feature / (norm + 1e-10)
        return feature_norm.astype(np.float32)


    def crop_face(self, image_bgr: np.ndarray, bbox: list, pad: float = 0.15) -> np.ndarray:
        """
        Safely crops the face bounding box with optional padding for UI thumbnails.
        """
        h, w, _ = image_bgr.shape
        x, y, bw, bh = bbox
        px = int(bw * pad)
        py = int(bh * pad)
        x1 = max(0, x - px)
        y1 = max(0, y - py)
        x2 = min(w, x + bw + px)
        y2 = min(h, y + bh + py)
        crop = image_bgr[y1:y2, x1:x2]
        if crop.size == 0:
            return image_bgr[max(0, y):min(h, y+bh), max(0, x):min(w, x+bw)]
        return crop

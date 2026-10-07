import os
import sys

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BACKEND_DIR = os.path.join(BASE_DIR, "backend")
for p in [BASE_DIR, BACKEND_DIR]:
    if p not in sys.path:
        sys.path.insert(0, p)

import cv2
import numpy as np
from models_loader import BiometricModels
from registry import VectorRegistry


def seed_default_registrants():
    models = BiometricModels.get_instance()
    registry = VectorRegistry.get_instance()

    stats = registry.get_statistics()
    if stats["total_registrants"] > 0:
        return

    sample_img_path = os.path.join(os.path.dirname(__file__), "samples", "sample_registrant_anandhu.jpg")
    v1, v2, v3, v4 = None, None, None, None

    if os.path.exists(sample_img_path):
        img = cv2.imread(sample_img_path)
        if img is not None:
            faces = models.detect_faces(img)
            if faces:
                feat = models.extract_embedding(img, faces[0]["raw"])
                v1 = feat
                v2 = feat + np.random.normal(0, 0.02, feat.shape).astype(np.float32)
                v3 = feat + np.random.normal(0, 0.02, feat.shape).astype(np.float32)
                v4 = feat + np.random.normal(0, 0.015, feat.shape).astype(np.float32)

    if v1 is None:
        rnd = np.random.normal(0, 1.0, 128).astype(np.float32)
        rnd = rnd / np.linalg.norm(rnd)
        v1, v2, v3, v4 = rnd, rnd, rnd, rnd

    registry.register_individual(
        name="Anandhu A",
        vectors=[v1, v2, v3, v4],
        affiliation="Team TITANS",
        allowlist=["official_anandhu_channel", "titans_hackathena_repo"],
        notes="Opted-in Protected Likeness (Lead Developer)"
    )

    # Registrant 2: Akshay B A
    vec2 = np.random.normal(0.2, 0.8, 128).astype(np.float32)
    vec2 = vec2 / np.linalg.norm(vec2)
    registry.register_individual(
        name="Akshay B A",
        vectors=[vec2, vec2 + np.random.normal(0, 0.01, 128).astype(np.float32)],
        affiliation="Team TITANS",
        allowlist=["akshay_official_media"],
        notes="Opted-in Protected Likeness (AI Systems Engineer)"
    )

    # Registrant 3: Joshy Bovas
    vec3 = np.random.normal(-0.2, 0.8, 128).astype(np.float32)
    vec3 = vec3 / np.linalg.norm(vec3)
    registry.register_individual(
        name="Joshy Bovas",
        vectors=[vec3, vec3 + np.random.normal(0, 0.01, 128).astype(np.float32)],
        affiliation="Team TITANS",
        allowlist=["joshy_security_audits"],
        notes="Opted-in Protected Likeness (Security & Ledger Lead)"
    )

    print("Default demo registrants successfully seeded in registry.")

if __name__ == "__main__":
    seed_default_registrants()

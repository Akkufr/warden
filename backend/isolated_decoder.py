"""
Warden Isolated Process Media Decoder
=====================================
Executes media decoding in a dedicated sandboxed subprocess isolated from the main API server.
Prevents decoder segfaults, memory leaks, parser hangs, or decompression explosions
from impacting the primary FastAPI runtime.
"""

import sys
import os
import argparse
import numpy as np
import cv2

try:
    from backend.security import (
        detect_magic_signature,
        preflight_image_dimensions,
        validate_tensor_frame,
        MAX_IMAGE_FILE_SIZE
    )
except ImportError:
    from security import (
        detect_magic_signature,
        preflight_image_dimensions,
        validate_tensor_frame,
        MAX_IMAGE_FILE_SIZE
    )


def decode_worker(input_path: str, output_npy_path: str) -> int:
    """
    Decodes an image file safely inside an isolated process.
    Returns:
        0: Success (tensor saved to output_npy_path)
        1: Magic signature / header check failure
        2: Decompression bomb or size ceiling violation
        3: Decoder failed to parse image (corrupt buffer)
        4: Tensor validation failed
        5: Unexpected runtime exception
    """
    try:
        if not os.path.exists(input_path):
            sys.stderr.write(f"ERROR:Input file does not exist: {input_path}\n")
            return 1

        file_size = os.path.getsize(input_path)
        if file_size == 0 or file_size > MAX_IMAGE_FILE_SIZE:
            sys.stderr.write(f"ERROR:File size {file_size} violates limits\n")
            return 2

        with open(input_path, "rb") as f:
            raw_bytes = f.read()

        # 1. Magic bytes verification
        sig = detect_magic_signature(raw_bytes[:32])
        if sig not in ("JPEG", "PNG", "WEBP", "GIF"):
            sys.stderr.write(f"ERROR:Invalid signature: {sig}\n")
            return 1

        # 2. Preflight dimensions
        safe_dim, w, h, dim_msg = preflight_image_dimensions(raw_bytes)
        if not safe_dim:
            sys.stderr.write(f"ERROR:{dim_msg}\n")
            return 2

        # 3. Safe decode
        nparr = np.frombuffer(raw_bytes, np.uint8)
        img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        if img is None:
            sys.stderr.write("ERROR:Decoder returned None\n")
            return 3

        # 4. Tensor validation
        valid_tensor, t_msg = validate_tensor_frame(img)
        if not valid_tensor:
            sys.stderr.write(f"ERROR:{t_msg}\n")
            return 4

        # Save validated tensor for main process retrieval
        np.save(output_npy_path, img)
        return 0

    except Exception as e:
        sys.stderr.write(f"ERROR:Isolated decode crash: {str(e)}\n")
        return 5


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Isolated Media Decoder Worker")
    parser.add_argument("--input", required=True, help="Input media file path")
    parser.add_argument("--output", required=True, help="Output .npy tensor path")
    args = parser.parse_args()

    exit_code = decode_worker(args.input, args.output)
    sys.exit(exit_code)

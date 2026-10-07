import os
from PIL import Image, ImageDraw

icons_dir = os.path.join("extension", "icons")
os.makedirs(icons_dir, exist_ok=True)

def draw_warden_icon(size):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    
    # Background rounded container
    r = int(size * 0.22)
    bg_color = (11, 29, 54, 255) # #0B1D36
    draw.rounded_rectangle([0, 0, size - 1, size - 1], radius=r, fill=bg_color)
    
    # Subtle border
    border_color = (39, 58, 82, 255) # #273A52
    draw.rounded_rectangle([0, 0, size - 1, size - 1], radius=r, outline=border_color, width=max(1, int(size * 0.04)))
    
    # Shield shape points
    # Shield fits in center with padding
    pad = size * 0.22
    w = size - 2 * pad
    h = size - 2 * pad
    top = pad
    bottom = pad + h
    left = pad
    right = pad + w
    cx = size / 2.0
    
    # Shield points: top-left, top-right, bottom-curve to point (cx, bottom)
    shield_pts = [
        (left, top + h * 0.15),
        (cx, top),
        (right, top + h * 0.15),
        (right, top + h * 0.60),
        (cx, bottom),
        (left, top + h * 0.60),
    ]
    
    # Draw shield outline / fill
    shield_fill = (0, 180, 216, 230) # #00B4D8
    draw.polygon(shield_pts, fill=shield_fill)
    
    # Inner checkmark or biometric core
    if size >= 32:
        check_pts = [
            (cx - w * 0.22, top + h * 0.45),
            (cx - w * 0.05, top + h * 0.62),
            (cx + w * 0.25, top + h * 0.30)
        ]
        line_w = max(2, int(size * 0.08))
        draw.line(check_pts, fill=(11, 29, 54, 255), width=line_w, joint="curve")
    
    return img

for sz in [16, 48, 128]:
    icon = draw_warden_icon(sz)
    icon_path = os.path.join(icons_dir, f"icon{sz}.png")
    icon.save(icon_path, "PNG")
    print(f"Generated {icon_path}")

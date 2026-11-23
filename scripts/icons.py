"""Rebuild the application icons from the supplied transparent artwork."""
from pathlib import Path
from PIL import Image

root = Path(__file__).resolve().parents[1]
original = Image.open(root / "assets/editor-original.png").convert("RGBA")
alpha = original.getchannel("A")
# Ignore nearly transparent scanner pixels when measuring the artwork for a launcher.
left, top, right, bottom = alpha.point(lambda value: 255 if value > 5 else 0).getbbox()
edge = max(right - left, bottom - top)
side = round(edge / 0.87)
x, y = (left + right - side) // 2, (top + bottom - side) // 2
destination = root / "src-tauri/icons"
destination.mkdir(parents=True, exist_ok=True)
white = Image.new("RGBA", original.size, "white")
white.putalpha(alpha)
for suffix, source in [("", original), ("-white", white)]:
    artwork = source.crop((x, y, x + side, y + side))
    for size in (16, 24, 32, 48, 64, 96, 128, 256, 512):
        scaled = artwork.resize((size, size), Image.Resampling.LANCZOS)
        scaled.save(destination / f"{size}x{size}{suffix}.png", optimize=True)
        if size == 256:
            scaled.save(destination / f"icon{suffix}.png", optimize=True)
    if not suffix:
        artwork.save(destination / "icon.ico", sizes=[(s, s) for s in (16, 24, 32, 48, 64, 128, 256)])

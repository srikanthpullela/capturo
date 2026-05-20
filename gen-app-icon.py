#!/usr/bin/env python3
"""Generate Capturo app icons for macOS and Windows from one modern mark."""
import math, os, struct, subprocess, zlib

ICON_DIR = '/Users/srikanthpullela/Desktop/snapcraft/src-tauri/icons'
ICONSET_DIR = f'{ICON_DIR}/icon.iconset'

def clamp(v, lo=0.0, hi=1.0):
    return max(lo, min(hi, v))

def make_png(w, h, pixels):
    def chunk(tag, data):
        return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)
    raw = b''.join(b'\x00' + b''.join(bytes(px) for px in row) for row in pixels)
    return (b'\x89PNG\r\n\x1a\n'
            + chunk(b'IHDR', struct.pack('>II', w, h) + bytes([8, 6, 0, 0, 0]))
            + chunk(b'IDAT', zlib.compress(raw, 9))
            + chunk(b'IEND', b''))

def make_ico(images):
    header = struct.pack('<HHH', 0, 1, len(images))
    offset = 6 + len(images) * 16
    entries, blobs = [], []
    for size, blob in images:
        w = 0 if size >= 256 else size
        entries.append(struct.pack('<BBBBHHII', w, w, 0, 0, 1, 32, len(blob), offset))
        blobs.append(blob)
        offset += len(blob)
    return header + b''.join(entries) + b''.join(blobs)

def mix(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))

def bg_color(t):
    if t < 0.5:
        return mix((6, 182, 212), (99, 102, 241), t * 2)
    return mix((99, 102, 241), (168, 85, 247), (t - 0.5) * 2)

def mark_color(t, background):
    if background:
        if t < 0.5:
            return mix((255, 255, 255), (232, 240, 255), t * 2)
        return mix((232, 240, 255), (255, 255, 255), (t - 0.5) * 2)
    return (0, 0, 0)

def sdf_rrect(px, py, rx, ry, rw, rh, rr):
    cx = max(rx + rr, min(px, rx + rw - rr))
    cy = max(ry + rr, min(py, ry + rh - rr))
    return math.hypot(px - cx, py - cy) - rr

def sdf_segment(px, py, ax, ay, bx, by):
    vx, vy = bx - ax, by - ay
    wx, wy = px - ax, py - ay
    denom = vx * vx + vy * vy or 1.0
    t = clamp((wx * vx + wy * vy) / denom)
    return math.hypot(px - (ax + vx * t), py - (ay + vy * t))

def blend(dst, src):
    sr, sg, sb, sa = src
    dr, dg, db, da = dst
    a = sa / 255.0
    ba = da / 255.0
    oa = a + ba * (1 - a)
    if oa <= 0:
        return (0, 0, 0, 0)
    r = int((sr * a + dr * ba * (1 - a)) / oa)
    g = int((sg * a + dg * ba * (1 - a)) / oa)
    b = int((sb * a + db * ba * (1 - a)) / oa)
    return (r, g, b, int(oa * 255))

def render(size, background=True):
    aa = max(1.2, size / 128)
    cx = cy = size / 2
    radius = size * 0.285
    width = size * 0.13
    gap = 0.73
    pixels = [[(0, 0, 0, 0)] * size for _ in range(size)]

    cap1 = (cx + math.cos(gap) * radius, cy + math.sin(gap) * radius)
    cap2 = (cx + math.cos(-gap) * radius, cy + math.sin(-gap) * radius)
    reticle_cx = cx + size * 0.31
    reticle_r = size * 0.088

    for y in range(size):
        for x in range(size):
            px, py = x + 0.5, y + 0.5
            t = (px / size + py / size) / 2
            out = (0, 0, 0, 0)

            if background:
                bg_a = clamp((aa - sdf_rrect(px, py, 0, 0, size, size, size * 0.18)) / aa)
                if bg_a > 0:
                    c = bg_color(t)
                    out = (c[0], c[1], c[2], int(bg_a * 255))

            dx, dy = px - cx, py - cy
            angle = math.atan2(dy, dx)
            dist = abs(math.hypot(dx, dy) - radius) - width / 2
            ring_a = clamp((aa - dist) / aa)
            if abs(angle) < gap:
                ring_a = 0.0
            cap_a = max(
                clamp((aa - (math.hypot(px - cap1[0], py - cap1[1]) - width / 2)) / aa),
                clamp((aa - (math.hypot(px - cap2[0], py - cap2[1]) - width / 2)) / aa),
            )
            mark_a = max(ring_a, cap_a)
            line_w = size * 0.032
            reticle_ring = abs(math.hypot(px - reticle_cx, py - cy) - reticle_r) - line_w / 2
            capture_a = clamp((aa - reticle_ring) / aa)
            capture_a = max(capture_a, clamp((aa - (sdf_segment(px, py, reticle_cx - size * 0.135, cy, reticle_cx + size * 0.135, cy) - line_w / 2)) / aa))
            capture_a = max(capture_a, clamp((aa - (sdf_segment(px, py, reticle_cx, cy - size * 0.135, reticle_cx, cy + size * 0.135) - line_w / 2)) / aa))
            dot_a = clamp((aa - (math.hypot(px - reticle_cx, py - cy) - size * 0.032)) / aa)

            if mark_a > 0:
                c = mark_color(t, background)
                alpha = mark_a * (0.96 if background else 1.0)
                out = blend(out, (c[0], c[1], c[2], int(alpha * 255)))
            accent_a = max(capture_a * 0.82, dot_a)
            if accent_a > 0:
                c = (255, 255, 255) if background else (0, 0, 0)
                out = blend(out, (c[0], c[1], c[2], int(accent_a * 255)))
            pixels[y][x] = out
    return pixels

os.makedirs(ICONSET_DIR, exist_ok=True)

iconset = {
    'icon_16x16.png': 16, 'icon_16x16@2x.png': 32,
    'icon_32x32.png': 32, 'icon_32x32@2x.png': 64,
    'icon_128x128.png': 128, 'icon_128x128@2x.png': 256,
    'icon_256x256.png': 256, 'icon_256x256@2x.png': 512,
    'icon_512x512.png': 512, 'icon_512x512@2x.png': 1024,
}
standalone = {
    '16x16.png': 16, '32x32.png': 32, '64x64.png': 64,
    '128x128.png': 128, '128x128@2x.png': 256,
    '256x256.png': 256, '512x512.png': 512, '1024x1024.png': 1024,
    'icon.png': 512,
    'Square30x30Logo.png': 30, 'Square44x44Logo.png': 44,
    'Square71x71Logo.png': 71, 'Square89x89Logo.png': 89,
    'Square107x107Logo.png': 107, 'Square142x142Logo.png': 142,
    'Square150x150Logo.png': 150, 'Square284x284Logo.png': 284,
    'Square310x310Logo.png': 310, 'StoreLogo.png': 50,
}

cache = {}
def png(size, background=True):
    key = (size, background)
    if key not in cache:
        print(f'  rendering {size}x{size} {"app" if background else "tray"}...')
        cache[key] = make_png(size, size, render(size, background))
    return cache[key]

print('Generating macOS iconset...')
for name, size in iconset.items():
    with open(f'{ICONSET_DIR}/{name}', 'wb') as f:
        f.write(png(size, True))

print('Generating standalone and Windows PNGs...')
for name, size in standalone.items():
    with open(f'{ICON_DIR}/{name}', 'wb') as f:
        f.write(png(size, True))

print('Generating tray icons...')
with open(f'{ICON_DIR}/tray-icon.png', 'wb') as f:
    f.write(png(64, True))
with open(f'{ICON_DIR}/tray-icon-template.png', 'wb') as f:
    f.write(png(64, False))
with open(f'{ICON_DIR}/tray-icon-light.png', 'wb') as f:
    f.write(png(64, False))

print('Generating icon.ico...')
ico_images = [(s, png(s, True)) for s in (16, 24, 32, 48, 64, 128, 256)]
with open(f'{ICON_DIR}/icon.ico', 'wb') as f:
    f.write(make_ico(ico_images))

print('Running iconutil...')
r = subprocess.run(['iconutil', '-c', 'icns', ICONSET_DIR, '-o', f'{ICON_DIR}/icon.icns'], capture_output=True, text=True)
if r.returncode != 0:
    raise SystemExit(r.stderr)
print('Done.')

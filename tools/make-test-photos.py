#!/usr/bin/env python3
"""
Build synthetic "tutor photographs a slip on a desk" images so the detector can
be tested without a pile of real photos. Each case writes a PNG plus a JSON
sidecar holding the true corner positions, which test-detect.mjs scores against.

Run:  python3 tools/make-test-photos.py <slip.png> <outdir>
"""
import json
import math
import os
import random
import sys

from PIL import Image, ImageDraw, ImageFilter

W, H = 1400, 1900          # "phone photo" canvas


def desk(colour, noise=8, seed=0):
    rnd = random.Random(seed)
    im = Image.new("RGB", (W, H), colour)
    px = im.load()
    for y in range(0, H, 2):
        for x in range(0, W, 2):
            n = rnd.randint(-noise, noise)
            r, g, b = px[x, y]
            px[x, y] = (max(0, min(255, r + n)),
                        max(0, min(255, g + n)),
                        max(0, min(255, b + n)))
    return im.filter(ImageFilter.GaussianBlur(1.1))


def quad_transform(size, quad):
    """PIL's QUAD coefficients map the OUTPUT box back to the INPUT quad, so we
    invert: solve for the perspective that sends the source rect to `quad`."""
    (x0, y0), (x1, y1), (x2, y2), (x3, y3) = quad
    w, h = size
    src = [(0, 0), (w, 0), (w, h), (0, h)]
    dst = [(x0, y0), (x1, y1), (x2, y2), (x3, y3)]

    A, B = [], []
    for (u, v), (x, y) in zip(dst, src):
        A.append([u, v, 1, 0, 0, 0, -u * x, -v * x]); B.append(x)
        A.append([0, 0, 0, u, v, 1, -u * y, -v * y]); B.append(y)

    # Gaussian elimination
    n = 8
    for c in range(n):
        p = max(range(c, n), key=lambda r: abs(A[r][c]))
        A[c], A[p] = A[p], A[c]
        B[c], B[p] = B[p], B[c]
        d = A[c][c]
        A[c] = [v / d for v in A[c]]
        B[c] /= d
        for r in range(n):
            if r == c:
                continue
            f = A[r][c]
            if f:
                A[r] = [a - f * b for a, b in zip(A[r], A[c])]
                B[r] -= f * B[c]
    return B


def paste_quad(base, tile, quad, shadow=True):
    """Warp `tile` onto `base` so its corners land on `quad` (TL,TR,BR,BL)."""
    coeffs = quad_transform(tile.size, quad)
    warped = tile.convert("RGBA").transform(
        base.size, Image.PERSPECTIVE, coeffs, Image.BICUBIC)
    mask = Image.new("L", tile.size, 255).transform(
        base.size, Image.PERSPECTIVE, coeffs, Image.BICUBIC)

    if shadow:
        sh = mask.filter(ImageFilter.GaussianBlur(11)).point(lambda v: int(v * 0.42))
        dark = Image.new("RGB", base.size, (25, 25, 28))
        base.paste(dark, (14, 16), sh)

    base.paste(warped, (0, 0), mask)
    return quad


def rect_quad(cx, cy, w, h, rot=0.0, persp=0.0, tilt=0.0):
    """A rectangle centred on (cx,cy), rotated, with a little keystone."""
    pts = [(-w / 2, -h / 2), (w / 2, -h / 2), (w / 2, h / 2), (-w / 2, h / 2)]
    out = []
    for i, (x, y) in enumerate(pts):
        # keystone: shrink the top edge, and lean one side in
        if y < 0:
            x *= (1 - persp)
        if x < 0:
            y *= (1 - tilt)
        c, s = math.cos(rot), math.sin(rot)
        out.append((cx + x * c - y * s, cy + x * s + y * c))
    return out


def workbook(seed=1):
    """A ruled exercise-book page — the classic thing that also looks like paper."""
    rnd = random.Random(seed)
    im = Image.new("RGB", (900, 1200), (250, 249, 243))
    d = ImageDraw.Draw(im)
    for y in range(90, 1200, 46):
        d.line([(60, y), (860, y)], fill=(196, 206, 224), width=3)
    d.line([(120, 0), (120, 1200)], fill=(226, 168, 168), width=3)
    for i in range(26):                      # scribbled "answers"
        y = 96 + i * 46
        x = 140
        while x < 800 and rnd.random() < 0.72:
            ln = rnd.randint(30, 120)
            d.line([(x, y - rnd.randint(4, 16)), (x + ln, y - rnd.randint(4, 16))],
                   fill=(38, 44, 70), width=4)
            x += ln + rnd.randint(12, 34)
    return im


def cast(im, factor):
    r, g, b = im.split()
    r = r.point(lambda v: min(255, int(v * factor[0])))
    g = g.point(lambda v: min(255, int(v * factor[1])))
    b = b.point(lambda v: min(255, int(v * factor[2])))
    return Image.merge("RGB", (r, g, b))


def main():
    slip_path, outdir = sys.argv[1], sys.argv[2]
    os.makedirs(outdir, exist_ok=True)
    slip = Image.open(slip_path).convert("RGB")

    cases = []

    def case(name, build):
        base, quad, note = build()
        base.save(os.path.join(outdir, name + ".png"))
        json.dump({"name": name, "quad": quad, "note": note, "size": [W, H]},
                  open(os.path.join(outdir, name + ".json"), "w"))
        cases.append(name)

    # 1 — the easy one: straight on, dark desk
    def c1():
        base = desk((92, 78, 66), seed=1)
        q = rect_quad(W / 2, H / 2, 760, 760 / 0.5765)
        paste_quad(base, slip, q)
        return base, q, "flat on a dark wooden desk"
    case("01-flat-dark-desk", c1)

    # 2 — rotated and keystoned, held at an angle
    def c2():
        base = desk((88, 92, 99), seed=2)
        q = rect_quad(W / 2 + 40, H / 2, 720, 720 / 0.5765,
                      rot=math.radians(-13), persp=0.10, tilt=0.05)
        paste_quad(base, slip, q)
        return base, q, "rotated 13 degrees with keystone"
    case("02-rotated-keystone", c2)

    # 3 — the actual complaint: student work in the frame too
    def c3():
        base = desk((104, 96, 84), seed=3)
        wb = workbook(3)
        paste_quad(base, wb, rect_quad(W * 0.34, H * 0.66, 900, 1180,
                                       rot=math.radians(6)), shadow=False)
        q = rect_quad(W * 0.60, H * 0.36, 620, 620 / 0.5765, rot=math.radians(4))
        paste_quad(base, slip, q)
        return base, q, "slip beside an open exercise book"
    case("03-with-student-work", c3)

    # 4 — bright desk: the slip is DARKER than what it sits on
    def c4():
        base = desk((238, 236, 232), noise=5, seed=4)
        q = rect_quad(W / 2, H / 2, 700, 700 / 0.5765, rot=math.radians(3))
        paste_quad(base, cast(slip, (0.93, 0.93, 0.95)), q)
        return base, q, "on a white table, low contrast"
    case("04-bright-desk", c4)

    # 5 — warm indoor light, underexposed
    def c5():
        base = desk((70, 60, 48), seed=5)
        q = rect_quad(W / 2, H / 2 - 30, 780, 780 / 0.5765, rot=math.radians(-6))
        paste_quad(base, slip, q)
        return cast(base, (0.92, 0.78, 0.58)).point(lambda v: int(v * 0.72)), q, \
            "dim, heavy tungsten cast"
    case("05-dim-warm", c5)

    # 6 — TWO slips: must be detected and flagged
    def c6():
        base = desk((96, 88, 78), seed=6)
        q2 = rect_quad(W * 0.72, H * 0.66, 560, 560 / 0.5765, rot=math.radians(9))
        paste_quad(base, slip, q2)
        q = rect_quad(W * 0.32, H * 0.36, 580, 580 / 0.5765, rot=math.radians(-5))
        paste_quad(base, slip, q)
        return base, q, "two slips in one photo - should flag"
    case("06-two-slips", c6)

    # 7 — shot sideways
    def c7():
        base = desk((84, 86, 92), seed=7)
        q = rect_quad(W / 2, H / 2, 700 / 0.5765, 700, rot=math.radians(2))
        paste_quad(base, slip.rotate(90, expand=True), q)
        return base, q, "photographed in landscape"
    case("07-landscape", c7)

    # 8 — small in frame, taken from too far back
    def c8():
        base = desk((110, 104, 96), seed=8)
        q = rect_quad(W / 2, H / 2, 430, 430 / 0.5765, rot=math.radians(-18))
        paste_quad(base, slip, q)
        return base, q, "far away and steeply rotated"
    case("08-far-and-rotated", c8)

    # 9 — bleeding off the edge of the frame
    def c9():
        base = desk((80, 74, 70), seed=9)
        q = rect_quad(W * 0.5, H * 0.46, 980, 980 / 0.5765, rot=math.radians(2),
                      persp=0.12)
        paste_quad(base, slip, q)
        return base, q, "fills the frame, slight keystone"
    case("09-fills-frame", c9)

    # 10 — clutter: pen, mug ring, phone
    def c10():
        base = desk((100, 90, 76), seed=10)
        d = ImageDraw.Draw(base)
        d.ellipse([120, 1500, 460, 1840], outline=(60, 48, 38), width=16)
        d.rounded_rectangle([1080, 250, 1330, 760], 40, fill=(26, 26, 30))
        d.line([(200, 420), (520, 300)], fill=(20, 60, 140), width=26)
        q = rect_quad(W * 0.48, H * 0.52, 660, 660 / 0.5765, rot=math.radians(7))
        paste_quad(base, slip, q)
        return base, q, "pen, phone and a mug ring in shot"
    case("10-cluttered-desk", c10)

    json.dump(cases, open(os.path.join(outdir, "index.json"), "w"))
    print(f"wrote {len(cases)} cases to {outdir}")


if __name__ == "__main__":
    main()

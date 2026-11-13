"""Картинка для прев'ю посилань og-image.jpg (1200x630): фото сторінок і скляна табличка з назвою, як шапка сайту.

Після зміни назви магазину перегенеруйте її (рядки таблички — окремими аргументами):
    python scripts/og-image.py "КРАМНИЦЯ" "Оленки Шевчук"
Потрібен Pillow: pip install pillow
"""

import os
import sys
from PIL import Image, ImageDraw, ImageFilter, ImageEnhance, ImageFont

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
SRC = os.path.join(ROOT, "pages.jpg")
OUT = os.path.join(ROOT, "og-image.jpg")
W, H = 1200, 630

# жирний шрифт із засічками та кирилицею — перший, що знайдеться
FONTS = [
    "C:/Windows/Fonts/georgiab.ttf",
    "/Library/Fonts/Georgia Bold.ttf",
    "/System/Library/Fonts/Supplemental/Georgia Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf",
]

lines = sys.argv[1:]
if not lines:
    sys.exit(__doc__)
font_path = next((f for f in FONTS if os.path.exists(f)), None)
if not font_path:
    sys.exit(
        "Не знайшов шрифт Georgia Bold чи DejaVu Serif Bold — допишіть шлях у FONTS"
    )

# фото: кадр з центру, трохи приглушене, як на сайті
im = Image.open(SRC).convert("RGB")
im = im.resize((W, round(im.height * W / im.width)), Image.LANCZOS)
top = (im.height - H) // 2
im = im.crop((0, top, W, top + H))
im = ImageEnhance.Brightness(im).enhance(0.9)

# віньєтка по краях
vig = Image.new("L", (W, H), 0)
ImageDraw.Draw(vig).ellipse((-W * 0.15, -H * 0.25, W * 1.15, H * 1.25), fill=255)
im = Image.composite(
    im, Image.new("RGB", (W, H)), vig.filter(ImageFilter.GaussianBlur(120))
)

# розмір шрифту: найбільший, з яким найдовший рядок влазить у табличку
probe = ImageDraw.Draw(im)
size = 76
while size > 30:
    font = ImageFont.truetype(font_path, size)
    if (
        max(probe.textlength(t, font=font) for t in lines) <= 680
        and size * len(lines) * 1.25 <= 420
    ):
        break
    size -= 2
font = ImageFont.truetype(font_path, size)
heights = [probe.textbbox((0, 0), t, font=font)[3] for t in lines]
gap = round(size * 0.18)
text_w = max(probe.textlength(t, font=font) for t in lines)

# табличка по тексту: розмите фото під нею + світлий шар, тінь і світлий край, як на сайті
pw, ph = max(560, round(text_w) + 120), sum(heights) + gap * (len(lines) - 1) + 110
px, py = (W - pw) // 2, (H - ph) // 2
radius = 32
mask = Image.new("L", (W, H), 0)
ImageDraw.Draw(mask).rounded_rectangle((px, py, px + pw, py + ph), radius, fill=255)
shadow = Image.new("L", (W, H), 0)
ImageDraw.Draw(shadow).rounded_rectangle(
    (px, py + 18, px + pw, py + ph + 18), radius, fill=150
)
im = Image.composite(
    Image.new("RGB", (W, H)), im, shadow.filter(ImageFilter.GaussianBlur(28))
)
glass = Image.blend(
    im.filter(ImageFilter.GaussianBlur(22)),
    Image.new("RGB", (W, H), (246, 246, 244)),
    0.8,
)
im = Image.composite(glass, im, mask)
edge = Image.new("L", (W, H), 0)
ImageDraw.Draw(edge).rounded_rectangle(
    (px, py, px + pw, py + ph), radius, outline=100, width=2
)
im = Image.composite(Image.new("RGB", (W, H), (255, 255, 255)), im, edge)

draw = ImageDraw.Draw(im)
y = py + (ph - (sum(heights) + gap * (len(lines) - 1))) // 2 - 6
for t, h in zip(lines, heights):
    draw.text(
        ((W - draw.textlength(t, font=font)) / 2, y), t, font=font, fill=(28, 29, 31)
    )
    y += h + gap

im.save(OUT, quality=86, optimize=True, progressive=True)
print("Готово:", os.path.normpath(OUT))

#!/usr/bin/env python3
"""Generate the MD Reader app icon at 1024x1024.

Terminal-match theme: pink background (#ef989b) with a black (#000000)
CommonMark-style Markdown mark ("M" + downward arrow), matching the app's
black-on-pink SF Mono aesthetic.

The mark geometry follows the official CommonMark logo:
  - a rounded outer border rectangle
  - the letter "M" formed by two verticals + a center "V"
  - a downward arrow to the right of the M
Everything is drawn as filled/stroked black shapes on the pink field.
"""
from PIL import Image, ImageDraw

S = 1024
BG = (239, 152, 155, 255)      # #ef989b
FG = (0, 0, 0, 255)            # #000000

img = Image.new("RGBA", (S, S), BG)
d = ImageDraw.Draw(img)

# --- Layout: center a CommonMark-style mark on the pink field ---
# The mark sits inside a rounded rectangle border. Use generous margins so
# macOS BigSur squircle masking never clips the glyph.
mx = int(S * 0.16)             # outer margin
box_l, box_t = mx, int(S * 0.26)
box_r, box_b = S - mx, S - int(S * 0.26)
box_w = box_r - box_l
box_h = box_b - box_t

stroke = int(S * 0.045)        # border thickness
radius = int(S * 0.06)

# Rounded border rectangle (hollow)
d.rounded_rectangle(
    [box_l, box_t, box_r, box_b],
    radius=radius,
    outline=FG,
    width=stroke,
)

# Inner content area (padding inside the border)
pad = int(box_w * 0.10)
ix_l = box_l + pad
ix_r = box_r - pad
iy_t = box_t + pad
iy_b = box_b - pad
iw = ix_r - ix_l
ih = iy_b - iy_t

# The mark is split into two columns: "M" (left ~55%) and arrow (right).
gap = int(iw * 0.06)
m_w = int(iw * 0.55)
a_l = ix_l + m_w + gap
a_r = ix_r

# --- Letter "M" ---
mstroke = int(iw * 0.11)       # M stem thickness
m_l = ix_l
m_r = ix_l + m_w
m_t = iy_t
m_b = iy_b
half = mstroke // 2

# left vertical
d.rectangle([m_l, m_t, m_l + mstroke, m_b], fill=FG)
# right vertical
d.rectangle([m_r - mstroke, m_t, m_r, m_b], fill=FG)
# center "V" of the M: two thick diagonals meeting near vertical center
cx = (m_l + m_r) // 2
apex_y = m_t + int((m_b - m_t) * 0.55)
# left diagonal: from top of left stem to apex
d.line([(m_l + half, m_t + half), (cx, apex_y)], fill=FG, width=mstroke, joint="curve")
# right diagonal: from top of right stem to apex
d.line([(m_r - half, m_t + half), (cx, apex_y)], fill=FG, width=mstroke, joint="curve")

# --- Down arrow ---
astroke = int((a_r - a_l) * 0.30)   # arrow shaft thickness
acx = (a_l + a_r) // 2
shaft_l = acx - astroke // 2
shaft_r = acx + astroke // 2
shaft_t = iy_t
# arrowhead occupies bottom portion
head_h = int(ih * 0.34)
shaft_b = iy_b - head_h + int(head_h * 0.15)
# shaft
d.rectangle([shaft_l, shaft_t, shaft_r, shaft_b], fill=FG)
# arrowhead (triangle) spanning full arrow column width
head_half = int((a_r - a_l) * 0.48)
d.polygon(
    [
        (acx - head_half, shaft_b - int(head_h * 0.05)),
        (acx + head_half, shaft_b - int(head_h * 0.05)),
        (acx, iy_b),
    ],
    fill=FG,
)

img.save("icons/icon.png")
print("wrote icons/icon.png", img.size)

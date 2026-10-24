"""Episode thumbnail: the user's picture, cropped to the chosen size, with an optional badge ("EPISODE 4").

The picture is added to the project (copied into `<project folder>/Assets/`). The badge is a chamfered plate with
condensed bold text, placed in picture coordinates (fractions of the picture), so it stays on the same spot of the
picture whatever output size is chosen; the picture fills the output and the overflow is cropped evenly.

The last settings are remembered (state.json → "thumbnail") so the next episode starts from them with the number + 1.
"""
from __future__ import annotations

import hashlib
import json
import shutil
from pathlib import Path

from pydantic import BaseModel, Field

from .project import Project, ThumbnailSettings

FONT = Path(__file__).parent / "assets" / "fonts" / "Montserrat-Black.ttf"
SS = 4                                   # supersampling for the badge's edges
PRESETS = [(1280, 720), (1920, 1080), (2560, 1440), (3840, 2160), (1080, 1080)]
YOUTUBE_MAX_BYTES = 2 * 1024 * 1024      # YouTube rejects bigger thumbnails
IMAGE_TYPES = {".png", ".jpg", ".jpeg", ".webp"}


class ThumbnailError(ValueError):
    pass


# ---- settings -----------------------------------------------------------------------------------
def assets_dir(project_path: str | Path) -> Path:
    return Path(project_path).parent / "Assets"


def add_image(project_path: str | Path, image: str | Path) -> str:
    """Copy a picture into the project's Assets folder (unless it is already there); returns the new path."""
    src = Path(image)
    if not src.is_file():
        raise ThumbnailError(f"image not found: {image}")
    if src.suffix.lower() not in IMAGE_TYPES:
        raise ThumbnailError(f"not a supported image (png, jpg, webp): {src.name}")
    d = assets_dir(project_path)
    try:
        if src.resolve().parent == d.resolve():
            return str(src.resolve())
    except OSError:
        pass
    d.mkdir(parents=True, exist_ok=True)
    target = d / src.name
    if target.exists() and _sha(target) != _sha(src):
        stem, n = target.stem, 2
        while (d / f"{stem}-{n}{target.suffix}").exists():
            n += 1
        target = d / f"{stem}-{n}{target.suffix}"
    if not target.exists():
        shutil.copyfile(src, target)
    return str(target.resolve())


def _sha(f: Path) -> str:
    return hashlib.sha256(f.read_bytes()).hexdigest()


def initial(p: Project, project_path: str | Path) -> ThumbnailSettings:
    """The project's own settings, else the last used ones (number + 1 for another project), else defaults.
    The episode number also follows the video template's "episode" parameter when that one is set."""
    from . import templates as T
    if p.export.thumbnail is not None:
        return p.export.thumbnail
    me = str(Path(project_path).resolve())
    last = T.load_state().get("thumbnail")
    s = ThumbnailSettings()
    if last:
        try:
            s = ThumbnailSettings.model_validate(last.get("settings") or {})
        except ValueError:
            s = ThumbnailSettings()
        if s.episode is not None and last.get("project") != me:
            s.episode += 1
        if s.image and not Path(s.image).is_file():
            s.image = None
    video_ep = p.export.video.params.get("episode") if p.export.video.template else None
    if isinstance(video_ep, (int, float)) and not isinstance(video_ep, bool):
        s.episode = int(video_ep)
    return s


def update(p: Project, project_path: str | Path, changes: dict) -> ThumbnailSettings:
    """Merge `changes` into the project's thumbnail settings (badge fields may be given as a nested dict).
    A picture from outside the project is copied into it. Saves the project."""
    cur = initial(p, project_path).model_dump()
    changes = dict(changes)
    badge = changes.pop("badge", None)
    unknown = set(changes) - set(cur)
    if unknown:
        raise ThumbnailError(f"unknown thumbnail settings: {', '.join(sorted(unknown))}")
    cur.update(changes)
    if badge:
        bad = set(badge) - set(cur["badge"])
        if bad:
            raise ThumbnailError(f"unknown badge settings: {', '.join(sorted(bad))}")
        cur["badge"].update(badge)
    s = ThumbnailSettings.model_validate(cur)
    if s.image:
        s.image = add_image(project_path, s.image)
    p.export.thumbnail = s
    p.save(project_path)
    return s


def remember(s: ThumbnailSettings, project_path: str | Path) -> None:
    from . import templates as T
    me = str(Path(project_path).resolve())
    T.update_state(lambda st: st.__setitem__("thumbnail", {"settings": s.model_dump(), "project": me}))


def badge_text(s: ThumbnailSettings) -> str:
    t = s.badge.text
    if "{n}" in t:
        if s.episode is None:
            raise ThumbnailError("episode number is needed for the badge text")
        t = t.replace("{n}", str(s.episode))
    return t


# ---- drawing ------------------------------------------------------------------------------------
class Placement(BaseModel):
    """How the picture lands in the output: scaled by `scale`, then cropped at (`left`, `top`)."""
    scale: float
    left: float
    top: float
    image_w: int
    image_h: int
    out_w: int
    out_h: int
    badge: dict = Field(default_factory=dict)   # badge rectangle in output pixels (cx, cy, w, h, angle)


def _color(v: str) -> tuple[int, int, int]:
    h = v.strip().lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    if len(h) != 6:
        raise ThumbnailError(f"not a colour: {v}")
    try:
        return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    except ValueError:
        raise ThumbnailError(f"not a colour: {v}") from None


def placement(s: ThumbnailSettings, image_w: int, image_h: int, out_w: int, out_h: int) -> Placement:
    scale = max(out_w / image_w, out_h / image_h)
    left = (image_w * scale - out_w) / 2
    top = (image_h * scale - out_h) / 2
    b = s.badge
    sh = image_h * scale
    return Placement(scale=scale, left=left, top=top, image_w=image_w, image_h=image_h, out_w=out_w, out_h=out_h,
                     badge={"cx": b.x * image_w * scale - left, "cy": b.y * image_h * scale - top,
                            "w": b.width * sh, "h": b.height * sh, "angle": b.angle})


def _badge_layer(s: ThumbnailSettings, w: float, h: float):
    """The badge, unrotated, at SS× size (RGBA)."""
    from PIL import Image, ImageDraw, ImageFont
    b = s.badge
    W, H = max(2, round(w * SS)), max(2, round(h * SS))
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    c = min(b.chamfer, 0.5) * H
    d.polygon([(c, 0), (W - c, 0), (W, c), (W, H - c), (W - c, H), (c, H), (0, H - c), (0, c)],
              fill=_color(b.fill) + (255,))
    text = badge_text(s)
    if text.strip():
        font = ImageFont.truetype(str(FONT), max(4, round(b.font * H)))
        l, t, r, bt = font.getbbox(text, anchor="ls")
        tw, th = r - l, bt - t
        txt = Image.new("RGBA", (max(1, tw), max(1, th)), (0, 0, 0, 0))
        ImageDraw.Draw(txt).text((-l, -t), text, font=font, fill=_color(b.ink) + (255,), anchor="ls")
        sx = min(b.squeeze, (b.text_width * W) / max(1, tw))
        txt = txt.resize((max(1, round(tw * sx)), th), Image.LANCZOS)
        baseline = H / 2 + b.baseline * H         # baseline below the centre
        layer.alpha_composite(txt, (round((W - txt.width) / 2), round(baseline + t)))
    return layer


def render(s: ThumbnailSettings, size: tuple[int, int] | None = None, with_badge: bool = True):
    """The thumbnail as a PIL image (RGB). `size` overrides the output size (for previews)."""
    from PIL import Image
    if not s.image or not Path(s.image).is_file():
        raise ThumbnailError("add a picture for the thumbnail first")
    out_w, out_h = size or (s.width, s.height)
    if out_w < 16 or out_h < 16:
        raise ThumbnailError("thumbnail size is too small")
    with Image.open(s.image) as im:
        im.load()
        src = im.convert("RGBA")
    pl = placement(s, src.width, src.height, out_w, out_h)
    sw, sh = max(1, round(src.width * pl.scale)), max(1, round(src.height * pl.scale))
    scaled = src.resize((sw, sh), Image.LANCZOS) if (sw, sh) != src.size else src
    left, top = round(pl.left), round(pl.top)
    canvas = scaled.crop((left, top, left + out_w, top + out_h))
    if with_badge and s.badge.enabled:
        bd = pl.badge
        layer = _badge_layer(s, bd["w"], bd["h"])
        layer = layer.rotate(-bd["angle"], resample=Image.BICUBIC, expand=True)   # angle: clockwise, like CSS
        layer = layer.resize((max(1, round(layer.width / SS)), max(1, round(layer.height / SS))), Image.LANCZOS)
        canvas.alpha_composite(layer, (round(bd["cx"] - layer.width / 2), round(bd["cy"] - layer.height / 2)))
    return canvas.convert("RGB")


def save(img, target: Path, fmt: str) -> Path:
    target.parent.mkdir(parents=True, exist_ok=True)
    if fmt == "jpg":
        img.save(target, "JPEG", quality=92, optimize=True, progressive=True)
    else:
        img.save(target, "PNG", optimize=True)
    return target


def export(s: ThumbnailSettings, out_dir: Path) -> tuple[Path, list[str]]:
    """Write `thumbnail.png` / `thumbnail.jpg`; returns the file and warnings (e.g. too big for YouTube)."""
    target = save(render(s), out_dir / f"thumbnail.{s.format}", s.format)
    other = out_dir / ("thumbnail.jpg" if s.format == "png" else "thumbnail.png")
    other.unlink(missing_ok=True)                  # only one thumbnail per export
    warnings = []
    if target.stat().st_size > YOUTUBE_MAX_BYTES:
        warnings.append(f"thumbnail is {target.stat().st_size / 1048576:.1f} MB — YouTube accepts up to 2 MB "
                        "(choose JPG or a smaller size)")
    return target, warnings


def preview(s: ThumbnailSettings, cache: Path, max_w: int = 960) -> dict:
    """Small renders for the export screen: with the badge and the bare picture (for dragging the badge)."""
    from PIL import Image
    if not s.image or not Path(s.image).is_file():
        raise ThumbnailError("add a picture for the thumbnail first")
    k = max_w / s.width if s.width > max_w else 1.0
    size = (max(16, round(s.width * k)), max(16, round(s.height * k)))
    key = hashlib.sha256(json.dumps([s.model_dump(), size, Path(s.image).stat().st_mtime], sort_keys=True,
                                    default=str).encode()).hexdigest()[:16]
    cache.mkdir(parents=True, exist_ok=True)
    full, bare = cache / f"{key}.png", cache / f"{key}.base.png"
    if not full.is_file():
        render(s, size).save(full, "PNG")
    if not bare.is_file():
        render(s, size, with_badge=False).save(bare, "PNG")
    with Image.open(s.image) as im:
        iw, ih = im.size
    pl = placement(s, iw, ih, *size)
    text = ""
    try:
        text = badge_text(s)
    except ThumbnailError:
        pass
    return {"image": str(full), "base": str(bare), "width": size[0], "height": size[1], "key": key,
            "placement": pl.model_dump(), "text": text}

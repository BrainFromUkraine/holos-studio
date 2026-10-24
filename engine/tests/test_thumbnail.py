"""Thumbnail: picture added to the project, cover crop, badge in picture coordinates, export, API, MCP."""
import numpy as np
import pytest
import soundfile as sf
from fastapi.testclient import TestClient
from PIL import Image

from holos import ops
from holos import thumbnail as TH
from holos.project import Badge, Project, ThumbnailSettings
from holos.server import create_app

SR = 48000


@pytest.fixture()
def home(tmp_path, monkeypatch):
    h = tmp_path / "home"
    monkeypatch.setenv("HOLOS_HOME", str(h))
    monkeypatch.delenv("HOLOS_TEMPLATES", raising=False)
    return h


def _picture(f, w=1600, h=900):
    """Left half red, right half blue, so crops are easy to check."""
    a = np.zeros((h, w, 3), np.uint8)
    a[:, : w // 2] = (200, 0, 0)
    a[:, w // 2:] = (0, 0, 200)
    Image.fromarray(a).save(f)
    return str(f)


def _project(tmp_path, folder="ep") -> str:
    d = tmp_path / folder
    d.mkdir()
    x = np.random.default_rng(1).standard_normal(SR * 3) * 0.05
    f = d / "POD00001.WAV"
    sf.write(f, np.stack([x, x], 1), SR, subtype="PCM_24")
    path = str(d / "ep.holos")
    p, _ = ops.create_project(path, [str(f)], "Ep")
    ops.analyze_project(p, path)
    return path


def test_render_size_crop_and_badge(tmp_path):
    pic = _picture(tmp_path / "pic.png")
    s = ThumbnailSettings(image=pic, width=1280, height=720, episode=4,
                          badge=Badge(text="ВИПУСК {n}", x=0.25, y=0.5, width=0.4, height=0.12, angle=-4.5,
                                      fill="#d6fa06", ink="#060606"))
    img = TH.render(s)
    assert img.size == (1280, 720)
    plate = img.getpixel((190, 360))                       # on the badge, left of the text
    assert plate[1] > 200 and plate[0] > 180                # yellow-green
    assert img.getpixel((320, 360))[1] < 60                 # dark text in the middle
    assert img.getpixel((1200, 40)) == (0, 0, 200)
    # square output: the picture is cropped evenly, the badge stays on the same spot of the picture
    sq = TH.render(s.model_copy(update={"width": 900, "height": 900}))
    assert sq.size == (900, 900)
    pl = TH.placement(s, 1600, 900, 900, 900)
    assert pl.left == pytest.approx(350) and pl.top == 0
    assert pl.badge["cx"] == pytest.approx(0.25 * 1600 - 350)
    bare = TH.render(s, with_badge=False)
    assert bare.getpixel((320, 360)) == (200, 0, 0)


def test_badge_text_needs_number(tmp_path):
    s = ThumbnailSettings(image=_picture(tmp_path / "p.png"), badge=Badge(text="EP {n}"))
    with pytest.raises(TH.ThumbnailError):
        TH.badge_text(s)
    assert TH.badge_text(s.model_copy(update={"episode": 12})) == "EP 12"
    with pytest.raises(TH.ThumbnailError):
        TH.render(ThumbnailSettings(image=str(tmp_path / "missing.png"), episode=1))


def test_settings_copy_picture_and_carry_over(tmp_path, home):
    path = _project(tmp_path)
    pic = _picture(tmp_path / "cover.png")
    p = Project.load(path)
    s = TH.update(p, path, {"image": pic, "episode": 4, "width": 1280, "height": 720, "badge": {"text": "ВИПУСК {n}"}})
    assert s.image.endswith("cover.png") and "Assets" in s.image and s.image != pic
    assert Project.load(path).export.thumbnail.episode == 4
    with pytest.raises(TH.ThumbnailError):
        TH.update(p, path, {"colour": "red"})
    TH.remember(s, path)
    # the next episode starts from the same picture / badge with the number + 1
    path2 = _project(tmp_path, "ep2")
    s2 = TH.initial(Project.load(path2), path2)
    assert s2.episode == 5 and s2.badge.text == "ВИПУСК {n}" and s2.width == 1280
    # the same project keeps its number
    assert TH.initial(Project.load(path), path).episode == 4


def test_export_writes_thumbnail(tmp_path, home):
    path = _project(tmp_path)
    p = Project.load(path)
    TH.update(p, path, {"image": _picture(tmp_path / "c.png"), "episode": 2, "format": "png", "width": 640, "height": 360})
    r = ops.export_project(path, tmp_path / "out", wav=False, mp3=False, thumbnail=True)
    f = r["files"]["thumbnail"]
    assert f.endswith("thumbnail.png")
    assert Image.open(f).size == (640, 360)
    assert Project.load(path).export.make_thumbnail is True
    TH.update(Project.load(path), path, {"format": "jpg"})
    r = ops.export_project(path, tmp_path / "out", wav=False, mp3=False)
    assert r["files"]["thumbnail"].endswith("thumbnail.jpg")
    assert not (tmp_path / "out" / "thumbnail.png").exists()
    # the next episode gets the remembered picture copied into its own folder, number + 1
    path2 = _project(tmp_path, "ep2")
    r = ops.export_project(path2, tmp_path / "o2", wav=False, mp3=False, thumbnail=True)
    s2 = Project.load(path2).export.thumbnail
    assert s2.episode == 3 and str(tmp_path / "ep2" / "Assets") in s2.image


def test_export_without_picture(tmp_path, home):
    path = _project(tmp_path)
    with pytest.raises(TH.ThumbnailError):
        ops.export_project(path, tmp_path / "o", wav=False, mp3=False, thumbnail=True)


def test_api_and_mcp(tmp_path, home):
    path = _project(tmp_path)
    c = TestClient(create_app(token="t"))
    h = {"X-Holos-Token": "t"}
    r = c.get("/api/projects/thumbnail", params={"path": path}, headers=h).json()
    assert r["preview"] is None and r["enabled"] is False and {"width": 1920, "height": 1080} in r["presets"]
    pic = _picture(tmp_path / "c.png")
    r = c.put("/api/projects/thumbnail", json={"path": path, "changes": {"image": pic, "episode": 3, "enabled": True,
                                                                         "badge": {"x": 0.3}}}, headers=h).json()
    assert r["enabled"] is True and r["settings"]["badge"]["x"] == 0.3
    pv = r["preview"]
    assert pv["width"] == 960 and pv["height"] == 540 and Image.open(pv["image"]).size == (960, 540)
    assert c.get("/api/files/cache", params={"path": pv["base"], "token": "t"}).status_code == 200
    assert c.put("/api/projects/thumbnail", json={"path": path, "changes": {"width": 5}}, headers=h).status_code == 400
    assert c.get("/api/thumbnail/font", params={"token": "t"}).status_code == 200

    from holos import mcp_server as M
    info = M.set_thumbnail(path, {"episode": 9, "badge": {"text": "ВИПУСК {n}"}})
    assert info["badge_text"] == "ВИПУСК 9" and info["with_export"] is True and info["picture_ok"]
    assert M.get_thumbnail(path)["size"] == "1920x1080"

"""根据 Draiq 原始素材生成导航图标和网站图标。"""
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
source = Image.open(ROOT / "docs/brand/draiq-logo.png").convert("RGBA")
output = ROOT / "web/public/brand"
output.mkdir(parents=True, exist_ok=True)
source.save(output / "draiq-logo.png")
# 原始素材的字标上方包含 D 符号。完整保留符号，
# 去除展示留白，使其适用于小尺寸导航图标。
symbol = source.crop((360, 145, 960, 830))
symbol = symbol.crop(symbol.getchannel("A").getbbox())
symbol.thumbnail((448, 448), Image.Resampling.LANCZOS)
icon = Image.new("RGBA", (512, 512))
icon.alpha_composite(symbol, ((512 - symbol.width) // 2, (512 - symbol.height) // 2))
icon.save(output / "draiq-icon.png")
icon.save(ROOT / "web/public/favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)])
print("已生成 Draiq 标识、导航图标和网站图标。")

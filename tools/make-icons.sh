#!/usr/bin/env bash
# 由 public/icons/*.svg 生成各尺寸 PNG。
#
# 产物已提交进仓库，正常开发/部署**不需要**运行本脚本——应用保持零构建步骤。
# 只有修改了图标源文件时才需要重新生成。
#
#   ./tools/make-icons.sh
#
# 依赖 macOS 自带的 sips（能直接栅格化 SVG）。
# 在 Linux 上可用 rsvg-convert 或 inkscape 替代，命令语义相同。
set -euo pipefail

cd "$(dirname "$0")/../public/icons"

if ! command -v sips >/dev/null 2>&1; then
  echo "找不到 sips。Linux 上请改用：" >&2
  echo "  rsvg-convert -w 512 -h 512 icon.svg -o icon-512.png   # 其余同理" >&2
  exit 1
fi

# 两个满幅版本（无圆角）：
#   apple-touch.svg —— iOS 主屏图标必须完全不透明，透明角会被合成成黑角
#   maskable.svg    —— Android 自适应图标，图形须落在中央 80% 安全区内
gen() { # <源 svg> <边长> <输出>
  sips -s format png -Z "$2" "$1" --out "$3" >/dev/null
  printf '  %-26s %sx%s\n' "$3" "$2" "$2"
}

echo "生成图标："
gen icon.svg        512 icon-512.png
gen icon.svg        192 icon-192.png
gen apple-touch.svg 180 apple-touch-icon-180.png
gen maskable.svg    512 maskable-512.png
echo "完成。"

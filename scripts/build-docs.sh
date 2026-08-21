#!/bin/bash

# 手順書 (docs/setup-guide.md) を PDF に変換する。
#
# PDF を手で作ると Markdown との乖離に気づけない。生成手順をリポジトリに
# 置いておき、md を直したら必ずこれを実行して PDF を作り直す。

set -e

cleanup() {
  rm -f "$WORK/setup-guide.html" "$WORK/pdf.css" "$WORK/raw.pdf"
}

SRC="docs/setup-guide.md"
OUT="docs/setup-guide.pdf"
WORK="${TMPDIR:-/tmp}"
trap cleanup EXIT

# pandoc は Markdown を HTML に、Chrome はその HTML を PDF にする。
# LaTeX 経由にしないのは、日本語フォントの設定が環境ごとに壊れやすいため。
# Chrome のヘッドレス印刷はシステムのフォントをそのまま使う。
if ! command -v pandoc >/dev/null 2>&1; then
  echo "❌ pandoc が見つかりません: brew install pandoc" >&2
  exit 1
fi

CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
if [ ! -x "$CHROME" ]; then
  echo "❌ Google Chrome が見つかりません（PDF 変換に使います）" >&2
  exit 1
fi

echo "📝 スタイルを用意..."
cat > "$WORK/pdf.css" <<'CSS'
@page { size: A4; margin: 18mm 16mm 20mm; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body {
  font-family: "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Noto Sans JP", sans-serif;
  font-size: 10.2pt; line-height: 1.75; color: #1a1a1a; max-width: none; margin: 0;
}
h1 { font-size: 17pt; border-bottom: 2.5px solid #c8102e; padding-bottom: 6px;
     margin: 26px 0 14px; page-break-before: always; page-break-after: avoid; }
h1:first-of-type { page-break-before: avoid; }
h2 { font-size: 13pt; margin: 22px 0 8px; padding-left: 9px;
     border-left: 4px solid #c8102e; page-break-after: avoid; }
h3 { font-size: 11.2pt; margin: 16px 0 6px; color: #333; page-break-after: avoid; }
table { border-collapse: collapse; width: 100%; margin: 10px 0; font-size: 9.3pt;
        page-break-inside: avoid; }
th, td { border: 1px solid #cfcfcf; padding: 5px 8px; text-align: left; vertical-align: top; }
th { background: #f2f2f4; font-weight: 600; }
code { font-family: "SF Mono", Menlo, monospace; font-size: 8.9pt;
       background: #f4f4f6; padding: 1px 4px; border-radius: 3px; }
pre { background: #f7f7f9; border: 1px solid #e0e0e4; border-left: 3px solid #888;
      padding: 9px 11px; border-radius: 4px; overflow-x: auto; page-break-inside: avoid; }
pre code { background: none; padding: 0; font-size: 8.6pt; line-height: 1.55; }
blockquote { border-left: 4px solid #e8a33d; background: #fdf7ec; margin: 12px 0;
             padding: 9px 13px; page-break-inside: avoid; }
blockquote p { margin: 4px 0; }
ul, ol { padding-left: 1.5em; }
li { margin: 3px 0; }
hr { border: none; border-top: 1px solid #ddd; margin: 20px 0; }
strong { font-weight: 600; }
.title { font-size: 22pt; font-weight: 700; margin-bottom: 4px; }
.subtitle { font-size: 12pt; color: #666; }
.date { font-size: 10pt; color: #888; margin-top: 10px; }
header#title-block-header { border-bottom: none; padding: 40px 0 26px; margin-bottom: 10px; }
/* Claude に入力する文言。警告 (blockquote) と見分けが付くようにする */
.prompt {
  border: 1px solid #b9c6e0; border-left: 4px solid #3b6cb7; background: #f2f6fc;
  padding: 9px 13px 9px 15px; margin: 10px 0; border-radius: 4px;
  font-size: 10pt; page-break-inside: avoid;
}
.prompt::before {
  content: "Claude に入力"; display: block; font-size: 7.6pt; font-weight: 600;
  color: #3b6cb7; letter-spacing: .04em; margin-bottom: 3px;
}
/* 印刷物なのでリンクは下線なしの落ち着いた色にする */
a { color: #1a1a1a; text-decoration: none; }
#TOC a { color: #24405e; }
#TOC { border: 1px solid #e2e2e6; background: #fafafb; padding: 10px 16px;
       border-radius: 5px; font-size: 9.4pt; }
#TOC ul { margin: 3px 0; }
CSS

echo "📄 Markdown → HTML..."
pandoc "$SRC" -f markdown -t html5 --standalone --metadata charset=UTF-8 \
  --css "$WORK/pdf.css" --embed-resources --toc --toc-depth=2 \
  -o "$WORK/setup-guide.html"

echo "🖨  HTML → PDF..."
"$CHROME" --headless --disable-gpu --no-pdf-header-footer \
  --print-to-pdf="$WORK/raw.pdf" --virtual-time-budget=10000 \
  "file://$WORK/setup-guide.html" 2>/dev/null

# Chrome の出力はフォントを丸ごと埋め込むため 6MB 近くなる。Ghostscript が
# あればサブセット化する（14ページで 5.9MB → 0.85MB）。無くても PDF は出す。
if command -v gs >/dev/null 2>&1; then
  echo "🗜  フォントをサブセット化..."
  gs -sDEVICE=pdfwrite -dCompatibilityLevel=1.5 -dPDFSETTINGS=/prepress \
     -dNOPAUSE -dQUIET -dBATCH -dSubsetFonts=true \
     -sOutputFile="$OUT" "$WORK/raw.pdf"
else
  echo "ℹ️  Ghostscript が無いため圧縮を省略します（brew install ghostscript）"
  cp "$WORK/raw.pdf" "$OUT"
fi

echo "✅ $OUT ($(du -h "$OUT" | cut -f1))"

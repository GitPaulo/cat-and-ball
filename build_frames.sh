#!/usr/bin/env bash
set -e

mkdir -p frames_compressed

for file in frames/*.txt; do
    filename=$(basename "$file" .txt)
    svgfile="frames_compressed/${filename}.svg"

    echo -n "<svg xmlns='http://www.w3.org/2000/svg' width='600' height='80'><text font-family='Courier New, monospace' font-size='14' fill='white' xml:space='preserve'>" >"$svgfile"

    # Convert text to SVG <tspan>
    lineno=0
    while IFS= read -r line; do
        if [ "$lineno" -eq 0 ]; then
            echo -n "<tspan x='10' dy='0'>${line}</tspan>" >>"$svgfile"
        else
            echo -n "<tspan x='10' dy='16'>${line}</tspan>" >>"$svgfile"
        fi
        lineno=$((lineno + 1))
    done <"$file"

    echo "</text></svg>" >>"$svgfile"

    # Gzip it
    gzip -9 -c "$svgfile" >"${svgfile}.gz"
done

echo "✅ Frames precompressed in frames_compressed/"

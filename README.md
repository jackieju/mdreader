# MD Reader

Native macOS markdown reader built with Tauri v2 (pure Rust backend, static HTML/CSS/JS frontend — no node/vite/webpack build step). Renders `.md` files in an exact replica of the opencode `terminal-match` theme as it appears in Apple Terminal.app with **SF Mono Regular 11pt**.

## Features

- Native **File > Open** (⌘O) — opens any `.md` / `.markdown` / `.mdown` / `.mkd` / `.txt` file.
- Drag-and-drop a markdown file onto the window to open it.
- Full monospace grid look (everything SF Mono / Menlo).
- Syntax highlighting with the exact opencode syntax palette.
- Fully offline: `marked` and `highlight.js` are vendored under `dist/vendor/`.

## Project layout

```
mdreader/
├── README.md
├── dist/                       ← static frontend (no build step)
│   ├── index.html
│   ├── app.js
│   ├── style.css
│   └── vendor/
│       ├── marked.min.js       ← vendored (offline)
│       ├── highlight.min.js    ← vendored (offline)
│       └── hljs-opencode.css   ← opencode syntax colors
└── src-tauri/
    ├── Cargo.toml
    ├── build.rs
    ├── tauri.conf.json
    └── src/
        └── main.rs
```

## Build & run

Requires Rust ≥ 1.77 and Xcode Command Line Tools. `tauri-cli` is **not** required — plain `cargo` works.

Dev / debug run:

```sh
cd src-tauri
cargo run
```

Release build (produces `target/release/mdreader` binary and a bundled `.app`):

```sh
cd src-tauri
cargo build --release
```

The bundled macOS app appears at:

```
src-tauri/target/release/bundle/macos/MD Reader.app
```

Launch it either with `open "src-tauri/target/release/bundle/macos/MD Reader.app"` or by double-clicking in Finder.

If you prefer the Tauri CLI:

```sh
cargo install tauri-cli --version "^2"
cargo tauri dev       # or `cargo tauri build`
```

## Theme (opencode `terminal-match`, SF Mono 11pt)

| Role                | Hex        |
| ------------------- | ---------- |
| Page background     | `#ef989b`  |
| Panel / code bg     | `#df8d90`  |
| Panel border        | `#2d2d2d`  |
| Body text           | `#edecee`  |
| Headings / strong   | `#000000`  |
| Emphasis (italic)   | `#ffca76`  |
| Links               | `#96349f`  |
| Inline code         | `#364af6`  |
| Block quote         | `#6d6d6d`  |
| List markers        | `#000000`  |
| Horizontal rule     | `#6d6d6d`  |
| Muted text          | `#000000`  |

Syntax highlighting (mapped onto highlight.js classes in `dist/vendor/hljs-opencode.css`):

| Token                          | Hex        |
| ------------------------------ | ---------- |
| comment                        | `#6d6d6d`  |
| keyword                        | `#96349f`  |
| string                         | `#364af6`  |
| number                         | `#9dff65`  |
| function / type / variable     | `#0d4f2a`  |
| operator                       | `#96349f`  |
| punctuation                    | `#edecee`  |

Global font stack:

```css
font-family: "SF Mono", "SFMono-Regular", Menlo, Monaco, monospace;
font-size: 14px;
line-height: 1.5;
```

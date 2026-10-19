# Application icon

`icon.svg` is the editable, colored application artwork, adapted from the user-supplied
`streamline-pixel--business-product-piggy-bank.svg` (Streamline Pixel). It retains the source's
pixel shapes, with an indigo tile, a pink pig with a berry outline, a gold coin and pale-gold sparkles.
The SVG description records the source; this repository does not assert a new license for the original artwork.

The committed packaging assets are `build/icon.icns` (macOS), `build/icon.ico` (Windows,
16–256px), and `build/icon.png` (Linux, 1024px). `electron-builder.yml` selects them explicitly.
Packaging uses those assets directly and does not require image-generation tools.

To regenerate all three on macOS:

```sh
brew install librsvg imagemagick
bun run app-icons:generate
```

The generator also uses Apple's built-in `iconutil`. Its temporary iconset is removed on success
or failure; missing converters and conversion failures are reported rather than replaced with a default icon.

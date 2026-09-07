# Certificate typefaces — bundled, not resolved by name

`utils/pdf-certificate.js` embeds these four faces into the PDF
(`doc.registerFont`) and converts them to `<path>` outlines for the SVG the
PNG/JPG are composed from. **Neither output references a font by name**, so
neither can be rendered differently by the machine it runs on.

That is the fix for a real production defect, not a preference. The SVG used to
name `Helvetica, 'Liberation Sans', 'Nimbus Sans', Arial, sans-serif`; the
container is `node:20-alpine`, which ships no font packages at all. librsvg
resolved none of the names, so every downloaded PNG and JPG had a row of
`.notdef` boxes where the text should be while the frame artwork rendered
perfectly. It looked right on macOS only because the OS substitutes a fallback
— there is nothing in the image to substitute from. Installing a font package
in the Dockerfile would fix the symptom until the next base image.

## What is here

| File | Role in the certificate | Family / weight |
|---|---|---|
| `PlayfairDisplay-Bold.ttf` | the heading — "CERTIFICATE OF COMPLETION", brand red, tracked wide | Playfair Display Bold (700) |
| `IBMPlexSans-Bold.ttf`     | recipient name (uppercase) and the title | IBM Plex Sans Bold (700) |
| `IBMPlexSans-Regular.ttf`  | eyebrows, date, signatory caption, footer | IBM Plex Sans Regular (400) |
| `GreatVibes-Regular.ttf`   | the signatory's name, above the rule | Great Vibes Regular (400) |

All four are **static instances**, deliberately — a variable `.ttf` embeds as
its default weight and gives up the weight the design asked for, with nothing
to flag it.

IBM Plex Sans is the EasyFix brand face (`EasyFix-Brand-Kit/build/fonts/`).
Playfair Display and Great Vibes are the serif and script the approved
certificate reference calls for; the Brand Kit bundles neither.

## Licences — all SIL Open Font License 1.1, embedding permitted

| Font | Licence text here | Upstream |
|---|---|---|
| IBM Plex Sans | `OFL-IBMPlexSans.txt` | <https://github.com/IBM/plex> — copied from `EasyFix-Brand-Kit/build/fonts/OFL.txt` |
| Playfair Display | `OFL-PlayfairDisplay.txt` | <https://github.com/clauseggers/Playfair-Display> |
| Great Vibes | `OFL-GreatVibes.txt` | <https://github.com/googlefonts/great-vibes> |

The OFL explicitly permits embedding in a document; it forbids selling the
fonts on their own and requires the licence to travel with them, which is what
these three files are for. Reserved Font Names apply (Playfair Display, IBM
Plex): do not ship a MODIFIED copy under the same name.

## Provenance

- `IBMPlexSans-Regular.ttf` — copied verbatim from `EasyFix-Brand-Kit`
  `build/fonts/` (kit commit `ebe18b9`, the same commit
  `assets/certificate/` was vendored from).
- `PlayfairDisplay-Bold.ttf`, `IBMPlexSans-Bold.ttf`, `GreatVibes-Regular.ttf`
  — static instances served by the Google Fonts CSS API, fetched 2026-09-07:

      curl -A 'Mozilla/4.0' 'https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700'
      curl -A 'Mozilla/4.0' 'https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@700'
      curl -A 'Mozilla/4.0' 'https://fonts.googleapis.com/css2?family=Great+Vibes'

  (the old user-agent is what makes the API answer with `.ttf` rather than
  `.woff2`; then fetch the `fonts.gstatic.com` URL it prints). The
  `google/fonts` repo now carries Playfair Display and IBM Plex Sans only as
  variable `[wght].ttf` files, which is why they are not taken from there.

Unlike `assets/certificate/`, nothing regenerates this directory: these are
upstream release binaries, not build output. Replacing one is a deliberate act
— re-measure the certificate afterwards, because every point size in
`STYLE` was chosen against these faces' advance widths.

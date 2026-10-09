# Astro CAD Viewer

Public, static front end for viewing locally generated CAD previews.

The site is published at <https://felix34003.github.io/astro_cad-viewer/>. This
repository contains the browser interface and its Pages deployment workflow. It
does not contain model files, generated outputs, or the Fusion helper.

The viewer can read an `outputs/` folder selected by the visitor or connect to a
compatible helper running on that same visitor's computer. Model files remain
local to that computer. Fusion import also requires that visitor's own Fusion
MCP connection and an explicit approval in the viewer.

With a compatible helper, the Fusion import dialog shows the current stage,
completed STEP parts and joints, native motion checks, and elapsed time for the
current step. A slow step alone is not treated as a failed import.

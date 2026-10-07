# Third-party notices

ModPacer is free software, released under the **GNU General Public License, version 3 only**
(see [LICENSE](LICENSE)). This file lists everything in it that came from somewhere else, where it came
from, and under what license.

## Code ported from Vortex and fomod-installer (GPL-3.0)

Both projects are GPL-3.0, the same license as this tool, which is why this tool is GPL-3.0 too.

**Vortex**: <https://github.com/Nexus-Mods/Vortex>, by Black Tree Gaming Ltd. / Nexus Mods. GPL-3.0.

| File here | What it contains | Taken from |
| :--- | :--- | :--- |
| `lib/mod-reference-match.js` | A faithful port of how Vortex decides whether a collection's rule points at an installed mod (id, file hash, file name + glob, Nexus ids, tag, version match) | `src/extensions/mod_management/util/testModReference.ts`, `coerceToSemver.ts`, `isFuzzyVersion.ts` |
| `lib/collection-membership.js` | How Vortex decides which collections a mod is in (the Mods page's Collection column): a collection rule that names a mod by id puts it in; any other rule is matched by content; and the content lookup behind it | `src/renderer/src/extensions/collections/index.ts` (`generateCollectionMap`), `src/extensions/mod_management/util/findModByRef.ts` |
| `lib/simple-installer.js` | The list of "this looks like real mod content" patterns for Skyrim SE, copied as-is, and the logic that strips a wrapper folder from an archive | Vortex's `installer_fomod_shared/utils/gameSupport.ts` (`stopPatterns('skyrimse')`); `ArchiveStructure.FindPathPrefix` from fomod-installer |

**fomod-installer**: <https://github.com/Nexus-Mods/fomod-installer>, Nexus Mods. GPL-3.0. These files were written
by reading its source and Vortex's, and re-implement the same behavior (file ordering, install-step rules,
condition handling). They are not line-for-line copies, but they follow that code closely enough that they are
treated as derived from it:

| File here | Behavior re-implemented |
| :--- | :--- |
| `lib/fomod-parser.js` | Reading a FOMOD installer's `ModuleConfig.xml` (its schema and `Parser20`/`Parser40`) |
| `lib/choice-resolver.js` | Turning recorded installer choices into the files to install (`XmlScriptInstaller.cs`: install phases and file-collision rules) |
| `lib/mod-root.js` | Finding the folder an installer's files are relative to (`ModFormatManager.cs`) |
| `lib/vortex-file-order.js` | The order Vortex lists an extracted archive's files in (`InstallManager.ts` `buildFileList()`, `util/walk.ts`) |

`lib/vortex-update.js` follows how Vortex itself replaces a mod (`InstallManager.ts`, `InstallContext.ts`, and the
download actions in `download_management/actions/state.ts`). That was researched from Vortex's source, but the code
itself is this tool's own.

All seven files named in the two tables above carry a short GPL notice at
the top.

## Code reused from the same author's other tools (now GPL-3.0 here)

These come from **Vortex Collection Tools** (<https://github.com/awesmdiver/vortex-collection-tools>) and
**SkyrimNet MultiProxy** (<https://github.com/awesmdiver/skyrimnet-multiproxy-dev>), written by the same person as
this tool, who is releasing the parts used here under GPL-3.0 along with the rest of it.

| File here | From |
| :--- | :--- |
| `lib/vortex-helper-client.js` | Vortex Collection Tools, `lib/vortex-helper-client.js` (including its `isVortexRunning`, from `lib/vortex-sync/lib.js`) |
| `lib/sevenzip.js`, `lib/extract-resolved-files.js`, `lib/simple-installer.js` (its non-Vortex parts) | Vortex Collection Tools |
| `lib/fomod-parser.js`, `lib/choice-resolver.js`, `lib/mod-root.js`, `lib/vortex-file-order.js` | Vortex Collection Tools (which is where the Vortex / fomod-installer behavior above was first written down) |
| `web/public/fomod-picker.js`, `lib/fomod-picker-data.js` (and its styles in `web/public/style.css`) | Ported from Vortex Collection Tools, `web/public/fomod-picker.js` and `lib/fomod-picker-data.js` |
| `lib/vortex-sync/win-dialog.js` | Vortex Collection Tools |
| `lib/mod-identity.js` | Adapted from Vortex Collection Tools, `lib/build-mod-from-vortex-state.js` |
| `lib/nexus.js`, `lib/download-file.js` | Adapted from Vortex Collection Tools' Nexus download code |
| `lib/vortex-update.js` (`resolveOrRegisterArchiveId`) | Adapted from Vortex Collection Tools' update-collection code |
| `lib/skyrimnet-install.js` (`resolveSkyrimNetDir`) | Ported from SkyrimNet MultiProxy's `proxy.py` (same algorithm) |

## Bundled program: 7-Zip

`tools/7-Zip/7z.exe` and `7z.dll`, by **Igor Pavlov** (<https://www.7-zip.org/>). Mostly GNU LGPL; some code is
LGPL with the "unRAR license restriction", and some is BSD 2-clause or BSD 3-clause. Its own `License.txt` ships
beside it, as its license requires. This tool starts 7-Zip as a separate program to open archives, which is
compatible with GPL-3.0. The unRAR restriction means 7-Zip's RAR code may not be used to build a program that
re-creates the RAR compression algorithm; this tool only reads archives.

## Bundled program: Node.js

`runtime/node.exe` is the official Windows x64 build of **Node.js** (<https://nodejs.org>), by the **OpenJS Foundation** and
Node.js contributors, so a player doesn't have to install anything. Node.js is under the **MIT license**. Its own `LICENSE`
file ships beside it as `runtime/LICENSE`; that file also lists the licenses of everything Node.js itself bundles (V8, OpenSSL,
ICU, libuv, zlib, and others, all permissive licenses), and has to travel with it. This tool starts Node.js as a separate program
to run its own code, which is compatible with GPL-3.0, and does not modify it. The exact build is pinned (and its checksum
verified against nodejs.org's published `SHASUMS256.txt`) in `release/manifest.json`.

## Bundled extension: the Vortex Bridge

`helper/vortex-bridge/` (and the same files as `helper/vortex-bridge.zip`) is the **Vortex Bridge**, a Vortex extension written by the same person as this tool (<https://github.com/awesmdiver/vortex-bridge>).
It is their own code, under the **MIT license**; its own `LICENSE` ships inside the folder and the zip. The updater copies it into
Vortex's plugins folder when the player clicks to install it. It runs inside Vortex, not inside this tool.

## Libraries (installed with `npm`, license files included in each package's folder under `node_modules/`)

| Package | License |
| :--- | :--- |
| `express` and its dependencies | MIT |
| `fast-xml-parser` and its dependencies | MIT |
| `minimatch` (the same package Vortex's own code uses for file patterns) | BlueOak-1.0.0 |
| `semver`, `inherits`, `once`, `wrappy`, `setprototypeof` | ISC |
| `qs` | BSD-3-Clause |

All of these are permissive licenses that are compatible with GPL-3.0.

## Data this tool reads (not part of the download)

The **SkyrimNet Plugin Hub** catalog (<https://github.com/MinLL/SkyrimNet-Plugins>), by MinLL and the SkyrimNet team.
The tool downloads it at run time to learn each mod's latest version; none of it is bundled or redistributed.

The Hub's own catalog file (`index.json`, the same data with each mod's download and endorsement counts) and its download counter (<https://fateless.ai>, the Plugin Hub API) are by the SkyrimNet team
and fateless.ai. When the player installs or updates a mod, or opens its page, the tool tells that counter the mod's name and version, so the author's counts are right; Settings has a switch to turn that off.

## The fateless.ai icon

The little icon on each row's plugins-page link is the **fateless.ai** site mark (<https://fateless.ai/favicon.svg>, the rune ᚠ in cyan on a dark rounded square), by **fateless.ai / the SkyrimNet team**. It is
used here with the permission of the SkyrimNet author, Min (2026-10-04), and redrawn as plain SVG paths so it shows the same on every PC. It is a brand mark and stays theirs; it is not under this project's license.

## Mod Organizer 2

ModPacer reads **Mod Organizer 2**'s settings file (`ModOrganizer.ini`) and the active profile's mod list (`modlist.txt`) to find your folders and to know which mods are switched on and in what order (<https://github.com/ModOrganizer2/modorganizer>, GPL-3.0). Only the file formats were read from its public repository; **no Mod Organizer 2 code is included.** ModPacer never writes into its folders.

It also works with **Vortex** and **Nexus Mods**. None of their code is included beyond what is listed
above.

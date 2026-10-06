# ModPacer help

Easily install new mods and keep them on pace with updates. This page answers common questions.

## The page at a glance

The top of the page has four tiles. Click one to jump to its section.

- **Updates ready:** Mods you have that have a newer version. Click **Update** on one, or **Update all**.
- **Download from Nexus:** Mods where the new version is only on Nexus. ModPacer opens the Nexus page for you. (If you add a Nexus Premium key, ModPacer can download them for you!)
- **Up to date:** Mods that are already on the latest version.
- **Not installed:** Mods in the catalog that you don't have yet. Click **Install** on one, or **Install all**.

## Vortex Bridge (for Vortex users)

**What it is:** Vortex Bridge is a tiny add-on for Vortex. It lets ModPacer see the mods you have in Vortex and install new ones for you.

**Do I need it?** Yes, if you use Vortex. If you use Mod Organizer 2, skip this part.

**How to get it:** Vortex Bridge comes inside the ModPacer download. ModPacer can't add it to Vortex for you, so you do that part in Vortex:

1. In ModPacer's setup, click **Get the Vortex Bridge**. It opens the folder with `vortex-bridge.zip` in it.
2. In Vortex, click **Home**, then **Extensions**.
3. Drag `vortex-bridge.zip` onto the **Drop File(s)** box at the bottom of the page.
4. Restart Vortex if it asks you to. Then check that **Vortex Bridge** is in the list and says **Enabled**.
5. Back in ModPacer, click **Check again**.

The file is in the `helper` folder inside your ModPacer folder.

**If ModPacer says a newer Vortex Bridge comes with it:** you can click **Skip**: the one you have still works. To update it:

1. In Vortex, click **Home**, then **Extensions**.
2. Remove the existing extension and restart Vortex.
3. Drag `vortex-bridge.zip` onto the **Drop File(s)** box at the bottom of the page.
4. Restart Vortex if it asks you to.
5. Back in ModPacer, click **Check again**.

**Why remove it first?** If you drop the new one on top, Vortex shows both versions until it restarts. If you then remove the older one, Vortex removes the new one too, because they are the same extension.

**Why does ModPacer sometimes wait on Vortex?** Vortex needs to be open, finished loading, and not showing any pop-up messages for the Bridge to answer. ModPacer will patiently wait and check again on its own.

## Installing and updating

1. Click **Install** or **Update** on a mod.
2. Watch the progress on the screen. If the mod has options to pick (a FOMOD), a screen will pop up. Pick what you want and carry on.
3. When you are done with a batch of mods, click the **Deploy** button. This tells Vortex to apply your mods, and ModPacer will show you the progress.
4. Open Vortex and make sure the mod's plugins are turned on. ModPacer turns them on when it can, and tells you when it does. (If you turned a plugin off yourself, it stays off.)

If Vortex is waiting for you to click something (like a pop-up warning), ModPacer will tell you. Just switch to Vortex, answer the pop-up, and ModPacer will keep going.

**For Mod Organizer 2 users:** ModPacer downloads new files straight into your MO2 downloads folder and stops there. You install them in MO2 just like you normally do. In **Settings**, pick your **Mod Organizer 2 folder** (the one with `ModOrganizer.exe`). ModPacer reads it to find your mods and your Skyrim folder, and never changes it.

## How to Change Your Mod Manager in ModPacer

ModPacer only prompts you to select a mod manager during its initial setup. To switch between managers like Vortex and Mod Organizer 2, you must perform a fresh reset. This process will not affect your installed mods.

1. Right-click the ModPacer icon in your system tray (next to the clock) and select **Stop**.
2. Open the ModPacer folder: where `ModPacer.exe` is (`%LOCALAPPDATA%\Programs\ModPacer` if you used the installer, or the folder you unzipped).
3. Delete the file `config.json`. Note: This will erase your ModPacer configuration, including settings like your Nexus key.
4. Start ModPacer again to trigger the setup pop-up and choose your new mod manager.

## Adult (NSFW) mods

Adult mods are hidden by default. To see them, turn them on in **Settings**. It will ask "Are you 18 or older?" just once. These mods carry an **NSFW** tag so you know what they are.

## "Requires X"

Some mods need another mod to work. If you see "Requires X. Install it before this mod," make sure to install that required mod first! ModPacer does not install requirements for you automatically.

## Visits, endorsements and the plugins page

Each mod shows its **visits** and **endorsements** from the SkyrimNet Plugin Hub. You will also see two links: **Mod page** (the mod's own page, usually GitHub) and the **fateless.ai icon** (the mod's page on fateless.ai/plugins).

When you install a mod, update one, or open a mod's page from ModPacer, it pings fateless.ai so the author gets credit for the visit. **Only the mod's name and version are sent, nothing about you.** You can turn this off in **Settings** under "Tell the plugins page when I install or update a mod."

## For mod authors

If players use ModPacer to install and update your mod:

- **fateless.ai records it.** Each install, update, or page open through ModPacer is counted on your plugin's page at fateless.ai/plugins, the exact same place your other visits show up. It counts once per person action, per version.
- **Your own page counts it too.** For a GitHub mod, ModPacer downloads the file directly from your release, so GitHub's download count goes up as it always does. For a Nexus mod, ModPacer opens your Nexus page and the person downloads it there, so Nexus counts it.
- **Your credit stays attached.** Every single row names your mod and links directly to your mod page and your fateless.ai page. ModPacer never hides where a mod came from.
- **Endorsements are yours.** ModPacer only displays endorsement counts from the Hub. It can't endorse for anyone yet, and it never changes your numbers.

Want your mod listed? Publish it on the SkyrimNet Plugin Hub and ModPacer will find it.

## Privacy

- Everything ModPacer saves lives right in its own folder. To completely remove ModPacer, just delete that folder.
- Your Nexus key, if you add one, stays safely on your PC.
- ModPacer keeps a small log in its own `logs` folder, with no keys in it. Turn it off any time with **Keep a log** in Settings.
- To tell you when a new ModPacer is out, it reads its own listing on the Plugin Hub, the list it already reads. Turn it off any time in **Settings**.
- The only thing sent over the internet is the mod's name and version to fateless.ai when you install, update, or open a page (and you can turn that off).

## Stuck?

- **"Vortex isn't answering":** Check that Vortex is open and has no pop-ups waiting, then click **Retry**.
- **Nothing shows up in a section:** The tile might count a mod, but the list can be empty if that mod is filtered out (like a hidden adult mod).
- **"I can't find SkyrimNet":** In **Settings**, pick your **Mod Organizer 2 folder**, or pick the **SkyrimNet folder** yourself (the one with a `config` folder inside it). ModPacer's message lists the folders it checked.
- **Still stuck?** Open **Settings**, press **Open log folder**, and send us `update.log` on the [ModPacer Issues page](https://github.com/awesmdiver/modpacer/issues). Please don't send `config.json`: it holds your settings, including a Nexus key if you added one.

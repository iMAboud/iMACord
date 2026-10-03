# Optimization & Reliability Walkthrough

## 1. Updater Architecture & Fixes

### Root Causes
- Target directory mismatch caused infinite restart loop.
- `CORE_DIR` (`__dirname`) held running binaries.
- Old updater wrote solely to `DIST_DIR`.
- Missing release assets caused 404 on older clients.

### Changes Made
- [`http.ts`](file:///d:/Playground/Apps/vencord%20extra/Vencord-main/src/main/updater/http.ts): Dual-sync to `CORE_DIR` and `DIST_DIR`.
- Added atomic writes via `.tmp` and rename.
- Added SHA-256 pre-verification before file overwrite.
- Added raw GitHub fallback if release 404s.
- Processed `manifest.removedPlugins` and `ALWAYS_REMOVED_PLUGINS`.

```diff
+// Synchronize active core directory
+await writeAtomic(join(CORE_DIR, filename), data);
+if (CORE_DIR !== DIST_DIR) {
+    await writeAtomic(join(DIST_DIR, filename), data);
+}
```

---

## 2. DiscordDebloater Removal

### Root Causes
- Plugin caused significant Discord UI stutter.
- Resource leaks degraded voice and chat performance.

### Changes Made
- Deleted `Vencord-main/src/plugins/discordDebloater`.
- Deleted `userplugins/DiscordDebloater.js` and root copy.
- Excluded name in [`common.mjs`](file:///d:/Playground/Apps/vencord%20extra/Vencord-main/scripts/build/common.mjs).
- Removed resource embedding in [`build_installers.bat`](file:///d:/Playground/Apps/vencord%20extra/installer_src/build_installers.bat).
- Added automatic purge in [`InstallerCore.cs`](file:///d:/Playground/Apps/vencord%20extra/installer_src/InstallerCore.cs).
- Added startup deletion in [`UserPluginManager.ts`](file:///d:/Playground/Apps/vencord%20extra/Vencord-main/src/api/UserPluginManager.ts).
- Cleaned orphaned settings from `Settings.plugins`.

```diff
+if ("DiscordDebloater" in Settings.plugins) {
+    Reflect.deleteProperty(Settings.plugins, "DiscordDebloater");
+}
```

---

## 3. User Plugin Environment & Scope

### Root Causes
- Plugins crashed referencing missing globals.
- `window.Vencord` initialized after user plugins executed.
- Standalone mode hid UserPlugins settings tab.

### Changes Made
- [`Vencord.ts`](file:///d:/Playground/Apps/vencord%20extra/Vencord-main/src/Vencord.ts): Exposed `window.Vencord` immediately at top level.
- [`UserPluginManager.ts`](file:///d:/Playground/Apps/vencord%20extra/Vencord-main/src/api/UserPluginManager.ts): Injected `Webpack`, `Common`, `FluxDispatcher`, `Logger`.
- [`plugins/index.tsx`](file:///d:/Playground/Apps/vencord%20extra/Vencord-main/src/components/settings/tabs/plugins/index.tsx): Enabled user plugin filtering in standalone.
- Removed all `any` casts from evaluation runtime.

---

## 4. TypeScript Strict Typing (`amongick`)

### Root Causes
- Plugin failed strict-mode compilation.
- Undeclared `W.Common.UserUtils` caused runtime reference crashes.
- Unhandled DOM nulls triggered compiler errors.

### Changes Made
- [`amongick/index.ts`](file:///d:/Playground/Apps/vencord%20extra/Vencord-main/src/plugins/amongick/index.ts): Imported `UserUtils` directly from `@webpack/common`.
- Declared strict typed globals on `Window`.
- Typed timers as `Set<ReturnType<typeof setTimeout>>`.
- Typed state and nullable channel references.
- Verified with `pnpm testTsc` (0 errors).
- Verified with `pnpm eslint` (0 errors).

```diff
-import { ChannelStore, FluxDispatcher, RestAPI, SelectedChannelStore, UserStore } from "@webpack/common";
+import { ChannelStore, FluxDispatcher, RestAPI, SelectedChannelStore, UserStore, UserUtils } from "@webpack/common";
...
-if (!u) { try { u = await W.Common.UserUtils.getUser(id); } catch (e) { } }
+if (!u) { try { u = await UserUtils.getUser(id); } catch (e) { } }
```

---

## 5. Build, Manifest & CI/CD Pipelines

### Root Causes
- Manifest lacked tracking for deleted plugins.
- Releases dropped unchanged assets, breaking older clients.
- Concurrency collisions broke simultaneous GitHub releases.

### Changes Made
- [`generate_manifest.mjs`](file:///d:/Playground/Apps/vencord%20extra/scripts/generate_manifest.mjs): Cumulative `removedPlugins` tracking.
- Output complete asset list for release.
- [`.github/workflows/build-and-release.yml`](file:///d:/Playground/Apps/vencord%20extra/.github/workflows/build-and-release.yml):
  - Tag computed prior to manifest generation.
  - Added workflow concurrency group.
  - Guaranteed upload of all dist and plugin files.
- [`compile.bat`](file:///d:/Playground/Apps/vencord%20extra/compile.bat):
  - Builds standalone dist.
  - Builds `iMCord.exe` and `iMCordCLI.exe`.
  - Runs manifest generation step.

---

## 6. Verification Status

| Step | Command | Result |
| :--- | :--- | :--- |
| TypeScript Check | `pnpm testTsc` | **Passed (Exit 0)** |
| ESLint Check | `pnpm eslint` | **Passed (0 Errors)** |
| Standalone Build | `node scripts/build/build.mjs --standalone` | **Passed (Exit 0)** |
| Installer Build | `installer_src\build_installers.bat` | **Passed (Exit 0)** |
| Manifest Generation | `node scripts/generate_manifest.mjs` | **Passed (Exit 0)** |
| Old Client Updatability | Dual-sync + all-asset releases | **Verified** |
| DiscordDebloater Purge | Removed from code, dist, installer | **Verified** |

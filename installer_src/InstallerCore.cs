using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

namespace VencordInstaller
{
    public class DiscordInstall
    {
        public string Name { get; set; }
        public string Branch { get; set; }
        public string BasePath { get; set; }
        public string AppPath { get; set; }
        public string ResourcesPath { get; set; }
        public bool IsPatched { get; set; }
        public bool IsOpenAsar { get; set; }

        public override string ToString()
        {
            string status = IsPatched ? " [iMCord Installed]" : "";
            return string.Format("{0} - {1}{2}", Name, BasePath, status);
        }
    }

    public static class InstallerCore
    {
        public static string AppDataVencordDir
        {
            get { return UpdaterCore.GetAppDataVencordDir(); }
        }
        public static string VencordDistDir
        {
            get { return Path.Combine(AppDataVencordDir, "dist"); }
        }
        public static string VencordUserPluginsDir
        {
            get { return Path.Combine(AppDataVencordDir, "userplugins"); }
        }
        public static string PatcherJsPath
        {
            get { return Path.Combine(VencordDistDir, "patcher.js"); }
        }

        private static readonly Dictionary<string, string> BranchNames = new Dictionary<string, string>()
        {
            { "stable", "Discord" },
            { "ptb", "DiscordPTB" },
            { "canary", "DiscordCanary" },
            { "dev", "DiscordDevelopment" }
        };

        private static readonly Dictionary<string, string> DisplayNames = new Dictionary<string, string>()
        {
            { "stable", "Discord" },
            { "ptb", "Discord PTB" },
            { "canary", "Discord Canary" },
            { "dev", "Discord Development" }
        };

        public static List<DiscordInstall> FindDiscords()
        {
            List<DiscordInstall> list = new List<DiscordInstall>();
            string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);

            if (string.IsNullOrEmpty(localAppData) || !Directory.Exists(localAppData))
                return list;

            foreach (KeyValuePair<string, string> kvp in BranchNames)
            {
                string branch = kvp.Key;
                string dirName = kvp.Value;
                string path = Path.Combine(localAppData, dirName);

                DiscordInstall install = ParseDiscord(path, branch);
                if (install != null)
                {
                    list.Add(install);
                }
            }

            return list;
        }

        public static DiscordInstall ParseDiscord(string basePath, string branch = null)
        {
            if (string.IsNullOrEmpty(basePath) || !Directory.Exists(basePath))
                return null;

            if (string.IsNullOrEmpty(branch))
            {
                string folder = Path.GetFileName(basePath);
                if (string.Equals(folder, "DiscordPTB", StringComparison.OrdinalIgnoreCase))
                    branch = "ptb";
                else if (string.Equals(folder, "DiscordCanary", StringComparison.OrdinalIgnoreCase))
                    branch = "canary";
                else if (string.Equals(folder, "DiscordDevelopment", StringComparison.OrdinalIgnoreCase))
                    branch = "dev";
                else
                    branch = "stable";
            }

            string[] dirs;
            try
            {
                dirs = Directory.GetDirectories(basePath, "app-*");
            }
            catch
            {
                return null;
            }

            if (dirs == null || dirs.Length == 0)
                return null;

            string latestAppDir = null;
            Version latestVersion = null;

            foreach (string dir in dirs)
            {
                string dirName = Path.GetFileName(dir);
                string res = Path.Combine(dir, "resources");
                if (!Directory.Exists(res))
                    continue;

                string verStr = dirName.StartsWith("app-") ? dirName.Substring(4) : dirName;
                Version ver;
                if (Version.TryParse(verStr, out ver))
                {
                    if (latestVersion == null || ver > latestVersion)
                    {
                        latestVersion = ver;
                        latestAppDir = dir;
                    }
                }
                else
                {
                    if (latestAppDir == null || string.Compare(dir, latestAppDir, StringComparison.OrdinalIgnoreCase) > 0)
                    {
                        latestAppDir = dir;
                    }
                }
            }

            if (latestAppDir == null)
                return null;

            string resourcesPath = Path.Combine(latestAppDir, "resources");
            string appAsar = Path.Combine(resourcesPath, "app.asar");
            string backupAsar = Path.Combine(resourcesPath, "_app.asar");

            if (!File.Exists(appAsar) && !File.Exists(backupAsar))
                return null;

            bool isPatched = File.Exists(backupAsar);
            bool isOpenAsar = CheckIsOpenAsar(resourcesPath);

            string displayName = DisplayNames.ContainsKey(branch) ? DisplayNames[branch] : "Discord (" + branch + ")";

            return new DiscordInstall()
            {
                Name = displayName,
                Branch = branch,
                BasePath = basePath,
                AppPath = latestAppDir,
                ResourcesPath = resourcesPath,
                IsPatched = isPatched,
                IsOpenAsar = isOpenAsar
            };
        }

        private static bool CheckIsOpenAsar(string resourcesDir)
        {
            string[] checkFiles = new string[] { "_app.asar", "app.asar" };
            foreach (string file in checkFiles)
            {
                string p = Path.Combine(resourcesDir, file);
                if (File.Exists(p))
                {
                    try
                    {
                        using (FileStream fs = new FileStream(p, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
                        {
                            byte[] buffer = new byte[Math.Min(fs.Length, 1024 * 16)];
                            int read = fs.Read(buffer, 0, buffer.Length);
                            string text = Encoding.UTF8.GetString(buffer, 0, read);
                            if (text.IndexOf("OpenAsar", StringComparison.OrdinalIgnoreCase) >= 0)
                                return true;
                        }
                    }
                    catch
                    {
                    }
                }
            }
            return false;
        }

        public static bool IsDiscordRunning(DiscordInstall di)
        {
            string procName = BranchNames.ContainsKey(di.Branch) ? BranchNames[di.Branch] : "Discord";
            Process[] procs = Process.GetProcessesByName(procName);
            return procs != null && procs.Length > 0;
        }

        public static void LaunchDiscord(DiscordInstall di)
        {
            try
            {
                string procName = BranchNames.ContainsKey(di.Branch) ? BranchNames[di.Branch] : "Discord";
                string exeName = procName + ".exe";
                string exePath = Path.Combine(di.AppPath, exeName);
                if (File.Exists(exePath))
                {
                    Process.Start(new ProcessStartInfo(exePath) { UseShellExecute = true, WorkingDirectory = di.AppPath });
                    return;
                }

                string updateExe = Path.Combine(di.BasePath, "Update.exe");
                if (File.Exists(updateExe))
                {
                    Process.Start(new ProcessStartInfo(updateExe, "--processStart " + exeName) { UseShellExecute = true });
                }
            }
            catch {}
        }

        public static void KillDiscord(DiscordInstall di)
        {
            string procName = BranchNames.ContainsKey(di.Branch) ? BranchNames[di.Branch] : "Discord";
            Process[] procs = Process.GetProcessesByName(procName);
            foreach (Process p in procs)
            {
                try
                {
                    p.Kill();
                    p.WaitForExit(3000);
                }
                catch
                {
                }
            }
        }

        public static void ExtractEmbeddedPayload(Action<string> log = null)
        {
            DeployPayload(null, log);
        }

        public static void DeployPayload(UpdateSyncResult sync, Action<string> log = null)
        {
            if (log == null) log = delegate(string s) {};

            if (!Directory.Exists(VencordDistDir))
                Directory.CreateDirectory(VencordDistDir);

            if (!Directory.Exists(VencordUserPluginsDir))
                Directory.CreateDirectory(VencordUserPluginsDir);

            CleanupTempFiles(VencordDistDir);
            CleanupTempFiles(VencordUserPluginsDir);

            EmbeddedManifest embedded = UpdaterCore.LoadEmbeddedManifest();
            RemoteManifest remote = (sync != null) ? sync.Manifest : null;

            if (remote != null && remote.dist != null && remote.dist.Count > 0)
            {
                string cacheDistDir = UpdaterCore.GetCacheDistDir();
                string cachePluginsDir = UpdaterCore.GetCachePluginsDir();

                foreach (KeyValuePair<string, ManifestFileEntry> kvp in remote.dist)
                {
                    if (!UpdaterCore.IsSafeFileName(kvp.Key) || kvp.Value == null) continue;
                    DeployVerifiedFile(kvp.Key, kvp.Value, true, VencordDistDir, cacheDistDir, embedded != null ? embedded.dist : null, log);
                }

                if (remote.plugins != null)
                {
                    foreach (KeyValuePair<string, ManifestFileEntry> kvp in remote.plugins)
                    {
                        if (!UpdaterCore.IsSafeFileName(kvp.Key) || kvp.Value == null) continue;
                        DeployVerifiedFile(kvp.Key, kvp.Value, false, VencordUserPluginsDir, cachePluginsDir, embedded != null ? embedded.plugins : null, log);
                    }
                }

                DeleteRemovedPlugins(remote);
            }
            else if (embedded != null)
            {
                if (embedded.dist != null)
                {
                    foreach (KeyValuePair<string, EmbeddedEntry> kvp in embedded.dist)
                    {
                        if (!UpdaterCore.IsSafeFileName(kvp.Key) || kvp.Value == null) continue;
                        DeployBundledFile(kvp.Key, kvp.Value, VencordDistDir, log);
                    }
                }
                if (embedded.plugins != null)
                {
                    foreach (KeyValuePair<string, EmbeddedEntry> kvp in embedded.plugins)
                    {
                        if (!UpdaterCore.IsSafeFileName(kvp.Key) || kvp.Value == null) continue;
                        DeployBundledFile(kvp.Key, kvp.Value, VencordUserPluginsDir, log);
                    }
                }

                DeleteRemovedPlugins(null);
            }
            else
            {
                throw new InvalidDataException("No bundled or downloaded payload manifest was found.");
            }

            string pkgJsonPath = Path.Combine(VencordDistDir, "package.json");
            if (!File.Exists(pkgJsonPath) || !string.Equals(File.ReadAllText(pkgJsonPath, Encoding.UTF8), "{}", StringComparison.Ordinal))
            {
                File.WriteAllText(pkgJsonPath, "{}", Encoding.UTF8);
            }

            EnsureQuickCssSeparatorRule(log);
        }

        private static void DeployVerifiedFile(
            string fileName,
            ManifestFileEntry entry,
            bool isDist,
            string targetDir,
            string cacheDir,
            Dictionary<string, EmbeddedEntry> embeddedMap,
            Action<string> log)
        {
            string expectedHash = (entry.hash ?? "").ToLowerInvariant();
            string destPath = Path.Combine(targetDir, fileName);

            if (!string.IsNullOrEmpty(expectedHash) &&
                string.Equals(UpdaterCore.Sha256File(destPath), expectedHash, StringComparison.OrdinalIgnoreCase))
            {
                log("Verified up to date: " + fileName);
                return;
            }

            string cachePath = Path.Combine(cacheDir, fileName);
            if (!string.IsNullOrEmpty(expectedHash) &&
                string.Equals(UpdaterCore.Sha256File(cachePath), expectedHash, StringComparison.OrdinalIgnoreCase))
            {
                UpdaterCore.CopyAtomic(cachePath, destPath);
                log("Deployed updated " + (isDist ? "core" : "plugin") + ": " + fileName);
                return;
            }

            if (embeddedMap != null)
            {
                EmbeddedEntry emb;
                if (embeddedMap.TryGetValue(fileName, out emb) &&
                    emb != null &&
                    string.Equals(emb.hash, expectedHash, StringComparison.OrdinalIgnoreCase))
                {
                    if (UpdaterCore.ExtractEmbeddedResourceVerified(emb.resource, expectedHash, destPath, true))
                    {
                        log("Extracted " + (isDist ? "dist file" : "plugin") + ": " + fileName);
                        return;
                    }
                }
            }

            if (UpdaterCore.TryDownloadEntryToCache(fileName, entry, isDist, cachePath))
            {
                UpdaterCore.CopyAtomic(cachePath, destPath);
                log("Downloaded " + (isDist ? "core" : "plugin") + ": " + fileName);
                return;
            }

            throw new InvalidDataException("Failed to verify or download required file: " + fileName);
        }

        private static void DeployBundledFile(string fileName, EmbeddedEntry emb, string targetDir, Action<string> log)
        {
            string expectedHash = (emb.hash ?? "").ToLowerInvariant();
            string destPath = Path.Combine(targetDir, fileName);

            if (!string.IsNullOrEmpty(expectedHash) &&
                string.Equals(UpdaterCore.Sha256File(destPath), expectedHash, StringComparison.OrdinalIgnoreCase))
            {
                log("Verified bundled: " + fileName);
                return;
            }

            if (!UpdaterCore.ExtractEmbeddedResourceVerified(emb.resource, expectedHash, destPath, true))
            {
                throw new InvalidDataException("Bundled resource failed integrity check: " + fileName);
            }
            log("Extracted bundled: " + fileName);
        }

        private static void DeleteRemovedPlugins(RemoteManifest remote)
        {
            HashSet<string> toDelete = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
            {
                "AlwaysHideNonVideo.js",
                "Focus.js",
                "UserFocus.js",
                "FocusVoiceUser.js",
                "SuperDebloat.js",
                "FuckNitro.js",
                "CurShare.js",
                "curshare.js",
                "hideContextMenuItems.js",
                "HideContextMenuItems.js",
                "hideContextMenuItems.js.new",
                "DiscordDebloater.js",
                "discorddebloater.js",
                "amongick.js"
            };

            if (remote != null && remote.removedPlugins != null)
            {
                foreach (string p in remote.removedPlugins)
                {
                    if (!UpdaterCore.IsSafeFileName(p)) continue;
                    if (remote.plugins != null && remote.plugins.ContainsKey(p)) continue;
                    toDelete.Add(p);
                }
            }

            foreach (string unwanted in toDelete)
            {
                string unwantedPath = Path.Combine(VencordUserPluginsDir, unwanted);
                if (File.Exists(unwantedPath))
                {
                    try { File.Delete(unwantedPath); } catch { }
                }
            }
        }

        private static void CleanupTempFiles(string dir)
        {
            try
            {
                if (!Directory.Exists(dir)) return;
                foreach (string f in Directory.GetFiles(dir, "*.tmp"))
                {
                    try { File.Delete(f); } catch { }
                }
                foreach (string f in Directory.GetFiles(dir, "*.download"))
                {
                    try { File.Delete(f); } catch { }
                }
            }
            catch { }
        }

        private static void EnsureQuickCssSeparatorRule(Action<string> log)
        {
            try
            {
                string settingsDir = Path.Combine(AppDataVencordDir, "settings");
                if (!Directory.Exists(settingsDir))
                    Directory.CreateDirectory(settingsDir);

                string quickCssPath = Path.Combine(settingsDir, "quickCss.css");
                string separatorCss = "div[role=\"separator\"][class*=\"separator_\"] {\r\n    display: none !important;\r\n}\r\n";

                if (!File.Exists(quickCssPath))
                {
                    File.WriteAllText(quickCssPath, separatorCss, Encoding.UTF8);
                    log("Created quickCss.css with context menu separator hidden.");
                }
                else
                {
                    string existing = File.ReadAllText(quickCssPath, Encoding.UTF8);
                    if (!existing.Contains("div[role=\"separator\"][class*=\"separator_\"]"))
                    {
                        string updated = existing.TrimEnd() + "\r\n\r\n" + separatorCss;
                        File.WriteAllText(quickCssPath, updated, Encoding.UTF8);
                        log("Appended context menu separator rule to existing quickCss.css.");
                    }
                }
            }
            catch (Exception ex)
            {
                log("Notice: Could not update quickCss.css: " + ex.Message);
            }
        }

        public static void WriteAppAsar(string outFile, string patcherPath)
        {
            string patcherJsonPath = "\"" + patcherPath.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
            string indexJsContents = "require(" + patcherJsonPath + ")";
            byte[] indexJsBytes = Encoding.UTF8.GetBytes(indexJsContents);

            string packageJson = "{\n\t\"name\": \"discord\",\n\t\"main\": \"index.js\"\n}";
            byte[] packageJsonBytes = Encoding.UTF8.GetBytes(packageJson);

            string headerString = "{\"files\":{\"index.js\":{\"size\":" + indexJsBytes.Length + ",\"offset\":\"0\"},\"package.json\":{\"size\":" + packageJsonBytes.Length + ",\"offset\":\"" + indexJsBytes.Length + "\"}}}";
            byte[] headerBytes = Encoding.UTF8.GetBytes(headerString);

            uint headerStringSize = (uint)headerBytes.Length;
            uint dataSize = 4;
            uint alignedSize = (headerStringSize + dataSize - 1) & ~(dataSize - 1);
            uint headerSize = alignedSize + 8;
            uint headerObjectSize = alignedSize + dataSize;
            uint diff = alignedSize - headerStringSize;

            using (FileStream fs = new FileStream(outFile, FileMode.Create, FileAccess.Write))
            using (BinaryWriter bw = new BinaryWriter(fs))
            {
                bw.Write((uint)dataSize);
                bw.Write((uint)headerSize);
                bw.Write((uint)headerObjectSize);
                bw.Write((uint)headerStringSize);

                bw.Write(headerBytes);
                for (int i = 0; i < diff; i++)
                {
                    bw.Write((byte)'0');
                }

                bw.Write(indexJsBytes);
                bw.Write(packageJsonBytes);
            }
        }

        public static void Install(DiscordInstall di, Action<string> log = null)
        {
            Install(di, null, log);
        }

        public static void Install(DiscordInstall di, UpdateSyncResult sync, Action<string> log = null)
        {
            if (log == null) log = delegate(string s) {};

            log("Deploying Vencord runtime & custom plugins...");
            DeployPayload(sync, log);

            bool isSandboxTest = UpdaterCore.GetLoopbackManifestUrl() != null &&
                                 !string.IsNullOrEmpty(Environment.GetEnvironmentVariable("IMCORD_TEST_DIR"));

            bool wasRunning = !isSandboxTest && IsDiscordRunning(di);
            if (wasRunning)
            {
                log("Closing Discord process...");
                KillDiscord(di);
            }

            string appAsar = Path.Combine(di.ResourcesPath, "app.asar");
            string backupAsar = Path.Combine(di.ResourcesPath, "_app.asar");

            log("Patching Discord at: " + di.ResourcesPath);

            if (!File.Exists(backupAsar))
            {
                if (File.Exists(appAsar))
                {
                    File.Move(appAsar, backupAsar);
                }
                else
                {
                    throw new FileNotFoundException("Could not find stock app.asar to backup.");
                }
            }
            else
            {
                if (File.Exists(appAsar))
                {
                    File.Delete(appAsar);
                }
            }

            WriteAppAsar(appAsar, PatcherJsPath);
            di.IsPatched = true;
            log("Successfully installed Vencord!");

            if (wasRunning)
            {
                log("Relaunching Discord...");
                LaunchDiscord(di);
            }
        }

        public static void Uninstall(DiscordInstall di, Action<string> log = null)
        {
            if (log == null) log = delegate(string s) {};

            bool isSandboxTest = UpdaterCore.GetLoopbackManifestUrl() != null &&
                                 !string.IsNullOrEmpty(Environment.GetEnvironmentVariable("IMCORD_TEST_DIR"));
            if (!isSandboxTest)
            {
                log("Closing Discord process if running...");
                KillDiscord(di);
            }

            string appAsar = Path.Combine(di.ResourcesPath, "app.asar");
            string backupAsar = Path.Combine(di.ResourcesPath, "_app.asar");

            if (File.Exists(appAsar))
            {
                File.Delete(appAsar);
            }

            if (File.Exists(backupAsar))
            {
                File.Move(backupAsar, appAsar);
            }

            di.IsPatched = false;
            log("Successfully uninstalled Vencord!");
        }

        public static void InstallOpenAsar(DiscordInstall di, Action<string> log = null)
        {
            if (log == null) log = delegate(string s) {};

            log("Closing Discord...");
            KillDiscord(di);

            string appAsar = Path.Combine(di.ResourcesPath, "app.asar");
            string backupAsar = Path.Combine(di.ResourcesPath, "_app.asar");
            string targetAsar = File.Exists(backupAsar) ? backupAsar : appAsar;
            string openAsarBackup = Path.Combine(di.ResourcesPath, "app.asar.backup");

            if (!File.Exists(openAsarBackup))
            {
                File.Copy(targetAsar, openAsarBackup);
            }

            log("Downloading OpenAsar...");
            UpdaterCore.ConfigureNetworking();
            string url = "https://github.com/GooseMod/OpenAsar/releases/download/nightly/app.asar";
            using (System.Net.WebClient wc = new System.Net.WebClient())
            {
                wc.Headers.Add("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
                wc.DownloadFile(url, targetAsar);
            }

            di.IsOpenAsar = true;
            log("Successfully installed OpenAsar!");
        }

        public static void UninstallOpenAsar(DiscordInstall di, Action<string> log = null)
        {
            if (log == null) log = delegate(string s) {};

            log("Closing Discord...");
            KillDiscord(di);

            string appAsar = Path.Combine(di.ResourcesPath, "app.asar");
            string backupAsar = Path.Combine(di.ResourcesPath, "_app.asar");
            string targetAsar = File.Exists(backupAsar) ? backupAsar : appAsar;
            string openAsarBackup = Path.Combine(di.ResourcesPath, "app.asar.backup");

            if (File.Exists(openAsarBackup))
            {
                File.Delete(targetAsar);
                File.Move(openAsarBackup, targetAsar);
                di.IsOpenAsar = false;
                log("Successfully uninstalled OpenAsar!");
            }
            else
            {
                throw new FileNotFoundException("app.asar.backup not found. Cannot restore stock OpenAsar.");
            }
        }
    }
}

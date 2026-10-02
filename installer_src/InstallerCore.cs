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
            string status = IsPatched ? " [iMACord Installed]" : "";
            return string.Format("{0} - {1}{2}", Name, BasePath, status);
        }
    }

    public static class InstallerCore
    {
        public static readonly string AppDataVencordDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            "Vencord"
        );
        public static readonly string VencordDistDir = Path.Combine(AppDataVencordDir, "dist");
        public static readonly string VencordUserPluginsDir = Path.Combine(AppDataVencordDir, "userplugins");
        public static readonly string PatcherJsPath = Path.Combine(VencordDistDir, "patcher.js");

        public static readonly string[] EmbeddedDistFiles = new string[]
        {
            "patcher.js",
            "preload.js",
            "renderer.js",
            "renderer.css"
        };

        public static readonly string[] EmbeddedPluginFiles = new string[]
        {
            "iMAMenu.js",
            "MultiStreamPopout.js",
            "amongick.js",
            "DiscordDebloater.js"
        };

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
            if (log == null) log = delegate(string s) {};

            if (!Directory.Exists(VencordDistDir))
                Directory.CreateDirectory(VencordDistDir);

            if (!Directory.Exists(VencordUserPluginsDir))
                Directory.CreateDirectory(VencordUserPluginsDir);

            Assembly asm = Assembly.GetExecutingAssembly();

            foreach (string file in EmbeddedDistFiles)
            {
                string target = Path.Combine(VencordDistDir, file);
                if (ExtractResourceToFile(asm, file, target))
                {
                    log("Extracted dist file: " + file);
                }
                else
                {
                    log("Warning: Resource not found: " + file);
                }
            }

            string pkgJsonPath = Path.Combine(VencordDistDir, "package.json");
            File.WriteAllText(pkgJsonPath, "{}", Encoding.UTF8);

            string[] unwantedPlugins = new string[]
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
                "hideContextMenuItems.js.new"
            };
            foreach (string unwanted in unwantedPlugins)
            {
                string unwantedPath = Path.Combine(VencordUserPluginsDir, unwanted);
                if (File.Exists(unwantedPath))
                {
                    try { File.Delete(unwantedPath); } catch { }
                }
            }

            foreach (string plugin in EmbeddedPluginFiles)
            {
                string target = Path.Combine(VencordUserPluginsDir, plugin);
                if (ExtractResourceToFile(asm, plugin, target))
                {
                    log("Extracted plugin: " + plugin);
                }
                else
                {
                    log("Warning: Resource not found: " + plugin);
                }
            }

            EnsureQuickCssSeparatorRule(log);
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

        private static bool ExtractResourceToFile(Assembly asm, string resourceKey, string targetPath)
        {
            string matchedName = null;
            string[] names = asm.GetManifestResourceNames();

            foreach (string n in names)
            {
                if (n.Equals(resourceKey, StringComparison.OrdinalIgnoreCase) ||
                    n.EndsWith("." + resourceKey, StringComparison.OrdinalIgnoreCase) ||
                    n.EndsWith("_" + resourceKey, StringComparison.OrdinalIgnoreCase))
                {
                    matchedName = n;
                    break;
                }
            }

            if (matchedName == null)
                return false;

            using (Stream s = asm.GetManifestResourceStream(matchedName))
            {
                if (s == null) return false;
                using (FileStream fs = new FileStream(targetPath, FileMode.Create, FileAccess.Write, FileShare.None))
                {
                    byte[] buffer = new byte[81920];
                    int bytesRead;
                    while ((bytesRead = s.Read(buffer, 0, buffer.Length)) > 0)
                    {
                        fs.Write(buffer, 0, bytesRead);
                    }
                }
            }
            return true;
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
            if (log == null) log = delegate(string s) {};

            log("Extracting Vencord runtime & custom plugins...");
            ExtractEmbeddedPayload(log);

            bool wasRunning = IsDiscordRunning(di);
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

            log("Closing Discord process if running...");
            KillDiscord(di);

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

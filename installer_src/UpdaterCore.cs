using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Net.Cache;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

namespace VencordInstaller
{
    public class ManifestFileEntry
    {
        public string hash { get; set; }
        public long size { get; set; }
        public string url { get; set; }
    }

    public class InstallerBinaryEntry
    {
        public string codeHash { get; set; }
        public string hash { get; set; }
        public long size { get; set; }
        public string url { get; set; }
    }

    public class InstallerMetadata
    {
        public InstallerBinaryEntry gui { get; set; }
        public InstallerBinaryEntry cli { get; set; }
    }

    public class RemoteManifest
    {
        public string version { get; set; }
        public string updatedAt { get; set; }
        public InstallerMetadata installer { get; set; }
        public Dictionary<string, ManifestFileEntry> dist { get; set; }
        public Dictionary<string, ManifestFileEntry> plugins { get; set; }
        public List<string> removedPlugins { get; set; }
    }

    public class EmbeddedEntry
    {
        public string hash { get; set; }
        public long size { get; set; }
        public string resource { get; set; }
    }

    public class EmbeddedManifest
    {
        public string version { get; set; }
        public Dictionary<string, EmbeddedEntry> dist { get; set; }
        public Dictionary<string, EmbeddedEntry> plugins { get; set; }
    }

    public enum UpdateStage
    {
        Checking,
        SelfUpdating,
        SyncingPayload,
        UpToDate,
        Synced,
        Offline,
        SelfUpdatedRelaunching
    }

    public class UpdateProgress
    {
        public UpdateStage Stage { get; set; }
        public string Message { get; set; }
        public int Percent { get; set; }
        public string RemoteVersion { get; set; }
        public int FilesDone { get; set; }
        public int FilesTotal { get; set; }
        public long BytesDone { get; set; }
        public long BytesTotal { get; set; }
    }

    public class UpdateSyncResult
    {
        public bool Success { get; set; }
        public bool Offline { get; set; }
        public bool Relaunched { get; set; }
        public int RelaunchExitCode { get; set; }
        public string RelaunchedExePath { get; set; }
        public string RemoteVersion { get; set; }
        public RemoteManifest Manifest { get; set; }
        public string ErrorMessage { get; set; }
        public int DownloadedFiles { get; set; }
        public long DownloadedBytes { get; set; }
        public bool UsedBinaryFallback { get; set; }
        public string TriggerReason { get; set; }
    }

    public class StartupOptions
    {
        public bool NoSelfUpdate { get; set; }
        public bool NoUpdate { get; set; }
        public bool ForceUpdate { get; set; }
        public bool UpdateOnly { get; set; }
        public string UpdatedFrom { get; set; }
        public int CleanupOldPid { get; set; }
        public string PendingAction { get; set; }
        public string PendingPath { get; set; }
        public List<string> ForwardedArgs { get; set; }

        public StartupOptions()
        {
            ForwardedArgs = new List<string>();
        }
    }

    public class UpdateCancellation
    {
        private readonly object _lock = new object();
        private readonly List<HttpWebRequest> _activeRequests = new List<HttpWebRequest>();
        private volatile bool _cancelled;

        public bool IsCancelled
        {
            get { return _cancelled; }
        }

        public void Cancel()
        {
            _cancelled = true;
            HttpWebRequest[] snapshot;
            lock (_lock)
            {
                snapshot = _activeRequests.ToArray();
            }
            foreach (HttpWebRequest req in snapshot)
            {
                try { req.Abort(); } catch { }
            }
        }

        internal void Track(HttpWebRequest req)
        {
            if (req == null) return;
            lock (_lock)
            {
                if (_cancelled)
                {
                    try { req.Abort(); } catch { }
                    return;
                }
                _activeRequests.Add(req);
            }
        }

        internal void Untrack(HttpWebRequest req)
        {
            if (req == null) return;
            lock (_lock)
            {
                _activeRequests.Remove(req);
            }
        }
    }

    public static class UpdaterCore
    {
        private const string ReleaseBase = "https://github.com/" + BuildInfo.Repo + "/releases/latest/download";
        private const string RawBase = "https://raw.githubusercontent.com/" + BuildInfo.Repo + "/main";
        private const int ManifestTimeoutMs = 5000;
        private const int DownloadTimeoutMs = 20000;
        private const int MaxConcurrentDownloads = 6;
        private const double BulkSwapRatio = 0.80;
        private const int BulkSwapFileCount = 8;

        private class DeltaItem
        {
            public string FileName;
            public bool IsDist;
            public string ExpectedHash;
            public long Size;
            public string PrimaryUrl;
            public string FallbackUrl;
            public string CachePath;
        }

        public static void ConfigureNetworking()
        {
            try
            {
                ServicePointManager.Expect100Continue = false;
                ServicePointManager.UseNagleAlgorithm = false;
                ServicePointManager.DefaultConnectionLimit = 12;
            }
            catch { }

            try { ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072; } catch { }
            try { ServicePointManager.SecurityProtocol |= (SecurityProtocolType)12288; } catch { }
        }

        public static string GetLoopbackManifestUrl()
        {
            string url = Environment.GetEnvironmentVariable("IMCORD_MANIFEST_URL");
            if (string.IsNullOrEmpty(url)) return null;
            url = url.Trim();
            if (url.StartsWith("http://127.0.0.1:", StringComparison.OrdinalIgnoreCase) ||
                url.StartsWith("http://localhost:", StringComparison.OrdinalIgnoreCase))
            {
                return url;
            }
            return null;
        }

        public static string GetAppDataVencordDir()
        {
            if (GetLoopbackManifestUrl() != null)
            {
                string testDir = Environment.GetEnvironmentVariable("IMCORD_TEST_DIR");
                if (!string.IsNullOrEmpty(testDir))
                    return Path.Combine(testDir, "AppData_Vencord");
            }
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Vencord");
        }

        public static string GetLocalUpdaterDir()
        {
            if (GetLoopbackManifestUrl() != null)
            {
                string testDir = Environment.GetEnvironmentVariable("IMCORD_TEST_DIR");
                if (!string.IsNullOrEmpty(testDir))
                    return Path.Combine(testDir, "Local_iMCord");
            }
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "iMCord");
        }

        public static string GetCacheDistDir()
        {
            return Path.Combine(GetLocalUpdaterDir(), "cache", "dist");
        }

        public static string GetCachePluginsDir()
        {
            return Path.Combine(GetLocalUpdaterDir(), "cache", "plugins");
        }

        public static StartupOptions ParseStartupOptions(string[] args)
        {
            StartupOptions opts = new StartupOptions();
            if (args == null) return opts;

            for (int i = 0; i < args.Length; i++)
            {
                string raw = args[i];
                if (string.IsNullOrEmpty(raw)) continue;
                string norm = raw.TrimStart('-').ToLowerInvariant();

                if (norm == "no-self-update")
                {
                    opts.NoSelfUpdate = true;
                }
                else if (norm == "no-update" || norm == "offline")
                {
                    opts.NoUpdate = true;
                    opts.ForwardedArgs.Add(raw);
                }
                else if (norm == "force-update")
                {
                    opts.ForceUpdate = true;
                    opts.ForwardedArgs.Add(raw);
                }
                else if (norm == "update")
                {
                    opts.UpdateOnly = true;
                    opts.ForwardedArgs.Add(raw);
                }
                else if (norm == "updated-from" && i + 1 < args.Length)
                {
                    opts.UpdatedFrom = args[++i];
                }
                else if (norm == "cleanup-old" && i + 1 < args.Length)
                {
                    int pid;
                    if (int.TryParse(args[++i], out pid))
                        opts.CleanupOldPid = pid;
                }
                else if (norm == "pending-action" && i + 1 < args.Length)
                {
                    opts.PendingAction = args[++i];
                }
                else if (norm == "pending-path" && i + 1 < args.Length)
                {
                    opts.PendingPath = args[++i];
                }
                else
                {
                    opts.ForwardedArgs.Add(raw);
                }
            }

            return opts;
        }

        public static void RunStartupCleanup(StartupOptions opts)
        {
            string exePath = GetCurrentExePath();
            if (string.IsNullOrEmpty(exePath)) return;

            int waitPid = (opts != null) ? opts.CleanupOldPid : 0;

            ThreadPool.QueueUserWorkItem(delegate
            {
                if (waitPid > 0 && waitPid != Process.GetCurrentProcess().Id)
                {
                    try
                    {
                        Process oldProc = Process.GetProcessById(waitPid);
                        if (oldProc != null && !oldProc.HasExited)
                            oldProc.WaitForExit(3000);
                    }
                    catch { }
                }

                string oldFile = exePath + ".old";
                string newFile = exePath + ".new";
                for (int attempt = 0; attempt < 5; attempt++)
                {
                    bool pending = false;
                    if (File.Exists(oldFile))
                    {
                        try { File.Delete(oldFile); }
                        catch { pending = true; }
                    }
                    if (File.Exists(newFile))
                    {
                        try { File.Delete(newFile); }
                        catch { pending = true; }
                    }
                    if (!pending) break;
                    Thread.Sleep(200);
                }
            });
        }

        public static string GetCurrentExePath()
        {
            try
            {
                ProcessModule mod = Process.GetCurrentProcess().MainModule;
                if (mod != null && !string.IsNullOrEmpty(mod.FileName))
                    return mod.FileName;
            }
            catch { }

            try
            {
                return Assembly.GetExecutingAssembly().Location;
            }
            catch { }

            return null;
        }

        public static bool IsSafeFileName(string name)
        {
            if (string.IsNullOrEmpty(name)) return false;
            if (name.IndexOf('/') >= 0 || name.IndexOf('\\') >= 0 || name.IndexOf("..", StringComparison.Ordinal) >= 0)
                return false;
            if (!string.Equals(Path.GetFileName(name), name, StringComparison.Ordinal))
                return false;
            return name.EndsWith(".js", StringComparison.OrdinalIgnoreCase) ||
                   name.EndsWith(".css", StringComparison.OrdinalIgnoreCase);
        }

        public static string Sha256Bytes(byte[] data)
        {
            using (SHA256 sha = SHA256.Create())
            {
                byte[] hash = sha.ComputeHash(data);
                return BytesToHex(hash);
            }
        }

        public static string Sha256File(string filePath)
        {
            if (string.IsNullOrEmpty(filePath) || !File.Exists(filePath)) return null;
            try
            {
                using (SHA256 sha = SHA256.Create())
                using (FileStream fs = new FileStream(filePath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
                {
                    byte[] hash = sha.ComputeHash(fs);
                    return BytesToHex(hash);
                }
            }
            catch
            {
                return null;
            }
        }

        private static string Sha256String(string text)
        {
            return Sha256Bytes(Encoding.UTF8.GetBytes(text ?? ""));
        }

        private static string BytesToHex(byte[] hash)
        {
            StringBuilder sb = new StringBuilder(hash.Length * 2);
            for (int i = 0; i < hash.Length; i++)
                sb.Append(hash[i].ToString("x2"));
            return sb.ToString();
        }

        public static EmbeddedManifest LoadEmbeddedManifest()
        {
            Assembly asm = Assembly.GetExecutingAssembly();
            using (Stream s = OpenResourceStream(asm, "embedded_manifest.json"))
            {
                if (s == null) return null;
                using (StreamReader sr = new StreamReader(s, Encoding.UTF8))
                {
                    string json = sr.ReadToEnd();
                    JavaScriptSerializer ser = CreateSerializer();
                    return ser.Deserialize<EmbeddedManifest>(json);
                }
            }
        }

        public static Stream OpenResourceStream(Assembly asm, string resourceKey)
        {
            if (asm == null || string.IsNullOrEmpty(resourceKey)) return null;
            string[] names = asm.GetManifestResourceNames();
            foreach (string n in names)
            {
                if (n.Equals(resourceKey, StringComparison.OrdinalIgnoreCase) ||
                    n.EndsWith("." + resourceKey, StringComparison.OrdinalIgnoreCase) ||
                    n.EndsWith("_" + resourceKey, StringComparison.OrdinalIgnoreCase))
                {
                    return asm.GetManifestResourceStream(n);
                }
            }
            return null;
        }

        public static bool ExtractEmbeddedResourceVerified(string resourceKey, string expectedHash, string destPath, bool isGzip)
        {
            Assembly asm = Assembly.GetExecutingAssembly();
            string tmpPath = destPath + ".tmp";
            string dir = Path.GetDirectoryName(destPath);
            if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir))
                Directory.CreateDirectory(dir);

            try
            {
                using (Stream rawStream = OpenResourceStream(asm, resourceKey))
                {
                    if (rawStream == null) return false;
                    Stream src = isGzip ? (Stream)new GZipStream(rawStream, CompressionMode.Decompress) : rawStream;
                    try
                    {
                        using (SHA256 sha = SHA256.Create())
                        using (FileStream fs = new FileStream(tmpPath, FileMode.Create, FileAccess.Write, FileShare.None))
                        {
                            byte[] buffer = new byte[81920];
                            int read;
                            while ((read = src.Read(buffer, 0, buffer.Length)) > 0)
                            {
                                sha.TransformBlock(buffer, 0, read, null, 0);
                                fs.Write(buffer, 0, read);
                            }
                            sha.TransformFinalBlock(new byte[0], 0, 0);
                            string actualHash = BytesToHex(sha.Hash);
                            if (!string.IsNullOrEmpty(expectedHash) &&
                                !string.Equals(actualHash, expectedHash, StringComparison.OrdinalIgnoreCase))
                            {
                                try { fs.Close(); File.Delete(tmpPath); } catch { }
                                return false;
                            }
                        }
                    }
                    finally
                    {
                        if (isGzip) src.Dispose();
                    }
                }

                MoveOverwrite(tmpPath, destPath);
                return true;
            }
            catch
            {
                try { if (File.Exists(tmpPath)) File.Delete(tmpPath); } catch { }
                return false;
            }
        }

        public static bool VerifyEmbeddedResourcesQuick(EmbeddedManifest emb)
        {
            if (emb == null) return false;
            Assembly asm = Assembly.GetExecutingAssembly();
            if (emb.dist != null)
            {
                foreach (KeyValuePair<string, EmbeddedEntry> kvp in emb.dist)
                {
                    if (kvp.Value == null || string.IsNullOrEmpty(kvp.Value.resource)) return false;
                    using (Stream s = OpenResourceStream(asm, kvp.Value.resource))
                    {
                        if (s == null) return false;
                    }
                }
            }
            if (emb.plugins != null)
            {
                foreach (KeyValuePair<string, EmbeddedEntry> kvp in emb.plugins)
                {
                    if (kvp.Value == null || string.IsNullOrEmpty(kvp.Value.resource)) return false;
                    using (Stream s = OpenResourceStream(asm, kvp.Value.resource))
                    {
                        if (s == null) return false;
                    }
                }
            }
            return true;
        }

        private static bool VerifyEmbeddedEntryIntegrity(string resourceKey, string expectedHash)
        {
            Assembly asm = Assembly.GetExecutingAssembly();
            try
            {
                using (Stream rawStream = OpenResourceStream(asm, resourceKey))
                {
                    if (rawStream == null) return false;
                    using (GZipStream gz = new GZipStream(rawStream, CompressionMode.Decompress))
                    using (SHA256 sha = SHA256.Create())
                    {
                        byte[] buffer = new byte[81920];
                        int read;
                        while ((read = gz.Read(buffer, 0, buffer.Length)) > 0)
                        {
                            sha.TransformBlock(buffer, 0, read, null, 0);
                        }
                        sha.TransformFinalBlock(new byte[0], 0, 0);
                        string actual = BytesToHex(sha.Hash);
                        return string.Equals(actual, expectedHash, StringComparison.OrdinalIgnoreCase);
                    }
                }
            }
            catch
            {
                return false;
            }
        }

        public static UpdateSyncResult RunSyncBlocking(
            bool isGui,
            StartupOptions options,
            Action<UpdateProgress> onProgress,
            UpdateCancellation cancel,
            Func<List<string>> getExtraLaunchArgs = null)
        {
            if (options == null) options = new StartupOptions();
            if (cancel == null) cancel = new UpdateCancellation();

            UpdateSyncResult result = new UpdateSyncResult();
            bool isLoopbackTest = GetLoopbackManifestUrl() != null;

            if (options.NoUpdate)
            {
                result.Success = true;
                result.Offline = true;
                result.TriggerReason = "no-update";
                ReportProgress(onProgress, UpdateStage.Offline, "Offline mode (update skipped)", 100, BuildInfo.Version, 0, 0, 0, 0);
                return result;
            }

            if (!BuildInfo.IsReleaseBuild && !options.ForceUpdate && !isLoopbackTest)
            {
                result.Success = true;
                result.RemoteVersion = BuildInfo.Version;
                result.TriggerReason = "dev-skip";
                ReportProgress(onProgress, UpdateStage.UpToDate, "Local dev build", 100, BuildInfo.Version, 0, 0, 0, 0);
                return result;
            }

            ReportProgress(onProgress, UpdateStage.Checking, "Checking for latest iMCord update...", 0, BuildInfo.Version, 0, 0, 0, 0);

            RemoteManifest manifest = null;
            try
            {
                manifest = FetchRemoteManifest(cancel);
            }
            catch (Exception ex)
            {
                result.Success = false;
                result.Offline = true;
                result.ErrorMessage = ex.Message;
                result.TriggerReason = "offline";
                ReportProgress(onProgress, UpdateStage.Offline, "Offline (using bundled files)", 100, BuildInfo.Version, 0, 0, 0, 0);
                return result;
            }

            if (cancel.IsCancelled)
            {
                result.Success = false;
                result.Offline = true;
                result.TriggerReason = "cancelled";
                return result;
            }

            if (manifest == null)
            {
                result.Success = false;
                result.Offline = true;
                result.ErrorMessage = "Empty manifest response.";
                result.TriggerReason = "offline";
                ReportProgress(onProgress, UpdateStage.Offline, "Offline (invalid manifest)", 100, BuildInfo.Version, 0, 0, 0, 0);
                return result;
            }

            result.Manifest = manifest;
            result.RemoteVersion = string.IsNullOrEmpty(manifest.version) ? BuildInfo.Version : manifest.version;

            // Downgrade guard
            if (IsRemoteOlder(result.RemoteVersion, BuildInfo.Version))
            {
                result.Success = true;
                result.TriggerReason = "local-newer";
                ReportProgress(onProgress, UpdateStage.UpToDate, "Current version is newer than remote", 100, BuildInfo.Version, 0, 0, 0, 0);
                return result;
            }

            EmbeddedManifest embedded = LoadEmbeddedManifest();
            bool embeddedOk = VerifyEmbeddedResourcesQuick(embedded);

            InstallerBinaryEntry remoteBin = null;
            if (manifest.installer != null)
                remoteBin = isGui ? manifest.installer.gui : manifest.installer.cli;

            string localCodeHash = isGui ? BuildInfo.GuiCodeHash : BuildInfo.CliCodeHash;
            string currentExePath = GetCurrentExePath();
            string localExeHash = Sha256File(currentExePath);

            bool sameVersion = VersionsEqual(result.RemoteVersion, BuildInfo.Version);
            bool codeChanged = remoteBin != null &&
                               !string.IsNullOrEmpty(remoteBin.codeHash) &&
                               !string.Equals(remoteBin.codeHash, localCodeHash, StringComparison.OrdinalIgnoreCase);

            List<DeltaItem> deltas = BuildDeltaList(manifest, embedded, isLoopbackTest);
            long deltaBytes = 0;
            for (int i = 0; i < deltas.Count; i++)
                deltaBytes += Math.Max(0, deltas[i].Size);

            bool canHealCorruption = !options.NoSelfUpdate &&
                                     remoteBin != null &&
                                     !string.IsNullOrEmpty(remoteBin.hash) &&
                                     !string.IsNullOrEmpty(currentExePath) &&
                                     !string.Equals(remoteBin.hash, localExeHash, StringComparison.OrdinalIgnoreCase);

            bool canSwapExe = canHealCorruption && (!sameVersion || options.ForceUpdate);

            bool bulkChanged = remoteBin != null &&
                               remoteBin.size > 0 &&
                               (deltaBytes >= (long)(remoteBin.size * BulkSwapRatio) || deltas.Count >= BulkSwapFileCount);

            if (!embeddedOk && canHealCorruption)
            {
                return PerformBinarySelfUpdate(remoteBin, result.RemoteVersion, options, isGui, onProgress, cancel, getExtraLaunchArgs, "corruption");
            }

            if (codeChanged && canSwapExe)
            {
                return PerformBinarySelfUpdate(remoteBin, result.RemoteVersion, options, isGui, onProgress, cancel, getExtraLaunchArgs, "codeHash");
            }

            if (bulkChanged && canSwapExe)
            {
                return PerformBinarySelfUpdate(remoteBin, result.RemoteVersion, options, isGui, onProgress, cancel, getExtraLaunchArgs, "bulk");
            }

            if (!VerifyNeededEmbeddedEntries(manifest, embedded) && canHealCorruption)
            {
                return PerformBinarySelfUpdate(remoteBin, result.RemoteVersion, options, isGui, onProgress, cancel, getExtraLaunchArgs, "corruption");
            }

            if (deltas.Count == 0)
            {
                PruneStaleCache(manifest);
                result.Success = true;
                result.TriggerReason = "up-to-date";
                ReportProgress(onProgress, UpdateStage.UpToDate, "Latest (" + result.RemoteVersion + ")", 100, result.RemoteVersion, 0, 0, 0, 0);
                return result;
            }

            // Tier 2: parallel delta payload sync
            List<DeltaItem> failed;
            long downloadedBytes = DownloadDeltasParallel(deltas, result.RemoteVersion, onProgress, cancel, out failed);

            if (cancel.IsCancelled)
            {
                result.Success = false;
                result.Offline = true;
                result.TriggerReason = "cancelled";
                return result;
            }

            if (failed.Count == 0)
            {
                PruneStaleCache(manifest);
                result.Success = true;
                result.DownloadedFiles = deltas.Count;
                result.DownloadedBytes = downloadedBytes;
                result.TriggerReason = "delta";
                ReportProgress(onProgress, UpdateStage.Synced, "Updated " + deltas.Count + " file(s) (" + result.RemoteVersion + ")", 100, result.RemoteVersion, deltas.Count, deltas.Count, downloadedBytes, Math.Max(deltaBytes, downloadedBytes));
                return result;
            }

            // Tier 2 failed (e.g. SHA-256 mismatch / asset corruption): escalate to Tier 1 full binary swap
            if (canHealCorruption)
            {
                UpdateSyncResult fallbackRes = PerformBinarySelfUpdate(remoteBin, result.RemoteVersion, options, isGui, onProgress, cancel, getExtraLaunchArgs, "corruption");
                fallbackRes.UsedBinaryFallback = true;
                return fallbackRes;
            }

            result.Success = false;
            result.Offline = true;
            result.ErrorMessage = "Failed to sync " + failed.Count + " update file(s).";
            result.TriggerReason = "delta-failed";
            ReportProgress(onProgress, UpdateStage.Offline, "Sync incomplete (using available files)", 100, BuildInfo.Version, 0, 0, 0, 0);
            return result;
        }

        private static bool VerifyNeededEmbeddedEntries(RemoteManifest manifest, EmbeddedManifest embedded)
        {
            if (manifest == null || embedded == null) return false;

            string vencordDir = GetAppDataVencordDir();
            string distDir = Path.Combine(vencordDir, "dist");
            string pluginsDir = Path.Combine(vencordDir, "userplugins");

            if (manifest.dist != null)
            {
                foreach (KeyValuePair<string, ManifestFileEntry> kvp in manifest.dist)
                {
                    if (!IsSafeFileName(kvp.Key) || kvp.Value == null || string.IsNullOrEmpty(kvp.Value.hash)) continue;
                    string hash = kvp.Value.hash.ToLowerInvariant();
                    string cacheFile = Path.Combine(GetCacheDistDir(), kvp.Key);
                    string installedFile = Path.Combine(distDir, kvp.Key);

                    if (string.Equals(Sha256File(cacheFile), hash, StringComparison.OrdinalIgnoreCase)) continue;
                    if (string.Equals(Sha256File(installedFile), hash, StringComparison.OrdinalIgnoreCase)) continue;

                    EmbeddedEntry emb;
                    if (embedded.dist != null && embedded.dist.TryGetValue(kvp.Key, out emb) && emb != null &&
                        string.Equals(emb.hash, hash, StringComparison.OrdinalIgnoreCase))
                    {
                        if (!VerifyEmbeddedEntryIntegrity(emb.resource, hash))
                            return false;
                    }
                }
            }

            if (manifest.plugins != null)
            {
                foreach (KeyValuePair<string, ManifestFileEntry> kvp in manifest.plugins)
                {
                    if (!IsSafeFileName(kvp.Key) || kvp.Value == null || string.IsNullOrEmpty(kvp.Value.hash)) continue;
                    string hash = kvp.Value.hash.ToLowerInvariant();
                    string cacheFile = Path.Combine(GetCachePluginsDir(), kvp.Key);
                    string installedFile = Path.Combine(pluginsDir, kvp.Key);

                    if (string.Equals(Sha256File(cacheFile), hash, StringComparison.OrdinalIgnoreCase)) continue;
                    if (string.Equals(Sha256File(installedFile), hash, StringComparison.OrdinalIgnoreCase)) continue;

                    EmbeddedEntry emb;
                    if (embedded.plugins != null && embedded.plugins.TryGetValue(kvp.Key, out emb) && emb != null &&
                        string.Equals(emb.hash, hash, StringComparison.OrdinalIgnoreCase))
                    {
                        if (!VerifyEmbeddedEntryIntegrity(emb.resource, hash))
                            return false;
                    }
                }
            }

            return true;
        }

        private static List<DeltaItem> BuildDeltaList(RemoteManifest manifest, EmbeddedManifest embedded, bool isLoopbackTest)
        {
            List<DeltaItem> list = new List<DeltaItem>();
            string vencordDir = GetAppDataVencordDir();
            string installedDistDir = Path.Combine(vencordDir, "dist");
            string installedPluginsDir = Path.Combine(vencordDir, "userplugins");
            string cacheDistDir = GetCacheDistDir();
            string cachePluginsDir = GetCachePluginsDir();

            if (manifest.dist != null)
            {
                foreach (KeyValuePair<string, ManifestFileEntry> kvp in manifest.dist)
                {
                    string file = kvp.Key;
                    ManifestFileEntry info = kvp.Value;
                    if (!IsSafeFileName(file) || info == null || string.IsNullOrEmpty(info.hash)) continue;

                    string hash = info.hash.ToLowerInvariant();
                    string cacheFile = Path.Combine(cacheDistDir, file);
                    string installedFile = Path.Combine(installedDistDir, file);

                    if (string.Equals(Sha256File(cacheFile), hash, StringComparison.OrdinalIgnoreCase)) continue;
                    if (HasEmbeddedHash(embedded != null ? embedded.dist : null, file, hash)) continue;
                    if (string.Equals(Sha256File(installedFile), hash, StringComparison.OrdinalIgnoreCase)) continue;

                    string releaseUrl = !string.IsNullOrEmpty(info.url)
                        ? info.url
                        : ReleaseBase + "/" + Uri.EscapeDataString(file);
                    string fallbackUrl = isLoopbackTest ? null : ReleaseBase + "/" + Uri.EscapeDataString(file);

                    list.Add(new DeltaItem
                    {
                        FileName = file,
                        IsDist = true,
                        ExpectedHash = hash,
                        Size = info.size,
                        PrimaryUrl = releaseUrl,
                        FallbackUrl = string.Equals(releaseUrl, fallbackUrl, StringComparison.OrdinalIgnoreCase) ? null : fallbackUrl,
                        CachePath = cacheFile
                    });
                }
            }

            if (manifest.plugins != null)
            {
                foreach (KeyValuePair<string, ManifestFileEntry> kvp in manifest.plugins)
                {
                    string file = kvp.Key;
                    ManifestFileEntry info = kvp.Value;
                    if (!IsSafeFileName(file) || info == null || string.IsNullOrEmpty(info.hash)) continue;

                    string hash = info.hash.ToLowerInvariant();
                    string cacheFile = Path.Combine(cachePluginsDir, file);
                    string installedFile = Path.Combine(installedPluginsDir, file);

                    if (string.Equals(Sha256File(cacheFile), hash, StringComparison.OrdinalIgnoreCase)) continue;
                    if (HasEmbeddedHash(embedded != null ? embedded.plugins : null, file, hash)) continue;
                    if (string.Equals(Sha256File(installedFile), hash, StringComparison.OrdinalIgnoreCase)) continue;

                    string releaseUrl = !string.IsNullOrEmpty(info.url)
                        ? info.url
                        : ReleaseBase + "/" + Uri.EscapeDataString(file);
                    string rawUrl = RawBase + "/userplugins/" + Uri.EscapeDataString(file);

                    list.Add(new DeltaItem
                    {
                        FileName = file,
                        IsDist = false,
                        ExpectedHash = hash,
                        Size = info.size,
                        PrimaryUrl = isLoopbackTest ? releaseUrl : rawUrl,
                        FallbackUrl = isLoopbackTest ? null : releaseUrl,
                        CachePath = cacheFile
                    });
                }
            }

            return list;
        }

        private static bool HasEmbeddedHash(Dictionary<string, EmbeddedEntry> map, string file, string expectedHash)
        {
            if (map == null) return false;
            EmbeddedEntry entry;
            if (!map.TryGetValue(file, out entry) || entry == null || string.IsNullOrEmpty(entry.hash))
                return false;
            if (!string.Equals(entry.hash, expectedHash, StringComparison.OrdinalIgnoreCase))
                return false;
            using (Stream s = OpenResourceStream(Assembly.GetExecutingAssembly(), entry.resource))
            {
                return s != null;
            }
        }

        private static long DownloadDeltasParallel(
            List<DeltaItem> deltas,
            string remoteVersion,
            Action<UpdateProgress> onProgress,
            UpdateCancellation cancel,
            out List<DeltaItem> failed)
        {
            Directory.CreateDirectory(GetCacheDistDir());
            Directory.CreateDirectory(GetCachePluginsDir());

            int totalFiles = deltas.Count;
            long totalExpectedBytes = 0;
            for (int i = 0; i < totalFiles; i++)
                totalExpectedBytes += Math.Max(1024, deltas[i].Size);

            long[] itemBytes = new long[totalFiles];
            int completedCount = 0;
            int nextIndex = -1;
            long lastReportTicks = 0;
            object progressLock = new object();
            List<DeltaItem> failedList = new List<DeltaItem>();

            int workerCount = Math.Min(MaxConcurrentDownloads, totalFiles);
            ManualResetEvent allDone = new ManualResetEvent(false);
            int activeWorkers = workerCount;

            Action reportNow = delegate
            {
                lock (progressLock)
                {
                    long nowTicks = DateTime.UtcNow.Ticks;
                    if (completedCount < totalFiles && (nowTicks - lastReportTicks) < TimeSpan.FromMilliseconds(50).Ticks)
                        return;
                    lastReportTicks = nowTicks;

                    long bytesDone = 0;
                    for (int k = 0; k < totalFiles; k++)
                        bytesDone += itemBytes[k];

                    int pct = totalExpectedBytes > 0 ? (int)Math.Min(99, (bytesDone * 100L) / totalExpectedBytes) : 0;
                    if (completedCount == totalFiles) pct = 100;

                    ReportProgress(
                        onProgress,
                        UpdateStage.SyncingPayload,
                        string.Format("Syncing {0} ({1}/{2})...", remoteVersion, completedCount, totalFiles),
                        pct,
                        remoteVersion,
                        completedCount,
                        totalFiles,
                        bytesDone,
                        totalExpectedBytes
                    );
                }
            };

            reportNow();

            for (int w = 0; w < workerCount; w++)
            {
                ThreadPool.QueueUserWorkItem(delegate
                {
                    try
                    {
                        while (!cancel.IsCancelled)
                        {
                            int idx = Interlocked.Increment(ref nextIndex);
                            if (idx >= totalFiles) break;

                            DeltaItem item = deltas[idx];
                            bool ok = DownloadSingleDelta(item, cancel, delegate(long done)
                            {
                                Interlocked.Exchange(ref itemBytes[idx], done);
                                reportNow();
                            });

                            if (!ok)
                            {
                                lock (failedList)
                                {
                                    failedList.Add(item);
                                }
                            }
                            Interlocked.Increment(ref completedCount);
                            reportNow();
                        }
                    }
                    finally
                    {
                        if (Interlocked.Decrement(ref activeWorkers) == 0)
                            allDone.Set();
                    }
                });
            }

            allDone.WaitOne();
            allDone.Dispose();

            long sumBytes = 0;
            for (int k = 0; k < totalFiles; k++)
                sumBytes += itemBytes[k];

            failed = failedList;
            return sumBytes;
        }

        public static bool TryDownloadEntryToCache(string fileName, ManifestFileEntry info, bool isDist, string cachePath)
        {
            if (info == null || string.IsNullOrEmpty(info.hash) || !IsSafeFileName(fileName))
                return false;

            bool isLoopbackTest = GetLoopbackManifestUrl() != null;
            string releaseUrl = !string.IsNullOrEmpty(info.url)
                ? info.url
                : ReleaseBase + "/" + Uri.EscapeDataString(fileName);
            string rawUrl = RawBase + "/userplugins/" + Uri.EscapeDataString(fileName);

            DeltaItem item = new DeltaItem
            {
                FileName = fileName,
                IsDist = isDist,
                ExpectedHash = info.hash.ToLowerInvariant(),
                Size = info.size,
                PrimaryUrl = (isDist || isLoopbackTest) ? releaseUrl : rawUrl,
                FallbackUrl = isLoopbackTest ? null : (isDist ? (string.Equals(releaseUrl, ReleaseBase + "/" + Uri.EscapeDataString(fileName), StringComparison.OrdinalIgnoreCase) ? null : ReleaseBase + "/" + Uri.EscapeDataString(fileName)) : releaseUrl),
                CachePath = cachePath
            };

            return DownloadSingleDelta(item, new UpdateCancellation(), null);
        }

        private static bool DownloadSingleDelta(DeltaItem item, UpdateCancellation cancel, Action<long> onBytes)
        {
            string tmpPath = item.CachePath + ".download";
            string[] urls = string.IsNullOrEmpty(item.FallbackUrl)
                ? new string[] { item.PrimaryUrl }
                : new string[] { item.PrimaryUrl, item.FallbackUrl };

            for (int i = 0; i < urls.Length; i++)
            {
                if (cancel.IsCancelled) return false;
                try
                {
                    string actualHash = DownloadFileWithHash(urls[i], tmpPath, DownloadTimeoutMs, cancel, delegate(long done, long total)
                    {
                        if (onBytes != null) onBytes(done);
                    });

                    if (string.Equals(actualHash, item.ExpectedHash, StringComparison.OrdinalIgnoreCase))
                    {
                        MoveOverwrite(tmpPath, item.CachePath);
                        return true;
                    }
                    try { if (File.Exists(tmpPath)) File.Delete(tmpPath); } catch { }
                }
                catch
                {
                    try { if (File.Exists(tmpPath)) File.Delete(tmpPath); } catch { }
                }
            }

            return false;
        }

        private static UpdateSyncResult PerformBinarySelfUpdate(
            InstallerBinaryEntry remoteBin,
            string remoteVersion,
            StartupOptions options,
            bool isGui,
            Action<UpdateProgress> onProgress,
            UpdateCancellation cancel,
            Func<List<string>> getExtraLaunchArgs,
            string reason)
        {
            UpdateSyncResult res = new UpdateSyncResult();
            res.RemoteVersion = remoteVersion;
            res.TriggerReason = reason;

            string currentExePath = GetCurrentExePath();
            if (string.IsNullOrEmpty(currentExePath))
            {
                res.Success = false;
                res.ErrorMessage = "Cannot resolve executable path for self-update.";
                return res;
            }

            string exeName = Path.GetFileName(currentExePath);
            string exeDir = Path.GetDirectoryName(currentExePath);
            string mutexName = "Local\\iMCordUpdate_" + Sha256String(currentExePath).Substring(0, 12);

            bool createdNew;
            using (Mutex mutex = new Mutex(false, mutexName, out createdNew))
            {
                bool acquired = false;
                try
                {
                    try { acquired = mutex.WaitOne(0, false); }
                    catch (AbandonedMutexException) { acquired = true; }

                    if (!acquired)
                    {
                        res.Success = false;
                        res.ErrorMessage = "Another update is already in progress.";
                        return res;
                    }

                    bool dirWritable = CanWriteToDirectory(exeDir);
                    string targetDir = dirWritable ? exeDir : GetLocalUpdaterDir();
                    if (!Directory.Exists(targetDir)) Directory.CreateDirectory(targetDir);

                    string targetExePath = dirWritable ? currentExePath : Path.Combine(targetDir, exeName);
                    string newPath = targetExePath + ".new";
                    string oldPath = targetExePath + ".old";

                    string primaryUrl = !string.IsNullOrEmpty(remoteBin.url)
                        ? remoteBin.url
                        : ReleaseBase + "/" + Uri.EscapeDataString(exeName);
                    string fallbackUrl = (GetLoopbackManifestUrl() == null && !string.Equals(primaryUrl, ReleaseBase + "/" + Uri.EscapeDataString(exeName), StringComparison.OrdinalIgnoreCase))
                        ? ReleaseBase + "/" + Uri.EscapeDataString(exeName)
                        : null;

                    ReportProgress(onProgress, UpdateStage.SelfUpdating, "Updating installer to " + remoteVersion + "...", 0, remoteVersion, 0, 1, 0, remoteBin.size);

                    string downloadedHash = null;
                    long lastTicks = 0;
                    string[] urls = string.IsNullOrEmpty(fallbackUrl)
                        ? new string[] { primaryUrl }
                        : new string[] { primaryUrl, fallbackUrl };

                    for (int i = 0; i < urls.Length; i++)
                    {
                        if (cancel.IsCancelled)
                        {
                            try { if (File.Exists(newPath)) File.Delete(newPath); } catch { }
                            res.Success = false;
                            res.Offline = true;
                            return res;
                        }

                        try
                        {
                            downloadedHash = DownloadFileWithHash(urls[i], newPath, DownloadTimeoutMs, cancel, delegate(long done, long total)
                            {
                                long effectiveTotal = total > 0 ? total : remoteBin.size;
                                long nowTicks = DateTime.UtcNow.Ticks;
                                if (done < effectiveTotal && (nowTicks - lastTicks) < TimeSpan.FromMilliseconds(50).Ticks)
                                    return;
                                lastTicks = nowTicks;

                                int pct = effectiveTotal > 0 ? (int)Math.Min(99, (done * 100L) / effectiveTotal) : 0;
                                ReportProgress(
                                    onProgress,
                                    UpdateStage.SelfUpdating,
                                    string.Format("Updating installer to {0} ({1}%)...", remoteVersion, pct),
                                    pct,
                                    remoteVersion,
                                    0,
                                    1,
                                    done,
                                    effectiveTotal
                                );
                            });

                            if (string.Equals(downloadedHash, remoteBin.hash, StringComparison.OrdinalIgnoreCase))
                                break;

                            downloadedHash = null;
                            try { if (File.Exists(newPath)) File.Delete(newPath); } catch { }
                        }
                        catch
                        {
                            downloadedHash = null;
                            try { if (File.Exists(newPath)) File.Delete(newPath); } catch { }
                        }
                    }

                    if (string.IsNullOrEmpty(downloadedHash))
                    {
                        res.Success = false;
                        res.Offline = true;
                        res.ErrorMessage = "Downloaded installer failed SHA-256 verification.";
                        return res;
                    }

                    // Perform NTFS atomic swap or fallback copy
                    string launchExe = targetExePath;
                    if (dirWritable)
                    {
                        try
                        {
                            if (File.Exists(oldPath)) File.Delete(oldPath);
                            File.Move(currentExePath, oldPath);
                            try
                            {
                                File.Move(newPath, currentExePath);
                            }
                            catch
                            {
                                try { File.Move(oldPath, currentExePath); } catch { }
                                throw;
                            }
                        }
                        catch
                        {
                            string fallbackDir = GetLocalUpdaterDir();
                            if (!Directory.Exists(fallbackDir)) Directory.CreateDirectory(fallbackDir);
                            launchExe = Path.Combine(fallbackDir, exeName);
                            MoveOverwrite(newPath, launchExe);
                        }
                    }
                    else
                    {
                        MoveOverwrite(newPath, launchExe);
                    }

                    ReportProgress(onProgress, UpdateStage.SelfUpdatedRelaunching, "Restarting updated installer...", 100, remoteVersion, 1, 1, remoteBin.size, remoteBin.size);

                    List<string> childArgs = new List<string>();
                    childArgs.Add("--no-self-update");
                    childArgs.Add("--updated-from");
                    childArgs.Add(BuildInfo.Version);
                    childArgs.Add("--cleanup-old");
                    childArgs.Add(Process.GetCurrentProcess().Id.ToString());

                    if (getExtraLaunchArgs != null)
                    {
                        List<string> extras = getExtraLaunchArgs();
                        if (extras != null)
                            childArgs.AddRange(extras);
                    }
                    else if (options.ForwardedArgs != null && options.ForwardedArgs.Count > 0)
                    {
                        childArgs.AddRange(options.ForwardedArgs);
                    }

                    ProcessStartInfo psi = new ProcessStartInfo();
                    psi.FileName = launchExe;
                    psi.Arguments = JoinCommandLineArgs(childArgs);
                    psi.UseShellExecute = false;
                    psi.WorkingDirectory = Path.GetDirectoryName(launchExe);

                    Process child = Process.Start(psi);
                    res.Success = true;
                    res.Relaunched = true;
                    res.RelaunchedExePath = launchExe;
                    res.DownloadedFiles = 1;
                    res.DownloadedBytes = remoteBin.size;

                    if (!isGui && child != null)
                    {
                        child.WaitForExit();
                        res.RelaunchExitCode = child.ExitCode;
                    }
                    return res;
                }
                finally
                {
                    if (acquired)
                    {
                        try { mutex.ReleaseMutex(); } catch { }
                    }
                }
            }
        }

        private static bool CanWriteToDirectory(string dir)
        {
            if (string.IsNullOrEmpty(dir) || !Directory.Exists(dir)) return false;
            string probe = Path.Combine(dir, ".imcord_write_probe_" + Process.GetCurrentProcess().Id);
            try
            {
                using (FileStream fs = new FileStream(probe, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                {
                    fs.WriteByte(0);
                }
                File.Delete(probe);
                return true;
            }
            catch
            {
                try { if (File.Exists(probe)) File.Delete(probe); } catch { }
                return false;
            }
        }

        private static RemoteManifest FetchRemoteManifest(UpdateCancellation cancel)
        {
            string loopbackUrl = GetLoopbackManifestUrl();
            string[] urls = !string.IsNullOrEmpty(loopbackUrl)
                ? new string[] { loopbackUrl }
                : new string[]
                  {
                      ReleaseBase + "/manifest.json",
                      RawBase + "/userplugins/manifest.json"
                  };

            Exception lastError = null;
            JavaScriptSerializer ser = CreateSerializer();

            for (int i = 0; i < urls.Length; i++)
            {
                if (cancel.IsCancelled) break;
                try
                {
                    string json = DownloadString(urls[i], ManifestTimeoutMs, cancel);
                    RemoteManifest parsed = ser.Deserialize<RemoteManifest>(json);
                    if (parsed != null) return parsed;
                }
                catch (Exception ex)
                {
                    lastError = ex;
                }
            }

            if (lastError != null) throw lastError;
            return null;
        }

        private static string DownloadString(string url, int timeoutMs, UpdateCancellation cancel)
        {
            HttpWebRequest req = CreateRequest(AppendCacheBuster(url), timeoutMs, timeoutMs);
            cancel.Track(req);
            try
            {
                using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
                using (Stream s = resp.GetResponseStream())
                using (StreamReader sr = new StreamReader(s, Encoding.UTF8))
                {
                    return sr.ReadToEnd();
                }
            }
            finally
            {
                cancel.Untrack(req);
            }
        }

        private static string DownloadFileWithHash(
            string url,
            string destPath,
            int timeoutMs,
            UpdateCancellation cancel,
            Action<long, long> onBytes)
        {
            string dir = Path.GetDirectoryName(destPath);
            if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir))
                Directory.CreateDirectory(dir);

            HttpWebRequest req = CreateRequest(AppendCacheBuster(url), timeoutMs, timeoutMs);
            cancel.Track(req);
            try
            {
                using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
                using (Stream s = resp.GetResponseStream())
                using (SHA256 sha = SHA256.Create())
                using (FileStream fs = new FileStream(destPath, FileMode.Create, FileAccess.Write, FileShare.None))
                {
                    long total = resp.ContentLength;
                    long written = 0;
                    byte[] buffer = new byte[65536];
                    int read;
                    while ((read = s.Read(buffer, 0, buffer.Length)) > 0)
                    {
                        if (cancel.IsCancelled)
                            throw new OperationCanceledException();
                        sha.TransformBlock(buffer, 0, read, null, 0);
                        fs.Write(buffer, 0, read);
                        written += read;
                        if (onBytes != null) onBytes(written, total);
                    }
                    sha.TransformFinalBlock(new byte[0], 0, 0);
                    return BytesToHex(sha.Hash);
                }
            }
            finally
            {
                cancel.Untrack(req);
            }
        }

        private static HttpWebRequest CreateRequest(string url, int timeoutMs, int readWriteTimeoutMs)
        {
            HttpWebRequest req = (HttpWebRequest)WebRequest.Create(url);
            req.Method = "GET";
            req.UserAgent = "iMCord-Installer/" + BuildInfo.Version;
            req.AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate;
            req.AllowAutoRedirect = true;
            req.MaximumAutomaticRedirections = 10;
            req.Timeout = timeoutMs;
            req.ReadWriteTimeout = readWriteTimeoutMs;
            req.KeepAlive = true;
            req.CachePolicy = new HttpRequestCachePolicy(HttpRequestCacheLevel.NoCacheNoStore);
            req.Headers.Add("Cache-Control", "no-cache, no-store");
            req.Headers.Add("Pragma", "no-cache");
            return req;
        }

        private static string AppendCacheBuster(string url)
        {
            string sep = url.IndexOf('?') >= 0 ? "&" : "?";
            return url + sep + "t=" + DateTime.UtcNow.Ticks;
        }

        private static void PruneStaleCache(RemoteManifest manifest)
        {
            try
            {
                string distDir = GetCacheDistDir();
                if (Directory.Exists(distDir))
                {
                    foreach (string file in Directory.GetFiles(distDir))
                    {
                        string name = Path.GetFileName(file);
                        if (manifest.dist == null || !manifest.dist.ContainsKey(name))
                        {
                            try { File.Delete(file); } catch { }
                        }
                    }
                }

                string pluginsDir = GetCachePluginsDir();
                if (Directory.Exists(pluginsDir))
                {
                    foreach (string file in Directory.GetFiles(pluginsDir))
                    {
                        string name = Path.GetFileName(file);
                        if (manifest.plugins == null || !manifest.plugins.ContainsKey(name))
                        {
                            try { File.Delete(file); } catch { }
                        }
                    }
                }
            }
            catch { }
        }

        public static void MoveOverwrite(string srcPath, string destPath)
        {
            string dir = Path.GetDirectoryName(destPath);
            if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir))
                Directory.CreateDirectory(dir);

            if (File.Exists(destPath))
                File.Delete(destPath);
            File.Move(srcPath, destPath);
        }

        public static void CopyAtomic(string srcPath, string destPath)
        {
            string tmpPath = destPath + ".tmp";
            string dir = Path.GetDirectoryName(destPath);
            if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir))
                Directory.CreateDirectory(dir);

            File.Copy(srcPath, tmpPath, true);
            MoveOverwrite(tmpPath, destPath);
        }

        private static void ReportProgress(
            Action<UpdateProgress> onProgress,
            UpdateStage stage,
            string message,
            int percent,
            string remoteVersion,
            int filesDone,
            int filesTotal,
            long bytesDone,
            long bytesTotal)
        {
            if (onProgress == null) return;
            onProgress(new UpdateProgress
            {
                Stage = stage,
                Message = message,
                Percent = percent,
                RemoteVersion = remoteVersion,
                FilesDone = filesDone,
                FilesTotal = filesTotal,
                BytesDone = bytesDone,
                BytesTotal = bytesTotal
            });
        }

        private static JavaScriptSerializer CreateSerializer()
        {
            JavaScriptSerializer ser = new JavaScriptSerializer();
            ser.MaxJsonLength = 10 * 1024 * 1024;
            return ser;
        }

        private static Version ParseNumericVersion(string raw)
        {
            if (string.IsNullOrEmpty(raw)) return null;
            string s = raw.Trim();
            if (s.StartsWith("v", StringComparison.OrdinalIgnoreCase))
                s = s.Substring(1);
            int dash = s.IndexOf('-');
            if (dash > 0) s = s.Substring(0, dash);

            Version v;
            return Version.TryParse(s, out v) ? v : null;
        }

        private static bool IsRemoteOlder(string remoteVerStr, string localVerStr)
        {
            Version r = ParseNumericVersion(remoteVerStr);
            Version l = ParseNumericVersion(localVerStr);
            if (r == null || l == null) return false;
            return r < l;
        }

        private static bool VersionsEqual(string a, string b)
        {
            Version va = ParseNumericVersion(a);
            Version vb = ParseNumericVersion(b);
            if (va != null && vb != null) return va == vb;
            return string.Equals(a, b, StringComparison.OrdinalIgnoreCase);
        }

        public static string JoinCommandLineArgs(List<string> args)
        {
            if (args == null || args.Count == 0) return "";
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < args.Count; i++)
            {
                if (i > 0) sb.Append(' ');
                sb.Append(QuoteCommandLineArg(args[i]));
            }
            return sb.ToString();
        }

        private static string QuoteCommandLineArg(string arg)
        {
            if (arg == null) return "\"\"";
            if (arg.Length > 0 && arg.IndexOfAny(new char[] { ' ', '\t', '"' }) == -1)
                return arg;

            StringBuilder sb = new StringBuilder();
            sb.Append('"');
            int backslashes = 0;
            for (int i = 0; i < arg.Length; i++)
            {
                char c = arg[i];
                if (c == '\\')
                {
                    backslashes++;
                }
                else if (c == '"')
                {
                    sb.Append('\\', backslashes * 2 + 1);
                    sb.Append('"');
                    backslashes = 0;
                }
                else
                {
                    if (backslashes > 0)
                    {
                        sb.Append('\\', backslashes);
                        backslashes = 0;
                    }
                    sb.Append(c);
                }
            }
            if (backslashes > 0)
                sb.Append('\\', backslashes * 2);
            sb.Append('"');
            return sb.ToString();
        }
    }
}

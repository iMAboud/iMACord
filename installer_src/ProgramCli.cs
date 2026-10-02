using System;
using System.Collections.Generic;
using System.IO;

namespace VencordInstaller
{
    public class ProgramCli
    {
        public static int Main(string[] args)
        {
            Console.Title = "iMACord Installer CLI";

            bool flagInstall = false;
            bool flagRepair = false;
            bool flagUninstall = false;
            bool flagInstallOpenAsar = false;
            bool flagUninstallOpenAsar = false;
            bool flagHelp = false;
            bool flagVersion = false;

            string branchArg = "";
            string locationArg = "";

            for (int i = 0; i < args.Length; i++)
            {
                string a = args[i].TrimStart('-').ToLowerInvariant();
                if (a == "install") flagInstall = true;
                else if (a == "repair") flagRepair = true;
                else if (a == "uninstall") flagUninstall = true;
                else if (a == "install-openasar") flagInstallOpenAsar = true;
                else if (a == "uninstall-openasar") flagUninstallOpenAsar = true;
                else if (a == "help" || a == "h" || a == "?") flagHelp = true;
                else if (a == "version" || a == "v") flagVersion = true;
                else if (a == "branch" && i + 1 < args.Length) { branchArg = args[++i].ToLowerInvariant(); }
                else if (a == "location" && i + 1 < args.Length) { locationArg = args[++i]; }
            }

            if (flagHelp)
            {
                PrintHelp();
                return 0;
            }

            if (flagVersion)
            {
                Console.WriteLine("iMACord Installer CLI (Custom Build)");
                Console.WriteLine("Features: Custom User Plugins & In-App Plugin Manager");
                return 0;
            }

            List<DiscordInstall> discords = InstallerCore.FindDiscords();

            if (!string.IsNullOrEmpty(locationArg))
            {
                DiscordInstall custom = InstallerCore.ParseDiscord(locationArg, branchArg);
                if (custom != null)
                {
                    discords.Insert(0, custom);
                }
                else
                {
                    Console.ForegroundColor = ConsoleColor.Red;
                    Console.WriteLine("Error: Specified location is not a valid Discord install: " + locationArg);
                    Console.ResetColor();
                    return 1;
                }
            }

            bool hasActionFlag = flagInstall || flagRepair || flagUninstall || flagInstallOpenAsar || flagUninstallOpenAsar;

            if (!hasActionFlag)
            {
                return RunInteractive(discords);
            }

            DiscordInstall target = SelectTargetByBranch(discords, branchArg);
            if (target == null)
            {
                Console.ForegroundColor = ConsoleColor.Red;
                Console.WriteLine("Error: No valid Discord installation found.");
                Console.ResetColor();
                return 1;
            }

            Action<string> log = delegate(string s) {
                Console.WriteLine(" -> " + s);
            };

            try
            {
                if (flagInstall || flagRepair)
                {
                    Console.ForegroundColor = ConsoleColor.Cyan;
                    Console.WriteLine("Installing iMACord to: " + target.BasePath);
                    Console.ResetColor();
                    InstallerCore.Install(target, log);
                    Console.ForegroundColor = ConsoleColor.Green;
                    Console.WriteLine("Successfully installed iMACord!");
                    Console.ResetColor();
                }
                else if (flagUninstall)
                {
                    Console.ForegroundColor = ConsoleColor.Cyan;
                    Console.WriteLine("Uninstalling iMACord from: " + target.BasePath);
                    Console.ResetColor();
                    InstallerCore.Uninstall(target, log);
                    Console.ForegroundColor = ConsoleColor.Green;
                    Console.WriteLine("Successfully uninstalled iMACord!");
                    Console.ResetColor();
                }
                else if (flagInstallOpenAsar)
                {
                    Console.ForegroundColor = ConsoleColor.Cyan;
                    Console.WriteLine("Installing OpenAsar to: " + target.BasePath);
                    Console.ResetColor();
                    InstallerCore.InstallOpenAsar(target, log);
                    Console.ForegroundColor = ConsoleColor.Green;
                    Console.WriteLine("Successfully installed OpenAsar!");
                    Console.ResetColor();
                }
                else if (flagUninstallOpenAsar)
                {
                    Console.ForegroundColor = ConsoleColor.Cyan;
                    Console.WriteLine("Uninstalling OpenAsar from: " + target.BasePath);
                    Console.ResetColor();
                    InstallerCore.UninstallOpenAsar(target, log);
                    Console.ForegroundColor = ConsoleColor.Green;
                    Console.WriteLine("Successfully uninstalled OpenAsar!");
                    Console.ResetColor();
                }
                return 0;
            }
            catch (Exception ex)
            {
                Console.ForegroundColor = ConsoleColor.Red;
                Console.WriteLine("Operation failed: " + ex.Message);
                Console.ResetColor();
                return 1;
            }
        }

        private static int RunInteractive(List<DiscordInstall> discords)
        {
            Console.ForegroundColor = ConsoleColor.Cyan;
            Console.WriteLine("==================================================");
            Console.WriteLine("              VENCORD INSTALLER (CLI)");
            Console.WriteLine("    Custom Build: iMAMenu");
            Console.WriteLine("    + Custom Plugin Manager & Filters");
            Console.WriteLine("==================================================");
            Console.ResetColor();
            Console.WriteLine();

            if (discords.Count == 0)
            {
                Console.ForegroundColor = ConsoleColor.Yellow;
                Console.WriteLine("No Discord installations auto-detected in %LOCALAPPDATA%.");
                Console.ResetColor();
                Console.Write("Enter custom Discord installation directory (or press Enter to cancel): ");
                string custom = Console.ReadLine();
                if (string.IsNullOrEmpty(custom)) return 1;

                DiscordInstall di = InstallerCore.ParseDiscord(custom);
                if (di == null)
                {
                    Console.ForegroundColor = ConsoleColor.Red;
                    Console.WriteLine("Invalid Discord directory.");
                    Console.ResetColor();
                    return 1;
                }
                discords.Add(di);
            }

            Console.WriteLine("Detected Discord Installations:");
            for (int i = 0; i < discords.Count; i++)
            {
                DiscordInstall d = discords[i];
                Console.ForegroundColor = d.IsPatched ? ConsoleColor.Green : ConsoleColor.White;
                Console.WriteLine(string.Format("  [{0}] {1} ({2}){3}", i + 1, d.Name, d.BasePath, d.IsPatched ? " [Vencord Installed]" : ""));
            }
            Console.WriteLine(string.Format("  [{0}] Custom Location", discords.Count + 1));
            Console.ResetColor();
            Console.WriteLine();

            Console.Write("Select Discord install [1-" + (discords.Count + 1) + "]: ");
            string selStr = Console.ReadLine();
            int selIdx;
            if (!int.TryParse(selStr, out selIdx) || selIdx < 1 || selIdx > discords.Count + 1)
            {
                Console.WriteLine("Invalid selection.");
                return 1;
            }

            DiscordInstall selectedDiscord = null;
            if (selIdx == discords.Count + 1)
            {
                Console.Write("Enter path to Discord install: ");
                string customPath = Console.ReadLine();
                selectedDiscord = InstallerCore.ParseDiscord(customPath);
                if (selectedDiscord == null)
                {
                    Console.ForegroundColor = ConsoleColor.Red;
                    Console.WriteLine("Error: Invalid Discord path.");
                    Console.ResetColor();
                    return 1;
                }
            }
            else
            {
                selectedDiscord = discords[selIdx - 1];
            }

            Console.WriteLine();
            Console.WriteLine("What would you like to do?");
            Console.WriteLine("  [1] Install iMACord");
            Console.WriteLine("  [2] Reinstall / Repair iMACord");
            Console.WriteLine("  [3] Uninstall iMACord");
            Console.WriteLine("  [4] Install OpenAsar");
            Console.WriteLine("  [5] Uninstall OpenAsar");
            Console.WriteLine("  [6] Quit");
            Console.WriteLine();

            Console.Write("Choice [1-6]: ");
            string actStr = Console.ReadLine();
            int action;
            if (!int.TryParse(actStr, out action) || action < 1 || action > 6)
            {
                Console.WriteLine("Invalid choice.");
                return 1;
            }

            if (action == 6)
            {
                Console.WriteLine("Cancelled.");
                return 0;
            }

            Action<string> log = delegate(string s) {
                Console.WriteLine(" -> " + s);
            };

            Console.WriteLine();

            try
            {
                switch (action)
                {
                    case 1:
                    case 2:
                        Console.ForegroundColor = ConsoleColor.Cyan;
                        Console.WriteLine("Installing custom iMACord to: " + selectedDiscord.BasePath);
                        Console.ResetColor();
                        InstallerCore.Install(selectedDiscord, log);
                        Console.ForegroundColor = ConsoleColor.Green;
                        Console.WriteLine("\n[SUCCESS] iMACord installed successfully!");
                        Console.WriteLine("Restart Discord to use your custom plugins.");
                        Console.ResetColor();
                        break;
                    case 3:
                        Console.ForegroundColor = ConsoleColor.Cyan;
                        Console.WriteLine("Uninstalling iMACord from: " + selectedDiscord.BasePath);
                        Console.ResetColor();
                        InstallerCore.Uninstall(selectedDiscord, log);
                        Console.ForegroundColor = ConsoleColor.Green;
                        Console.WriteLine("\n[SUCCESS] iMACord uninstalled successfully!");
                        Console.ResetColor();
                        break;
                    case 4:
                        Console.ForegroundColor = ConsoleColor.Cyan;
                        Console.WriteLine("Installing OpenAsar to: " + selectedDiscord.BasePath);
                        Console.ResetColor();
                        InstallerCore.InstallOpenAsar(selectedDiscord, log);
                        Console.ForegroundColor = ConsoleColor.Green;
                        Console.WriteLine("\n[SUCCESS] OpenAsar installed successfully!");
                        Console.ResetColor();
                        break;
                    case 5:
                        Console.ForegroundColor = ConsoleColor.Cyan;
                        Console.WriteLine("Uninstalling OpenAsar from: " + selectedDiscord.BasePath);
                        Console.ResetColor();
                        InstallerCore.UninstallOpenAsar(selectedDiscord, log);
                        Console.ForegroundColor = ConsoleColor.Green;
                        Console.WriteLine("\n[SUCCESS] OpenAsar uninstalled successfully!");
                        Console.ResetColor();
                        break;
                }
                return 0;
            }
            catch (Exception ex)
            {
                Console.ForegroundColor = ConsoleColor.Red;
                Console.WriteLine("\n[FAILED] " + ex.Message);
                Console.ResetColor();
                return 1;
            }
            finally
            {
                Console.WriteLine("\nPress Enter to exit...");
                Console.ReadLine();
            }
        }

        private static DiscordInstall SelectTargetByBranch(List<DiscordInstall> discords, string branch)
        {
            if (discords.Count == 0) return null;
            if (string.IsNullOrEmpty(branch) || branch == "auto")
            {
                foreach (string b in new string[] { "stable", "ptb", "canary", "dev" })
                {
                    foreach (DiscordInstall d in discords)
                    {
                        if (string.Equals(d.Branch, b, StringComparison.OrdinalIgnoreCase))
                            return d;
                    }
                }
                return discords[0];
            }

            foreach (DiscordInstall d in discords)
            {
                if (string.Equals(d.Branch, branch, StringComparison.OrdinalIgnoreCase))
                    return d;
            }
            return null;
        }

        private static void PrintHelp()
        {
            Console.WriteLine("Usage: VencordInstallerCli.exe [options]");
            Console.WriteLine();
            Console.WriteLine("Options:");
            Console.WriteLine("  -install               Install iMACord");
            Console.WriteLine("  -repair                Repair / Reinstall iMACord");
            Console.WriteLine("  -uninstall             Uninstall iMACord");
            Console.WriteLine("  -install-openasar      Install OpenAsar");
            Console.WriteLine("  -uninstall-openasar    Uninstall OpenAsar");
            Console.WriteLine("  -branch <branch>       The branch of Discord [auto|stable|ptb|canary|dev]");
            Console.WriteLine("  -location <dir>        Custom location of the Discord install");
            Console.WriteLine("  -version               View program version");
            Console.WriteLine("  -help                  View usage instructions");
            Console.WriteLine();
        }
    }
}

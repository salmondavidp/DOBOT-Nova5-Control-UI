using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

internal static class DOBOTLauncher
{
    [STAThread]
    private static int Main()
    {
        string root = AppDomain.CurrentDomain.BaseDirectory;
        string appDir = Path.Combine(root, "dobot");
        string runBat = Path.Combine(appDir, "run.bat");

        if (!File.Exists(runBat))
        {
            MessageBox.Show(
                "Could not find dobot\\run.bat. Make sure the downloaded folder was extracted completely.",
                "DOBOT Nova 5 Control UI",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            return 1;
        }

        try
        {
            ProcessStartInfo startInfo = new ProcessStartInfo
            {
                FileName = runBat,
                WorkingDirectory = appDir,
                UseShellExecute = true,
            };
            Process.Start(startInfo);
            return 0;
        }
        catch (Exception ex)
        {
            MessageBox.Show(
                "Could not start the DOBOT launcher.\r\n\r\n" + ex.Message,
                "DOBOT Nova 5 Control UI",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            return 1;
        }
    }
}

using System.Net.NetworkInformation;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;

namespace StationOS.Services;

internal sealed class HardwareFingerprintService
{
    public HardwareFingerprintData Build()
    {
        var machineName = Environment.MachineName;
        var platform = $"{RuntimeInformation.OSDescription} {RuntimeInformation.OSArchitecture}";
        var cpuId = ReadCpuId();
        var mainboardUuid = ReadMainboardUuid();
        var diskSerial = ReadDiskSerial();
        var machineGuid = ReadMachineGuid();
        var macs = ReadPhysicalMacs();
        var fingerprint = ComputeFingerprint(cpuId, mainboardUuid, diskSerial, machineName, platform, machineGuid, macs);

        return new HardwareFingerprintData(
            fingerprint,
            cpuId,
            mainboardUuid,
            diskSerial,
            machineName,
            platform,
            machineGuid,
            macs
        );
    }

    private static string ComputeFingerprint(
        string? cpuId,
        string? mainboardUuid,
        string? diskSerial,
        string machineName,
        string platform,
        string? machineGuid,
        IReadOnlyList<string> macs)
    {
        var payload = string.Join('|', new[]
        {
            Normalize(cpuId),
            Normalize(mainboardUuid),
            Normalize(diskSerial),
            Normalize(machineName),
            Normalize(platform),
            Normalize(machineGuid),
            string.Join(',', macs.Select(Normalize).Where(x => !string.IsNullOrWhiteSpace(x)))
        });

        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(payload));
        return Convert.ToHexString(bytes);
    }

    private static string? ReadCpuId()
    {
        try
        {
            if (OperatingSystem.IsLinux())
            {
                var cpuinfo = File.Exists("/proc/cpuinfo") ? File.ReadAllText("/proc/cpuinfo") : "";
                foreach (var line in cpuinfo.Split('\n'))
                {
                    if (line.StartsWith("Serial", StringComparison.OrdinalIgnoreCase))
                        return line.Split(':', 2).LastOrDefault()?.Trim();
                    if (line.StartsWith("Hardware", StringComparison.OrdinalIgnoreCase))
                        return line.Split(':', 2).LastOrDefault()?.Trim();
                }
            }

            if (OperatingSystem.IsWindows())
            {
                return Environment.GetEnvironmentVariable("PROCESSOR_IDENTIFIER")?.Trim();
            }
        }
        catch { }

        return null;
    }

    private static string? ReadMainboardUuid()
    {
        var candidates = new[]
        {
            "/sys/class/dmi/id/product_uuid",
            "/sys/devices/virtual/dmi/id/product_uuid"
        };

        foreach (var path in candidates)
        {
            try
            {
                if (File.Exists(path))
                {
                    var value = File.ReadAllText(path).Trim();
                    if (!string.IsNullOrWhiteSpace(value))
                        return value;
                }
            }
            catch { }
        }

        return null;
    }

    private static string? ReadDiskSerial()
    {
        try
        {
            if (OperatingSystem.IsLinux())
            {
                var root = "/sys/block";
                if (Directory.Exists(root))
                {
                    foreach (var disk in Directory.GetDirectories(root))
                    {
                        var serialPath = Path.Combine(disk, "device", "serial");
                        if (File.Exists(serialPath))
                        {
                            var value = File.ReadAllText(serialPath).Trim();
                            if (!string.IsNullOrWhiteSpace(value))
                                return value;
                        }
                    }
                }
            }
        }
        catch { }

        return null;
    }

    private static string? ReadMachineGuid()
    {
        try
        {
            var candidates = new[]
            {
                "/etc/machine-id",
                "/var/lib/dbus/machine-id"
            };

            foreach (var path in candidates)
            {
                if (File.Exists(path))
                {
                    var value = File.ReadAllText(path).Trim();
                    if (!string.IsNullOrWhiteSpace(value))
                        return value;
                }
            }
        }
        catch { }

        return null;
    }

    private static IReadOnlyList<string> ReadPhysicalMacs()
    {
        var result = new List<string>();
        try
        {
            var virtualPrefixes = new[] { "lo", "veth", "docker", "br-", "virbr", "tun", "tap", "wg", "vmnet", "vboxnet", "vnet" };
            foreach (var nic in NetworkInterface.GetAllNetworkInterfaces())
            {
                if (nic.NetworkInterfaceType == NetworkInterfaceType.Loopback)
                    continue;
                if (nic.OperationalStatus != OperationalStatus.Up)
                    continue;

                var name = nic.Name.ToLowerInvariant();
                if (virtualPrefixes.Any(prefix => name.StartsWith(prefix)))
                    continue;

                if (OperatingSystem.IsLinux())
                {
                    var devicePath = $"/sys/class/net/{nic.Name}/device";
                    if (!Directory.Exists(devicePath))
                        continue;
                }

                var mac = nic.GetPhysicalAddress().ToString();
                if (!string.IsNullOrWhiteSpace(mac) && mac != "000000000000" && !result.Any(x => string.Equals(x, mac, StringComparison.OrdinalIgnoreCase)))
                {
                    result.Add(mac);
                }
            }
        }
        catch { }

        return result;
    }

    private static string Normalize(string? value)
        => string.IsNullOrWhiteSpace(value) ? "" : value.Trim().ToUpperInvariant();
}

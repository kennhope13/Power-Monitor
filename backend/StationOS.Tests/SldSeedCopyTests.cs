using System;
using System.IO;
using System.Threading.Tasks;
using Microsoft.EntityFrameworkCore;
using StationOS.Api.Extensions;
using StationOS.Data;
using StationOS.Data.Entities;
using Xunit;

namespace StationOS.Tests
{
    public class SldSeedCopyTests
    {
        private static AppDbContext CreateDb()
        {
            var opts = new DbContextOptionsBuilder<AppDbContext>()
                .UseInMemoryDatabase(Guid.NewGuid().ToString())
                .Options;
            return new AppDbContext(opts);
        }

        [Fact]
        public async Task SeedDefaultSld_ShouldCopySvgToCustomWebRoot_IfSourceExists()
        {
            // Arrange
            var tempWebRoot = Path.Combine(Path.GetTempPath(), "StationOS_Test_WebRoot_" + Guid.NewGuid());
            var appBaseDir = AppContext.BaseDirectory;
            var srcDir = Path.Combine(appBaseDir, "wwwroot", "sld");
            var srcFile = Path.Combine(srcDir, "7497ff6f-28c2-47a5-ba28-6b15f8a84c9c.svg");

            // Create dummy source file
            Directory.CreateDirectory(srcDir);
            await File.WriteAllTextAsync(srcFile, "<svg>Test SVG</svg>");

            // Set environment variable
            Environment.SetEnvironmentVariable("STATIONOS_WEB_ROOT", tempWebRoot);

            using var db = CreateDb();
            // Seed a station so the method doesn't exit early
            db.Stations.Add(new Station
            {
                Id = Guid.NewGuid(),
                Code = "TBA-LA01",
                Name = "Test Station",
                Status = "active"
            });
            await db.SaveChangesAsync();

            // Act
            // We invoke the private method via reflection or just call the public one if we want.
            // Since InitializeDatabaseAsync also calls it, but has database migrations, let's call the private method via reflection.
            var methodInfo = typeof(DbInitializer).GetMethod("SeedDefaultSldAsync", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static);
            Assert.NotNull(methodInfo);
            var taskObj = methodInfo!.Invoke(null, new object[] { db });
            Assert.NotNull(taskObj);
            var task = (Task)taskObj!;
            await task;

            // Assert
            var expectedDestFile = Path.Combine(tempWebRoot, "sld", "7497ff6f-28c2-47a5-ba28-6b15f8a84c9c.svg");
            Assert.True(File.Exists(expectedDestFile));
            var destContent = await File.ReadAllTextAsync(expectedDestFile);
            Assert.Equal("<svg>Test SVG</svg>", destContent);

            // Cleanup
            Environment.SetEnvironmentVariable("STATIONOS_WEB_ROOT", null);
            try
            {
                if (Directory.Exists(tempWebRoot)) Directory.Delete(tempWebRoot, true);
                if (File.Exists(srcFile)) File.Delete(srcFile);
            }
            catch { }
        }
    }
}

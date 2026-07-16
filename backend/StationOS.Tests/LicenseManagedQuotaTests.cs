using System;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Moq;
using StationOS.Api.Controllers;
using StationOS.Data;
using StationOS.Data.Entities;
using StationOS.Services;
using Xunit;

namespace StationOS.Tests
{
    public class LicenseManagedQuotaTests : IDisposable
    {
        private readonly string _tempLicenseRoot;
        private readonly AppDbContext _db;
        private readonly Mock<IConfiguration> _mockConfig;
        private readonly Mock<IWebHostEnvironment> _mockEnv;
        private readonly Mock<ILogger<LicenseService>> _mockLogger;
        private readonly IServiceScopeFactory _scopeFactory;

        public LicenseManagedQuotaTests()
        {
            _tempLicenseRoot = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString());
            Directory.CreateDirectory(_tempLicenseRoot);
            Environment.SetEnvironmentVariable("STATIONOS_LICENSE_ROOT", _tempLicenseRoot);

            var opts = new DbContextOptionsBuilder<AppDbContext>()
                .UseInMemoryDatabase(Guid.NewGuid().ToString())
                .Options;
            _db = new AppDbContext(opts);

            // Add a mock/dummy station to database as settings require a station FK
            _db.Stations.Add(new Station
            {
                Id = Guid.NewGuid(),
                Name = "Test Station",
                Status = "active"
            });
            _db.SaveChanges();

            _mockConfig = new Mock<IConfiguration>();
            _mockEnv = new Mock<IWebHostEnvironment>();
            _mockLogger = new Mock<ILogger<LicenseService>>();

            var services = new ServiceCollection();
            services.AddSingleton(_db);
            var serviceProvider = services.BuildServiceProvider();
            
            var mockScope = new Mock<IServiceScope>();
            mockScope.Setup(s => s.ServiceProvider).Returns(serviceProvider);

            var mockScopeFactory = new Mock<IServiceScopeFactory>();
            mockScopeFactory.Setup(sf => sf.CreateScope()).Returns(mockScope.Object);
            _scopeFactory = mockScopeFactory.Object;
        }

        public void Dispose()
        {
            if (Directory.Exists(_tempLicenseRoot))
            {
                try { Directory.Delete(_tempLicenseRoot, true); } catch { }
            }
            _db.Dispose();
        }

        [Fact]
        public async Task UpdateManagedQuota_ValidData_ShouldSaveToDbAndReturnOk()
        {
            var licenseService = new LicenseService(_scopeFactory, _mockConfig.Object, _mockEnv.Object, _mockLogger.Object);
            var controller = new LicenseController(licenseService, _db);
            var req = new ManagedQuotaData(5, 10, Guid.NewGuid(), "Master Station");

            var result = await controller.UpdateManagedQuota(req);

            var okResult = Assert.IsType<OkObjectResult>(result);
            var returnedQuota = Assert.IsType<ManagedQuotaData>(okResult.Value);
            Assert.Equal(5, returnedQuota.Cameras);
            Assert.Equal(10, returnedQuota.Sensors);

            // Verify persistence in DB
            var setting = await _db.SystemSettings.FirstOrDefaultAsync(s => s.Key == "managed_quota");
            Assert.NotNull(setting);
            var savedData = JsonSerializer.Deserialize<ManagedQuotaData>(setting.Value);
            Assert.NotNull(savedData);
            Assert.Equal(5, savedData.Cameras);
            Assert.Equal(10, savedData.Sensors);
        }

        [Fact]
        public async Task UpdateManagedQuota_NegativeQuota_ShouldReturnBadRequest()
        {
            var licenseService = new LicenseService(_scopeFactory, _mockConfig.Object, _mockEnv.Object, _mockLogger.Object);
            var controller = new LicenseController(licenseService, _db);
            var req = new ManagedQuotaData(-1, 5, Guid.NewGuid(), "Master Station");

            var result = await controller.UpdateManagedQuota(req);

            var badRequest = Assert.IsType<BadRequestObjectResult>(result);
            // Verify DB doesn't have it
            var setting = await _db.SystemSettings.FirstOrDefaultAsync(s => s.Key == "managed_quota");
            Assert.Null(setting);
        }

        [Fact]
        public async Task LicenseService_ShouldLoadManagedQuotaFromDb()
        {
            var licenseService = new LicenseService(_scopeFactory, _mockConfig.Object, _mockEnv.Object, _mockLogger.Object);
            
            // 1. Initially no license
            var statusBefore = await licenseService.GetStatusAsync();
            Assert.Null(statusBefore);

            // 2. Add managed quota directly to DB to simulate persistence/restart
            var req = new ManagedQuotaData(8, 12, Guid.NewGuid(), "Master Station");
            var jsonValue = JsonSerializer.Serialize(req);
            _db.SystemSettings.Add(new SystemSettings
            {
                StationId = await _db.Stations.Select(s => s.Id).FirstOrDefaultAsync(),
                Key = "managed_quota",
                Value = jsonValue,
                UpdatedAt = DateTime.UtcNow
            });
            await _db.SaveChangesAsync();

            licenseService.InvalidateSnapshot();

            // 3. Get status and verify limits match managed quota
            var statusAfter = await licenseService.GetStatusAsync();
            Assert.NotNull(statusAfter);
            Assert.Equal(8, statusAfter.MaxCameras);
            Assert.Equal(12, statusAfter.MaxSensors);
            Assert.Equal("managed", statusAfter.Source);
            Assert.True(statusAfter.IsValid);
        }

        [Fact]
        public async Task ClearAllLicenses_ShouldRemoveManagedQuota()
        {
            var licenseService = new LicenseService(_scopeFactory, _mockConfig.Object, _mockEnv.Object, _mockLogger.Object);
            
            // Add managed quota to DB
            var req = new ManagedQuotaData(5, 5, Guid.NewGuid(), "Master Station");
            var jsonValue = JsonSerializer.Serialize(req);
            _db.SystemSettings.Add(new SystemSettings
            {
                StationId = await _db.Stations.Select(s => s.Id).FirstOrDefaultAsync(),
                Key = "managed_quota",
                Value = jsonValue,
                UpdatedAt = DateTime.UtcNow
            });
            await _db.SaveChangesAsync();

            // Verify it is there
            Assert.NotNull(await _db.SystemSettings.FirstOrDefaultAsync(s => s.Key == "managed_quota"));

            // Clear all
            await licenseService.ClearAllLicensesAsync();

            // Verify it is gone
            Assert.Null(await _db.SystemSettings.FirstOrDefaultAsync(s => s.Key == "managed_quota"));
        }
    }
}

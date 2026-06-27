using Microsoft.EntityFrameworkCore;
using StationOS.Data.Entities;

namespace StationOS.Data;

public class AppDbContext : DbContext
{
    public AppDbContext(DbContextOptions<AppDbContext> options) : base(options) { }

    public DbSet<Station> Stations => Set<Station>();
    public DbSet<Device> Devices => Set<Device>();
    public DbSet<User> Users => Set<User>();
    public DbSet<SldFile> SldFiles => Set<SldFile>();
    public DbSet<SldPoint> SldPoints => Set<SldPoint>();
    public DbSet<SensorReading> SensorReadings => Set<SensorReading>();
    public DbSet<AiModelVersion> AiModelVersions => Set<AiModelVersion>();
    public DbSet<DetectionEvent> DetectionEvents => Set<DetectionEvent>();
    public DbSet<MediaFile> MediaFiles => Set<MediaFile>();
    public DbSet<ThermalFrame> ThermalFrames => Set<ThermalFrame>();
    public DbSet<Alert> Alerts => Set<Alert>();
    public DbSet<AlertHistory> AlertHistories => Set<AlertHistory>();
    public DbSet<Rule> Rules => Set<Rule>();
    public DbSet<RuleTriggerLog> RuleTriggerLogs => Set<RuleTriggerLog>();
    public DbSet<AuditLog> AuditLogs => Set<AuditLog>();
    public DbSet<LoginLog> LoginLogs => Set<LoginLog>();
    public DbSet<NotifyLog> NotifyLogs => Set<NotifyLog>();
    public DbSet<SystemSettings> SystemSettings => Set<SystemSettings>();
    public DbSet<Report> Reports => Set<Report>();
    public DbSet<SyncQueue> SyncQueues => Set<SyncQueue>();
    public DbSet<MaintenanceTask> MaintenanceTasks => Set<MaintenanceTask>();
    public DbSet<License> Licenses => Set<License>();
    public DbSet<Boundary> Boundaries => Set<Boundary>();
    public DbSet<RoiPoint> RoiPoints => Set<RoiPoint>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        base.OnModelCreating(modelBuilder);

        // SensorReading — TimescaleDB hypertable (composite key: time + id)
        modelBuilder.Entity<SensorReading>(e =>
        {
            e.HasKey(x => new { x.Time, x.Id });
            e.Property(x => x.Id).ValueGeneratedOnAdd();
            e.HasIndex(x => new { x.StationId, x.Time });
            e.HasIndex(x => new { x.DeviceId, x.PointId, x.Time });
        });

        // SystemSettings — unique constraint (station_id, key)
        modelBuilder.Entity<SystemSettings>()
            .HasIndex(x => new { x.StationId, x.Key })
            .IsUnique();

        // JSON columns (PostgreSQL JSONB)
        modelBuilder.Entity<Station>().Property(x => x.Location).HasColumnType("jsonb");
        modelBuilder.Entity<Device>().Property(x => x.Config).HasColumnType("jsonb");
        modelBuilder.Entity<Rule>().Property(x => x.Condition).HasColumnType("jsonb");
        modelBuilder.Entity<Rule>().Property(x => x.Actions).HasColumnType("jsonb");
        modelBuilder.Entity<DetectionEvent>().Property(x => x.BoundingBoxes).HasColumnType("jsonb");
        modelBuilder.Entity<DetectionEvent>().Property(x => x.Metadata).HasColumnType("jsonb");
        modelBuilder.Entity<ThermalFrame>().Property(x => x.TempMatrix).HasColumnType("jsonb");
        modelBuilder.Entity<AuditLog>().Property(x => x.OldValue).HasColumnType("jsonb");
        modelBuilder.Entity<AuditLog>().Property(x => x.NewValue).HasColumnType("jsonb");
        modelBuilder.Entity<SyncQueue>().Property(x => x.Payload).HasColumnType("jsonb");
        modelBuilder.Entity<SystemSettings>().Property(x => x.Value).HasColumnType("jsonb");
        modelBuilder.Entity<RuleTriggerLog>().Property(x => x.ConditionSnapshot).HasColumnType("jsonb");
        modelBuilder.Entity<MaintenanceTask>().Property(x => x.Checklist).HasColumnType("jsonb");
        modelBuilder.Entity<Boundary>().Property(x => x.PolygonJson).HasColumnType("jsonb");
        modelBuilder.Entity<Boundary>().Property(x => x.ThresholdsJson).HasColumnType("jsonb");

        // Boundary index: nhanh khi list theo device
        modelBuilder.Entity<Boundary>().HasIndex(x => new { x.DeviceId, x.Type });
    }

    private bool _isSyncQueueSaving = false;

    public override async Task<int> SaveChangesAsync(System.Threading.CancellationToken cancellationToken = default)
    {
        if (_isSyncQueueSaving)
        {
            return await base.SaveChangesAsync(cancellationToken);
        }

        var addedEntries = ChangeTracker.Entries()
            .Where(e => e.State == EntityState.Added)
            .Select(e => e.Entity)
            .ToList();

        var modifiedEntries = ChangeTracker.Entries()
            .Where(e => e.State == EntityState.Modified)
            .Select(e => e.Entity)
            .ToList();

        var result = await base.SaveChangesAsync(cancellationToken);

        var syncItems = new System.Collections.Generic.List<SyncQueue>();

        foreach (var entity in addedEntries)
        {
            if (entity is SyncQueue) continue;

            if (entity is Alert alert)
            {
                bool alreadyQueued = SyncQueues.Local.Any(q => q.EntityType == "Alert" && q.EntityId == alert.Id) ||
                                     await SyncQueues.AnyAsync(q => q.EntityType == "Alert" && q.EntityId == alert.Id, cancellationToken);
                if (!alreadyQueued)
                {
                    syncItems.Add(new SyncQueue
                    {
                        EntityType = "Alert",
                        EntityId = alert.Id,
                        Payload = System.Text.Json.JsonSerializer.Serialize(new
                        {
                            id = alert.Id,
                            station_id = alert.StationId,
                            device_id = alert.DeviceId,
                            rule_id = alert.RuleId,
                            source = alert.Source,
                            level = alert.Level,
                            status = alert.Status,
                            message = alert.Message,
                            value = alert.Value,
                            triggered_at = alert.TriggeredAt,
                            imageUrl = alert.ImageUrl,
                            thumbnailUrl = alert.ThumbnailUrl,
                            videoUrl = alert.VideoUrl
                        }),
                        Status = "pending"
                    });
                }
            }
            else if (entity is DetectionEvent evt)
            {
                syncItems.Add(new SyncQueue
                {
                    EntityType = "DetectionEvent",
                    EntityId = evt.Id,
                    Payload = System.Text.Json.JsonSerializer.Serialize(new
                    {
                        id = evt.Id,
                        cameraId = evt.CameraId,
                        stationId = evt.StationId,
                        source = evt.Source,
                        detectionType = evt.DetectionType,
                        confidence = evt.Confidence,
                        boundingBoxes = evt.BoundingBoxes,
                        metadata = evt.Metadata,
                        detectedAt = evt.DetectedAt
                    }),
                    Status = "pending"
                });
            }
            else if (entity is Report report)
            {
                bool alreadyQueued = SyncQueues.Local.Any(q => q.EntityType == "Report" && q.EntityId == report.Id) ||
                                     await SyncQueues.AnyAsync(q => q.EntityType == "Report" && q.EntityId == report.Id, cancellationToken);
                if (!alreadyQueued)
                {
                    syncItems.Add(new SyncQueue
                    {
                        EntityType = "Report",
                        EntityId = report.Id,
                        Payload = System.Text.Json.JsonSerializer.Serialize(new
                        {
                            id = report.Id,
                            stationId = report.StationId,
                            type = report.Type,
                            periodFrom = report.PeriodFrom,
                            periodTo = report.PeriodTo,
                            fileUrl = report.FileUrl,
                            generatedAt = report.GeneratedAt,
                            generatedBy = report.GeneratedBy
                        }),
                        Status = "pending"
                    });
                }
            }
            else if (entity is AuditLog auditLog)
            {
                bool alreadyQueued = SyncQueues.Local.Any(q => q.EntityType == "AuditLog" && q.EntityId == auditLog.Id) ||
                                     await SyncQueues.AnyAsync(q => q.EntityType == "AuditLog" && q.EntityId == auditLog.Id, cancellationToken);
                if (!alreadyQueued)
                {
                    syncItems.Add(new SyncQueue
                    {
                        EntityType = "AuditLog",
                        EntityId = auditLog.Id,
                        Payload = System.Text.Json.JsonSerializer.Serialize(new
                        {
                            id = auditLog.Id,
                            userId = auditLog.UserId,
                            action = auditLog.Action,
                            entityType = auditLog.EntityType,
                            entityId = auditLog.EntityId,
                            ipAddress = auditLog.IpAddress,
                            oldValue = auditLog.OldValue,
                            newValue = auditLog.NewValue,
                            ts = auditLog.Ts
                        }),
                        Status = "pending"
                    });
                }
            }
            else if (entity is MaintenanceTask task)
            {
                bool alreadyQueued = SyncQueues.Local.Any(q => q.EntityType == "MaintenanceTask" && q.EntityId == task.Id) ||
                                     await SyncQueues.AnyAsync(q => q.EntityType == "MaintenanceTask" && q.EntityId == task.Id, cancellationToken);
                if (!alreadyQueued)
                {
                    syncItems.Add(new SyncQueue
                    {
                        EntityType = "MaintenanceTask",
                        EntityId = task.Id,
                        Payload = System.Text.Json.JsonSerializer.Serialize(new
                        {
                            id = task.Id,
                            stationId = task.StationId,
                            deviceId = task.DeviceId,
                            title = task.Title,
                            type = task.Type,
                            status = task.Status,
                            assignedTo = task.AssignedTo,
                            notes = task.Notes,
                            scheduledDate = task.ScheduledDate,
                            completedAt = task.CompletedAt
                        }),
                        Status = "pending"
                    });
                }
            }
        }

        foreach (var entity in modifiedEntries)
        {
            if (entity is MaintenanceTask task)
            {
                if (!syncItems.Any(q => q.EntityType == "MaintenanceTask" && q.EntityId == task.Id))
                {
                    syncItems.Add(new SyncQueue
                    {
                        EntityType = "MaintenanceTask",
                        EntityId = task.Id,
                        Payload = System.Text.Json.JsonSerializer.Serialize(new
                        {
                            id = task.Id,
                            stationId = task.StationId,
                            deviceId = task.DeviceId,
                            title = task.Title,
                            type = task.Type,
                            status = task.Status,
                            assignedTo = task.AssignedTo,
                            notes = task.Notes,
                            scheduledDate = task.ScheduledDate,
                            completedAt = task.CompletedAt
                        }),
                        Status = "pending"
                    });
                }
            }
            else if (entity is Alert alert)
            {
                if (!syncItems.Any(q => q.EntityType == "Alert" && q.EntityId == alert.Id))
                {
                    syncItems.Add(new SyncQueue
                    {
                        EntityType = "Alert",
                        EntityId = alert.Id,
                        Payload = System.Text.Json.JsonSerializer.Serialize(new
                        {
                            id = alert.Id,
                            station_id = alert.StationId,
                            device_id = alert.DeviceId,
                            rule_id = alert.RuleId,
                            source = alert.Source,
                            level = alert.Level,
                            status = alert.Status,
                            message = alert.Message,
                            value = alert.Value,
                            triggered_at = alert.TriggeredAt,
                            imageUrl = alert.ImageUrl,
                            thumbnailUrl = alert.ThumbnailUrl,
                            videoUrl = alert.VideoUrl
                        }),
                        Status = "pending"
                    });
                }
            }
        }

        if (syncItems.Count > 0)
        {
            try
            {
                _isSyncQueueSaving = true;
                SyncQueues.AddRange(syncItems);
                await base.SaveChangesAsync(cancellationToken);
            }
            finally
            {
                _isSyncQueueSaving = false;
            }
        }

        return result;
    }
}

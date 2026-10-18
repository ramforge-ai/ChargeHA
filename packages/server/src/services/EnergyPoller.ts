import type { CumulativeEnergyData, EnergyData } from "@chargeha/shared";
import { observable } from "@trpc/server/observable";
import type { Observable } from "@trpc/server/observable";
import type { TypedEventEmitter } from "./TypedEventEmitter.ts";
import type { EnergyAdapterManager } from "./EnergyAdapterManager.ts";
import type { ChargingPointManager } from "./ChargingPointManager.ts";
import type { AppDatabase } from "../db/AppDatabase.ts";
import type { Logger } from "../lib/Logger.ts";
import { ServiceError } from "../lib/ServiceError.ts";
import { energyRetryDelayMs } from "./energyRetryDelayMs.ts";

export class EnergyPoller {
  private readonly em: EnergyAdapterManager;
  private readonly chargingPoints: ChargingPointManager;
  private readonly eventEmitter: TypedEventEmitter;
  private readonly db: AppDatabase;
  private readonly logger: Logger;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private stopped = false;
  private lifecycle: Promise<void> = Promise.resolve();
  private controller: AbortController | null = null;
  private retryDelayMs = 0;
  // In-flight poll, tracked so stop() can await it before shutdown.
  private polling: Promise<void> | null = null;
  private latestRealtime: EnergyData | null = null;
  private latestCumulative: CumulativeEnergyData | null = null;
  private consecutivePollFailures = 0;
  private lastFailureLoggedAtMs = 0;
  private reconfigurePending = false;

  constructor(
    em: EnergyAdapterManager,
    chargingPoints: ChargingPointManager,
    eventEmitter: TypedEventEmitter,
    db: AppDatabase,
    logger: Logger,
  ) {
    this.em = em;
    this.chargingPoints = chargingPoints;
    this.eventEmitter = eventEmitter;
    this.db = db;
    this.logger = logger;
    // When a config key relevant to the active adapter changes, rebuild
    // the adapter and restart the timer so the new poll interval takes
    // effect immediately. Coalesced per tick: a multi-key save emits one
    // config_changed per key, and rebuilding per event would tear down and
    // re-login the adapter once per key.
    this.eventEmitter.subscribe("config_changed", ({ key }) => {
      if (this.stopped || !this.em.isRelevantConfigKey(key)) return;
      if (this.reconfigurePending) return;
      this.reconfigurePending = true;
      queueMicrotask(() => {
        this.reconfigurePending = false;
        if (this.stopped) return;
        void this.requestStart(true).catch((error) => {
          this.logger.error("Energy adapter reconfiguration failed:", error);
        });
      });
    });
    void this.requestStart().catch((error) => {
      this.logger.error("Energy polling initialization failed:", error);
    });
  }

  private invalidate(): number {
    this.generation++;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.controller?.abort(new Error("Energy polling stopped"));
    return this.generation;
  }

  private requestStart(reconfigure = false): Promise<void> {
    this.stopped = false;
    const generation = this.invalidate();
    const previous = this.polling;
    this.lifecycle = this.lifecycle.catch((error) => {
      this.logger.error("Previous energy lifecycle operation failed:", error);
    }).then(async () => {
      await previous;
      if (generation !== this.generation) return;
      if (reconfigure) await this.em.reconfigure();
      else await this.em.ready();
      if (generation !== this.generation) return;
      this.latestRealtime = null;
      this.latestCumulative = null;
      this.retryDelayMs = 0;
      this.consecutivePollFailures = 0;
      this.lastFailureLoggedAtMs = 0;
      this.logger.info(
        `Polling every ${this.em.pollIntervalSeconds()}s after completion`,
      );
      this.launch(generation);
    });
    return this.lifecycle;
  }

  private launch(generation: number): void {
    if (generation !== this.generation || this.polling) return;
    const controller = new AbortController();
    this.controller = controller;
    this.polling = this.poll(generation, controller.signal).catch((error) => {
      this.logger.error("Energy poll processing failed:", error);
      this.retryDelayMs = 30_000;
    }).finally(() => {
      this.polling = null;
      this.controller = null;
      if (generation !== this.generation) return;
      // A retry must never accelerate an adapter's normal cadence. Apply this
      // floor here so it also covers unexpected poll-processing failures, and
      // intervals longer than the retry ladder's five-minute cap.
      const delay = Math.max(
        this.retryDelayMs,
        this.em.pollIntervalSeconds() * 1000,
      );
      if (this.retryDelayMs > 0) {
        this.logger.info(
          `Energy polling retry in ${Math.ceil(delay / 1000)}s`,
        );
      }
      this.timer = setTimeout(() => this.launch(generation), delay);
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const generation = this.invalidate();
    await this.lifecycle;
    await this.polling;
    if (generation !== this.generation) return;
    this.latestRealtime = null;
    this.latestCumulative = null;
  }

  restart(): Promise<void> {
    return this.requestStart();
  }

  getRealtimeSnapshot(): {
    timestamp: string;
    realtime: EnergyData;
    cumulative: CumulativeEnergyData;
  } {
    const snapshot = this.tryGetRealtimeSnapshot();
    if (!snapshot) {
      throw new ServiceError("No data available yet", "PRECONDITION_FAILED");
    }
    return snapshot;
  }

  tryGetRealtimeSnapshot(): {
    timestamp: string;
    realtime: EnergyData;
    cumulative: CumulativeEnergyData;
  } | null {
    if (!this.latestRealtime || !this.latestCumulative) return null;
    return {
      timestamp: new Date().toISOString(),
      realtime: this.latestRealtime,
      cumulative: this.latestCumulative,
    };
  }

  subscribeToUpdates(): Observable<EnergyData & CumulativeEnergyData, unknown> {
    return observable<EnergyData & CumulativeEnergyData>((emit) => {
      // Initial snapshot (replaces WS onopen behavior)
      if (this.latestRealtime && this.latestCumulative) {
        emit.next({ ...this.latestRealtime, ...this.latestCumulative });
      }

      // Subscribe to live updates
      const unsubscribe = this.eventEmitter.subscribe(
        "energy_update",
        (data) => {
          emit.next(data);
        },
      );

      return unsubscribe;
    });
  }

  private async poll(
    generation = this.generation,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      const load = await this.chargingPoints.getChargingLoadW();
      if (generation !== this.generation) return;
      const realtime = await this.em.getRealtimeData(load, signal);
      if (generation !== this.generation) return;
      const adapterName = this.em.constructor.name;
      this.logger.debug(
        `${adapterName} → solar=${realtime.solarProductionW}W grid=${realtime.gridPowerW}W consumption=${realtime.homeConsumptionW}W` +
          (realtime.batteryPowerW != null
            ? ` battery=${realtime.batteryPowerW}W soc=${realtime.batterySoc}%`
            : ""),
      );

      // Build cumulative data from local DB recordings
      // Use the configured timezone (IANA) so the "today" boundary matches
      // the user's local day, not the server's system timezone.
      const timezone = (await this.db.getConfig("timezone")) ?? "";
      const todaySummary = await this.db.getTodayEnergySummary(timezone);
      const cumulative: CumulativeEnergyData = {
        solarProducedWh: 0,
        gridImportedWh: 0,
        gridExportedWh: 0,
        dailySolarProducedWh: todaySummary.solarWh,
        dailyGridImportWh: todaySummary.gridImportWh,
        dailyGridExportWh: todaySummary.gridExportWh,
      };

      if (generation !== this.generation) return;
      this.retryDelayMs = 0;
      this.latestRealtime = realtime;
      this.latestCumulative = cumulative;

      // Emit energy update for tRPC subscriptions and DataRecorder
      this.eventEmitter.emit("energy_update", { ...realtime, ...cumulative });

      // Emit poll success for notification listener
      this.eventEmitter.emit("energy_poll_success", {});

      if (this.consecutivePollFailures > 0) {
        await this.recordPluginLog(
          "info",
          `Polling recovered after ${this.consecutivePollFailures} failed poll(s)`,
        );
        this.consecutivePollFailures = 0;
        this.lastFailureLoggedAtMs = 0;
      }
    } catch (error) {
      if (generation !== this.generation) return;
      this.logger.error("Poll failed:", error);
      await this.recordPollFailure(error);
      this.retryDelayMs = energyRetryDelayMs(
        error,
        this.consecutivePollFailures,
      );

      // Record the failure as a zero-valued breadcrumb so DataRecorder writes a
      // row with poll_failed=1 instead of silently re-recording the previous
      // good reading every minute. Daily totals come from DB so we still need
      // to fetch them — fall back to zeros if even that fails.
      const failedRealtime: EnergyData = {
        solarProductionW: 0,
        gridPowerW: 0,
        homeConsumptionW: 0,
        batteryPowerW: null,
        batterySoc: null,
        gridVoltageV: null,
        lastUpdated: new Date().toISOString(),
        pollFailed: true,
        pollError: error instanceof Error ? error.message : String(error),
      };
      const failedCumulative = await this.buildCumulativeFromDb();

      if (generation !== this.generation) return;
      this.latestRealtime = failedRealtime;
      this.latestCumulative = failedCumulative;
      this.eventEmitter.emit("energy_update", {
        ...failedRealtime,
        ...failedCumulative,
      });

      // Emit poll failure for notification listener
      this.eventEmitter.emit("energy_poll_failure", {
        error: error instanceof Error ? error.message : String(error),
      });
      // Failure remains visible throughout the cooldown; never serve cached data as fresh.
    }
  }

  // First failure is logged immediately; repeats at most every 5 minutes,
  // carrying the consecutive-failure count, so a dead inverter fills the
  // Logs page with a heartbeat rather than one row per tick.
  private async recordPollFailure(error: unknown): Promise<void> {
    this.consecutivePollFailures++;
    const nowMs = Date.now();
    const throttleMs = 5 * 60 * 1000;
    if (
      this.lastFailureLoggedAtMs !== 0 &&
      nowMs - this.lastFailureLoggedAtMs < throttleMs
    ) return;
    this.lastFailureLoggedAtMs = nowMs;
    await this.recordPluginLog(
      "error",
      `Poll failed: ${error instanceof Error ? error.message : String(error)}`,
      this.consecutivePollFailures > 1
        ? { consecutiveFailures: this.consecutivePollFailures }
        : undefined,
    );
  }

  private async recordPluginLog(
    level: string,
    message: string,
    payload?: Record<string, unknown>,
  ): Promise<void> {
    const pluginId = this.em.activePluginId;
    if (!pluginId) return;
    try {
      await this.db.insertPluginLog({
        pluginId,
        level,
        message,
        payload: payload ? JSON.stringify(payload) : null,
        origin: null,
        traceId: null,
      });
    } catch (err) {
      this.logger.error("Failed to persist poll log entry:", err);
    }
  }

  // Build cumulative-from-DB block; on DB error, return zeros so a poll
  // failure path still produces a usable event.
  private async buildCumulativeFromDb(): Promise<CumulativeEnergyData> {
    try {
      const timezone = (await this.db.getConfig("timezone")) ?? "";
      const todaySummary = await this.db.getTodayEnergySummary(timezone);
      return {
        solarProducedWh: 0,
        gridImportedWh: 0,
        gridExportedWh: 0,
        dailySolarProducedWh: todaySummary.solarWh,
        dailyGridImportWh: todaySummary.gridImportWh,
        dailyGridExportWh: todaySummary.gridExportWh,
      };
    } catch {
      return {
        solarProducedWh: 0,
        gridImportedWh: 0,
        gridExportedWh: 0,
        dailySolarProducedWh: 0,
        dailyGridImportWh: 0,
        dailyGridExportWh: 0,
      };
    }
  }
}

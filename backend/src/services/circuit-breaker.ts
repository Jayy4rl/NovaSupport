import { logger } from "../logger.js";
import { Metrics } from "../metrics.js";

export type State = "CLOSED" | "OPEN" | "HALF_OPEN";

export type CircuitBreakerSnapshot = {
  state: State;
  failureCount: number;
  nextAttempt: number;
};

export type CircuitBreakerStorage = {
  load(): Promise<CircuitBreakerSnapshot | null>;
  save(snapshot: CircuitBreakerSnapshot): Promise<void>;
};

export class CircuitBreaker {
  private state: State = "CLOSED";
  private failureThreshold: number;
  private resetTimeout: number;
  private failureCount: number = 0;
  private nextAttempt: number = 0;
  private readonly storage: CircuitBreakerStorage | null;
  private initialized: Promise<void> | null = null;
  /**
   * Tracks the single in-flight canary request during HALF_OPEN state.
   * Once one caller claims the canary slot (by setting this promise), every
   * other concurrent caller sees the breaker as still OPEN and fails fast,
   * preventing a request burst from re-tripping the circuit right after
   * Horizon recovers from an outage.
   */
  private halfOpenCanary: Promise<unknown> | null = null;

  constructor(
    failureThreshold = 5,
    resetTimeout = 30000,
    storage: CircuitBreakerStorage | null = null,
  ) {
    this.failureThreshold = failureThreshold;
    this.resetTimeout = resetTimeout;
    this.storage = storage;
    Metrics.circuitBreakerState("CLOSED");
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    await this.ensureInitialized();

    if (this.state === "OPEN") {
      if (Date.now() >= this.nextAttempt) {
        await this.setState("HALF_OPEN");
        Metrics.circuitBreakerState("HALF_OPEN");
        logger.info("Circuit breaker state: HALF_OPEN");
      } else {
        throw new Error("Circuit breaker is OPEN");
      }
    }

    // HALF_OPEN: allow exactly one canary request through; all other
    // concurrent callers fail fast (as if still OPEN) until the canary
    // resolves. This prevents a request burst from re-tripping the circuit
    // immediately after the downstream service recovers.
    if (this.state === "HALF_OPEN") {
      if (this.halfOpenCanary !== null) {
        throw new Error("Circuit breaker is OPEN");
      }

      let resolvCanary!: () => void;
      this.halfOpenCanary = new Promise<void>((resolve) => {
        resolvCanary = resolve;
      });

      try {
        let result!: T;
        try {
          result = await fn();
        } catch (error) {
          await this.onFailure();
          throw error;
        }
        await this.onSuccess();
        return result;
      } finally {
        this.halfOpenCanary = null;
        resolvCanary();
      }
    }

    let result!: T;
    try {
      result = await fn();
    } catch (error) {
      await this.onFailure();
      throw error;
    }
    await this.onSuccess();
    return result;
  }

  private async onSuccess() {
    const unchanged = this.failureCount === 0 && this.state === "CLOSED";
    this.failureCount = 0;
    if (this.state === "HALF_OPEN") {
      await this.setState("CLOSED");
      Metrics.circuitBreakerState("CLOSED");
      logger.info("Circuit breaker state: CLOSED");
    } else if (!unchanged) {
      await this.persist();
    }
  }

  private async onFailure() {
    this.failureCount++;
    if (this.state === "HALF_OPEN" || this.failureCount >= this.failureThreshold) {
      this.nextAttempt = Date.now() + this.resetTimeout;
      try {
        await this.setState("OPEN");
      } catch (err) {
        logger.error({ err }, "Failed to persist circuit breaker OPEN state");
      }
      Metrics.circuitBreakerState("OPEN");
      logger.warn(
        { failureCount: this.failureCount, nextAttempt: new Date(this.nextAttempt).toISOString() },
        "Circuit breaker state: OPEN"
      );
    } else {
      try {
        await this.persist();
      } catch (err) {
        logger.error({ err }, "Failed to persist circuit breaker state");
      }
    }
  }

  getState(): State {
    return this.state;
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.storage) return;
    this.initialized ??= this.storage.load()
      .then(async (snapshot) => {
        if (!snapshot) {
          await this.persist();
          return;
        }
        this.state = snapshot.state;
        this.failureCount = snapshot.failureCount;
        this.nextAttempt = snapshot.nextAttempt;

        if (this.state === "OPEN" && Date.now() >= this.nextAttempt) {
          this.state = "HALF_OPEN";
          await this.persist();
        }

        Metrics.circuitBreakerState(this.state);
        logger.info(
          {
            state: this.state,
            failureCount: this.failureCount,
            nextAttempt: this.nextAttempt ? new Date(this.nextAttempt).toISOString() : null,
          },
          "Circuit breaker state restored",
        );
      })
      .catch((err) => {
        logger.error({ err }, "Failed to restore circuit breaker state");
      });
    await this.initialized;
  }

  private async setState(state: State): Promise<void> {
    this.state = state;
    if (state === "CLOSED") {
      this.nextAttempt = 0;
    }
    await this.persist();
  }

  private async persist(): Promise<void> {
    if (!this.storage) return;
    await this.storage.save({
      state: this.state,
      failureCount: this.failureCount,
      nextAttempt: this.nextAttempt,
    });
  }
}

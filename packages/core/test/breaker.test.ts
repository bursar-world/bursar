import { describe, expect, it } from 'vitest';
import { CircuitBreaker } from '../src/rpc/breaker.js';

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe('CircuitBreaker', () => {
  it('stays closed until the failure threshold is reached', () => {
    const c = clock();
    const breaker = new CircuitBreaker('primary', { failureThreshold: 3, openMs: 5_000, now: c.now });

    breaker.fail('timeout');
    breaker.fail('timeout');
    expect(breaker.state).toBe('closed');
    expect(breaker.tryAcquire()).toBe(true);

    breaker.fail('timeout');
    expect(breaker.state).toBe('open');
    expect(breaker.tryAcquire()).toBe(false);
  });

  it('one success anywhere below the threshold clears the count', () => {
    const c = clock();
    const breaker = new CircuitBreaker('primary', { failureThreshold: 3, now: c.now });

    breaker.fail('timeout');
    breaker.fail('timeout');
    breaker.succeed();
    expect(breaker.consecutiveFailures).toBe(0);

    breaker.fail('timeout');
    breaker.fail('timeout');
    expect(breaker.state).toBe('closed');
  });

  it('goes half-open once the cooldown elapses and admits exactly one probe', () => {
    const c = clock();
    const breaker = new CircuitBreaker('primary', { failureThreshold: 1, openMs: 5_000, now: c.now });

    breaker.fail('http 429');
    expect(breaker.state).toBe('open');

    c.advance(4_999);
    expect(breaker.state).toBe('open');

    c.advance(1);
    expect(breaker.state).toBe('half-open');
    expect(breaker.tryAcquire()).toBe(true);
    expect(breaker.tryAcquire()).toBe(false);
  });

  it('closes when the probe succeeds', () => {
    const c = clock();
    const breaker = new CircuitBreaker('primary', { failureThreshold: 1, openMs: 5_000, now: c.now });

    breaker.fail('http 429');
    c.advance(5_000);
    expect(breaker.tryAcquire()).toBe(true);
    breaker.succeed();

    expect(breaker.state).toBe('closed');
    expect(breaker.snapshot().lastFailure).toBeNull();
  });

  it('a failed probe restarts the cooldown instead of retrying on every call', () => {
    const c = clock();
    const breaker = new CircuitBreaker('primary', { failureThreshold: 1, openMs: 5_000, now: c.now });

    breaker.fail('http 429');
    c.advance(5_000);
    expect(breaker.tryAcquire()).toBe(true);
    breaker.fail('http 429');

    expect(breaker.state).toBe('open');
    expect(breaker.tryAcquire()).toBe(false);

    c.advance(5_000);
    expect(breaker.state).toBe('half-open');
  });

  it('holds the circuit open until successThreshold probes land', () => {
    const c = clock();
    const breaker = new CircuitBreaker('primary', {
      failureThreshold: 1,
      openMs: 1_000,
      successThreshold: 2,
      now: c.now,
    });

    breaker.fail('down');
    c.advance(1_000);

    expect(breaker.tryAcquire()).toBe(true);
    breaker.succeed();
    expect(breaker.state).toBe('half-open');

    expect(breaker.tryAcquire()).toBe(true);
    breaker.succeed();
    expect(breaker.state).toBe('closed');
  });

  it('a failure between probes resets the run of successes', () => {
    const c = clock();
    const breaker = new CircuitBreaker('primary', {
      failureThreshold: 1,
      openMs: 1_000,
      successThreshold: 2,
      now: c.now,
    });

    breaker.fail('down');
    c.advance(1_000);
    breaker.tryAcquire();
    breaker.succeed();
    breaker.tryAcquire();
    breaker.fail('down again');

    c.advance(1_000);
    breaker.tryAcquire();
    breaker.succeed();
    expect(breaker.state).toBe('half-open');
  });

  it('reports what it knows and can be reset', () => {
    const c = clock();
    const breaker = new CircuitBreaker('fallback', { failureThreshold: 1, now: c.now });

    breaker.fail('HTTP 402 from fallback');
    expect(breaker.snapshot()).toMatchObject({
      name: 'fallback',
      state: 'open',
      consecutiveFailures: 1,
      lastFailure: 'HTTP 402 from fallback',
    });

    breaker.reset();
    expect(breaker.snapshot()).toMatchObject({ state: 'closed', consecutiveFailures: 0, openedAt: null });
  });

  it('refuses nonsense settings at construction', () => {
    expect(() => new CircuitBreaker('x', { failureThreshold: 0 })).toThrow(RangeError);
    expect(() => new CircuitBreaker('x', { openMs: -1 })).toThrow(RangeError);
    expect(() => new CircuitBreaker('x', { successThreshold: 0 })).toThrow(RangeError);
  });
});

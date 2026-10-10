import { describe, expect, it } from 'vitest';

import { ConfigError } from '../src/errors.js';
import { readPrices } from '../src/prices.js';

describe('the price list', () => {
  it('reads entries separated by commas or newlines, in USDG', () => {
    const prices = readPrices('POST /render=0.01\nGET /quote = 0.001, * /v1/*=2');
    expect(prices.routes.map((route) => [route.method, route.path, route.amount.toString()])).toEqual([
      ['POST', '/render', '10000'],
      ['GET', '/quote', '1000'],
      ['*', '/v1/*', '2000000'],
    ]);
  });

  it('matches by method and path, the first entry winning', () => {
    const prices = readPrices('POST /render=0.01, * /v1/*=0.5');
    expect(prices.match('post', '/render')?.amount).toBe(10000n);
    expect(prices.match('GET', '/render')).toBeUndefined();
    expect(prices.match('DELETE', '/v1/anything/here')?.amount).toBe(500000n);
    expect(prices.match('GET', '/v2/x')).toBeUndefined();
    expect(prices.match('POST', '/render/')?.amount).toBe(10000n);
  });

  it('refuses an empty list, a malformed entry and a free route', () => {
    expect(() => readPrices('')).toThrow(ConfigError);
    expect(() => readPrices('render=0.01')).toThrow(/METHOD \/path=price/);
    expect(() => readPrices('POST /render=0')).toThrow(/nothing/);
    expect(() => readPrices('POST /render=0.0000001')).toThrow(ConfigError);
  });
});

import { describe, it, expect } from 'vitest';

// ユーティリティ関数のテスト例
describe('Utility Functions', () => {
  describe('Math Operations', () => {
    it('should add two numbers correctly', () => {
      const add = (a: number, b: number) => a + b;
      expect(add(2, 3)).toBe(5);
      expect(add(-1, 1)).toBe(0);
      expect(add(0, 0)).toBe(0);
    });

    it('should multiply two numbers correctly', () => {
      const multiply = (a: number, b: number) => a * b;
      expect(multiply(2, 3)).toBe(6);
      expect(multiply(-2, 3)).toBe(-6);
      expect(multiply(0, 5)).toBe(0);
    });
  });

  describe('String Operations', () => {
    it('should concatenate strings correctly', () => {
      const concat = (a: string, b: string) => a + b;
      expect(concat('Hello', 'World')).toBe('HelloWorld');
      expect(concat('', 'test')).toBe('test');
      expect(concat('test', '')).toBe('test');
    });

    it('should convert string to uppercase', () => {
      const toUpperCase = (str: string) => str.toUpperCase();
      expect(toUpperCase('hello')).toBe('HELLO');
      expect(toUpperCase('')).toBe('');
      expect(toUpperCase('Test123')).toBe('TEST123');
    });
  });

  describe('Array Operations', () => {
    it('should filter array correctly', () => {
      const filterEven = (arr: number[]) => arr.filter(num => num % 2 === 0);
      expect(filterEven([1, 2, 3, 4, 5, 6])).toEqual([2, 4, 6]);
      expect(filterEven([1, 3, 5])).toEqual([]);
      expect(filterEven([2, 4, 6])).toEqual([2, 4, 6]);
    });

    it('should map array correctly', () => {
      const double = (arr: number[]) => arr.map(num => num * 2);
      expect(double([1, 2, 3])).toEqual([2, 4, 6]);
      expect(double([])).toEqual([]);
      expect(double([0, -1, 5])).toEqual([0, -2, 10]);
    });
  });

  describe('Object Operations', () => {
    it('should merge objects correctly', () => {
      const merge = (obj1: Record<string, any>, obj2: Record<string, any>) => ({ ...obj1, ...obj2 });
      expect(merge({ a: 1 }, { b: 2 })).toEqual({ a: 1, b: 2 });
      expect(merge({}, { test: 'value' })).toEqual({ test: 'value' });
      expect(merge({ key: 'old' }, { key: 'new' })).toEqual({ key: 'new' });
    });
  });
}); 
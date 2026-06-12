export function add(a: number, b: number): number {
  return a + b;
}

export function multiply(a: number, b: number): number {
  return a * b;
}

// e1: 类型错误
export const result: number = add(1, 2);

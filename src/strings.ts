export function upper(s: string): string {
  return s.toUpperCase();
}

// e2: 类型错误（方法不存在）
export function lower(s: string): string {
  return s.toLowerCase();
}

// e3: export 类型标注错误
export const greeting: string = "12345";

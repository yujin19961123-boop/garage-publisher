const pad = (value: number) => String(value).padStart(2, '0');
// Compare local calendar dates, rather than elapsed 24-hour periods (DST safe).
const dayNumber = (date: Date) => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000;

export function exactTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '时间未知';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function relativeTime(value: string, now = Date.now()): string {
  const date = new Date(value), current = new Date(now);
  if (!Number.isFinite(date.getTime()) || !Number.isFinite(now)) return '时间未知';
  const elapsed = now - date.getTime();
  // Allow a minute of clock skew without displaying a negative duration.
  if (elapsed >= -60000 && elapsed < 60000) return '刚刚';
  if (elapsed >= 60000 && elapsed < 3600000) return `${Math.floor(elapsed / 60000)}分钟前`;
  const days = dayNumber(current) - dayNumber(date);
  if (days === 0 && elapsed >= 3600000) return `${Math.floor(elapsed / 3600000)}小时前`;
  if (days > 0 && days < 7) return `${days}天前`;
  const monday = dayNumber(current) - (current.getDay() + 6) % 7;
  if (dayNumber(date) >= monday - 7 && dayNumber(date) < monday) return `上周${'日一二三四五六'[date.getDay()]}`;
  if (date.getFullYear() === current.getFullYear()) return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return `${date.getFullYear()}年${pad(date.getMonth() + 1)}月${pad(date.getDate())}日`;
}

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.ApexFormat = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function formatBytes(n) {
    if (n == null || !Number.isFinite(n)) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = Math.max(0, n);
    let index = 0;
    while (value >= 1024 && index < units.length - 1) {
      value /= 1024;
      index += 1;
    }
    const digits = value >= 100 || index === 0 ? 0 : value >= 10 ? 1 : 2;
    return `${value.toFixed(digits)} ${units[index]}`;
  }

  function formatSpeed(bps) {
    if (!bps || bps < 1) return '0 B/s';
    return `${formatBytes(bps)}/s`;
  }

  function formatDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '—';
    const total = Math.round(seconds);
    if (total < 60) return `${total}s`;
    const minutes = Math.floor(total / 60);
    const secs = total % 60;
    if (minutes < 60) return `${minutes}m ${String(secs).padStart(2, '0')}s`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
  }

  function formatEta(item) {
    if (!item || item.status !== 'downloading' || !item.speed || !item.size) return '—';
    const left = item.size - item.downloaded;
    if (left <= 0) return '—';
    return formatDuration(left / item.speed);
  }

  return { formatBytes, formatSpeed, formatDuration, formatEta };
});

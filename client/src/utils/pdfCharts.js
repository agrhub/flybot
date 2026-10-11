import Chart from 'chart.js/auto';

// Chart colors for printed pages (white paper, independent of the light/dark theme)
export const PRINT = {
  text: '#4b5563',
  grid: '#e5e7eb',
  series: ['#10b981', '#f59e0b', '#ef4444', '#64748b', '#3b82f6', '#8b5cf6', '#ec4899', '#14b8a6'],
};

/**
 * Draw a Chart.js config off screen and return it as a PNG data URL (for PDFs).
 * Animations and responsiveness are turned off and axis/legend colors suit white paper.
 */
export async function chartImage(config, { width = 1000, height = 420 } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.style.position = 'fixed';
  canvas.style.left = '-10000px';
  document.body.appendChild(canvas);
  const options = config.options || {};
  const scales = Object.fromEntries(Object.entries(options.scales || {}).map(([key, scale]) => [key, {
    ...scale,
    ticks: { ...(scale.ticks || {}), color: PRINT.text },
    grid: { ...(scale.grid || {}), color: PRINT.grid },
    title: scale.title ? { ...scale.title, color: PRINT.text } : undefined,
  }]));
  const chart = new Chart(canvas, {
    ...config,
    options: {
      ...options,
      responsive: false,
      animation: false,
      devicePixelRatio: 1,
      scales,
      plugins: {
        ...(options.plugins || {}),
        legend: { ...(options.plugins?.legend || {}), labels: { ...(options.plugins?.legend?.labels || {}), color: PRINT.text } },
      },
    },
  });
  // White background under the chart
  const out = document.createElement('canvas');
  out.width = width;
  out.height = height;
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(canvas, 0, 0);
  chart.destroy();
  canvas.remove();
  return out.toDataURL('image/png');
}

function getColorForPlayer(playerIdentity) {
  let hash = 0;
  for (let i = 0; i < playerIdentity.length; i++) {
    const char = playerIdentity.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }

  const colors = [
    "#fbbf24",
    "#10b981",
    "#3b82f6",
    "#f87171",
    "#a78bfa",
    "#ec4899",
    "#14b8a6",
    "#f97316",
  ];

  return colors[Math.abs(hash) % colors.length];
}

export function buildPlayerIcon(L, headingDeg, color = "#fbbf24", size = 24) {
  return L.divIcon({
    className: "player-marker",
    html: `<svg width="${size}" height="${size}" viewBox="0 0 24 24" style="filter:drop-shadow(0 2px 4px rgba(0,0,0,0.5))"><path transform="rotate(${headingDeg} 12 12)" d="M12 2 L19 21 L12 15 L5 21 Z" fill="${color}" stroke="#000" stroke-width="1.5" stroke-linejoin="round"/></svg>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

export function buildPopupHtml({
  playerName,
  telemetry,
  speedValue,
  speedLabel,
}) {
  const tel = telemetry || {};
  const val = speedValue ?? Math.round(Number(tel.speedMph ?? 0));
  const label = speedLabel || "mph";
  const classText = tel.carClassLabel || "N/A";
  const pi = Number.isFinite(Number(tel.carPerformanceIndex))
    ? Number(tel.carPerformanceIndex)
    : "N/A";
  return `
    <div style="font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#111">
      <div style="font-size:12px;text-transform:uppercase;letter-spacing:0.08em;color:#666;margin-bottom:4px">${playerName || "Anonymous"}</div>
      <div style="font-weight:700;font-size:16px;margin-bottom:6px">${tel.carName || "Unknown Car"}</div>
      <div style="font-size:14px"><strong>Speed:</strong> ${val} ${label}</div>
      <div style="font-size:14px"><strong>Class:</strong> ${classText} | ${pi}</div>
    </div>
  `;
}

export { getColorForPlayer };

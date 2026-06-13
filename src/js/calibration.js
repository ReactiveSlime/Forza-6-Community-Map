function toPointPair(value) {
  if (!Array.isArray(value) || value.length < 2) return null;
  const x = Number(value[0]);
  const y = Number(value[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return [x, y];
}

export function normalizeCalibration(raw) {
  if (!raw || typeof raw !== "object") return null;

  const calAWorld = toPointPair(raw.calAWorld);
  const calAPix = toPointPair(raw.calAPix);
  const calBWorld = toPointPair(raw.calBWorld);
  const calBPix = toPointPair(raw.calBPix);
  const calCWorld = toPointPair(raw.calCWorld);
  const calCPix = toPointPair(raw.calCPix);

  if (
    !calAWorld ||
    !calAPix ||
    !calBWorld ||
    !calBPix ||
    !calCWorld ||
    !calCPix
  )
    return null;

  return { calAWorld, calAPix, calBWorld, calBPix, calCWorld, calCPix };
}

export function buildCalibrationTransform(raw) {
  const calibration = normalizeCalibration(raw);
  if (!calibration) return null;

  const wxA = calibration.calAWorld[0];
  const wzA = calibration.calAWorld[1];
  const pxA = calibration.calAPix[0];
  const pyA = calibration.calAPix[1];
  const wxB = calibration.calBWorld[0];
  const wzB = calibration.calBWorld[1];
  const pxB = calibration.calBPix[0];
  const pyB = calibration.calBPix[1];
  const wxC = calibration.calCWorld[0];
  const wzC = calibration.calCWorld[1];
  const pxC = calibration.calCPix[0];
  const pyC = calibration.calCPix[1];

  const denom = wxA * (wzB - wzC) - wzA * (wxB - wxC) + (wxB * wzC - wxC * wzB);
  if (Math.abs(denom) < 1e-6) return null;

  const a = ((pxB - pxA) * (wzC - wzA) - (pxC - pxA) * (wzB - wzA)) / denom;
  const b = ((pxC - pxA) * (wxB - wxA) - (pxB - pxA) * (wxC - wxA)) / denom;
  const e = pxA - a * wxA - b * wzA;
  const c = ((pyB - pyA) * (wzC - wzA) - (pyC - pyA) * (wzB - wzA)) / denom;
  const d = ((pyC - pyA) * (wxB - wxA) - (pyB - pyA) * (wxC - wxA)) / denom;
  const f = pyA - c * wxA - d * wzA;

  if (
    !Number.isFinite(a) ||
    !Number.isFinite(b) ||
    !Number.isFinite(c) ||
    !Number.isFinite(d) ||
    !Number.isFinite(e) ||
    !Number.isFinite(f)
  )
    return null;

  return {
    ...calibration,
    a,
    b,
    c,
    d,
    e,
    f,
    worldToPixel(worldX, worldZ) {
      return { x: a * worldX + b * worldZ + e, y: c * worldX + d * worldZ + f };
    },
  };
}

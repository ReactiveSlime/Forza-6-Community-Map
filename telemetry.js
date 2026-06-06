import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CAR_CLASS_LABELS = ['D', 'C', 'B', 'A', 'S1', 'S2', 'R', 'X'];

let carOrdinalMap = null;

function loadCarOrdinalMap() {
  if (carOrdinalMap) return carOrdinalMap;

  const map = {};
  const candidateFiles = [
    path.resolve(__dirname, 'src', 'static', 'car-ordinals.json'),
    path.resolve(__dirname, 'src', 'static', 'fh6-car-ordinals.json'),
  ];

  for (const filePath of candidateFiles) {
    if (!existsSync(filePath)) continue;
    try {
      Object.assign(map, JSON.parse(readFileSync(filePath, 'utf8')));
    } catch (error) {
      console.warn(`Unable to load car ordinal map from ${filePath}:`, error);
    }
  }

  carOrdinalMap = map;
  return carOrdinalMap;
}

function carName(ordinal) {
  const map = loadCarOrdinalMap();
  return map[String(ordinal)] ?? `Car #${ordinal}`;
}

function carClassLabel(carClass) {
  return CAR_CLASS_LABELS[carClass] ?? `Class ${carClass}`;
}

function formatGear(gear) {
  if (gear === 0) return 'R';
  if (gear === 11) return 'N';
  return String(gear);
}

export function readTelemetryPacket(buffer) {
  if (buffer.length < 324) {
    throw new Error(`packet too short: ${buffer.length} bytes (need >= 324)`);
  }

  const readF32 = (offset) => buffer.readFloatLE(offset);
  const readS32 = (offset) => buffer.readInt32LE(offset);
  const readU32 = (offset) => buffer.readUInt32LE(offset);
  const readU16 = (offset) => buffer.readUInt16LE(offset);
  const readU8 = (offset) => buffer.readUInt8(offset);
  const readS8 = (offset) => buffer.readInt8(offset);

  const telemetry = {
    isRaceOn: readS32(0),
    timestampMS: readU32(4),

    engineMaxRpm: readF32(8),
    engineIdleRpm: readF32(12),
    currentEngineRpm: readF32(16),

    accelerationX: readF32(20),
    accelerationY: readF32(24),
    accelerationZ: readF32(28),

    velocityX: readF32(32),
    velocityY: readF32(36),
    velocityZ: readF32(40),

    angularVelocityX: readF32(44),
    angularVelocityY: readF32(48),
    angularVelocityZ: readF32(52),

    yaw: readF32(56),
    pitch: readF32(60),
    roll: readF32(64),

    normalizedSuspensionTravelFrontLeft: readF32(68),
    normalizedSuspensionTravelFrontRight: readF32(72),
    normalizedSuspensionTravelRearLeft: readF32(76),
    normalizedSuspensionTravelRearRight: readF32(80),

    tireSlipRatioFrontLeft: readF32(84),
    tireSlipRatioFrontRight: readF32(88),
    tireSlipRatioRearLeft: readF32(92),
    tireSlipRatioRearRight: readF32(96),

    wheelRotationSpeedFrontLeft: readF32(100),
    wheelRotationSpeedFrontRight: readF32(104),
    wheelRotationSpeedRearLeft: readF32(108),
    wheelRotationSpeedRearRight: readF32(112),

    wheelOnRumbleStripFrontLeft: readS32(116),
    wheelOnRumbleStripFrontRight: readS32(120),
    wheelOnRumbleStripRearLeft: readS32(124),
    wheelOnRumbleStripRearRight: readS32(128),

    wheelInPuddleFrontLeft: readS32(132),
    wheelInPuddleFrontRight: readS32(136),
    wheelInPuddleRearLeft: readS32(140),
    wheelInPuddleRearRight: readS32(144),

    surfaceRumbleFrontLeft: readF32(148),
    surfaceRumbleFrontRight: readF32(152),
    surfaceRumbleRearLeft: readF32(156),
    surfaceRumbleRearRight: readF32(160),

    tireSlipAngleFrontLeft: readF32(164),
    tireSlipAngleFrontRight: readF32(168),
    tireSlipAngleRearLeft: readF32(172),
    tireSlipAngleRearRight: readF32(176),

    tireCombinedSlipFrontLeft: readF32(180),
    tireCombinedSlipFrontRight: readF32(184),
    tireCombinedSlipRearLeft: readF32(188),
    tireCombinedSlipRearRight: readF32(192),

    suspensionTravelMetersFrontLeft: readF32(196),
    suspensionTravelMetersFrontRight: readF32(200),
    suspensionTravelMetersRearLeft: readF32(204),
    suspensionTravelMetersRearRight: readF32(208),

    carOrdinal: readS32(212),
    carClass: readS32(216),
    carPerformanceIndex: readS32(220),
    drivetrainType: readS32(224),
    numCylinders: readS32(228),
    carGroup: readU32(232),
    smashableVelDiff: readF32(236),
    smashableMass: readF32(240),

    positionX: readF32(244),
    positionY: readF32(248),
    positionZ: readF32(252),
    speedMs: readF32(256),

    power: readF32(260),
    torque: readF32(264),
    tireTempFrontLeft: readF32(268),
    tireTempFrontRight: readF32(272),
    tireTempRearLeft: readF32(276),
    tireTempRearRight: readF32(280),
    boost: readF32(284),
    fuel: readF32(288),
    distanceTraveled: readF32(292),

    bestLap: readF32(296),
    lastLap: readF32(300),
    currentLap: readF32(304),
    currentRaceTime: readF32(308),
    lapNumber: readU16(312),

    racePosition: readU8(314),
    accelInput: readU8(315),
    brakeInput: readU8(316),
    clutchInput: readU8(317),
    handBrake: readU8(318),

    gear: readU8(319),
    steer: readS8(320),
    normalizedDrivingLine: readS8(321),
    normalizedAIBrakeDifference: readS8(322),
  };

  telemetry.speedMph = telemetry.speedMs * 2.23694;
  telemetry.speedKph = telemetry.speedMs * 3.6;
  telemetry.rpmPercent = telemetry.engineMaxRpm > 0
    ? (telemetry.currentEngineRpm / telemetry.engineMaxRpm) * 100
    : 0;
  telemetry.carName = carName(telemetry.carOrdinal);
  telemetry.carClassLabel = carClassLabel(telemetry.carClass);
  telemetry.gearLabel = formatGear(telemetry.gear);

  return telemetry;
}

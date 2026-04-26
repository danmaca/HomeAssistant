// ============================================================================
// CoverAutomation.js
// Node-RED Function Node: Řízení náklonu exteriérových žaluzií
// Exterior Venetian Blind Tilt Control based on Sun Position & Indoor Temperature
// ============================================================================
//
// POPIS / DESCRIPTION:
// Tento skript řídí náklon lamel exteriérových žaluzií na základě aktuální
// polohy slunce (elevace, azimut) a vnitřní teploty. Cílem je automaticky
// blokovat přímé sluneční záření, když je to potřeba, a zároveň umožnit
// přirozené osvětlení a solární zisky, když je to žádoucí.
//
// This script controls exterior venetian blind tilt based on current sun
// position (elevation, azimuth) and indoor temperature. The goal is to
// automatically block direct sunlight when needed while allowing natural
// light and solar heat gain when desirable.
//
// SPOUŠTĚNÍ / TRIGGERING:
// Tento skript by měl být spouštěn každých 5 minut (inject node s intervalem)
// nebo při změně stavu entity sun.sun (state change node).
// This script should be triggered every 5 minutes (inject node with interval)
// or on sun.sun state change (state change node).
//
// VÝSTUP / OUTPUT:
// Výstup se připojuje na "call service" node v Node-RED nakonfigurovaný na
// službu cover.set_cover_tilt_position.
// Output should connect to a "call service" node in Node-RED configured
// for cover.set_cover_tilt_position service.
//
// KONVENCE TILT_POSITION / TILT_POSITION CONVENTION:
// Většina integrací Home Assistant pro žaluzie používá:
//   tilt_position = 0   -> lamely zavřené (closed / vertical)
//   tilt_position = 100 -> lamely otevřené (open / horizontal)
// Pokud váš systém používá opačnou konvenci (0=open, 100=closed),
// prohoďte hodnoty TILT_CLOSED a TILT_OPEN v konfiguraci níže.
//
// Most Home Assistant cover integrations use:
//   tilt_position = 0   -> slats closed (vertical)
//   tilt_position = 100 -> slats open (horizontal)
// If your system uses the opposite convention (0=open, 100=closed),
// swap TILT_CLOSED and TILT_OPEN values in the configuration below.
//
// KONCEPT PROFILOVÉHO ÚHLU / PROFILE ANGLE CONCEPT:
// Profilový úhel je efektivní úhel slunečních paprsků promítnutý do
// vertikální roviny kolmé na okno. Tento úhel určuje, jak moc je třeba
// naklonit lamely, aby blokovaly přímé sluneční záření. Je vypočten jako:
//   profileAngle = atan(tan(elevation) / cos(deltaAzimuth))
// kde deltaAzimuth je rozdíl mezi azimutem slunce a orientací okna.
//
// The profile angle is the effective angle of sun rays projected onto the
// vertical plane perpendicular to the window. This angle determines how
// much the slats need to tilt to block direct sunlight. Calculated as:
//   profileAngle = atan(tan(elevation) / cos(deltaAzimuth))
// where deltaAzimuth is the difference between sun azimuth and window facing.
// ============================================================================

// ============================================================================
// KONFIGURACE / CONFIGURATION
// Všechny nastavitelné konstanty jsou seskupeny zde pro snadnou úpravu.
// All configurable constants are grouped here for easy adjustment.
// ============================================================================
const CONFIG = {
  // --- Okno / Window ---
  // Azimut okna ve stupních od severu (po směru hodinových ručiček)
  // Window azimuth in degrees from North (clockwise)
  // 0=Sever/North, 90=Východ/East, 180=Jih/South, 270=Západ/West
  WINDOW_AZIMUTH: 90, // Východní okno / East-facing window

  // Poloviční zorné pole okna ve stupních
  // Half-angle field of view of the window in degrees
  // Slunce mimo tento úhel od osy okna nemůže přímo svítit dovnitř
  // Sun beyond this angle from window normal cannot directly shine in
  WINDOW_FOV: 80,

  // --- Lokace / Location ---
  // Praha, Česká republika (pouze pro referenci, data slunce přichází z HA)
  // Prague, Czech Republic (for reference only, sun data comes from HA)
  // Lat: 50.0755° N, Lon: 14.4378° E

  // --- Entity IDs ---
  // Entita slunce v Home Assistant (standardní)
  // Sun entity in Home Assistant (standard)
  SUN_ENTITY: "sun.sun",

  // Teplotní senzor / Temperature sensor
  TEMP_SENSOR: "sensor.workroom_thermometer_temperature",

  // Entita žaluzií / Blind entity
  BLIND_ENTITY: "cover.workroom_blinds",

  // --- Mapování náklonu / Tilt mapping ---
  // Hodnota tilt_position pro zavřené lamely (vertikální)
  // tilt_position value for closed slats (vertical)
  TILT_CLOSED: 0,

  // Hodnota tilt_position pro otevřené lamely (horizontální)
  // tilt_position value for open slats (horizontal)
  TILT_OPEN: 100,

  // --- Prahové hodnoty / Thresholds ---
  // Minimální elevace slunce pro aktivaci (stupně)
  // Minimum sun elevation for activation (degrees)
  MIN_ELEVATION: 2,

  // Přídavný úhel náklonu pro jistotu blokování (stupně)
  // Additional tilt margin to ensure blocking (degrees)
  TILT_MARGIN: 5,

  // Minimální krok změny náklonu (procenta)
  // Minimum step size for tilt changes (percentage)
  MIN_STEP: 5,

  // Minimální změna pro odeslání nového příkazu (hystereze, procenta)
  // Minimum change to send a new command (hysteresis, percentage)
  HYSTERESIS: 5,

  // --- Teplotní prahy / Temperature thresholds ---
  // Úpravy požadovaného úhlu podle vnitřní teploty
  // Required angle adjustments based on indoor temperature
  TEMP_THRESHOLDS: {
    COOL_MAX: 22, // Pod touto teplotou: povolit solární zisky / Below: allow solar gain
    COMFORT_MAX: 24, // Komfortní zóna: žádná úprava / Comfort zone: no adjustment
    WARM_MAX: 26, // Teplé: zvýšit blokování / Warm: increase blocking
    HOT_MAX: 30, // Horké: výrazně zvýšit blokování / Hot: significantly increase blocking
  },

  // Úpravy úhlu pro jednotlivé teplotní zóny (stupně)
  // Angle adjustments for each temperature zone (degrees)
  TEMP_ADJUSTMENTS: {
    COOL: -5, // Snížit úhel (povolit sluneční teplo) / Reduce angle (allow solar heat)
    COMFORT: 0, // Žádná úprava / No adjustment
    WARM: 8, // Zvýšit úhel (více blokovat) / Increase angle (block more)
    HOT: 15, // Výrazně zvýšit / Significantly increase
    VERY_HOT: 20, // Maximální blokování / Maximum blocking
  },
};

// ============================================================================
// POMOCNÉ FUNKCE / HELPER FUNCTIONS
// ============================================================================

/**
 * Normalizuje úhel do rozsahu [-180, 180] stupňů.
 * Normalizes an angle to the range [-180, 180] degrees.
 *
 * @param {number} angle - Úhel ve stupních / Angle in degrees
 * @returns {number} Normalizovaný úhel / Normalized angle
 */
function normalizeAngle(angle) {
  // Zajistíme, že úhel je v rozsahu [-180, 180]
  // Ensure the angle is in the range [-180, 180]
  let normalized = angle % 360;
  if (normalized > 180) {
    normalized -= 360;
  } else if (normalized < -180) {
    normalized += 360;
  }
  return normalized;
}

/**
 * Omezí hodnotu do zadaného rozsahu.
 * Clamps a value to the specified range.
 *
 * @param {number} value - Hodnota k omezení / Value to clamp
 * @param {number} min - Minimální hodnota / Minimum value
 * @param {number} max - Maximální hodnota / Maximum value
 * @returns {number} Omezená hodnota / Clamped value
 */
function clamp(value, min, max) {
  if (isNaN(value)) return min; // Bezpečná hodnota při NaN / Safe fallback for NaN
  return Math.min(Math.max(value, min), max);
}

/**
 * Zaokrouhlí hodnotu na nejbližší násobek kroku.
 * Rounds a value to the nearest multiple of step.
 *
 * @param {number} value - Hodnota k zaokrouhlení / Value to round
 * @param {number} step - Velikost kroku / Step size
 * @returns {number} Zaokrouhlená hodnota / Rounded value
 */
function roundToStep(value, step) {
  if (isNaN(value) || step <= 0) return 0;
  return Math.round(value / step) * step;
}

/**
 * Převod stupňů na radiány.
 * Convert degrees to radians.
 *
 * @param {number} degrees - Úhel ve stupních / Angle in degrees
 * @returns {number} Úhel v radiánech / Angle in radians
 */
function degreesToRadians(degrees) {
  return degrees * (Math.PI / 180);
}

/**
 * Převod radiánů na stupně.
 * Convert radians to degrees.
 *
 * @param {number} radians - Úhel v radiánech / Angle in radians
 * @returns {number} Úhel ve stupních / Angle in degrees
 */
function radiansToDegrees(radians) {
  return radians * (180 / Math.PI);
}

/**
 * Vypočítá profilový úhel slunce vzhledem k oknu.
 * Calculates the profile angle of the sun relative to the window.
 *
 * Profilový úhel je projekce slunečních paprsků do vertikální roviny
 * kolmé na povrch okna. Tento úhel přímo určuje potřebný náklon lamel.
 *
 * The profile angle is the projection of sun rays onto the vertical plane
 * perpendicular to the window surface. This angle directly determines
 * the required slat tilt.
 *
 * Vzorec / Formula:
 *   profileAngle = atan(tan(elevation) / cos(deltaAzimuth))
 *
 * @param {number} sunElevation - Elevace slunce ve stupních / Sun elevation in degrees
 * @param {number} deltaAzimuth - Rozdíl azimutů ve stupních / Azimuth difference in degrees
 * @returns {number} Profilový úhel ve stupních / Profile angle in degrees
 */
function calculateProfileAngle(sunElevation, deltaAzimuth) {
  // Převod na radiány pro trigonometrické výpočty
  // Convert to radians for trigonometric calculations
  const elevRad = degreesToRadians(sunElevation);
  const deltaAzRad = degreesToRadians(deltaAzimuth);

  // Ochrana proti dělení nulou / cos(90°) = 0
  // Protection against division by zero / cos(90°) = 0
  const cosDA = Math.cos(deltaAzRad);
  if (Math.abs(cosDA) < 0.001) {
    // Slunce je téměř rovnoběžně s oknem, profilový úhel se blíží 90°
    // Sun is almost parallel to window, profile angle approaches 90°
    return 90;
  }

  // Výpočet profilového úhlu
  // Calculate profile angle
  const profileRad = Math.atan(Math.tan(elevRad) / cosDA);
  const profileDeg = radiansToDegrees(profileRad);

  // Profilový úhel by měl být kladný (slunce je nad horizontem)
  // Profile angle should be positive (sun is above horizon)
  return Math.max(0, profileDeg);
}

/**
 * Získá teplotní úpravu úhlu na základě vnitřní teploty.
 * Gets the temperature-based angle adjustment based on indoor temperature.
 *
 * @param {number|null} temperature - Vnitřní teplota v °C / Indoor temperature in °C
 * @returns {{adjustment: number, zone: string}} Úprava a název zóny / Adjustment and zone name
 */
function getTemperatureAdjustment(temperature) {
  // Pokud teplota není dostupná, neupravujeme
  // If temperature is not available, no adjustment
  if (temperature === null || temperature === undefined || isNaN(temperature)) {
    return {
      adjustment: 0,
      zone: "unknown (senzor nedostupný / sensor unavailable)",
    };
  }

  const t = CONFIG.TEMP_THRESHOLDS;
  const a = CONFIG.TEMP_ADJUSTMENTS;

  if (temperature < t.COOL_MAX) {
    // Pod 22°C: chladné, povolit solární zisky (snížit náklon)
    // Below 22°C: cool, allow solar heat gain (reduce tilt)
    return { adjustment: a.COOL, zone: `cool / chladné (< ${t.COOL_MAX}°C)` };
  } else if (temperature < t.COMFORT_MAX) {
    // 22-24°C: komfortní zóna, žádná úprava
    // 22-24°C: comfort zone, no adjustment
    return {
      adjustment: a.COMFORT,
      zone: `comfort / komfort (${t.COOL_MAX}-${t.COMFORT_MAX}°C)`,
    };
  } else if (temperature < t.WARM_MAX) {
    // 24-26°C: teplo, zvýšit blokování
    // 24-26°C: warm, increase blocking
    return {
      adjustment: a.WARM,
      zone: `warm / teplé (${t.COMFORT_MAX}-${t.WARM_MAX}°C)`,
    };
  } else if (temperature < t.HOT_MAX) {
    // 26-30°C: horko, výrazně zvýšit blokování
    // 26-30°C: hot, significantly increase blocking
    return {
      adjustment: a.HOT,
      zone: `hot / horké (${t.WARM_MAX}-${t.HOT_MAX}°C)`,
    };
  } else {
    // Nad 30°C: velmi horko, maximální blokování
    // Above 30°C: very hot, maximum blocking
    return {
      adjustment: a.VERY_HOT,
      zone: `very hot / velmi horké (> ${t.HOT_MAX}°C)`,
    };
  }
}

// ============================================================================
// HLAVNÍ LOGIKA / MAIN LOGIC
// ============================================================================

// --- 1. Získání dat z Home Assistant / Get data from Home Assistant ---
// Přístup ke stavům HA přes globální kontext Node-RED
// Access HA states through Node-RED global context
const haStates = global.get("homeassistant").homeAssistant.states;

// --- Získání dat entity slunce / Get sun entity data ---
const sunEntity = haStates[CONFIG.SUN_ENTITY];

if (!sunEntity || !sunEntity.attributes) {
  // Entita slunce nenalezena – nemůžeme pokračovat
  // Sun entity not found – cannot proceed
  node.warn(
    `CoverAutomation: Entita slunce '${CONFIG.SUN_ENTITY}' nenalezena! ` +
      `/ Sun entity '${CONFIG.SUN_ENTITY}' not found!`,
  );
  node.status({
    fill: "red",
    shape: "ring",
    text: `Chyba: sun entity nenalezena / Error: sun entity not found`,
  });
  return null;
}

const sunElevation = parseFloat(sunEntity.attributes.elevation);
const sunAzimuth = parseFloat(sunEntity.attributes.azimuth);

// Ověření platnosti dat slunce / Validate sun data
if (isNaN(sunElevation) || isNaN(sunAzimuth)) {
  node.warn(
    `CoverAutomation: Neplatná data slunce – elevation: ${sunEntity.attributes.elevation}, ` +
      `azimuth: ${sunEntity.attributes.azimuth} / Invalid sun data`,
  );
  node.status({
    fill: "red",
    shape: "ring",
    text: `Chyba: neplatná data slunce / Error: invalid sun data`,
  });
  return null;
}

// --- Získání vnitřní teploty / Get indoor temperature ---
const tempEntity = haStates[CONFIG.TEMP_SENSOR];
let indoorTemp = null;

if (
  tempEntity &&
  tempEntity.state !== undefined &&
  tempEntity.state !== "unavailable" &&
  tempEntity.state !== "unknown"
) {
  indoorTemp = parseFloat(tempEntity.state);
  if (isNaN(indoorTemp)) {
    // Teplota má neplatnou hodnotu, pokračujeme bez úprav
    // Temperature has invalid value, continue without adjustments
    node.warn(
      `CoverAutomation: Neplatná teplota ze senzoru '${CONFIG.TEMP_SENSOR}': '${tempEntity.state}' ` +
        `/ Invalid temperature from sensor – continuing without temp adjustments`,
    );
    indoorTemp = null;
  }
} else {
  // Teplotní senzor nenalezen, pokračujeme bez teplotních úprav
  // Temperature sensor not found, continue without temperature adjustments
  node.warn(
    `CoverAutomation: Teplotní senzor '${CONFIG.TEMP_SENSOR}' nenalezen nebo nedostupný ` +
      `/ Temperature sensor not found or unavailable – continuing without temp adjustments`,
  );
}

// --- 2. Kontrola, zda je slunce relevantní / Check if sun is relevant ---
// Výpočet rozdílu azimutu mezi sluncem a oknem
// Calculate azimuth difference between sun and window
const deltaAzimuth = normalizeAngle(sunAzimuth - CONFIG.WINDOW_AZIMUTH);
const absDeltaAzimuth = Math.abs(deltaAzimuth);

// Je slunce nad horizontem? / Is the sun above the horizon?
const isSunAboveHorizon = sunElevation > CONFIG.MIN_ELEVATION;

// Svítí slunce na okno? (je v zorném poli okna?)
// Is the sun shining on the window? (within window field of view?)
const isSunFacingWindow = absDeltaAzimuth < CONFIG.WINDOW_FOV;

// Celkově: je slunce relevantní pro naše okno?
// Overall: is the sun relevant for our window?
const isSunRelevant = isSunAboveHorizon && isSunFacingWindow;

let tiltPosition;
let reason;
let requiredAngle = 0;
let profileAngle = 0;

if (!isSunRelevant) {
  // --- Slunce nesvítí na okno -> plně otevřít lamely ---
  // --- Sun is not shining on the window -> fully open slats ---

  tiltPosition = CONFIG.TILT_OPEN;

  if (!isSunAboveHorizon) {
    reason =
      `Slunce pod horizontem (elevace ${sunElevation.toFixed(1)}° < ${CONFIG.MIN_ELEVATION}°) ` +
      `/ Sun below horizon – fully open`;
  } else {
    reason =
      `Slunce mimo okno (deltaAz ${deltaAzimuth.toFixed(1)}°, FOV ±${CONFIG.WINDOW_FOV}°) ` +
      `/ Sun not facing window – fully open`;
  }
} else {
  // --- Slunce svítí na okno -> vypočítat potřebný náklon ---
  // --- Sun is shining on the window -> calculate required tilt ---

  // --- 3. Výpočet profilového úhlu / Calculate profile angle ---
  profileAngle = calculateProfileAngle(sunElevation, deltaAzimuth);

  // --- 4. Výpočet požadovaného úhlu náklonu / Calculate required tilt angle ---
  // Základní úhel = profilový úhel + bezpečnostní marže
  // Base angle = profile angle + safety margin
  requiredAngle = profileAngle + CONFIG.TILT_MARGIN;

  // --- Změkčení na okrajích zorného pole / Edge softening at FOV limits ---
  // Když se slunce blíží k hranici zorného pole okna, snižujeme intenzitu
  // blokování pomocí cos(deltaAzimuth). To zajistí hladký přechod místo
  // skokové změny na hranici FOV.
  //
  // When the sun approaches the edge of the window FOV, we reduce blocking
  // intensity using cos(deltaAzimuth). This ensures a smooth transition
  // instead of an abrupt change at the FOV boundary.
  const edgeFactor = Math.cos(degreesToRadians(deltaAzimuth));
  requiredAngle = requiredAngle * clamp(edgeFactor, 0, 1);

  // --- Teplotní úpravy / Temperature adjustments ---
  const tempResult = getTemperatureAdjustment(indoorTemp);
  requiredAngle += tempResult.adjustment;

  // --- Omezení na platný rozsah [0, 90] / Clamp to valid range [0, 90] ---
  requiredAngle = clamp(requiredAngle, 0, 90);

  // --- 5. Mapování na tilt_position (0-100) / Map to tilt_position (0-100) ---
  // requiredAngle 0° (horizontální/otevřené) -> TILT_OPEN
  // requiredAngle 90° (vertikální/zavřené) -> TILT_CLOSED
  //
  // Vzorec / Formula:
  // tiltPosition = TILT_OPEN - (requiredAngle / 90) * (TILT_OPEN - TILT_CLOSED)
  tiltPosition =
    CONFIG.TILT_OPEN -
    (requiredAngle / 90) * (CONFIG.TILT_OPEN - CONFIG.TILT_CLOSED);

  reason =
    `Slunce aktivní (profil ${profileAngle.toFixed(1)}°, teplota: ${tempResult.zone}) ` +
    `/ Sun active – blocking`;
}

// --- 6. Zaokrouhlení na minimální krok / Round to minimum step ---
tiltPosition = roundToStep(tiltPosition, CONFIG.MIN_STEP);

// Finální omezení na rozsah [TILT_CLOSED, TILT_OPEN]
// Final clamp to range [TILT_CLOSED, TILT_OPEN]
tiltPosition = clamp(
  tiltPosition,
  Math.min(CONFIG.TILT_CLOSED, CONFIG.TILT_OPEN),
  Math.max(CONFIG.TILT_CLOSED, CONFIG.TILT_OPEN),
);

// --- 7. Hystereze – kontrola minimální změny / Hysteresis – check minimum change ---
// Použijeme flow kontext pro uložení předchozí hodnoty
// Use flow context to store the previous value
const previousTilt = flow.get("blindTiltPrevious");
const tiltChange =
  previousTilt !== undefined && previousTilt !== null
    ? Math.abs(tiltPosition - previousTilt)
    : CONFIG.HYSTERESIS + 1; // První spuštění: vždy odeslat / First run: always send

if (tiltChange < CONFIG.HYSTERESIS) {
  // Změna je příliš malá, neprovádíme akci
  // Change is too small, no action needed
  const statusText =
    `Beze změny: ${previousTilt}% (Δ${tiltChange.toFixed(0)}% < ${CONFIG.HYSTERESIS}%) | ` +
    `El: ${sunElevation.toFixed(1)}° Az: ${sunAzimuth.toFixed(1)}°`;

  node.status({
    fill: "grey",
    shape: "ring",
    text: statusText,
  });

  // Vracíme null – žádný výstup z funkce (zastaví tok zpráv)
  // Return null – no output from function (stops message flow)
  return null;
}

// --- Uložení nové hodnoty pro příští porovnání / Save new value for next comparison ---
flow.set("blindTiltPrevious", tiltPosition);

// --- 8. Sestavení výstupní zprávy / Build output message ---
msg.payload = {
  data: {
    entity_id: CONFIG.BLIND_ENTITY,
    tilt_position: tiltPosition,
  },
};

// --- Ladící informace / Debug information ---
// Přiložíme kompletní diagnostická data pro ladění a monitoring
// Attach complete diagnostic data for debugging and monitoring
msg.debug = {
  // Vstupní data / Input data
  sunElevation: sunElevation,
  sunAzimuth: sunAzimuth,
  indoorTemp: indoorTemp,

  // Vypočtené hodnoty / Calculated values
  deltaAzimuth: parseFloat(deltaAzimuth.toFixed(2)),
  absDeltaAzimuth: parseFloat(absDeltaAzimuth.toFixed(2)),
  profileAngle: parseFloat(profileAngle.toFixed(2)),
  requiredAngle: parseFloat(requiredAngle.toFixed(2)),

  // Stavy / States
  isSunAboveHorizon: isSunAboveHorizon,
  isSunFacingWindow: isSunFacingWindow,
  isSunRelevant: isSunRelevant,

  // Výstup / Output
  tiltPosition: tiltPosition,
  previousTilt:
    previousTilt !== undefined && previousTilt !== null
      ? previousTilt
      : "N/A (první spuštění / first run)",
  tiltChange: parseFloat(tiltChange.toFixed(1)),

  // Metadata
  reason: reason,
  timestamp: new Date().toISOString(),

  // Konfigurace (pro referenci) / Configuration (for reference)
  config: {
    windowAzimuth: CONFIG.WINDOW_AZIMUTH,
    windowFOV: CONFIG.WINDOW_FOV,
    blindEntity: CONFIG.BLIND_ENTITY,
    tempSensor: CONFIG.TEMP_SENSOR,
  },
};

// --- 9. Stavový indikátor uzlu / Node status indicator ---
// Žlutá: slunce aktivně svítí na okno / Yellow: sun is actively shining on window
// Zelená: slunce nesvítí na okno / Green: sun is not shining on window
const statusFill = isSunRelevant ? "yellow" : "green";
const statusText =
  `Tilt: ${tiltPosition}% | ` +
  `El: ${sunElevation.toFixed(1)}° Az: ${sunAzimuth.toFixed(1)}° | ` +
  (indoorTemp !== null ? `${indoorTemp.toFixed(1)}°C | ` : "") +
  (isSunRelevant ? `Profil: ${profileAngle.toFixed(1)}°` : `Otevřeno / Open`);

node.status({
  fill: statusFill,
  shape: "dot",
  text: statusText,
});

// --- 10. Odeslání zprávy na výstup / Send message to output ---
return msg;

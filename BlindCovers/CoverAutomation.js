// ============================================================================
// CoverAutomation.js
// Node-RED Function Node: Řízení náklonu exteriérových žaluzií
// ============================================================================
//
// POPIS:
// Tento skript řídí náklon lamel exteriérových žaluzií na základě aktuální
// polohy slunce (elevace, azimut) a vnitřní teploty. Cílem je automaticky
// blokovat přímé sluneční záření, když je to potřeba, a zároveň umožnit
// přirozené osvětlení a solární zisky, když je to žádoucí.
//
// SPOUŠTĚNÍ:
// Tento skript by měl být spouštěn každých 5 minut (inject node s intervalem)
// nebo při změně stavu entity sun.sun (state change node).
//
// VÝSTUP:
// Výstup se připojuje na "call service" node v Node-RED nakonfigurovaný na
// službu cover.set_cover_tilt_position.
//
// KONVENCE TILT_POSITION:
// Většina integrací Home Assistant pro žaluzie používá:
//   tilt_position = 0   -> lamely zavřené (vertikální)
//   tilt_position = 100 -> lamely otevřené (horizontální)
// Pokud váš systém používá opačnou konvenci (0=otevřené, 100=zavřené),
// prohoďte hodnoty TILT_CLOSED a TILT_OPEN v konfiguraci níže.
//
// KONCEPT PROFILOVÉHO ÚHLU:
// Profilový úhel je efektivní úhel slunečních paprsků promítnutý do
// vertikální roviny kolmé na okno. Tento úhel určuje, jak moc je třeba
// naklonit lamely, aby blokovaly přímé sluneční záření. Je vypočten jako:
//   profileAngle = atan(tan(elevation) / cos(deltaAzimuth))
// kde deltaAzimuth je rozdíl mezi azimutem slunce a orientací okna.
// ============================================================================

// ============================================================================
// KONFIGURACE
// Všechny nastavitelné konstanty jsou seskupeny zde pro snadnou úpravu.
// ============================================================================
const CONFIG = {
  // --- Okno ---
  // Azimut okna ve stupních od severu (po směru hodinových ručiček)
  // 0=Sever, 90=Východ, 180=Jih, 270=Západ
  WINDOW_AZIMUTH: 230, // Východní okno

  // Poloviční zorné pole okna ve stupních
  // Slunce mimo tento úhel od osy okna nemůže přímo svítit dovnitř
  WINDOW_FOV: 80,

  // --- Lokace ---
  // Praha, Česká republika (pouze pro referenci, data slunce přichází z HA)
  // Lat: 50.0755° N, Lon: 14.4378° E

  // --- Entity IDs ---
  // Entita slunce v Home Assistant (standardní)
  SUN_ENTITY: "sun.sun",

  // Teplotní senzor
  TEMP_SENSOR: "sensor.workroom_thermometer_temperature",

  // Entita žaluzií
  BLIND_ENTITY: "cover.workroom_blinds",

  // --- Mapování náklonu ---
  // Hodnota tilt_position pro zavřené lamely (vertikální)
  TILT_CLOSED: 0,

  // Hodnota tilt_position pro otevřené lamely (horizontální)
  TILT_OPEN: 100,

  // --- Prahové hodnoty ---
  // Minimální elevace slunce pro aktivaci (stupně)
  MIN_ELEVATION: 2,

  // Přídavný úhel náklonu pro jistotu blokování (stupně)
  TILT_MARGIN: 5,

  // Minimální krok změny náklonu (procenta)
  MIN_STEP: 5,

  // Minimální změna pro odeslání nového příkazu (hystereze, procenta)
  HYSTERESIS: 5,

  // --- Teplotní prahy ---
  // Úpravy požadovaného úhlu podle vnitřní teploty
  TEMP_THRESHOLDS: {
    COOL_MAX: 22, // Pod touto teplotou: povolit solární zisky
    COMFORT_MAX: 24, // Komfortní zóna: žádná úprava
    WARM_MAX: 26, // Teplé: zvýšit blokování
    HOT_MAX: 30, // Horké: výrazně zvýšit blokování
  },

  // Úpravy úhlu pro jednotlivé teplotní zóny (stupně)
  TEMP_ADJUSTMENTS: {
    COOL: -5, // Snížit úhel (povolit sluneční teplo)
    COMFORT: 0, // Žádná úprava
    WARM: 8, // Zvýšit úhel (více blokovat)
    HOT: 15, // Výrazně zvýšit
    VERY_HOT: 20, // Maximální blokování
  },
};

// ============================================================================
// POMOCNÉ FUNKCE
// ============================================================================

/**
 * Normalizuje úhel do rozsahu [-180, 180] stupňů.
 *
 * @param {number} angle - Úhel ve stupních
 * @returns {number} Normalizovaný úhel
 */
function normalizeAngle(angle) {
  // Zajistíme, že úhel je v rozsahu [-180, 180]
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
 *
 * @param {number} value - Hodnota k omezení
 * @param {number} min - Minimální hodnota
 * @param {number} max - Maximální hodnota
 * @returns {number} Omezená hodnota
 */
function clamp(value, min, max) {
  if (isNaN(value)) return min; // Bezpečná hodnota při NaN
  return Math.min(Math.max(value, min), max);
}

/**
 * Zaokrouhlí hodnotu na nejbližší násobek kroku.
 *
 * @param {number} value - Hodnota k zaokrouhlení
 * @param {number} step - Velikost kroku
 * @returns {number} Zaokrouhlená hodnota
 */
function roundToStep(value, step) {
  if (isNaN(value) || step <= 0) return 0;
  return Math.round(value / step) * step;
}

/**
 * Převod stupňů na radiány.
 *
 * @param {number} degrees - Úhel ve stupních
 * @returns {number} Úhel v radiánech
 */
function degreesToRadians(degrees) {
  return degrees * (Math.PI / 180);
}

/**
 * Převod radiánů na stupně.
 *
 * @param {number} radians - Úhel v radiánech
 * @returns {number} Úhel ve stupních
 */
function radiansToDegrees(radians) {
  return radians * (180 / Math.PI);
}

/**
 * Vypočítá profilový úhel slunce vzhledem k oknu.
 *
 * Profilový úhel je projekce slunečních paprsků do vertikální roviny
 * kolmé na povrch okna. Tento úhel přímo určuje potřebný náklon lamel.
 *
 * Vzorec:
 *   profileAngle = atan(tan(elevation) / cos(deltaAzimuth))
 *
 * @param {number} sunElevation - Elevace slunce ve stupních
 * @param {number} deltaAzimuth - Rozdíl azimutů ve stupních
 * @returns {number} Profilový úhel ve stupních
 */
function calculateProfileAngle(sunElevation, deltaAzimuth) {
  // Převod na radiány pro trigonometrické výpočty
  const elevRad = degreesToRadians(sunElevation);
  const deltaAzRad = degreesToRadians(deltaAzimuth);

  // Ochrana proti dělení nulou / cos(90°) = 0
  const cosDA = Math.cos(deltaAzRad);
  if (Math.abs(cosDA) < 0.001) {
    // Slunce je téměř rovnoběžně s oknem, profilový úhel se blíží 90°
    return 90;
  }

  // Výpočet profilového úhlu
  const profileRad = Math.atan(Math.tan(elevRad) / cosDA);
  const profileDeg = radiansToDegrees(profileRad);

  // Profilový úhel by měl být kladný (slunce je nad horizontem)
  return Math.max(0, profileDeg);
}

/**
 * Získá teplotní úpravu úhlu na základě vnitřní teploty.
 *
 * @param {number|null} temperature - Vnitřní teplota v °C
 * @returns {{adjustment: number, zone: string}} Úprava a název zóny
 */
function getTemperatureAdjustment(temperature) {
  // Pokud teplota není dostupná, neupravujeme
  if (temperature === null || temperature === undefined || isNaN(temperature)) {
    return {
      adjustment: 0,
      zone: "neznámá (senzor nedostupný)",
    };
  }

  const t = CONFIG.TEMP_THRESHOLDS;
  const a = CONFIG.TEMP_ADJUSTMENTS;

  if (temperature < t.COOL_MAX) {
    // Pod 22°C: chladné, povolit solární zisky (snížit náklon)
    return { adjustment: a.COOL, zone: `chladné (< ${t.COOL_MAX}°C)` };
  } else if (temperature < t.COMFORT_MAX) {
    // 22-24°C: komfortní zóna, žádná úprava
    return {
      adjustment: a.COMFORT,
      zone: `komfort (${t.COOL_MAX}-${t.COMFORT_MAX}°C)`,
    };
  } else if (temperature < t.WARM_MAX) {
    // 24-26°C: teplo, zvýšit blokování
    return {
      adjustment: a.WARM,
      zone: `teplé (${t.COMFORT_MAX}-${t.WARM_MAX}°C)`,
    };
  } else if (temperature < t.HOT_MAX) {
    // 26-30°C: horko, výrazně zvýšit blokování
    return {
      adjustment: a.HOT,
      zone: `horké (${t.WARM_MAX}-${t.HOT_MAX}°C)`,
    };
  } else {
    // Nad 30°C: velmi horko, maximální blokování
    return {
      adjustment: a.VERY_HOT,
      zone: `velmi horké (> ${t.HOT_MAX}°C)`,
    };
  }
}

// ============================================================================
// HLAVNÍ LOGIKA
// ============================================================================

// --- 1. Získání dat z Home Assistant ---
// Přístup ke stavům HA přes globální kontext Node-RED
const haStates = global.get("homeassistant").homeAssistant.states;

// --- Získání dat entity slunce ---
const sunEntity = haStates[CONFIG.SUN_ENTITY];

if (!sunEntity || !sunEntity.attributes) {
  // Entita slunce nenalezena – nemůžeme pokračovat
  node.warn(
    `CoverAutomation: Entita slunce '${CONFIG.SUN_ENTITY}' nenalezena!`,
  );
  node.status({
    fill: "red",
    shape: "ring",
    text: `Chyba: entita slunce nenalezena`,
  });
  return null;
}

const sunElevation = parseFloat(sunEntity.attributes.elevation);
const sunAzimuth = parseFloat(sunEntity.attributes.azimuth);

// Ověření platnosti dat slunce
if (isNaN(sunElevation) || isNaN(sunAzimuth)) {
  node.warn(
    `CoverAutomation: Neplatná data slunce – elevation: ${sunEntity.attributes.elevation}, ` +
      `azimuth: ${sunEntity.attributes.azimuth}`,
  );
  node.status({
    fill: "red",
    shape: "ring",
    text: `Chyba: neplatná data slunce`,
  });
  return null;
}

// --- Získání vnitřní teploty ---
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
    node.warn(
      `CoverAutomation: Neplatná teplota ze senzoru '${CONFIG.TEMP_SENSOR}': '${tempEntity.state}' ` +
        `– pokračuji bez teplotních úprav`,
    );
    indoorTemp = null;
  }
} else {
  // Teplotní senzor nenalezen, pokračujeme bez teplotních úprav
  node.warn(
    `CoverAutomation: Teplotní senzor '${CONFIG.TEMP_SENSOR}' nenalezen nebo nedostupný ` +
      `– pokračuji bez teplotních úprav`,
  );
}

// --- 1b. Kontrola pozice žaluzií ---
// Pokud jsou žaluzie vytažené nahoru o více než 50 %, nemá smysl měnit náklon lamel.
const blindEntity = haStates[CONFIG.BLIND_ENTITY];
if (
  blindEntity &&
  blindEntity.attributes &&
  blindEntity.attributes.current_position !== undefined
) {
  const currentPosition = parseFloat(blindEntity.attributes.current_position);
  if (!isNaN(currentPosition) && currentPosition > 50) {
    const statusText = `Žaluzie vytaženy (${currentPosition}% > 50%) – náklon se nemění`;
    node.status({
      fill: "blue",
      shape: "ring",
      text: statusText,
    });
    node.warn(
      `CoverAutomation: Žaluzie '${CONFIG.BLIND_ENTITY}' jsou vytaženy na ${currentPosition}% (> 50%) ` +
        `– náklon se nemění`,
    );
    return null;
  }
}

// --- 2. Kontrola, zda je slunce relevantní ---
// Výpočet rozdílu azimutu mezi sluncem a oknem
const deltaAzimuth = normalizeAngle(sunAzimuth - CONFIG.WINDOW_AZIMUTH);
const absDeltaAzimuth = Math.abs(deltaAzimuth);

// Je slunce nad horizontem?
const isSunAboveHorizon = sunElevation > CONFIG.MIN_ELEVATION;

// Svítí slunce na okno? (je v zorném poli okna?)
const isSunFacingWindow = absDeltaAzimuth < CONFIG.WINDOW_FOV;

// Celkově: je slunce relevantní pro naše okno?
const isSunRelevant = isSunAboveHorizon && isSunFacingWindow;

let tiltPosition;
let reason;
let requiredAngle = 0;
let profileAngle = 0;

if (!isSunRelevant) {
  // --- Slunce nesvítí na okno -> plně otevřít lamely ---

  tiltPosition = CONFIG.TILT_OPEN;

  if (!isSunAboveHorizon) {
    reason = `Slunce pod horizontem (elevace ${sunElevation.toFixed(1)}° < ${CONFIG.MIN_ELEVATION}°) – plně otevřeno`;
  } else {
    reason = `Slunce mimo okno (deltaAz ${deltaAzimuth.toFixed(1)}°, FOV ±${CONFIG.WINDOW_FOV}°) – plně otevřeno`;
  }
} else {
  // --- Slunce svítí na okno -> vypočítat potřebný náklon ---

  // --- 3. Výpočet profilového úhlu ---
  profileAngle = calculateProfileAngle(sunElevation, deltaAzimuth);

  // --- 4. Výpočet požadovaného úhlu náklonu ---
  // Základní úhel = profilový úhel + bezpečnostní marže
  requiredAngle = profileAngle + CONFIG.TILT_MARGIN;

  // --- Změkčení na okrajích zorného pole ---
  // Když se slunce blíží k hranici zorného pole okna, snižujeme intenzitu
  // blokování pomocí cos(deltaAzimuth). To zajistí hladký přechod místo
  // skokové změny na hranici FOV.
  const edgeFactor = Math.cos(degreesToRadians(deltaAzimuth));
  requiredAngle = requiredAngle * clamp(edgeFactor, 0, 1);

  // --- Teplotní úpravy ---
  const tempResult = getTemperatureAdjustment(indoorTemp);
  requiredAngle += tempResult.adjustment;

  // --- Omezení na platný rozsah [0, 90] ---
  requiredAngle = clamp(requiredAngle, 0, 90);

  // --- 5. Mapování na tilt_position (0-100) ---
  // requiredAngle 0° (horizontální/otevřené) -> TILT_OPEN
  // requiredAngle 90° (vertikální/zavřené) -> TILT_CLOSED
  //
  // Vzorec:
  // tiltPosition = TILT_OPEN - (requiredAngle / 90) * (TILT_OPEN - TILT_CLOSED)
  tiltPosition =
    CONFIG.TILT_OPEN -
    (requiredAngle / 90) * (CONFIG.TILT_OPEN - CONFIG.TILT_CLOSED);

  reason = `Slunce aktivní (profil ${profileAngle.toFixed(1)}°, teplota: ${tempResult.zone}) – blokování`;
}

// --- 6. Zaokrouhlení na minimální krok ---
tiltPosition = roundToStep(tiltPosition, CONFIG.MIN_STEP);

// Finální omezení na rozsah [TILT_CLOSED, TILT_OPEN]
tiltPosition = clamp(
  tiltPosition,
  Math.min(CONFIG.TILT_CLOSED, CONFIG.TILT_OPEN),
  Math.max(CONFIG.TILT_CLOSED, CONFIG.TILT_OPEN),
);

// --- 7. Hystereze – kontrola minimální změny ---
// Použijeme flow kontext pro uložení předchozí hodnoty
const previousTilt = flow.get("blindTiltPrevious");
const tiltChange =
  previousTilt !== undefined && previousTilt !== null
    ? Math.abs(tiltPosition - previousTilt)
    : CONFIG.HYSTERESIS + 1; // První spuštění: vždy odeslat

if (tiltChange < CONFIG.HYSTERESIS) {
  // Změna je příliš malá, neprovádíme akci
  const statusText =
    `Beze změny: ${previousTilt}% (Δ${tiltChange.toFixed(0)}% < ${CONFIG.HYSTERESIS}%) | ` +
    `El: ${sunElevation.toFixed(1)}° Az: ${sunAzimuth.toFixed(1)}°`;

  node.status({
    fill: "grey",
    shape: "ring",
    text: statusText,
  });

  // Vracíme null – žádný výstup z funkce (zastaví tok zpráv)
  return null;
}

// --- Uložení nové hodnoty pro příští porovnání ---
flow.set("blindTiltPrevious", tiltPosition);

// --- 8. Sestavení výstupní zprávy ---
msg.payload = {
  data: {
    entity_id: CONFIG.BLIND_ENTITY,
    tilt_position: tiltPosition,
  },
};

// --- Ladící informace ---
// Přiložíme kompletní diagnostická data pro ladění a monitoring
msg.debug = {
  // Vstupní data
  sunElevation: sunElevation,
  sunAzimuth: sunAzimuth,
  indoorTemp: indoorTemp,

  // Vypočtené hodnoty
  deltaAzimuth: parseFloat(deltaAzimuth.toFixed(2)),
  absDeltaAzimuth: parseFloat(absDeltaAzimuth.toFixed(2)),
  profileAngle: parseFloat(profileAngle.toFixed(2)),
  requiredAngle: parseFloat(requiredAngle.toFixed(2)),

  // Stavy
  isSunAboveHorizon: isSunAboveHorizon,
  isSunFacingWindow: isSunFacingWindow,
  isSunRelevant: isSunRelevant,

  // Výstup
  tiltPosition: tiltPosition,
  previousTilt:
    previousTilt !== undefined && previousTilt !== null
      ? previousTilt
      : "N/A (první spuštění)",
  tiltChange: parseFloat(tiltChange.toFixed(1)),

  // Metadata
  reason: reason,
  timestamp: new Date().toISOString(),

  // Konfigurace (pro referenci)
  config: {
    windowAzimuth: CONFIG.WINDOW_AZIMUTH,
    windowFOV: CONFIG.WINDOW_FOV,
    blindEntity: CONFIG.BLIND_ENTITY,
    tempSensor: CONFIG.TEMP_SENSOR,
  },
};

// --- 9. Stavový indikátor uzlu ---
// Žlutá: slunce aktivně svítí na okno
// Zelená: slunce nesvítí na okno
const statusFill = isSunRelevant ? "yellow" : "green";
const statusText =
  `Tilt: ${tiltPosition}% | ` +
  `El: ${sunElevation.toFixed(1)}° Az: ${sunAzimuth.toFixed(1)}° | ` +
  (indoorTemp !== null ? `${indoorTemp.toFixed(1)}°C | ` : "") +
  (isSunRelevant ? `Profil: ${profileAngle.toFixed(1)}°` : `Otevřeno`);

node.status({
  fill: statusFill,
  shape: "dot",
  text: statusText,
});

// --- 10. Odeslání zprávy na výstup ---
return msg;

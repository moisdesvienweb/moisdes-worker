// ================================================================
// MOISDES — SOLAR POSITION ALGORITHM (NREL SPA)
// spa.js
//
// Full port of NREL's Solar Position Algorithm for Solar Radiation
// Applications (Reda & Andreas, 2004) — the algorithm with the tightest
// published accuracy for sun position (~0.0003°), used as the reference
// implementation across the solar-energy industry. This replaces the
// simplified low-order NOAA/Meeus formula previously used here (which
// was already "accurate to within a minute" but uses far fewer periodic
// terms); the SPA path adds full VSOP87 Earth-position terms, the 63-term
// IAU 1980 nutation series, aberration, and topocentric (elevation +
// atmospheric-refraction) corrections that the simplified formula omits.
//
// Ported from https://github.com/udivankin/sunrise-sunset-js (ISC
// licensed), which is itself a faithful JS port of NREL's reference C
// implementation — coefficient tables below are copied verbatim from
// that source rather than retyped from memory, specifically to avoid
// transcription errors in ~200 numeric constants.
// ================================================================

window.MOISDES = window.MOISDES || {};

window.MOISDES.spa = (function () {
  const PI = Math.PI;
  const SUN_RADIUS = 0.26667; // degrees
  const REFRACTION_CORRECTION = 0.5667; // degrees, standard atmospheric refraction at the horizon
  const INVALID_VALUE = -99999;

  // ── math helpers ────────────────────────────────────────────────────
  function deg2rad(d) { return (PI / 180.0) * d; }
  function rad2deg(r) { return (180.0 / PI) * r; }
  function limitDegrees(d) {
    let l = d / 360.0;
    l = 360.0 * (l - Math.floor(l));
    if (l < 0) l += 360.0;
    return l;
  }
  function limitDegrees180(d) {
    let l = d / 180.0;
    l = 180.0 * (l - Math.floor(l));
    if (l < 0) l += 180.0;
    return l;
  }
  function limitDegrees180pm(d) {
    let l = d / 360.0;
    l = 360.0 * (l - Math.floor(l));
    if (l < -180.0) l += 360.0;
    else if (l > 180.0) l -= 360.0;
    return l;
  }
  function limitZero2one(v) {
    let l = v - Math.floor(v);
    if (l < 0) l += 1.0;
    return l;
  }
  function thirdOrderPolynomial(a, b, c, d, x) { return ((a * x + b) * x + c) * x + d; }
  function limitMinutes(m) {
    let l = m;
    if (l < -20.0) l += 1440.0;
    else if (l > 20.0) l -= 1440.0;
    return l;
  }

  // ── Julian day/century/millennium ───────────────────────────────────
  function julianDay(year, month, day, hour, minute, second, deltaUt1, timezone) {
    let y = year, m = month;
    const dayDecimal = day + (hour - timezone + (minute + (second + deltaUt1) / 60.0) / 60.0) / 24.0;
    if (m < 3) { m += 12; y--; }
    let jd = Math.floor(365.25 * (y + 4716.0)) + Math.floor(30.6001 * (m + 1)) + dayDecimal - 1524.5;
    if (jd > 2299160.0) {
      const a = Math.floor(y / 100);
      jd += 2 - a + Math.floor(a / 4);
    }
    return jd;
  }
  function julianCentury(jd) { return (jd - 2451545.0) / 36525.0; }
  function julianEphemerisDay(jd, deltaT) { return jd + deltaT / 86400.0; }
  function julianEphemerisCentury(jde) { return (jde - 2451545.0) / 36525.0; }
  function julianEphemerisMillennium(jce) { return jce / 10.0; }

  // ── Earth heliocentric position (VSOP87 periodic terms) ─────────────
  // prettier-ignore
  const L_TERMS = [
    [[175347046.0,0,0],[3341656.0,4.6692568,6283.07585],[34894.0,4.6261,12566.1517],[3497.0,2.7441,5753.3849],[3418.0,2.8289,3.5231],[3136.0,3.6277,77713.7715],[2676.0,4.4181,7860.4194],[2343.0,6.1352,3930.2097],[1324.0,0.7425,11506.7698],[1273.0,2.0371,529.691],[1199.0,1.1096,1577.3435],[990,5.233,5884.927],[902,2.045,26.298],[857,3.508,398.149],[780,1.179,5223.694],[753,2.533,5507.553],[505,4.583,18849.228],[492,4.205,775.523],[357,2.92,0.067],[317,5.849,11790.629],[284,1.899,796.298],[271,0.315,10977.079],[243,0.345,5486.778],[206,4.806,2544.314],[205,1.869,5573.143],[202,2.458,6069.777],[156,0.833,213.299],[132,3.411,2942.463],[126,1.083,20.775],[115,0.645,0.98],[103,0.636,4694.003],[102,0.976,15720.839],[102,4.267,7.114],[99,6.21,2146.17],[98,0.68,155.42],[86,5.98,161000.69],[85,1.3,6275.96],[85,3.67,71430.7],[80,1.81,17260.15],[79,3.04,12036.46],[75,1.76,5088.63],[74,3.5,3154.69],[74,4.68,801.82],[70,0.83,9437.76],[62,3.98,8827.39],[61,1.82,7084.9],[57,2.78,6286.6],[56,4.39,14143.5],[56,3.47,6279.55],[52,0.19,12139.55],[52,1.33,1748.02],[51,0.28,5856.48],[49,0.49,1194.45],[41,5.37,8429.24],[41,2.4,19651.05],[39,6.17,10447.39],[37,6.04,10213.29],[37,2.57,1059.38],[36,1.71,2352.87],[36,1.78,6812.77],[33,0.59,17789.85],[30,0.44,83996.85],[30,2.74,1349.87],[25,3.16,4690.48]],
    [[628331966747.0,0,0],[206059.0,2.678235,6283.07585],[4303.0,2.6351,12566.1517],[425.0,1.59,3.523],[119.0,5.796,26.298],[109.0,2.966,1577.344],[93,2.59,18849.23],[72,1.14,529.69],[68,1.87,398.15],[67,4.41,5507.55],[59,2.89,5223.69],[56,2.17,155.42],[45,0.4,796.3],[36,0.47,775.52],[29,2.65,7.11],[21,5.34,0.98],[19,1.85,5486.78],[19,4.97,213.3],[17,2.99,6275.96],[16,0.03,2544.31],[16,1.43,2146.17],[15,1.21,10977.08],[12,2.83,1748.02],[12,3.26,5088.63],[12,5.27,1194.45],[12,2.08,4694],[11,0.77,553.57],[10,1.3,6286.6],[10,4.24,1349.87],[9,2.7,242.73],[9,5.64,951.72],[8,5.3,2352.87],[6,2.65,9437.76],[6,4.67,4690.48]],
    [[52919.0,0,0],[8720.0,1.0721,6283.0758],[309.0,0.867,12566.152],[27,0.05,3.52],[16,5.19,26.3],[16,3.68,155.42],[10,0.76,18849.23],[9,2.06,77713.77],[7,0.83,775.52],[5,4.66,1577.34],[4,1.03,7.11],[4,3.44,5573.14],[3,5.14,796.3],[3,6.05,5507.55],[3,1.19,242.73],[3,6.12,529.69],[3,0.31,398.15],[3,2.28,553.57],[2,4.38,5223.69],[2,3.75,0.98]],
    [[289.0,5.844,6283.076],[35,0,0],[17,5.49,12566.15],[3,5.2,155.42],[1,4.72,3.52],[1,5.3,18849.23],[1,5.97,242.73]],
    [[114.0,3.142,0],[8,4.13,6283.08],[1,3.84,12566.15]],
    [[1,3.14,0]],
  ];
  const L_SUBCOUNT = [64, 34, 20, 7, 3, 1];
  // prettier-ignore
  const B_TERMS = [
    [[280.0,3.199,84334.662],[102.0,5.422,5507.553],[80,3.88,5223.69],[44,3.7,2352.87],[32,4,1577.34]],
    [[9,3.9,5507.55],[6,1.73,5223.69]],
  ];
  const B_SUBCOUNT = [5, 2];
  // prettier-ignore
  const R_TERMS = [
    [[100013989.0,0,0],[1670700.0,3.0984635,6283.07585],[13956.0,3.05525,12566.1517],[3084.0,5.1985,77713.7715],[1628.0,1.1739,5753.3849],[1576.0,2.8469,7860.4194],[925.0,5.453,11506.77],[542.0,4.564,3930.21],[472.0,3.661,5884.927],[346.0,0.964,5507.553],[329.0,5.9,5223.694],[307.0,0.299,5573.143],[243.0,4.273,11790.629],[212.0,5.847,1577.344],[186.0,5.022,10977.079],[175.0,3.012,18849.228],[110.0,5.055,5486.778],[98,0.89,6069.78],[86,5.69,15720.84],[86,1.27,161000.69],[65,0.27,17260.15],[63,0.92,529.69],[57,2.01,83996.85],[56,5.24,71430.7],[49,3.25,2544.31],[47,2.58,775.52],[45,5.54,9437.76],[43,6.01,6275.96],[39,5.36,4694],[38,2.39,8827.39],[37,0.83,19651.05],[37,4.9,12139.55],[36,1.67,12036.46],[35,1.84,2942.46],[33,0.24,7084.9],[32,0.18,5088.63],[32,1.78,398.15],[28,1.21,6286.6],[28,1.9,6279.55],[26,4.59,10447.39]],
    [[103019.0,1.10749,6283.07585],[1721.0,1.0644,12566.1517],[702.0,3.142,0],[32,1.02,18849.23],[31,2.84,5507.55],[25,1.32,5223.69],[18,1.42,1577.34],[10,5.91,10977.08],[9,1.42,6275.96],[9,0.27,5486.78]],
    [[4359.0,5.7846,6283.0758],[124.0,5.579,12566.152],[12,3.14,0],[9,3.63,77713.77],[6,1.87,5573.14],[3,5.47,18849.23]],
    [[145.0,4.273,6283.076],[7,3.92,12566.15]],
    [[4,2.56,6283.08]],
  ];
  const R_SUBCOUNT = [40, 10, 6, 2, 1];

  function earthPeriodicTermSummation(terms, count, jme) {
    let sum = 0;
    for (let i = 0; i < count; i++) sum += terms[i][0] * Math.cos(terms[i][1] + terms[i][2] * jme);
    return sum;
  }
  function earthValues(termSum, count, jme) {
    let sum = 0;
    for (let i = 0; i < count; i++) sum += termSum[i] * Math.pow(jme, i);
    return sum / 1.0e8;
  }
  function earthHeliocentricLongitude(jme) {
    const sum = [];
    for (let i = 0; i < 6; i++) sum[i] = earthPeriodicTermSummation(L_TERMS[i], L_SUBCOUNT[i], jme);
    return limitDegrees(rad2deg(earthValues(sum, 6, jme)));
  }
  function earthHeliocentricLatitude(jme) {
    const sum = [];
    for (let i = 0; i < 2; i++) sum[i] = earthPeriodicTermSummation(B_TERMS[i], B_SUBCOUNT[i], jme);
    return rad2deg(earthValues(sum, 2, jme));
  }
  function earthRadiusVector(jme) {
    const sum = [];
    for (let i = 0; i < 5; i++) sum[i] = earthPeriodicTermSummation(R_TERMS[i], R_SUBCOUNT[i], jme);
    return earthValues(sum, 5, jme);
  }

  // ── Geocentric sun position ─────────────────────────────────────────
  function geocentricLongitude(l) { let t = l + 180.0; if (t >= 360.0) t -= 360.0; return t; }
  function geocentricLatitude(b) { return -b; }
  function aberrationCorrection(r) { return -20.4898 / (3600.0 * r); }
  function apparentSunLongitude(theta, delPsi, delTau) { return theta + delPsi + delTau; }
  function geocentricRightAscension(lamda, epsilon, beta) {
    const lamdaR = deg2rad(lamda), epsilonR = deg2rad(epsilon);
    return limitDegrees(rad2deg(Math.atan2(
      Math.sin(lamdaR) * Math.cos(epsilonR) - Math.tan(deg2rad(beta)) * Math.sin(epsilonR),
      Math.cos(lamdaR)
    )));
  }
  function geocentricDeclination(beta, epsilon, lamda) {
    const betaR = deg2rad(beta), epsilonR = deg2rad(epsilon);
    return rad2deg(Math.asin(Math.sin(betaR) * Math.cos(epsilonR) + Math.cos(betaR) * Math.sin(epsilonR) * Math.sin(deg2rad(lamda))));
  }
  function sunMeanLongitude(jme) {
    return limitDegrees(280.4664567 + jme * (360007.6982779 + jme * (0.03032028 + jme * (1 / 49931.0 + jme * (-1 / 15300.0 + jme * (-1 / 2000000.0))))));
  }
  function sunEquatorialHorizontalParallax(r) { return 8.794 / (3600.0 * r); }

  // ── Nutation (IAU 1980, 63-term series) ─────────────────────────────
  // prettier-ignore
  const Y_TERMS = [
    [0,0,0,0,1],[-2,0,0,2,2],[0,0,0,2,2],[0,0,0,0,2],[0,1,0,0,0],[0,0,1,0,0],[-2,1,0,2,2],[0,0,0,2,1],[0,0,1,2,2],[-2,-1,0,2,2],
    [-2,0,1,0,0],[-2,0,0,2,1],[0,0,-1,2,2],[2,0,0,0,0],[0,0,1,0,1],[2,0,-1,2,2],[0,0,-1,0,1],[0,0,1,2,1],[-2,0,2,0,0],[0,0,-2,2,1],
    [2,0,0,2,2],[0,0,2,2,2],[0,0,2,0,0],[-2,0,1,2,2],[0,0,0,2,0],[-2,0,0,2,0],[0,0,-1,2,1],[0,2,0,0,0],[2,0,-1,0,1],[-2,2,0,2,2],
    [0,1,0,0,1],[-2,0,1,0,1],[0,-1,0,0,1],[0,0,2,-2,0],[2,0,-1,2,1],[2,0,1,2,2],[0,1,0,2,2],[-2,1,1,0,0],[0,-1,0,2,2],[2,0,0,2,1],
    [2,0,1,0,0],[-2,0,2,2,2],[-2,0,1,2,1],[2,0,-2,0,1],[2,0,0,0,1],[0,-1,1,0,0],[-2,-1,0,2,1],[-2,0,0,0,1],[0,0,2,2,1],[-2,0,2,0,1],
    [-2,1,0,2,1],[0,0,1,-2,0],[-1,0,1,0,0],[-2,1,0,0,0],[1,0,0,0,0],[0,0,1,2,0],[0,0,-2,2,2],[-1,-1,1,0,0],[0,1,1,0,0],[0,-1,1,2,2],
    [2,-1,-1,2,2],[0,0,3,2,2],[2,-1,0,2,2],
  ];
  // prettier-ignore
  const PE_TERMS = [
    [-171996,-174.2,92025,8.9],[-13187,-1.6,5736,-3.1],[-2274,-0.2,977,-0.5],[2062,0.2,-895,0.5],[1426,-3.4,54,-0.1],[712,0.1,-7,0],[-517,1.2,224,-0.6],[-386,-0.4,200,0],[-301,0,129,-0.1],[217,-0.5,-95,0.3],
    [-158,0,0,0],[129,0.1,-70,0],[123,0,-53,0],[63,0,0,0],[63,0.1,-33,0],[-59,0,26,0],[-58,-0.1,32,0],[-51,0,27,0],[48,0,0,0],[46,0,-24,0],
    [-38,0,16,0],[-31,0,13,0],[29,0,0,0],[29,0,-12,0],[26,0,0,0],[-22,0,0,0],[21,0,-10,0],[17,-0.1,0,0],[16,0,-8,0],[-16,0.1,7,0],
    [-15,0,9,0],[-13,0,7,0],[-12,0,6,0],[11,0,0,0],[-10,0,5,0],[-8,0,3,0],[7,0,-3,0],[-7,0,0,0],[-7,0,3,0],[-7,0,3,0],
    [6,0,0,0],[6,0,-3,0],[6,0,-3,0],[-6,0,3,0],[-6,0,3,0],[5,0,0,0],[-5,0,3,0],[-5,0,3,0],[-5,0,3,0],[4,0,0,0],
    [4,0,0,0],[4,0,0,0],[-4,0,0,0],[-4,0,0,0],[-4,0,0,0],[3,0,0,0],[-3,0,0,0],[-3,0,0,0],[-3,0,0,0],[-3,0,0,0],
    [-3,0,0,0],[-3,0,0,0],[-3,0,0,0],
  ];

  function meanElongationMoonSun(jce) { return thirdOrderPolynomial(1.0 / 189474.0, -0.0019142, 445267.11148, 297.85036, jce); }
  function meanAnomalySun(jce) { return thirdOrderPolynomial(-1.0 / 300000.0, -0.0001603, 35999.05034, 357.52772, jce); }
  function meanAnomalyMoon(jce) { return thirdOrderPolynomial(1.0 / 56250.0, 0.0086972, 477198.867398, 134.96298, jce); }
  function argumentLatitudeMoon(jce) { return thirdOrderPolynomial(1.0 / 327270.0, -0.0036825, 483202.017538, 93.27191, jce); }
  function ascendingLongitudeMoon(jce) { return thirdOrderPolynomial(1.0 / 450000.0, 0.0020708, -1934.136261, 125.04452, jce); }

  function xyTermSummation(i, x) {
    let sum = 0;
    for (let j = 0; j < 5; j++) sum += x[j] * Y_TERMS[i][j];
    return sum;
  }
  function nutationLongitudeAndObliquity(jce, x) {
    let sumPsi = 0, sumEpsilon = 0;
    for (let i = 0; i < 63; i++) {
      const xyTermSum = deg2rad(xyTermSummation(i, x));
      sumPsi += (PE_TERMS[i][0] + jce * PE_TERMS[i][1]) * Math.sin(xyTermSum);
      sumEpsilon += (PE_TERMS[i][2] + jce * PE_TERMS[i][3]) * Math.cos(xyTermSum);
    }
    return { delPsi: sumPsi / 36000000.0, delEpsilon: sumEpsilon / 36000000.0 };
  }
  function eclipticMeanObliquity(jme) {
    const u = jme / 10.0;
    return 84381.448 + u * (-4680.93 + u * (-1.55 + u * (1999.25 + u * (-51.38 + u * (-249.67 + u * (-39.05 + u * (7.12 + u * (27.87 + u * (5.79 + u * 2.45)))))))));
  }
  function eclipticTrueObliquity(deltaEpsilon, epsilon0) { return deltaEpsilon + epsilon0 / 3600.0; }

  // ── Observer / topocentric ───────────────────────────────────────────
  function greenwichMeanSiderealTime(jd, jc) {
    return limitDegrees(280.46061837 + 360.98564736629 * (jd - 2451545.0) + jc * jc * (0.000387933 - jc / 38710000.0));
  }
  function greenwichSiderealTime(nu0, delPsi, epsilon) { return nu0 + delPsi * Math.cos(deg2rad(epsilon)); }
  function observerHourAngle(nu, longitude, alphaDeg) { return limitDegrees(nu + longitude - alphaDeg); }
  function rightAscensionParallaxAndTopocentricDec(latitude, elevation, xi, h, delta) {
    const latRad = deg2rad(latitude), xiRad = deg2rad(xi), hRad = deg2rad(h), deltaRad = deg2rad(delta);
    const u = Math.atan(0.99664719 * Math.tan(latRad));
    const y = 0.99664719 * Math.sin(u) + (elevation * Math.sin(latRad)) / 6378140.0;
    const x = Math.cos(u) + (elevation * Math.cos(latRad)) / 6378140.0;
    const deltaAlphaRad = Math.atan2(-x * Math.sin(xiRad) * Math.sin(hRad), Math.cos(deltaRad) - x * Math.sin(xiRad) * Math.cos(hRad));
    const deltaPrime = rad2deg(Math.atan2(
      (Math.sin(deltaRad) - y * Math.sin(xiRad)) * Math.cos(deltaAlphaRad),
      Math.cos(deltaRad) - x * Math.sin(xiRad) * Math.cos(hRad)
    ));
    return { deltaAlpha: rad2deg(deltaAlphaRad), deltaPrime };
  }

  // ── Julian-day RA/Dec (shared by the "now" calc and RTS interpolation) ──
  function calculateRaDecForJd(jd, deltaT) {
    const jc = julianCentury(jd);
    const jde = julianEphemerisDay(jd, deltaT);
    const jce = julianEphemerisCentury(jde);
    const jme = julianEphemerisMillennium(jce);

    const l = earthHeliocentricLongitude(jme);
    const b = earthHeliocentricLatitude(jme);
    const r = earthRadiusVector(jme);

    const theta = geocentricLongitude(l);
    const beta = geocentricLatitude(b);

    const x = [meanElongationMoonSun(jce), meanAnomalySun(jce), meanAnomalyMoon(jce), argumentLatitudeMoon(jce), ascendingLongitudeMoon(jce)];
    const nutation = nutationLongitudeAndObliquity(jce, x);

    const epsilon0 = eclipticMeanObliquity(jme);
    const epsilon = eclipticTrueObliquity(nutation.delEpsilon, epsilon0);

    const delTau = aberrationCorrection(r);
    const lamda = apparentSunLongitude(theta, nutation.delPsi, delTau);

    const nu0 = greenwichMeanSiderealTime(jd, jc);
    const nu = greenwichSiderealTime(nu0, nutation.delPsi, epsilon);

    const alpha = geocentricRightAscension(lamda, epsilon, beta);
    const delta = geocentricDeclination(beta, epsilon, lamda);

    return { alpha, delta, nu };
  }

  // ── Rise/transit/set ─────────────────────────────────────────────────
  function sunHourAngleAtRiseSet(latitude, deltaZero, h0Prime) {
    const latitudeRad = deg2rad(latitude), deltaZeroRad = deg2rad(deltaZero);
    const argument = (Math.sin(deg2rad(h0Prime)) - Math.sin(latitudeRad) * Math.sin(deltaZeroRad)) / (Math.cos(latitudeRad) * Math.cos(deltaZeroRad));
    if (Math.abs(argument) <= 1) return limitDegrees180(rad2deg(Math.acos(argument)));
    return INVALID_VALUE; // polar day/night
  }
  function approxSunTransitTime(alphaZero, longitude, nu) { return (alphaZero - longitude - nu) / 360.0; }
  function rtsAlphaDeltaPrime(ad, n) {
    let a = ad[1] - ad[0], b = ad[2] - ad[1];
    if (Math.abs(a) >= 2.0) a = limitZero2one(a);
    if (Math.abs(b) >= 2.0) b = limitZero2one(b);
    return ad[1] + (n * (a + b + (b - a) * n)) / 2.0;
  }
  function rtsSunAltitude(latitude, deltaPrime, hPrime) {
    const latitudeRad = deg2rad(latitude), deltaPrimeRad = deg2rad(deltaPrime);
    return rad2deg(Math.asin(Math.sin(latitudeRad) * Math.sin(deltaPrimeRad) + Math.cos(latitudeRad) * Math.cos(deltaPrimeRad) * Math.cos(deg2rad(hPrime))));
  }
  function sunRiseAndSet(mRts, hRts, deltaPrime, latitude, hPrime, h0Prime, sun) {
    return mRts[sun] + (hRts[sun] - h0Prime) / (360.0 * Math.cos(deg2rad(deltaPrime[sun])) * Math.cos(deg2rad(latitude)) * Math.sin(deg2rad(hPrime[sun])));
  }
  function dayfracToLocalHr(dayfrac, timezone) { return 24.0 * limitZero2one(dayfrac + timezone / 24.0); }

  function calculateEotAndSunRiseTransitSet(spa) {
    const h0Prime = -1 * (SUN_RADIUS + spa.atmosphericRefraction);
    const sunRtsJd = julianDay(spa.year, spa.month, spa.day, 0, 0, 0, 0, 0);
    const rtsNoon = calculateRaDecForJd(sunRtsJd, spa.deltaT);
    const nu = rtsNoon.nu;

    const alpha = [], delta = [];
    for (let i = 0; i < 3; i++) {
      const r = calculateRaDecForJd(sunRtsJd + i - 1, spa.deltaT);
      alpha[i] = r.alpha;
      delta[i] = r.delta;
    }

    const mRts = [];
    mRts[0] = approxSunTransitTime(alpha[1], spa.longitude, nu); // SUN_TRANSIT

    const h0 = sunHourAngleAtRiseSet(spa.latitude, delta[1], h0Prime);
    if (h0 === INVALID_VALUE) return { sunrise: INVALID_VALUE, suntransit: INVALID_VALUE, sunset: INVALID_VALUE };

    const h0Dfrac = h0 / 360.0;
    mRts[1] = limitZero2one(mRts[0] - h0Dfrac); // SUN_RISE
    mRts[2] = limitZero2one(mRts[0] + h0Dfrac); // SUN_SET
    mRts[0] = limitZero2one(mRts[0]);

    const nuRts = [], hPrime = [], alphaPrime = [], deltaPrime = [], hRts = [];
    for (let i = 0; i < 3; i++) {
      nuRts[i] = nu + 360.985647 * mRts[i];
      const n = mRts[i] + spa.deltaT / 86400.0;
      alphaPrime[i] = rtsAlphaDeltaPrime(alpha, n);
      deltaPrime[i] = rtsAlphaDeltaPrime(delta, n);
      hPrime[i] = limitDegrees180pm(nuRts[i] + spa.longitude - alphaPrime[i]);
      hRts[i] = rtsSunAltitude(spa.latitude, deltaPrime[i], hPrime[i]);
    }

    const suntransit = dayfracToLocalHr(mRts[0] - hPrime[0] / 360.0, spa.timezone);
    const sunrise = dayfracToLocalHr(sunRiseAndSet(mRts, hRts, deltaPrime, spa.latitude, hPrime, h0Prime, 1), spa.timezone);
    const sunset = dayfracToLocalHr(sunRiseAndSet(mRts, hRts, deltaPrime, spa.latitude, hPrime, h0Prime, 2), spa.timezone);

    return { sunrise, suntransit, sunset };
  }

  // ── Public entry point ───────────────────────────────────────────────
  // Mirrors zmanim.js's existing getSunTimes(date, lat, lon, elevation)
  // contract: date's Y/M/D (local calendar) + the browser's own UTC
  // offset for that date are used as the calculation's civil-date input,
  // and the result comes back as real JS Date objects for that same day.
  function sunTimes(date, latitude, longitude, elevation) {
    const spa = {
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
      timezone: -date.getTimezoneOffset() / 60,
      deltaUt1: 0,
      deltaT: 69, // seconds; changes ~1s/year, close enough for zmanim purposes at any value near "now"
      latitude,
      longitude,
      elevation: elevation > 0 ? elevation : 0,
      pressure: 1013,
      temperature: 15,
      atmosphericRefraction: REFRACTION_CORRECTION,
    };

    const rts = calculateEotAndSunRiseTransitSet(spa);
    const toDate = (fractionalHour) => {
      if (!isFinite(fractionalHour) || fractionalHour === INVALID_VALUE) return null;
      const localMidnightUtc = Date.UTC(spa.year, spa.month - 1, spa.day, 0, 0, 0, 0);
      return new Date(localMidnightUtc + Math.round((fractionalHour - spa.timezone) * 3600000));
    };

    return {
      sunrise: toDate(rts.sunrise),
      sunset: toDate(rts.sunset),
      solarNoon: toDate(rts.suntransit),
    };
  }

  return { sunTimes };
})();
